import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isName, isArray, isStream, name,
} from './types.js';
import { ImageInfo } from './image.js';
import { decodeJpeg } from './jpeg.js';
import { encodeJpeg, JpegKind } from './jpegencode.js';
import { resampleBox } from './resample.js';
import { collectImageUsage } from './imageusage.js';

/** Target for the lossy image pass. Presence in OptimizeOptions is the opt-in.
 *  Named for the concern, not the subject: `ImageOptions` is already taken by
 *  raster.ts, where it means the render options for ToImage(). */
export interface OptimizeImageOptions {
  /** Target DPI. Omit to recompress without downsampling. Never upsamples. */
  dpi?: number;
  /** IJG scale 1..100. Default 75. */
  quality?: number;
}

export interface ImageOptimization {
  /** Object number of the image stream — the one stable identifier. */
  objNum: number;
  /** Resource key of a placement (e.g. 'Im0'); diagnostic only. */
  name?: string;
  width: number; height: number;
  originalWidth: number; originalHeight: number;
  bytesSaved: number;
}

export interface SkippedImage { objNum: number; name?: string; reason: string }

const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

/** Terminal (codec) filter of a chain: the last entry, or the single name. */
function terminalFilter(doc: Document, dict: PdfDict): string | undefined {
  const f = doc.resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) {
    const last = doc.resolve(f[f.length - 1]);
    if (isName(last)) return last.name;
  }
  return undefined;
}

/** Filters whose output ImageInfo.Decode() delivers as plain 8-bit samples. */
const SAMPLE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
]);
const DCT_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'DCT']);

function csHead(doc: Document, cs: PdfObject | undefined): string | undefined {
  const r = doc.resolve(cs);
  if (isName(r)) return r.name;
  if (isArray(r) && r.length > 0) {
    const h = doc.resolve(r[0]);
    if (isName(h)) return h.name;
  }
  return undefined;
}

/**
 * The JpegKind for a colorspace, or a reason it cannot be encoded.
 *
 * This picks how many components the samples carry and whether the encoder
 * applies the YCbCr transform. It says nothing about the output dict: the
 * original /ColorSpace is carried through untouched (see `rebuild`).
 */
function kindOf(doc: Document, cs: PdfObject | undefined): JpegKind | { reason: string } {
  const head = csHead(doc, cs);
  switch (head) {
    case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
    case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
    case 'DeviceCMYK': case 'CMYK': return 'cmyk';
    case 'Indexed': case 'I': return { reason: 'indexed (palette) colorspace' };
    case 'ICCBased': {
      const arr = doc.resolve(cs);
      const s = isArray(arr) ? doc.resolve(arr[1]) : undefined;
      const n = isStream(s) ? doc.resolve(s.dict.get('N')) : undefined;
      if (n === 1) return 'gray';
      if (n === 3) return 'rgb';
      if (n === 4) return 'cmyk';
      return { reason: `ICCBased with unsupported /N ${String(n)}` };
    }
    case undefined: return { reason: 'missing colorspace' };
    default: return { reason: `unsupported colorspace: ${head}` };
  }
}

/** A reason this image must not be recompressed, or undefined when it may be. */
function guard(doc: Document, dict: PdfDict): string | undefined {
  if (doc.resolve(dict.get('ImageMask')) === true) return 'image mask (bilevel stencil)';
  const bpc = doc.resolve(dict.get('BitsPerComponent'));
  if (bpc !== 8) return `BitsPerComponent ${String(bpc ?? '(absent)')} is not 8`;
  if (dict.has('Mask')) return 'has /Mask (stencil or colour-key masking)';
  if (dict.has('Decode')) return 'has /Decode (sample inversion the re-encode would not reproduce)';
  const f = terminalFilter(doc, dict);
  if (f !== undefined && !DCT_FILTERS.has(f) && !SAMPLE_FILTERS.has(f))
    return `unsupported filter ${f}`;
  return undefined;
}

/** Decoded interleaved 8-bit samples, or a reason they are unavailable. */
function samplesOf(
  doc: Document, img: ImageInfo, kind: JpegKind, w: number, h: number,
): Uint8Array | { reason: string } {
  const want = w * h * CHANNELS[kind];
  const f = terminalFilter(doc, img.Dict);
  try {
    if (f !== undefined && DCT_FILTERS.has(f)) {
      // Decode() is a *passthrough* for DCT: it unwraps any preceding filters
      // (e.g. [ASCII85Decode, DCTDecode]) and hands back the JPEG bytes, which
      // is exactly what decodeJpeg wants.
      const j = decodeJpeg(img.Decode());
      if (j.width !== w || j.height !== h)
        return { reason: `JPEG geometry ${j.width}x${j.height} disagrees with the dict ${w}x${h}` };
      if (j.comps !== CHANNELS[kind])
        return { reason: `JPEG has ${j.comps} components, colorspace implies ${CHANNELS[kind]}` };
      return j.data;
    }
    const bytes = img.Decode();
    if (bytes.length !== want)
      return { reason: `decoded ${bytes.length} bytes, expected ${want}` };
    return bytes;
  } catch (e) {
    return { reason: `decode failed: ${(e as Error).message}` };
  }
}

