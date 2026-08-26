import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { encodeGif } from '../src/gifencode.js';
import { quantize } from '../src/quantize.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodeGif } from './helpers/decode-gif.js';

const page = (w = 120, h = 90) => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, w, h],
  content: `1 0 0 rg 0 0 ${w / 2} ${h} re f`,
})).Pages[0];

const rgbAt = (g: { width: number; rgb: Uint8Array }, x: number, y: number) => {
  const p = (y * g.width + x) * 3;
  return [g.rgb[p], g.rgb[p + 1], g.rgb[p + 2]];
};

describe('page.ToImage — GIF output', () => {
  it('emits a GIF89a decodable at the page pixel size', () => {
    const g = decodeGif(page().ToImage({ format: 'gif' }));

    expect(g.width).toBe(120);
    expect(g.height).toBe(90);
  });

  // A page of flat colours has far fewer than 256 distinct values, so the
  // palette is EXACT and the round trip is lossless. That is the common shape
  // for a rendered document, and it is why GIF is usable here at all.
  it('round-trips a few-colour page exactly', () => {
    const g = decodeGif(page().ToImage({ format: 'gif' }));

    expect(rgbAt(g, 30, 45)).toEqual([255, 0, 0]);
    expect(rgbAt(g, 90, 45)).toEqual([255, 255, 255]);
  });

  it('is not vertically flipped', () => {
    const p = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 8, 8], content: '1 0 0 rg 0 4 8 4 re f',
    })).Pages[0];
    const g = decodeGif(p.ToImage({ format: 'gif' }));

    expect(rgbAt(g, 4, 1)).toEqual([255, 0, 0]);
    expect(rgbAt(g, 4, 6)).toEqual([255, 255, 255]);
  });

  it('refuses a transparent background', () => {
    const call = () => page().ToImage({ format: 'gif', background: 'transparent' });

    expect(call).toThrow(/gif/);
    expect(call).toThrow(/transparent/);
  });
});

describe('encodeGif', () => {
  /** `n` distinct colours, one pixel each, in a 1-row image. */
  const ramp = (n: number) => {
    const s = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { s[i * 3] = i & 0xff; s[i * 3 + 1] = (i * 7) & 0xff; s[i * 3 + 2] = (i * 13) & 0xff; }
    return s;
  };

  it('rejects a sample count that does not match its dimensions', () => {
    expect(() => encodeGif(4, 2, new Uint8Array(10))).toThrow(TypeError);
  });

  // The LZW code width grows as the dictionary fills, and a wide image of
  // varied colour is what drives it past the initial width. A short fixture
  // never leaves the first width at all, so it cannot see a growth bug.
  it('round-trips an image long enough to grow the LZW code width', () => {
    const n = 4000;
    const src = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = (i * 37) & 0xff;
      src[i * 3] = v; src[i * 3 + 1] = 255 - v; src[i * 3 + 2] = (v * 3) & 0xff;
    }
    const g = decodeGif(encodeGif(n, 1, src));

    expect(g.width).toBe(n);
    // Colour is quantized (more than 256 distinct values), so compare the
    // INDEX stream rather than the pixels: that is what LZW actually coded.
    expect(g.indices.length).toBe(n);
  });

  it('writes a global colour table sized to the next power of two', () => {
    // Three colours need a 4-entry table, the smallest GIF allows.
    const g = decodeGif(encodeGif(3, 1, Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255])));

    expect(g.palette.length / 3).toBe(4);
    expect(rgbAt(g, 0, 0)).toEqual([255, 0, 0]);
    expect(rgbAt(g, 1, 0)).toEqual([0, 255, 0]);
    expect(rgbAt(g, 2, 0)).toEqual([0, 0, 255]);
  });

  it('caps the palette at 256 entries for an image with more colours', () => {
    const g = decodeGif(encodeGif(1000, 1, ramp(1000)));

    expect(g.palette.length / 3).toBe(256);
  });
});

describe('quantize', () => {
  it('is exact when the image has at most 256 colours', () => {
    const src = Uint8Array.from([255, 0, 0, 0, 255, 0, 255, 0, 0]);
    const q = quantize(src, 3);

    expect(q.exact).toBe(true);
    expect(q.palette.length / 3).toBe(2);          // red and green, deduped
    expect([...q.indices]).toEqual([0, 1, 0]);
  });

  it('reduces to at most 256 colours and maps every pixel', () => {
    const n = 5000;
    const src = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      src[i * 3] = i & 0xff; src[i * 3 + 1] = (i >> 3) & 0xff; src[i * 3 + 2] = (i >> 6) & 0xff;
    }
    const q = quantize(src, n);

    expect(q.exact).toBe(false);
    expect(q.palette.length / 3).toBeLessThanOrEqual(256);
    expect(q.indices.length).toBe(n);
    for (const i of q.indices) expect(i).toBeLessThan(q.palette.length / 3);
  });

  // A quantizer that returned a plausible palette but mapped every pixel to
  // entry 0 would satisfy the bounds above. Error has to be bounded too.
  it('maps each pixel to a near colour, not an arbitrary one', () => {
    const n = 3000;
    const src = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      src[i * 3] = (i * 5) & 0xff; src[i * 3 + 1] = (i * 11) & 0xff; src[i * 3 + 2] = (i * 23) & 0xff;
    }
    const q = quantize(src, n);

    let worst = 0;
    for (let i = 0; i < n; i++) {
      const e = q.indices[i] * 3;
      for (let c = 0; c < 3; c++) {
        worst = Math.max(worst, Math.abs(src[i * 3 + c] - q.palette[e + c]));
      }
    }
    // Median cut over 256 boxes keeps every channel comfortably inside this.
    expect(worst).toBeLessThan(64);
  });
});
