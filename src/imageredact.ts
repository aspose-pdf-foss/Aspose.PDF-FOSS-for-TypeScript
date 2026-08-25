// Pure core for partial image redaction: map a device rect to the covered pixel
// box of an axis-aligned image placement, blank those pixels, and re-encode the
// RGBA raster as a DeviceRGB FlateDecode image XObject (+ DeviceGray /SMask when
// the source had transparency). No Document mutation — redact.ts orchestrates.

import { deflateSync } from 'node:zlib';
import { Matrix, Rect, invert, apply } from './text.js';
import type { ImageRgba } from './raster.js';
import { PdfDict, PdfObject, PdfStream, PdfName, name, isName, isArray } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

// Re-exported so redact.ts, inlineimage.ts and the tests keep the import path
// they have always had -- the shape redact.ts already uses for resprune.ts.
export { inlineImageToStream } from './inlinedict.js';

/** Half-open pixel box: covers columns [x0,x1) and rows [y0,y1). */
export interface PixelBox { x0: number; y0: number; x1: number; y1: number; }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The pixel box of `rect` within an image of `w`×`h` placed by `ctm`. Returns
 *  undefined when the rect does not overlap the image. Throws for a rotated or
 *  skewed placement (nonzero off-diagonal terms). */
export function coveredPixelBox(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox | undefined {
  const EPS = 1e-6;
  if (Math.abs(ctm[1]) > EPS || Math.abs(ctm[2]) > EPS)
    throw new UnsupportedFeatureError('rotated/skewed image placement is not supported for partial redaction');

  const inv = invert(ctm);
  const [ua, va] = apply(inv, rect[0], rect[1]);
  const [ub, vb] = apply(inv, rect[2], rect[3]);
  const uLo = clamp01(Math.min(ua, ub)), uHi = clamp01(Math.max(ua, ub));
  const vLo = clamp01(Math.min(va, vb)), vHi = clamp01(Math.max(va, vb));
  if (uHi <= uLo || vHi <= vLo) return undefined; // no overlap after clamping

  const x0 = Math.floor(uLo * w), x1 = Math.ceil(uHi * w);
  // v=1 is the TOP of the image (pixel row 0), so rows flip.
  const y0 = Math.floor((1 - vHi) * h), y1 = Math.ceil((1 - vLo) * h);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(w, x1), y1: Math.min(h, y1) };
}

/** True when (px,py) lies inside the convex quad (winding-agnostic; points on an
 *  edge count as inside). */
function pointInQuad(quad: readonly [number, number][], px: number, py: number): boolean {
  let pos = false, neg = false;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 0) pos = true; else if (cross < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/** Covered pixels of a rotated/skewed placement: map the four device-rect corners
 *  into pixel space (a convex quad) and fill it as one half-open pixel span per
 *  scanline row (a pixel is covered iff its center falls inside the quad). Returns
 *  [] when the quad misses the image. */
function coveredPixelPolygon(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox[] {
  const inv = invert(ctm);
  const corners: [number, number][] = [
    [rect[0], rect[1]], [rect[2], rect[1]], [rect[2], rect[3]], [rect[0], rect[3]],
  ];
  const quad = corners.map(([dx, dy]) => {
    const [u, v] = apply(inv, dx, dy);
    return [u * w, (1 - v) * h] as [number, number]; // v=1 is the top → row 0
  });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of quad) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const yLo = Math.max(0, Math.floor(minY)), yHi = Math.min(h, Math.ceil(maxY));
  const xLo = Math.max(0, Math.floor(minX)), xHi = Math.min(w, Math.ceil(maxX));
  const out: PixelBox[] = [];
  for (let y = yLo; y < yHi; y++) {
    let lo = -1, hi = -1; // contiguous covered x-span (quad is convex)
    for (let x = xLo; x < xHi; x++) {
      if (pointInQuad(quad, x + 0.5, y + 0.5)) { if (lo < 0) lo = x; hi = x; }
    }
    if (lo >= 0) out.push({ x0: lo, y0: y, x1: hi + 1, y1: y + 1 });
  }
  return out;
}

/** Covered pixel region of any placement: a single box for an axis-aligned CTM
 *  (via {@link coveredPixelBox}), or per-scanline spans for a rotated/skewed one.
 *  Returns [] when the rect does not overlap the image. */
export function coveredPixelRegion(ctm: Matrix, w: number, h: number, rect: Rect): PixelBox[] {
  const EPS = 1e-6;
  if (Math.abs(ctm[1]) <= EPS && Math.abs(ctm[2]) <= EPS) {
    const b = coveredPixelBox(ctm, w, h, rect);
    return b ? [b] : [];
  }
  return coveredPixelPolygon(ctm, w, h, rect);
}

/** Blank every pixel inside each box: RGB→0, alpha→255 (opaque black). */
export function blankPixels(img: ImageRgba, boxes: PixelBox[]): void {
  const { w, data } = img;
  for (const b of boxes) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) {
        const p = (y * w + x) * 4;
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 255;
      }
    }
  }
}

