import { describe as suite, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { htmlElements } from '../src/htmlflow.js';
import { placeElements } from '../src/flowplace.js';
import { describe as describeReport, CONSTRUCTS } from '../src/htmlreport.js';
import type { HtmlFlowOptions } from '../src/htmlflow.js';
import type { NotRendered } from '../src/htmlreport.js';

function render(src: string, width = 400, options: HtmlFlowOptions = {}) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  // Placement-time records are collected the way page.AddHtml collects them
  // (zch2.16), so this helper reports what that entry point would.
  const late: NotRendered[] = [];
  const { elements, skipped, unsupported } = htmlElements(doc, src, width, {
    ...options, onNotRendered: (r) => { late.push(r); },
  });
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  const all = [...skipped, ...late];
  return {
    page, skipped: all, unsupported,
    text: page.GetText(),
    names: all.map(describeReport),
  };
}

/** The Flow driver, for the one construct a rect provably cannot produce.
 *  `placeElements` hands an unscalable element back as `remainder` rather than
 *  drawing outside the caller's rect (zch2.16), so only `Render` overflows. */
function renderViaFlow(src: string) {
  const { pages, skipped, unsupported } = Document.New().AddHtml(src);
  return {
    page: pages[0], skipped, unsupported,
    text: pages.map((p) => p.GetText()).join(' '),
    names: skipped.map(describeReport),
  };
}

suite('suppression (zch2.7)', () => {
  it("suppresses an iframe's children and keeps the text around it", () => {
    // Asserted POSITIVELY: `not.toContain('fb')` also passes when the whole
    // document failed to render, so the surrounding text must be present too.
    const r = render('<p>before</p><iframe>fb</iframe><p>after</p>');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.text).not.toContain('fb');
    expect(r.names).toContain('iframe');
    expect(r.skipped.find((s) => s.construct === 'iframe')?.kind).toBe('dropped');
  });

  it('RENDERS inline svg, and still does not leak its text into the flow', () => {
    // zch2.12 renders it; what must not come back is the leak zch2.7 closed —
    // the graphic's <text> arriving as a PARAGRAPH. It is drawn by the
    // importer at its own coordinates instead, inside the form.
    const r = render('<p>before</p><svg><text>SVGTEXT</text></svg><p>after</p>');
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.names).not.toContain('svg');
  });

  it('suppresses inline math', () => {
    const r = render('<p>a</p><math><mi>MATHTEXT</mi></math><p>b</p>');
    expect(r.text).toContain('a');
    expect(r.text).not.toContain('MATHTEXT');
    expect(r.names).toContain('math');
  });

  it('KEEPS object, video, audio and canvas fallback, and reports it', () => {
    // The exact opposite assertion on the same shape as the iframe case
    // above, which is what stops "suppress" and "keep" collapsing into one
    // rule that happens to satisfy both tests.
    for (const name of ['object', 'video', 'audio', 'canvas']) {
      const r = render(`<p>x</p><${name}>KEPT</${name}>`);
      expect(r.text, name).toContain('KEPT');
      expect(r.names, name).toContain(name);
      expect(r.skipped.find((s) => s.construct === name)?.kind, name)
        .toBe('degraded');
    }
  });

  it('suppresses a BLOCK-level iframe too, through the other walk', () => {
    // cssbox.ts and cssinline.ts have separate walks. An iframe is inline by
    // default so cssinline sees it; display:block routes it to cssbox, and a
    // policy applied in only one of the two is silent for the other.
    const r = render('<p>before</p><iframe style="display:block">fb</iframe>');
    expect(r.text).toContain('before');
    expect(r.text).not.toContain('fb');
    expect(r.names).toContain('iframe');
  });

  it('reports a suppressed element exactly ONCE', () => {
    const r = render('<iframe>fb</iframe>');
    expect(r.names.filter((n) => n === 'iframe')).toHaveLength(1);
  });

  it('leaves an unknown element alone, with no record', () => {
    const r = render('<my-widget>custom</my-widget>');
    expect(r.text).toContain('custom');
    expect(r.names).toEqual([]);
  });
});

