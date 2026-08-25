import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isName } from './types.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, deviceGray, Rgb } from './colorspace.js';
import { ImageInfo } from './image.js';
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

/** An image XObject as encoded bytes: an image carrying transparency becomes an
 *  RGBA PNG, an unmasked DCTDecode passes through as JPEG, an /ImageMask is
 *  painted with `fill`, and anything else decodable is re-encoded to PNG.
 *  Returns undefined when the image cannot be decoded. Never throws.
 *
 *  The bytes rather than a `data:` URI, because a caller writing images
 *  alongside a document needs the file — and because a media type is what tells
 *  it which extension to use. `imageHref` is the base64 wrapper over this, so
 *  the two cannot disagree about what an image is. */
export function encodeImage(doc: Document, stream: PdfStream, fill: Rgb): EncodedImage | undefined {
  const info = new ImageInfo(doc, '', stream);
  const filter = info.Filter;

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
    return { bytes: info.RawData, mediaType: 'image/jpeg' };
  }
  try {
    const width = info.Width, height = info.Height;
    if (!width || !height) return undefined;
    const samples = info.Decode();
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

/** The conventional file extension for a media type this module emits. */
export function imageExtension(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : 'png';
}
