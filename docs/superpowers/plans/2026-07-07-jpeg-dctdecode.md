# JPEG (DCTDecode) Baseline Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a from-scratch baseline JPEG decoder so partially-covered `DCTDecode` images can be decoded, blanked, and re-encoded by the existing redaction path (issue `aspose-pdf-foss-for-ts-b3b`).

**Architecture:** A pure `src/jpeg.ts` decoder (`decodeJpeg(bytes) → {width,height,comps,data}`) with no `Document` coupling, wired into `decodeImageRgba` in `src/raster.ts` as a branch before the `NO_RASTER_DECODER` guard. Tests drive it with a minimal in-repo baseline JPEG encoder in `test/helpers/build-jpeg.ts` (round-trip). Nothing else in the pipeline changes — `redact.ts` already decodes → blanks → re-encodes and simply stops throwing for JPEG.

**Tech Stack:** TypeScript (ESM/NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only; the JPEG encoder lives under `test/`.

## Global Constraints

- **Zero runtime deps:** `src/jpeg.ts` imports only from `./errors.js`. No npm packages, no `node:` modules needed in the decoder.
- **ESM + NodeNext:** every relative import specifier carries the `.js` extension (e.g. `import { decodeJpeg } from './jpeg.js'`).
- **Errors:** throw `UnsupportedFeatureError` (unsupported coding process/precision) or `PdfParseError` (malformed/truncated) from `./errors.js` — the public error types.
- **Scope:** baseline sequential DCT (SOF0/SOF1), 8-bit only. Progressive (SOF2), arithmetic (SOF9–11), lossless/differential/hierarchical, and 12-bit throw `UnsupportedFeatureError`. Progressive is follow-up `aspose-pdf-foss-for-ts-3ee`.
- **Quality gates:** `npm run typecheck` and `npm test` must both be green before closing the issue. Target one file with `npx vitest run test/<name>.test.ts`.
- **Commit style:** end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

- **Create `test/helpers/build-jpeg.ts`** — minimal baseline JPEG *encoder* fixture builder (grayscale / YCbCr-RGB / CMYK-Adobe, optional 4:2:0 chroma subsampling, optional restart interval). Test-only.
- **Create `src/jpeg.ts`** — the baseline JPEG decoder. Pure; imports only `./errors.js`.
- **Create `test/jpeg.test.ts`** — decoder unit tests via encoder round-trip.
- **Modify `src/raster.ts`** — add a `DCTDecode` branch in `decodeImageRgba`.
- **Modify `test/redact-image.test.ts`** — add JPEG partial-redaction success tests; relabel the two existing "malformed JPEG throws" cases.
- **Modify `README.md`** — narrow the JPEG partial-redaction exclusion to progressive/arithmetic only.

Shared math (8×8 DCT basis table, zig-zag order) is intentionally duplicated between `src/jpeg.ts` (decode/IDCT) and `test/helpers/build-jpeg.ts` (encode/FDCT): the encoder is test-only and must not import from `src`, and the two blocks are ~15 lines each.

---

## Task 1: Baseline JPEG encoder (test fixture builder)

**Files:**
- Create: `test/helpers/build-jpeg.ts`
- Test: `test/helpers/build-jpeg.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces:
  ```ts
  export interface JpegEncodeOptions {
    width: number; height: number;
    comps: 1 | 3 | 4;          // 1=gray, 3=RGB, 4=CMYK (0=no ink, 255=full ink)
    pixels: Uint8Array;        // length width*height*comps, interleaved, row 0 = top
    subsample?: boolean;       // comps===3 only: 4:2:0 luma (h=v=2), chroma 1×1
    restartInterval?: number;  // MCUs between RSTn markers; 0/undefined = none
  }
  export function encodeBaselineJpeg(o: JpegEncodeOptions): Uint8Array;
  ```
  Output is a valid baseline (SOF0) JPEG: SOI, optional APP14-Adobe (transform 1 for RGB, 0 for CMYK), DQT (all-ones quant table — no quantization loss beyond rounding), SOF0, DHT (fixed-length canonical Huffman built from the symbols actually used), optional DRI, SOS, entropy-coded data, EOI. CMYK is stored Adobe-inverted (`255 - value`).

- [ ] **Step 1: Write the failing structural test**

Create `test/helpers/build-jpeg.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encodeBaselineJpeg } from './build-jpeg.js';

