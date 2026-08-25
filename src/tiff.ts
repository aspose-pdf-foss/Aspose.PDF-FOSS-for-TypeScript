import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import type { RasterImage } from './rasterimage.js';
import { inflateSync } from 'node:zlib';
import { lzwDecode } from './lzw.js';
import { runLengthDecode } from './ascii.js';
import { applyPredictor } from './predictor.js';
import { decodeCcitt } from './ccitt.js';
import { decodeJpeg } from './jpeg.js';

/** Tags this decoder reads. Numbers are TIFF 6.0's. */
const T_WIDTH = 256, T_HEIGHT = 257, T_BPS = 258, T_COMPRESSION = 259;
const T_PHOTOMETRIC = 262, T_FILLORDER = 266, T_STRIP_OFFSETS = 273;
const T_SAMPLES = 277, T_ROWS_PER_STRIP = 278, T_STRIP_COUNTS = 279;
const T_PLANAR = 284, T_T4OPTIONS = 292, T_PREDICTOR = 317, T_COLORMAP = 320;
const T_TILE_WIDTH = 322, T_TILE_LENGTH = 323;
const T_TILE_OFFSETS = 324, T_TILE_COUNTS = 325;
const T_EXTRA_SAMPLES = 338, T_JPEG_TABLES = 347;

/** Bytes per value for each TIFF field type. Absent marks one we do not read. */
const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

/** Refuse a raster whose pixel count cannot plausibly be allocated. */
const MAX_PIXELS = 1 << 28;
/** A file with more images than this is damage, not a document. */
const MAX_PAGES = 4096;

/**
 * Every multi-byte read in this module goes through one of these.
 *
 * TIFF is the first format here that is not fixed-endian: `II` files are
 * little-endian and `MM` big-endian, and a large share of real files are `MM`.
 * A second read site that assumes an order misreads such a file completely and
 * silently -- which is why the reader is an object threaded everywhere rather
 * than a pair of free functions.
 */
class TiffReader {
  constructor(readonly d: Uint8Array, readonly le: boolean) {}
  u16(o: number): number {
    if (o < 0 || o + 1 >= this.d.length) throw new PdfParseError('TIFF: read past end of file');
    return this.le ? this.d[o] | (this.d[o + 1] << 8) : (this.d[o] << 8) | this.d[o + 1];
  }
  u32(o: number): number {
    if (o < 0 || o + 3 >= this.d.length) throw new PdfParseError('TIFF: read past end of file');
    const a = this.d[o], b = this.d[o + 1], c = this.d[o + 2], e = this.d[o + 3];
    return (this.le ? a | (b << 8) | (c << 16) | (e << 24)
                    : (a << 24) | (b << 16) | (c << 8) | e) >>> 0;
  }
}

/** A parsed IFD: tag -> its values, flattened to numbers. */
export type Ifd = Map<number, number[]>;

function openTiff(data: Uint8Array): TiffReader {
  if (data.length < 8) throw new PdfParseError('TIFF: file is too short');
  const le = data[0] === 0x49 && data[1] === 0x49;
  const be = data[0] === 0x4d && data[1] === 0x4d;
  if (!le && !be) throw new PdfParseError('TIFF: missing "II" or "MM" byte-order mark');
  const r = new TiffReader(data, le);
  const magic = r.u16(2);
  if (magic === 43) throw new UnsupportedFeatureError('TIFF: BigTIFF is not supported');
  if (magic !== 42) throw new PdfParseError(`TIFF: bad magic ${magic}`);
  return r;
}

/** Walk the IFD chain, guarding against a file that points one at itself. */
function ifdOffsets(r: TiffReader): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  let at = r.u32(4);
  while (at !== 0) {
    if (at + 2 > r.d.length) throw new PdfParseError(`TIFF: IFD offset ${at} outside the file`);
    if (seen.has(at)) throw new PdfParseError('TIFF: cyclic IFD chain');
    if (out.length >= MAX_PAGES) throw new PdfParseError('TIFF: too many images');
    seen.add(at);
    out.push(at);
    const count = r.u16(at);
    at = r.u32(at + 2 + count * 12);
  }
  if (out.length === 0) throw new PdfParseError('TIFF: no images');
  return out;
}

