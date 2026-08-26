import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodeBmp, parseBmpHeader, fileStride } from '../src/bmp.js';
import { encodeBmp } from '../src/bmpencode.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** Red on the left half, so a decoded pixel says whether THIS page was
 *  encoded rather than a blank field of the right size. */
const page = (w = 120, h = 90) => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, w, h],
  content: `1 0 0 rg 0 0 ${w / 2} ${h} re f`,
})).Pages[0];

/** Read back through `bmp.ts`, whose decoder is anchored outside this repo:
 *  `test/fixtures/bmp/` holds GDI+-written files cross-checked with bmp-js. */
const rgbAt = (img: { width: number; samples: Uint8Array }, x: number, y: number) => {
  const p = (y * img.width + x) * 3;
  return [img.samples[p], img.samples[p + 1], img.samples[p + 2]];
};

describe('page.ToImage — BMP output', () => {
  it('emits a decodable 24-bit BMP at the page pixel size', () => {
    const img = decodeBmp(page().ToImage({ format: 'bmp' }));

    if (img.kind !== 'rgb') throw new Error(`expected rgb, got ${img.kind}`);
    expect(img.width).toBe(120);
    expect(img.height).toBe(90);
  });

  it('encodes the page content, not an empty canvas', () => {
    const img = decodeBmp(page().ToImage({ format: 'bmp' }));
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(rgbAt(img, 30, 45)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 90, 45)).toEqual([255, 255, 255]);
  });

  it('opens with the "BM" signature and a BITMAPINFOHEADER', () => {
    const b = page().ToImage({ format: 'bmp' });
    const h = parseBmpHeader(b);

    expect([b[0], b[1]]).toEqual([0x42, 0x4d]);
    expect(h.dibSize).toBe(40);
    expect(h.bpp).toBe(24);
    expect(h.compression).toBe(0);
  });

  // The row order is the single thing a BMP writer gets wrong invisibly: a
  // flipped image is a plausible picture. BMP stores rows BOTTOM-UP under a
  // positive height, which is the opposite of the top-down samples we hold.
  it('writes rows bottom-up, so the image is not vertically flipped', () => {
    // Top band red, bottom band white — asymmetric, unlike the left/right
    // fixture above, which a vertical flip would leave looking identical.
    const p = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 8, 8], content: '1 0 0 rg 0 4 8 4 re f',
    })).Pages[0];
    const img = decodeBmp(p.ToImage({ format: 'bmp' }));
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(rgbAt(img, 4, 1)).toEqual([255, 0, 0]);       // near the top
    expect(rgbAt(img, 4, 6)).toEqual([255, 255, 255]);   // near the bottom
  });

  // Rows are padded to a 4-byte boundary, and a width that is not a multiple
  // of 4 is the only shape that can tell a correct stride from a packed one:
  // getting it wrong shears the image progressively, which reads as corruption
  // rather than as a wrong number.
  it('pads each row to a 4-byte boundary', () => {
    const b = page(21, 5).ToImage({ format: 'bmp' });
    const h = parseBmpHeader(b);
    const img = decodeBmp(b);
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(fileStride(21, 24)).toBe(64);            // 63 rounded up to 64
    expect(b.length).toBe(h.offBits + 64 * 5);
    // The shear would put the red/white boundary in a different place per row.
    expect(rgbAt(img, 2, 0)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 2, 4)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 18, 4)).toEqual([255, 255, 255]);
  });

  // BMP's 24-bit form has no alpha, so it takes JPEG's answer rather than
  // TIFF's: refuse instead of quietly compositing onto white.
  it('refuses a transparent background, which 24-bit BMP cannot represent', () => {
    const call = () => page().ToImage({ format: 'bmp', background: 'transparent' });

    expect(call).toThrow(/bmp/);
    expect(call).toThrow(/transparent/);
  });
});

describe('encodeBmp', () => {
  it('rejects a sample count that does not match its dimensions', () => {
    expect(() => encodeBmp(4, 2, new Uint8Array(10))).toThrow(TypeError);
  });

  it('round-trips exact pixel values', () => {
    // 2x2: red, green / blue, black
    const samples = Uint8Array.from([
      255, 0, 0, 0, 255, 0,
      0, 0, 255, 0, 0, 0,
    ]);
    const img = decodeBmp(encodeBmp(2, 2, samples));

    if (img.kind !== 'rgb') throw new Error('expected rgb');
    expect([...img.samples]).toEqual([...samples]);
  });
});
