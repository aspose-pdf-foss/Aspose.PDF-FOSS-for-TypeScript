import { describe, it, expect } from 'vitest';
import { diffPixels, changedRegions, diffImage, type RgbImage } from '../src/pixeldiff.js';

/** A white w x h image with the given pixels painted [r, g, b]. */
function img(w: number, h: number, paint: [number, number, [number, number, number]][] = []): RgbImage {
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (const [x, y, c] of paint) rgb.set(c, (y * w + x) * 3);
  return { width: w, height: h, rgb };
}
const RED: [number, number, number] = [255, 0, 0];
const block = (x0: number, y0: number, x1: number, y1: number): [number, number, [number, number, number]][] => {
  const out: [number, number, [number, number, number]][] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push([x, y, RED]);
  return out;
};

describe('diffPixels', () => {
  it('finds no change between identical images', () => {
    const d = diffPixels(img(4, 4, [[1, 1, RED]]), img(4, 4, [[1, 1, RED]]), 0);
    expect(d.changed).toBe(0);
  });

  it('marks exactly the pixels that differ', () => {
    const d = diffPixels(img(4, 3), img(4, 3, [[2, 1, RED]]), 0);
    expect(d.changed).toBe(1);
    expect(Array.from(d.mask)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]);
  });

  it('ignores a difference no larger than the tolerance in every channel', () => {
    const a = img(1, 1, [[0, 0, [100, 100, 100]]]);
    expect(diffPixels(a, img(1, 1, [[0, 0, [108, 100, 100]]]), 8).changed).toBe(0);
    expect(diffPixels(a, img(1, 1, [[0, 0, [109, 100, 100]]]), 8).changed).toBe(1);
    expect(diffPixels(a, img(1, 1, [[0, 0, [100, 100, 91]]]), 8).changed).toBe(1);
  });

  it('compares images of different size on the larger one, outside an image being white', () => {
    const d = diffPixels(img(2, 2), img(3, 1, [[2, 0, RED]]), 0);
    expect([d.width, d.height, d.changed]).toEqual([3, 2, 1]);
    expect(d.mask[2]).toBe(1);
  });

  it('treats an absent image as blank', () => {
    expect(diffPixels(undefined, img(2, 2, [[0, 0, RED]]), 0).changed).toBe(1);
    expect(diffPixels(img(2, 2), undefined, 0).changed).toBe(0);
  });
});

describe('changedRegions', () => {
  it('boxes each connected change, top to bottom then left to right', () => {
    const d = diffPixels(img(20, 20), img(20, 20, [...block(12, 2, 15, 4), ...block(1, 10, 3, 18), ...block(1, 2, 2, 3)]), 0);
    expect(changedRegions(d, 1)).toEqual([
      { x0: 1, y0: 2, x1: 2, y1: 3 }, { x0: 12, y0: 2, x1: 15, y1: 4 }, { x0: 1, y0: 10, x1: 3, y1: 18 },
    ]);
  });

  it('orders by the box, not by where the scan first met the group', () => {
    // B is met first (its top pixel is at x 7, A's at x 10), but A reaches
    // further left lower down, so A's box starts left of B's on the same row.
    const A: [number, number, [number, number, number]][] = [[10, 0, RED], [9, 1, RED], [8, 2, RED], [7, 3, RED], [6, 4, RED], [5, 5, RED]];
    const d = diffPixels(img(12, 8), img(12, 8, [[7, 0, RED], ...A]), 0);
    expect(changedRegions(d, 1)).toEqual([{ x0: 5, y0: 0, x1: 11, y1: 6 }, { x0: 7, y0: 0, x1: 8, y1: 1 }]);
  });

  it('joins diagonal neighbours', () => {
    const d = diffPixels(img(4, 4), img(4, 4, [[0, 0, RED], [1, 1, RED], [2, 2, RED]]), 0);
    expect(changedRegions(d, 1)).toEqual([{ x0: 0, y0: 0, x1: 3, y1: 3 }]);
  });

  it('joins changes closer than the merge distance, and boxes the pixels not the grid', () => {
    const d = diffPixels(img(40, 10), img(40, 10, [...block(3, 3, 6, 5), ...block(9, 3, 12, 5), ...block(30, 3, 33, 5)]), 0);
    expect(changedRegions(d, 1)).toHaveLength(3);
    expect(changedRegions(d, 8)).toEqual([{ x0: 3, y0: 3, x1: 12, y1: 5 }, { x0: 30, y0: 3, x1: 33, y1: 5 }]);
  });

  it('returns nothing for no change', () => {
    expect(changedRegions(diffPixels(img(5, 5), img(5, 5), 0), 4)).toEqual([]);
  });

  it('handles a change filling a large image without exhausting the stack', () => {
    const w = 600, h = 600;
    const d = diffPixels(img(w, h), { width: w, height: h, rgb: new Uint8Array(w * h * 3) }, 0);
    expect(changedRegions(d, 1)).toEqual([{ x0: 0, y0: 0, x1: w, y1: h }]);
  });
});

describe('diffImage', () => {
  it('fades the base and paints changed pixels red', () => {
    const base = img(2, 1, [[0, 0, [0, 0, 0]]]);
    const d = diffPixels(img(2, 1), img(2, 1, [[1, 0, [0, 255, 0]]]), 0);
    const out = diffImage(base, d);
    // black faded toward white: 0 + (255 - 0) * 0.75
    expect(Array.from(out.subarray(0, 3))).toEqual([191, 191, 191]);
    expect(Array.from(out.subarray(3, 6))).toEqual([255, 0, 0]);
  });

  it('paints on white where there is no base', () => {
    const d = diffPixels(img(1, 2), img(1, 2, [[0, 1, RED]]), 0);
    expect(Array.from(diffImage(undefined, d))).toEqual([255, 255, 255, 255, 0, 0]);
  });
});
