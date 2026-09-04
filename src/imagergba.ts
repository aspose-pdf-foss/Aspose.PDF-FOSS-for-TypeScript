import type { Document } from './document.js';
import { PdfDict, PdfStream, PdfObject, isStream, isArray } from './types.js';
import { Rgb, ColorConverter, resolveColorSpace } from './colorspace.js';
import { arrNums } from './pagerender.js';
import { ImageInfo } from './image.js';
import { colorKeyAlpha } from './colorkey.js';
import { inflateStream } from './flate.js';
import { decodeJpeg, type JpegImage } from './jpeg.js';

/**
 * An image XObject (or inline image) decoded to straight-alpha RGBA.
 *
 * Its own module because THREE unrelated consumers want it and only one of them
 * is a renderer: `raster.ts` paints it, `redact.ts` inspects samples, and
 * `imagehref.ts` re-encodes it to PNG for the Markdown, HTML, DOCX, EPUB and
 * SVG exports. Reaching it through `raster.ts` would make every one of those
 * exports import the rasterizer -- the glyph outliner, the blend modes and
 * `std14data.ts`'s bundled font outlines -- to produce a picture.
 *
 * It holds the one owner of image TRANSPARENCY: `/SMask`, then a stencil
 * `/Mask` stream, then a colour-key `/Mask` array. Two decoders answering that
 * question differently is how the same document comes to render opaque in one
 * export and masked in another, which is exactly what it did before `2pgr`.
 */
export interface ImageRgba { w: number; h: number; data: Uint8Array; }

// DCTDecode has its own branch below; JPXDecode and JBIG2Decode flow through the
// generic sample path (Image.Decode returns 8-bit / 1-bit samples respectively).
export const NO_RASTER_DECODER = new Set(['DCTDecode', 'DCT']);

export function resolveNum(doc: Document, o: PdfObject | undefined, dflt: number): number {
  const v = doc.resolve(o);
  return typeof v === 'number' ? v : dflt;
}
export function localDeviceGray(): ColorConverter {
  return { components: 1, toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; }, initial: () => [0, 0, 0] };
}
export function isIndexedCs(doc: Document, csObj: PdfObject | undefined): boolean {
  const r0 = doc.resolve(csObj);
  if (Array.isArray(r0) && r0.length) {
    const h = doc.resolve(r0[0]);
    return typeof h === 'object' && h !== null && (h as { kind?: string }).kind === 'name'
      && ((h as { name: string }).name === 'Indexed' || (h as { name: string }).name === 'I');
  }
  return false;
}

/** Decode an /SMask soft-mask stream to per-pixel alpha (0..255) resampled onto the
 *  `w`×`h` base-image grid (nearest). Handles 8-bit Flate/LZW grayscale masks and
 *  DCT-encoded (baseline/progressive) grayscale masks. Returns undefined when
 *  absent/undecodable. */
function decodeSMaskAlpha(doc: Document, dict: PdfDict, w: number, h: number): Uint8Array | undefined {
  const sm = doc.resolve(dict.get('SMask'));
  if (!isStream(sm)) return undefined;
  const info = new ImageInfo(doc, '', sm);
  const sw = info.Width, sh = info.Height;
  if (!sw || !sh) return undefined;

  // Source alpha: one byte per pixel, row-major over `gw`×`gh`.
  let src: Uint8Array;
  let gw = sw, gh = sh;
  const filt = info.Filter ?? '';
  if (filt === 'DCTDecode' || filt === 'DCT') {
    let dec: JpegImage;
    try { dec = decodeJpeg(info.Decode()); } catch { return undefined; } // progressive/arith/malformed → degrade
    gw = dec.width; gh = dec.height;
    const nc = dec.comps;
    if (nc === 1) src = dec.data;
    else { src = new Uint8Array(gw * gh); for (let i = 0; i < src.length; i++) src[i] = dec.data[i * nc]; }
  } else {
    if (NO_RASTER_DECODER.has(filt)) return undefined;
    if ((resolveNum(doc, sm.dict.get('BitsPerComponent'), 8)) !== 8) return undefined;
    try { src = info.Decode(); } catch { return undefined; }
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(gh - 1, (y * gh / h) | 0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(gw - 1, (x * gw / w) | 0);
      out[y * w + x] = src[sy * gw + sx] ?? 255;
    }
  }
  return out;
}

/**
 * Decode a stencil-mask `/Mask` STREAM to per-pixel alpha (0 masked, 255
 * painted), resampled onto the `w`×`h` base grid (nearest), or undefined when
 * absent or undecodable.
 *
 * 32000-1 8.9.6.4's other form of the same entry. Its polarity is
 * `/ImageMask`'s: under the default `/Decode [0 1]` a sample of 0 PAINTS, and
 * `/Decode [1 0]` flips that — so it is read here exactly as the `/ImageMask`
 * branch below reads its own. Ignoring the `/Decode` renders the precise
 * negative of the intended transparency, which reads as deliberate rather than
 * broken.
 */
function decodeStencilMaskAlpha(
  doc: Document, dict: PdfDict, w: number, h: number,
): Uint8Array | undefined {
  const mk = doc.resolve(dict.get('Mask'));
  if (!isStream(mk)) return undefined;
  const info = new ImageInfo(doc, '', mk);
  const mw = info.Width, mh = info.Height;
  if (!mw || !mh) return undefined;
  let bits: Uint8Array;
  try { bits = info.Decode(); } catch { return undefined; } // JBIG2/CCITT/malformed → degrade
  const rowBytes = (mw + 7) >> 3;
  if (bits.length < rowBytes * mh) return undefined;

  const dec = arrNums(doc, mk.dict.get('Decode'));
  const invert = dec.length >= 2 && dec[0] === 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, (y * mh / h) | 0);
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, (x * mw / w) | 0);
      const bit = (bits[sy * rowBytes + (sx >> 3)] >> (7 - (sx & 7))) & 1;
      out[y * w + x] = ((bit === 1) !== invert) ? 0 : 255;
    }
  }
  return out;
}

