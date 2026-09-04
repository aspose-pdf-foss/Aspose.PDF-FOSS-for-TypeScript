import { describe, it, expect } from 'vitest';
import { convertImageSpace, grayscaleImage } from '../src/colorimage.js';
import { PdfDict, PdfObject, PdfStream, name } from '../src/types.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { decodeJpeg } from '../src/jpeg.js';
import { inflateSync } from 'node:zlib';

/** The flate route deflates its output, so read it back the way
 *  `grayimage.test.ts` does rather than asserting on `raw`. */
const samplesOf = (s: PdfStream): number[] => [...inflateSync(s.raw)];

const resolve = (o: PdfObject | undefined): PdfObject => o as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;

const img = (entries: [string, PdfObject][], raw: Uint8Array): PdfStream => ({
  kind: 'stream',
  dict: new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')], ...entries,
  ]) as PdfDict,
  raw,
});

const str = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });

/** Two pixels, red then blue, DeviceRGB, unfiltered. */
const rgbPair = () => img([
  ['Width', 2], ['Height', 1], ['BitsPerComponent', 8],
  ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
], new Uint8Array([255, 0, 0, 0, 0, 255]));

/**
 * `convertImageSpace` -- one image XObject retargeted (85l8.1).
 *
 * `grayimage.test.ts` covers the gray path unedited; this file covers what is
 * new. `grayscaleImage` remains its gray specialization.
 */
describe('convertImageSpace — the sample route', () => {
  it('writes four components per pixel for a cmyk target', () => {
    const r = convertImageSpace(rgbPair(), resolve, inflate, 'cmyk', {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('flate');
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceCMYK'));
    // red -> (0,1,1,0), blue -> (1,1,0,0), as 8-bit.
    expect(samplesOf(r.stream)).toEqual([0, 255, 255, 0, 255, 255, 0, 0]);
  });

  it('reports none when the image is already in the target space', () => {
    const s = img([
      ['Width', 2], ['Height', 1], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(6));
    expect(convertImageSpace(s, resolve, inflate, 'rgb', {}).kind).toBe('none');
  });

  it('converts a gray source up to cmyk', () => {
    const s = img([
      ['Width', 2], ['Height', 1], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceGray')], ['Filter', name('FlateDecode')],
    ], new Uint8Array([0, 255]));
    const r = convertImageSpace(s, resolve, inflate, 'cmyk', {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    // Black -> pure K, white -> no ink at all.
    expect(samplesOf(r.stream)).toEqual([0, 0, 0, 255, 0, 0, 0, 0]);
  });
});

describe('convertImageSpace — the Indexed palette route', () => {
  it('rewrites the lookup table to the target and leaves the samples alone', () => {
    const samples = new Uint8Array([0, 1, 2, 3]);
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, str(palette)]],
    ], samples);

    const r = convertImageSpace(s, resolve, inflate, 'cmyk', {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    expect(r.stream.raw).toEqual(samples);          // untouched, as for gray

    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect(cs[1]).toEqual(name('DeviceCMYK'));
    const lut = (cs[3] as { bytes: Uint8Array }).bytes;
    expect(lut).toHaveLength(4 * 4);                // 4 entries x 4 components
    // red, green, blue, white.
    expect([...lut]).toEqual([
      0, 255, 255, 0,
      255, 0, 255, 0,
      255, 255, 0, 0,
      0, 0, 0, 0,
    ]);
  });
});

describe('convertImageSpace — the jpeg-exact route is gray only', () => {
  const jpegRgb = () => {
    const px = new Uint8Array(8 * 8 * 3);
    for (let i = 0; i < 64; i++) { px[i * 3] = 255; px[i * 3 + 1] = 40; px[i * 3 + 2] = 10; }
    return img([
      ['Width', 8], ['Height', 8], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('DCTDecode')],
    ], encodeJpeg(8, 8, px, 'rgb', { quality: 90 }));
  };

  // A YCbCr JPEG's Y channel IS Rec. 601 luma, which is the whole basis of the
  // coefficient-domain route. There is no such identity for cmyk or rgb, so
  // the route must decline rather than produce a plausible wrong picture.
  it('takes the exact route for gray', () => {
    const r = grayscaleImage(jpegRgb(), resolve, inflate, {});
    expect(r.kind === 'converted' && r.route).toBe('jpeg-exact');
  });

  it('falls through to the sample route for cmyk', () => {
    const r = convertImageSpace(jpegRgb(), resolve, inflate, 'cmyk', {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('jpeg');
    const out = decodeJpeg(r.stream.raw);
    expect(out.comps).toBe(4);
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceCMYK'));
  });
});

describe('grayscaleImage is the gray specialization of convertImageSpace', () => {
  it('agrees with convertImageSpace at to: gray', () => {
    expect(grayscaleImage(rgbPair(), resolve, inflate, {}))
      .toEqual(convertImageSpace(rgbPair(), resolve, inflate, 'gray', {}));
  });
});
