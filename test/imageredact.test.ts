import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { coveredPixelBox, coveredPixelRegion, blankPixels, encodeRgbaXObject, blankSamples, blankImageMaskSamples, encodeSamplesXObject, inlineImageToStream } from '../src/imageredact.js';
import type { ImageRgba } from '../src/raster.js';
import type { Matrix } from '../src/text.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { PdfDict, PdfObject, name, isName, isArray } from '../src/types.js';

// A 4×4 image placed at device [0,0,100,100] via cm = [100,0,0,100,0,0].
const CM: Matrix = [100, 0, 0, 100, 0, 0];

function solid(w: number, h: number, rgba: [number, number, number, number]): ImageRgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { w, h, data };
}

describe('coveredPixelBox', () => {
  it('maps the left device half to the left pixel columns', () => {
    const box = coveredPixelBox(CM, 4, 4, [0, 0, 50, 100]);
    expect(box).toEqual({ x0: 0, y0: 0, x1: 2, y1: 4 });
  });

  it('flips rows for a top device band (v→row: row 0 is top)', () => {
    // Device y in [75,100] is the TOP of the image (v near 1) → pixel rows 0..1.
    const box = coveredPixelBox(CM, 4, 4, [0, 75, 100, 100]);
    expect(box).toEqual({ x0: 0, y0: 0, x1: 4, y1: 1 });
  });

  it('returns undefined when the rect misses the image', () => {
    expect(coveredPixelBox(CM, 4, 4, [200, 200, 300, 300])).toBeUndefined();
  });

  it('throws on a rotated CTM', () => {
    const rot: Matrix = [0, 100, -100, 0, 100, 0]; // 90° rotation
    expect(() => coveredPixelBox(rot, 4, 4, [0, 0, 50, 50])).toThrow(UnsupportedFeatureError);
  });
});

describe('coveredPixelRegion', () => {
  it('delegates to a single box for an axis-aligned placement', () => {
    expect(coveredPixelRegion(CM, 4, 4, [0, 0, 50, 100])).toEqual([{ x0: 0, y0: 0, x1: 2, y1: 4 }]);
  });

  it('returns no spans when an axis-aligned rect misses the image', () => {
    expect(coveredPixelRegion(CM, 4, 4, [200, 200, 300, 300])).toEqual([]);
  });

  it('fills the rotated polygon as per-row pixel spans (90° CTM)', () => {
    // 90° placement of a 4×4 image over device [0,100]²; redact the left device
    // half → the mapped quad covers the TOP two pixel rows, full width.
    const rot: Matrix = [0, 100, -100, 0, 100, 0];
    expect(coveredPixelRegion(rot, 4, 4, [0, 0, 50, 100])).toEqual([
      { x0: 0, y0: 0, x1: 4, y1: 1 },
      { x0: 0, y0: 1, x1: 4, y1: 2 },
    ]);
  });

  it('returns no spans when a rotated quad misses the image', () => {
    const rot: Matrix = [0, 100, -100, 0, 100, 0];
    expect(coveredPixelRegion(rot, 4, 4, [200, 200, 300, 300])).toEqual([]);
  });
});