/**
 * Per-pixel alpha for a colour-key `/Mask` ARRAY, or undefined when there is
 * none (or it states too few bounds for the sample stride).
 *
 * `comps` is the SAMPLE stride, not the colour space's component count: an
 * Indexed image stores one index per pixel while its base space has three or
 * four. The rule itself lives in `colorkey.ts`, shared with `colorimage.ts`, so
 * a converted document cannot mask differently from the original.
 */
function colorKeyAlphaFor(
  doc: Document, dict: PdfDict, samples: Uint8Array, pixels: number, comps: number,
): Uint8Array | undefined {
  const m = doc.resolve(dict.get('Mask'));
  if (!isArray(m)) return undefined;
  const ranges = m.map((v) => doc.resolve(v)).filter((v): v is number => typeof v === 'number');
  if (ranges.length < comps * 2) return undefined;
  return colorKeyAlpha(samples, pixels, comps, ranges);
}

/** Decode an image XObject (or inline image) to RGBA. Handles Flate/LZW/CCITT
 *  sample data, 8-bit Device/Indexed/ICC colorspaces, 1-bit /ImageMask stencils
 *  (painted in `fill`), and /SMask alpha. JPXDecode (JPEG 2000) and JBIG2Decode
 *  decode to samples via the generic path. Returns undefined when undecodable
 *  (JPEG has a dedicated branch above, or unusual bit depths). */
export function decodeImageRgba(doc: Document, stream: PdfStream, fill: Rgb): ImageRgba | undefined {
  const info = new ImageInfo(doc, '', stream);
  const w = info.Width, h = info.Height;
  if (!w || !h || w * h > 64 * 1024 * 1024) return undefined;

  const filt = info.Filter;
  if (filt === 'DCTDecode' || filt === 'DCT') {
    let dec: JpegImage;
    try { dec = decodeJpeg(info.Decode()); } catch { return undefined; } // progressive/arith/malformed → degrade
    const { width: jw, height: jh, comps, data: s } = dec;
    // /SMask, then either form of /Mask. The two /Mask forms are one entry so
    // only one can be present; /SMask outranks both, being the richer mask and
    // mutually exclusive with /Mask per 32000-1 anyway.
    const alpha = decodeSMaskAlpha(doc, stream.dict, jw, jh)
      ?? decodeStencilMaskAlpha(doc, stream.dict, jw, jh)
      ?? colorKeyAlphaFor(doc, stream.dict, s, jw * jh, comps);
    const out = new Uint8Array(jw * jh * 4);
    for (let i = 0; i < jw * jh; i++) {
      let r: number, g: number, b: number;
      if (comps === 1) { r = g = b = s[i]; }
      else if (comps === 3) { r = s[i * 3]; g = s[i * 3 + 1]; b = s[i * 3 + 2]; }
      else { // 4-component CMYK → RGB (naive)
        const c = s[i * 4], m = s[i * 4 + 1], y = s[i * 4 + 2], k = s[i * 4 + 3];
        r = ((255 - c) * (255 - k)) / 255; g = ((255 - m) * (255 - k)) / 255; b = ((255 - y) * (255 - k)) / 255;
      }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = alpha ? alpha[i] : 255;
    }
    return { w: jw, h: jh, data: out };
  }

  if (NO_RASTER_DECODER.has(info.Filter ?? '')) return undefined;
  let samples: Uint8Array;
  try { samples = info.Decode(); } catch { return undefined; }

  const dict = stream.dict;
  const data = new Uint8Array(w * h * 4);

  if (doc.resolve(dict.get('ImageMask')) === true) {
    const dec = arrNums(doc, dict.get('Decode'));
    const invert = dec.length >= 2 && dec[0] === 1;     // /Decode [1 0] flips the paint sense
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (samples[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const paint = (bit === 0) !== invert;           // default [0 1]: sample 0 paints
        const i = (y * w + x) * 4;
        data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = paint ? 255 : 0;
      }
    return { w, h, data };
  }

  if (resolveNum(doc, dict.get('BitsPerComponent'), 8) !== 8) return undefined;
  const csObj = dict.get('ColorSpace');
  const indexed = isIndexedCs(doc, csObj);
  const cs = csObj !== undefined
    ? resolveColorSpace(csObj, (o) => doc.resolve(o), (s) => inflateStream(s as Parameters<typeof inflateStream>[0]))
    : localDeviceGray();
  const nc = cs.components;
  // `nc` is the SAMPLE stride here, Indexed included: resolveColorSpace reports
  // ONE component for an Indexed space, whatever its base has. (The `indexed`
  // flag below is about SCALING -- a raw index rather than a 0..1 fraction --
  // not about stride.)
  const alpha = decodeSMaskAlpha(doc, dict, w, h)
    ?? decodeStencilMaskAlpha(doc, dict, w, h)
    ?? colorKeyAlphaFor(doc, dict, samples, w * h, nc);
  for (let i = 0; i < w * h; i++) {
    let out: Rgb;
    if (indexed) out = cs.toRgb([samples[i] ?? 0]);
    else { const comps: number[] = []; for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / 255); out = cs.toRgb(comps); }
    data[i * 4] = out[0]; data[i * 4 + 1] = out[1]; data[i * 4 + 2] = out[2];
    data[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return { w, h, data };
}

