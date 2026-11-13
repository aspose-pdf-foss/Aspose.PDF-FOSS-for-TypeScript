// Sample-preserving image optimization. Unlike JPEG downsampling, no placement
// measurement is needed: every reference to an image retains the same pixels.
import type { Document } from './document.js';
import type { OperationContext, OperationSteps } from './operation.js';
import type { ImageOptimization, SkippedImage } from './imageopt.js';
import { PdfDict, isArray, isName, isStream, name } from './types.js';
import { decodeImageStream } from './imagedecode.js';
import { encodeJbig2 } from './jbig2encode.js';
import { rethrowLimit } from './errors.js';

export interface BilevelOptimizationResult {
  images: ImageOptimization[];
  skippedImages: SkippedImage[];
  bytesSaved: number;
}

const BYTE_FILTERS = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
  'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85',
]);

function guard(doc: Document, dict: PdfDict): string | undefined {
  if (dict.has('F')) return 'external image stream';
  const stencil = doc.resolve(dict.get('ImageMask')) === true;
  const bpc = doc.resolve(dict.get('BitsPerComponent'));
  if (bpc !== 1 && !(stencil && !dict.has('BitsPerComponent'))) return 'image is not 1 bit per component';
  if (!stencil) {
    const cs = doc.resolve(dict.get('ColorSpace'));
    if (!isName(cs) || cs.name !== 'DeviceGray') return 'colorspace is not DeviceGray';
  }
  const f = doc.resolve(dict.get('Filter'));
  if (dict.has('Filter')) {
    const filters = isArray(f) ? f.map((v) => doc.resolve(v)) : [f];
    for (const filter of filters) {
      if (!isName(filter) || !BYTE_FILTERS.has(filter.name))
        return `unsupported filter ${isName(filter) ? filter.name : '(invalid)'}`;
    }
  }
  return undefined;
}

/** @internal One image is an atomic unit, matching the JPEG optimization pass. */
export function* optimizeBilevelImagesSteps(
  doc: Document, context: OperationContext,
): OperationSteps<BilevelOptimizationResult> {
  const result: BilevelOptimizationResult = { images: [], skippedImages: [], bytesSaved: 0 };
  // Prefixes are arbitrary in XML. Retain the lenient legacy reader as a
  // conservative fallback for damaged packets it can still identify.
  const pdfa1 = doc.GetXmpValue('http://www.aiim.org/pdfa/ns/id/', 'part')?.asInt() === 1
    || doc.GetXmp().pdfaPart === 1;
  const candidates = [...doc.objectEntries()].filter(([, obj]) => {
    if (!isStream(obj)) return false;
    const subtype = doc.resolve(obj.dict.get('Subtype'));
    return isName(subtype) && subtype.name === 'Image'
      && (doc.resolve(obj.dict.get('BitsPerComponent')) === 1 || doc.resolve(obj.dict.get('ImageMask')) === true);
  });
  let completed = 0;
  for (const [r, stream] of candidates) {
    imageUnit: {
      if (!isStream(stream)) break imageUnit;
      const skip = (reason: string) => result.skippedImages.push({ objNum: r.num, reason });
      if (pdfa1) { skip('document declares PDF/A-1, which prohibits JBIG2'); break imageUnit; }
      const reason = guard(doc, stream.dict);
      if (reason) { skip(reason); break imageUnit; }
      const w = doc.resolve(stream.dict.get('Width')), h = doc.resolve(stream.dict.get('Height'));
      if (typeof w !== 'number' || typeof h !== 'number'
        || ![w, h].every((v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff)
        || !Number.isSafeInteger(w * h)) {
        skip('missing or invalid /Width or /Height'); break imageUnit;
      }
      // Before decoding or allocating; a policy refusal is never a skip.
      doc.loadLimits.enforce('maxImagePixels', w * h, 'JBIG2 optimization');
      let samples: Uint8Array;
      try { samples = decodeImageStream(doc, stream); }
      catch (e) { rethrowLimit(e); skip(`decode failed: ${(e as Error).message}`); break imageUnit; }
      if (samples.length !== Math.ceil(w / 8) * h) {
        skip('decoded sample length disagrees with image dimensions'); break imageUnit;
      }
      const raw = encodeJbig2(w, h, samples, doc.loadLimits);
      const bytesSaved = stream.raw.length - raw.length;
      if (bytesSaved <= 0) { skip('JBIG2 image would not be smaller'); break imageUnit; }
      const dict: PdfDict = new Map(stream.dict);
      dict.delete('DecodeParms'); dict.delete('DP');
      dict.set('Filter', name('JBIG2Decode')); dict.set('Length', raw.length);
      doc.replaceObject(r.num, { kind: 'stream', dict, raw });
      // Save uses the catalog version when present. Do not write a new codec
      // under a caller's explicit pre-JBIG2 version (PDF 1.4 introduced it).
      if (/^1\.[0-3]$/.test(doc.headerVersion() ?? '')) doc.catalog().set('Version', name('1.4'));
      result.images.push({ objNum: r.num, width: w, height: h, originalWidth: w, originalHeight: h, bytesSaved });
      result.bytesSaved += bytesSaved;
    }
    yield context.progress('jbig2', ++completed, candidates.length);
  }
  return result;
}