describe('blankSamples', () => {
  it('zeros the nc components of covered 8-bpc pixels only', () => {
    // 2×1 RGB: [pixel0 rgb][pixel1 rgb]
    const s = Uint8Array.from([11, 22, 33, 44, 55, 66]);
    blankSamples(s, 2, 1, 3, 8, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0 only
    expect([...s]).toEqual([0, 0, 0, 44, 55, 66]);
  });

  it('clears only the covered nibble of a shared 4-bpc byte', () => {
    // 4×1 indexed, 4 bpc → 2 pixels/byte: byte0 = pixels(0,1), byte1 = pixels(2,3)
    const s = Uint8Array.from([0xab, 0xcd]);
    blankSamples(s, 4, 1, 1, 4, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0 = high nibble
    expect([...s]).toEqual([0x0b, 0xcd]); // low nibble (pixel1) preserved

    const s2 = Uint8Array.from([0xab, 0xcd]);
    blankSamples(s2, 4, 1, 1, 4, [{ x0: 1, y0: 0, x1: 2, y1: 1 }]); // pixel1 = low nibble
    expect([...s2]).toEqual([0xa0, 0xcd]); // high nibble (pixel0) preserved
  });

  it('zeros both bytes of a covered 16-bpc sample', () => {
    // 2×1 gray, 16 bpc → 2 bytes/pixel
    const s = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
    blankSamples(s, 2, 1, 1, 16, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // pixel0
    expect([...s]).toEqual([0, 0, 0x56, 0x78]);
  });

  it('respects row byte-alignment across rows (1 bpc)', () => {
    // 3×2, 1 bpc, nc 1 → rowBytes = ceil(3/8) = 1. Row0 = 0b111_00000, Row1 = 0b101_00000
    const s = Uint8Array.from([0b11100000, 0b10100000]);
    blankSamples(s, 3, 2, 1, 1, [{ x0: 0, y0: 1, x1: 1, y1: 2 }]); // row1, col0 only
    expect([...s]).toEqual([0b11100000, 0b00100000]); // row0 untouched; row1 bit0 cleared
  });
});

describe('blankImageMaskSamples', () => {
  it('sets covered stencil bits to 1 (default-Decode non-marking value)', () => {
    // 8×1 stencil, all-zeros (every pixel marks); clear cols 0..3 → high nibble = 1.
    const s = Uint8Array.from([0x00]);
    blankImageMaskSamples(s, 8, 1, [{ x0: 0, y0: 0, x1: 4, y1: 1 }], 1);
    expect([...s]).toEqual([0xf0]); // cols 0..3 → 1, cols 4..7 untouched
  });

  it('sets covered stencil bits to 0 (Decode [1 0] non-marking value)', () => {
    // 8×1 stencil, all-ones; clear cols 0..3 → high nibble = 0.
    const s = Uint8Array.from([0xff]);
    blankImageMaskSamples(s, 8, 1, [{ x0: 0, y0: 0, x1: 4, y1: 1 }], 0);
    expect([...s]).toEqual([0x0f]); // cols 0..3 → 0, cols 4..7 preserved
  });

  it('respects row byte-alignment across rows', () => {
    // 3×2, rowBytes = ceil(3/8) = 1. Clear row1 col0 only.
    const s = Uint8Array.from([0b00000000, 0b00100000]);
    blankImageMaskSamples(s, 3, 2, [{ x0: 0, y0: 1, x1: 1, y1: 2 }], 1);
    expect([...s]).toEqual([0b00000000, 0b10100000]); // row0 untouched; row1 bit0 set
  });
});

describe('blankPixels', () => {
  it('zeros RGB and sets alpha 255 inside the box only', () => {
    const img = solid(2, 2, [10, 20, 30, 40]);
    blankPixels(img, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]); // top-left pixel only
    expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);   // blanked
    expect([...img.data.subarray(4, 8)]).toEqual([10, 20, 30, 40]); // untouched
  });
});

describe('encodeRgbaXObject', () => {
  it('emits a DeviceRGB Flate image and no SMask when fully opaque', () => {
    const img = solid(2, 1, [1, 2, 3, 255]);
    const out = encodeRgbaXObject(img);
    expect(out.smask).toBeUndefined();
    const cs = out.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    expect(out.dict.get('Width')).toBe(2);
    expect([...inflateSync(Buffer.from(out.raw))]).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('emits an SMask when any pixel has alpha < 255', () => {
    const img = solid(1, 1, [9, 9, 9, 128]);
    const out = encodeRgbaXObject(img);
    expect(out.smask).toBeDefined();
    expect([...inflateSync(Buffer.from(out.smask!.raw))]).toEqual([128]);
    const scs = out.smask!.dict.get('ColorSpace');
    expect(isName(scs) && scs.name).toBe('DeviceGray');
  });
});

describe('encodeSamplesXObject', () => {
  it('clones colorspace/bit-depth/decode and re-deflates the samples', () => {
    const src: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', 4], ['Height', 1],
      ['ColorSpace', name('DeviceCMYK')], ['BitsPerComponent', 8],
      ['Decode', [1, 0, 1, 0, 1, 0, 1, 0] as unknown as PdfObject],
      ['Filter', name('LZWDecode')], // must NOT be carried over
    ]);
    const samples = Uint8Array.from([0, 0, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1]);
    const out = encodeSamplesXObject(src, samples);

    expect(isName(out.dict.get('ColorSpace')) && (out.dict.get('ColorSpace') as { name: string }).name).toBe('DeviceCMYK');
    expect(out.dict.get('BitsPerComponent')).toBe(8);
    expect(isArray(out.dict.get('Decode'))).toBe(true);
    expect(isName(out.dict.get('Filter')) && (out.dict.get('Filter') as { name: string }).name).toBe('FlateDecode');
    expect([...inflateSync(Buffer.from(out.raw))]).toEqual([...samples]); // uncovered bytes round-trip
  });
});

describe('inlineImageToStream', () => {
  it('expands abbreviated keys, a device colorspace name and a filter name', () => {
    const dict = new Map<string, PdfObject>([
      ['W', 4], ['H', 3], ['BPC', 8], ['CS', name('RGB')], ['F', name('Fl')], ['L', 12],
    ]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([1, 2, 3]) });
    expect(s.kind).toBe('stream');
    expect(s.dict.get('Width')).toBe(4);
    expect(s.dict.get('Height')).toBe(3);
    expect(s.dict.get('BitsPerComponent')).toBe(8);
    const cs = s.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    const f = s.dict.get('Filter');
    // Expanded since 10u9.10, where InlineImageInfo began exposing Filter to
    // callers: an inline image reporting 'Fl' where an XObject reports
    // 'FlateDecode' makes one rule read as two. Decoding never depended on it
    // -- filters.ts accepts both spellings -- so nothing downstream moved. The
    // previous expectation recorded the behaviour without giving a reason.
    expect(isName(f) && f.name).toBe('FlateDecode');
    expect(s.dict.has('L')).toBe(false);    // length dropped
    expect(s.raw).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('expands a filter ARRAY, not just a lone name', () => {
    const dict = new Map<string, PdfObject>([
      ['W', 2], ['H', 2], ['BPC', 8], ['F', [name('AHx'), name('Fl')]],
    ]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([1]) });
    const f = s.dict.get('Filter') as PdfObject[];
    expect(isArray(f)).toBe(true);
    expect(f.map((e) => (isName(e) ? e.name : '?'))).toEqual(['ASCIIHexDecode', 'FlateDecode']);
  });

  it('leaves a filter name it does not know alone', () => {
    // Conservative: an unrecognised name passes through so it stays visible to
    // the caller rather than being silently rewritten into something wrong.
    const dict = new Map<string, PdfObject>([['W', 1], ['H', 1], ['F', name('Weird')]]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([1]) });
    const f = s.dict.get('Filter');
    expect(isName(f) && f.name).toBe('Weird');
  });

  it('expands an indexed colorspace array head and base', () => {
    const dict = new Map<string, PdfObject>([
      ['W', 2], ['H', 2], ['BPC', 8],
      ['CS', [name('I'), name('RGB'), 1, { kind: 'string', bytes: Uint8Array.from([0, 0, 0, 255, 255, 255]) }]],
    ]);
    const s = inlineImageToStream({ dict, data: Uint8Array.from([0, 1, 1, 0]) });
    const cs = s.dict.get('ColorSpace') as PdfObject[];
    expect(isName(cs[0]) && cs[0].name).toBe('Indexed');
    expect(isName(cs[1]) && cs[1].name).toBe('DeviceRGB');
    expect(cs[2]).toBe(1); // hival preserved
  });
});
