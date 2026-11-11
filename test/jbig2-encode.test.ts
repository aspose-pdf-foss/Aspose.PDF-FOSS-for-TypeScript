import { describe, it, expect } from 'vitest';
import { encodeJbig2 } from '../src/jbig2encode.js';
import { decodeJbig2, parseSegments } from '../src/jbig2.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError, UnsupportedFeatureError } from '../src/errors.js';
import { arith_gb0 } from './helpers/jbig2-generic-vectors.js';

function packed(rows: readonly string[]): Uint8Array {
  const stride = Math.ceil(rows[0].length / 8), out = new Uint8Array(stride * rows.length);
  rows.forEach((row, y) => [...row].forEach((bit, x) => {
    if (bit === '0') out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  }));
  return out;
}

describe('lossless JBIG2 encoder', () => {
  it('promotes the fixture arithmetic encoder without changing its decisions', () => {
    const src = packed(arith_gb0.rows);
    const encoded = encodeJbig2(16, 16, src);
    const segments = parseSegments(encoded);
    expect(segments.map((s) => [s.type, s.pageAssociation])).toEqual([[48, 1], [39, 1]]);
    const region = segments[1];
    expect(encoded.subarray(region.dataStart + 26, encoded.length - 2)).toEqual(arith_gb0.bytes);
    expect([...encoded.subarray(-2)]).toEqual([0xff, 0xac]);
    expect(decodeJbig2(encoded, undefined, 16, 16)).toEqual(src);
  });

  it.each([1, 7, 8, 9, 17, 64, 257])('preserves every real pixel at width %i', (w) => {
    const h = 37, stride = Math.ceil(w / 8), src = new Uint8Array(stride * h);
    let seed = 12345;
    for (let i = 0; i < src.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; src[i] = seed >>> 24; }
    const before = src.slice();
    const decoded = decodeJbig2(encodeJbig2(w, h, src), undefined, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      expect((decoded[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1)
        .toBe((src[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1);
    expect(src).toEqual(before);
  });

  it.each([0, 255])('compresses a uniform plane of sample byte %i without changing polarity', (v) => {
    const src = new Uint8Array(128 * 64).fill(v);
    const encoded = encodeJbig2(1024, 64, src);
    expect(encoded.length).toBeLessThan(120);
    expect(decodeJbig2(encoded, undefined, 1024, 64)).toEqual(src);
  });

  it('ignores row padding both in contexts and repeated-row prediction', () => {
    const a = new Uint8Array(20).fill(0x80), b = new Uint8Array(20).fill(0xff);
    expect(encodeJbig2(1, 20, a)).toEqual(encodeJbig2(1, 20, b));
  });

  it.each([[0, 1], [1, 0], [-1, 1], [1.5, 2], [NaN, 1], [Infinity, 1], [0x100000000, 1]])('refuses invalid geometry %s x %s', (w, h) => {
    expect(() => encodeJbig2(w, h, new Uint8Array())).toThrow(UnsupportedFeatureError);
  });

  it('refuses truncated and overlong sample planes', () => {
    expect(() => encodeJbig2(9, 2, new Uint8Array(3))).toThrow(UnsupportedFeatureError);
    expect(() => encodeJbig2(9, 2, new Uint8Array(5))).toThrow(UnsupportedFeatureError);
  });

  it('enforces pixel limits before reading or allocating the image', () => {
    expect(() => encodeJbig2(1024, 64, new Uint8Array(), LoadLimits.defaults.with({ maxImagePixels: 10 })))
      .toThrow(ResourceLimitError);
  });
});
