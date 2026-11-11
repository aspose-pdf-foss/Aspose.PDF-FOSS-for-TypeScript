import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, PdfStream, isStream, name, ref } from '../src/types.js';
import { decodeImageStream } from '../src/imagedecode.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError, UnsupportedFeatureError } from '../src/errors.js';
import { encodeStream } from '../src/filters.js';
import { buildBilevelDoc } from './helpers/build-bilevelopt-pdf.js';
import { buildSignedGrayscalePdf } from './helpers/build-grayscale-pdf.js';
import { buildTwinImagePdf } from './helpers/build-imageopt-pdf.js';

const only = { fonts: false, dedup: false, compress: false, dr: false, jbig2: true };
function image(doc: Document, n: number): PdfStream {
  const s = doc.resolve(ref(n));
  if (!isStream(s)) throw new Error('expected an image');
  return s;
}
function equalPixels(actual: Uint8Array, expected: Uint8Array, w: number, h: number): void {
  const stride = Math.ceil(w / 8);
  expect(actual.length).toBe(expected.length);
  const a = actual.slice(), b = expected.slice();
  if (w % 8) for (let y = 0; y < h; y++) {
    a[(y + 1) * stride - 1] &= 0xff << (8 - w % 8);
    b[(y + 1) * stride - 1] &= 0xff << (8 - w % 8);
  }
  expect(Buffer.compare(a, b)).toBe(0);
}