describe('encodeBaselineJpeg (fixture builder)', () => {
  it('emits a baseline JPEG with SOI/EOI, SOF0, and the given dimensions', () => {
    const w = 8, h = 8;
    const pixels = new Uint8Array(w * h); // grayscale flat
    pixels.fill(120);
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels });

    expect(jpg[0]).toBe(0xff); expect(jpg[1]).toBe(0xd8);            // SOI
    expect(jpg[jpg.length - 2]).toBe(0xff); expect(jpg[jpg.length - 1]).toBe(0xd9); // EOI

    // Find SOF0 (FF C0) and read its 16-bit height/width.
    let sof = -1;
    for (let i = 2; i + 1 < jpg.length; i++) if (jpg[i] === 0xff && jpg[i + 1] === 0xc0) { sof = i; break; }
    expect(sof).toBeGreaterThan(0);
    const height = (jpg[sof + 5] << 8) | jpg[sof + 6];
    const width  = (jpg[sof + 7] << 8) | jpg[sof + 8];
    expect(height).toBe(h); expect(width).toBe(w);
    expect(jpg[sof + 9]).toBe(1); // component count
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/helpers/build-jpeg.test.ts`
Expected: FAIL — `encodeBaselineJpeg` is not defined / module not found.

- [ ] **Step 3: Implement the encoder**

Create `test/helpers/build-jpeg.ts`:
```ts
// Minimal baseline (SOF0) JPEG encoder for tests. Zero deps. Not for production:
// uses an all-ones quantization table (lossless except DCT rounding) and simple
// fixed-length canonical Huffman tables built from the symbols actually used.

export interface JpegEncodeOptions {
  width: number; height: number;
  comps: 1 | 3 | 4;
  pixels: Uint8Array;
  subsample?: boolean;
  restartInterval?: number;
}

// Zig-zag scan order: natural (row-major) index for each zig-zag position.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// A[k][n] = alpha(k) * cos((2n+1)kπ/16); alpha(0)=1/√2 else 1.
const A: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < 8; k++) {
    t[k] = []; const a = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) t[k][n] = a * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return t;
})();

const clamp = (v: number) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };

// Forward DCT of one 8×8 block of spatial samples (0..255) → 64 coeffs in zig-zag
// order, quantized by an all-ones table (i.e. rounded to integers).
function fdct(spatial: number[], out: Int32Array): void {
  const F = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) {
    let s = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += A[u][y] * A[v][x] * (spatial[y * 8 + x] - 128);
    F[u * 8 + v] = s / 4;
  }
  for (let k = 0; k < 64; k++) out[k] = Math.round(F[ZIGZAG[k]]);
}

function category(v: number): number { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; }
function valueBits(v: number, n: number): number { return v < 0 ? v + (1 << n) - 1 : v; }

// Fixed-length canonical Huffman: assign every used symbol a code of length L,
// where 2^L - 1 >= count (so the all-ones code is never used — a valid JPEG table).
function fixedHuff(syms: Set<number>): { bits: number[]; vals: number[]; enc: Map<number, { code: number; len: number }> } {
  const vals = [...syms].sort((a, b) => a - b);
  const n = vals.length;
  let L = 1; while ((1 << L) - 1 < n) L++;
  const bits = new Array(16).fill(0); bits[L - 1] = n;
  const enc = new Map<number, { code: number; len: number }>();
  for (let i = 0; i < n; i++) enc.set(vals[i], { code: i, len: L });
  return { bits, vals, enc };
}

class BitWriter {
  bytes: number[] = [];
  private buf = 0; private cnt = 0;
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) { this.buf = (this.buf << 1) | ((code >> i) & 1); if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; } }
  }
  private emit(b: number): void { b &= 0xff; this.bytes.push(b); if (b === 0xff) this.bytes.push(0); } // byte-stuffing
  flush(): void { if (this.cnt > 0) { const pad = 8 - this.cnt; this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff); this.buf = 0; this.cnt = 0; } }
}