function readIfd(r: TiffReader, at: number): Ifd {
  const count = r.u16(at);
  const ifd: Ifd = new Map();
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    const tag = r.u16(e), type = r.u16(e + 2), n = r.u32(e + 4);
    const size = TYPE_SIZE[type];
    if (!size) continue;                       // a type we never read
    const bytes = size * n;
    // A value of four bytes or fewer is stored INLINE in the entry, left-
    // justified. Read as an offset it lands somewhere plausible in the file and
    // the image decodes to garbage with no error raised anywhere.
    const base = bytes <= 4 ? e + 8 : r.u32(e + 8);
    if (bytes > 4 && base + bytes > r.d.length)
      throw new PdfParseError(`TIFF: tag ${tag} value at ${base} outside the file`);
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      const o = base + k * size;
      vals.push(size === 1 ? r.d[o] : size === 2 ? r.u16(o) : r.u32(o));
    }
    ifd.set(tag, vals);
  }
  return ifd;
}

/** All values of a tag, or `dflt` when it is absent. */
function tagNums(ifd: Ifd, tag: number, dflt: number[]): number[] {
  const v = ifd.get(tag);
  return v && v.length ? v : dflt;
}
/** The first value of a tag, or `dflt` when it is absent. */
function tag1(ifd: Ifd, tag: number, dflt: number): number {
  const v = ifd.get(tag);
  return v && v.length ? v[0] : dflt;
}

export function tiffPageCount(data: Uint8Array): number {
  return ifdOffsets(openTiff(data)).length;
}

export function decodeTiff(data: Uint8Array, page = 0): RasterImage {
  const r = openTiff(data);
  const offsets = ifdOffsets(r);
  if (!Number.isInteger(page) || page < 0 || page >= offsets.length)
    throw new UnsupportedFeatureError(
      `TIFF: page ${page} out of range (file has ${offsets.length})`);
  return decodeIfd(r, readIfd(r, offsets[page]));
}

/** Bytes per row for `width` pixels of `bits` total bits each, byte-padded. */
export function packedStride(width: number, bits: number): number {
  return Math.ceil((width * bits) / 8);
}

/** One independently compressed rectangle of the image. */
interface Block { off: number; len: number; x: number; y: number; w: number; h: number }

/** Geometry and tags the block loop and the photometric mapping both need. */
export interface TiffPlan {
  width: number; height: number; photometric: number; spp: number; bps: number;
  compression: number; predictor: number; fillOrder: number; t4Options: number;
  blocks: Block[];
  /** The block's own width in pixels -- the TILE width, padded, when tiled. */
  blockW: number;
  tiled: boolean;
  /** JPEGTables (tag 347) for the abbreviated JPEG form, when present. */
  jpegTables?: Uint8Array;
}

/**
 * Split an interleaved colour+extra raster into colour and alpha planes.
 *
 * ExtraSamples 1 is ASSOCIATED alpha, meaning the colour is premultiplied, and
 * it must be divided out: PDF's /SMask composites colour x alpha, so
 * premultiplied colour multiplies alpha in twice and the image renders too
 * dark, worst exactly where it is most transparent. Value 2 is unassociated
 * and passes through. Value 0 is UNSPECIFIED, which is not a claim of
 * transparency -- the channel is dropped and the image stays opaque.
 */
function splitAlpha(
  samples: Uint8Array, px: number, colorCh: number, spp: number, extra: number,
): { color: Uint8Array; alpha?: Uint8Array } {
  const color = new Uint8Array(px * colorCh);
  for (let p = 0; p < px; p++)
    for (let c = 0; c < colorCh; c++) color[p * colorCh + c] = samples[p * spp + c];
  if (extra !== 1 && extra !== 2) return { color };

  const alpha = new Uint8Array(px);
  for (let p = 0; p < px; p++) alpha[p] = samples[p * spp + colorCh];
  if (extra === 2) return { color, alpha };
  for (let p = 0; p < px; p++) {
    const a = alpha[p];
    for (let c = 0; c < colorCh; c++) {
      const i = p * colorCh + c;
      color[i] = a === 0 ? 0 : Math.min(255, Math.round((color[i] * 255) / a));
    }
  }
  return { color, alpha };
}

/** JPEGTables minus its EOI, then the block minus its SOI. */
function spliceJpeg(tables: Uint8Array, block: Uint8Array): Uint8Array {
  const t = tables.length >= 2 && tables[tables.length - 2] === 0xff &&
            tables[tables.length - 1] === 0xd9
    ? tables.subarray(0, tables.length - 2) : tables;
  const b = block.length >= 2 && block[0] === 0xff && block[1] === 0xd8
    ? block.subarray(2) : block;
  const out = new Uint8Array(t.length + b.length);
  out.set(t, 0);
  out.set(b, t.length);
  return out;
}

