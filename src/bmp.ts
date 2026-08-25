import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import type { RasterImage } from './rasterimage.js';

/** Compression values from the BMP header (wingdi.h BI_* constants). */
const BI_RGB = 0, BI_RLE8 = 1, BI_RLE4 = 2;
const BI_BITFIELDS = 3, BI_JPEG = 4, BI_PNG = 5, BI_ALPHABITFIELDS = 6;

/** DIB header sizes we accept. 64 is OS/2 v2, read as an INFOHEADER. */
const DIB_CORE = 12, DIB_INFO = 40, DIB_V2 = 52, DIB_V3 = 56;
const DIB_OS22 = 64, DIB_V4 = 108, DIB_V5 = 124;
const KNOWN_DIB = new Set([DIB_CORE, DIB_INFO, DIB_V2, DIB_V3, DIB_OS22, DIB_V4, DIB_V5]);

/** Refuse a raster whose pixel count cannot plausibly be allocated. */
const MAX_PIXELS = 1 << 28;   // 268M pixels; 4 bytes each is already 1 GB

const u16 = (d: Uint8Array, o: number): number => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number): number =>
  (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const i32 = (d: Uint8Array, o: number): number =>
  d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24);

/** Everything the two header generations agree on, plus where to find the rest. */
export interface BmpHeader {
  dibSize: number;
  width: number;
  /** Always positive; `topDown` carries the sign. */
  height: number;
  topDown: boolean;
  bpp: number;
  compression: number;
  /** Palette entry count, 0 when the header states none. */
  clrUsed: number;
  /** Offset of the pixel array, as the file states it. */
  offBits: number;
  /** Offset just past the DIB header -- where a palette or INFO masks begin. */
  afterHeader: number;
}

export function parseBmpHeader(d: Uint8Array): BmpHeader {
  if (d.length < 26 || d[0] !== 0x42 || d[1] !== 0x4d)
    throw new PdfParseError('BMP: missing "BM" file header');
  const offBits = u32(d, 0x0a);
  const dibSize = u32(d, 0x0e);
  if (!KNOWN_DIB.has(dibSize))
    throw new PdfParseError(`BMP: unknown DIB header size ${dibSize}`);
  if (d.length < 14 + dibSize)
    throw new PdfParseError('BMP: truncated DIB header');

  let width: number, rawHeight: number, bpp: number;
  let compression = BI_RGB, clrUsed = 0;
  if (dibSize === DIB_CORE) {
    // BITMAPCOREHEADER: 16-bit dimensions, no compression field at all.
    width = u16(d, 0x12);
    rawHeight = u16(d, 0x14);
    bpp = u16(d, 0x18);
  } else {
    width = i32(d, 0x12);
    rawHeight = i32(d, 0x16);
    bpp = u16(d, 0x1c);
    compression = u32(d, 0x1e);
    clrUsed = u32(d, 0x2e);
  }
  if (width <= 0 || rawHeight === 0)
    throw new PdfParseError(`BMP: bad dimensions ${width}x${rawHeight}`);
  const height = Math.abs(rawHeight);
  if (width * height > MAX_PIXELS)
    throw new PdfParseError(`BMP: ${width}x${height} exceeds the pixel bound`);
  if (offBits < 14 + dibSize || offBits > d.length)
    throw new PdfParseError(`BMP: pixel offset ${offBits} outside the file`);

  return {
    dibSize, width, height, topDown: rawHeight < 0, bpp, compression,
    clrUsed, offBits, afterHeader: 14 + dibSize,
  };
}

/** Bytes per row in the FILE: packed to the bit depth, then padded to 4 bytes. */
export function fileStride(width: number, bpp: number): number {
  return (((width * bpp + 31) / 32) | 0) * 4;
}

/** Bytes per row in the OUTPUT: packed to the bit depth, padded to a byte. */
export function packedStride(width: number, bpp: number): number {
  return (width * bpp + 7) >> 3;
}