export function encodeBaselineJpeg(o: JpegEncodeOptions): Uint8Array {
  const { width, height, pixels } = o;
  const ri = o.restartInterval ?? 0;

  // Build component planes in JPEG component space.
  let planes: { data: number[]; h: number; v: number }[];
  let adobe: number | undefined;
  if (o.comps === 1) {
    planes = [{ data: Array.from(pixels.subarray(0, width * height)), h: 1, v: 1 }];
  } else if (o.comps === 3) {
    const Y: number[] = [], Cb: number[] = [], Cr: number[] = [];
    for (let i = 0; i < width * height; i++) {
      const R = pixels[i * 3], G = pixels[i * 3 + 1], B = pixels[i * 3 + 2];
      Y.push(clamp(0.299 * R + 0.587 * G + 0.114 * B));
      Cb.push(clamp(-0.168736 * R - 0.331264 * G + 0.5 * B + 128));
      Cr.push(clamp(0.5 * R - 0.418688 * G - 0.081312 * B + 128));
    }
    const s = o.subsample ? 2 : 1;
    planes = [{ data: Y, h: s, v: s }, { data: Cb, h: 1, v: 1 }, { data: Cr, h: 1, v: 1 }];
    adobe = 1;
  } else {
    const C: number[] = [], M: number[] = [], Yc: number[] = [], K: number[] = [];
    for (let i = 0; i < width * height; i++) { // store Adobe-inverted CMYK
      C.push(255 - pixels[i * 4]); M.push(255 - pixels[i * 4 + 1]); Yc.push(255 - pixels[i * 4 + 2]); K.push(255 - pixels[i * 4 + 3]);
    }
    planes = [{ data: C, h: 1, v: 1 }, { data: M, h: 1, v: 1 }, { data: Yc, h: 1, v: 1 }, { data: K, h: 1, v: 1 }];
    adobe = 0;
  }

  const maxH = Math.max(...planes.map((p) => p.h));
  const maxV = Math.max(...planes.map((p) => p.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));

  // Per-component padded sample plane at native (possibly subsampled) resolution.
  const cinfo = planes.map((p) => {
    const cw = mcusPerLine * p.h * 8, ch = mcusPerColumn * p.v * 8;
    const sp = new Array(cw * ch).fill(0);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const fx = Math.min(width - 1, Math.floor(((x + 0.5) * maxH) / p.h));
      const fy = Math.min(height - 1, Math.floor(((y + 0.5) * maxV) / p.v));
      sp[y * cw + x] = p.data[fy * width + fx];
    }
    return { sp, cw, ch, h: p.h, v: p.v };
  });

  // FDCT every block (zig-zag coeffs), grouped per component.
  const blocks = cinfo.map((c) => {
    const bpl = mcusPerLine * c.h, bpc = mcusPerColumn * c.v;
    const arr: Int32Array[] = [];
    for (let br = 0; br < bpc; br++) for (let bc = 0; bc < bpl; bc++) {
      const spatial = new Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) spatial[y * 8 + x] = c.sp[(br * 8 + y) * c.cw + (bc * 8 + x)];
      const zz = new Int32Array(64); fdct(spatial, zz); arr.push(zz);
    }
    return { arr, bpl, bpc };
  });

  // MCU traversal helper (shared by symbol-collection and emit passes).
  const total = mcusPerLine * mcusPerColumn;
  const traverse = (onBlock: (ci: number, zz: Int32Array) => void, onRestart: () => void) => {
    let mcu = 0;
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++) {
      for (let ci = 0; ci < cinfo.length; ci++) {
        const B = blocks[ci], c = cinfo[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++)
          onBlock(ci, B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)]);
      }
      mcu++;
      if (ri && mcu % ri === 0 && mcu < total) onRestart();
    }
  };

  // Pass 1: collect the DC and AC symbols actually used.
  const dcSyms = new Set<number>([0]);
  const acSyms = new Set<number>([0x00]);
  {
    const pred = new Array(cinfo.length).fill(0);
    traverse((ci, zz) => {
      const diff = zz[0] - pred[ci]; pred[ci] = zz[0]; dcSyms.add(category(diff));
      let k = 1;
      while (k < 64) {
        let run = 0; while (k < 64 && zz[k] === 0) { run++; k++; }
        if (k === 64) break;
        while (run > 15) { acSyms.add(0xf0); run -= 16; }
        acSyms.add((run << 4) | category(zz[k])); k++;
      }
    }, () => pred.fill(0));
  }
  const dcH = fixedHuff(dcSyms), acH = fixedHuff(acSyms);

  // Pass 2: entropy-code, resetting DC predictors + flushing at each restart.
  const bw = new BitWriter();
  const rstBytes: { at: number; marker: number }[] = [];
  {
    const pred = new Array(cinfo.length).fill(0);
    let rstIdx = 0;
    traverse((ci, zz) => {
      const diff = zz[0] - pred[ci]; pred[ci] = zz[0];
      const dcat = category(diff); const d = dcH.enc.get(dcat)!;
      bw.put(d.code, d.len); if (dcat) bw.put(valueBits(diff, dcat), dcat);
      let k = 1;
      while (k < 64) {
        let run = 0; while (k < 64 && zz[k] === 0) { run++; k++; }
        if (k === 64) { const e = acH.enc.get(0x00)!; bw.put(e.code, e.len); break; }
        while (run > 15) { const z = acH.enc.get(0xf0)!; bw.put(z.code, z.len); run -= 16; }
        const acat = category(zz[k]); const sym = (run << 4) | acat; const e = acH.enc.get(sym)!;
        bw.put(e.code, e.len); bw.put(valueBits(zz[k], acat), acat); k++;
      }
    }, () => {
      bw.flush(); rstBytes.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx & 7) }); rstIdx++; pred.fill(0);
    });
    bw.flush();
  }
  // Splice RSTn markers into the entropy byte stream.
  const entropy: number[] = [];
  let prev = 0;
  for (const r of rstBytes) { for (let i = prev; i < r.at; i++) entropy.push(bw.bytes[i]); entropy.push(0xff, r.marker); prev = r.at; }
  for (let i = prev; i < bw.bytes.length; i++) entropy.push(bw.bytes[i]);

  // ---- Assemble the file ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT: table 0, all ones
  out.push(0xff, 0xc0); u16(8 + cinfo.length * 3); out.push(8); u16(height); u16(width); out.push(cinfo.length);
  for (let i = 0; i < cinfo.length; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0); // id, sampling, quant table 0
  const writeDHT = (tc: number, th: number, t: { bits: number[]; vals: number[] }) => {
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length); out.push((tc << 4) | th);
    for (let i = 0; i < 16; i++) out.push(t.bits[i]); for (const v of t.vals) out.push(v);
  };
  writeDHT(0, 0, dcH); writeDHT(1, 0, acH);
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); }
  out.push(0xff, 0xda); u16(6 + cinfo.length * 2); out.push(cinfo.length);
  for (let i = 0; i < cinfo.length; i++) out.push(i + 1, 0x00); // comp selector, Td=0 Ta=0
  out.push(0, 63, 0); // Ss, Se, Ah/Al
  for (const b of entropy) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/helpers/build-jpeg.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/build-jpeg.ts test/helpers/build-jpeg.test.ts
