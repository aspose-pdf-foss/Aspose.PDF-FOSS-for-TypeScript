import type { Document } from './document.js';
import type { Page } from './page.js';
import { inflateSync, deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, PdfStream, name } from './types.js';
import { enc } from './serialize.js';
import { applyPredictor } from './predictor.js';
import type { StructElement } from './struct.js';
import type { Layer } from './ocg.js';
import { allocContentMcid } from './structwrite.js';
import {
  ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent, freshKey, num,
  wrapMarkedContent, wrapArtifact,
} from './pagecontent.js';
import { UnsupportedFeatureError, PdfParseError } from './errors.js';
import { decodeBmp } from './bmp.js';
import { decodeTiff, tiffPageCount } from './tiff.js';
import type { RasterImage } from './rasterimage.js';

export interface AddImageOptions {
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Which image of a multi-image file to embed, 0-based. TIFF only; a
   *  non-zero value THROWS for a format with no pages rather than being
   *  silently ignored. Default 0. */
  page?: number;
  /** When set, wrap the image draw in a marked-content sequence and attach it to
   *  the given structure element (typically a `Figure` with `/Alt`). */
  tag?: StructElement;
  /** Attach the whole image XObject to an optional-content layer (sets /OC). */
  layer?: Layer;
}

export interface BuiltImage {
  stream: PdfStream;
  smask?: PdfStream;
}

/** DIB header sizes a BMP may declare, mirroring bmp.ts's own set. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** Detect 'jpeg', 'png', 'bmp' or 'tiff' from leading magic bytes. */
function sniff(data: Uint8Array): 'jpeg' | 'png' | 'bmp' | 'tiff' {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'jpeg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 &&
      data[2] === 0x4e && data[3] === 0x47) return 'png';
  // "II" 42 or "MM" 42, each read in its OWN byte order. Four bytes of
  // structure, so unlike BMP's two-byte "BM" this needs no secondary check.
  if (data.length >= 8) {
    if (data[0] === 0x49 && data[1] === 0x49 && data[2] === 42 && data[3] === 0) return 'tiff';
    if (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 42) return 'tiff';
  }
  // "BM" is only two bytes, far weaker magic than PNG's eight, so a known DIB
  // header size is required beside it -- otherwise any file beginning with
  // those bytes is claimed by the BMP path and fails deep inside the decoder
  // with a message about a header field rather than here.
  if (data.length >= 18 && data[0] === 0x42 && data[1] === 0x4d) {
    const dib = (data[14] | (data[15] << 8) | (data[16] << 16) | (data[17] << 24)) >>> 0;
    if (BMP_DIB_SIZES.has(dib)) return 'bmp';
  }
  throw new UnsupportedFeatureError('AddImage: unrecognized image format (expected JPEG, PNG, BMP or TIFF)');
}

/** Parse a baseline/progressive JPEG SOF marker into an Image XObject. */
export function buildJpegXObject(data: Uint8Array): BuiltImage {
  let i = 2; // skip SOI (FF D8)
  let adobe = false; // Adobe APP14 marker present (CMYK is stored inverted)
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    let marker = data[i + 1];
    i += 2;
    while (marker === 0xff && i < data.length) marker = data[i++]; // skip fill bytes
    if (marker === 0xd8 || marker === 0xd9) continue;              // SOI/EOI: no length
    if (marker >= 0xd0 && marker <= 0xd7) continue;               // RSTn: no length
    if (i + 1 >= data.length) break;
    const segLen = (data[i] << 8) | data[i + 1];
    if (marker === 0xee && segLen >= 7 && // APP14 "Adobe"
        data[i + 2] === 0x41 && data[i + 3] === 0x64 && data[i + 4] === 0x6f &&
        data[i + 5] === 0x62 && data[i + 6] === 0x65) {
      adobe = true;
    }
    // SOF markers carry frame geometry; exclude DHT(C4), JPG(C8), DAC(CC).
    const isSOF = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const precision = data[i + 2];
      const height = (data[i + 3] << 8) | data[i + 4];
      const width = (data[i + 5] << 8) | data[i + 6];
      const nc = data[i + 7];
      const cs = nc === 1 ? 'DeviceGray' : nc === 3 ? 'DeviceRGB' : nc === 4 ? 'DeviceCMYK' : undefined;
      if (cs === undefined)
        throw new UnsupportedFeatureError(`AddImage: unsupported JPEG with ${nc} components`);
      const dict: PdfDict = new Map<string, PdfObject>([
        ['Type', name('XObject')],
        ['Subtype', name('Image')],
        ['Width', width],
        ['Height', height],
        ['BitsPerComponent', precision],
        ['ColorSpace', name(cs)],
        ['Filter', name('DCTDecode')],
      ]);
      // Adobe-tagged CMYK JPEGs store inverted samples; flip them back via /Decode.
      if (nc === 4 && adobe) dict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0]);
      return { stream: { kind: 'stream', dict, raw: data } };
    }
    i += segLen; // skip this segment
  }
  throw new PdfParseError('AddImage: no SOF marker found in JPEG');
}

