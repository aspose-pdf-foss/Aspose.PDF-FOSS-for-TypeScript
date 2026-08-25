import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf, TEXT_CONTENT, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';
import { escapeHtml } from '../src/html.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';
import { buildTextAndImagePage, buildTwoImagePage } from './helpers/build-edit-pdf.js';
import { imageHref } from '../src/imagehref.js';
import { buildSimpleTtfPdf, buildSimpleCffPdf, buildCffOttoPdf, buildWholeFontPdf } from './helpers/build-optimize-pdf.js';
import { buildRestrictedTtfPdf, buildLigatureTtfPdf, buildTwoRunTtfPdf } from './helpers/build-embed-fonts.js';
import { sfntFromWoff } from '../src/woff.js';
import { parseSfnt } from '../src/sfnt.js';
import { readFileSync } from 'node:fs';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';
import { Type1Font } from '../src/type1.js';
import { CffFont } from '../src/cff.js';
import { buildType1, t1num } from './helpers/build-type1.js';
import type { Path } from '../src/pagerender.js';

describe('ToHtml — shell', () => {
  it('returns a standalone HTML document', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const html = doc.Pages[0].ToHtml();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('omits the shell for fragment: true', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const html = doc.Pages[0].ToHtml({ fragment: true });
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('<html');
  });

  it('uses the title option, escaped', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    expect(doc.ToHtml({ title: 'A & B' })).toContain('<title>A &amp; B</title>');
  });

  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });
});

describe('ToHtml — untagged semantic', () => {
  it('ranks the larger size as a heading and body text as a paragraph', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<p>Revenue grew twelve percent this year.</p>');
  });

  it('escapes text content', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).not.toContain('<script');
  });

  it('splits a heading out of the block it was clustered into', () => {
    // The block grouper puts the 24pt heading and the 12pt body in ONE block,
    // since they are left-aligned and close together. Ranking per block would
    // let the longer body text outvote the heading and emit a single <p>.
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const blocks = doc.Pages[0].GetStructuredText();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lines).toHaveLength(2);

    const html = doc.ToHtml({ fragment: true });
    expect(html).toBe('<h1>Quarterly Report</h1>\n<p>Revenue grew twelve percent this year.</p>');
  });

  // A ruled card used to reach the export as an empty one-cell <table>; its
  // text belongs in the prose flow instead.
  it('emits no table for a ruled card, and keeps its text as prose', () => {
    const stream = hline(20, 120, 220) + hline(20, 120, 280)
      + vline(20, 220, 280) + vline(120, 220, 280)
      + text(30, 250, 'Card heading')
      + hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
      + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
      + text(55, 175, 'A') + text(105, 175, 'B')
      + text(55, 125, 'C') + text(105, 125, 'D');
    const html = Document.Open(buildTablePdf(stream)).ToHtml({ fragment: true });

    expect(html.match(/<table>/g)).toHaveLength(1);   // the real grid only
    expect(html).not.toContain('<td></td>');
    expect(html).toContain('Card heading');           // not dropped, just not a table
    expect(html).not.toMatch(/<t[dh][^>]*>Card heading/);
  });
});

// A caption and a 1x1 image scaled to 100pt, for the /Figure path.
const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

// A 2x2 ruled grid with cell text, as AutoTag's table detection sees it.
const RULED_TABLE = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
  + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
  + text(55, 175, 'A') + text(105, 175, 'B')
  + text(55, 125, 'C') + text(105, 125, 'D');

