import { describe, it, expect } from 'vitest';
import { grayscaleImage } from '../src/colorimage.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { decodeJpeg } from '../src/jpeg.js';
import { deflateSync, inflateSync } from 'node:zlib';

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

describe('grayscaleImage — nothing to convert', () => {
  it('reports none for an image mask', () => {
    const s = img([['ImageMask', true], ['Width', 2], ['Height', 2]], new Uint8Array(1));
    expect(grayscaleImage(s, resolve, inflate, {}).kind).toBe('none');
  });

  it('reports none for an already-DeviceGray image', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['ColorSpace', name('DeviceGray')],
      ['BitsPerComponent', 8],
    ], new Uint8Array(4));
    expect(grayscaleImage(s, resolve, inflate, {}).kind).toBe('none');
  });
});

describe('grayscaleImage — the Indexed palette route', () => {
  const palette = () => new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);

  it('greys the lookup table and leaves the samples untouched', () => {
    const samples = new Uint8Array([0, 1, 2, 3]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, str(palette())]],
    ], samples);

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    // Sample data is byte-identical: only the palette moved.
    expect(r.stream.raw).toEqual(samples);

    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect(cs[1]).toEqual(name('DeviceGray'));
    const lut = cs[3] as { bytes: Uint8Array };
    // 0.299, 0.587, 0.114, 1.0 -> 8-bit.
    expect([...lut.bytes]).toEqual([76, 150, 29, 255]);
  });

  it('converts at 4 bits per component, where the sample routes cannot', () => {
    const s = img([
      ['Width', 4], ['Height', 1], ['BitsPerComponent', 4],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, str(palette())]],
    ], new Uint8Array([0x01, 0x23]));

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    expect(r.stream.dict.get('BitsPerComponent')).toBe(4);
  });

  it('reads a palette stored as a stream, not only as a string', () => {
    const lutStream: PdfStream = { kind: 'stream', dict: new Map(), raw: palette() };
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, lutStream]],
    ], new Uint8Array([0, 1, 2, 3]));

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect(isStream(cs[3] as PdfObject)).toBe(true);
    expect([...(cs[3] as PdfStream).raw]).toEqual([76, 150, 29, 255]);
  });

  it('greys a CMYK palette through its base converter, not as if it were RGB', () => {
    // Pure cyan and pure magenta. An RGB reading of the same bytes would give
    // 0.299 and 0.587; the CMYK reading gives 0.701 and 0.413.
    const cmyk = new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0]);
    const s = img([
      ['Width', 2], ['Height', 1], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceCMYK'), 1, str(cmyk)]],
    ], new Uint8Array([0, 1]));

    const r = grayscaleImage(s, resolve, inflate, {});
    if (r.kind !== 'converted') throw new Error('expected converted');
    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect([...(cs[3] as { bytes: Uint8Array }).bytes]).toEqual([179, 105]);
  });

  it('preserves every unrelated dict key', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, str(palette())]],
      ['SMask', { kind: 'ref', num: 9, gen: 0 } as PdfObject],
      ['Intent', name('RelativeColorimetric')],
    ], new Uint8Array([0, 1, 2, 3]));

    const r = grayscaleImage(s, resolve, inflate, {});
    if (r.kind !== 'converted') throw new Error('expected converted');
    expect(r.stream.dict.get('SMask')).toEqual({ kind: 'ref', num: 9, gen: 0 });
    expect(r.stream.dict.get('Intent')).toEqual(name('RelativeColorimetric'));
  });
});

