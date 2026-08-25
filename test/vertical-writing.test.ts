import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { TextFont, glyphDisplacement, tjShift, glyphOrigin } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildInkTtf } from './helpers/build-sfnt.js';
import { decodePng } from './helpers/decode-png.js';

const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));
const bytes = (...b: number[]) => Uint8Array.from(b);
const id = (o: PdfObject | undefined) => o as PdfObject;
const noInflate = () => new Uint8Array(0);

/** A Type0 font over one descendant CIDFont, `/Encoding` given by name. */
function type0(encoding: string, cidFont: Record<string, PdfObject> = {}): TextFont {
  return new TextFont(dict({
    Subtype: name('Type0'),
    BaseFont: name('KozMinPr6N-Regular'),
    Encoding: name(encoding),
    DescendantFonts: [dict({ Subtype: name('CIDFontType0'), DW: 1000, ...cidFont })],
  }), id, noInflate as never);
}

describe('vertical metrics: /DW2 and /W2', () => {
  it('defaults to the spec values when the font declares neither', () => {
    // 32000-1 9.7.4.3: /DW2 defaults to [880, -1000].
    const g = type0('Identity-V').decodeGlyphs(bytes(0x00, 0x05))[0];
    expect(g.vertical).toBeDefined();
    expect(g.vertical!.w1).toBeCloseTo(-1);      // -1000/1000
    expect(g.vertical!.vy).toBeCloseTo(0.88);    //  880/1000
    // No /W2 vector: vx defaults to half the glyph's own horizontal width.
    expect(g.vertical!.vx).toBeCloseTo(0.5);     // /DW 1000 -> w0 = 1
  });

  it('centres the default position vector on the glyph\'s own width', () => {
    // A half-width glyph must sit half as far across, or a run of mixed widths
    // wanders off the column axis.
    const f = type0('Identity-V', { W: [5, [500]] });
    expect(f.decodeGlyphs(bytes(0x00, 0x05))[0].vertical!.vx).toBeCloseTo(0.25);
  });

  it('reads /DW2', () => {
    const g = type0('Identity-V', { DW2: [800, -1200] }).decodeGlyphs(bytes(0x00, 0x05))[0];
    expect(g.vertical!.w1).toBeCloseTo(-1.2);
    expect(g.vertical!.vy).toBeCloseTo(0.8);
  });

  it('reads the /W2 array form, whose triples advance with the CID', () => {
    // c [w1y vx vy  w1y vx vy] — CID 5 then CID 6.
    const f = type0('Identity-V', { W2: [5, [-900, 400, 850, -1100, 450, 870]] });
    const a = f.decodeGlyphs(bytes(0x00, 0x05))[0].vertical!;
    const b = f.decodeGlyphs(bytes(0x00, 0x06))[0].vertical!;
    expect([a.w1, a.vx, a.vy].map((v) => +v.toFixed(3))).toEqual([-0.9, 0.4, 0.85]);
    expect([b.w1, b.vx, b.vy].map((v) => +v.toFixed(3))).toEqual([-1.1, 0.45, 0.87]);
  });

  it('reads the /W2 range form, whose vector is shared by the whole range', () => {
    // cFirst cLast w1y vx vy — every CID in 5..7 gets the *same* vector, which
    // is the one place the two shapes differ in meaning rather than spelling.
    const f = type0('Identity-V', { W2: [5, 7, -950, 500, 900] });
    for (const cid of [5, 6, 7]) {
      const v = f.decodeGlyphs(bytes(0x00, cid))[0].vertical!;
      expect([v.w1, v.vx, v.vy].map((x) => +x.toFixed(3))).toEqual([-0.95, 0.5, 0.9]);
    }
    // Outside the range, the defaults apply again.
    expect(f.decodeGlyphs(bytes(0x00, 0x08))[0].vertical!.w1).toBeCloseTo(-1);
  });

  it('leaves a horizontal font with no vertical metrics at all', () => {
    expect(type0('Identity-H').decodeGlyphs(bytes(0x00, 0x05))[0].vertical).toBeUndefined();
  });
});

