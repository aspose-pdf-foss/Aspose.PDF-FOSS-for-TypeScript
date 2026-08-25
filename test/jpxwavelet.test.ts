import { describe, it, expect } from 'vitest';
import { idwt1d53, idwt1d97, fdwt1d53, fdwt1d97, inverseDwt, ResolutionSpec } from '../src/jpxwavelet.js';

// The inverse 5/3 and 9/7 lifting steps are validated here by forward→inverse
// round-trips (the forward transforms live alongside the inverse for testing).
// Full 2D subband-assembly conformance is proven end-to-end in test/jpx.test.ts.

describe('inverse DWT — 1D lifting', () => {
  it('5/3 inverse exactly inverts 5/3 forward (integer, lossless)', () => {
    for (const sig of [[10, 3, 47, 5, 9, 200, 13, 6], [1, 2, 3, 4, 5], [100], [7, 7], [0, 255, 0, 255, 0, 255]]) {
      const a = Float32Array.from(sig);
      fdwt1d53(a, 0, a.length, 1);
      idwt1d53(a, 0, a.length, 1);
      expect(Array.from(a).map((v) => Math.round(v))).toEqual(sig);
    }
  });

  it('9/7 inverse inverts 9/7 forward within float tolerance', () => {
    for (const sig of [[10, 3, 47, 5, 9, 200, 13, 6], [1, 2, 3, 4, 5, 6, 7, 8], [50, 60, 70, 80]]) {
      const a = Float32Array.from(sig);
      fdwt1d97(a, 0, a.length, 1);
      idwt1d97(a, 0, a.length, 1);
      for (let i = 0; i < sig.length; i++) expect(Math.abs(a[i] - sig[i])).toBeLessThan(1e-3);
    }
  });

  it('operates along a strided column without touching neighbors', () => {
    const w = 3, h = 4;
    const grid = new Float32Array(w * h);
    const col = [12, 40, 8, 33];
    for (let y = 0; y < h; y++) grid[y * w + 1] = col[y]; // middle column
    fdwt1d53(grid, 1, h, w);
    idwt1d53(grid, 1, h, w);
    for (let y = 0; y < h; y++) expect(Math.round(grid[y * w + 1])).toBe(col[y]);
    for (let y = 0; y < h; y++) { expect(grid[y * w]).toBe(0); expect(grid[y * w + 2]).toBe(0); }
  });
});

describe('inverse DWT — 2D driver', () => {
  it('returns the LL band unchanged when there are no decomposition levels', () => {
    const ll = Float32Array.from([1, 2, 3, 4]);
    const res: ResolutionSpec[] = [{ level: 0, x0: 0, y0: 0, x1: 2, y1: 2, subbands: [{ type: 'LL', x0: 0, y0: 0, x1: 2, y1: 2, coeffs: ll }] }];
    expect(Array.from(inverseDwt(res, true))).toEqual([1, 2, 3, 4]);
  });

  it('reconstructs the right dimensions for a one-level 4x4 pyramid', () => {
    const z = (n: number) => new Float32Array(n);
    const res: ResolutionSpec[] = [
      { level: 0, x0: 0, y0: 0, x1: 2, y1: 2, subbands: [{ type: 'LL', x0: 0, y0: 0, x1: 2, y1: 2, coeffs: Float32Array.from([100, 100, 100, 100]) }] },
      { level: 1, x0: 0, y0: 0, x1: 4, y1: 4, subbands: [
        { type: 'HL', x0: 0, y0: 0, x1: 2, y1: 2, coeffs: z(4) },
        { type: 'LH', x0: 0, y0: 0, x1: 2, y1: 2, coeffs: z(4) },
        { type: 'HH', x0: 0, y0: 0, x1: 2, y1: 2, coeffs: z(4) },
      ] },
    ];
    const out = inverseDwt(res, true);
    expect(out.length).toBe(16);
    // All-zero detail bands + constant LL → constant reconstruction.
    for (let i = 0; i < 16; i++) expect(Math.round(out[i])).toBe(100);
  });
});
