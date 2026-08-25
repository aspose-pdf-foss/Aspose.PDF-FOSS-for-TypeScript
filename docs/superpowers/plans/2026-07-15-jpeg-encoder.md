# Baseline JPEG Encoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `encodeJpeg` — a baseline (SOF0) JPEG encoder with real quantization, quality control, and optimized Huffman tables — so `Optimize({ images })` (issue `kqy`) can honor a target quality.

**Architecture:** Three internal modules. `jpegfdct.ts` owns the transform and quantization; `jpeghuffenc.ts` owns bit output and Huffman table construction; `jpegencode.ts` owns color transform, MCU assembly, marker writing, and orchestration. Nothing is exported from `index.ts`. The new code shares no module with `test/helpers/build-jpeg.ts` — see the spec's "Relationship to build-jpeg.ts".

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-jpeg-encoder-design.md`
**Issue:** aspose-pdf-foss-for-ts-aw0
**Branch:** `feat/jpeg-encoder` (already created; spec committed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext**, `strict` TypeScript. Every import specifier carries `.js` (e.g. `import { ZIGZAG } from './jpeg.js'`).
- **TDD.** Write the failing test first, watch it fail, then implement.
- **Do not modify `test/helpers/build-jpeg.ts`** or any existing `src/` file. This plan is purely additive. (`jpeg.ts` is imported, never edited.)
- `npm run typecheck` and `npm test` must both be green before the issue closes.
- **`encodeJpeg` is internal** — do not add it to `src/index.ts`, and do not update `README.md`. It has no public API surface. (Contrast: README must be kept in sync only for public APIs.)
- Match house style: terse, comment-light, one concern per file; comments state constraints the code cannot show.

## Reference Facts (verified against the tree — do not re-derive)

These were confirmed by reading the source. Later tasks depend on them.

- `ZIGZAG` is exported from `src/jpeg.ts:11`. **`ZIGZAG[k]` = the natural (row-major) index for zig-zag position `k`.**
- `idct` (`src/jpeg.ts:31`) consumes **natural-order** coefficients and normalizes by `s / 4`. Its basis is `A[k][n] = alpha(k) * cos((2n+1)kπ/16)`, `alpha(0) = 1/√2`. The matching forward transform therefore also carries `1/4`. `fdct` then `idct` reproduces the input up to rounding.
- **`DQT` is written in zig-zag order.** `parseDQT` (`src/jpeg.ts:92`) stores the table exactly as read, and `src/jpeg.ts:299` converts with `qn[ZIGZAG[k]] = q[k]`. So emit `quantNatural[ZIGZAG[k]]` for `k = 0..63`.
- `decodeJpeg(data: Uint8Array): JpegImage` where `JpegImage = { width, height, comps, data }` and `data` is interleaved 8-bit samples (`src/jpeg.ts:9`).
- `combinePlanes` (`src/jpeg.ts:334`) inverts CMYK **only** when an Adobe APP14 marker is present. We write no APP14 for CMYK, so no inversion occurs on decode.
- **Flat-block DC identity:** for a block whose samples are all `V`, after the `−128` level shift every sample is `d = V − 128`, and `F[0] = (1/4) · Σ_y Σ_x (1/√2)(1/√2) · d = 8d`. So a flat 255 block gives `DC = 8 · 127 = 1016` and all AC coefficients 0. Task 1 asserts exactly this.
- **Quality scaling uses integer division, not rounding.** libjpeg computes `(base * scale + 50) / 100` with C integer division (truncation). `Math.floor` is correct; `Math.round` is **wrong** and would make `quality: 50` return `base + 1` instead of `base`.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/jpegfdct.ts` | Annex K base quant tables, IJG quality scaling, forward DCT, quantize-to-zig-zag |
| Create `src/jpeghuffenc.ts` | `BitWriter` (`FF00` stuffing), canonical table build from `(bits, vals)`, Annex K standard tables, Annex K.2 optimal table build |
| Create `src/jpegencode.ts` | `encodeJpeg`: validation, color transform, plane padding/subsampling, MCU traversal, marker assembly |
| Create `test/helpers/build-raster.ts` | Synthetic raster builders + PSNR helper for the tests |
| Create `test/jpegfdct.test.ts` | Task 1 tests |
| Create `test/jpeghuffenc.test.ts` | Tasks 2-3 tests |
| Create `test/jpegencode.test.ts` | Tasks 4-8 tests |

---

### Task 1: Transform and quantization (`jpegfdct.ts`)

**Files:**
- Create: `src/jpegfdct.ts`
- Test: `test/jpegfdct.test.ts`

