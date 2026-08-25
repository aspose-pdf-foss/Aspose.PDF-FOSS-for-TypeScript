import { describe, it, expect } from 'vitest';
import { decodeJpeg } from '../src/jpeg.js';
import { buildJpegXObject } from '../src/imageembed.js';
import { name } from '../src/types.js';
import { encodeJpeg } from '../src/jpegencode.js';
import {
  grayGradient, flatGray, rgbGradient, cmykGradient, psnr,
} from './helpers/build-raster.js';

describe('encodeJpeg — grayscale', () => {
  it('round-trips a gray gradient at q90 above 40dB', () => {
    const w = 32, h = 32;
    const px = grayGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 90, optimizeHuffman: false }));
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.comps).toBe(1);
    expect(psnr(px, dec.data)).toBeGreaterThan(40);
  });

  it('round-trips a flat field near-exactly', () => {
    const w = 16, h = 16;
    const px = flatGray(w, h, 200);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 90, optimizeHuffman: false }));
    for (let i = 0; i < px.length; i++) expect(Math.abs(dec.data[i] - 200)).toBeLessThanOrEqual(1);
  });

  it('starts with SOI and ends with EOI', () => {
    const out = encodeJpeg(8, 8, flatGray(8, 8, 128), 'gray', { optimizeHuffman: false });
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9]);
  });

  it('rejects a samples buffer of the wrong length', () => {
    expect(() => encodeJpeg(8, 8, new Uint8Array(63), 'gray')).toThrow(TypeError);
  });

  it('rejects non-positive dimensions', () => {
    expect(() => encodeJpeg(0, 8, new Uint8Array(0), 'gray')).toThrow(TypeError);
  });
});

describe('encodeJpeg — RGB', () => {
  it('round-trips at 4:4:4 q90 above 40dB', () => {
    const w = 32, h = 32;
    const px = rgbGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'rgb', {
      quality: 90, subsampling: '4:4:4', optimizeHuffman: false,
    }));
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.comps).toBe(3);
    expect(psnr(px, dec.data)).toBeGreaterThan(40);
  });

  it('round-trips at 4:2:0 with correct geometry', () => {
    const w = 32, h = 32;
    const px = rgbGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'rgb', {
      quality: 90, subsampling: '4:2:0', optimizeHuffman: false,
    }));
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.comps).toBe(3);
    // Chroma is halved by design, so the whole-image floor is the q50 floor.
    expect(psnr(px, dec.data)).toBeGreaterThan(30);
  });

  it('4:2:0 is smaller than 4:4:4 at the same quality', () => {
    const w = 64, h = 64;
    const px = rgbGradient(w, h);
    const a = encodeJpeg(w, h, px, 'rgb', { subsampling: '4:4:4', optimizeHuffman: false });
    const b = encodeJpeg(w, h, px, 'rgb', { subsampling: '4:2:0', optimizeHuffman: false });
    expect(b.length).toBeLessThan(a.length);
  });

  it('defaults to 4:2:0', () => {
    const w = 32, h = 32;
    const px = rgbGradient(w, h);
    const dflt = encodeJpeg(w, h, px, 'rgb', { optimizeHuffman: false });
    const explicit = encodeJpeg(w, h, px, 'rgb', { subsampling: '4:2:0', optimizeHuffman: false });
    expect([...dflt]).toEqual([...explicit]);
  });

  it('a flat colour field round-trips near-exactly at 4:4:4', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'rgb', {
      quality: 95, subsampling: '4:4:4', optimizeHuffman: false,
    }));
    for (let i = 0; i < px.length; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });
});

/** True when the byte stream carries an APP14 "Adobe" marker segment. */
function hasAdobeApp14(d: Uint8Array): boolean {
  for (let i = 0; i + 8 < d.length; i++) {
    if (d[i] === 0xff && d[i + 1] === 0xee &&
        d[i + 4] === 0x41 && d[i + 5] === 0x64 && d[i + 6] === 0x6f &&
        d[i + 7] === 0x62 && d[i + 8] === 0x65) return true;
  }
  return false;
}