describe('Optimize lossless JBIG2', () => {
  it.each([false, true])('rewrites a bilevel image in place (Flate=%s) and accounts once', (flate) => {
    const { doc, nums, samples } = buildBilevelDoc({ flate });
    const before = image(doc, nums[0]), raw = before.raw.slice();
    const result = doc.Optimize(only), after = image(doc, nums[0]);
    expect(after.dict.get('Filter')).toEqual(name('JBIG2Decode'));
    equalPixels(decodeImageStream(doc, after), samples, 513, 128);
    expect(before.raw).toEqual(raw);
    expect(result.jbig2.images).toEqual([{
      objNum: nums[0], width: 513, height: 128, originalWidth: 513, originalHeight: 128,
      bytesSaved: raw.length - after.raw.length,
    }]);
    expect(result.bytesSaved).toBe(result.jbig2.bytesSaved);
    expect(result.jbig2.bytesSaved).toBeGreaterThan(0);
    expect(result.lossy).toBe(false);
    expect(result.images).toEqual([]);
    const reopened = Document.Open(doc.Save());
    equalPixels(reopened.Pages[0].Images[0].Decode(), samples, 513, 128);
  });

  it.each([undefined, false])('is disabled with jbig2=%s and reports an empty concern', (jbig2) => {
    const { doc, nums } = buildBilevelDoc();
    const original = image(doc, nums[0]);
    const result = doc.Optimize({ ...only, jbig2 });
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2).toEqual({ images: [], skippedImages: [], bytesSaved: 0 });
  });

  it.each(['LZWDecode', 'RunLengthDecode', 'ASCIIHexDecode', 'ASCII85Decode'] as const)('accepts byte filter %s', (filter) => {
    const { doc, nums, samples } = buildBilevelDoc();
    const original = image(doc, nums[0]);
    doc.replaceObject(nums[0], encodeStream(samples, filter, original.dict));
    const result = doc.Optimize(only);
    expect(result.jbig2.images).toHaveLength(1);
    equalPixels(decodeImageStream(doc, image(doc, nums[0])), samples, 513, 128);
  });

  it('decodes PNG predictors and removes their parameters after replacement', () => {
    const { doc, nums, samples } = buildBilevelDoc();
    const original = image(doc, nums[0]), stride = 65;
    const predicted = new Uint8Array((stride + 1) * 128);
    for (let y = 0; y < 128; y++) predicted.set(samples.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    const raw = new Uint8Array(deflateSync(predicted, { level: 0 }));
    original.dict.set('Filter', [name('FlateDecode')]);
    original.dict.set('DecodeParms', [new Map<string, PdfObject>([['Predictor', 15], ['Colors', 1], ['Columns', 513], ['BitsPerComponent', 1]])]);
    original.dict.set('DP', new Map([['Predictor', 15]]));
    doc.replaceObject(nums[0], { ...original, raw });
    expect(doc.Optimize(only).jbig2.images).toHaveLength(1);
    const after = image(doc, nums[0]);
    expect(after.dict.has('DecodeParms')).toBe(false);
    expect(after.dict.has('DP')).toBe(false);
    equalPixels(decodeImageStream(doc, after), samples, 513, 128);
  });

  it('preserves stencil rendering and Decode without converting sample sense', () => {
    const { doc, nums } = buildBilevelDoc({ stencil: true });
    const original = image(doc, nums[0]);
    original.dict.delete('BitsPerComponent');
    original.dict.set('Decode', [1, 0]);
    const before = doc.Pages[0].ToImage();
    expect(doc.Optimize(only).jbig2.images).toHaveLength(1);
    const after = image(doc, nums[0]);
    expect(after.dict.get('ImageMask')).toBe(true);
    expect(after.dict.get('Decode')).toEqual([1, 0]);
    expect(after.dict.has('ColorSpace')).toBe(false);
    expect(doc.Pages[0].ToImage()).toEqual(before);
    expect(Document.Open(doc.Save()).Pages[0].ToImage()).toEqual(before);
  });

  it('preserves every unrelated dictionary entry, including transparency and metadata', () => {
    const { doc, nums } = buildBilevelDoc();
    const original = image(doc, nums[0]);
    const extras: PdfDict = new Map<string, PdfObject>([
      ['Decode', [1, 0]], ['Mask', [0, 0]], ['Intent', name('RelativeColorimetric')],
      ['Interpolate', true], ['OC', doc.allocObject(new Map([['Type', name('OCG')]]))],
      ['Metadata', doc.allocObject(new Map([['Producer', name('test')]]))],
      ['SMask', doc.allocObject({ kind: 'stream', dict: new Map<string, PdfObject>([
        ['Subtype', name('Image')], ['Width', 513], ['Height', 128],
        ['ColorSpace', name('DeviceGray')], ['BitsPerComponent', 8],
      ]), raw: new Uint8Array(513 * 128).fill(255) })],
    ]);
    for (const [key, value] of extras) original.dict.set(key, value);
    expect(doc.Optimize(only).jbig2.images).toHaveLength(1);
    const after = image(doc, nums[0]);
    for (const [key, value] of original.dict) {
      if (!['Filter', 'DecodeParms', 'DP', 'Length'].includes(key)) expect(after.dict.get(key)).toEqual(value);
    }
  });

  it('retains a tiny image when the complete JBIG2 stream would be larger', () => {
    const { doc, nums } = buildBilevelDoc({ width: 1, height: 1 });
    const original = image(doc, nums[0]), result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2.images).toEqual([]);
    expect(result.jbig2.skippedImages[0].reason).toMatch(/smaller/);
  });

  it.each(['CCITTFaxDecode', 'JBIG2Decode', 'DCTDecode', 'JPXDecode'])('leaves existing codec %s untouched', (filter) => {
    const { doc, nums } = buildBilevelDoc(), original = image(doc, nums[0]);
    original.dict.set('Filter', name(filter));
    const result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2.skippedImages[0].reason).toMatch(/filter/i);
  });

  it.each(['color', 'external', 'fractional', 'nan', 'truncated', 'broken-filter'])('declines %s inputs without replacing them', (kind) => {
    const { doc, nums } = buildBilevelDoc(), original = image(doc, nums[0]);
    if (kind === 'color') original.dict.set('ColorSpace', name('DeviceRGB'));
    if (kind === 'external') original.dict.set('F', new Map([['Type', name('Filespec')]]));
    if (kind === 'fractional') original.dict.set('Width', 1.5);
    if (kind === 'nan') original.dict.set('Height', NaN);
    if (kind === 'truncated') original.dict.set('Height', 129);
    if (kind === 'broken-filter') original.dict.set('Filter', name('FlateDecode'));
    const result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2.images).toEqual([]);
    expect(result.jbig2.skippedImages).toHaveLength(1);
  });

  it('declines documents declaring PDF/A-1', () => {
    const { doc, nums } = buildBilevelDoc(), original = image(doc, nums[0]);
    doc.SetXmp({ pdfaPart: 1 });
    const result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2.skippedImages[0].reason).toMatch(/PDF\/A-1/);
  });

  it.each(['attribute', 'element', 'entity'])('recognizes alternate-prefix PDF/A-1 identification (%s)', (shape) => {
    const { doc, nums } = buildBilevelDoc(), original = image(doc, nums[0]);
    const attr = shape === 'attribute' ? ' archive:part="1"' : '';
    const value = shape === 'entity' ? '&#49;' : '1';
    const body = shape === 'attribute' ? '' : `<archive:part>${value}</archive:part>`;
    const raw = new TextEncoder().encode(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
      + `<rdf:Description xmlns:archive="http://www.aiim.org/pdfa/ns/id/"${attr}>${body}</rdf:Description></rdf:RDF>`);
    doc.catalog().set('Metadata', doc.allocObject({ kind: 'stream',
      dict: new Map([['Type', name('Metadata')], ['Subtype', name('XML')]]), raw }));
    const result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(original);
    expect(result.jbig2.images).toHaveLength(0);
    expect(result.jbig2.skippedImages[0].reason).toMatch(/PDF\/A-1/);
  });

  it.each([false, true])('declines packed TIFF predictor samples (indirect=%s)', (indirect) => {
    const { doc, nums } = buildBilevelDoc({ width: 512 }), original = image(doc, nums[0]);
    // A white row has one leading 1 followed by 511 zero horizontal deltas.
    // The existing TIFF decoder incorrectly reconstructs bytes (80 80 ...),
    // so this pass must not bake that result into a new image codec.
    const deltas = new Uint8Array(64 * 128);
    for (let y = 0; y < 128; y++) deltas[y * 64] = 0x80;
    const raw = new Uint8Array(deflateSync(deltas, { level: 0 }));
    const parms: PdfDict = new Map<string, PdfObject>([
      ['Predictor', indirect ? doc.allocObject(2) : 2], ['Columns', 512], ['Colors', 1], ['BitsPerComponent', 1],
    ]);
    original.dict.set('Filter', indirect ? [doc.allocObject(name('FlateDecode'))] : name('FlateDecode'));
    original.dict.set(indirect ? 'DecodeParms' : 'DP', indirect ? [doc.allocObject(parms)] : parms);
    const stream = { ...original, raw }; doc.replaceObject(nums[0], stream);
    const result = doc.Optimize(only);
    expect(image(doc, nums[0])).toBe(stream);
    expect(result.jbig2.images).toHaveLength(0);
    expect(result.jbig2.skippedImages[0].reason).toMatch(/TIFF predictor/);
  });

  it('raises an explicit catalog version below 1.4 only when replacing an image', () => {
    const { doc } = buildBilevelDoc();
    doc.catalog().set('Version', name('1.3'));
    doc.Optimize(only);
    expect(doc.catalog().get('Version')).toEqual(name('1.4'));
    const { doc: tiny } = buildBilevelDoc({ width: 1, height: 1 });
    tiny.catalog().set('Version', name('1.3')); tiny.Optimize(only);
    expect(tiny.catalog().get('Version')).toEqual(name('1.3'));
  });

  it('propagates image-pixel policy refusals', () => {
    const { doc } = buildBilevelDoc();
    const reopened = Document.Open(doc.Save(), { limits: LoadLimits.defaults.with({ maxImagePixels: 10 }) });
    expect(() => reopened.Optimize(only)).toThrow(ResourceLimitError);
  });

  it('handles all refs to a shared image, even without a measurable placement', () => {
    const { doc, nums } = buildBilevelDoc();
    const xo = new Map<string, PdfObject>([['Im0', ref(nums[0])], ['Alias', ref(nums[0])]]);
    doc.Pages[0].Dict.set('Resources', new Map([['XObject', xo]]));
    // Keep the reference but remove the invocation; sample-preserving coding needs no DPI.
    doc.Pages[0].Dict.delete('Contents');
    expect(doc.Optimize(only).jbig2.images).toHaveLength(1);
    expect(doc.Pages[0].Images[0].Filter).toBe('JBIG2Decode');
    expect(doc.resolve(xo.get('Im0'))).toBe(doc.resolve(xo.get('Alias')));
  });

  it('checks pre-abort before replacing an image', async () => {
    const { doc, nums } = buildBilevelDoc(), original = image(doc, nums[0]);
    const reason = new Error('pre-abort');
    expect(() => doc.Optimize({ ...only, signal: AbortSignal.abort(reason) })).toThrow(reason);
    await expect(doc.OptimizeAsync({ ...only, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(image(doc, nums[0])).toBe(original);
  });

  it('does not disturb the existing JPEG concern or lossy flag', () => {
    const { doc: source, nums } = buildBilevelDoc();
    const doc = Document.Open(buildTwinImagePdf().bytes);
    doc.allocObject(image(source, nums[0]));
    const result = doc.Optimize({ ...only, images: { quality: 30 } });
    expect(result.jbig2.images).toHaveLength(1);
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.lossy).toBe(true);
    expect(result.bytesSaved).toBe(result.jbig2.bytesSaved + result.images.reduce((n, i) => n + i.bytesSaved, 0));
  });

  it('shares sync/async output and yields after each image with the outer operation name', async () => {
    const { doc } = buildBilevelDoc({ count: 2 }), bytes = doc.Save();
    const sync = Document.Open(bytes), asyncDoc = Document.Open(bytes), phases: string[] = [];
    const expected = sync.Optimize(only);
    const actual = await asyncDoc.OptimizeAsync({ ...only, onProgress: (e) => {
      expect(e.operation).toBe('Optimize'); if (e.phase) phases.push(e.phase);
    } });
    expect(actual).toEqual(expected);
    expect(asyncDoc.Save()).toEqual(sync.Save());
    expect(phases.filter((p) => p === 'jbig2')).toHaveLength(2);
  });

  it('cancels between images with coherent partial replacements', async () => {
    const { doc, nums } = buildBilevelDoc({ count: 2 });
    const controller = new AbortController(), reason = new Error('stop between images');
    await expect(doc.OptimizeAsync({ ...only, signal: controller.signal, onProgress: (e) => {
      if (e.phase === 'jbig2') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(image(doc, nums[0]).dict.get('Filter')).toEqual(name('JBIG2Decode'));
    expect(image(doc, nums[1]).dict.has('Filter')).toBe(false);
    expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
  });

  it('retains the signed-document refusal', () => {
    expect(() => Document.Open(buildSignedGrayscalePdf()).Optimize(only)).toThrow(UnsupportedFeatureError);
  });
});