git commit -m "test(b3b): minimal baseline JPEG encoder fixture builder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Baseline JPEG decoder (`src/jpeg.ts`)

**Files:**
- Create: `src/jpeg.ts`
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `encodeBaselineJpeg` (Task 1) for test inputs; `PdfParseError`, `UnsupportedFeatureError` from `./errors.js`.
- Produces:
  ```ts
  export interface JpegImage { width: number; height: number; comps: number; data: Uint8Array }
  export function decodeJpeg(bytes: Uint8Array): JpegImage;
  ```
  `data` is interleaved 8-bit, `comps` channels per pixel, row 0 = top. Channels: 1→gray; 3→R,G,B (YCbCr→RGB unless Adobe transform 0); 4→C,M,Y,K (Adobe inversion undone). Throws `UnsupportedFeatureError` for progressive/arithmetic/lossless SOFs and non-8-bit precision; `PdfParseError` for malformed/truncated input.

- [ ] **Step 1: Write the failing grayscale round-trip test**

Create `test/jpeg.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { decodeJpeg } from '../src/jpeg.js';
import { encodeBaselineJpeg } from './helpers/build-jpeg.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';

const near = (a: number, b: number, tol = 3) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('decodeJpeg — baseline', () => {
  it('round-trips a grayscale image (flat blocks exact)', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    for (let i = 0; i < w * h; i++) near(dec.data[i], px[i]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpeg.test.ts`
Expected: FAIL — `decodeJpeg` not defined.

- [ ] **Step 3: Implement the decoder**