/**
 * Strips and tiles are one thing: a rectangular block of the image, separately
 * compressed. They differ only in where each block's geometry comes from.
 *
 * A partial edge TILE still contains a FULL tile of data -- TIFF pads to the
 * tile grid and the image is cropped out of it -- whereas a final STRIP is
 * genuinely short. Treating an edge tile as short reads the next tile's bytes
 * as this one's remainder and misaligns every block after it.
 */
function blockList(ifd: Ifd, width: number, height: number): {
  blocks: Block[]; blockW: number; tiled: boolean;
} {
  const tw = tag1(ifd, T_TILE_WIDTH, 0), th = tag1(ifd, T_TILE_LENGTH, 0);
  const tiled = tw > 0 && th > 0;
  const offs = tagNums(ifd, tiled ? T_TILE_OFFSETS : T_STRIP_OFFSETS, []);
  const lens = tagNums(ifd, tiled ? T_TILE_COUNTS : T_STRIP_COUNTS, []);
  if (offs.length === 0 || offs.length !== lens.length)
    throw new PdfParseError('TIFF: block offsets and byte counts disagree');

  const blocks: Block[] = [];
  if (tiled) {
    // TIFF 6.0 requires both tile dimensions to be a multiple of 16. That is
    // what makes a tile's left edge byte-aligned at ANY bit depth, which is
    // what lets a sub-byte tiled image be copied row-wise at all.
    if (tw % 16 !== 0 || th % 16 !== 0)
      throw new PdfParseError(`TIFF: tile ${tw}x${th} is not a multiple of 16`);
    const across = Math.ceil(width / tw);
    const down = Math.ceil(height / th);
    if (across * down !== offs.length)
      throw new PdfParseError(`TIFF: ${offs.length} tiles for a ${across}x${down} grid`);
    for (let i = 0; i < offs.length; i++) {
      const cx = (i % across) * tw, cy = Math.floor(i / across) * th;
      blocks.push({
        off: offs[i], len: lens[i], x: cx, y: cy,
        w: Math.min(tw, width - cx), h: Math.min(th, height - cy),
      });
    }
    return { blocks, blockW: tw, tiled };
  }

  // RowsPerStrip defaults to 2^32-1: the whole image is ONE strip. Defaulting
  // it to 0 or 1 breaks every single-strip file, which is most of them.
  const rps = Math.min(tag1(ifd, T_ROWS_PER_STRIP, 0xffffffff), height);
  if (rps <= 0) throw new PdfParseError('TIFF: RowsPerStrip is zero');
  const expected = Math.ceil(height / rps);
  if (expected !== offs.length)
    throw new PdfParseError(`TIFF: ${offs.length} strips, geometry needs ${expected}`);
  for (let i = 0; i < offs.length; i++) {
    const y = i * rps;
    blocks.push({ off: offs[i], len: lens[i], x: 0, y, w: width, h: Math.min(rps, height - y) });
  }
  return { blocks, blockW: width, tiled };
}

/** The colour table: three consecutive PLANES of 16-bit values, scaled to 8. */
function readColorMap(ifd: Ifd, bps: number): Uint8Array {
  const cm = ifd.get(T_COLORMAP);
  if (!cm) throw new PdfParseError('TIFF: palette image with no ColorMap');
  const n = 1 << bps;
  if (cm.length < n * 3)
    throw new PdfParseError(`TIFF: ColorMap has ${cm.length} values, needs ${n * 3}`);
  const pal = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    pal[i * 3] = cm[i] >> 8;                 // reds plane
    pal[i * 3 + 1] = cm[n + i] >> 8;         // greens plane
    pal[i * 3 + 2] = cm[2 * n + i] >> 8;     // blues plane
  }
  return pal;
}

/** Bit-reversed bytes, for FillOrder 2. */
const REVERSE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 1 << (7 - b);
    t[i] = v;
  }
  return t;
})();

/**
 * Turn one block's stored bytes into raw samples.
 *
 * Every block is compressed INDEPENDENTLY and the codec state resets here, per
 * call. Concatenating blocks and decoding once produces garbage after the
 * first -- which is the structural reason this function takes one block rather
 * than the whole pixel area, and which no single-block fixture can observe.
 */
