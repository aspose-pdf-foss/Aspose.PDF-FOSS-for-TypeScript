import { describe, it, expect } from 'vitest';
import { idct, ZIGZAG } from '../src/jpeg.js';
import {
  QUANT_LUMA, QUANT_CHROMA, scaleQuantTable, fdct8x8, quantizeBlock,
} from '../src/jpegfdct.js';

describe('quantization tables', () => {
  it('are 64 entries and start with the Annex K corner values', () => {
    expect(QUANT_LUMA.length).toBe(64);
    expect(QUANT_CHROMA.length).toBe(64);
    expect(QUANT_LUMA[0]).toBe(16);
    expect(QUANT_CHROMA[0]).toBe(17);
  });

  it('quality 50 reproduces the base table exactly (integer-division identity)', () => {
    // scale = 200 - 2*50 = 100, so floor((base*100 + 50)/100) === base.
    expect([...scaleQuantTable(QUANT_LUMA, 50)]).toEqual([...QUANT_LUMA]);
    expect([...scaleQuantTable(QUANT_CHROMA, 50)]).toEqual([...QUANT_CHROMA]);
  });

  it('quality 100 clamps every entry to 1', () => {
    const t = scaleQuantTable(QUANT_LUMA, 100);
    expect([...t]).toEqual(new Array(64).fill(1));
  });

  it('lower quality never yields a smaller divisor', () => {
    const hi = scaleQuantTable(QUANT_LUMA, 90);
    const lo = scaleQuantTable(QUANT_LUMA, 20);
    for (let i = 0; i < 64; i++) expect(lo[i]).toBeGreaterThanOrEqual(hi[i]);
  });

  it('clamps into 1..255 at both extremes', () => {
    for (const q of [1, 25, 50, 75, 100]) {
      for (const v of scaleQuantTable(QUANT_LUMA, q)) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(255);
      }
    }
  });

  it('clamps out-of-range quality rather than throwing', () => {
    expect([...scaleQuantTable(QUANT_LUMA, 0)]).toEqual([...scaleQuantTable(QUANT_LUMA, 1)]);
    expect([...scaleQuantTable(QUANT_LUMA, 999)]).toEqual([...scaleQuantTable(QUANT_LUMA, 100)]);
  });
});

describe('fdct8x8', () => {
  it('gives DC = 8 * (V-128) and zero AC for a flat block', () => {
    // Hand-derived, independent of idct: F[0] = (1/4) * 64 * (1/2) * d = 8d.
    const spatial = new Float64Array(64).fill(255 - 128);
    const out = new Float64Array(64);
    fdct8x8(spatial, out);
    expect(out[0]).toBeCloseTo(1016, 6);
    for (let i = 1; i < 64; i++) expect(out[i]).toBeCloseTo(0, 6);
  });

  it('inverts through idct to within a rounding step', () => {
    const spatial = new Float64Array(64);
    for (let i = 0; i < 64; i++) spatial[i] = ((i * 37) % 256) - 128;
    const coef = new Float64Array(64);
    fdct8x8(spatial, coef);
    const rounded = new Int32Array(64);
    for (let i = 0; i < 64; i++) rounded[i] = Math.round(coef[i]);
    const back: number[] = new Array(64).fill(0);
    idct(rounded, 0, back, 128, 255);
    for (let i = 0; i < 64; i++) expect(Math.abs(back[i] - (spatial[i] + 128))).toBeLessThanOrEqual(1);
  });
});

describe('quantizeBlock', () => {
  it('divides by the natural-order table and emits zig-zag order', () => {
    const coef = new Float64Array(64);
    for (let i = 0; i < 64; i++) coef[i] = i * 10;
    const quant = new Int32Array(64).fill(10);
    const out = new Int32Array(64);
    quantizeBlock(coef, quant, out);
    for (let k = 0; k < 64; k++) expect(out[k]).toBe(ZIGZAG[k]);
  });

  it('rounds to nearest rather than truncating', () => {
    const coef = new Float64Array(64);
    coef[0] = 17; // 17/10 = 1.7 -> 2
    const quant = new Int32Array(64).fill(10);
    const out = new Int32Array(64);
    quantizeBlock(coef, quant, out);
    expect(out[0]).toBe(2);
  });
});