/** Zero every component of each covered pixel, in place, within packed image
 *  samples. Rows are byte-aligned; `bpc` ∈ {1,2,4,8,16} is packed MSB-first.
 *  Blank value is 0 (index 0 / all-zero color). Sub-byte depths clear only the
 *  covered pixel's bit-field, so a byte shared with an uncovered pixel at a box
 *  edge stays bit-identical. */
export function blankSamples(
  samples: Uint8Array, w: number, h: number, nc: number, bpc: number, boxes: PixelBox[],
): void {
  const rowBytes = Math.ceil((w * nc * bpc) / 8);
  const bytesPerComp = bpc >> 3;              // 1 for 8-bpc, 2 for 16-bpc, 0 for sub-byte
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y++) {
      const rowOff = y * rowBytes;
      for (let x = box.x0; x < box.x1; x++) {
        for (let c = 0; c < nc; c++) {
          const bit = (x * nc + c) * bpc;
          const byte = rowOff + (bit >> 3);
          if (bpc >= 8) {
            for (let k = 0; k < bytesPerComp; k++) if (byte + k < samples.length) samples[byte + k] = 0;
          } else if (byte < samples.length) {
            const shift = 8 - (bit & 7) - bpc;  // MSB-first field position within the byte
            samples[byte] &= ~(((1 << bpc) - 1) << shift) & 0xff;
          }
        }
      }
    }
  }
}

/** Blank the covered pixels of a 1-bpc image-mask stencil in place, setting each
 *  covered bit to `maskBit` — the non-marking sample value (1 under the default
 *  /Decode [0 1], 0 under [1 0]) — so covered pixels stop painting. Rows are
 *  byte-aligned, MSB-first; bits outside the boxes stay bit-identical. */
export function blankImageMaskSamples(
  samples: Uint8Array, w: number, h: number, boxes: PixelBox[], maskBit: 0 | 1,
): void {
  const rowBytes = Math.ceil(w / 8);
  for (const box of boxes) {
    for (let y = box.y0; y < box.y1; y++) {
      const rowOff = y * rowBytes;
      for (let x = box.x0; x < box.x1; x++) {
        const byte = rowOff + (x >> 3);
        if (byte >= samples.length) continue;
        const bit = 0x80 >> (x & 7);        // MSB-first bit for this column
        if (maskBit) samples[byte] |= bit;
        else samples[byte] &= ~bit & 0xff;
      }
    }
  }
}

function imageDict(w: number, h: number, cs: string): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', w], ['Height', h],
    ['ColorSpace', name(cs)], ['BitsPerComponent', 8],
    ['Filter', name('FlateDecode')],
  ]);
}

/** Re-encode straight-alpha RGBA as a DeviceRGB FlateDecode image, plus a
 *  DeviceGray /SMask when any pixel is non-opaque. */
export function encodeRgbaXObject(img: ImageRgba): {
  dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array };
} {
  const { w, h, data } = img;
  const rgb = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  let hasAlpha = false;
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
    alpha[i] = data[i * 4 + 3];
    if (alpha[i] !== 255) hasAlpha = true;
  }
  const raw = new Uint8Array(deflateSync(Buffer.from(rgb)));
  const out: { dict: PdfDict; raw: Uint8Array; smask?: { dict: PdfDict; raw: Uint8Array } } = {
    dict: imageDict(w, h, 'DeviceRGB'), raw,
  };
  if (hasAlpha) {
    out.smask = { dict: imageDict(w, h, 'DeviceGray'), raw: new Uint8Array(deflateSync(Buffer.from(alpha))) };
  }
  return out;
}

/** Re-encode blanked packed samples as a FlateDecode image, cloning the source
 *  image's colorspace and bit-depth so uncovered pixels stay byte-identical. The
 *  original `/Filter` and `/DecodeParms` are dropped (output is raw deflate, no
 *  predictor); `/ColorSpace` and `/Decode` are carried over by reference. */
export function encodeSamplesXObject(srcDict: PdfDict, samples: Uint8Array): {
  dict: PdfDict; raw: Uint8Array;
} {
  const raw = new Uint8Array(deflateSync(Buffer.from(samples)));
  const dict = new Map<string, PdfObject>();
  dict.set('Type', name('XObject'));
  dict.set('Subtype', name('Image'));
  for (const k of ['Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Decode', 'Intent']) {
    const v = srcDict.get(k);
    if (v !== undefined) dict.set(k, v);
  }
  dict.set('Filter', name('FlateDecode'));
  return { dict, raw };
}