describe('ToHtml — tagged semantic', () => {
  it('drives markup from the structure tree', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<p>Page one body</p>');
    expect(html).toContain('<p>Page two body</p>');
    expect(html).toContain('<div>');            // Document/Sect wrappers
  });

  it('uses /Alt as a figure\'s alt text', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('alt="A figure"');
  });

  it('resolves a custom role through the RoleMap to a heading', () => {
    // MyHead -> SubHead -> H2.
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('<h2');
  });

  it('emits /Lang on an element that declares one', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('lang="en-GB"');
  });

  it('lets /ActualText replace the element\'s glyph text', () => {
    const doc = Document.Open(buildTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<p>Body paragraph actual</p>');
  });

  it('renders a tagged table through Table.toHtml', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<table>');
    expect(html).toContain('<caption>Employee directory</caption>');
    expect(html).toContain('<thead>');
    expect(html).toContain('scope="col"');
    // Exactly one table, despite the walk visiting the Table element once.
    expect(html.match(/<table>/g)).toHaveLength(1);
  });

  // /Pg is optional on a Table element whose content all lives in its cells,
  // which is exactly what AutoTag authors. Keying the lookup on the element's
  // own /Pg dropped every such table.
  it('renders a Table element that carries no /Pg of its own', () => {
    const doc = Document.Open(buildTablePdf(RULED_TABLE));
    doc.AutoTag();
    const html = Document.Open(doc.Save()).ToHtml({ fragment: true });
    expect(html).toContain('<table>');
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain('>A</th>');
    expect(html).toContain('>D</td>');
  });

  // The untagged path has always inlined images; the tagged path emitted a bare
  // <img alt> with nothing to show.
  it('inlines the image a /Figure marks as a data URI', () => {
    const src = buildTextAndImagePage(FIGURE_PAGE);

    const untagged = Document.Open(src).ToHtml({ fragment: true });
    expect(untagged).toMatch(/<img src="data:image\/png;base64,/); // baseline

    const doc = Document.Open(src);
    doc.AutoTag({ alt: () => 'a company logo' });
    const html = Document.Open(doc.Save()).ToHtml({ fragment: true });
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    expect(html).toContain('alt="a company logo"');
  });

  // Proves the MCID match is load-bearing rather than "any image on the page":
  // two Figures on one page, whose images encode to different bytes. Pairing
  // each src with its own /Alt fails if the lookup grabs every image, matches
  // the wrong MCID, or pairs them in the wrong order.
  it('pairs each /Figure with the image it marks, not the page\'s other one', () => {
    const doc = Document.Open(buildTwoImagePage(
      'q 60 0 0 60 20 200 cm /Im0 Do Q q 60 0 0 60 20 100 cm /Im1 Do Q'));
    doc.AutoTag({ alt: (e) => (e.quad[1] < 150 ? 'lower' : 'upper') });

    const href = (n: string) =>
      imageHref(doc, doc.Pages[0].Images.find((i) => i.Name === n)!.Stream, [0, 0, 0])!;
    const white = href('Im0'), black = href('Im1');
    expect(white).not.toBe(black);   // the fixture actually distinguishes them

    const html = Document.Open(doc.Save()).ToHtml({ fragment: true });
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain(`<img src="${white}" alt="upper"/>`);
    expect(html).toContain(`<img src="${black}" alt="lower"/>`);
  });

  it('keeps only this page\'s elements, with ancestor nesting intact', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.Pages[1].ToHtml({ fragment: true });
    expect(html).toContain('<p>Page two body</p>');
    expect(html).not.toContain('Page one body');
    expect(html).not.toContain('alt="A figure"');   // Figure is on page 1
    // The Sect ancestor survives around the kept P.
    expect(html).toMatch(/<div>[\s\S]*<p>Page two body<\/p>[\s\S]*<\/div>/);
  });
});

/** Strip tags and decode the entities escapeHtml produces. */
function htmlText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

describe('ToHtml — round-trip', () => {
  it('preserves untagged page text', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const expected = htmlText(escapeHtml(doc.Pages[0].GetText()));
    expect(htmlText(doc.ToHtml({ fragment: true }))).toBe(expected);
  });

  it('preserves tagged document text', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const text = htmlText(doc.ToHtml({ fragment: true }));
    expect(text).toContain('Page one body');
    expect(text).toContain('Page two body');
    // Each run appears exactly once.
    expect(text.match(/Page one body/g)).toHaveLength(1);
  });
});