describe('displacement along the writing direction', () => {
  const vert = type0('Identity-V');
  const horiz = type0('Identity-H');

  it('runs down the page vertically and across horizontally', () => {
    const [vx, vy] = glyphDisplacement(vert.decodeGlyphs(bytes(0, 5))[0], 12, 0, 0, 1);
    expect(vx).toBe(0);
    expect(vy).toBeCloseTo(-12);          // w1 = -1 em, PDF Y up -> downward
    const [hx, hy] = glyphDisplacement(horiz.decodeGlyphs(bytes(0, 5))[0], 12, 0, 0, 1);
    expect(hx).toBeCloseTo(12);
    expect(hy).toBe(0);
  });

  it('does not apply horizontal scaling to a vertical advance', () => {
    // Tz scales horizontal displacements only (32000-1 9.4.4).
    const g = vert.decodeGlyphs(bytes(0, 5))[0];
    expect(glyphDisplacement(g, 12, 0, 0, 2)[1]).toBeCloseTo(-12);
    const h = horiz.decodeGlyphs(bytes(0, 5))[0];
    expect(glyphDisplacement(h, 12, 0, 0, 2)[0]).toBeCloseTo(24);
  });

  it('adds char spacing to the vertical axis', () => {
    const g = vert.decodeGlyphs(bytes(0, 5))[0];
    expect(glyphDisplacement(g, 12, 3, 0, 1)[1]).toBeCloseTo(-9); // -12 + 3
  });

  it('moves a TJ adjustment backwards along the writing direction', () => {
    // Positive TJ moves back: leftwards horizontally, upwards vertically.
    expect(tjShift(1000, 12, 1, false)).toEqual([-12, 0]);
    expect(tjShift(1000, 12, 1, true)).toEqual([0, -12]);
    expect(tjShift(-1000, 12, 1, true)).toEqual([0, 12]);
  });

  it('draws a vertical glyph offset by the negated position vector', () => {
    const g = vert.decodeGlyphs(bytes(0, 5))[0];
    const [ox, oy] = glyphOrigin(g, 100, 200, 10, 1);
    expect(ox).toBeCloseTo(100 - 0.5 * 10);   // vx = 0.5 em
    expect(oy).toBeCloseTo(200 - 0.88 * 10);  // vy = 0.88 em
    // A horizontal glyph draws at the pen, untouched.
    expect(glyphOrigin(horiz.decodeGlyphs(bytes(0, 5))[0], 100, 200, 10, 1)).toEqual([100, 200]);
  });
});

/** A page of vertical text: an embedded ink font, /Identity-V, three glyphs. */
function verticalPage(opts: { content: string; encoding?: string } ): Document {
  const ttf = buildInkTtf();
  const ff2 = deflateSync(Buffer.from(ttf));
  // /ToUnicode so extraction has characters to order.
  const tu = new TextEncoder().encode(
    '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
    '3 beginbfchar <0001> <3042> <0002> <3044> <0003> <3046> endbfchar\n');
  const tuz = deflateSync(Buffer.from(tu));
  return Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 300, 300],
    // F0 takes the requested writing mode; F1 is always horizontal, for the
    // mixed-direction case.
    resources: '<< /Font << /F0 5 0 R /F1 10 0 R >> >>',
    content: opts.content,
    extra: {
      10: '<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>',
      5: `<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding /${opts.encoding ?? 'Identity-V'} /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>`,
      6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 1000 >>',
      7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
      8: { dict: `<< /Filter /FlateDecode /Length ${ff2.length} /Length1 ${ttf.length} >>`, raw: ff2 },
      9: { dict: `<< /Filter /FlateDecode /Length ${tuz.length} >>`, raw: tuz },
    },
  }));
}

describe('extraction of a vertically-set page', () => {
  it('groups a column into one fragment that reads downward', () => {
    const doc = verticalPage({ content: 'BT /F0 20 Tf 200 250 Td <000100020003> Tj ET' });
    const frags = doc.Pages[0].GetTextFragments();
    expect(frags.length).toBe(1);
    expect(frags[0].vertical).toBe(true);
    expect(frags[0].text).toBe('あいう');
    // The column runs downward from the start: its box is taller than it is wide.
    const [x0, y0, x1, y1] = frags[0].quad;
    expect(y1 - y0).toBeGreaterThan(x1 - x0);
    expect(y1).toBeLessThanOrEqual(250);
  });

  it('reads columns right to left', () => {
    // Two columns: the left one drawn first, the right one second. Japanese
    // vertical text reads right-to-left, so content order must not win.
    const doc = verticalPage({
      content:
        'BT /F0 20 Tf 100 250 Td <00010001> Tj ET\n' +   // left column: ああ
        'BT /F0 20 Tf 200 250 Td <00020002> Tj ET\n',    // right column: いい
    });
    expect(doc.Pages[0].GetText()).toBe('いい\nああ');
  });

  it('orders glyphs within a column top to bottom', () => {
    const doc = verticalPage({ content: 'BT /F0 20 Tf 200 250 Td <000100020003> Tj ET' });
    expect(doc.Pages[0].GetText()).toBe('あいう');
  });

  it('keeps a horizontal page ordering exactly as before', () => {
    const doc = verticalPage({
      encoding: 'Identity-H',
      content:
        'BT /F0 20 Tf 100 250 Td <00010001> Tj ET\n' +
        'BT /F0 20 Tf 100 200 Td <00020002> Tj ET\n',
    });
    // Horizontal: top line first, and no column reordering.
    expect(doc.Pages[0].GetText()).toBe('ああ\nいい');
    expect(doc.Pages[0].GetTextFragments()[0].vertical).toBeUndefined();
  });

  it('lays a mixed page out per direction, vertical body first', () => {
    // Vertical body (F0) plus a horizontal running head (F1) above it. There is
    // no single ordering right for both; interleaving by position would drop the
    // head into the middle of the column.
    const doc = verticalPage({
      content:
        'BT /F1 20 Tf 40 280 Td <00030003> Tj ET\n' +     // horizontal head: うう
        'BT /F0 20 Tf 200 250 Td <00010001> Tj ET\n',     // vertical body:   ああ
    });
    expect(doc.Pages[0].GetText()).toBe('ああ\nうう');
    const frags = doc.Pages[0].GetTextFragments();
    expect(frags.map((f) => f.vertical)).toEqual([undefined, true]); // content order
  });

  it('finds vertical text through Search, in column order', () => {
    const doc = verticalPage({ content: 'BT /F0 20 Tf 200 250 Td <000100020003> Tj ET' });
    const hits = doc.Pages[0].Search('いう');
    expect(hits.length).toBe(1);
  });
});

