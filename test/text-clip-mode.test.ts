import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

/**
 * Text clipping modes 4-7 (4gtd.2).
 *
 * Modes 4-7 add the glyphs they show to the clipping path, which takes effect at
 * `ET` and is restored by `Q` like any other clip. `4gtd.1` landed the mode
 * plumbing and deliberately left 4-6 painting as 0-2 with no clip at all, so
 * artwork clipped to display type painted UNCLIPPED — a solid rectangle where a
 * word should have been.
 *
 * **The rule the existing primitive got wrong:** `clipToGlyphs` INTERSECTS, and
 * a text object accumulates the UNION of every show operator's glyphs. Called
 * per run it yields the intersection, which for two non-overlapping runs is
 * empty — everything after `ET` silently erased.
 *
 * **Geometry, measured rather than assumed.** `(HHHH)` at 72pt from PDF (20,110)
 * occupies device x 25..222, y 140..189. The rectangle after the text object
 * covers only the LEFT of that (device x 10..140), which is what lets a region
 * hold glyphs but no rectangle — the only way to tell mode 4 (fills AND clips)
 * from mode 7 (clips only). With a rectangle over the whole run the two are
 * pixel-identical, and the first version of this file could not separate them.
 */

/** The band the rectangle covers, in device space. */
const RECT = { x0: 10, y0: 140, x1: 140, y1: 189 };
/** Glyphs beyond the rectangle's right edge — mode 4 paints here, mode 7 does not. */
const BEYOND = { x0: 150, y0: 140, x1: 222, y1: 189 };

/** A red rectangle over the LEFT of the text band, painted after the text object. */
const RECT_AFTER = '1 0 0 rg 10 111 130 49 re f\n';

const show = (mode: string, text = '(HHHH)') =>
  `q BT /F1 72 Tf 20 110 Td ${mode}${text} Tj ET\n${RECT_AFTER}Q\n`;

function inkIn(pdf: Uint8Array, b: { x0: number; y0: number; x1: number; y1: number }): number {
  const png = decodePng(Document.Open(pdf).Pages[0].ToImage());
  let n = 0;
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      const [r, g, bl] = png.at(x, y);
      if (r !== 255 || g !== 255 || bl !== 255) n++;
    }
  }
  return n;
}

const AREA = (RECT.x1 - RECT.x0) * (RECT.y1 - RECT.y0);

describe('text clipping modes', () => {
  it('paints the whole band under mode 0 — the control', () => {
    // Without this the "less than half the band" assertions below could be
    // satisfied by a build that painted less for some unrelated reason.
    expect(inkIn(buildSimpleTextPdf(show('')), RECT)).toBe(AREA);
  });

  it('clips a following fill to the glyphs under "4 Tr"', () => {
    const band = inkIn(buildSimpleTextPdf(show('4 Tr ')), RECT);
    expect(band).toBeGreaterThan(0);                 // something is painted
    expect(band).toBeLessThan(AREA * 0.6);           // but nowhere near all of it
  });

  it('unions the glyphs of EVERY show operator in the text object', () => {
    // **The case a single-run fixture provably cannot make.** `clipToGlyphs`
    // intersects, so a per-run implementation gives the intersection of the two
    // runs' glyphs — empty, since they do not overlap — and the rectangle
    // vanishes. Two Tj at different pen positions, both under the rectangle.
    const pdf = buildSimpleTextPdf(
      'q BT /F1 72 Tf 20 110 Td 4 Tr (H) Tj 60 0 Td (H) Tj ET\n' + RECT_AFTER + 'Q\n',
    );
    expect(inkIn(pdf, { x0: 20, y0: 140, x1: 70, y1: 189 })).toBeGreaterThan(0);
    expect(inkIn(pdf, { x0: 80, y0: 140, x1: 130, y1: 189 })).toBeGreaterThan(0);
  });

  it('restores the previous clip at Q', () => {
    const pdf = buildSimpleTextPdf(
      show('4 Tr ') + '0 0 1 rg 10 40 280 40 re f\n',
    );
    // The blue rectangle is outside the q/Q block, so nothing clips it.
    expect(inkIn(pdf, { x0: 10, y0: 220, x1: 290, y1: 260 })).toBe(280 * 40);
  });

  it('paints no glyphs under mode 7 but still clips', () => {
    const pdf = buildSimpleTextPdf(show('7 Tr '));
    const band = inkIn(pdf, RECT);
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(AREA * 0.6);
    // Beyond the rectangle the glyphs are not painted at all — mode 7 clips only.
    expect(inkIn(pdf, BEYOND)).toBe(0);
  });

  it('paints the glyphs AND clips under mode 4', () => {
    // The same region under mode 4 DOES carry ink, which is what separates the
    // painting clip modes from the clip-only one.
    expect(inkIn(buildSimpleTextPdf(show('4 Tr ')), BEYOND)).toBeGreaterThan(0);
  });

  it('leaves the clip alone when the sink cannot outline the glyphs', () => {
    // Fail OPEN. A code the Standard-14 substitute has no glyph for resolves to no
    // outline, so `clipToGlyphs` declines. The rectangle must still be there,
    // and UNCLIPPED — the whole band, exactly as with no clipping mode at all.
    const pdf = buildSimpleTextPdf(show('7 Tr ', '(\\000\\000\\000)'), { encoding: null });
    expect(inkIn(pdf, RECT)).toBe(AREA);
  });
});