**Interfaces:**
- Consumes: `ZIGZAG`, `idct` from `src/jpeg.js`.
- Produces:
  - `QUANT_LUMA: Int32Array` (64, natural order)
  - `QUANT_CHROMA: Int32Array` (64, natural order)
  - `scaleQuantTable(base: Int32Array, quality: number): Int32Array` (natural order)
  - `fdct8x8(spatial: Float64Array, out: Float64Array): void` (natural order both sides; `spatial` is already level-shifted)
  - `quantizeBlock(coef: Float64Array, quant: Int32Array, out: Int32Array): void` (`coef`/`quant` natural order, `out` **zig-zag** order)

- [ ] **Step 1: Write the failing tests**

Create `test/jpegfdct.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jpegfdct.test.ts`
Expected: FAIL — `Failed to resolve import "../src/jpegfdct.js"`.

- [ ] **Step 3: Implement `src/jpegfdct.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jpegfdct.test.ts`
Expected: PASS (all tests in 3 describes).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jpegfdct.ts test/jpegfdct.test.ts
git commit -m "feat(jpegencode): forward DCT, Annex K quant tables, IJG quality scaling"
```

---

### Task 2: Bit output and standard Huffman tables (`jpeghuffenc.ts`)

**Files:**
- Create: `src/jpeghuffenc.ts`
- Test: `test/jpeghuffenc.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class BitWriter { readonly bytes: number[]; put(code: number, len: number): void; flush(): void }`
  - `interface HuffTable { bits: number[]; vals: number[]; enc: Map<number, HuffCode> }`
  - `interface HuffCode { code: number; len: number }`
  - `buildHuffTable(bits: number[], vals: number[]): HuffTable`
  - `STD_DC_LUMA`, `STD_AC_LUMA`, `STD_DC_CHROMA`, `STD_AC_CHROMA` — all `HuffTable`

**Note on the Annex K standard tables:** a misremembered constant here costs compression ratio, **not** correctness — the tables ship in `DHT`, so any internally valid table decodes correctly. The tests below therefore assert *validity* (prefix-free, `bits` sums to `vals.length`, no all-ones codeword) rather than byte-matching a transcription.

- [ ] **Step 1: Write the failing tests**

Create `test/jpeghuffenc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BitWriter, buildHuffTable,
  STD_DC_LUMA, STD_AC_LUMA, STD_DC_CHROMA, STD_AC_CHROMA,
} from '../src/jpeghuffenc.js';

describe('BitWriter', () => {
  it('packs bits MSB-first', () => {
    const bw = new BitWriter();
    bw.put(0b101, 3);
    bw.put(0b11010, 5);
    expect(bw.bytes).toEqual([0b10111010]);
  });

  it('stuffs a zero byte after every 0xFF', () => {
    const bw = new BitWriter();
    bw.put(0xff, 8);
    expect(bw.bytes).toEqual([0xff, 0x00]);
  });

  it('pads the final partial byte with 1-bits on flush', () => {
    const bw = new BitWriter();
    bw.put(0b1, 1);
    bw.flush();
    expect(bw.bytes).toEqual([0b11111111, 0x00]); // padding makes 0xFF, which is then stuffed
  });

  it('flush on a byte boundary emits nothing extra', () => {
    const bw = new BitWriter();
    bw.put(0b10101010, 8);
    bw.flush();
    expect(bw.bytes).toEqual([0b10101010]);
  });
});