function decodeBlock(src: Uint8Array, p: TiffPlan, b: Block, srcStride: number): Uint8Array {
  let data = src;
  if (p.fillOrder === 2) {
    data = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) data[i] = REVERSE[src[i]];
  }

  let out: Uint8Array;
  switch (p.compression) {
    case 1: out = data; break;
    case 5: out = lzwDecode(data, 1); break;
    case 8: case 32946: out = new Uint8Array(inflateSync(Buffer.from(data))); break;
    // PDF's RunLengthDecode stops at byte 128, which TIFF PackBits reserves and
    // real encoders do not emit. The length check in `assemble` turns a silent
    // early stop into an error rather than a half-black strip.
    case 32773: out = runLengthDecode(data); break;
    // The abbreviated form: shared tables live in JPEGTables and each block
    // carries only its scan. The whole-image single-block case never reaches
    // here -- `decodeIfd` returns it as an `embedded` passthrough.
    case 7: out = decodeJpeg(p.jpegTables ? spliceJpeg(p.jpegTables, data) : data).data; break;
    // CCITT. `rows` is the BLOCK's height, not the image's, and `decodeCcitt`
    // reads `k` only for its SIGN -- negative is pure 2D, 0 is pure 1D,
    // anything positive is mixed -- so 1 is passed rather than T.4's
    // conventional 4, which would imply a significance it does not have.
    case 2: case 3: case 4: {
      const k = p.compression === 4 ? -1
        : p.compression === 2 ? 0
        : (p.t4Options & 1) ? 1 : 0;
      const byteAlign = p.compression === 2 ? true : !!(p.t4Options & 4);
      out = decodeCcitt(data, {
        k, columns: p.blockW, rows: b.h, blackIs1: false,
        byteAlign, endOfLine: false, endOfBlock: true,
      });
      break;
    }
    default:
      throw new UnsupportedFeatureError(`TIFF: compression ${p.compression} is not supported`);
  }

  if (p.predictor === 2) {
    // Per BLOCK, per row: with tiles the block's width is not the image's, and
    // passing the image's decodes the first tile plausibly and the rest wrongly.
    out = applyPredictor(out.subarray(0, srcStride * b.h), {
      predictor: 2, colors: p.spp, bpc: p.bps, columns: p.blockW,
    });
  } else if (p.predictor !== 1) {
    throw new UnsupportedFeatureError(`TIFF: Predictor ${p.predictor} is not supported`);
  }
  return out;
}

function decodeIfd(r: TiffReader, ifd: Ifd): RasterImage {
  const width = tag1(ifd, T_WIDTH, 0);
  const height = tag1(ifd, T_HEIGHT, 0);
  if (width <= 0 || height <= 0)
    throw new PdfParseError(`TIFF: bad dimensions ${width}x${height}`);
  if (width * height > MAX_PIXELS)
    throw new PdfParseError(`TIFF: ${width}x${height} exceeds the pixel bound`);
  if (!ifd.has(T_PHOTOMETRIC))
    throw new PdfParseError('TIFF: no PhotometricInterpretation');
  const photometric = tag1(ifd, T_PHOTOMETRIC, 0);
  const spp = tag1(ifd, T_SAMPLES, 1);
  const bps = tagNums(ifd, T_BPS, [1])[0];
  if (tag1(ifd, T_PLANAR, 1) !== 1)
    throw new UnsupportedFeatureError('TIFF: PlanarConfiguration 2 is not supported');

  // BI_JPEG's counterpart: one block covering the whole image, with no shared
  // tables, is a complete JPEG datastream. Hand it on untouched -- a DCTDecode
  // passthrough with no decode and no re-encode is the most faithful and the
  // cheapest route, and it is also what makes photometric 6 (YCbCr) work here
  // while the raw-sample routes refuse it, since a JPEG carries its own colour
  // transform.
  if (tag1(ifd, T_COMPRESSION, 1) === 7 && !ifd.has(T_JPEG_TABLES)) {
    const offs = tagNums(ifd, T_STRIP_OFFSETS, tagNums(ifd, T_TILE_OFFSETS, []));
    const lens = tagNums(ifd, T_STRIP_COUNTS, tagNums(ifd, T_TILE_COUNTS, []));
    if (offs.length === 1 && lens.length === 1) {
      if (offs[0] + lens[0] > r.d.length)
        throw new PdfParseError('TIFF: JPEG payload runs past the file');
      if (lens[0] === 0) throw new PdfParseError('TIFF: JPEG payload is empty');
      return { kind: 'embedded', format: 'jpeg',
               payload: r.d.subarray(offs[0], offs[0] + lens[0]) };
    }
  }

  const { blocks, blockW, tiled } = blockList(ifd, width, height);
  return assemble(r, ifd, {
    width, height, photometric, spp, bps,
    compression: tag1(ifd, T_COMPRESSION, 1),
    predictor: tag1(ifd, T_PREDICTOR, 1),
    fillOrder: tag1(ifd, T_FILLORDER, 1),
    t4Options: tag1(ifd, T_T4OPTIONS, 0),
    blocks, blockW, tiled,
    jpegTables: ifd.has(T_JPEG_TABLES)
      ? Uint8Array.from(tagNums(ifd, T_JPEG_TABLES, [])) : undefined,
  });
}

