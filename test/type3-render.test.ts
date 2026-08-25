import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { interpret, baseMatrix, RenderSink } from '../src/pagerender.js';
import { type3Pdf } from './helpers/build-type3.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, t: number, tol = 20) => Math.abs(v - t) <= tol;
const isRed = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 0) && near(px[2], 0);
const isGreen = (px: [number, number, number, number]) => near(px[0], 0) && near(px[1], 255) && near(px[2], 0);
const isWhite = (px: [number, number, number, number]) => near(px[0], 255) && near(px[1], 255) && near(px[2], 255);

/** A 1x1 solid-green DeviceRGB image, for a glyph procedure that draws one. */
const GREEN_PIXEL = {
  dict: '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>',
  raw: Uint8Array.from([0, 255, 0]),
};

// Default fixture: /FontMatrix 1/100, glyph = a filled 100x100 glyph-space box,
// shown at size 50 from (20,20). One glyph covers user (20,20)-(70,70), i.e.
// device x 20..70, y 130..180 — a solid square, which no substituted Latin face
// resembles: its upper corners are the points a fallback 'a' cannot reach.
describe('Page.ToImage — Type 3 glyph procedures', () => {
  it('paints the glyph procedure under a non-trivial /FontMatrix', () => {
    const png = decodePng(Document.Open(type3Pdf()).Pages[0].ToImage());
    expect(isRed(png.at(65, 135))).toBe(true);     // upper-right corner of the box
    expect(isRed(png.at(25, 135))).toBe(true);     // upper-left corner of the box
    expect(isRed(png.at(45, 155))).toBe(true);     // centre of the box
    expect(isWhite(png.at(150, 40))).toBe(true);   // far from the text
  });

  it('advances by /Widths scaled through /FontMatrix, not by 1/1000', () => {
    // 100 glyph-space units x 0.01 x 50pt = 50 user units, so the second glyph
    // covers user (70,20)-(120,70). Divide by 1000 instead and it lands 5 units
    // along, inside the first.
    const png = decodePng(Document.Open(type3Pdf()).Pages[0].ToImage());
    expect(isRed(png.at(115, 135))).toBe(true);    // upper-right of the second box
    expect(isRed(png.at(95, 155))).toBe(true);     // centre of the second box
    expect(isWhite(png.at(130, 155))).toBe(true);  // past the end of the run
  });

  it('draws an image a glyph procedure invokes, from the font /Resources', () => {
    const png = decodePng(Document.Open(type3Pdf({
      content: 'BT /T3 50 Tf 20 20 Td (a) Tj ET',
      charProc: '100 0 0 0 100 100 d1 q 100 0 0 100 0 0 cm /Im0 Do Q',
      fontResources: '<< /XObject << /Im0 8 0 R >> >>',
      extra: { 8: GREEN_PIXEL },
    })).Pages[0].ToImage());
    expect(isGreen(png.at(45, 155))).toBe(true);   // the image fills the glyph box
    expect(isGreen(png.at(65, 135))).toBe(true);
    expect(isWhite(png.at(150, 40))).toBe(true);
  });

  it('draws text a glyph procedure shows in another font', () => {
    // Helvetica 'H' at glyph-space size 100 — one em, so 50pt on the page —
    // raised 60 glyph units off the glyph origin. That puts its cap band at
    // user y 50..86, i.e. device y 114..150: above everything a substituted
    // Latin face could draw for the code itself, which is what makes this
    // assert the nested font rather than a fallback.
    const png = decodePng(Document.Open(type3Pdf({
      content: 'BT /T3 50 Tf 1 0 0 rg 20 20 Td (a) Tj ET',
      charProc: '100 0 0 0 100 100 d1 BT /F1 100 Tf 0 60 Td (H) Tj ET',
      fontResources: '<< /Font << /F1 8 0 R >> >>',
      extra: { 8: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    })).Pages[0].ToImage());
    let ink = 0, blank = 0;
    for (let y = 118; y < 146; y++)
      for (let x = 20; x < 56; x++) (isRed(png.at(x, y)) ? ink++ : blank++);
    expect(ink).toBeGreaterThan(0);      // the nested font drew something
    expect(blank).toBeGreaterThan(ink);  // outlines, not a filled block
    expect(isWhite(png.at(150, 40))).toBe(true);
  });

  it('draws nothing for a code whose glyph procedure is missing', () => {
    // No substitute face: a Type 3 font's glyphs are the only glyphs it has, so
    // a code /CharProcs does not name has no appearance at all.
    const png = decodePng(Document.Open(type3Pdf({ extra: { 6: '<< >>' } })).Pages[0].ToImage());
    expect(isWhite(png.at(45, 155))).toBe(true);
    expect(isWhite(png.at(25, 175))).toBe(true);
    expect(isWhite(png.at(95, 155))).toBe(true);
  });
});

describe('Type 3 glyph procedures — recursion', () => {
  /** Counts the paints the interpreter emits. A glyph procedure that shows its
   *  own font must be *skipped*, not merely survived: recursion at full size
   *  bottoms out only on the JS stack, whose RangeError drawGlyphProc catches —
   *  so the rendered page looks identical either way and only the paint count
   *  tells a cycle guard from a stack overflow. */
  class FillCounter implements RenderSink {
    fills = 0;
    save() {} restore() {}
    addClip() {} clipToStroke() {} clipToGlyphs() { return true; }
    fill() { this.fills++; }
    stroke() {} image() {} glyphRun() {} shading() {}
    setAlpha() {} setBlend() {}
    beginOffscreen() {} endOffscreen() {}
    beginKnockoutElement() {} endKnockoutElement() {}
    clearSoftMask() {}
  }

  it('runs a glyph procedure that shows its own font exactly once', () => {
    const doc = Document.Open(type3Pdf({
      content: 'BT /T3 50 Tf 1 0 0 rg 20 20 Td (a) Tj ET',
      charProc: '100 0 0 0 100 100 d1 BT /T3 100 Tf 0 0 Td (a) Tj ET 0 0 100 100 re f',
      fontResources: '<< /Font << /T3 5 0 R >> >>',
    }));
    const page = doc.Pages[0];
    const sink = new FillCounter();
    interpret(doc, page, baseMatrix(page, 'crop').matrix, sink);
    expect(sink.fills).toBe(1);   // the procedure's own box, and nothing nested
  });
});

describe('Page.ToSvg — Type 3 glyph procedures', () => {
  it('emits the procedure geometry as paths, not a <text> fallback', () => {
    const svg = Document.Open(type3Pdf()).Pages[0].ToSvg();
    expect(svg).toContain('<path d="M20 180L70 180L70 130L20 130Z" fill="#ff0000"');
    expect(svg).toContain('<path d="M70 180L120 180L120 130L70 130Z" fill="#ff0000"');
    expect(svg).not.toContain('<text');
  });
});

describe('Page.ToHtml fixed mode — Type 3 glyph procedures', () => {
  it('reproduces the glyph procedure, the third backend on the same interpreter', () => {
    const html = Document.Open(type3Pdf()).Pages[0].ToHtml({ mode: 'fixed' });
    expect(html).toContain('M20 180L70 180L70 130L20 130Z');
    expect(html).toContain('M70 180L120 180L120 130L70 130Z');
  });
});