describe('encodeJpeg — CMYK', () => {
  it('round-trips uninverted at q90 above 40dB', () => {
    const w = 32, h = 32;
    const px = cmykGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'cmyk', { quality: 90, optimizeHuffman: false }));
    expect(dec.comps).toBe(4);
    expect(psnr(px, dec.data)).toBeGreaterThan(40);
  });

  it('writes no Adobe APP14 marker', () => {
    // combinePlanes (jpeg.ts:334) inverts CMYK only when APP14 is present, and
    // buildJpegXObject (imageembed.ts:80) adds /Decode under the same condition.
    // Emitting one here would invert the round trip in both places.
    const out = encodeJpeg(16, 16, cmykGradient(16, 16), 'cmyk', { optimizeHuffman: false });
    expect(hasAdobeApp14(out)).toBe(false);
  });

  it('writes no JFIF APP0 marker for CMYK', () => {
    const out = encodeJpeg(16, 16, cmykGradient(16, 16), 'cmyk', { optimizeHuffman: false });
    expect([out[2], out[3]]).not.toEqual([0xff, 0xe0]);
  });

  it('ignores the subsampling option for CMYK', () => {
    const px = cmykGradient(16, 16);
    const a = encodeJpeg(16, 16, px, 'cmyk', { subsampling: '4:4:4', optimizeHuffman: false });
    const b = encodeJpeg(16, 16, px, 'cmyk', { subsampling: '4:2:0', optimizeHuffman: false });
    expect([...a]).toEqual([...b]);
  });
});

describe('encodeJpeg — optimized Huffman', () => {
  it('is the default', () => {
    const w = 48, h = 48;
    const px = grayGradient(w, h);
    const dflt = encodeJpeg(w, h, px, 'gray', { quality: 75 });
    const opt = encodeJpeg(w, h, px, 'gray', { quality: 75, optimizeHuffman: true });
    expect([...dflt]).toEqual([...opt]);
  });

  it('produces a strictly smaller file than the standard tables', () => {
    const w = 64, h = 64;
    const px = grayGradient(w, h);
    const std = encodeJpeg(w, h, px, 'gray', { quality: 75, optimizeHuffman: false });
    const opt = encodeJpeg(w, h, px, 'gray', { quality: 75, optimizeHuffman: true });
    expect(opt.length).toBeLessThan(std.length);
  });

  it('decodes to the same geometry as the standard tables, at comparable quality', () => {
    const w = 48, h = 48;
    const px = grayGradient(w, h);
    const std = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 75, optimizeHuffman: false }));
    const opt = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 75, optimizeHuffman: true }));
    expect(opt.width).toBe(std.width);
    expect(opt.height).toBe(std.height);
    expect(opt.comps).toBe(std.comps);
    // Huffman coding is lossless: only the table changes, never the coefficients.
    expect([...opt.data]).toEqual([...std.data]);
  });

  it('round-trips RGB 4:2:0 with optimized tables', () => {
    const w = 32, h = 32;
    const px = rgbGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'rgb', { quality: 90 }));
    expect(dec.comps).toBe(3);
    expect(psnr(px, dec.data)).toBeGreaterThan(30);
  });

  it('round-trips CMYK with optimized tables', () => {
    const w = 32, h = 32;
    const px = cmykGradient(w, h);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'cmyk', { quality: 90 }));
    expect(dec.comps).toBe(4);
    expect(psnr(px, dec.data)).toBeGreaterThan(40);
  });
});