describe('ToHtml — an image that will not encode', () => {
  // The asymmetry DocFigure.tagged records: a tagged /Figure still announces
  // itself through its /Alt, because that is the accessible content, while an
  // untagged bare page image has no alt and so leaves nothing behind. Nothing
  // else in the suite reaches this — every other fixture's image encodes, so
  // the byte-identity snapshot cannot protect the distinction.
  it('untagged: emits no img at all', () => {
    const doc = Document.Open(buildTextAndImagePage(FIGURE_PAGE));
    doc.Pages[0].Images[0].Stream.dict.set('Width', 0);   // imageHref gives up
    const html = doc.ToHtml({ fragment: true });
    expect(html).not.toContain('<img');
    expect(html).toContain('caption');                    // the page's text survives
  });

  it('tagged: still emits the alt', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('<img alt="A figure"/>');
  });
});

describe('ToHtml — fixed mode', () => {
  const textDoc = () => Document.Open(
    buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT }));

  it('positions a run at its device baseline, ascent-adjusted', () => {
    // TEXT_CONTENT: Helvetica-Bold size 24 at (72,100) on a 200x200 page.
    // baseMatrix flips y -> device baseline (72,100). sans-serif ascent 0.846:
    // top = 100 - 0.846*24 = 79.696.
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('<span class="f0" style="left:72px;top:79.696px;font-size:24px">Hi</span>');
  });

  it('emits an SVG backdrop inside a page div sized to the crop box', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('<div class="pg" style="width:200px;height:200px">');
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"');
  });

  it('never draws text into the backdrop (no <text>, "Hi" appears once)', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).not.toContain('<text');
    expect((html.match(/Hi/g) ?? []).length).toBe(1);
  });

  it('emits the font class CSS in the shell', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('.f0{font-family:Arial, Helvetica, sans-serif;font-weight:700;font-style:normal;color:#000000}');
  });

  it('emits a CSS transform for a rotated run', () => {
    // 90-degree rotation via cm before the text; L gains off-diagonal terms,
    // so glyphRun takes the transform path.
    const content = 'q 0 1 -1 0 100 0 cm BT /F1 24 Tf 10 10 Td (Hi) Tj ET Q';
    const doc = Document.Open(
      buildSvgPdf({ mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content }));
    const html = doc.Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('transform:matrix(');
  });

  it('renders every page as its own div inside one document', () => {
    const html = Document.Open(buildMultiPageTaggedPdf()).ToHtml({ mode: 'fixed' });
    expect((html.match(/<div class="pg"/g) ?? []).length).toBe(2);
    expect((html.match(/<html/g) ?? []).length).toBe(1);
    expect(html).toContain('Page one body');
    expect(html).toContain('Page two body');
  });

  it('round-trips text: fixed output contains every GetText word', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ mode: 'fixed', fragment: true });
    const stripped = html.replace(/<[^>]+>/g, '');
    for (const word of doc.Pages[0].GetText().split(/\s+/).filter(Boolean)) {
      expect(stripped).toContain(word);
    }
  });

  it('omits the shell (and its font CSS) for fragment: true', () => {
    const html = textDoc().Pages[0].ToHtml({ mode: 'fixed', fragment: true });
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('<style>');
    expect(html).toContain('<div class="pg"');
  });
});

