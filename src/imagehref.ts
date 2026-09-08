import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isName } from './types.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, deviceGray, Rgb } from './colorspace.js';
import { decodeImageStream, filterName, numOf } from './imagedecode.js';
import { encodeJpeg } from './jpegencode.js';
import { createHash } from 'node:crypto';
import { UnsupportedFeatureError } from './errors.js';
import { encodePng, pngDataUri } from './pngencode.js';
import { decodeImageRgba } from './imagergba.js';

function num(doc: Document, o: PdfObject | undefined): number {
  const v = doc.resolve(o);
  return typeof v === 'number' ? v : 0;
}

function isIndexedColorSpace(doc: Document, csObj: PdfObject | undefined): boolean {
  const r0 = doc.resolve(csObj);
  if (isArray(r0) && r0.length) {
    const h = doc.resolve(r0[0]);
    return isName(h) && (h.name === 'Indexed' || h.name === 'I');
  }
  return false;
}

function samplesToPng(
  doc: Document, dict: PdfDict, samples: Uint8Array, width: number, height: number,
): Uint8Array | undefined {
  const r = (o: PdfObject | undefined) => doc.resolve(o);
  const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
  const bpc = num(doc, dict.get('BitsPerComponent')) || 8;
  if (bpc !== 8) return undefined;
  const csObj = dict.get('ColorSpace');
  const isIndexedCs = isIndexedColorSpace(doc, csObj);
  const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : deviceGray();
  const nc = cs.components;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let out: Rgb;
    if (isIndexedCs) out = cs.toRgb([samples[i] ?? 0]);
    else {
      const comps: number[] = [];
      for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / 255);
      out = cs.toRgb(comps);
    }
    rgb[i * 3] = out[0]; rgb[i * 3 + 1] = out[1]; rgb[i * 3 + 2] = out[2];
  }
  return encodePng(width, height, rgb, 'rgb');
}

function maskPng(bits: Uint8Array, width: number, height: number, fill: Rgb): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const i = (y * width + x) * 4;
      const paint = bit === 0;
      rgba[i] = fill[0]; rgba[i + 1] = fill[1]; rgba[i + 2] = fill[2];
      rgba[i + 3] = paint ? 255 : 0;
    }
  }
  return encodePng(width, height, rgba, 'rgba');
}

/**
 * Does this image carry transparency of any kind?
 *
 * A cheap dict test rather than a decode, because it gates the JPEG
 * passthrough: an unmasked image must take exactly the path it took before
 * `2pgr`, so that no export's bytes move. `/Mask` counts in BOTH its forms --
 * a stencil stream and a colour-key array are one entry.
 */
function hasTransparency(doc: Document, dict: PdfDict): boolean {
  if (doc.resolve(dict.get('ImageMask')) === true) return false;  // its own branch below
  return dict.get('SMask') !== undefined || dict.get('Mask') !== undefined;
}

/** An image XObject encoded as a file: its bytes and their media type. */
export interface EncodedImage { bytes: Uint8Array; mediaType: string }

/** What `ImageInfo.Save` can be asked to produce. Deliberately NARROWER than
 *  `raster.ts`'s `ImageFormat`: those five encodings answer "rasterize a page",
 *  where this answers "hand me the picture that is already in the file", for
 *  which PNG and JPEG are what a caller writes to disk. Widening a union later
 *  is additive. */
export type SaveImageFormat = 'png' | 'jpeg';

const MEDIA_TYPE: Record<SaveImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/** How an image is to be saved. */
export interface SaveImageOptions {
  /** Force an encoding. Omitted, the image is encoded FAITHFULLY: an unmasked
   *  JPEG hands back its embedded bytes verbatim and anything else becomes PNG.
   *
   *  **Invariant:** an unrecognised value THROWS rather than falling back —
   *  TypeScript stops it at the call site, but this ships as JavaScript too, and
   *  PNG bytes written under a `.jpg` are a corrupt file rather than a degraded
   *  one. `raster.ts`'s `resolveFormat` takes the same posture. */
  format?: SaveImageFormat;
  /** Encoder quality, 1..100 on the IJG scale. Default 75.
   *
   *  Read only when JPEG bytes are actually PRODUCED. An already-JPEG image
   *  asked for `'jpeg'` passes through untouched, so it has no quality to
   *  re-choose; documented rather than rejected, as `ImageOptions.quality`
   *  already is for the lossless formats. */
  quality?: number;
}

/** Is every pixel fully opaque? */
function allOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/** RGBA to RGB, for samples `allOpaque` has already vouched for. */
function dropAlpha(rgba: Uint8Array): Uint8Array {
  const n = rgba.length / 4;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return rgb;
}

/** Composite straight RGBA over white, dropping the alpha channel.
 *
 *  For the opaque formats, where naming one IS the request to flatten. White
 *  rather than the stencil `fill`: this is the page a viewer would show the
 *  picture against, not the colour a stencil mask paints with. */
function overWhite(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const a = (rgba[i * 4 + 3] ?? 255) / 255;
    for (let k = 0; k < 3; k++) {
      rgb[i * 3 + k] = Math.round((rgba[i * 4 + k] ?? 0) * a + 255 * (1 - a));
    }
  }
  return rgb;
}

/** Re-encode an image to a NAMED format, decoding it through the shared RGBA
 *  decoder — the one owner of "/SMask, then a stencil /Mask, then a colour-key
 *  /Mask", so a saved file masks exactly as the renderers paint it. */