describe('encodeJpeg — quality', () => {
  it('meets the PSNR floor at each quality step', () => {
    const w = 32, h = 32;
    const px = grayGradient(w, h);
    const floors: [number, number][] = [[90, 40], [75, 35], [50, 30]];
    for (const [q, floor] of floors) {
      const dec = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: q }));
      expect(psnr(px, dec.data)).toBeGreaterThan(floor);
    }
  });

  it('rises in size and fidelity with quality', () => {
    const w = 64, h = 64;
    const px = grayGradient(w, h);
    const qs = [30, 50, 75, 90];
    const sizes = qs.map((q) => encodeJpeg(w, h, px, 'gray', { quality: q }).length);
    const psnrs = qs.map((q) => psnr(px, decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: q })).data));
    for (let i = 1; i < qs.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
      expect(psnrs[i]).toBeGreaterThanOrEqual(psnrs[i - 1]);
    }
  });

  it('defaults to quality 75', () => {
    const px = grayGradient(32, 32);
    const dflt = encodeJpeg(32, 32, px, 'gray');
    const explicit = encodeJpeg(32, 32, px, 'gray', { quality: 75 });
    expect([...dflt]).toEqual([...explicit]);
  });
});

describe('encodeJpeg — edge geometry', () => {
  const cases: [number, number][] = [[1, 1], [1, 16], [16, 1], [7, 7], [17, 5], [23, 31], [33, 33]];

  it('round-trips gray at sizes that are not block multiples', () => {
    for (const [w, h] of cases) {
      const px = grayGradient(w, h);
      const dec = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 90 }));
      expect([dec.width, dec.height]).toEqual([w, h]);
      expect(dec.data.length).toBe(w * h);
    }
  });

  it('round-trips RGB 4:2:0 at sizes that are not MCU multiples', () => {
    for (const [w, h] of cases) {
      const px = rgbGradient(w, h);
      const dec = decodeJpeg(encodeJpeg(w, h, px, 'rgb', { quality: 90, subsampling: '4:2:0' }));
      expect([dec.width, dec.height]).toEqual([w, h]);
      expect(dec.data.length).toBe(w * h * 3);
    }
  });

  it('keeps a flat field flat across a partial-block margin', () => {
    // Edge replication must extend the margin, not pad with zeros: a zero pad
    // would ring across the boundary and show up here.
    const w = 13, h = 13;
    const px = flatGray(w, h, 180);
    const dec = decodeJpeg(encodeJpeg(w, h, px, 'gray', { quality: 90 }));
    for (let i = 0; i < px.length; i++) expect(Math.abs(dec.data[i] - 180)).toBeLessThanOrEqual(2);
  });
});

describe('encodeJpeg — embed path', () => {
  // buildJpegXObject parses SOF markers with its own scanner, independent of
  // decodeJpeg. Round-tripping through it checks the marker layout against a
  // second reader in the tree, and is the path Optimize({ images }) will use.
  it('produces a JPEG that buildJpegXObject parses into a matching XObject', () => {
    const cases: [number, number, 'gray' | 'rgb' | 'cmyk', string][] = [
      [32, 24, 'gray', 'DeviceGray'],
      [32, 24, 'rgb', 'DeviceRGB'],
      [32, 24, 'cmyk', 'DeviceCMYK'],
    ];
    for (const [w, h, kind, cs] of cases) {
      const px = kind === 'gray' ? grayGradient(w, h)
        : kind === 'rgb' ? rgbGradient(w, h) : cmykGradient(w, h);
      const built = buildJpegXObject(encodeJpeg(w, h, px, kind, { quality: 80 }));
      const dict = built.stream.dict;
      expect(dict.get('Width')).toBe(w);
      expect(dict.get('Height')).toBe(h);
      expect(dict.get('BitsPerComponent')).toBe(8);
      expect(dict.get('ColorSpace')).toEqual(name(cs));
      expect(dict.get('Filter')).toEqual(name('DCTDecode'));
    }
  });

  it('leaves CMYK undecoded: no /Decode inversion array', () => {
    // buildJpegXObject only adds /Decode when APP14 is present. We emit none, so
    // the samples must be taken as-is.
    const built = buildJpegXObject(encodeJpeg(16, 16, cmykGradient(16, 16), 'cmyk'));
    expect(built.stream.dict.get('Decode')).toBeUndefined();
  });
});