suite('form controls (zch2.7)', () => {
  it("draws an input's value, which used to vanish entirely", () => {
    const r = render('<p>a</p><input value="VALUE">');
    expect(r.text).toContain('VALUE');
    expect(r.names).toContain('input:text');
    expect(r.skipped.find((s) => s.construct === 'input')?.kind).toBe('degraded');
  });

  it('draws NOTHING for a password input', () => {
    // CLAUDE.md records under formfield.ts that a password field's value must
    // never reach a content stream: flattening bakes the plaintext into
    // permanent page content where no viewer will ever mask it again. An HTML
    // password value is the same disclosure by a different route.
    const r = render('<p>a</p><input type="password" value="hunter2">');
    expect(r.text).toContain('a');
    expect(r.text).not.toContain('hunter2');
    expect(r.names).toContain('input:password');
    expect(r.skipped.find((s) => s.construct === 'input')?.kind).toBe('dropped');
  });

  it('draws nothing for a hidden input', () => {
    const r = render('<p>a</p><input type="hidden" value="SECRET">');
    expect(r.text).not.toContain('SECRET');
    expect(r.names).toContain('input:hidden');
  });

  it('draws ONLY the selected option of a select', () => {
    // Emitting every option turns a three-choice dropdown into three lines of
    // body text — a document that looks plausible and says something the
    // source does not.
    const r = render('<select><option>ALPHA<option selected>BRAVO</select>');
    expect(r.text).toContain('BRAVO');
    expect(r.text).not.toContain('ALPHA');
    expect(r.names).toContain('select');
  });

  it('renders what a browser shows for the four <selectedcontent> cases (4h3p)', () => {
    // webkit02.dat#44-47, verbatim. Those four are EXCLUDED from the vendored
    // WPT corpus and permanently so: the predicate matches their expected
    // TREE, which holds text the customizable-select element clones in from
    // the selected <option>, and a parser that produced it would produce a
    // tree no other parser produces. But the RENDER is a separate question,
    // and it already agrees — `selectedOptionText` implements the same rule
    // the four cases turn on (the `selected` attribute, else the first
    // option), so nothing here needed building.
    //
    // Pinned rather than merely recorded: without it a change to that rule
    // would silently break the agreement, and the corpus cannot report it.
    const cases: [string, string][] = [
      ['<select><button><selectedcontent></button><option>X', 'X'],
      ['<select><button><selectedcontent></button><option>x<i>i<b>ib</i>b', 'xiibb'],
      ['<select><button><selectedcontent></button><option>X<option>Y', 'X'],
      ['<select><button><selectedcontent></button><option>X<option selected>Y', 'Y'],
    ];
    for (const [src, expected] of cases) {
      expect(render(src).text.replace(/\s+/g, '')).toBe(expected);
    }
    // The unselected option must not leak, which is the half a `toContain`
    // would miss — cases 3 and 4 each carry the other option's text.
    expect(render(cases[2][0]).text).not.toContain('Y');
    expect(render(cases[3][0]).text).not.toContain('X');
  });

  it('renders a bare <selectedcontent> as ordinary inline content (4h3p)', () => {
    // Outside a <select> there is nothing to mirror, and the element is not in
    // the policy table — so it is an unknown inline and its children render.
    expect(render('<p>a<selectedcontent>BARE</selectedcontent>b</p>').text)
      .toContain('BARE');
  });

  it("keeps a textarea's text and a button's caption", () => {
    const r = render('<textarea>TA</textarea><button>GO</button>');
    expect(r.text).toContain('TA');
    expect(r.text).toContain('GO');
    expect(r.names).toContain('textarea');
    expect(r.names).toContain('button');
  });
});