describe('rendering a vertically-set page', () => {
  const near = (v: number, t: number, tol = 20) => Math.abs(v - t) <= tol;
  const isRed = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
  const isWhite = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

  it('advances glyphs down the page, not across', () => {
    const doc = verticalPage({ content: 'BT /F0 40 Tf 1 0 0 rg 150 250 Td <00010001> Tj ET' });
    const png = decodePng(doc.Pages[0].ToImage());
    // Two glyphs, one above the other on one column. Device Y grows downward,
    // so the second glyph is *below* the first and neither is to its right.
    let top = -1, bottom = -1;
    for (let y = 0; y < 300; y++) {
      if (isRed(png.at(150, y))) { if (top < 0) top = y; bottom = y; }
    }
    expect(top).toBeGreaterThan(0);
    expect(bottom - top).toBeGreaterThan(40);   // spans more than one glyph box
    // Nothing painted a column's width to the right, which is where a
    // horizontal advance would have put the second glyph.
    expect(isWhite(png.at(230, top + 10))).toBe(true);
  });

  it('carries the downward advance from one show operator to the next', () => {
    // Two separate Tj in one text object. The advance *between* runs is the
    // interpreter's, not the per-glyph loop's, so a single Tj never exercises
    // it — and a run-level advance stuck on the x axis puts the second glyph
    // beside the first instead of below it.
    const doc = verticalPage({
      content: 'BT /F0 40 Tf 1 0 0 rg 150 250 Td <0001> Tj <0001> Tj ET',
    });
    const png = decodePng(doc.Pages[0].ToImage());
    const inkRows: number[] = [];
    for (let y = 0; y < 300; y++) if (isRed(png.at(150, y))) inkRows.push(y);
    expect(inkRows.length).toBeGreaterThan(0);
    // Ink spans two glyph boxes down the same column...
    expect(inkRows[inkRows.length - 1] - inkRows[0]).toBeGreaterThan(40);
    // ...and the column to the right, where a horizontal advance would have put
    // the second run, is untouched.
    for (const y of [inkRows[0] + 5, inkRows[inkRows.length - 1] - 5]) {
      expect(isWhite(png.at(215, y)), `x=215 y=${y}`).toBe(true);
    }
  });

  it('renders the same page horizontally when the CMap is Identity-H', () => {
    const doc = verticalPage({
      encoding: 'Identity-H',
      content: 'BT /F0 40 Tf 1 0 0 rg 150 250 Td <00010001> Tj ET',
    });
    const png = decodePng(doc.Pages[0].ToImage());
    // The control: ink continues to the right, not downward.
    let right = -1;
    for (let x = 299; x >= 0; x--) if (isRed(png.at(x, 40))) { right = x; break; }
    expect(right).toBeGreaterThan(190);
  });

  it('emits one positioned tspan per glyph in SVG', () => {
    // SVG has no /WMode: a plain <text> would lay the column out as a row.
    const svg = verticalPage({ content: 'BT /F0 20 Tf 200 250 Td <000100020003> Tj ET' })
      .Pages[0].ToSvg();
    const tspans = svg.match(/<tspan /g) ?? [];
    expect(tspans.length).toBe(3);
    // Their y values must descend down the column (SVG y grows downward).
    const ys = [...svg.matchAll(/<tspan x="[^"]*" y="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys.length).toBe(3);
    expect(ys[1]).toBeGreaterThan(ys[0]);
    expect(ys[2]).toBeGreaterThan(ys[1]);
  });

  it('leaves horizontal SVG output free of per-glyph tspans', () => {
    const svg = verticalPage({
      encoding: 'Identity-H',
      content: 'BT /F0 20 Tf 200 250 Td <000100020003> Tj ET',
    }).Pages[0].ToSvg();
    expect(svg).not.toContain('<tspan');
  });
});