describe('grayscaleImage — the colour-key /Mask route', () => {
  const zinflate = (st: PdfStream): Uint8Array => new Uint8Array(inflateSync(st.raw));

  /**
   * (255,0,0) and (0,130,0) BOTH grey to 76: 0.299*255 = 76.245 and
   * 0.587*130 = 76.31. That collision is the whole reason a colour-key range
   * cannot be re-derived in grey -- any grey range covering the red would also
   * cover the green -- and it is what these fixtures are built around.
   */
  const RED_ONLY: PdfObject = [250, 255, 0, 5, 0, 5];

  it('masks only the keyed colour, not another colour sharing its luma', () => {
    const px = new Uint8Array([
      255, 0, 0,      // keyed   -> masked
      0, 130, 0,      // luma 76 as well, NOT keyed -> must stay painted
      0, 0, 255,      // luma 29
      255, 255, 255,  // luma 255
    ]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Mask', RED_ONLY],
      ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(px)));

    const r = grayscaleImage(s, resolve, zinflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;

    // Both pixels are grey 76 now, so nothing in the SAMPLES can tell them
    // apart -- only the stencil can.
    expect([...new Uint8Array(inflateSync(r.stream.raw))]).toEqual([76, 76, 29, 255]);

    expect(r.mask).toBeDefined();
    const m = r.mask!;
    expect(m.dict.get('ImageMask')).toBe(true);
    expect(m.dict.get('BitsPerComponent')).toBe(1);
    expect(m.dict.get('Width')).toBe(2);
    expect(m.dict.get('Height')).toBe(2);
    expect(m.dict.get('Decode')).toEqual([0, 1]);
    // Row 0 is [masked, painted] -> 0b10000000; row 1 is [painted, painted].
    // 1 means MASKED OUT, matching /ImageMask's own polarity under /Decode
    // [0 1]. Inverting it is invisible in our renderer, which honours neither
    // form of /Mask, and is a photographic negative of the transparency in one
    // that does.
    expect([...new Uint8Array(inflateSync(m.raw))]).toEqual([0x80, 0x00]);

    // The stale array must not survive into the converted dict: it describes
    // three components of a colour space the image no longer has.
    expect(r.stream.dict.get('Mask')).toBeUndefined();
  });

  it('pads each stencil row to a byte boundary', () => {
    // 5 px wide: bits 1,0,0,0,1 then three pad bits -> 0b10001000.
    const px = new Uint8Array([
      255, 0, 0,  0, 0, 0,  0, 0, 0,  0, 0, 0,  255, 0, 0,
    ]);
    const s = img([
      ['Width', 5], ['Height', 1], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Mask', RED_ONLY],
      ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(px)));

    const r = grayscaleImage(s, resolve, zinflate, {});
    if (r.kind !== 'converted' || !r.mask) throw new Error('expected a mask');
    expect([...new Uint8Array(inflateSync(r.mask.raw))]).toEqual([0x88]);
  });

  it('leaves an Indexed image’s array alone, since it keys index values', () => {
    // 8.9.6.4 keys RAW pre-Decode samples, and an Indexed image's samples are
    // indices -- which convertIndexed does not touch. So the array stays
    // exactly correct and there is nothing to convert.
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const samples = new Uint8Array([0, 1, 2, 3]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, str(palette)]],
      ['Mask', [0, 0]],
    ], samples);

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    expect(r.mask).toBeUndefined();
    expect(r.stream.dict.get('Mask')).toEqual([0, 0]);
    expect(r.stream.raw).toEqual(samples);
  });

  it('skips an image carrying BOTH a colour-key /Mask and an /SMask', () => {
    // 32000-1 makes them mutually exclusive. Converting one and leaving the
    // other produces a file no two viewers agree about.
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Mask', RED_ONLY],
      ['SMask', img([['Width', 2], ['Height', 2]], new Uint8Array(4))],
    ], new Uint8Array(12));

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/SMask/);
  });
});

describe('grayscaleImage — guards', () => {
  it('skips an image carrying a /Decode array', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Decode', [1, 0, 1, 0, 1, 0]],
    ], new Uint8Array(12));
    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/\/Decode/);
  });
});

describe('grayscaleImage — the DCT route', () => {
  it('re-encodes an RGB JPEG as a one-component grey JPEG', () => {
    const w = 8, h = 8;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = 255; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 0; }
    const jpeg = encodeJpeg(w, h, rgb, 'rgb', { quality: 90 });

    const s = img([
      ['Width', w], ['Height', h], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('DCTDecode')],
    ], jpeg);

    const r = grayscaleImage(s, resolve, inflate, { quality: 90 });
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('jpeg-exact');
    expect(r.from).toBe('DeviceRGB');
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.stream.dict.get('Filter')).toEqual(name('DCTDecode'));

    const out = decodeJpeg(r.stream.raw);
    expect(out.comps).toBe(1);
    expect(out.width).toBe(w);
    // Pure red -> Y = clamp8(0.299 * 255) = 76. The exact route reproduces the
    // input's own Y plane, so this is DCT round-trip loss on a flat block only.
    expect(Math.abs(out.data[0] - 76)).toBeLessThanOrEqual(1);
  });
});

describe('grayscaleImage — the sample route', () => {
  const zinflate = (st: PdfStream): Uint8Array => new Uint8Array(inflateSync(st.raw));

  it('greys Flate RGB samples and re-deflates them', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(rgb)));

    const r = grayscaleImage(s, resolve, zinflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('flate');
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.stream.dict.get('BitsPerComponent')).toBe(8);
    expect([...new Uint8Array(inflateSync(r.stream.raw))]).toEqual([76, 150, 29, 255]);
  });

  it('skips sub-8-bit non-indexed samples, which arrive still packed', () => {
    const s = img([
      ['Width', 8], ['Height', 1], ['BitsPerComponent', 4],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(new Uint8Array(12))));
    const r = grayscaleImage(s, resolve, zinflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/BitsPerComponent/);
  });

  it('reports a decode that produces the wrong number of samples', () => {
    const s = img([
      ['Width', 4], ['Height', 4], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(new Uint8Array(3))));
    const r = grayscaleImage(s, resolve, zinflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/expected/);
  });
});

describe('grayscaleImage — the exact DCT route declines', () => {
  it('falls back to the sample route for a CMYK JPEG, whose component 0 is cyan', () => {
    const w = 8, h = 8;
    const cmyk = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      cmyk[i * 4] = 0; cmyk[i * 4 + 1] = 255; cmyk[i * 4 + 2] = 255; cmyk[i * 4 + 3] = 0;
    }
    const jpeg = encodeJpeg(w, h, cmyk, 'cmyk', { quality: 90 });

    const s = img([
      ['Width', w], ['Height', h], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceCMYK')], ['Filter', name('DCTDecode')],
    ], jpeg);

    const r = grayscaleImage(s, resolve, inflate, { quality: 90 });
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('jpeg');
    expect(r.from).toBe('DeviceCMYK');
  });
});