/** Map a decoded raster onto an Image XObject, reusing the PNG path's parts.
 *
 *  The single owner of "which PDF colour space is this" for every image INPUT
 *  format. Two copies of this switch is how a BMP and a TIFF holding the same
 *  picture come to embed differently. Every arm is machinery that already
 *  existed: `imageStream`, `flate`, and the colour-plus-`/SMask` shape
 *  `buildPngXObject` produces for colour type 6. */
export function buildRasterXObject(img: RasterImage): BuiltImage {
  if (img.kind === 'embedded')
    return img.format === 'jpeg' ? buildJpegXObject(img.payload) : buildPngXObject(img.payload);
  if (img.kind === 'indexed') {
    const hival = Math.floor(img.palette.length / 3) - 1;
    const cs: PdfObject = [
      name('Indexed'), name('DeviceRGB'), hival,
      { kind: 'string', bytes: img.palette } as PdfObject,
    ];
    return { stream: imageStream(img.width, img.height, img.bpc, cs, flate(img.samples)) };
  }
  if (img.kind === 'cmyk')
    return { stream: imageStream(img.width, img.height, 8, name('DeviceCMYK'), flate(img.samples)) };

  const gray = img.kind === 'gray';
  const bpc = gray ? img.bpc : 8;
  const cs = name(gray ? 'DeviceGray' : 'DeviceRGB');
  const stream = imageStream(img.width, img.height, bpc, cs, flate(img.samples));
  if (!img.alpha) return { stream };
  const smask = imageStream(img.width, img.height, 8, name('DeviceGray'), flate(img.alpha));
  return { stream, smask };
}

/** How many frames an image file holds. Only TIFF can hold more than one, so
 *  every other format answers 1 — which is what lets `AddImagePages` treat a
 *  JPEG as a one-page document without a special case at the call site. */
export function imageFrameCount(
  data: Uint8Array, format?: 'jpeg' | 'png' | 'bmp' | 'tiff',
): number {
  return (format ?? sniff(data)) === 'tiff' ? tiffPageCount(data) : 1;
}

/** Build an Image XObject (+ optional soft mask) from encoded image bytes,
 *  auto-detecting JPEG/PNG/BMP/TIFF. Does not attach it to any page. */
export function buildImageXObject(
  data: Uint8Array, format?: 'jpeg' | 'png' | 'bmp' | 'tiff', page = 0,
): BuiltImage {
  const fmt = format ?? sniff(data);
  if (fmt === 'tiff') return buildRasterXObject(decodeTiff(data, page));
  // Accepting `page` and ignoring it is the trap textedit.ts's `region` is
  // documented against: a caller who thinks they selected page 3 and silently
  // got page 1 has no way to tell.
  if (page !== 0)
    throw new UnsupportedFeatureError(`AddImage: ${fmt} has no pages, so page ${page} is invalid`);
  if (fmt === 'bmp') return buildRasterXObject(decodeBmp(data));
  return fmt === 'jpeg' ? buildJpegXObject(data) : buildPngXObject(data);
}