describe('HTML fixed-mode export of a vertically-set page (kf8h.4)', () => {
  /** Every positioned span in a fixed-mode export, as {left, top, text}. */
  function spans(html: string): { left: number; top: number; text: string }[] {
    const out: { left: number; top: number; text: string }[] = [];
    const re = /<span class="[^"]*" style="([^"]*)">([^<]*)<\/span>/g;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const left = /left:(-?[\d.]+)px/.exec(m[1]);
      const top = /top:(-?[\d.]+)px/.exec(m[1]);
      if (left && top) out.push({ left: Number(left[1]), top: Number(top[1]), text: m[2] });
    }
    return out;
  }

  const THREE = 'BT /F0 40 Tf 150 250 Td <000100020003> Tj ET';

  it('emits one span per glyph rather than one for the run', () => {
    // Before kf8h.4 a whole show string was one span at the text-matrix origin,
    // so its glyphs laid out ACROSS the page: a vertical Japanese page exported
    // as a stack of short horizontal blobs.
    const html = verticalPage({ content: THREE }).ToHtml({ mode: 'fixed' });
    expect(spans(html)).toHaveLength(3);
  });

  it('stacks them down the column, not across', () => {
    const s = spans(verticalPage({ content: THREE }).ToHtml({ mode: 'fixed' }));
    expect(s[1].top).toBeGreaterThan(s[0].top);
    expect(s[2].top).toBeGreaterThan(s[1].top);
    // Same column: CSS left is unchanged glyph to glyph.
    expect(Math.abs(s[1].left - s[0].left)).toBeLessThan(1);
    expect(Math.abs(s[2].left - s[0].left)).toBeLessThan(1);
  });

  it('advances by the font\'s own vertical metric, not a browser default', () => {
    // /DW2 default is [880 -1000], so a 40pt glyph advances 40pt down. This is
    // the whole argument for per-glyph spans over CSS writing-mode, which would
    // let the browser choose the advance.
    const s = spans(verticalPage({ content: THREE }).ToHtml({ mode: 'fixed' }));
    expect(s[1].top - s[0].top).toBeCloseTo(40, 1);
    expect(s[2].top - s[1].top).toBeCloseTo(40, 1);
  });

  it("offsets each glyph by its vertical POSITION VECTOR, not the bare pen", () => {
    // Measured, and added after a mutation: every other assertion here is a
    // delta or a count, and the position vector is a CONSTANT per-glyph offset,
    // so replacing glyphOrigin() with the raw pen position left all of them
    // green. Only an ABSOLUTE position catches it.
    //
    // The run starts at Td x=150. An absent /W2 defaults the vector to
    // (w0/2, /DW2[0]) -- half the glyph's OWN width across -- so a 40pt glyph
    // of width 1em draws 20pt to the LEFT of the pen, at 130.
    const s = spans(verticalPage({ content: THREE }).ToHtml({ mode: 'fixed' }));
    expect(s[0].left).toBeCloseTo(130, 1);
    expect(s[0].left).not.toBeCloseTo(150, 1);
  });

  it('agrees with ToSvg about the inter-glyph delta', () => {
    // Both backends now claim to place vertical glyphs by /W2 and /DW2. This is
    // the assertion that stops them drifting apart: the SVG places <tspan>s in
    // the element's own local space, the HTML places <span>s in device px, and
    // the step between glyphs must survive both routes identically.
    const doc = verticalPage({ content: THREE });
    const svg = doc.Pages[0].ToSvg();
    const ys = [...svg.matchAll(/<tspan x="[-\d.]+" y="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(3);
    const svgStep = ys[1] - ys[0];
    const s = spans(doc.ToHtml({ mode: 'fixed' }));
    expect(s[1].top - s[0].top).toBeCloseTo(Math.abs(svgStep), 1);
  });

  it('leaves a horizontal run as one span', () => {
    // The fence for the other direction: /F1 is Identity-H, and a horizontal
    // run must still emit exactly one span carrying the whole string.
    const html = verticalPage({ content: 'BT /F1 40 Tf 20 250 Td <000100020003> Tj ET' })
      .ToHtml({ mode: 'fixed' });
    expect(spans(html)).toHaveLength(1);
  });

  it('emits per-glyph spans in embed mode too', () => {
    // fonts:'embed' takes a different branch of glyphRun — the embedder returns
    // the rendering characters — so vertical layout has to reach it as well, or
    // the option silently un-fixes the page.
    const html = verticalPage({ content: THREE })
      .ToHtml({ mode: 'fixed', fonts: 'embed' });
    const s = spans(html);
    expect(s).toHaveLength(3);
    expect(s[1].top).toBeGreaterThan(s[0].top);
  });
});