function assemble(r: TiffReader, ifd: Ifd, p: TiffPlan): RasterImage {
  const { width, height, spp, bps, photometric } = p;
  const imgStride = packedStride(width, bps * spp);
  const out = new Uint8Array(imgStride * height);

  for (const b of p.blocks) {
    if (b.off + b.len > r.d.length)
      throw new PdfParseError(`TIFF: block at ${b.off} runs past the file`);
    const srcStride = packedStride(p.blockW, bps * spp);
    const raw = decodeBlock(r.d.subarray(b.off, b.off + b.len), p, b, srcStride);
    if (raw.length < srcStride * b.h)
      throw new PdfParseError(
        `TIFF: block at ${b.off} decoded to ${raw.length} bytes, needs ${srcStride * b.h}`);
    const copy = packedStride(b.w, bps * spp);
    const xByte = (b.x * bps * spp) / 8;      // integral: tile widths are x16
    for (let j = 0; j < b.h; j++)
      out.set(raw.subarray(j * srcStride, j * srcStride + copy),
              (b.y + j) * imgStride + xByte);
  }

  if (photometric === 3) {
    if (spp !== 1) throw new UnsupportedFeatureError('TIFF: palette with several samples');
    return { kind: 'indexed', width, height, bpc: bps as 1 | 2 | 4 | 8,
             palette: readColorMap(ifd, bps), samples: out };
  }
  const extra = tag1(ifd, T_EXTRA_SAMPLES, 0);

  if (photometric === 0 || photometric === 1) {
    if (spp !== 1 && spp !== 2)
      throw new UnsupportedFeatureError(`TIFF: gray with ${spp} samples`);
    let samples: Uint8Array = out;
    let alpha: Uint8Array | undefined;
    if (spp === 2) {
      if (bps !== 8) throw new UnsupportedFeatureError('TIFF: gray+alpha below 8 bits');
      const s = splitAlpha(out, width * height, 1, 2, extra);
      samples = s.color; alpha = s.alpha;
    }
    // Photometric 0 is WhiteIsZero; DeviceGray is 0-is-black. Normalized here,
    // once, and nowhere else.
    if (photometric === 0) for (let i = 0; i < samples.length; i++) samples[i] ^= 0xff;
    return { kind: 'gray', width, height, bpc: bps as 1 | 2 | 4 | 8, samples, alpha };
  }
  if (photometric === 2 || photometric === 5) {
    const colorCh = photometric === 2 ? 3 : 4;
    if (bps !== 8)
      throw new UnsupportedFeatureError(`TIFF: ${colorCh}-channel image at ${bps} bits`);
    if (spp !== colorCh && spp !== colorCh + 1)
      throw new UnsupportedFeatureError(`TIFF: photometric ${photometric} with ${spp} samples`);
    if (photometric === 5) {
      if (spp !== 4) throw new UnsupportedFeatureError('TIFF: CMYK with an extra sample');
      return { kind: 'cmyk', width, height, samples: out };
    }
    if (spp === 3) return { kind: 'rgb', width, height, samples: out };
    const s = splitAlpha(out, width * height, 3, 4, extra);
    return { kind: 'rgb', width, height, samples: s.color, alpha: s.alpha };
  }
  throw new UnsupportedFeatureError(`TIFF: photometric ${photometric} is not supported`);
}