suite('properties computed and never read (zch2.7)', () => {
  it('reports inline-block, which is laid out as inline', () => {
    const r = render('<span style="display:inline-block;width:50px">ib</span>');
    expect(r.text).toContain('ib');
    expect(r.names).toContain('inline-block');
  });

  it('reports vertical-align, which is ignored', () => {
    // It IS a computed longhand, so the cascade's unknown-property backstop
    // never fires for it — it has zero consumers outside cssprop.ts's table.
    const r = render('<p>x<span style="vertical-align:super">s</span></p>');
    expect(r.names).toContain('vertical-align:super');
  });

  it('does NOT report vertical-align: baseline, the initial value', () => {
    // Every element computes one, so reporting the initial would put a record
    // on every element in every document and make the report unreadable.
    expect(render('<p>plain</p>').names).toEqual([]);
  });

  it('reports padding on an INLINE box, which is ignored', () => {
    const r = render('<p>x<span style="padding:20px">p</span>y</p>');
    expect(r.names).toContain('inline-box:padding');
  });

  it('does NOT report padding on a BLOCK box, where it is applied', () => {
    // cssresolve.ts turns a block's padding into real insets, so a record
    // there would be false.
    expect(render('<p style="padding:20px">x</p>').names).toEqual([]);
  });
});

suite('a nested table end to end (zch2.7)', () => {
  it("draws the inner table's text inside the outer cell", () => {
    const r = render('<table><tr><td>outer'
      + '<table><tr><td>INNER</td></tr></table></td></tr></table>');
    expect(r.text).toContain('outer');
    expect(r.text).toContain('INNER');
    expect(r.names).toContain('table');
  });
});

suite('the inventory sweep (zch2.7)', () => {
  /** One source per construct, and the kind it must report.
   *
   *  This table IS the feature. A construct that stops reporting, or reports
   *  the wrong kind, reddens here whatever else stays green. */
  const CASES: [construct: string, kind: string, src: string, via?: 'flow'][] = [
    ['iframe', 'dropped', '<iframe>fb</iframe>'],
    // Rendering an inline <svg> is zch2.12; what stays reportable is what the
    // IMPORTER could not draw inside it — here an <image> href this library
    // cannot decode, with no resolver.
    ['svg', 'degraded',
      '<svg viewBox="0 0 10 10"><image href="nope.png" width="10" height="10"/></svg>'],
    ['math', 'dropped', '<math><mi>x</mi></math>'],
    ['object', 'degraded', '<object>fb</object>'],
    ['video', 'degraded', '<video>fb</video>'],
    ['audio', 'degraded', '<audio>fb</audio>'],
    ['canvas', 'degraded', '<canvas>fb</canvas>'],
    ['input', 'degraded', '<input value="v">'],
    ['select', 'degraded', '<select><option>a</select>'],
    ['textarea', 'degraded', '<textarea>t</textarea>'],
    ['button', 'degraded', '<button>b</button>'],
    ['inline-block', 'degraded', '<span style="display:inline-block">x</span>'],
    ['vertical-align', 'degraded', '<p>x<span style="vertical-align:super">s</span></p>'],
    ['inline-box', 'degraded', '<p>x<span style="padding:9px">s</span></p>'],
    // A same-side PAIR: since zch2.10 a LONE float renders and reports
    // nothing, and what remains reportable is CSS putting two same-side floats
    // side by side where Flow stacks them.
    ['float', 'degraded',
      '<div style="float:left;width:50px">s</div><div style="float:left;width:50px">t</div>'],
    ['image', 'dropped', '<p>t <img src="a.png"> t</p>'],
    ['table', 'degraded',
      '<table><tr><td><table><tr><td>i</td></tr></table></td></tr></table>'],
    ['table-cell-blocks', 'degraded',
      '<table><tr><td><p>a</p><p>b</p></td></tr></table>'],
    ['link', 'degraded', '<p><a href="#f">j</a></p>'],
    // Only a Flow overflows (zch2.16); a rect hands the element back instead.
    ['overflow', 'degraded', '<p style="font-size:900px">W</p>', 'flow'],
    ['text', 'dropped', '<p>При</p>'],
  ];

  it('covers every construct in the vocabulary', () => {
    // The sweep and the vocabulary must not drift: a construct added to one
    // and not the other is exactly the silent gap this issue exists to close.
    expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set(CONSTRUCTS));
  });

  for (const [construct, kind, src, via] of CASES) {
    it(`reports ${construct} as ${kind}`, () => {
      const r = via === 'flow' ? renderViaFlow(src) : render(src);
      const hit = r.skipped.find((s) => s.construct === construct);
      expect(hit, `no ${construct} record in ${JSON.stringify(r.names)}`)
        .toBeDefined();
      expect(hit!.kind).toBe(kind);
    });
  }

  it('reports NOTHING for a document that renders whole', () => {
    // The other half: a report that fires on ordinary markup is a report
    // nobody reads.
    const r = render('<h1>T</h1><p>Body <b>bold</b> and '
      + '<a href="https://e.example">a link</a>.</p>'
      + '<ul><li>one</li><li>two</li></ul>'
      + '<table><tr><th>h</th></tr><tr><td>c</td></tr></table>');
    expect(r.names).toEqual([]);
  });
});