Create `src/jpeg.ts`:
```ts
// Baseline (SOF0/SOF1) sequential JPEG decoder. Zero deps beyond ./errors.js.
// Progressive (SOF2), arithmetic, lossless, and 12-bit are unsupported.
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export interface JpegImage { width: number; height: number; comps: number; data: Uint8Array }

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// A[k][n] = alpha(k) * cos((2n+1)kπ/16); alpha(0)=1/√2 else 1.
const A: number[][] = (() => {
  const t: number[][] = [];
  for (let k = 0; k < 8; k++) {
    t[k] = []; const a = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) t[k][n] = a * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return t;
})();

const clamp = (v: number) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };

// Inverse DCT of a natural-order 8×8 coefficient block → spatial samples (0..255,
// level-shifted by +128), written into `out` (row-major, length 64).
function idct(coef: Int32Array, off: number, out: number[]): void {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let u = 0; u < 8; u++) { const ay = A[u][y], base = off + u * 8; for (let v = 0; v < 8; v++) s += ay * A[v][x] * coef[base + v]; }
    out[y * 8 + x] = clamp(s / 4 + 128);
  }
}

function extend(v: number, n: number): number { return n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v; }

interface Huff { map: Map<number, number> } // key = (len<<16)|code → symbol
function buildHuff(bits: number[], vals: number[]): Huff {
  const map = new Map<number, number>(); let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) { for (let i = 0; i < bits[len - 1]; i++) { map.set((len << 16) | code, vals[k++]); code++; } code <<= 1; }
  return { map };
}

class BitReader {
  private buf = 0; private cnt = 0;
  constructor(private d: Uint8Array, public pos: number) {}
  private next(): number { // one entropy byte, or -1 at a marker (byte-stuffing removed)
    const b = this.d[this.pos++];
    if (b === 0xff) { const n = this.d[this.pos]; if (n === 0) { this.pos++; } else { this.pos--; return -1; } }
    return b === undefined ? -1 : b;
  }
  readBit(): number { if (this.cnt === 0) { const b = this.next(); if (b < 0) return 0; this.buf = b; this.cnt = 8; } this.cnt--; return (this.buf >> this.cnt) & 1; }
  receive(n: number): number { let v = 0; while (n-- > 0) v = (v << 1) | this.readBit(); return v; }
  restart(): void { // align to and consume the next RSTn marker
    this.cnt = 0;
    while (this.pos < this.d.length) {
      if (this.d[this.pos] === 0xff) { const n = this.d[this.pos + 1]; if (n >= 0xd0 && n <= 0xd7) { this.pos += 2; return; } if (n !== 0) return; }
      this.pos++;
    }
  }
}
function decodeHuff(r: BitReader, h: Huff): number {
  let code = 0;
  for (let len = 1; len <= 16; len++) { code = (code << 1) | r.readBit(); const s = h.map.get((len << 16) | code); if (s !== undefined) return s; }
  throw new PdfParseError('JPEG: invalid Huffman code');
}

interface Comp { id: number; h: number; v: number; tq: number; blocks: Int32Array; bpl: number; bpc: number }
interface Frame { width: number; height: number; comps: Comp[]; maxH: number; maxV: number }

export function decodeJpeg(data: Uint8Array): JpegImage {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const qt: (Int32Array | undefined)[] = [];
  const huffDC: (Huff | undefined)[] = [];
  const huffAC: (Huff | undefined)[] = [];
  let frame: Frame | undefined;
  let adobe: number | undefined;
  let restartInterval = 0;
  let pos = 2;

  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1]; pos += 2;
    if (marker === 0xd9) break;                                  // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / stray RSTn
    const len = u16(pos); const seg = pos + 2; const segEnd = pos + len; pos += len;

    if (marker === 0xdb) {                                       // DQT
      let p = seg;
      while (p < segEnd) { const pq = data[p] >> 4, tq = data[p] & 15; p++; const t = new Int32Array(64); for (let i = 0; i < 64; i++) { t[i] = pq ? u16(p) : data[p]; p += pq ? 2 : 1; } qt[tq] = t; }
    } else if (marker === 0xc4) {                                // DHT
      let p = seg;
      while (p < segEnd) {
        const tc = data[p] >> 4, th = data[p] & 15; p++;
        const bits: number[] = []; let tot = 0; for (let i = 0; i < 16; i++) { bits.push(data[p + i]); tot += data[p + i]; } p += 16;
        const vals: number[] = []; for (let i = 0; i < tot; i++) vals.push(data[p++]);
        const hf = buildHuff(bits, vals); if (tc === 0) huffDC[th] = hf; else huffAC[th] = hf;
      }
    } else if (marker === 0xdd) {                                // DRI
      restartInterval = u16(seg);
    } else if (marker === 0xee) {                                // APP14 Adobe
      if (len >= 14 && data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobe = data[seg + 11];
    } else if (marker === 0xc0 || marker === 0xc1) {             // SOF0 / SOF1 (baseline / extended sequential)
      const precision = data[seg]; if (precision !== 8) throw new UnsupportedFeatureError('JPEG: only 8-bit precision is supported');
      const height = u16(seg + 1), width = u16(seg + 3), nc = data[seg + 5];
      let maxH = 1, maxV = 1; const comps: Comp[] = []; let p = seg + 6;
      for (let i = 0; i < nc; i++) { const id = data[p], h = data[p + 1] >> 4, v = data[p + 1] & 15, tq = data[p + 2]; p += 3; maxH = Math.max(maxH, h); maxV = Math.max(maxV, v); comps.push({ id, h, v, tq, blocks: new Int32Array(0), bpl: 0, bpc: 0 }); }
      frame = { width, height, comps, maxH, maxV };
    } else if (marker === 0xc2) {                                // SOF2 progressive
      throw new UnsupportedFeatureError('JPEG: progressive DCT is not supported');
    } else if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8) {
      throw new UnsupportedFeatureError(`JPEG: unsupported coding process (SOF${marker - 0xc0})`);
    } else if (marker === 0xda) {                                // SOS
      if (!frame) throw new PdfParseError('JPEG: SOS before SOF');
      pos = decodeScan(data, seg, segEnd, frame, huffDC, huffAC, restartInterval, qt);
    }
    // other markers (APPn, COM, ...) are skipped by the length advance
  }
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return assemble(frame, adobe);
}

function decodeScan(
  data: Uint8Array, seg: number, entropy: number, frame: Frame,
  huffDC: (Huff | undefined)[], huffAC: (Huff | undefined)[], restartInterval: number, qt: (Int32Array | undefined)[],
): number {
  const ns = data[seg]; let p = seg + 1;
  const scan: { c: Comp; dc: Huff; ac: Huff }[] = [];
  for (let i = 0; i < ns; i++) {
    const cs = data[p], td = data[p + 1] >> 4, ta = data[p + 1] & 15; p += 2;
    const c = frame.comps.find((k) => k.id === cs); if (!c) throw new PdfParseError('JPEG: bad scan component');
    const dc = huffDC[td], ac = huffAC[ta]; if (!dc || !ac) throw new PdfParseError('JPEG: missing Huffman table');
    scan.push({ c, dc, ac });
  }
  // Ss/Se/Ah/Al follow (data[p], data[p+1], data[p+2]); baseline is 0,63,0,0.

  const mcusPerLine = Math.ceil(frame.width / (frame.maxH * 8));
  const mcusPerColumn = Math.ceil(frame.height / (frame.maxV * 8));
  for (const c of frame.comps) { c.bpl = mcusPerLine * c.h; c.bpc = mcusPerColumn * c.v; c.blocks = new Int32Array(c.bpl * c.bpc * 64); }

  const r = new BitReader(data, entropy);
  const pred = new Int32Array(scan.length);
  const total = mcusPerLine * mcusPerColumn;

  const block = (si: number, blockRow: number, blockCol: number) => {
    const sc = scan[si], c = sc.c, q = qt[c.tq]; if (!q) throw new PdfParseError('JPEG: missing quant table');
    const off = (blockRow * c.bpl + blockCol) * 64;
    const t = decodeHuff(r, sc.dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    c.blocks[off] = pred[si] * q[0];
    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(r, sc.ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run === 15) { k += 16; continue; } break; } // ZRL or EOB
      k += run; if (k > 63) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size) * q[k]; k++;
    }
  };

  let mcu = 0;
  for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++) {
    for (let si = 0; si < scan.length; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) block(si, my * c.v + by, mx * c.h + bx); }
    mcu++;
    if (restartInterval && mcu % restartInterval === 0 && mcu < total) { r.restart(); pred.fill(0); }
  }
  return r.pos;
}

function assemble(frame: Frame, adobeTransform: number | undefined): JpegImage {
  const { width, height, comps, maxH, maxV } = frame;
  const planes = comps.map((c) => {
    const pw = c.bpl * 8, ph = c.bpc * 8; const plane = new Uint8Array(pw * ph); const out = new Array(64);
    for (let br = 0; br < c.bpc; br++) for (let bc = 0; bc < c.bpl; bc++) {
      idct(c.blocks, (br * c.bpl + bc) * 64, out);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(br * 8 + y) * pw + (bc * 8 + x)] = out[y * 8 + x];
    }
    return { plane, pw, ph, h: c.h, v: c.v };
  });

  const nc = comps.length;
  const data = new Uint8Array(width * height * nc);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const di = (y * width + x) * nc;
    for (let ci = 0; ci < nc; ci++) {
      const pl = planes[ci];
      const sx = Math.min(pl.pw - 1, ((x * pl.h) / maxH) | 0);
      const sy = Math.min(pl.ph - 1, ((y * pl.v) / maxV) | 0);
      data[di + ci] = pl.plane[sy * pl.pw + sx];
    }
  }

  const transform = adobeTransform !== undefined ? adobeTransform : nc === 3 ? 1 : 0;
  if (nc === 3 && transform !== 0) ycbcrToRgb(data);
  else if (nc === 4) cmyk(data, transform, adobeTransform !== undefined);
  return { width, height, comps: nc, data };
}

const cl = (v: number) => { v = Math.round(v); return v < 0 ? 0 : v > 255 ? 255 : v; };
function ycbcrToRgb(d: Uint8Array): void {
  for (let i = 0; i < d.length; i += 3) {
    const Y = d[i], Cb = d[i + 1] - 128, Cr = d[i + 2] - 128;
    d[i] = cl(Y + 1.402 * Cr); d[i + 1] = cl(Y - 0.344136 * Cb - 0.714136 * Cr); d[i + 2] = cl(Y + 1.772 * Cb);
  }
}
function cmyk(d: Uint8Array, transform: number, adobe: boolean): void {
  for (let i = 0; i < d.length; i += 4) {
    let c: number, m: number, y: number; let k = d[i + 3];
    if (transform === 2) { const Y = d[i], Cb = d[i + 1] - 128, Cr = d[i + 2] - 128; c = 255 - cl(Y + 1.402 * Cr); m = 255 - cl(Y - 0.344136 * Cb - 0.714136 * Cr); y = 255 - cl(Y + 1.772 * Cb); }
    else { c = d[i]; m = d[i + 1]; y = d[i + 2]; }
    if (adobe) { c = 255 - c; m = 255 - m; y = 255 - y; k = 255 - k; }
    d[i] = c; d[i + 1] = m; d[i + 2] = y; d[i + 3] = k;
  }
}
```

