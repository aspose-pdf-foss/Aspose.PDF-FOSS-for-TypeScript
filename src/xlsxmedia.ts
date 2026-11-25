import type { Document } from './document.js';
import { rethrowLimit } from './errors.js';
import { buildJpegXObject } from './imageembed.js';
import { encodeImage, imageKey, type EncodedImage } from './imagehref.js';
import { filterName, numOf } from './imagedecode.js';
import { isStream, type PdfStream } from './types.js';

type Result = EncodedImage | 'image-limit' | 'unsupported-image';

function limit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be a nonnegative safe integer');
  return value;
}

/** Check the base and mask before the encoder sees either. For DCT passthrough
 * the JPEG frame determines what a workbook reader will allocate. */
function pixels(doc: Document, stream: PdfStream): number | undefined {
  const w = numOf(doc, stream.dict, 'Width', 0), h = numOf(doc, stream.dict, 'Height', 0);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) return undefined;
  doc.loadLimits.enforce('maxImagePixels', w * h, 'XLSX image');
  const filter = filterName(doc, stream.dict);
  if (filter === 'DCTDecode' || filter === 'DCT') {
    try {
      const jpeg = buildJpegXObject(stream.raw).stream.dict;
      const actual = Number(jpeg.get('Width')) * Number(jpeg.get('Height'));
      doc.loadLimits.enforce('maxImagePixels', actual, 'XLSX JPEG frame');
      if (jpeg.get('Width') !== w || jpeg.get('Height') !== h) return undefined;
    } catch (caught) { rethrowLimit(caught); return undefined; }
  } else if (filter && !['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
    'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85'].includes(filter)) return undefined;
  return w * h;
}

/** Bounds apply across the selected workbook, including distinct streams whose
 * encoded bytes ultimately deduplicate. A rejected stream is inspected once. */
export function workbookImages(doc: Document, pixelLimit?: number, byteLimit?: number) {
  const maxPixels = limit(pixelLimit, 8 * 1024 * 1024, 'maxImagePixels');
  const maxBytes = limit(byteLimit, 32 * 1024 * 1024, 'maxImageBytes');
  const cache = new WeakMap<PdfStream, Result>();
  const media = new Map<string, EncodedImage>();
  let remainingPixels = 64 * 1024 * 1024, remainingBytes = maxBytes;
  let placements = 0;
  function encode(stream: PdfStream): Result {
    if (!maxBytes || !maxPixels) return 'image-limit';
    if (doc.resolve(stream.dict.get('ImageMask')) === true) return 'unsupported-image';
    let area = 0;
    // The RGBA decoder may fall back to /Mask when /SMask is unusable.
    const inputs = new Set([stream]);
    for (const key of ['SMask', 'Mask']) {
      const mask = doc.resolve(stream.dict.get(key));
      if (isStream(mask)) inputs.add(mask);
    }
    for (const input of inputs) {
      if (input.raw.length > 32 * 1024 * 1024) return 'image-limit';
      const count = pixels(doc, input);
      if (count === undefined) return 'unsupported-image';
      if (count > maxPixels) return 'image-limit';
      area += count;
    }
    if (area > remainingPixels) return 'image-limit';
    remainingPixels -= area;
    const image = encodeImage(doc, stream, [0, 0, 0]);
    if (!image) return 'unsupported-image';
    if (image.bytes.length > maxBytes) return 'image-limit';
    const key = imageKey(image.bytes, image.mediaType);
    const shared = media.get(key);
    if (shared) return shared;
    if (image.bytes.length > remainingBytes) return 'image-limit';
    remainingBytes -= image.bytes.length;
    media.set(key, image);
    return image;
  }
  return (stream: PdfStream): Result => {
    if (placements >= 4096) return 'image-limit';
    let result = cache.get(stream);
    if (result === undefined) {
      result = encode(stream);
      cache.set(stream, result);
    }
    if (typeof result !== 'string') placements++;
    return result;
  };
}