/**
 * Walk the file's rows in the order they should appear top-down, calling `row`
 * with each row's bytes. A positive height means the file stores the bottom row
 * first, so the walk runs backwards.
 *
 * The single owner of the row flip: every route reads its rows through this, so
 * none of them can disagree about which end of the file the top row lives at.
 */
export function eachRowTopDown(
  d: Uint8Array, h: BmpHeader, stride: number,
  row: (bytes: Uint8Array, y: number) => void,
): void {
  const need = h.offBits + stride * h.height;
  if (need > d.length)
    throw new PdfParseError(`BMP: pixel array needs ${need} bytes, file has ${d.length}`);
  for (let y = 0; y < h.height; y++) {
    const src = h.topDown ? y : h.height - 1 - y;
    row(d.subarray(h.offBits + src * stride, h.offBits + (src + 1) * stride), y);
  }
}

/** 24-bit BI_RGB: BGR triples, restrided and flipped. */
function decode24(d: Uint8Array, h: BmpHeader): RasterImage {
  const out = new Uint8Array(h.width * h.height * 3);
  eachRowTopDown(d, h, fileStride(h.width, 24), (src, y) => {
    let o = y * h.width * 3;
    for (let x = 0; x < h.width; x++) {
      const s = x * 3;
      out[o++] = src[s + 2];   // R
      out[o++] = src[s + 1];   // G
      out[o++] = src[s];       // B
    }
  });
  return { kind: 'rgb', width: h.width, height: h.height, samples: out };
}

/**
 * Read the colour table into RGB triples.
 *
 * Entry size is the ONE thing the header generation changes downstream: a
 * BITMAPCOREHEADER stores RGBTRIPLE (3 bytes), everything later RGBQUAD (4).
 * Reading the wrong size shifts every colour after the first.
 */
function readPalette(d: Uint8Array, h: BmpHeader, inlineMasks: number): Uint8Array {
  const entry = h.dibSize === DIB_CORE ? 3 : 4;
  const count = h.clrUsed !== 0 ? h.clrUsed : 1 << h.bpp;
  const start = h.afterHeader + inlineMasks;
  if (start + count * entry > h.offBits)
    throw new PdfParseError(`BMP: ${count}-entry palette runs past the pixel data`);
  const pal = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = start + i * entry;
    pal[i * 3] = d[s + 2];       // R
    pal[i * 3 + 1] = d[s + 1];   // G
    pal[i * 3 + 2] = d[s];       // B
  }
  return pal;
}

/** 1/2/4/8-bit palette images: indices pass through, restrided and flipped. */
function decodeIndexed(d: Uint8Array, h: BmpHeader, samples?: Uint8Array): RasterImage {
  const palette = readPalette(d, h, 0);
  const outStride = packedStride(h.width, h.bpp);
  let out: Uint8Array;
  if (samples) {
    out = samples;                       // already unpacked by the RLE route
  } else {
    out = new Uint8Array(outStride * h.height);
    eachRowTopDown(d, h, fileStride(h.width, h.bpp), (src, y) => {
      out.set(src.subarray(0, outStride), y * outStride);
    });
  }
  return {
    kind: 'indexed', width: h.width, height: h.height,
    bpc: h.bpp as 1 | 2 | 4 | 8, palette, samples: out,
  };
}

/** A channel mask reduced to a shift and the width of its field. */
interface Channel { shift: number; max: number }

function channelOf(mask: number): Channel | undefined {
  if (mask === 0) return undefined;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let width = 0;
  while (((mask >>> (shift + width)) & 1) === 1) width++;
  return { shift, max: (1 << width) - 1 };
}

/**
 * Scale a channel to 8 bits by rounding, NOT by truncating and NOT by
 * replicating high bits. The three agree at 0 and at full scale, and differ in
 * between -- 5-bit 3 of 31 is 25 rounded and 24 the other two ways -- and only
 * rounding maps `max` to exactly 255 for every field width.
 */