- [ ] **Step 4: Run the grayscale test to verify it passes**

Run: `npx vitest run test/jpeg.test.ts`
Expected: PASS.

- [ ] **Step 5: Add color / subsampling / CMYK / restart / error tests**

Append to `test/jpeg.test.ts` inside the `describe`:
```ts
  it('round-trips an RGB image via YCbCr (4:4:4)', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(dec.comps).toBe(3);
    for (let i = 0; i < w * h * 3; i++) near(dec.data[i], px[i], 4);
  });

  it('round-trips a subsampled (4:2:0) flat RGB image', () => {
    const w = 16, h = 16;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; } // flat → exact after up/down-sample
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h);
    near(dec.data[0], 200, 4); near(dec.data[1], 80, 4); near(dec.data[2], 40, 4);
    const last = (w * h - 1) * 3; near(dec.data[last], 200, 4); near(dec.data[last + 1], 80, 4);
  });

  it('round-trips a flat CMYK (Adobe) image', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 30; px[i * 4 + 1] = 60; px[i * 4 + 2] = 90; px[i * 4 + 3] = 120; }
    const dec = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 4, pixels: px }));
    expect(dec.comps).toBe(4);
    near(dec.data[0], 30, 3); near(dec.data[1], 60, 3); near(dec.data[2], 90, 3); near(dec.data[3], 120, 3);
  });

  it('decodes identically with a restart interval', () => {
    const w = 24, h = 24;
    const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
    const plain = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const rst = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: 2 }));
    for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
  });

  it('throws UnsupportedFeatureError for progressive (SOF2)', () => {
    // Minimal header: SOI, SOF2 (1 comp, 8×8), then truncated.
    const b = Uint8Array.from([0xff, 0xd8, 0xff, 0xc2, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(() => decodeJpeg(b)).toThrow(UnsupportedFeatureError);
  });

  it('throws UnsupportedFeatureError for arithmetic coding (SOF9)', () => {
    const b = Uint8Array.from([0xff, 0xd8, 0xff, 0xc9, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xd9]);
    expect(() => decodeJpeg(b)).toThrow(UnsupportedFeatureError);
  });

  it('throws PdfParseError for a truncated stream with no frame', () => {
    expect(() => decodeJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(PdfParseError);
  });
```

