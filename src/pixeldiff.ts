/**
 * Pixel arithmetic under graphical comparison (`aq4a.5`): which pixels of two
 * RGB images differ, where the changed regions are, and a difference image.
 *
 * A LEAF importing NOTHING — images in, numbers out — so every rule is
 * testable from hand-built pixel arrays with no PDF rendered, the split
 * `floatstack.ts`, `meshtri.ts` and `textdiff.ts` already make.
 */

/** Opaque 8-bit RGB, row-major, top row first. */
export interface RgbImage { width: number; height: number; rgb: Uint8Array }

/** Which pixels differ: one byte per pixel of a `width` x `height` grid, 1
 *  where the two images differ. `changed` counts the 1s. */
export interface PixelDiff { width: number; height: number; mask: Uint8Array; changed: number }

/** A changed region in pixels, half-open: x0 <= x < x1, y0 <= y < y1. */
export interface PixelRegion { x0: number; y0: number; x1: number; y1: number }

/** Compare two images over the grid of the LARGER, aligned at the top left.
 *  A pixel outside an image — or every pixel of an absent one — is white,
 *  which is what an unpainted page shows. A pixel differs when any channel
 *  differs by MORE than `tolerance`. */
export function diffPixels(a: RgbImage | undefined, b: RgbImage | undefined, tolerance: number): PixelDiff {
  const width = Math.max(a?.width ?? 0, b?.width ?? 0);
  const height = Math.max(a?.height ?? 0, b?.height ?? 0);
  const mask = new Uint8Array(width * height);
  let changed = 0;
  const at = (im: RgbImage | undefined, x: number, y: number, c: number): number =>
    im && x < im.width && y < im.height ? im.rgb[(y * im.width + x) * 3 + c] : 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(at(a, x, y, c) - at(b, x, y, c)) > tolerance) {
          mask[y * width + x] = 1;
          changed++;
          break;
        }
      }
    }
  }
  return { width, height, mask, changed };
}

/** Box each group of changed pixels, ordered top to bottom then left to right.
 *
 *  Grouping runs on a grid of `cell` x `cell` squares, 8-connected: a square
 *  is changed when any pixel in it is, and touching squares form one group, so
 *  changes about a `cell` apart join (up to two cells, on the diagonal). The
 *  box is the extent of the changed PIXELS in the group, never of the squares.
 *  A grid rather than pairwise box merging keeps the cost linear in the image:
 *  a noisy difference yields tens of thousands of specks, and merging boxes
 *  pairwise would be quadratic in them. `cell` 1 is plain 8-connected pixels. */
export function changedRegions(d: PixelDiff, cell: number): PixelRegion[] {
  if (d.changed === 0) return [];
  const c = Math.max(1, Math.floor(cell));
  const gw = Math.ceil(d.width / c), gh = Math.ceil(d.height / c);
  // Per changed cell: the extent of its changed pixels; x0 = Infinity means none.
  const x0 = new Float64Array(gw * gh).fill(Infinity), y0 = new Float64Array(gw * gh).fill(Infinity);
  const x1 = new Float64Array(gw * gh).fill(-Infinity), y1 = new Float64Array(gw * gh).fill(-Infinity);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (!d.mask[y * d.width + x]) continue;
      const g = Math.floor(y / c) * gw + Math.floor(x / c);
      if (x < x0[g]) x0[g] = x;
      if (y < y0[g]) y0[g] = y;
      if (x + 1 > x1[g]) x1[g] = x + 1;
      if (y + 1 > y1[g]) y1[g] = y + 1;
    }
  }
  const seen = new Uint8Array(gw * gh);
  const out: PixelRegion[] = [];
  const stack: number[] = []; // explicit: a page-sized change would overflow recursion
  for (let start = 0; start < gw * gh; start++) {
    if (seen[start] || x0[start] === Infinity) continue;
    const r: PixelRegion = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const g = stack.pop()!;
      r.x0 = Math.min(r.x0, x0[g]); r.y0 = Math.min(r.y0, y0[g]);
      r.x1 = Math.max(r.x1, x1[g]); r.y1 = Math.max(r.y1, y1[g]);
      const gx = g % gw, gy = (g - gx) / gw;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const n = ny * gw + nx;
          if (seen[n] || x0[n] === Infinity) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    out.push(r);
  }
  return out.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
}

/** The base image faded three quarters of the way to white, with every
 *  changed pixel painted pure red: what stayed is legible as context, and what
 *  changed cannot be mistaken for content. RGB over the diff's grid; an absent
 *  base, or a pixel outside it, is white. */
export function diffImage(base: RgbImage | undefined, d: PixelDiff): Uint8Array {
  const out = new Uint8Array(d.width * d.height * 3);
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const o = (y * d.width + x) * 3;
      if (d.mask[y * d.width + x]) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 0; continue; }
      const inside = base && x < base.width && y < base.height;
      for (let c = 0; c < 3; c++) {
        const v = inside ? base.rgb[(y * base.width + x) * 3 + c] : 255;
        out[o + c] = Math.round(v + (255 - v) * 0.75);
      }
    }
  }
  return out;
}
