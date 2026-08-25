/**
 * An inline image's abbreviated dict, normalized to image-XObject spelling.
 *
 * A leaf -- it imports nothing but `types.js` -- because four unrelated callers
 * need it and none of them should have to reach through the others: `redact.ts`
 * and `inlineimage.ts` edit inline images, and `pagerender.ts` draws them.
 * Until `6dud` the renderer built its own synthetic stream from the RAW dict
 * instead, so every inline image using the abbreviations 32000-1 Table 93
 * MANDATES decoded to nothing and drew nothing, in both `ToImage` and `ToSvg`.
 */
import { PdfDict, PdfObject, PdfStream, PdfName, name, isName, isArray } from './types.js';

/** Inline-image abbreviated dict keys → full image-XObject keys (PDF §8.9.7). */
const INLINE_KEY: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms',
  F: 'Filter', H: 'Height', IM: 'ImageMask', I: 'Interpolate', W: 'Width',
};
/** Abbreviated filter names usable in an inline image's /F (32000-1 Table 94).
 *  Expanded for the same reason the colorspace names below are: a caller
 *  reading `ImageInfo.Filter` off the converted stream compares it against the
 *  full spelling, and an inline image reporting `AHx` where an XObject reports
 *  `ASCIIHexDecode` makes one rule read as two. Decoding never needed this --
 *  filters.ts accepts both spellings -- so nothing downstream changes. */
const INLINE_FILTER: Record<string, string> = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

/** Expand an inline filter value: a name, or an array of them. */
function expandInlineFilter(v: PdfObject): PdfObject {
  if (isName(v)) return INLINE_FILTER[v.name] ? name(INLINE_FILTER[v.name]) : v;
  if (isArray(v)) return v.map((e) => (isName(e) && INLINE_FILTER[e.name] ? name(INLINE_FILTER[e.name]) : e));
  return v;
}

/** Abbreviated colorspace names usable in an inline image's /CS. */
const INLINE_CS: Record<string, string> = {
  G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed',
};

/** Expand an inline colorspace value: a device/indexed name to its full form,
 *  or an indexed array's head (and its base name) recursively. Anything else —
 *  including a bare non-device name (a /Resources colorspace reference) — passes
 *  through unchanged, so it stays unresolvable and the caller degrades. */
function expandInlineCs(v: PdfObject): PdfObject {
  if (isName(v)) return INLINE_CS[v.name] ? name(INLINE_CS[v.name]) : v;
  if (isArray(v) && v.length > 0 && isName(v[0]) && INLINE_CS[(v[0] as PdfName).name]) {
    const out = v.slice();
    out[0] = name(INLINE_CS[(v[0] as PdfName).name]);
    if (out.length > 1 && isName(out[1]) && INLINE_CS[(out[1] as PdfName).name])
      out[1] = name(INLINE_CS[(out[1] as PdfName).name]);
    return out;
  }
  return v;
}

/** Expand an inline image (abbreviated keys/colorspace names) into a synthetic
 *  full-key image XObject stream that the standard decoders accept. Filter names
 *  keep their abbreviations (applyDecodeFilters accepts both). /L and /Length are
 *  dropped (the synthetic stream's length is implicit). */
export function inlineImageToStream(inline: { dict: PdfDict; data: Uint8Array }): PdfStream {
  const dict = new Map<string, PdfObject>();
  for (const [k, v] of inline.dict) {
    if (k === 'L' || k === 'Length') continue;
    const full = INLINE_KEY[k] ?? k;
    dict.set(full, full === 'ColorSpace' ? expandInlineCs(v)
      : full === 'Filter' ? expandInlineFilter(v) : v);
  }
  return { kind: 'stream', dict, raw: inline.data };
}