/**
 * The replacement dict: copy the original, then override only what changed.
 *
 * A denylist, not an allowlist. buildJpegXObject() synthesizes a dict from SOF
 * markers and knows only seven keys, so routing through it would silently drop
 * /SMask, /OC, /Intent and /Metadata — an image losing its /SMask renders its
 * transparent background black, with no error anywhere. Copy-then-override lets
 * an unanticipated key survive instead of vanishing.
 *
 * /ColorSpace and /BitsPerComponent are deliberately NOT rewritten: the
 * re-encode preserves the component count and emits 8-bit samples, so the
 * original colorspace object stays exactly as valid as it was. Replacing an
 * ICCBased colorspace with its device equivalent would discard the embedded
 * profile and shift every colour in the image.
 */
function rebuild(original: PdfStream, jpeg: Uint8Array, w: number, h: number): PdfStream {
  const dict: PdfDict = new Map(original.dict);
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.delete('Decode'); // the guard means the source had none
  dict.set('Width', w);
  dict.set('Height', h);
  dict.set('Filter', name('DCTDecode'));
  dict.set('Length', jpeg.length);
  return { kind: 'stream', dict, raw: jpeg };
}

/**
 * Recompress image XObjects to JPEG, downsampling to `opts.dpi`.
 *
 * LOSSY. Only reached when the caller passes `images` to Optimize.
 */
export function optimizeImages(
  doc: Document, opts: OptimizeImageOptions,
): { images: ImageOptimization[]; skippedImages: SkippedImage[] } {
  const images: ImageOptimization[] = [];
  const skippedImages: SkippedImage[] = [];
  const quality = opts.quality ?? 75;

  const usage = collectImageUsage(doc);
  const objNums = new Map<PdfStream, number>();
  for (const [r, obj] of doc.objectEntries()) if (isStream(obj)) objNums.set(obj, r.num);

  for (const [stream, u] of usage) {
    const objNum = objNums.get(stream);
    if (objNum === undefined) continue; // a direct stream has no referrers to fix
    const skip = (reason: string) => skippedImages.push({ objNum, name: u.name, reason });

    if (!u.complete) { skip(u.reason ?? 'usage could not be determined'); continue; }

    const g = guard(doc, stream.dict);
    if (g) { skip(g); continue; }

    const kind = kindOf(doc, stream.dict.get('ColorSpace'));
    if (typeof kind !== 'string') { skip(kind.reason); continue; }

    const w = doc.resolve(stream.dict.get('Width'));
    const h = doc.resolve(stream.dict.get('Height'));
    if (typeof w !== 'number' || typeof h !== 'number' || w < 1 || h < 1) {
      skip('missing or invalid /Width or /Height'); continue;
    }

    const src = samplesOf(doc, new ImageInfo(doc, u.name ?? '', stream), kind, w, h);
    if (!(src instanceof Uint8Array)) { skip(src.reason); continue; }

    // min(1, ...) is what makes "never upsample" true: an image already coarser
    // than the target is recompressed at quality but not resized.
    const scale = opts.dpi !== undefined && u.maxDpi > 0
      ? Math.min(1, opts.dpi / u.maxDpi) : 1;
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));

    let jpeg: Uint8Array;
    try {
      const resized = resampleBox(src, w, h, CHANNELS[kind], dw, dh);
      jpeg = encodeJpeg(dw, dh, resized, kind, { quality });
    } catch (e) {
      skip(`re-encode failed: ${(e as Error).message}`); continue;
    }

    const bytesSaved = stream.raw.length - jpeg.length;
    if (bytesSaved <= 0) { skip('re-encoded image would not be smaller'); continue; }

    // Install at the SAME object number: every /XObject resource dict points at
    // the image by ref, and PdfStream.raw is readonly, so this is the only way
    // to rewrite a shared stream without repointing each referrer.
    doc.replaceObject(objNum, rebuild(stream, jpeg, dw, dh));
    images.push({
      objNum, name: u.name,
      width: dw, height: dh, originalWidth: w, originalHeight: h,
      bytesSaved,
    });
  }
  return { images, skippedImages };
}
