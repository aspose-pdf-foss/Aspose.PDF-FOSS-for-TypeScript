import { describe, it, expect } from 'vitest';
import { decodeJpx, parseCodestream } from '../src/jpx.js';
import * as F from './helpers/jpx-fixtures.js';

const maxErr = (a: Uint8Array, b: Uint8Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe('decodeJpx end-to-end', () => {
  it('5/3 lossless grayscale decodes exactly', () => {
    const img = decodeJpx(F.lossless_gray_j2k);
    expect(img.width).toBe(F.lossless_gray_rgb.width);
    expect(img.height).toBe(F.lossless_gray_rgb.height);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('9/7 lossy RGB decodes within tolerance', () => {
    const img = decodeJpx(F.lossy_rgb_j2k);
    expect(img.comps).toBe(3);
    expect(maxErr(img.data, F.lossy_rgb_rgb.data)).toBeLessThanOrEqual(3);
  });

  it('RPCL progression (5/3 lossless RGB) decodes exactly', () => {
    const img = decodeJpx(F.rpcl_j2k);
    expect(img.comps).toBe(3);
    expect(Array.from(img.data)).toEqual(Array.from(F.rpcl_rgb.data));
  });

  it('JP2 box wrapper decodes identically to the bare codestream', () => {
    const img = decodeJpx(F.jp2box_j2k);
    expect(Array.from(img.data)).toEqual(Array.from(F.jp2box_rgb.data));
  });

  it('multi-layer (3 quality layers) grayscale decodes exactly', () => {
    // Guards against a regeneration silently producing a single-layer stream,
    // which would leave the assertion below passing while covering nothing.
    expect(parseCodestream(F.multilayer_gray_j2k).cod.layers).toBe(3);
    const img = decodeJpx(F.multilayer_gray_j2k);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('multi-layer (3 quality layers) RGB decodes exactly', () => {
    expect(parseCodestream(F.multilayer_rgb_j2k).cod.layers).toBe(3);
    const img = decodeJpx(F.multilayer_rgb_j2k);
    expect(img.comps).toBe(3);
    expect(Array.from(img.data)).toEqual(Array.from(F.multilayer_rgb_rgb.data));
  });

  it('throws on an empty/invalid codestream', () => {
    expect(() => decodeJpx(Uint8Array.from([0xff, 0x4f, 0xff, 0xd9]))).toThrow();
  });
});
