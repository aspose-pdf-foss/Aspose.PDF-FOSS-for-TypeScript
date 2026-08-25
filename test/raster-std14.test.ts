import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

type Png = ReturnType<typeof decodePng>;

/** Render a single glyph of a NON-embedded Type1 base font to a 200x100 PNG. */
function renderChar(baseFont: string, text: string): Png {
  const doc = Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 200, 100],
    resources: `<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /${baseFont} >> >> >>`,
    content: `BT /F1 60 Tf 20 25 Td (${text}) Tj ET`,
  }));
  return decodePng(doc.Pages[0].ToImage());
}

const isDark = (px: number[]) => px[0] < 100 && px[1] < 100 && px[2] < 100;

function darkCount(png: Png, x0 = 0, y0 = 0, x1 = png.width, y1 = png.height): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isDark(png.at(x, y))) n++;
  return n;
}

/** Bounding box of dark pixels, plus the count. */
function darkBBox(png: Png) {
  let x0 = png.width, y0 = png.height, x1 = 0, y1 = 0, count = 0;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++)
      if (isDark(png.at(x, y))) {
        count++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1, count };
}

/** A real filled glyph paints substantially AND fills its interior (unlike the
 *  hollow hairline placeholder box, whose central region is ~empty). */
function expectFilledGlyph(png: Png): void {
  const bb = darkBBox(png);
  expect(bb.count).toBeGreaterThan(150);
  const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0;
  const ix0 = bb.x0 + Math.floor(w * 0.25), ix1 = bb.x1 - Math.floor(w * 0.25);
  const iy0 = bb.y0 + Math.floor(h * 0.25), iy1 = bb.y1 - Math.floor(h * 0.25);
  expect(darkCount(png, ix0, iy0, ix1, iy1)).toBeGreaterThan(10);
}

describe('Page.ToImage — non-embedded Standard-14 glyph outlines', () => {
  it('renders Helvetica "H" as a real filled glyph, not a box', () => {
    expectFilledGlyph(renderChar('Helvetica', 'H'));
  });

  it('renders Times-Bold "R" as a real filled glyph', () => {
    expectFilledGlyph(renderChar('Times-Bold', 'R'));
  });

  it('renders Courier "M" as a real filled glyph', () => {
    expectFilledGlyph(renderChar('Courier', 'M'));
  });

  it('renders Symbol without throwing and paints something (glyph or fallback)', () => {
    const png = renderChar('Symbol', 'a');   // Symbol 'a' -> alpha, or placeholder box
    expect(png.width).toBe(200);
    expect(png.height).toBe(100);
    expect(darkCount(png)).toBeGreaterThan(0);
  });
});