const scale8 = (v: number, max: number): number =>
  max === 255 ? v : Math.round((v * 255) / max);

/**
 * Where a bitfields header keeps its masks, which differs by header size and is
 * the kind of thing that is silently wrong when wrong: a 40-byte INFOHEADER
 * stores them AFTER itself, in the bytes a palette would occupy, while a 52+
 * header stores them INSIDE itself at offset 0x36. Reading a V2 header's masks
 * from after it consumes the first palette entries as masks.
 */
function readMasks(d: Uint8Array, h: BmpHeader): [number, number, number, number] {
  const alphaField = h.dibSize >= DIB_V3 || h.compression === BI_ALPHABITFIELDS;
  if (h.compression === BI_BITFIELDS || h.compression === BI_ALPHABITFIELDS) {
    const at = h.dibSize >= DIB_V2 ? 0x36 : h.afterHeader;
    const need = at + (alphaField ? 16 : 12);
    if (need > d.length) throw new PdfParseError('BMP: truncated channel masks');
    return [u32(d, at), u32(d, at + 4), u32(d, at + 8),
            alphaField ? u32(d, at + 12) : 0];
  }
  // BI_RGB at 16 bpp is RGB555; at 32 bpp it is BGRX and the fourth byte is pad.
  if (h.bpp === 16) return [0x7c00, 0x03e0, 0x001f, 0];
  return [0x00ff0000, 0x0000ff00, 0x000000ff, 0];
}

/** 16- and 32-bit images, both mask-driven. */
function decodePacked(d: Uint8Array, h: BmpHeader): RasterImage {
  const [rm, gm, bm, am] = readMasks(d, h);
  const rc = channelOf(rm), gc = channelOf(gm), bc = channelOf(bm);
  if (!rc || !gc || !bc) throw new PdfParseError('BMP: a colour mask is empty');
  // The header must DECLARE alpha. A plain 32-bpp BI_RGB file's fourth byte is
  // padding, and it is very commonly zero across the whole image -- honouring it
  // yields a picture that is drawn, structurally correct and fully invisible.
  const ac = channelOf(am);

  const px = h.width * h.height;
  const out = new Uint8Array(px * 3);
  const alpha = ac ? new Uint8Array(px) : undefined;
  const bytes = h.bpp >> 3;
  eachRowTopDown(d, h, fileStride(h.width, h.bpp), (src, y) => {
    for (let x = 0; x < h.width; x++) {
      const s = x * bytes;
      const v = bytes === 2 ? (src[s] | (src[s + 1] << 8))
        : (src[s] | (src[s + 1] << 8) | (src[s + 2] << 16) | (src[s + 3] << 24)) >>> 0;
      const p = y * h.width + x;
      out[p * 3] = scale8((v >>> rc.shift) & rc.max, rc.max);
      out[p * 3 + 1] = scale8((v >>> gc.shift) & gc.max, gc.max);
      out[p * 3 + 2] = scale8((v >>> bc.shift) & bc.max, bc.max);
      if (alpha && ac) alpha[p] = scale8((v >>> ac.shift) & ac.max, ac.max);
    }
  });
  return { kind: 'rgb', width: h.width, height: h.height, samples: out, alpha };
}

/**
 * Decode an RLE4/RLE8 stream into a packed index raster, top-down.
 *
 * Pixels no run ever writes stay index 0 -- after a delta escape, or where a
 * row ends before its width. The format leaves them undefined; 0 is what
 * decoders in the wild produce and the only choice whose output cannot depend
 * on uninitialized memory.
 *
 * RLE is always bottom-up (the format forbids a negative height with it), so
 * the first row decoded is the BOTTOM one and rows are written from the end.
 */
