import { describe, it, expect } from 'vitest';
import { samplesMatch, diffImages, DIFF_PIXEL_TOL } from './helpers/compare-image.js';
import type { DecodedPng } from './helpers/decode-png.js';

/** Build a DecodedPng backed by a solid colour, with optional per-pixel overrides. */
function solid(width: number, height: number, rgb: [number, number, number],
               overrides: Record<string, [number, number, number]> = {}): DecodedPng {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(rgb, i * 3);
  for (const [key, v] of Object.entries(overrides)) {
    const [x, y] = key.split(',').map(Number);
    data.set(v, (y * width + x) * 3);
  }
  return {
    width, height, channels: 3, colorType: 2, data,
    at(x, y) {
      const i = (y * width + x) * 3;
      return [data[i], data[i + 1], data[i + 2], 255];
    },
  };
}

describe('samplesMatch', () => {
  it('returns no failures when every probe is within tolerance', () => {
    const p = solid(4, 4, [255, 128, 128]);
    expect(samplesMatch(p, [{ x: 1, y: 1, rgb: [255, 127, 130] }])).toEqual([]);
  });

  it('reports the probe that missed, with expected and actual', () => {
    const p = solid(4, 4, [255, 128, 128]);
    const fails = samplesMatch(p, [{ x: 2, y: 2, rgb: [0, 0, 255], note: 'in-cell' }]);
    expect(fails).toHaveLength(1);
    expect(fails[0]).toContain('(2,2)');
    expect(fails[0]).toContain('in-cell');
    expect(fails[0]).toContain('255,128,128');
  });

  it('honours an explicit tolerance', () => {
    const p = solid(4, 4, [100, 100, 100]);
    expect(samplesMatch(p, [{ x: 0, y: 0, rgb: [104, 100, 100] }], 2)).toHaveLength(1);
    expect(samplesMatch(p, [{ x: 0, y: 0, rgb: [104, 100, 100] }], 5)).toEqual([]);
  });
});

describe('diffImages', () => {
  it('reports zero difference for identical images', () => {
    const d = diffImages(solid(10, 10, [1, 2, 3]), solid(10, 10, [1, 2, 3]));
    expect(d.maxDelta).toBe(0);
    expect(d.failFraction).toBe(0);
  });

  it('counts only pixels beyond DIFF_PIXEL_TOL as failing', () => {
    // One pixel differs by exactly the tolerance (not failing), one by well over.
    const a = solid(10, 10, [100, 100, 100]);
    const b = solid(10, 10, [100, 100, 100], {
      '0,0': [100 + DIFF_PIXEL_TOL, 100, 100],
      '1,0': [200, 100, 100],
    });
    const d = diffImages(a, b);
    expect(d.maxDelta).toBe(100);
    expect(d.failFraction).toBeCloseTo(1 / 100, 6);
  });

  it('throws when dimensions differ, rather than comparing garbage', () => {
    expect(() => diffImages(solid(4, 4, [0, 0, 0]), solid(5, 4, [0, 0, 0])))
      .toThrow(/dimension/i);
  });
});
