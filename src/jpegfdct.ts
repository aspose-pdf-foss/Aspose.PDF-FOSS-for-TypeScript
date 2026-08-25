import { ZIGZAG } from './jpeg.js';

// Annex K.1 Table K.1 — luminance base quantization table, natural (row-major) order.
export const QUANT_LUMA = new Int32Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]);

// Annex K.1 Table K.2 — chrominance base quantization table, natural order.
export const QUANT_CHROMA = new Int32Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]);

/**
 * Scale a base table by IJG quality (1..100, clamped). Natural order in and out.
 * The division truncates, matching libjpeg's C integer division: that is what
 * makes quality 50 an identity on the base table.
 */
export function scaleQuantTable(base: Int32Array, quality: number): Int32Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    const v = Math.floor((base[i] * scale + 50) / 100);
    out[i] = v < 1 ? 1 : v > 255 ? 255 : v;
  }
  return out;
}

// A[k][n] = alpha(k) * cos((2n+1)kπ/16); alpha(0)=1/√2 else 1. Mirrors idct (jpeg.ts:18).
const A: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < 8; k++) {
    t[k] = []; const a = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) t[k][n] = a * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return t;
})();

/**
 * Forward DCT of one already level-shifted 8×8 block; `spatial` and `out` are
 * natural order. Carries the same 1/4 normalization as idct (jpeg.ts:31), so the
 * two are an exact pair. Encoding happens once per image, so this stays the
 * readable O(n⁴) form rather than a fast AAN factorization.
 */
export function fdct8x8(spatial: Float64Array, out: Float64Array): void {
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < 8; y++) {
      const au = A[u][y];
      for (let x = 0; x < 8; x++) s += au * A[v][x] * spatial[y * 8 + x];
    }
    out[u * 8 + v] = s / 4;
  }
}

/** Quantize natural-order coefficients into zig-zag-ordered integers. */
export function quantizeBlock(coef: Float64Array, quant: Int32Array, out: Int32Array): void {
  for (let k = 0; k < 64; k++) {
    const n = ZIGZAG[k];
    out[k] = Math.round(coef[n] / quant[n]);
  }
}
