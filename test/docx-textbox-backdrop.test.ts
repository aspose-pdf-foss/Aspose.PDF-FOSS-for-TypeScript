import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { unzip, textOf } from './helpers/unzip.js';
import { decodePng } from './helpers/decode-png.js';

/** A4 height in points — the fixture's page, and the y-flip reference. */
const H = 842;

/** A page with one line of 36pt text and one filled red rect below it. The rect
 *  is the graphics half — what the backdrop must keep — and the text the half a
 *  glyph-less backdrop must drop, because Word draws it again from the frame.
 *
 *  Deliberately the same shape as `html-raster-backdrop.test.ts`'s fixture: the
 *  two exports share `renderPageGraphicsToPng`, so a divergence between them is
 *  worth being able to see side by side.
 *
 *  36pt on purpose: the probes below count dark pixels inside a glyph's quad,
 *  and thin text at body size leaves too few to assert on confidently. If a
 *  probe is ever awkward, make the font BIGGER — never loosen the assertion. */
function textAndRect(): Document {
  const doc = Document.New();
  const { page } = doc.AddPage();
  page.AddText('Hello', 50, 700, { fontSize: 36 });
  const g = page.Graphics();
  g.setFillColor([1, 0, 0]).rect(50, 400, 200, 100).fill();
  g.apply();
  return doc;
}

const media = (bytes: Uint8Array) =>
  unzip(bytes).filter((e) => e.path.startsWith('word/media/'));

/** The one media part a backdrop page carries. */
function backdropPng(bytes: Uint8Array): Uint8Array {
  const parts = media(bytes);
  expect(parts).toHaveLength(1);
  return parts[0].bytes;
}

/** Dark pixels inside a PDF-page-space box, in a PNG rendered at scale 1.
 *
 *  The backdrop is rendered at the raster default of scale 1, so one point is
 *  one pixel; y flips because PDF space is bottom-up and a raster top-down. */
function darkPixelsIn(png: Uint8Array, quad: [number, number, number, number]): number {
  const img = decodePng(png);
  const [x0, y0, x1, y1] = quad;
  let n = 0;
  for (let y = Math.round(H - y1); y < Math.round(H - y0); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
      const [r, g] = img.at(x, y);
      if (r < 128 && g < 128) n++;
    }
  }
  return n;
}

/** The first text fragment's quad — where the glyphs actually landed, rather
 *  than a coordinate guessed from the AddText call. */
const glyphQuad = (doc: Document) =>
  doc.Pages[0].GetTextFragments()[0].quad as [number, number, number, number];

describe("textbox backdrop: 'raster'", () => {
  it('bakes no glyphs into the backdrop', () => {
    // The defect this file exists for (tvc4): the backdrop used to be a full
    // page.ToImage(), so every glyph was drawn twice — once baked in here, once
    // re-rendered by Word from the frame with a substituted face, which does not
    // land on the same pixels. Measured at 690 dark pixels before the fix.
    const doc = textAndRect();
    const png = backdropPng(doc.ToDocx({ mode: 'textbox', backdrop: 'raster' }));
    expect(darkPixelsIn(png, glyphQuad(doc))).toBe(0);
  });

  it('keeps the page graphics in the backdrop', () => {
    // The companion that stops the above passing because the backdrop is blank,
    // or because the rasterizer failed and the page silently lost it.
    const doc = textAndRect();
    const img = decodePng(backdropPng(doc.ToDocx({ mode: 'textbox', backdrop: 'raster' })));
    // Inside the red rect: page-space (150, 450) -> device (150, 842-450).
    const [r, g, b] = img.at(150, H - 450);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('keeps the text frames visible', () => {
    // The whole reason textbox mode positions frames at all: the text stays
    // real, editable Word text. Making it transparent instead would satisfy the
    // glyph-count assertion above and defeat the mode.
    const xml = textOf(
      unzip(textAndRect().ToDocx({ mode: 'textbox', backdrop: 'raster' })),
      'word/document.xml');
    expect(xml).toContain('Hello');
    expect(xml).toContain('w:framePr');
  });

  it('emits no backdrop by default', () => {
    expect(media(textAndRect().ToDocx({ mode: 'textbox' }))).toHaveLength(0);
  });
});