describe('buildHuffTable', () => {
  it('assigns canonical codes in (length, order) sequence', () => {
    // 2 codes of length 2, 1 of length 3 -> 00, 01, 100
    const t = buildHuffTable([0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [7, 8, 9]);
    expect(t.enc.get(7)).toEqual({ code: 0b00, len: 2 });
    expect(t.enc.get(8)).toEqual({ code: 0b01, len: 2 });
    expect(t.enc.get(9)).toEqual({ code: 0b100, len: 3 });
  });
});

const ALL_STD = [
  ['STD_DC_LUMA', STD_DC_LUMA], ['STD_AC_LUMA', STD_AC_LUMA],
  ['STD_DC_CHROMA', STD_DC_CHROMA], ['STD_AC_CHROMA', STD_AC_CHROMA],
] as const;

describe('Annex K standard tables', () => {
  for (const [label, t] of ALL_STD) {
    it(`${label}: bits sums to vals.length, and bits has 16 entries`, () => {
      expect(t.bits.length).toBe(16);
      expect(t.bits.reduce((a, b) => a + b, 0)).toBe(t.vals.length);
      expect(t.enc.size).toBe(t.vals.length);
    });

    it(`${label}: is prefix-free and avoids the all-ones codeword`, () => {
      const seen: { code: number; len: number }[] = [];
      for (const c of t.enc.values()) {
        // No code may be an all-ones pattern (reserved as a decoder sentinel).
        expect(c.code).not.toBe((1 << c.len) - 1);
        for (const p of seen) {
          const shorter = p.len <= c.len ? p : c;
          const longer = p.len <= c.len ? c : p;
          const prefix = longer.code >>> (longer.len - shorter.len);
          expect(prefix).not.toBe(shorter.code);
        }
        seen.push(c);
      }
    });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jpeghuffenc.test.ts`
Expected: FAIL — `Failed to resolve import "../src/jpeghuffenc.js"`.

- [ ] **Step 3: Implement `src/jpeghuffenc.ts`**

```ts
export interface HuffCode { code: number; len: number }

/** A Huffman table in DHT wire form plus its symbol→code map. */
export interface HuffTable {
  /** Count of codes of each length 1..16 (index 0 = length 1). */
  bits: number[];
  /** Symbols, ordered by code length then assignment order. */
  vals: number[];
  enc: Map<number, HuffCode>;
}

/** MSB-first bit writer with JPEG's mandatory `FF00` byte stuffing. */
export class BitWriter {
  readonly bytes: number[] = [];
  private buf = 0;
  private cnt = 0;

  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.buf = (this.buf << 1) | ((code >> i) & 1);
      if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; }
    }
  }

  /** Pad the final partial byte with 1-bits. */
  flush(): void {
    if (this.cnt === 0) return;
    const pad = 8 - this.cnt;
    this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff);
    this.buf = 0; this.cnt = 0;
  }

  private emit(b: number): void {
    b &= 0xff;
    this.bytes.push(b);
    if (b === 0xff) this.bytes.push(0x00); // a raw FF would read as a marker
  }
}

/** Assign canonical codes to a (bits, vals) spec — the DHT wire format. */
export function buildHuffTable(bits: number[], vals: number[]): HuffTable {
  const enc = new Map<number, HuffCode>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) enc.set(vals[k++], { code: code++, len });
    code <<= 1;
  }
  return { bits: [...bits], vals: [...vals], enc };
}

// ---- Annex K.3 standard tables ------------------------------------------------
// Transmitted verbatim in DHT, so a transcription slip costs compression ratio,
// never correctness.

const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export const STD_DC_LUMA = buildHuffTable(
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_VALS,
);

export const STD_DC_CHROMA = buildHuffTable(
  [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], DC_VALS,
);