- [ ] **Step 6: Run the full decoder suite**

Run: `npx vitest run test/jpeg.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/jpeg.ts test/jpeg.test.ts
git commit -m "feat(b3b): baseline JPEG (DCTDecode) decoder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire the decoder into `decodeImageRgba`

**Files:**
- Modify: `src/raster.ts` (imports near line 13; `decodeImageRgba` at line 573)
- Test: `test/jpeg.test.ts` (add a `decodeImageRgba` group), plus fixture `test/helpers/build-image-pdf.ts` reuse

**Interfaces:**
- Consumes: `decodeJpeg`, `JpegImage` (Task 2); existing `decodeImageRgba` / `decodeSMaskAlpha` / `ImageInfo`.
- Produces: `decodeImageRgba` now returns an `ImageRgba` for `DCTDecode` streams (previously `undefined`).

- [ ] **Step 1: Write the failing wiring test**

Append to `test/jpeg.test.ts`:
```ts
import { Document } from '../src/document.js';
import { decodeImageRgba } from '../src/raster.js';
import { isStream } from '../src/types.js';
import { buildSingleImagePdf } from './helpers/build-image-pdf.js';

describe('decodeImageRgba — DCTDecode', () => {
  it('decodes a baseline JPEG image XObject to RGBA', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdf({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg,
    }));
    // Find the Im0 image stream.
    const page = doc.Pages[0];
    const res = page.Resources!;
    const xobj = doc.resolve(res.get('XObject')) as Map<string, unknown>;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.w).toBe(w); expect(img!.h).toBe(h);
    near(img!.data[0], 200, 5); near(img!.data[1], 100, 5); near(img!.data[2], 50, 5);
    expect(img!.data[3]).toBe(255); // opaque (no SMask)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpeg.test.ts -t "DCTDecode"`
Expected: FAIL — `decodeImageRgba` returns `undefined` for DCT, so `img` is undefined.

- [ ] **Step 3: Add the import in `src/raster.ts`**

After the existing `import { inflateStream } from './flate.js';` line (near line 13), add:
```ts
import { decodeJpeg, JpegImage } from './jpeg.js';
```

- [ ] **Step 4: Add the DCT branch in `decodeImageRgba`**

In `src/raster.ts`, `decodeImageRgba` currently begins:
```ts
export function decodeImageRgba(doc: Document, stream: PdfStream, fill: Rgb): ImageRgba | undefined {
  const info = new ImageInfo(doc, '', stream);
  const w = info.Width, h = info.Height;
  if (!w || !h || w * h > 64 * 1024 * 1024) return undefined;
  if (NO_RASTER_DECODER.has(info.Filter ?? '')) return undefined;
```
Insert the DCT branch **between** the size guard and the `NO_RASTER_DECODER` guard, so `DCTDecode` is handled before that set declines it (the set stays intact for `decodeSMaskAlpha`):
```ts
  if (!w || !h || w * h > 64 * 1024 * 1024) return undefined;

  const filt = info.Filter;
  if (filt === 'DCTDecode' || filt === 'DCT') {
    let dec: JpegImage;
    try { dec = decodeJpeg(info.Decode()); } catch { return undefined; } // progressive/arith/malformed → degrade
    const { width: jw, height: jh, comps, data: s } = dec;
    const alpha = decodeSMaskAlpha(doc, stream.dict, jw, jh); // Flate /SMask still honored
    const out = new Uint8Array(jw * jh * 4);
    for (let i = 0; i < jw * jh; i++) {
      let r: number, g: number, b: number;
      if (comps === 1) { r = g = b = s[i]; }
      else if (comps === 3) { r = s[i * 3]; g = s[i * 3 + 1]; b = s[i * 3 + 2]; }
      else { // 4-component CMYK → RGB (naive)
        const c = s[i * 4], m = s[i * 4 + 1], y = s[i * 4 + 2], k = s[i * 4 + 3];
        r = ((255 - c) * (255 - k)) / 255; g = ((255 - m) * (255 - k)) / 255; b = ((255 - y) * (255 - k)) / 255;
      }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = alpha ? alpha[i] : 255;
    }
    return { w: jw, h: jh, data: out };
  }

  if (NO_RASTER_DECODER.has(info.Filter ?? '')) return undefined;
```

- [ ] **Step 5: Run the wiring test to verify it passes**

Run: `npx vitest run test/jpeg.test.ts -t "DCTDecode"`
Expected: PASS.

- [ ] **Step 6: Run the whole file + typecheck**

Run: `npx vitest run test/jpeg.test.ts && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/raster.ts test/jpeg.test.ts
git commit -m "feat(b3b): decode DCTDecode images to RGBA in decodeImageRgba

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: End-to-end partial JPEG redaction + docs + close

**Files:**
- Modify: `test/redact-image.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `encodeBaselineJpeg` (Task 1); existing `redactPage`, `buildSingleImagePdfWithCm`.
- Produces: no new API — verifies the whole redaction path and updates docs.

- [ ] **Step 1: Add the JPEG partial-redaction success test**

In `test/redact-image.test.ts`, add the import at the top (with the other helper imports):
```ts
import { encodeBaselineJpeg } from './helpers/build-jpeg.js';
```
Then, inside the `describe('partial image redaction (clip + re-encode)', ...)` block, add:
```ts
  it('blacks only the covered columns of a baseline JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; } // flat colour
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode(); // re-encoded as Flate DeviceRGB
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered (right) → preserved
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });
```

- [ ] **Step 2: Relabel the two "malformed JPEG throws" cases**

These two existing tests feed truncated bytes (`0xff,0xd8,0xff,0xd9` — SOI+EOI, no frame), which the decoder rejects (`PdfParseError` → caught → `undefined` → redaction throws). They stay valid but now assert *graceful degradation on an undecodable JPEG*, not "JPEG unsupported". Rename them for accuracy:

In the `describe('removeImagesUnder — XObject images', ...)` block, change:
```ts
  it('throws UnsupportedFeatureError for a partially-covered undecodable (JPEG) image', () => {
```
to:
```ts
  it('throws UnsupportedFeatureError for a partially-covered JPEG that fails to decode', () => {
```

In the `describe('partial image redaction (clip + re-encode)', ...)` block, change:
```ts
  it('throws for a partially-covered JPEG (DCTDecode) image', () => {
```
to:
```ts
  it('throws for a partially-covered JPEG that fails to decode (truncated)', () => {
```
Leave both test bodies unchanged.

- [ ] **Step 3: Run the redaction suite to verify it passes**

Run: `npx vitest run test/redact-image.test.ts`
Expected: PASS — the new success case plus the two relabeled throw cases and all prior cases.

- [ ] **Step 4: Update README limitations**

Open `README.md` and find the redaction limitation note added by issue `gq8` (search for `JPEG` near "partial" / "partially"). It currently excludes JPEG from partial redaction. Replace the exclusion so it reads (adjust surrounding wording to match the existing sentence style):
```md
Partial image redaction requires a decodable codec and axis-aligned placement.
Baseline JPEG (`DCTDecode`) images are decoded, blanked, and re-encoded as
DeviceRGB like other codecs; progressive JPEG, arithmetic-coded JPEG, JPEG 2000
(`JPXDecode`), JBIG2 (`JBIG2Decode`), and DCT-encoded soft masks are not decoded
and degrade to a thrown `UnsupportedFeatureError`. Re-encoded images are
normalized to DeviceRGB; partial inline-image coverage is unsupported.
```
Verify with `git diff README.md` that only the redaction limitation paragraph changed.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: entire suite green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add test/redact-image.test.ts README.md
git commit -m "test(b3b): end-to-end partial JPEG redaction; README limitations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-b3b
```

- [ ] **Step 8: Push (session-completion protocol)**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-07-07-jpeg-dctdecode-design.md`):
- New `src/jpeg.ts` with `decodeJpeg`/`JpegImage` → Task 2. ✓
- Marker walk (DQT/DHT/DRI/APP14/SOF/SOS/EOI), reject progressive/arith/lossless/12-bit → Task 2 Step 3 + error tests Step 5. ✓
- Baseline entropy decode, restart markers, dequant, IDCT, upsample, color transforms (gray/YCbCr/CMYK+Adobe) → Task 2. ✓
- Wire into `decodeImageRgba` before `NO_RASTER_DECODER`, keep DCT in the set for `decodeSMaskAlpha`, honor Flate `/SMask` → Task 3. ✓
- `ImageInfo.Decode()` DCT passthrough unchanged (only *read* in the branch) → Task 3 uses `info.Decode()`, no change to `image.ts`. ✓
- Baseline JPEG encoder fixture builder → Task 1. ✓
- Decoder unit tests (gray, 4:4:4, subsampled, CMYK, restart, progressive/arith/truncated throw) → Task 2 Steps 1/5. ✓
- E2E redaction success + relabel throw cases → Task 4 Steps 1–2. ✓
- README limitations → Task 4 Step 4. ✓
- Progressive deferred to `3ee`; non-goals (JPX/JBIG2, DCT SMask, 12-bit/arith) → Task 2 throws + README. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows complete code. ✓

**3. Type consistency:** `encodeBaselineJpeg(JpegEncodeOptions)`, `decodeJpeg(bytes): JpegImage` with `{width,height,comps,data}`, `decodeImageRgba(doc,stream,fill): ImageRgba|undefined` with `{w,h,data}` (note: `JpegImage` uses `width/height`, `ImageRgba` uses `w/h` — the Task 3 branch maps between them explicitly). `Comp`/`Frame`/`Huff`/`BitReader` are file-private to `src/jpeg.ts`. `A`/`ZIGZAG`/`clamp` are intentionally duplicated in the test-only encoder. ✓
```
