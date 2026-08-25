import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turbulenceSurface, type TurbulenceParams } from '../src/svgfilternoise.js';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'svg-filter');

/** Mean absolute channel difference between our render of a committed fixture
 *  SVG and the browser-rendered golden beside it. */
export function meanDiff(name: string, size = 64): number {
  const src = readFileSync(join(FIX, `${name}.svg`));
  const p = Document.Open(
    buildSvgPdf({ mediaBox: [0, 0, size, size], content: '' })).Pages[0];
  p.AddSVGObject(new Uint8Array(src), [0, 0, size, size], { fit: 'fill', filterScale: 1 });
  const got = decodePng(Document.Open(p.Document.Save()).Pages[0].ToImage());
  const gold = decodePng(new Uint8Array(readFileSync(join(FIX, `${name}.png`))));
  let sum = 0, n = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    for (let c = 0; c < 3; c++) { sum += Math.abs(gold.at(x, y)[c] - got.at(x, y)[c]); n++; }
  return sum / n;
}

const base: TurbulenceParams = {
  baseFreqX: 0.05, baseFreqY: 0.05, numOctaves: 1, seed: 1,
  fractalSum: false, stitch: false, tile: { x: 0, y: 0, w: 64, h: 64 },
};
const win = { x: 0, y: 0, w: 64, h: 64 };
const gen = (p: Partial<TurbulenceParams>) =>
  turbulenceSurface({ ...base, ...p }, win, 1, 0, 0);

describe('turbulenceSurface', () => {
  it('fills every channel of the window', () => {
    expect(gen({}).length).toBe(64 * 64 * 4);
  });

  it('stays within 0..1 in every channel', () => {
    for (const p of [{}, { fractalSum: true }, { numOctaves: 5 }]) {
      const d = gen(p);
      for (let i = 0; i < d.length; i++) {
        expect(d[i]).toBeGreaterThanOrEqual(0);
        expect(d[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(Array.from(gen({ seed: 42 }))).toEqual(Array.from(gen({ seed: 42 })));
  });

  it('differs between seeds', () => {
    const a = gen({ seed: 1 }), b = gen({ seed: 2 });
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same).toBeLessThan(a.length / 2);
  });

  it('distinguishes the two accumulation rules by their mean', () => {
    // type="turbulence" sums |noise| so its mean sits low; fractalNoise sums
    // signed noise remapped to 0..1 so its mean sits near 0.5. Swapping the two
    // is the single most common port bug.
    const meanAlpha = (d: Float32Array): number => {
      let t = 0;
      for (let p = 0; p < 64 * 64; p++) t += d[p * 4 + 3];
      return t / (64 * 64);
    };
    expect(meanAlpha(gen({ fractalSum: false }))).toBeLessThan(0.45);
    const f = meanAlpha(gen({ fractalSum: true }));
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  it('more octaves add detail', () => {
    const one = gen({ numOctaves: 1 }), four = gen({ numOctaves: 4 });
    let diff = 0;
    for (let i = 0; i < one.length; i++) diff += Math.abs(one[i] - four[i]);
    expect(diff).toBeGreaterThan(0);
  });

  it('a zero baseFrequency yields a constant field', () => {
    const d = gen({ baseFreqX: 0, baseFreqY: 0 });
    for (let p = 1; p < 64 * 64; p++) expect(d[p * 4 + 3]).toBeCloseTo(d[3], 6);
  });

  it('stitchTiles makes the field tile seamlessly across the tile width', () => {
    const d = turbulenceSurface(
      { ...base, stitch: true, baseFreqX: 0.0625, baseFreqY: 0.0625 }, win, 1, 0, 0);
    const at = (x: number, y: number) => d[((y * 64) + x) * 4 + 3];
    // One tile-width apart the field must agree at the seam.
    expect(Math.abs(at(0, 10) - at(63, 10))).toBeLessThan(0.25);
  });

  it('samples in USER space, so the field is stable under filterScale', () => {
    // The same user-space point must give the same value at 1x and 2x raster
    // resolution. If the generator sampled pixel indices the field would
    // change frequency whenever filterScale did.
    const one = turbulenceSurface(base, { x: 0, y: 0, w: 8, h: 8 }, 1, 0, 0);
    const two = turbulenceSurface(base, { x: 0, y: 0, w: 16, h: 16 }, 2, 0, 0);
    // User point ~ (2.5, 2.5) is pixel (2,2) at 1x and pixel (4,4)/(5,5) at 2x.
    const a = one[(2 * 8 + 2) * 4 + 3];
    const b = two[(5 * 16 + 5) * 4 + 3];
    expect(Math.abs(a - b)).toBeLessThan(0.06);
  });
});

describe('feTurbulence — against browser goldens', () => {
  // These are the assertions that actually validate the PORT. The structural
  // tests above cannot: a wrong gradient table or a wrong lattice shuffle still
  // produces determinstic, in-range, correctly-distributed noise.
  //
  // The bound is calibrated from the measured figure (0.65 and 0.70 of 255,
  // i.e. essentially exact) and left at 3 for rounding headroom. It is still
  // far tighter than the ~6 maxDelta the two BROWSERS differ by on the same
  // fixtures. See fixtures/svg-filter/PROVENANCE.md for why the fixtures are
  // low-frequency and what that does and does not prove.
  it('matches Chrome and resvg on fractalNoise', () => {
    expect(meanDiff('turbulence-fractal')).toBeLessThan(3);
  });

  it('matches Chrome and resvg on turbulence', () => {
    expect(meanDiff('turbulence-turb')).toBeLessThan(3);
  });
});