function reencode(
  doc: Document, stream: PdfStream, fill: Rgb, format: SaveImageFormat, quality?: number,
): EncodedImage | undefined {
  const rgba = decodeImageRgba(doc, stream, fill);
  if (!rgba) return undefined;
  if (format === 'png') {
    // An opaque picture is written WITHOUT an alpha channel, a third of the
    // bytes. That is not a corner: this branch is reached only when the
    // faithful encoding was a JPEG — every transparent image having been
    // handled there already — so extracting a photo as PNG is precisely the
    // case, and it is the common one.
    const opaque = allOpaque(rgba.data);
    const bytes = opaque
      ? encodePng(rgba.w, rgba.h, dropAlpha(rgba.data), 'rgb')
      : encodePng(rgba.w, rgba.h, rgba.data, 'rgba');
    return { bytes, mediaType: 'image/png' };
  }
  const rgb = overWhite(rgba.data, rgba.w, rgba.h);
  const bytes = encodeJpeg(rgba.w, rgba.h, rgb, 'rgb', quality != null ? { quality } : {});
  return { bytes, mediaType: 'image/jpeg' };
}

/** An image XObject as encoded bytes: an image carrying transparency becomes an
 *  RGBA PNG, an unmasked DCTDecode passes through as JPEG, an /ImageMask is
 *  painted with `fill`, and anything else decodable is re-encoded to PNG.
 *  Returns undefined when the image cannot be decoded. Never throws.
 *
 *  The bytes rather than a `data:` URI, because a caller writing images
 *  alongside a document needs the file — and because a media type is what tells
 *  it which extension to use. `imageHref` is the base64 wrapper over this, so
 *  the two cannot disagree about what an image is. */
export function encodeImage(
  doc: Document, stream: PdfStream, fill: Rgb, opts: SaveImageOptions = {},
): EncodedImage | undefined {
  const faithful = encodeFaithfully(doc, stream, fill);
  const want = opts.format;
  if (!want) return faithful;
  // A forced format the faithful encoding ALREADY satisfies changes nothing.
  // That is what keeps `Save({ format: 'png' })` on a Flate image identical to
  // `Save()` — and it is the cheaper answer, since the faithful PNG is RGB
  // where a re-encode would go through RGBA.
  if (faithful && faithful.mediaType === MEDIA_TYPE[want]) return faithful;
  return reencode(doc, stream, fill, want, opts.quality);
}

/** The faithful encoding: original bytes wherever they are already a file. */
function encodeFaithfully(doc: Document, stream: PdfStream, fill: Rgb): EncodedImage | undefined {
  const filter = filterName(doc, stream.dict);

  // Anything carrying transparency goes through the shared RGBA decoder, which
  // is the one owner of "/SMask, then a stencil /Mask, then a colour-key /Mask"
  // -- shared with raster.ts so the two renderers cannot disagree about the
  // same document, which is what they did until 2pgr.
  //
  // It comes FIRST because a JPEG cannot carry alpha: a soft-masked one has to
  // become a PNG or lose its mask, and losing it is what this fixes. An
  // unmasked image never reaches here, so every existing export's bytes are
  // untouched -- only pictures that were already wrong change.
  if (hasTransparency(doc, stream.dict)) {
    const rgba = decodeImageRgba(doc, stream, fill);
    if (rgba) {
      return { bytes: encodePng(rgba.w, rgba.h, rgba.data, 'rgba'), mediaType: 'image/png' };
    }
    // Undecodable: fall through and emit it opaque rather than nothing at all.
  }

  if (filter === 'DCTDecode' || filter === 'DCT') {
    return { bytes: stream.raw, mediaType: 'image/jpeg' };
  }
  try {
    const width = numOf(doc, stream.dict, 'Width', 0);
    const height = numOf(doc, stream.dict, 'Height', 0);
    if (!width || !height) return undefined;
    const samples = decodeImageStream(doc, stream);
    const dict = stream.dict;
    if (doc.resolve(dict.get('ImageMask')) === true)
      return { bytes: maskPng(samples, width, height, fill), mediaType: 'image/png' };
    const png = samplesToPng(doc, dict, samples, width, height);
    return png ? { bytes: png, mediaType: 'image/png' } : undefined;
  } catch {
    return undefined;
  }
}

/** An image XObject as a `data:` URI. See {@link encodeImage}. */
export function imageHref(doc: Document, stream: PdfStream, fill: Rgb): string | undefined {
  const enc = encodeImage(doc, stream, fill);
  if (!enc) return undefined;
  return `data:${enc.mediaType};base64,${Buffer.from(enc.bytes).toString('base64')}`;
}

/** The identity of an encoded image: a hash of its BYTES.
 *
 *  **Invariant:** never the `PdfStream` object. A merged document holds
 *  distinct stream objects with identical content, so keying on object identity
 *  re-encodes each of them and writes the same picture out several times — once
 *  per `data:` URI in a Markdown export, once per media part in a `.docx`, once
 *  per file on disk.
 *
 *  One owner because there are now THREE consumers — `mdexport.ts`,
 *  `docxexport.ts` and `node.ts`'s image extractor — and each had written the
 *  same three lines out for itself. docxexport.ts's own comment already claimed
 *  this was "mdexport.ts's rule, reused rather than re-derived", which it was
 *  not; it is now. It lives here because the rule is about an ENCODED image,
 *  beside {@link encodeImage} that produces one and {@link imageExtension} that
 *  names one. */
export function imageKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The conventional file extension for a media type this module emits. */
export function imageExtension(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : 'png';
}