suite('inline images (zch2.11)', () => {
  const PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bytes = (page: { Contents: Uint8Array }) =>
    new TextDecoder('latin1').decode(page.Contents);

  it('renders an image sharing its line with text, and reports nothing', () => {
    const r = render(`<p>before <img src="${PNG}"> after</p>`);
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.names.some((n) => n.startsWith('image:'))).toBe(false);
  });

  it('still reports an image it cannot resolve', () => {
    // What LEAVES the report is a RESOLVABLE image sharing a line with text.
    const r = render('<p>a <img src="missing.png"> b</p>');
    expect(r.names).toContain('image:missing.png');
  });

  it('sizes an img from its width and height attributes', () => {
    const r = render(`<p>a <img src="${PNG}" style="width:40px;height:20px"> b</p>`);
    // 40 CSS px -> 30pt, 20 -> 15.
    expect(bytes(r.page)).toMatch(/30 0 0 15 /);
  });

  it('reports vertical-align on a SPAN but not on an aligned IMG', () => {
    // Two rules where there was one: top/bottom are implemented for an atomic
    // and for nothing else. A single widened rule satisfies either fixture
    // alone, so both are asserted.
    expect(render(`<p>a <img src="${PNG}" style="vertical-align:top"> b</p>`).names)
      .not.toContain('vertical-align:top');
    expect(render('<p>a<span style="vertical-align:top">s</span></p>').names)
      .toContain('vertical-align:top');
  });

  it('still reports an img asking for a value we do not implement', () => {
    expect(render(`<p>a <img src="${PNG}" style="vertical-align:middle"> b</p>`).names)
      .toContain('vertical-align:middle');
  });
});

suite('inline images end to end (zch2.11)', () => {
  const PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('puts the following word to the RIGHT of the image', () => {
    // The pen-advance rule, end to end: without the TJ kern "after" would sit
    // where it sits with no image at all, on top of the picture.
    const withImg = render(
      `<p>before <img src="${PNG}" style="width:60px;height:12px"> after</p>`)
      .page.GetTextFragments().find((f) => f.text.includes('after'))!;
    const without = render('<p>before  after</p>')
      .page.GetTextFragments().find((f) => f.text.includes('after'))!;
    expect(withImg.quad[0]).toBeGreaterThan(without.quad[0] + 40);
  });

  it('wraps to a second line when the image does not fit', () => {
    const r = render(
      `<p>aaaa bbbb cccc <img src="${PNG}" style="width:300px;height:12px"> dddd</p>`,
      200);
    expect(r.text).toContain('aaaa');
    expect(r.text).toContain('dddd');
  });

  it('keeps a LONE image on the block path', () => {
    // zch2.6's figure rule is untouched: a lone image is still a block image,
    // not an atomic, so its width still fills the column.
    const r = render(`<p><img src="${PNG}"></p>`);
    expect(r.names).toEqual([]);
    expect(new TextDecoder('latin1').decode(r.page.Contents)).toMatch(/ Do/);
  });
});