/** Embed `data` as an Image XObject and paint it into rect [x, y, w, h]. */
export function addImage(
  doc: Document, page: Page, data: Uint8Array,
  rect: [number, number, number, number], opts: AddImageOptions = {},
): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] (4 finite numbers)');
  const built = buildImageXObject(data, opts.format, opts.page ?? 0);
  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  if (opts.layer) built.stream.dict.set('OC', opts.layer.Ref);
  xobjs.set(key, doc.allocObject(built.stream));

  const [x, y, w, h] = rect;
  const opacity = opts.opacity;
  const gsKey = opacity !== undefined && opacity < 1
    ? registerExtGState(doc, page, opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n`;
  s += `/${key} Do\nQ`;
  const body = enc(s);
  const tagged = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : body;
  appendContent(doc, page, tagged);
}

/** Embed a pre-built {@link BuiltImage} into `rect` [x, y, w, h] on `page`.
 *  Clones the image stream (and its soft mask) before allocating, so a single
 *  `BuiltImage` can be embedded independently on several pages (e.g. a repeating
 *  table header). Registers a fresh `/ImN` XObject and appends the draw. */
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number],
  opts: { opacity?: number; tag?: StructElement; artifact?: boolean } = {},
): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] (4 finite numbers)');
  const stream: PdfStream = { ...built.stream, dict: new Map(built.stream.dict) };
  if (built.smask) {
    const smask: PdfStream = { ...built.smask, dict: new Map(built.smask.dict) };
    stream.dict.set('SMask', doc.allocObject(smask));
  }
  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, doc.allocObject(stream));

  const [x, y, w, h] = rect;
  const opacity = opts.opacity;
  const gsKey = opacity !== undefined && opacity < 1
    ? registerExtGState(doc, page, opacity) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += `${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n`;
  s += `/${key} Do\nQ`;
  const body = enc(s);
  // `tag` wins over `artifact`, matching structwrite.ts's markDrawing: the caller
  // named a specific element, and silently discarding it for an artifact would be
  // the more surprising reading.
  const marked = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : opts.artifact ? wrapArtifact(body) : body;
  appendContent(doc, page, marked);
}

/** PNG chunk reader: yields { type, data } in order. */
function* pngChunks(data: Uint8Array): Generator<{ type: string; data: Uint8Array }> {
  let i = 8; // skip signature
  while (i + 8 <= data.length) {
    const len = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    const start = i + 8;
    yield { type, data: data.subarray(start, start + len) };
    i = start + len + 4; // + CRC
  }
}

/** Deflate `bytes` for a /FlateDecode stream. */
export function flate(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(bytes)));
}

/** An Image XObject over already-deflated sample bytes. */
export function imageStream(
  width: number, height: number, bpc: number,
  colorSpace: PdfObject, raw: Uint8Array,
): PdfStream {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Image')],
    ['Width', width],
    ['Height', height],
    ['BitsPerComponent', bpc],
    ['ColorSpace', colorSpace],
    ['Filter', name('FlateDecode')],
  ]);
  return { kind: 'stream', dict, raw };
}

// Adam7 interlace passes: [xStart, yStart, xStep, yStep].
const ADAM7_PASSES: [number, number, number, number][] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/** Reassemble a full raster from the 7 Adam7 passes of an interlaced PNG.
 *  Supported at bit depth >= 8 (byte-aligned pixels). */
function deinterlaceAdam7(
  inflated: Uint8Array, width: number, height: number, channels: number, bitDepth: number,
): Uint8Array {
  if (bitDepth < 8)
    throw new UnsupportedFeatureError('AddImage: interlaced PNG below 8-bit is not supported');
  const pxBytes = (channels * bitDepth) >> 3;
  const full = new Uint8Array(width * height * pxBytes);
  let off = 0;
  for (const [xs, ys, xstep, ystep] of ADAM7_PASSES) {
    const pw = xs >= width ? 0 : Math.ceil((width - xs) / xstep);
    const ph = ys >= height ? 0 : Math.ceil((height - ys) / ystep);
    if (pw === 0 || ph === 0) continue;
    const passBytes = (pw * pxBytes + 1) * ph;
    const passSamples = applyPredictor(inflated.subarray(off, off + passBytes), {
      predictor: 15, colors: channels, bpc: bitDepth, columns: pw,
    });
    off += passBytes;
    for (let r = 0; r < ph; r++) {
      const y = ys + r * ystep;
      for (let c = 0; c < pw; c++) {
        const x = xs + c * xstep;
        const src = (r * pw + c) * pxBytes;
        const dst = (y * width + x) * pxBytes;
        for (let k = 0; k < pxBytes; k++) full[dst + k] = passSamples[src + k];
      }
    }
  }
  return full;
}

function buildPngXObject(data: Uint8Array): BuiltImage {
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];
  for (const { type, data: cd } of pngChunks(data)) {
    if (type === 'IHDR') {
      width = (cd[0] << 24) | (cd[1] << 16) | (cd[2] << 8) | cd[3];
      height = (cd[4] << 24) | (cd[5] << 16) | (cd[6] << 8) | cd[7];
      bitDepth = cd[8];
      colorType = cd[9];
      interlace = cd[12];
    } else if (type === 'PLTE') {
      palette = cd;
    } else if (type === 'tRNS') {
      trns = cd;
    } else if (type === 'IDAT') {
      idatParts.push(cd);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (colorType < 0) throw new PdfParseError('AddImage: PNG has no IHDR');

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1
    : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new UnsupportedFeatureError(`AddImage: unsupported PNG color type ${colorType}`);
  const hasAlpha = colorType === 4 || colorType === 6;
  if (hasAlpha && bitDepth !== 8)
    throw new UnsupportedFeatureError('AddImage: PNG with alpha is only supported at 8-bit depth');

  // Concatenate and inflate IDAT, then reverse PNG row filters via predictor 15
  // (per-pass for an interlaced image, whole-raster otherwise).
  const idatLen = idatParts.reduce((n, p) => n + p.length, 0);
  const idat = new Uint8Array(idatLen);
  { let o = 0; for (const p of idatParts) { idat.set(p, o); o += p.length; } }
  const inflated = new Uint8Array(inflateSync(Buffer.from(idat)));
  const samples = interlace === 1
    ? deinterlaceAdam7(inflated, width, height, channels, bitDepth)
    : applyPredictor(inflated, { predictor: 15, colors: channels, bpc: bitDepth, columns: width });

  if (hasAlpha) {
    // Split interleaved color+alpha (8-bit) into separate color and alpha planes.
    const colorChannels = channels - 1; // 1 (gray+a) or 3 (rgb+a)
    const px = width * height;
    const color = new Uint8Array(px * colorChannels);
    const alpha = new Uint8Array(px);
    for (let p = 0; p < px; p++) {
      for (let c = 0; c < colorChannels; c++) color[p * colorChannels + c] = samples[p * channels + c];
      alpha[p] = samples[p * channels + colorChannels];
    }
    const cs = colorChannels === 1 ? name('DeviceGray') : name('DeviceRGB');
    const stream = imageStream(width, height, 8, cs, flate(color));
    const smask = imageStream(width, height, 8, name('DeviceGray'), flate(alpha));
    return { stream, smask };
  }

  if (colorType === 3) {
    if (!palette) throw new PdfParseError('AddImage: palette PNG missing PLTE');
    const hival = Math.floor(palette.length / 3) - 1;
    const cs: PdfObject = [
      name('Indexed'), name('DeviceRGB'), hival,
      { kind: 'string', bytes: new Uint8Array(palette) } as PdfObject,
    ];
    const stream = imageStream(width, height, bitDepth, cs, flate(samples));
    if (trns && trns.length > 0) {
      if (bitDepth !== 8)
        throw new UnsupportedFeatureError('AddImage: palette tRNS below 8-bit is not supported');
      // `samples` holds one palette index per pixel (8-bit). Map index -> alpha;
      // indices at or beyond the tRNS list are fully opaque (255).
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < alpha.length; i++) {
        const idx = samples[i];
        alpha[i] = idx < trns.length ? trns[idx] : 255;
      }
      const smask = imageStream(width, height, 8, name('DeviceGray'), flate(alpha));
      return { stream, smask };
    }
    return { stream };
  }

  const cs = colorType === 0 ? name('DeviceGray') : name('DeviceRGB');
  return { stream: imageStream(width, height, bitDepth, cs, flate(samples)) };
}
