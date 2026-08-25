import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { optimizeImages } from '../src/imageopt.js';
import { isStream, isName, isArray, PdfStream } from '../src/types.js';
import { decodeJpeg } from '../src/jpeg.js';
import {
  buildSimpleImagePdf, buildSmaskPdf, buildCmykImagePdf,
} from './helpers/build-imageopt-pdf.js';

function streamAt(doc: Document, num: number): PdfStream {
  const o = doc.getObject(num);
  if (!isStream(o)) throw new Error(`object ${num} is not a stream`);
  return o;
}

describe('optimizeImages', () => {
  it('halves a 288-DPI image at a 144-DPI target', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf(); // 64px in a 16pt box
    const doc = Document.Open(bytes);
    const r = optimizeImages(doc, { dpi: 144 });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toMatchObject({
      objNum: imgObjNum, originalWidth: 64, originalHeight: 64, width: 32, height: 32,
    });
    const s = streamAt(doc, imgObjNum);
    expect(doc.resolve(s.dict.get('Width'))).toBe(32);
    expect(doc.resolve(s.dict.get('Height'))).toBe(32);
  });

  it('does not upsample when the target exceeds the actual DPI', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 600, quality: 20 });
    const s = streamAt(doc, imgObjNum);
    expect(doc.resolve(s.dict.get('Width'))).toBe(64);
    expect(doc.resolve(s.dict.get('Height'))).toBe(64);
  });

  it('replaces the stream in place so existing refs stay valid', () => {
    const { bytes } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 72 });
    // The page's /XObject /Im0 must still resolve to the (new) image.
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const xo = doc.resolve((res as Map<string, any>).get('XObject'));
    const im = doc.resolve((xo as Map<string, any>).get('Im0'));
    expect(isStream(im)).toBe(true);
    expect(doc.resolve((im as PdfStream).dict.get('Width'))).toBe(16);
  });

  it('keeps /SMask attached to the rewritten image, and never touches the mask', () => {
    const { bytes, imgObjNum, smaskObjNum } = buildSmaskPdf();
    const doc = Document.Open(bytes);
    const maskRawBefore = streamAt(doc, smaskObjNum).raw.slice();
    const r = optimizeImages(doc, { dpi: 72 });

    const s = streamAt(doc, imgObjNum);
    expect(s.dict.get('SMask')).toBeDefined();                              // survived
    expect([...streamAt(doc, smaskObjNum).raw]).toEqual([...maskRawBefore]); // untouched
    expect(r.skippedImages.some((x) => x.objNum === smaskObjNum)).toBe(true);
  });

  it('carries /OC and /Metadata through the rewrite', () => {
    // The denylist rebuild must preserve keys it knows nothing about.
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const ocRef = doc.allocObject(new Map<string, any>([['Type', { kind: 'name', name: 'OCG' }]]));
    const mdRef = doc.allocObject({ kind: 'stream' as const, dict: new Map<string, any>(), raw: new Uint8Array([60, 63]) });
    const d = streamAt(doc, imgObjNum).dict as Map<string, any>;
    d.set('OC', ocRef);
    d.set('Metadata', mdRef);

    optimizeImages(doc, { dpi: 144 });

    const after = streamAt(doc, imgObjNum).dict;
    expect(after.get('OC')).toEqual(ocRef);
    expect(after.get('Metadata')).toEqual(mdRef);
  });

  it('carries an ICCBased /ColorSpace by reference instead of flattening it', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    // Point the image at an ICCBased colorspace: [/ICCBased <stream /N 3>].
    const iccStream = { kind: 'stream' as const, dict: new Map<string, any>([['N', 3]]), raw: new Uint8Array([1, 2, 3]) };
    const iccRef = doc.allocObject(iccStream);
    const csRef = doc.allocObject([{ kind: 'name' as const, name: 'ICCBased' }, iccRef]);
    streamAt(doc, imgObjNum).dict.set('ColorSpace', csRef);

    optimizeImages(doc, { dpi: 144 });

    const cs = doc.resolve(streamAt(doc, imgObjNum).dict.get('ColorSpace'));
    expect(isArray(cs)).toBe(true);
    const head = doc.resolve((cs as any[])[0]);
    expect(isName(head) && head.name).toBe('ICCBased'); // NOT flattened to /DeviceRGB
  });

  it('emits a decodable JPEG at the new dimensions', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 144 });
    const img = decodeJpeg(streamAt(doc, imgObjNum).raw);
    expect(img.width).toBe(32);
    expect(img.height).toBe(32);
    expect(img.comps).toBe(3);
  });

  it('round-trips a CMYK image without adding a /Decode', () => {
    // encodeJpeg writes non-inverted CMYK with no APP14, so the output must
    // carry no /Decode inversion — and the colorspace stays DeviceCMYK.
    const { bytes, imgObjNum } = buildCmykImagePdf();
    const doc = Document.Open(bytes);
    const r = optimizeImages(doc, { dpi: 144 });

    expect(r.skippedImages).toEqual([]);
    const d = streamAt(doc, imgObjNum).dict;
    expect(d.has('Decode')).toBe(false);
    expect(isName(d.get('ColorSpace')) && (d.get('ColorSpace') as any).name).toBe('DeviceCMYK');
    expect(decodeJpeg(streamAt(doc, imgObjNum).raw).comps).toBe(4);
  });

  it('adds no /Decode and drops stale /DecodeParms', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    streamAt(doc, imgObjNum).dict.set('DecodeParms', new Map([['Predictor', 15]]));
    optimizeImages(doc, { dpi: 144 });
    const d = streamAt(doc, imgObjNum).dict;
    expect(d.has('Decode')).toBe(false);
    expect(d.has('DecodeParms')).toBe(false);
    expect(isName(d.get('Filter')) && (d.get('Filter') as any).name).toBe('DCTDecode');
  });

  it('leaves an image byte-identical when the re-encode would not be smaller', () => {
    // Already tiny and heavily compressed: a re-encode at q95 cannot win.
    const { bytes, imgObjNum } = buildSimpleImagePdf({ imgW: 8, imgH: 8, boxW: 8, boxH: 8 });
    const doc = Document.Open(bytes);
    const before = streamAt(doc, imgObjNum).raw.slice();
    const r = optimizeImages(doc, { quality: 95 });
    expect([...streamAt(doc, imgObjNum).raw]).toEqual([...before]);
    expect(r.images).toHaveLength(0);
    expect(r.skippedImages[0].reason).toMatch(/not be smaller/);
  });

  it.each([
    ['ImageMask', (d: Map<string, any>) => d.set('ImageMask', true), /image mask/],
    ['1-bpp', (d: Map<string, any>) => d.set('BitsPerComponent', 1), /BitsPerComponent/],
    ['/Decode', (d: Map<string, any>) => d.set('Decode', [1, 0, 1, 0, 1, 0]), /Decode/],
    ['/Mask', (d: Map<string, any>) => d.set('Mask', [0, 0]), /Mask/],
    ['Indexed', (d: Map<string, any>) =>
      d.set('ColorSpace', [{ kind: 'name', name: 'Indexed' }, { kind: 'name', name: 'DeviceRGB' }, 1, { kind: 'string', bytes: new Uint8Array(6) }]), /[Ii]ndexed/],
    ['Separation', (d: Map<string, any>) =>
      d.set('ColorSpace', [{ kind: 'name', name: 'Separation' }]), /[Ss]eparation|colorspace/],
  ])('skips %s with a reason', (_label, mutate, pattern) => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const before = streamAt(doc, imgObjNum).raw.slice();
    mutate(streamAt(doc, imgObjNum).dict as Map<string, any>);

    const r = optimizeImages(doc, { dpi: 72 });

    expect(r.images).toHaveLength(0);
    const skip = r.skippedImages.find((x) => x.objNum === imgObjNum);
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(pattern);
    expect([...streamAt(doc, imgObjNum).raw]).toEqual([...before]);
  });

  it('re-opens after Save with the image intact', () => {
    const { bytes } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    optimizeImages(doc, { dpi: 144 });
    const out = Document.Open(doc.Save());
    const imgs = out.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    expect(imgs[0].Width).toBe(32);
    expect(imgs[0].Filter).toBe('DCTDecode');
  });
});