describe('ToHtml — fixed embed', () => {
  function firstWoff(html: string): Uint8Array {
    const m = html.match(/data:font\/woff;base64,([A-Za-z0-9+/=]+)/);
    if (!m) throw new Error('no embedded woff');
    return new Uint8Array(Buffer.from(m[1], 'base64'));
  }

  it('TrueType: one @font-face, base64 woff parses back to an sfnt', () => {
    const html = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect((html.match(/@font-face/g) ?? []).length).toBe(1);
    expect(html).toContain('src:url(data:font/woff;base64,');
    const f = parseSfnt(sfntFromWoff(firstWoff(html)));
    expect(f.cmap.size).toBeGreaterThan(0);
  });

  it('bare CFF wraps into a parseable OTTO', () => {
    const html = Document.Open(buildSimpleCffPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    const f = parseSfnt(sfntFromWoff(firstWoff(html)));
    expect(f.outlines).toBe('cff');
  });

  it('OpenType-CFF FontFile3 embeds', () => {
    const html = Document.Open(buildCffOttoPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
  });

  it('Type0/CIDFontType2 embeds', () => {
    const html = Document.Open(buildWholeFontPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
  });

  it('fsType-restricted font is skipped under embed, embedded under embed-all', () => {
    const pdf = buildRestrictedTtfPdf();
    expect(Document.Open(pdf).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' })).not.toContain('@font-face');
    expect(Document.Open(pdf).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed-all' })).toContain('@font-face');
  });

  it('default (map) output is unchanged vs no fonts option', () => {
    const a = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed' });
    const b = Document.Open(buildSimpleTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'map' });
    expect(b).toBe(a);
    expect(a).not.toContain('@font-face');
  });

  it('a multi-scalar ToUnicode glyph is emitted as a PUA codepoint', () => {
    const html = Document.Open(buildLigatureTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect(html).toContain('@font-face');
    // The "ffi" glyph renders from a Private-Use codepoint (U+E000..U+F8FF),
    // not the literal string.
    expect([...html].some(ch => { const c = ch.codePointAt(0) ?? 0; return c >= 0xe000 && c <= 0xf8ff; })).toBe(true);
    expect(html).not.toContain('ffi');
  });

  it('two runs sharing one font dict emit exactly one @font-face', () => {
    const html = Document.Open(buildTwoRunTtfPdf()).Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
    expect((html.match(/@font-face/g) ?? []).length).toBe(1);
  });

  describe('Type 1 /FontFile (m9on)', () => {
    const T1 = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));
    const t1 = new Type1Font(T1);

    /** Round as the Type 2 emitter does, and drop 'Z' — Type 2 closes
     *  subpaths implicitly, so a close has no counterpart to compare. */
    const cmp = (p: Path): Path => p.filter((g) => g.op !== 'Z').map((g) => g.op === 'C'
      ? { op: 'C' as const, x1: Math.round(g.x1), y1: Math.round(g.y1),
          x2: Math.round(g.x2), y2: Math.round(g.y2), x: Math.round(g.x), y: Math.round(g.y) }
      : { op: g.op, x: Math.round((g as { x: number }).x), y: Math.round((g as { y: number }).y) });

    const htmlFor = (text: string): string =>
      Document.Open(buildType1Pdf(T1, { text, size: 24 }))
        .Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });

    it('embeds a Type 1 as one @font-face whose woff parses back to an OTTO', () => {
      const html = htmlFor('A');
      expect((html.match(/@font-face/g) ?? []).length).toBe(1);
      expect(parseSfnt(sfntFromWoff(firstWoff(html))).outlines).toBe('cff');
    });

    it('resolves the cmap to the glyph the PDF actually drew', () => {
      // THE LOAD-BEARING CASE. type1ToCff RENUMBERS so .notdef is gid 0, which
      // CFF requires -- and NimbusSans-Regular.t1 lists /.notdef LAST, so every
      // glyph shifts by one. gidToCp is collected in the Type 1 program's OWN
      // numbering, so without a remap the cmap points each codepoint at its
      // neighbour. Both are valid gids, so nothing throws: the page renders
      // the wrong letters.
      //
      // 'B' rather than 'A', and that choice is load-bearing. In this fixture
      // A=0, B=1, .notdef=854, so an un-remapped 'A' asks for gid 0, which is
      // .notdef after renumbering -- and cmap format 4 reports glyph 0 as
      // ABSENT, so the bug would surface as a missing lookup rather than as
      // the wrong picture. An un-remapped 'B' asks for gid 1, which IS a real
      // glyph after renumbering: 'A'. That is the actual failure mode.
      const sf = parseSfnt(sfntFromWoff(firstWoff(htmlFor('B'))));
      const gid = sf.cmapLookup(0x42);
      expect(gid).toBeDefined();
      const drawn = new CffFont(sf.table('CFF ')!).glyphPath(gid!);
      expect(cmp(drawn)).toEqual(cmp(t1.glyphPath(t1.gidForName('B')!)));
      // ...and NOT 'A', which is what an un-remapped build returns.
      expect(cmp(drawn)).not.toEqual(cmp(t1.glyphPath(t1.gidForName('A')!)));
      // The premise: the fixture really does list .notdef last, so this test
      // would pass trivially on a font whose gid order already agreed.
      expect(t1.glyphName(0)).not.toBe('.notdef');
    });

    it('is embedded under plain embed: a Type 1 states no fsType', () => {
      // There is no OS/2 table in a Type 1, so there are no embedding-permission
      // bits to honour and the two modes agree. The asymmetry with TrueType is
      // structural, not an oversight.
      expect(htmlFor('A')).toContain('@font-face');
      expect(Document.Open(buildType1Pdf(T1, { text: 'A', size: 24 }))
        .Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed-all' })).toContain('@font-face');
    });

    it('takes units per em from /FontMatrix, not a flat 1000', () => {
      // The advance is written in FONT UNITS while head.unitsPerEm comes from
      // the converted program, so a hardcoded 1000 against a 2048/em face makes
      // every glyph advance half as far as it should -- a plausible narrow
      // face rather than an obvious fault. The PDF's /Widths say one full em,
      // so the emitted advance must equal unitsPerEm whatever that is.
      const prog = buildType1({
        charstrings: {
          '.notdef': Uint8Array.from([...t1num(0), ...t1num(0), 13, 14]),
          'A': Uint8Array.from([...t1num(0), ...t1num(2048), 13, 14]),
        },
        fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0],
      });
      const html = Document.Open(buildType1Pdf(prog, { text: 'A', size: 24 }))
        .Pages[0].ToHtml({ mode: 'fixed', fonts: 'embed' });
      const sf = parseSfnt(sfntFromWoff(firstWoff(html)));
      expect(sf.unitsPerEm).toBe(2048);
      expect(sf.advanceWidth(sf.cmapLookup(0x41)!)).toBe(2048);
    });

    it('map mode still emits no @font-face', () => {
      expect(Document.Open(buildType1Pdf(T1, { text: 'A', size: 24 }))
        .Pages[0].ToHtml({ mode: 'fixed' })).not.toContain('@font-face');
    });
  });
});

describe('backdrop is additive (kf8h.2)', () => {
  /** A page with text and vector graphics — enough that a stray change to the
   *  backdrop path would show. */
  function fixturePage(): Document {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('Fence', 50, 700, { fontSize: 18 });
    const g = page.Graphics();
    g.setFillColor([0, 0, 1]).rect(50, 400, 120, 80).fill();
    g.apply();
    return doc;
  }

  it('omitting backdrop is byte-identical to passing vector', () => {
    // The fence: `backdrop` absent must behave exactly as it did before the
    // option existed. This is not a golden to refresh — a failure means the
    // feature stopped being additive.
    expect(fixturePage().ToHtml({ mode: 'fixed' }))
      .toBe(fixturePage().ToHtml({ mode: 'fixed', backdrop: 'vector' }));
  });

  it('the default output still contains its SVG backdrop and no image', () => {
    const html = fixturePage().ToHtml({ mode: 'fixed' });
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });
});

describe('forms is additive (kf8h.1)', () => {
  it('omitting forms is byte-identical to passing false', () => {
    // The fence: an existing caller's output must not move.
    const a = Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed' });
    const b = Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed', forms: false });
    expect(a).toBe(b);
  });
});
