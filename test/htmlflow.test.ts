import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseHtml } from '../src/htmltree.js';
import { htmlElements, documentTitle } from '../src/htmlflow.js';
import type { HtmlFlowOptions } from '../src/htmlflow.js';
import { placeElements } from '../src/flowplace.js';
import type { LinkAnnotation } from '../src/annotation.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';

/** The report as the flat strings, which is what most assertions want. */
const names = (skipped: NotRendered[]): string[] => skipped.map(describeReport);

/** Place mapped elements into a rect and hand back the page. */
function render(src: string, width = 400, options: HtmlFlowOptions = {}) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements, skipped, unsupported } = htmlElements(doc, src, width, options);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return { page, skipped, unsupported };
}
describe('htmlElements', () => {
  it('maps a string source', () => {
    expect(render('<p>hello world</p>').page.GetText()).toContain('hello world');
  });
  it('accepts an already-parsed HtmlDocument', () => {
    const doc = Document.New();
    const root = parseHtml('<!doctype html><p>parsed once</p>');
    const { elements } = htmlElements(doc, root, 400);
    expect(elements.length).toBeGreaterThan(0);
  });
  it('reports skipped and unsupported through unchanged', () => {
    // A same-side PAIR: a lone float renders since zch2.10 and reports
    // nothing, so it can no longer stand for "a skipped entry gets through".
    const { skipped, unsupported } = render(
      '<p style="grid-template-columns:1fr">a</p>'
      + '<div style="float:left;width:50px">s</div><div style="float:left;width:50px">t</div>');
    expect(names(skipped)).toContain('float:left');
    expect(unsupported.some((u) => u.property === 'grid-template-columns')).toBe(true);
  });
  it('uses the DEFAULT resolver, so an unstyled paragraph is TIMES', () => {
    // The UA sheet declares html { font-family: serif } and font-family
    // inherits. zch2.4's tests all stubbed Helvetica, so this reads as a
    // regression against them and is browser-correct.
    const [frag] = render('<p>x</p>').page.GetTextFragments();
    expect(frag.fontName).toContain('Times');
  });
  it('honours an explicit font-family over the UA default', () => {
    const [frag] = render('<p style="font-family:monospace">x</p>').page.GetTextFragments();
    expect(frag.fontName).toContain('Courier');
  });
  it('lets the caller override the resolver entirely', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(doc, '<p>x</p>', 400, {
      resolveFamily: () => ({
        regular: 'Courier', bold: 'Courier-Bold',
        italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique',
      }),
    });
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    expect(page.GetTextFragments()[0].fontName).toContain('Courier');
  });
  it('resolves boxes against the width it is GIVEN', () => {
    // The width reaches resolveBoxes at build time, so a narrow width must
    // wrap text a wide one does not.
    const long = `<p>${'word '.repeat(40)}</p>`;
    const wide = render(long, 500).page.GetTextFragments().length;
    const narrow = render(long, 120).page.GetTextFragments().length;
    expect(narrow).toBeGreaterThan(wide);
  });
});
describe('the CSS math functions, end to end (zch2.2.6)', () => {
  /** The x of the first glyph a source draws, with `margin-left: <m>`.
   *
   *  Asserted as EQUIVALENCES rather than against computed points, and
   *  deliberately: the absolute number folds in the rect origin, the UA
   *  sheet's `body { margin: 8px }` and cssflow.ts's px -> pt conversion, so
   *  writing it out tests my arithmetic about the pipeline rather than the
   *  feature. The claim worth pinning is that a math function lands exactly
   *  where the value it reduces to lands. */
  const at = (m: string, width = 400): number =>
    render(`<p style="margin-left:${m}">x</p>`, width)
      .page.GetTextFragments()[0].quad[0];
  it('puts a calc() exactly where the length it reduces to goes', () => {
    expect(at('calc(10px + 6px)')).toBeCloseTo(at('16px'), 6);
    expect(at('calc(2 * 1em)')).toBeCloseTo(at('2em'), 6);
  });
  it('resolves a PERCENTAGE inside calc() against the build width', () => {
    // The width reaches resolveBoxes at BUILD time, so this is the thing a
    // test measuring only text wrapping cannot see — the same reason zch2.5's
    // own build-width fixture uses a percentage margin. The px -> pt factor
    // is 0.75, so 4px of extra margin is 3pt of extra offset at any width.
    for (const w of [400, 800]) {
      expect(at('calc(25% + 4px)', w)).toBeCloseTo(at('25%', w) + 3, 6);
    }
    // And the percentage half really does track the width.
    expect(at('calc(25% + 4px)', 800)).toBeGreaterThan(at('calc(25% + 4px)', 400));
  });
  it('lets a retained min() pick a different argument at a different width', () => {
    // Neither equality holds at the other width, which is what makes this
    // the case a value folded at computed time could not express.
    expect(at('min(50%, 60px)', 100)).toBeCloseTo(at('50%', 100), 6);
    expect(at('min(50%, 60px)', 800)).toBeCloseTo(at('60px', 800), 6);
    expect(at('50%', 800)).not.toBeCloseTo(at('60px', 800), 6);
  });
  it('reports an invalid math expression as unsupported rather than dropping it', () => {
    // A refused value stays reportable for zch2.7, which is why cssprop.ts
    // records an unparsable value instead of ignoring it.
    const { unsupported } = render('<p style="margin-left:calc(1px + 2)">x</p>');
    expect(unsupported.some(
      (u) => u.property === 'margin-left' && u.reason === 'unparsable-value')).toBe(true);
  });
});
describe('custom properties end to end (zch2.2.7)', () => {
  /** The x of the first glyph, with `margin-left: <m>`. */
  const at = (decls: string, width = 400): number =>
    render(`<p style="${decls}">x</p>`, width).page.GetTextFragments()[0].quad[0];
  it('puts a var() exactly where the value it resolves to goes', () => {
    // An equivalence rather than a computed number, for the reason the
    // zch2.2.6 cases record: the absolute value folds in the rect origin, the
    // UA sheet's body margin and the px -> pt conversion.
    expect(at('--m:16px;margin-left:var(--m)')).toBeCloseTo(at('margin-left:16px'), 6);
  });
  it('inherits a custom property across elements', () => {
    // Asserted through font-size rather than colour: TextFragment carries NO
    // colour, and deliberately so — fragmentsFromGlyphs merges across a
    // colour change, so a fragment could only ever report one of them. That
    // is a recorded invariant in text.ts; do not "fix" it by adding a field.
    const varSize = render('<div style="--fs:24px"><p style="font-size:var(--fs)">x</p></div>')
      .page.GetTextFragments()[0].fontSize;
    const litSize = render('<div><p style="font-size:24px">x</p></div>')
      .page.GetTextFragments()[0].fontSize;
    expect(varSize).toBeCloseTo(litSize, 6);
    // …and it really took effect, rather than both falling back to the
    // inherited 16px, which would make the equality vacuous.
    expect(varSize).toBeGreaterThan(
      render('<div><p>x</p></div>').page.GetTextFragments()[0].fontSize);
  });
  it('reports an undefined var as unsupported rather than dropping it', () => {
    const { unsupported } = render('<p style="color:var(--nope)">x</p>');
    expect(unsupported.some(
      (u) => u.property === 'color' && u.reason === 'undefined-var')).toBe(true);
  });
  it('renders a shorthand carrying a var()', () => {
    const { skipped, unsupported } = render(
      '<div style="--c:red;border:2px solid var(--c)">x</div>');
    expect(unsupported.some((u) => u.property === 'border')).toBe(false);
    expect(names(skipped)).not.toContain('border');
  });
});
describe('documentTitle', () => {
  it('reads the title element', () => {
    expect(documentTitle(parseHtml('<!doctype html><title>Report</title><p>x</p>')))
      .toBe('Report');
  });
  it('trims surrounding whitespace', () => {
    expect(documentTitle(parseHtml('<!doctype html><title>  Spaced  </title>')))
      .toBe('Spaced');
  });
  it('is undefined when there is no title', () => {
    expect(documentTitle(parseHtml('<!doctype html><p>x</p>'))).toBeUndefined();
  });
  it('is undefined for an EMPTY title rather than the empty string', () => {
    // SetMetadata({ title: '' }) would write an empty /Info /Title, which is
    // worse than leaving the document's own alone.
    expect(documentTitle(parseHtml('<!doctype html><title></title>'))).toBeUndefined();
    expect(documentTitle(parseHtml('<!doctype html><title>   </title>'))).toBeUndefined();
  });
  it('reads a title the parser moved into head', () => {
    // The tree builder puts <title> in <head> however the source spells it.
    expect(documentTitle(parseHtml('<!doctype html><html><head><title>In Head</title>'
      + '</head><body><p>x</p></body></html>'))).toBe('In Head');
  });
  it('does not mistake a body heading for a title', () => {
    expect(documentTitle(parseHtml('<!doctype html><body><h1>Not A Title</h1></body>')))
      .toBeUndefined();
  });
});
describe('images (zch2.6)', () => {
  // A 1x1 red PNG, the smallest thing buildImageXObject accepts.
  const PNG_1x1 = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  it('renders a lone image from a data: URI with no resolver at all', () => {
    const { skipped } = render(`<p><img src="${PNG_1x1}" alt="a red dot"></p>`);
    expect(names(skipped).some((s) => s.startsWith('image:'))).toBe(false);
  });
  it('treats surrounding WHITESPACE as no content', () => {
    // The commonest formatting of an image in real markup, so it must be a
    // figure and not a reported atomic.
    //
    // Note what this does NOT cover, measured rather than assumed: making
    // `loneAtomic` demand `runs.length === 0` instead of all-whitespace
    // reddens NOTHING. cssinline.ts trims the context's outer edges and then
    // filters every run whose text is '', so a lone atomic provably reaches
    // here with no whitespace run left to see — the two are redundant
    // defences, and breaking either alone proves nothing.
    const { skipped } = render(`<p>\n  <img src="${PNG_1x1}">\n</p>`);
    expect(names(skipped).some((s) => s.startsWith('image:'))).toBe(false);
  });
  it('renders an image sharing its line with text (zch2.11)', () => {
    // INVERTED from zch2.6, and the inversion is the proof the feature
    // landed: until zch2.11 layoutRuns could not place a box in a line, so
    // the text rendered and the image was reported.
    const { skipped, page } = render(`<p>before <img src="${PNG_1x1}"> after</p>`);
    expect(names(skipped).some((s) => s.startsWith('image:'))).toBe(false);
    expect(page.GetText()).toContain('before');
    expect(page.GetText()).toContain('after');
  });
  it('asks the resolver for a non-data src, with the src and the alt', () => {
    const seen: [string, string][] = [];
    render('<p><img src="logo.png" alt="Logo"></p>', 400, {
      resolveImage: (src, alt) => { seen.push([src, alt]); return undefined; },
    });
    expect(seen).toEqual([['logo.png', 'Logo']]);
  });
  it('asks the resolver ONCE for an image it declines (zch2.11)', () => {
    // Found by an existing zch2.6 case going red. A lone image tries the
    // block-figure path first; when that fails it used to fall through to the
    // atomic path, which asked the resolver for the same src a SECOND time.
    // Invisible in the output — the report and the render are identical
    // either way — but a resolver that fetches would do the work twice.
    const seen: string[] = [];
    render('<p><img src="twice.png"></p>', 400, {
      resolveImage: (src) => { seen.push(src); return undefined; },
    });
    expect(seen).toEqual(['twice.png']);
  });

  it('renders the bytes the resolver supplies', () => {
    const bytes = Buffer.from(PNG_1x1.slice(PNG_1x1.indexOf(',') + 1), 'base64');
    const { skipped } = render('<p><img src="logo.png"></p>', 400, {
      resolveImage: () => new Uint8Array(bytes),
    });
    expect(names(skipped)).toEqual([]);
  });
  it('draws BOTH images of a two-image paragraph (zch2.11)', () => {
    // INVERTED from zch2.6, where neither could be placed in a line so both
    // were reported. The guard it carried survives the inversion: the risk
    // was always that one image is drawn and the other silently lost, so the
    // count is what is asserted rather than mere presence.
    const { skipped, page } = render(
      `<p><img src="${PNG_1x1}"><img src="${PNG_1x1}"></p>`);
    expect(names(skipped).filter((s) => s.startsWith('image:')).length).toBe(0);
    const drawn = new TextDecoder('latin1').decode(page.Contents).match(/ Do\b/g);
    expect(drawn).toHaveLength(2);
  });
  it('reports an image the resolver declines rather than throwing', () => {
    const { skipped } = render('<p><img src="missing.png"></p>');
    expect(names(skipped)).toContain('image:missing.png');
  });
  it('reports an image whose bytes will not decode', () => {
    // buildImageXObject rejects anything that is not JPEG or PNG, and the
    // report has to survive that rather than the throw escaping.
    const { skipped } = render('<p><img src="data:image/png;base64,aGk="></p>');
    expect(names(skipped).some((s) => s.startsWith('image:'))).toBe(true);
  });
  it('rejects a resolveImage that is not a function', () => {
    const doc = Document.New();
    expect(() => htmlElements(
      doc, '<p>a</p>', 400, { resolveImage: 'nope' as never }))
      .toThrow(TypeError);
  });
});
describe('links (zch2.6)', () => {
  const annots = (src: string) => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(doc, src, 400);
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    return page.Annotations;
  };
  it('emits ONE /Link annotation for an anchor', () => {
    // A fence rather than a feature: this already works, by cssinline.ts
    // setting TextRun.link and runlink.ts emitting the annotation, and
    // nothing pinned it.
    const a = annots('<p>See <a href="https://example.com">the docs</a> here.</p>');
    expect(a.length).toBe(1);
    expect(a[0].Subtype).toBe('Link');
  });
  it('places one annotation per LINE a link occupies, all to one URI', () => {
    // Note which "one" this is. runlink.ts emits ONE /Link STRUCTURE element
    // per linked run — two would have a screen reader announce the link twice
    // — but one ANNOTATION per line, because a rect is a rectangle and a
    // wrapped link is not: a single rect over three lines would be clickable
    // across the whole paragraph. textdecor.ts's TextRun.link documents it.
    const a = annots(`<p><a href="https://example.com">${'word '.repeat(40)}</a></p>`);
    expect(a.length).toBeGreaterThan(1);
    for (const x of a) {
      expect(x.Subtype).toBe('Link');
      const act = (x as LinkAnnotation).Action;
      expect(act?.type).toBe('uri');
    }
  });
  it('keeps two adjacent links separate', () => {
    // cssinline.ts folds the destination into the run merge key: merged, the
    // whole phrase would point at the second URI, rendering perfectly and
    // linking wrongly.
    const a = annots('<p><a href="https://a.example">a</a>'
      + '<a href="https://b.example">b</a></p>');
    expect(a.length).toBe(2);
  });
  it('emits NO annotation for a fragment-only href, and reports it', () => {
    // A /URI action pointing at "#intro" is a link that looks clickable and
    // does nothing in a viewer. Resolving one needs an id-to-destination map
    // built after placement, which is a follow-up.
    //
    // zch2.6 parked this on `unsupported` as `unparsable-value` and recorded
    // that zch2.7 could widen it. It MOVED: a link we declined to make is a
    // construct we did not render, not a declaration we could not parse.
    const { skipped, unsupported } = render('<p><a href="#intro">jump</a></p>');
    expect(annots('<p><a href="#intro">jump</a></p>').length).toBe(0);
    expect(names(skipped)).toContain('link:#intro');
    expect(skipped.find((s) => s.construct === 'link')?.kind).toBe('degraded');
    expect(unsupported.some((u) => u.property === 'href')).toBe(false);
  });
  it('still renders the TEXT of a fragment link', () => {
    expect(render('<p><a href="#intro">jump</a></p>').page.GetText())
      .toContain('jump');
  });
  it('still links an href that merely CONTAINS a hash', () => {
    // The refusal is for a FRAGMENT-only href. A real URI with a fragment
    // resolves perfectly well as a /URI action.
    expect(annots('<p><a href="https://example.com/a#b">x</a></p>').length).toBe(1);
  });
});
describe('tables end to end (zch2.6)', () => {
  it("draws every cell's text", () => {
    const { page } = render('<table><tr><td>alpha</td><td>beta</td></tr>'
      + '<tr><td>gamma</td><td>delta</td></tr></table>');
    const text = page.GetText();
    for (const w of ['alpha', 'beta', 'gamma', 'delta']) expect(text).toContain(w);
  });
  it('draws the caption and the cells', () => {
    const { page } = render(
      '<table><caption>Totals</caption><tr><td>cell</td></tr></table>');
    expect(page.GetText()).toContain('Totals');
    expect(page.GetText()).toContain('cell');
  });
  it("keeps a spanning cell's text", () => {
    const { page } = render('<table><tr><td colspan=2>wide</td></tr>'
      + '<tr><td>x</td><td>y</td></tr></table>');
    const t = page.GetText();
    expect(t).toContain('wide');
    expect(t).toContain('x');
    expect(t).toContain('y');
  });
  it('keeps the text of a cell whose content had to be flattened', () => {
    const { page, skipped } = render(
      '<table><tr><td><p>one</p><p>two</p></td></tr></table>');
    expect(names(skipped)).toContain('table-cell-blocks');
    expect(page.GetText()).toContain('one');
    expect(page.GetText()).toContain('two');
  });
  it('draws a thead row above its body rows', () => {
    const { page } = render('<table><thead><tr><th>head</th></tr></thead>'
      + '<tbody><tr><td>body</td></tr></tbody></table>');
    const frags = page.GetTextFragments();
    const y = (s: string) => {
      const f = frags.find((x) => x.text.includes(s));
      if (f === undefined) throw new Error(`no fragment for ${s}`);
      return f.quad[1];
    };
    expect(y('head')).toBeGreaterThan(y('body'));
  });
});