function decodeRle(d: Uint8Array, h: BmpHeader): Uint8Array {
  const stride = packedStride(h.width, h.bpp);
  const out = new Uint8Array(stride * h.height);
  const nibble = h.bpp === 4;

  const put = (x: number, y: number, idx: number): void => {
    if (x >= h.width || y >= h.height) return;   // a delta may land off the edge
    const row = (h.height - 1 - y) * stride;     // bottom-up
    if (nibble) {
      const b = row + (x >> 1);
      out[b] |= (x & 1) === 0 ? (idx & 0x0f) << 4 : idx & 0x0f;
    } else {
      out[row + x] = idx & 0xff;
    }
  };

  let p = h.offBits, x = 0, y = 0;
  for (;;) {
    if (p + 1 >= d.length) throw new PdfParseError('BMP: RLE stream ends mid-code');
    const count = d[p++], value = d[p++];
    if (count > 0) {
      if (x + count > h.width)
        throw new PdfParseError(`BMP: RLE run of ${count} overruns row ${y}`);
      for (let i = 0; i < count; i++, x++)
        put(x, y, nibble ? ((i & 1) === 0 ? value >> 4 : value & 0x0f) : value);
      continue;
    }
    if (value === 0) { x = 0; y++; continue; }        // end of line
    if (value === 1) break;                           // end of bitmap
    if (value === 2) {                                // delta
      if (p + 1 >= d.length) throw new PdfParseError('BMP: RLE delta is truncated');
      x += d[p++]; y += d[p++];
      continue;
    }
    // Absolute mode: `value` literal pixels, the run padded to a 16-bit boundary.
    const n = value;
    if (x + n > h.width)
      throw new PdfParseError(`BMP: RLE absolute run of ${n} overruns row ${y}`);
    const bytes = nibble ? (n + 1) >> 1 : n;
    if (p + bytes > d.length) throw new PdfParseError('BMP: RLE absolute run is truncated');
    for (let i = 0; i < n; i++, x++) {
      const b = d[p + (nibble ? i >> 1 : i)];
      put(x, y, nibble ? ((i & 1) === 0 ? b >> 4 : b & 0x0f) : b);
    }
    p += bytes + (bytes & 1);   // word alignment
  }
  return out;
}

export function decodeBmp(data: Uint8Array): RasterImage {
  const h = parseBmpHeader(data);
  if (h.compression === BI_RLE8 || h.compression === BI_RLE4) {
    const want = h.compression === BI_RLE8 ? 8 : 4;
    if (h.bpp !== want)
      throw new UnsupportedFeatureError(`BMP: RLE${want} at ${h.bpp}bpp`);
    if (h.topDown)
      throw new UnsupportedFeatureError('BMP: a top-down RLE image is not valid');
    return decodeIndexed(data, h, decodeRle(data, h));
  }
  if (h.compression === BI_BITFIELDS || h.compression === BI_ALPHABITFIELDS) {
    if (h.bpp === 16 || h.bpp === 32) return decodePacked(data, h);
    throw new UnsupportedFeatureError(`BMP: bitfields at ${h.bpp}bpp`);
  }
  // BI_JPEG and BI_PNG wrap a COMPLETE file. Slice it and name it; decoding it
  // here would give this module a dependency on JPEG for a case that needs none.
  if (h.compression === BI_JPEG || h.compression === BI_PNG) {
    const payload = data.subarray(h.offBits);
    if (payload.length === 0)
      throw new PdfParseError('BMP: embedded payload is empty');
    return {
      kind: 'embedded',
      format: h.compression === BI_JPEG ? 'jpeg' : 'png',
      payload,
    };
  }
  if (h.compression === BI_RGB) {
    if (h.bpp === 16 || h.bpp === 32) return decodePacked(data, h);
    if (h.bpp === 1 || h.bpp === 2 || h.bpp === 4 || h.bpp === 8)
      return decodeIndexed(data, h);
    if (h.bpp === 24) return decode24(data, h);
  }
  throw new UnsupportedFeatureError(
    `BMP: unsupported ${h.bpp}bpp with compression ${h.compression}`);
}
