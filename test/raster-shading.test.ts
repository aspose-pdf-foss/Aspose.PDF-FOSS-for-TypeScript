import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  axialShadingPdf, radialShadingPdf, axialShadingClippedPdf, unsupportedShadingPdf,
  shadingPatternPdf, patternTextPdf,
  type4ShadingPdf, type4SeparationPdf,
} from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 12) => Math.abs(v - target) <= tol;

describe('Page.ToImage — axial shading', () => {
  const png = () => decodePng(Document.Open(axialShadingPdf()).Pages[0].ToImage());

  it('ramps red → blue along the horizontal axis', () => {
    const p = png();
    // Coords [0 0 200 0]: s follows device x (the y-flip leaves x unchanged).
    const [lr, lg, lb] = p.at(6, 100);          // near left → mostly red
    expect(lr).toBeGreaterThan(220);
    expect(lb).toBeLessThan(40);
    const [rr, , rb] = p.at(194, 100);          // near right → mostly blue
    expect(rr).toBeLessThan(40);
    expect(rb).toBeGreaterThan(220);
    // center → the N=1 midpoint of red→blue is (128,0,128)
    const [cr, cg, cb] = p.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });
});

describe('Page.ToImage — radial shading', () => {
  const png = () => decodePng(Document.Open(radialShadingPdf()).Pages[0].ToImage());

  it('goes red at the center, purple at half-radius, white (unpainted) past the rim', () => {
    const p = png();
    // center (100,100) → r0 = 0 → red
    const [cr, cg, cb] = p.at(100, 100);
    expect(cr).toBeGreaterThan(220);
    expect(cg).toBeLessThan(40);
    expect(cb).toBeLessThan(40);
    // 40px out of the 80px rim → s = 0.5 → purple (128,0,128)
    const [mr, mg, mb] = p.at(140, 100);
    expect(near(mr, 128)).toBe(true);
    expect(near(mg, 0)).toBe(true);
    expect(near(mb, 128)).toBe(true);
    // 90px out (past the rim, no extend) → unpainted white background
    expect(p.at(191, 100)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — shading honors the active clip', () => {
  it('paints only inside the clip rectangle', () => {
    const p = decodePng(Document.Open(axialShadingClippedPdf()).Pages[0].ToImage());
    // inside clip (user 50..150 → device 50..150): center is the purple midpoint
    const [cr, cg, cb] = p.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
    // outside clip → untouched white background
    expect(p.at(10, 10)).toEqual([255, 255, 255, 255]);
    expect(p.at(190, 190)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — shading pattern fill (scn / PatternType 2)', () => {
  const png = () => decodePng(Document.Open(shadingPatternPdf()).Pages[0].ToImage());

  it('fills the path with the axial gradient, clipped to the filled geometry', () => {
    const p = png();
    // Inside the fill rect [50 50 100 100] → device 50..150; gradient across x 50..150.
    const [lr, , lb] = p.at(54, 100);          // left of rect → red
    expect(lr).toBeGreaterThan(220);
    expect(lb).toBeLessThan(40);
    const [rr, , rb] = p.at(146, 100);         // right of rect → blue
    expect(rr).toBeLessThan(40);
    expect(rb).toBeGreaterThan(220);
    const [cr, cg, cb] = p.at(100, 100);       // center → purple midpoint
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
    // Outside the filled rect → untouched white (the pattern is clipped to the path).
    expect(p.at(20, 20)).toEqual([255, 255, 255, 255]);
    expect(p.at(180, 180)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — text filled through a shading pattern', () => {
  const png = () => decodePng(Document.Open(patternTextPdf()).Pages[0].ToImage());

  const isInk = (p: [number, number, number, number]) => !(p[0] > 245 && p[1] > 245 && p[2] > 245);

  /** The first ink pixel found scanning columns from `from` toward `to`, over
   *  the band the text occupies. Scanning beats hard-coded coordinates: it makes
   *  the assertion about the ramp rather than about Helvetica's exact outlines. */
  function edgeInk(p: ReturnType<typeof decodePng>, from: number, to: number): [number, number, number] {
    const step = Math.sign(to - from);
    for (let x = from; x !== to; x += step) {
      for (let y = 60; y < 140; y++) {
        const px = p.at(x, y);
        if (isInk(px)) return [px[0], px[1], px[2]];
      }
    }
    throw new Error('no ink found — the fixture drew nothing');
  }

  it('ramps the glyphs red → blue instead of painting them flat', () => {
    const p = png();
    const [lr, , lb] = edgeInk(p, 0, 199);        // leftmost glyph ink → red end
    expect(lr).toBeGreaterThan(lb + 60);
    const [rr, , rb] = edgeInk(p, 199, 0);        // rightmost glyph ink → blue end
    expect(rb).toBeGreaterThan(rr + 60);
  });

  it('leaves no pixel painted the pattern placeholder gray', () => {
    // scn stores [128,128,128] as a stand-in for "a pattern is selected". Any
    // pixel of it on the page means a paint path read gs.fill and ignored
    // gs.fillPattern — the whole of this bug.
    const p = png();
    let flat = 0;
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        const [r, g, b] = p.at(x, y);
        if (r === 128 && g === 128 && b === 128) flat++;
      }
    expect(flat).toBe(0);
  });

  it('paints the glyphs only, not their bounding box', () => {
    // The counter of an 'H' and the gap between glyphs must stay white, or the
    // clip is the run's box rather than its outlines.
    const p = png();
    expect(p.at(100, 10).slice(0, 3)).toEqual([255, 255, 255]);   // above the text
    expect(p.at(100, 190).slice(0, 3)).toEqual([255, 255, 255]);  // below the text
  });
});

describe('Page.ToImage — unsupported shading', () => {
  it('degrades to a mid-gray fill without throwing, bounded by the clip', () => {
    const p = decodePng(Document.Open(unsupportedShadingPdf()).Pages[0].ToImage());
    const [gr, gg, gb] = p.at(100, 100);       // inside clip → mid-gray
    expect(near(gr, 128)).toBe(true);
    expect(near(gg, 128)).toBe(true);
    expect(near(gb, 128)).toBe(true);
    expect(p.at(10, 10)).toEqual([255, 255, 255, 255]);   // outside clip → white
  });
});

describe('Page.ToImage — type 4 PostScript functions', () => {
  it('ramps blue → red across an axial shading driven by a PostScript program', () => {
    const p = decodePng(Document.Open(type4ShadingPdf()).Pages[0].ToImage());
    // The bug this covers paints a flat colour, so the assertion is that the
    // two ends DIFFER and land where the program says — not merely that the
    // page is painted.
    const [lr, lg, lb] = p.at(6, 100);           // t ~ 0 → blue
    expect(lr).toBeLessThan(40);
    expect(lg).toBeLessThan(40);
    expect(lb).toBeGreaterThan(220);
    const [rr, rg, rb] = p.at(194, 100);         // t ~ 1 → red
    expect(rr).toBeGreaterThan(220);
    expect(rg).toBeLessThan(40);
    expect(rb).toBeLessThan(40);
    const [cr, cg, cb] = p.at(100, 100);         // t ~ 0.5 → purple
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('resolves a Separation tint transform to its alternate-space colour', () => {
    const p = decodePng(Document.Open(type4SeparationPdf()).Pages[0].ToImage());
    const [r, g, b] = p.at(100, 100);            // tint 1 → (0,1,0)
    expect(r).toBeLessThan(40);
    expect(g).toBeGreaterThan(220);
    expect(b).toBeLessThan(40);
    const [wr, wg, wb] = p.at(5, 5);             // outside the rect → white page
    expect(wr).toBeGreaterThan(230);
    expect(wg).toBeGreaterThan(230);
    expect(wb).toBeGreaterThan(230);
  });
});