export const STD_AC_LUMA = buildHuffTable(
  [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);

export const STD_AC_CHROMA = buildHuffTable(
  [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
    0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
    0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jpeghuffenc.test.ts`
Expected: PASS.

If a `bits sums to vals.length` assertion fails, a standard-table transcription is off. Fix the transcription — do **not** relax the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/jpeghuffenc.ts test/jpeghuffenc.test.ts
git commit -m "feat(jpegencode): bit writer with FF00 stuffing + Annex K standard Huffman tables"
```

---

### Task 3: Optimal Huffman table construction (`jpeghuffenc.ts`)

**Files:**
- Modify: `src/jpeghuffenc.ts` (append)
- Test: `test/jpeghuffenc.test.ts` (append)

**Interfaces:**
- Consumes: `HuffTable`, `buildHuffTable` from Task 2.
- Produces: `buildOptimalHuffTable(freq: Int32Array): HuffTable` — `freq` has length **257**; entries 0..255 are symbol counts, index 256 is reserved and must be left 0 by the caller (the function sets it).

**Why the phantom symbol:** a decoder treats the all-ones codeword as a sentinel, so no real symbol may receive it. Reserving `freq[256] = 1` forces the phantom to take that slot; it is removed from `bits` at the end, and never appears in `vals`.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpeghuffenc.test.ts`:

```ts
import { buildOptimalHuffTable } from '../src/jpeghuffenc.js';

const freqOf = (counts: Record<number, number>): Int32Array => {
  const f = new Int32Array(257);
  for (const [s, n] of Object.entries(counts)) f[Number(s)] = n;
  return f;
};

const isPrefixFree = (t: { enc: Map<number, { code: number; len: number }> }): boolean => {
  const all = [...t.enc.values()];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    const shorter = a.len <= b.len ? a : b;
    const longer = a.len <= b.len ? b : a;
    if ((longer.code >>> (longer.len - shorter.len)) === shorter.code) return false;
  }
  return true;
};

describe('buildOptimalHuffTable', () => {
  it('gives a more frequent symbol a code no longer than a rarer one', () => {
    const t = buildOptimalHuffTable(freqOf({ 1: 1000, 2: 100, 3: 10, 4: 1 }));
    const len = (s: number) => t.enc.get(s)!.len;
    expect(len(1)).toBeLessThanOrEqual(len(2));
    expect(len(2)).toBeLessThanOrEqual(len(3));
    expect(len(3)).toBeLessThanOrEqual(len(4));
  });

  it('emits only symbols with a nonzero count, and never the phantom', () => {
    const t = buildOptimalHuffTable(freqOf({ 5: 3, 9: 7 }));
    expect(new Set(t.vals)).toEqual(new Set([5, 9]));
    expect(t.vals).not.toContain(256);
    expect(t.bits.reduce((a, b) => a + b, 0)).toBe(t.vals.length);
  });

  it('is prefix-free and never assigns the all-ones codeword', () => {
    const t = buildOptimalHuffTable(freqOf({ 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 }));
    expect(isPrefixFree(t)).toBe(true);
    for (const c of t.enc.values()) expect(c.code).not.toBe((1 << c.len) - 1);
  });

  it('limits code length to 16 bits on a Fibonacci histogram', () => {
    // Fibonacci frequencies are the classic worst case: an unconstrained build
    // produces a degenerate ~n-deep tree, well past 16 bits.
    const f = new Int32Array(257);
    let a = 1, b = 1;
    for (let s = 0; s < 40; s++) { f[s] = a; const n = a + b; a = b; b = n; }
    const t = buildOptimalHuffTable(f);
    for (const c of t.enc.values()) {
      expect(c.len).toBeGreaterThanOrEqual(1);
      expect(c.len).toBeLessThanOrEqual(16);
    }
    expect(t.bits.length).toBe(16);
    expect(t.bits.reduce((x, y) => x + y, 0)).toBe(t.vals.length);
    expect(isPrefixFree(t)).toBe(true);
  });

  it('handles a single-symbol histogram', () => {
    const t = buildOptimalHuffTable(freqOf({ 42: 9 }));
    expect(t.vals).toEqual([42]);
    expect(t.enc.get(42)!.len).toBeGreaterThanOrEqual(1);
    expect(t.enc.get(42)!.code).not.toBe((1 << t.enc.get(42)!.len) - 1);
  });

  it('does not mutate the caller frequency array', () => {
    const f = freqOf({ 1: 5, 2: 4 });
    const before = [...f];
    buildOptimalHuffTable(f);
    expect([...f]).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jpeghuffenc.test.ts`
Expected: FAIL — `buildOptimalHuffTable is not exported` / not a function.

- [ ] **Step 3: Append the implementation to `src/jpeghuffenc.ts`**

```ts
const MAX_CLEN = 32;

/**
 * Build a length-limited optimal Huffman table from symbol frequencies, per
 * Annex K.2. `freq` is length 257: 0..255 are symbol counts, 256 is reserved.
 * The caller's array is not mutated.
 *
 * Index 256 is a phantom symbol given count 1 so that it, and never a real
 * symbol, receives the all-ones codeword a decoder reserves as a sentinel. It is
 * dropped from `bits` before the table is returned.
 */
export function buildOptimalHuffTable(freq: Int32Array): HuffTable {
  const f = new Int32Array(257);
  f.set(freq.subarray(0, 257));
  f[256] = 1; // phantom: reserves the all-ones codeword

  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);

  // Repeatedly merge the two least-frequent live nodes, tracking each merged
  // chain through `others` so every member's code length grows together.
  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
    let c2 = -1; v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
    if (c2 < 0) break;

    f[c1] += f[c2];
    f[c2] = 0;

    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }

  // Histogram of code lengths. Index i holds the count of i-bit codes.
  const bits = new Int32Array(MAX_CLEN + 1);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;

  // Fold codes longer than 16 bits back under the limit by repeatedly promoting
  // a shorter code into a longer slot — the Annex K.2 length-limiting procedure.
  let i = MAX_CLEN;
  for (; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  // Drop the phantom, which now owns the longest code.
  while (bits[i] === 0) i--;
  bits[i]--;

  const outBits: number[] = [];
  for (let n = 1; n <= 16; n++) outBits.push(bits[n]);

  // Symbols ordered by code length, then by symbol value.
  const vals: number[] = [];
  for (let len = 1; len <= MAX_CLEN; len++)
    for (let s = 0; s <= 255; s++) if (codesize[s] === len) vals.push(s);

  return buildHuffTable(outBits, vals);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jpeghuffenc.test.ts`
Expected: PASS (Task 2 and Task 3 describes).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/jpeghuffenc.ts test/jpeghuffenc.test.ts
git commit -m "feat(jpegencode): Annex K.2 optimal Huffman tables with 16-bit length limiting"
```

---

### Task 4: Grayscale end-to-end (`jpegencode.ts`)

**Files:**
- Create: `src/jpegencode.ts`
- Create: `test/helpers/build-raster.ts`
- Test: `test/jpegencode.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3; `decodeJpeg` from `src/jpeg.js` (tests only).
- Produces:
  - `type JpegKind = 'gray' | 'rgb' | 'cmyk'`
  - `interface JpegEncodeOptions { quality?: number; subsampling?: '4:4:4' | '4:2:0'; optimizeHuffman?: boolean }`
  - `encodeJpeg(width: number, height: number, samples: Uint8Array, kind: JpegKind, opts?: JpegEncodeOptions): Uint8Array`
  - From `test/helpers/build-raster.ts`: `grayGradient(w, h): Uint8Array`, `rgbGradient(w, h): Uint8Array`, `cmykGradient(w, h): Uint8Array`, `flatGray(w, h, v): Uint8Array`, `psnr(a: Uint8Array, b: Uint8Array): number`

This task implements the full pipeline but wires only the `gray` path; Tasks 5-6 add `rgb` and `cmyk`. `optimizeHuffman` defaults to **false** here and flips to **true** in Task 7, so this task's output is stable against a fixed table.

- [ ] **Step 1: Write the raster helper**

Create `test/helpers/build-raster.ts`:

```ts
// Synthetic rasters + a PSNR measure for the JPEG encoder tests. Zero deps.

/** Horizontal+vertical gray ramp. */
export function grayGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    px[y * w + x] = Math.round(((x / Math.max(1, w - 1)) * 0.5 + (y / Math.max(1, h - 1)) * 0.5) * 255);
  return px;
}

export function flatGray(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h).fill(v);
}

/** Smooth RGB ramp: R along x, G along y, B constant mid. */
export function rgbGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    px[i] = Math.round((x / Math.max(1, w - 1)) * 255);
    px[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
    px[i + 2] = 128;
  }
  return px;
}

export function cmykGradient(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    px[i] = Math.round((x / Math.max(1, w - 1)) * 255);
    px[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
    px[i + 2] = 64;
    px[i + 3] = 32;
  }
  return px;
}

/** Peak signal-to-noise ratio in dB over two equal-length 8-bit buffers. */
export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`psnr: length mismatch ${a.length} vs ${b.length}`);
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/jpegencode.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJpeg } from '../src/jpeg.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { grayGradient, flatGray, psnr } from './helpers/build-raster.js';

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: FAIL — `Failed to resolve import "../src/jpegencode.js"`.

- [ ] **Step 4: Implement `src/jpegencode.ts`**

```ts
import { ZIGZAG } from './jpeg.js';
import {
  QUANT_LUMA, QUANT_CHROMA, scaleQuantTable, fdct8x8, quantizeBlock,
} from './jpegfdct.js';
import {
  BitWriter, HuffTable, buildOptimalHuffTable,
  STD_DC_LUMA, STD_AC_LUMA, STD_DC_CHROMA, STD_AC_CHROMA,
} from './jpeghuffenc.js';

export type JpegKind = 'gray' | 'rgb' | 'cmyk';

export interface JpegEncodeOptions {
  /** 1..100 on the IJG scale. Default 75. */
  quality?: number;
  /** 3-component only; ignored for gray and CMYK. Default '4:2:0'. */
  subsampling?: '4:4:4' | '4:2:0';
  /** Per-image Huffman tables. Default true. */
  optimizeHuffman?: boolean;
}

const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

/** One component: its sample plane plus the table slots it uses. */
interface Plane {
  data: Uint8Array;
  w: number;
  h: number;
  /** Sampling factors relative to the frame. */
  hs: number;
  vs: number;
  /** Quant table slot (0 = luma, 1 = chroma). */
  tq: 0 | 1;
  /** DC/AC Huffman table slot. */
  td: 0 | 1;
}

/** Split interleaved samples into per-component planes, applying the JPEG colour
 *  transform. Gray and CMYK pass through; CMYK is deliberately not inverted and
 *  carries no APP14 (see the spec's "Colorspace conventions"). */
function toPlanes(
  width: number, height: number, samples: Uint8Array, kind: JpegKind, sub420: boolean,
): Plane[] {
  const px = width * height;
  if (kind === 'gray') {
    return [{ data: samples.slice(), w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 }];
  }
  if (kind === 'cmyk') {
    const out: Plane[] = [];
    for (let c = 0; c < 4; c++) {
      const d = new Uint8Array(px);
      for (let i = 0; i < px; i++) d[i] = samples[i * 4 + c];
      out.push({ data: d, w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 });
    }
    return out;
  }
  const Y = new Uint8Array(px), Cb = new Uint8Array(px), Cr = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    const R = samples[i * 3], G = samples[i * 3 + 1], B = samples[i * 3 + 2];
    Y[i] = clamp8(0.299 * R + 0.587 * G + 0.114 * B);
    Cb[i] = clamp8(-0.168736 * R - 0.331264 * G + 0.5 * B + 128);
    Cr[i] = clamp8(0.5 * R - 0.418688 * G - 0.081312 * B + 128);
  }
  if (!sub420) {
    return [
      { data: Y, w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 },
      { data: Cb, w: width, h: height, hs: 1, vs: 1, tq: 1, td: 1 },
      { data: Cr, w: width, h: height, hs: 1, vs: 1, tq: 1, td: 1 },
    ];
  }
  const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
  return [
    { data: Y, w: width, h: height, hs: 2, vs: 2, tq: 0, td: 0 },
    { data: box2x2(Cb, width, height), w: cw, h: ch, hs: 1, vs: 1, tq: 1, td: 1 },
    { data: box2x2(Cr, width, height), w: cw, h: ch, hs: 1, vs: 1, tq: 1, td: 1 },
  ];
}

const clamp8 = (v: number): number => {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

/** Box-average a plane 2x2, rounding up odd edges by clamping the source index. */
function box2x2(src: Uint8Array, w: number, h: number): Uint8Array {
  const dw = Math.ceil(w / 2), dh = Math.ceil(h / 2);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = 2 * x, y0 = 2 * y;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    out[y * dw + x] = Math.round(
      (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) / 4,
    );
  }
  return out;
}

/** Sample a plane with edge replication, so partial blocks extend the margin. */
const at = (p: Plane, x: number, y: number): number =>
  p.data[Math.min(y, p.h - 1) * p.w + Math.min(x, p.w - 1)];

const category = (v: number): number => { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; };
const valueBits = (v: number, n: number): number => (v < 0 ? v + (1 << n) - 1 : v);

/** Encode interleaved 8-bit samples as a baseline JPEG. */
export function encodeJpeg(
  width: number, height: number, samples: Uint8Array, kind: JpegKind,
  opts: JpegEncodeOptions = {},
): Uint8Array {
  const nch = CHANNELS[kind];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new TypeError('encodeJpeg: width and height must be positive integers');
  if (samples.length !== width * height * nch)
    throw new TypeError(
      `encodeJpeg: expected ${width * height * nch} samples, got ${samples.length}`,
    );

  const quality = opts.quality ?? 75;
  const sub420 = kind === 'rgb' && (opts.subsampling ?? '4:2:0') === '4:2:0';
  const optimize = opts.optimizeHuffman ?? false; // Task 7 flips this default to true

  const planes = toPlanes(width, height, samples, kind, sub420);
  const maxH = Math.max(...planes.map((p) => p.hs));
  const maxV = Math.max(...planes.map((p) => p.vs));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerCol = Math.ceil(height / (8 * maxV));

  const quant: Int32Array[] = [scaleQuantTable(QUANT_LUMA, quality)];
  const usesChroma = planes.some((p) => p.tq === 1);
  if (usesChroma) quant.push(scaleQuantTable(QUANT_CHROMA, quality));

  // FDCT + quantize every block of every plane, in raster order per plane.
  const coefs: Int32Array[][] = planes.map((p) => {
    const bpl = mcusPerLine * p.hs, bpc = mcusPerCol * p.vs;
    const q = quant[p.tq];
    const spatial = new Float64Array(64);
    const freq = new Float64Array(64);
    const out: Int32Array[] = [];
    for (let br = 0; br < bpc; br++) for (let bc = 0; bc < bpl; bc++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
        spatial[y * 8 + x] = at(p, bc * 8 + x, br * 8 + y) - 128;
      fdct8x8(spatial, freq);
      const zz = new Int32Array(64);
      quantizeBlock(freq, q, zz);
      out.push(zz);
    }
    return out;
  });

  const blocksPerLine = planes.map((p) => mcusPerLine * p.hs);

  // Walk MCUs, handing each block to `onBlock` in scan order.
  const traverse = (onBlock: (pi: number, zz: Int32Array) => void): void => {
    for (let my = 0; my < mcusPerCol; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let pi = 0; pi < planes.length; pi++) {
        const p = planes[pi];
        for (let by = 0; by < p.vs; by++) for (let bx = 0; bx < p.hs; bx++)
          onBlock(pi, coefs[pi][(my * p.vs + by) * blocksPerLine[pi] + (mx * p.hs + bx)]);
      }
  };

  /** Feed one block's symbols to `dc`/`ac` sinks; `emit` also writes the bits. */
  const codeBlock = (
    zz: Int32Array, pred: number,
    dc: (sym: number) => void, ac: (sym: number) => void,
    emit?: { bw: BitWriter; dcT: HuffTable; acT: HuffTable },
  ): number => {
    const diff = zz[0] - pred;
    const dcat = category(diff);
    dc(dcat);
    if (emit) {
      const c = emit.dcT.enc.get(dcat)!;
      emit.bw.put(c.code, c.len);
      if (dcat) emit.bw.put(valueBits(diff, dcat), dcat);
    }
    let k = 1;
    while (k < 64) {
      let run = 0;
      while (k < 64 && zz[k] === 0) { run++; k++; }
      if (k === 64) {
        ac(0x00); // EOB
        if (emit) { const c = emit.acT.enc.get(0x00)!; emit.bw.put(c.code, c.len); }
        break;
      }
      while (run > 15) {
        ac(0xf0); // ZRL
        if (emit) { const c = emit.acT.enc.get(0xf0)!; emit.bw.put(c.code, c.len); }
        run -= 16;
      }
      const acat = category(zz[k]);
      const sym = (run << 4) | acat;
      ac(sym);
      if (emit) {
        const c = emit.acT.enc.get(sym)!;
        emit.bw.put(c.code, c.len);
        emit.bw.put(valueBits(zz[k], acat), acat);
      }
      k++;
    }
    return zz[0];
  };

  // ---- Table selection ----
  let dcTables: HuffTable[], acTables: HuffTable[];
  if (optimize) {
    const nSlots = usesChroma ? 2 : 1;
    const dcFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const acFreq = Array.from({ length: nSlots }, () => new Int32Array(257));
    const pred = new Array(planes.length).fill(0);
    traverse((pi, zz) => {
      const slot = planes[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], (s) => dcFreq[slot][s]++, (s) => acFreq[slot][s]++);
    });
    dcTables = dcFreq.map(buildOptimalHuffTable);
    acTables = acFreq.map(buildOptimalHuffTable);
  } else {
    dcTables = usesChroma ? [STD_DC_LUMA, STD_DC_CHROMA] : [STD_DC_LUMA];
    acTables = usesChroma ? [STD_AC_LUMA, STD_AC_CHROMA] : [STD_AC_LUMA];
  }

  // ---- Entropy pass ----
  const bw = new BitWriter();
  {
    const pred = new Array(planes.length).fill(0);
    const noop = () => {};
    traverse((pi, zz) => {
      const slot = planes[pi].td;
      pred[pi] = codeBlock(zz, pred[pi], noop, noop, {
        bw, dcT: dcTables[slot], acT: acTables[slot],
      });
    });
    bw.flush();
  }

  // ---- Assemble ----
  const out: number[] = [];
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);

  out.push(0xff, 0xd8); // SOI

  if (kind !== 'cmyk') { // APP0/JFIF
    out.push(0xff, 0xe0); u16(16);
    out.push(0x4a, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
    out.push(1, 1, 0); // version 1.1, no density units
    u16(1); u16(1); // X/Y density
    out.push(0, 0); // no thumbnail
  }

  // DQT — written in zig-zag order; parseDQT (jpeg.ts:92) stores wire order and
  // jpeg.ts:299 de-zigzags with qn[ZIGZAG[k]] = q[k].
  for (let t = 0; t < quant.length; t++) {
    out.push(0xff, 0xdb); u16(2 + 1 + 64);
    out.push(t); // 8-bit precision (Pq=0), table id t
    for (let k = 0; k < 64; k++) out.push(quant[t][ZIGZAG[k]]);
  }

  out.push(0xff, 0xc0); u16(8 + planes.length * 3); // SOF0
  out.push(8); u16(height); u16(width); out.push(planes.length);
  for (let i = 0; i < planes.length; i++)
    out.push(i + 1, (planes[i].hs << 4) | planes[i].vs, planes[i].tq);

  const writeDHT = (tc: number, th: number, t: HuffTable) => {
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length);
    out.push((tc << 4) | th);
    for (const b of t.bits) out.push(b);
    for (const v of t.vals) out.push(v);
  };
  for (let t = 0; t < dcTables.length; t++) writeDHT(0, t, dcTables[t]);
  for (let t = 0; t < acTables.length; t++) writeDHT(1, t, acTables[t]);

  out.push(0xff, 0xda); u16(6 + planes.length * 2); // SOS
  out.push(planes.length);
  for (let i = 0; i < planes.length; i++)
    out.push(i + 1, (planes[i].td << 4) | planes[i].td);
  out.push(0, 63, 0); // Ss, Se, Ah/Al

  for (const b of bw.bytes) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/jpegencode.ts test/jpegencode.test.ts test/helpers/build-raster.ts
git commit -m "feat(jpegencode): baseline grayscale encode via encodeJpeg"
```

---

### Task 5: RGB with 4:4:4 and 4:2:0

**Files:**
- Modify: `src/jpegencode.ts` (no change expected — the Task 4 implementation already covers `rgb`; this task proves it and fixes what it finds)
- Test: `test/jpegencode.test.ts` (append)

**Interfaces:**
- Consumes: `encodeJpeg` from Task 4.
- Produces: nothing new.

The `rgb` path is written in Task 4 but never exercised. This task is where it is proven. If a test fails, fix `src/jpegencode.ts` — do not weaken the assertion.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpegencode.test.ts`:

```ts
import { rgbGradient } from './helpers/build-raster.js';

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
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: the RGB describe passes if Task 4's plane/MCU code is correct. If any fail, debug `toPlanes` / `traverse` / SOF sampling factors in `src/jpegencode.ts`.

- [ ] **Step 3: Commit**

```bash
git add test/jpegencode.test.ts src/jpegencode.ts
git commit -m "test(jpegencode): RGB 4:4:4 and 4:2:0 round-trip coverage"
```

---

### Task 6: CMYK

**Files:**
- Modify: `src/jpegencode.ts` (only if a test fails)
- Test: `test/jpegencode.test.ts` (append)

**Interfaces:**
- Consumes: `encodeJpeg` from Task 4.
- Produces: nothing new.

The load-bearing assertion is **no APP14**: `combinePlanes` (`jpeg.ts:334`) inverts CMYK only when APP14 is present, so emitting one would silently invert the round trip.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpegencode.test.ts`:

```ts
import { cmykGradient } from './helpers/build-raster.js';

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
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/jpegencode.test.ts src/jpegencode.ts
git commit -m "test(jpegencode): CMYK round-trip, no APP14, no inversion"
```

---

### Task 7: Turn on optimized Huffman by default

**Files:**
- Modify: `src/jpegencode.ts` (the `optimize` default)
- Test: `test/jpegencode.test.ts` (append)

**Interfaces:**
- Consumes: `buildOptimalHuffTable` (Task 3), `encodeJpeg` (Task 4).
- Produces: nothing new. `optimizeHuffman` now defaults to `true`.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpegencode.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify the default test fails**

Run: `npx vitest run test/jpegencode.test.ts -t "optimized Huffman"`
Expected: FAIL — "is the default" fails because `optimize` still defaults to `false`.

- [ ] **Step 3: Flip the default**

In `src/jpegencode.ts`, change:

```ts
  const optimize = opts.optimizeHuffman ?? false; // Task 7 flips this default to true
```

to:

```ts
  const optimize = opts.optimizeHuffman ?? true;
```

- [ ] **Step 4: Run the full file**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: PASS — every describe, including Tasks 4-6 (which pin `optimizeHuffman: false` explicitly and so are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/jpegencode.ts test/jpegencode.test.ts
git commit -m "feat(jpegencode): default to per-image optimized Huffman tables"
```

---

### Task 8: Quality behaviour and edge geometry

**Files:**
- Modify: `src/jpegencode.ts` (only if a test fails)
- Test: `test/jpegencode.test.ts` (append)

**Interfaces:**
- Consumes: `encodeJpeg` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/jpegencode.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/jpegencode.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; the whole vitest suite is green, including the pre-existing `test/jpeg.test.ts` (this plan touches no existing file, so nothing there should move).

- [ ] **Step 4: Commit**

```bash
git add test/jpegencode.test.ts src/jpegencode.ts
git commit -m "test(jpegencode): quality floors, monotonicity, and partial-block geometry"
```

- [ ] **Step 5: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-aw0
git pull --rebase
git push -u origin feat/jpeg-encoder
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **`kqy` stays blocked** until this lands; it is the consumer and gets its own spec. Do not start image downsampling here.
- **`w6m`** (real-world JPEG fixtures) is a separate, non-blocking issue. Do not add a dev dependency to chase interop proof in this plan.
- If you find yourself wanting to import from `test/helpers/build-jpeg.ts`, stop and re-read the spec's "Relationship to build-jpeg.ts". The separation is deliberate.
- `README.md` is intentionally **not** updated: `encodeJpeg` is internal and has no public API surface.
