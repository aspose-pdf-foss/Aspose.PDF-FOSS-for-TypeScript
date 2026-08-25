# JPEG differential + hierarchical decode (SOF5-7/13-15, DHP, EXP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode hierarchical JPEGs — DHP frame header, EXP 2× reference expansion, and all six differential frame types (SOF5/6/7 Huffman, SOF13/14/15 arithmetic) — so hierarchical `DCTDecode` images flow through the redaction / `decodeImageRgba` consumers.

**Architecture:** `decodeJpeg` detects hierarchical mode (DHP or a differential SOF before the first scan) and delegates to a new `src/jpeghier.ts` frame-composition loop; the non-hierarchical path is unchanged. Each frame reconstructs to per-component `Int32` planes before colour; differential frames' residuals (no level shift for DCT, `Psv=0` for lossless) are added onto an EXP-upsampled reference, and the final composed planes go through the shared `combinePlanes`. A test-only frame-splitter encoder (`test/helpers/build-jpeg-hier.ts`) builds a lossless base frame + a differential residual frame, reusing the existing single-frame encoders in a new `differential` mode.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension.
- **Errors** — throw `PdfParseError` / `UnsupportedFeatureError` from `./errors.js`.
- **TDD** — every feature lands with a failing vitest test first; fixtures in `test/helpers/`.
- **Quality gates** — `npm run typecheck` and `npm test` both green before closing the issue.
- **Precision** — 8-bit and 12-bit only (12-bit output downshifted to 8-bit).
- **Scope guard** — frames are 1×1-sampled (no intra-frame subsampling); test image dims are multiples of 16 so EXP doubling lands on 8×8-block boundaries.
- **Non-hierarchical path unchanged** — the branch-by-detection keeps the existing single-frame decode byte-for-byte identical; the full suite (~1583 tests) guards it.
- **Beads** — issue `aspose-pdf-foss-for-ts-ac6.3`; already claimed. Close with `bd close` when green.

---

### Task 1: Refactor `jpeg.ts` — `parseSof` + table parsers, `idct` differential mode, exports, new fields

Pure refactor + new capability plumbing. No behavior change for existing single-frame decode; the full suite is the guard.

**Files:**
- Modify: `src/jpeg.ts`

**Interfaces:**
- Produces (newly exported):
  - `function idct(coef: Int32Array, off: number, out: number[], shift: number, maxv: number, differential?: boolean): void` — `differential=true` skips the level-shift add and the [0,maxv] clamp (signed residual output).
  - `function setupGeometry(frame: Frame): void`
  - `function decodeScan(data: Uint8Array, seg: number, entropy: number, frame: Frame, huffDC: (Huff|undefined)[], huffAC: (Huff|undefined)[], restartInterval: number): number`
  - `function parseSof(data: Uint8Array, seg: number, marker: number, qt: (Int32Array|undefined)[]): Frame` — parses a SOF/DHP header into a `Frame` with flags, geometry, and a per-component quant snapshot.
  - `function parseDQT(data, seg, segEnd, qt): void`, `parseDHT(data, seg, segEnd, huffDC, huffAC): void`, `parseDAC(data, seg, segEnd, dcCond, acCond): void`.
  - `Frame` gains `differential: boolean`; `Comp` gains `quant?: Int32Array`.

- [ ] **Step 1: Add the `differential` param to `idct`**

Replace the `idct` function body in `src/jpeg.ts`:

```ts
function idct(coef: Int32Array, off: number, out: number[], shift: number, maxv: number, differential = false): void {
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let s = 0;
    for (let u = 0; u < 8; u++) { const ay = A[u][y], base = off + u * 8; for (let v = 0; v < 8; v++) s += ay * A[v][x] * coef[base + v]; }
    if (differential) { out[y * 8 + x] = Math.round(s / 4); continue; } // signed residual, no level shift / clamp
    const v = Math.round(s / 4 + shift);
    out[y * 8 + x] = v < 0 ? 0 : v > maxv ? maxv : v;
  }
}
export { idct };
```

(Leave the existing `function idct(...)` signature line's leading `function` as-is; the `export { idct }` after the body exports it. Alternatively prefix `export` — either works. Use the `export { idct }` form to minimize churn.)

- [ ] **Step 2: Export `setupGeometry` and `decodeScan`**

Add `export` to both declarations:

```ts
export function setupGeometry(frame: Frame): void {
```
```ts
export function decodeScan(
```

- [ ] **Step 3: Add `differential` to `Frame` and `quant` to `Comp`**

```ts
export interface Comp { id: number; h: number; v: number; tq: number; blocks: Int32Array; bpl: number; bpc: number; blocksPerLine: number; blocksPerColumn: number; samples?: Int32Array; quant?: Int32Array }
export interface Frame { width: number; height: number; comps: Comp[]; maxH: number; maxV: number; progressive: boolean; arithmetic: boolean; lossless: boolean; differential: boolean; precision: number; mcusPerLine: number; mcusPerColumn: number }
```

- [ ] **Step 4: Add the extracted parse helpers**

Add these exported functions to `src/jpeg.ts` (near `setupGeometry`). They contain the exact logic currently inline in `decodeJpeg`:

```ts
export function parseDQT(data: Uint8Array, seg: number, segEnd: number, qt: (Int32Array | undefined)[]): void {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  let p = seg;
  while (p < segEnd) { const pq = data[p] >> 4, tq = data[p] & 15; p++; const t = new Int32Array(64); for (let i = 0; i < 64; i++) { t[i] = pq ? u16(p) : data[p]; p += pq ? 2 : 1; } qt[tq] = t; }
}

export function parseDHT(data: Uint8Array, seg: number, segEnd: number, huffDC: (Huff | undefined)[], huffAC: (Huff | undefined)[]): void {
  let p = seg;
  while (p < segEnd) {
    const tc = data[p] >> 4, th = data[p] & 15; p++;
    const bits: number[] = []; let tot = 0; for (let i = 0; i < 16; i++) { bits.push(data[p + i]); tot += data[p + i]; } p += 16;
    const vals: number[] = []; for (let i = 0; i < tot; i++) vals.push(data[p++]);
    const hf = buildHuff(bits, vals); if (tc === 0) huffDC[th] = hf; else huffAC[th] = hf;
  }
}

export function parseDAC(data: Uint8Array, seg: number, segEnd: number, dcCond: { L: number; U: number }[], acCond: { Kx: number }[]): void {
  let p = seg;
  while (p < segEnd) {
    const tc = data[p] >> 4, tb = data[p] & 15, val = data[p + 1]; p += 2;
    if (tc === 0) dcCond[tb] = { L: val >> 4, U: val & 15 };
    else acCond[tb] = { Kx: val };
  }
}

// Parse a SOF (or DHP) header into a Frame with process flags, geometry, and a
// per-component quant-table snapshot (immune to later DQT redefinition).
export function parseSof(data: Uint8Array, seg: number, marker: number, qt: (Int32Array | undefined)[]): Frame {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const precision = data[seg]; if (precision !== 8 && precision !== 12) throw new UnsupportedFeatureError('JPEG: only 8-bit and 12-bit precision are supported');
  const height = u16(seg + 1), width = u16(seg + 3), nc = data[seg + 5];
  let maxH = 1, maxV = 1; const comps: Comp[] = []; let p = seg + 6;
  for (let i = 0; i < nc; i++) { const id = data[p], h = data[p + 1] >> 4, v = data[p + 1] & 15, tq = data[p + 2]; p += 3; maxH = Math.max(maxH, h); maxV = Math.max(maxV, v); comps.push({ id, h, v, tq, blocks: new Int32Array(0), bpl: 0, bpc: 0, blocksPerLine: 0, blocksPerColumn: 0, quant: qt[tq] }); }
  const differential = (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xcd && marker <= 0xcf);
  const progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
  const lossless = marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf;
  const arithmetic = marker >= 0xc9 && marker <= 0xcf && marker !== 0xcc;
  const frame: Frame = { width, height, comps, maxH, maxV, progressive, arithmetic, lossless, differential, precision, mcusPerLine: 0, mcusPerColumn: 0 };
  if (lossless) setupLosslessGeometry(frame); else setupGeometry(frame);
  return frame;
}
```

- [ ] **Step 5: Rewire `decodeJpeg` to use the helpers**

In `decodeJpeg`, replace the DQT branch body with `parseDQT(data, seg, segEnd, qt);`, the DHT branch body with `parseDHT(data, seg, segEnd, huffDC, huffAC);`, the DAC branch body with `parseDAC(data, seg, segEnd, dcCond, acCond);`, and the SOF branch's frame-construction block (from `const precision = data[seg]; ...` through `if (lossless) setupLosslessGeometry(frame); else setupGeometry(frame);`) with:

```ts
      frame = parseSof(data, seg, marker, qt);
```

So the SOF branch becomes:
```ts
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 || marker === 0xc9 || marker === 0xca || marker === 0xcb) {
      frame = parseSof(data, seg, marker, qt);
    } else if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8) {
      throw new UnsupportedFeatureError(`JPEG: unsupported coding process (SOF${marker - 0xc0})`);
```

- [ ] **Step 6: Run the full suite — refactor must be a no-op**

Run: `npm run typecheck && npm test`
Expected: PASS — all ~1583 tests green.

- [ ] **Step 7: Commit**

```bash
git add src/jpeg.ts
git commit -m "refactor(ac6.3): extract parseSof/table parsers, idct differential mode"
```

---

### Task 2: `jpeghier.ts` composition + lossless-differential end-to-end (SOF7/SOF15)

The full frame-composition pipeline, validated first with the **exact** oracle (lossless differential). Lands the product module, the `decodeJpeg` branch, and the encoder's lossless base + lossless-differential path.

**Files:**
- Create: `src/jpeghier.ts`
- Modify: `src/jpeg.ts` (detection branch at the top of `decodeJpeg`)
- Modify: `src/jpeglossless.ts` (`Psv=0` handling for differential frames)
- Create: `test/helpers/build-jpeg-hier.ts`
- Modify: `test/helpers/build-jpeg-lossless.ts` (add `differential` mode)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes (from `jpeg.ts`): `idct`, `ZIGZAG`, `combinePlanes`, `parseSof`, `parseDQT`, `parseDHT`, `parseDAC`, `decodeScan`, `Frame`, `Comp`, `Plane`, `Huff`, `JpegImage`; (from `jpegarith.ts`) `decodeArithScan`; (from `jpeglossless.ts`) `decodeLosslessScan`.
- Produces:
  - `src/jpeghier.ts`: `isHierarchical(data: Uint8Array): boolean`, `decodeHierarchical(data: Uint8Array): JpegImage`, `upsample2x(plane: Int32Array, pw: number, ph: number, eh: boolean, ev: boolean): { plane: Int32Array; pw: number; ph: number }`.
  - `test/helpers/build-jpeg-hier.ts`: `interface HierEncodeOptions { width: number; height: number; comps: 1 | 3; pixels: ArrayLike<number>; residual: 'seq-dct' | 'prog-dct' | 'lossless'; mode?: 'huffman' | 'arithmetic'; expand?: 'h' | 'v' | 'hv' }` and `function encodeHierarchicalJpeg(o: HierEncodeOptions): Uint8Array`.
  - `test/helpers/build-jpeg-lossless.ts`: `LosslessEncodeOptions` gains `differential?: boolean`.

- [ ] **Step 1: Write the failing test — SOF7 (Huffman lossless differential) recovers grayscale exactly**

Add to `test/jpeg.test.ts` (import + describe):

```ts
import { encodeHierarchicalJpeg } from './helpers/build-jpeg-hier.js';
```

```ts
describe('decodeJpeg — hierarchical (differential lossless)', () => {
  it('SOF7 Huffman: two-frame hierarchical recovers grayscale exactly', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'hv' }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    expect(Array.from(dec.data)).toEqual(Array.from(px)); // exact
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

Run: `npx vitest run test/jpeg.test.ts -t "hierarchical"`
Expected: FAIL — `encodeHierarchicalJpeg` not found.

- [ ] **Step 3: Add `Psv=0` (differential) handling to the lossless decoder**

In `src/jpeglossless.ts`, inside `decodeLosslessScan`, the `decodeSample` closure computes `px`. Update it so predictor 0 means "no prediction" (used by differential-lossless frames):

```ts
  const decodeSample = (si: number, x: number, y: number) => {
    const c = scan[si].c; const S = c.samples!; const bpl = c.bpl;
    let px: number;
    if (psv === 0) px = 0;                       // differential frame: reference supplies prediction
    else if (reset[si]) { px = def; reset[si] = false; }
    else if (y === 0) px = S[x - 1];
    else if (x === 0) px = S[(y - 1) * bpl];
    else px = losslessPredict(psv, S[y * bpl + x - 1], S[(y - 1) * bpl + x], S[(y - 1) * bpl + x - 1]);
    S[y * bpl + x] = (px + readDiff(si)) & 0xffff;
  };
```

- [ ] **Step 4: Add `differential` mode to the lossless encoder**

In `test/helpers/build-jpeg-lossless.ts`, extend the options and encoder:

Add to `LosslessEncodeOptions`:
```ts
  differential?: boolean;            // hierarchical differential frame: Psv=0, per-component residual, no colour
```

In `buildPlanes`, handle differential (per-component residual, no colour transform / CMYK inversion):
```ts
function buildPlanes(o: LosslessEncodeOptions): { planes: number[][]; adobe: number | undefined } {
  const { width, height, pixels } = o; const Pt = o.pointTransform ?? 0; const n = width * height;
  const sh = (v: number) => v >> Pt;
  if (o.differential) { // per-component signed residual; container carries colour info from the base frame
    const planes: number[][] = []; for (let ci = 0; ci < o.comps; ci++) { const pl: number[] = []; for (let i = 0; i < n; i++) pl.push(pixels[i * o.comps + ci]); planes.push(pl); }
    return { planes, adobe: undefined };
  }
  if (o.comps === 1) { const g: number[] = []; for (let i = 0; i < n; i++) g.push(sh(pixels[i])); return { planes: [g], adobe: undefined }; }
  if (o.comps === 3) {
    const R: number[] = [], G: number[] = [], B: number[] = [];
    for (let i = 0; i < n; i++) { R.push(sh(pixels[i * 3])); G.push(sh(pixels[i * 3 + 1])); B.push(sh(pixels[i * 3 + 2])); }
    return { planes: [R, G, B], adobe: 0 };
  }
  const C: number[] = [], M: number[] = [], Y: number[] = [], K: number[] = [];
  for (let i = 0; i < n; i++) { C.push(sh(255 - pixels[i * 4])); M.push(sh(255 - pixels[i * 4 + 1])); Y.push(sh(255 - pixels[i * 4 + 2])); K.push(sh(255 - pixels[i * 4 + 3])); }
  return { planes: [C, M, Y, K], adobe: 0 };
}
```

In `encodeLosslessJpeg`, force predictor 0 and the direct predictor when differential. Change the `psv` binding and `predAt`:
```ts
  const psv = o.differential ? 0 : (o.predictor ?? 1);
```
```ts
  const predAt = (plane: number[], x: number, y: number, reset: boolean): number => {
    if (o.differential) return 0;               // Psv=0: residual coded directly
    if (reset) return def;
    if (y === 0) return plane[x - 1];
    if (x === 0) return plane[(y - 1) * w];
    return predict(psv, plane[y * w + x - 1], plane[(y - 1) * w + x], plane[(y - 1) * w + x - 1]);
  };
```

`assembleFile` already writes `out.push(psv, 0, Pt & 15)` for the SOS — with `psv=0` that emits Ss=0, correct for a differential frame. The SOF marker is still written as `arith ? 0xcb : 0xc3`; the hierarchical assembler rewrites it to the differential variant (Step 6).

- [ ] **Step 5: Write the product module `src/jpeghier.ts`**

Create `src/jpeghier.ts`:

```ts
// Hierarchical (T.81 Annex J) JPEG decode: DHP frame progression, EXP 2×
// reference expansion, and differential frames (SOF5-7 / SOF13-15) whose residual
// is added onto the upsampled reconstruction of the previous frame. Reuses the
// single-frame entropy/transform paths; only reconstruction (no level shift for
// DCT, Psv=0 for lossless) and composition differ.
import { PdfParseError } from './errors.js';
import { idct, ZIGZAG, combinePlanes, parseSof, parseDQT, parseDHT, parseDAC, decodeScan } from './jpeg.js';
import type { Frame, Plane, Huff, JpegImage } from './jpeg.js';
import { decodeArithScan } from './jpegarith.js';
import { decodeLosslessScan } from './jpeglossless.js';

// Pre-walk markers to the first scan; hierarchical iff a DHP (0xDE) or a
// differential SOF (0xC5-C7 / 0xCD-CF) appears first.
export function isHierarchical(data: Uint8Array): boolean {
  let pos = 2;
  while (pos + 1 < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const m = data[pos + 1]; pos += 2;
    if (m === 0xd9 || m === 0xda) return false;                       // EOI / SOS reached
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;             // standalone markers
    if (m === 0xde) return true;                                      // DHP
    if ((m >= 0xc5 && m <= 0xc7) || (m >= 0xcd && m <= 0xcf)) return true; // differential SOF
    if (pos + 1 >= data.length) return false;
    pos += (data[pos] << 8) | data[pos + 1];                          // skip segment by length
  }
  return false;
}

// Expand a component plane ×2 horizontally and/or vertically by bilinear
// interpolation (even = original, odd = (a+b+1)>>1, last replicated).
export function upsample2x(plane: Int32Array, pw: number, ph: number, eh: boolean, ev: boolean): { plane: Int32Array; pw: number; ph: number } {
  let cur = plane, cw = pw, ch = ph;
  if (eh) {
    const nw = cw * 2; const out = new Int32Array(nw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const a = cur[y * cw + x]; const b = x + 1 < cw ? cur[y * cw + x + 1] : a; out[y * nw + 2 * x] = a; out[y * nw + 2 * x + 1] = (a + b + 1) >> 1; }
    cur = out; cw = nw;
  }
  if (ev) {
    const nh = ch * 2; const out = new Int32Array(cw * nh);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const a = cur[y * cw + x]; const b = y + 1 < ch ? cur[(y + 1) * cw + x] : a; out[(2 * y) * cw + x] = a; out[(2 * y + 1) * cw + x] = (a + b + 1) >> 1; }
    cur = out; ch = nh;
  }
  return { plane: cur, pw: cw, ph: ch };
}

interface Dim { pw: number; ph: number }

// Reconstruct a DCT frame to per-component Int32 planes (padded to 8×8 blocks).
// Non-differential: absolute samples (level-shifted, clamped). Differential:
// signed residual (no shift/clamp).
function dctPlanes(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  const { precision, differential } = frame;
  const shift = differential ? 0 : 1 << (precision - 1);
  const maxv = (1 << precision) - 1;
  const planes: Int32Array[] = []; const dims: Dim[] = [];
  for (const c of frame.comps) {
    const q = c.quant; if (!q) throw new PdfParseError('JPEG: missing quant table');
    const qn = new Int32Array(64); for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k];
    const pw = c.bpl * 8, ph = c.bpc * 8; const plane = new Int32Array(pw * ph);
    const out = new Array(64); const dq = new Int32Array(64);
    for (let br = 0; br < c.bpc; br++) for (let bc = 0; bc < c.bpl; bc++) {
      const off = (br * c.bpl + bc) * 64;
      for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
      idct(dq, 0, out, shift, maxv, differential);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(br * 8 + y) * pw + (bc * 8 + x)] = out[y * 8 + x];
    }
    planes.push(plane); dims.push({ pw, ph });
  }
  return { planes, dims };
}

// Lossless frame planes: c.samples directly (absolute for the base frame, raw
// residual for a differential frame — Psv=0 stored these as (0+diff)&0xffff).
function losslessPlanes(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  return { planes: frame.comps.map((c) => c.samples!), dims: frame.comps.map((c) => ({ pw: c.bpl, ph: c.bpc })) };
}

function reconstruct(frame: Frame): { planes: Int32Array[]; dims: Dim[] } {
  return frame.lossless ? losslessPlanes(frame) : dctPlanes(frame);
}

// Add a differential frame's residual onto the (upsampled) reference in place.
// DCT residual: clamp to [0,maxv]; lossless residual: modular (& maxv).
function addResidual(ref: Int32Array, rd: Dim, res: Int32Array, sd: Dim, maxv: number, mod: boolean): void {
  const pw = Math.min(rd.pw, sd.pw), ph = Math.min(rd.ph, sd.ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const v = ref[y * rd.pw + x] + res[y * sd.pw + x];
    ref[y * rd.pw + x] = mod ? (v & maxv) : v < 0 ? 0 : v > maxv ? maxv : v;
  }
}

// Downshift composed Int32 planes to 8-bit and interleave/colour via combinePlanes.
function combineFinal(frame: Frame, planes: Int32Array[], dims: Dim[], adobe: number | undefined): JpegImage {
  const down = frame.precision - 8;
  const out: Plane[] = planes.map((p, ci) => {
    const u8 = new Uint8Array(p.length); for (let i = 0; i < p.length; i++) { const v = p[i] >> down; u8[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    return { plane: u8, pw: dims[ci].pw, ph: dims[ci].ph, h: frame.comps[ci].h, v: frame.comps[ci].v };
  });
  return combinePlanes(frame, out, adobe);
}

export function decodeHierarchical(data: Uint8Array): JpegImage {
  const u16 = (p: number) => (data[p] << 8) | data[p + 1];
  const qt: (Int32Array | undefined)[] = [];
  const huffDC: (Huff | undefined)[] = []; const huffAC: (Huff | undefined)[] = [];
  const dcCond: { L: number; U: number }[] = []; const acCond: { Kx: number }[] = [];
  let adobe: number | undefined; let restartInterval = 0;
  let refPlanes: Int32Array[] | undefined; let refDims: Dim[] | undefined; let refFrame: Frame | undefined;
  let pending: Frame | undefined; let pendingExpH = false, pendingExpV = false; // EXP that preceded `pending`'s SOF
  let expH = false, expV = false;                                               // EXP accumulating for the NEXT frame
  let pos = 2;

  // Finalize the pending frame: reconstruct it, then either seed the reference
  // (first frame) or upsample the reference by the pending frame's own EXP and add
  // its residual. EXP is captured per-frame (pendingExpH/V) at SOF time, because a
  // later frame's EXP marker arrives before this frame is finalized.
  const finalize = () => {
    if (!pending) return;
    const { planes, dims } = reconstruct(pending);
    if (!refPlanes) { refPlanes = planes; refDims = dims; refFrame = pending; }
    else {
      if (pendingExpH || pendingExpV) for (let i = 0; i < refPlanes.length; i++) { const u = upsample2x(refPlanes[i], refDims![i].pw, refDims![i].ph, pendingExpH, pendingExpV); refPlanes[i] = u.plane; refDims![i] = { pw: u.pw, ph: u.ph }; }
      const maxv = (1 << pending.precision) - 1;
      for (let i = 0; i < refPlanes.length; i++) addResidual(refPlanes[i], refDims![i], planes[i], dims[i], maxv, pending.lossless);
      refFrame = pending;
    }
    pending = undefined;
  };

  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const marker = data[pos + 1]; pos += 2;
    if (marker === 0xd9) break;                                       // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = u16(pos); const seg = pos + 2; const segEnd = pos + len; pos += len;

    if (marker === 0xdb) parseDQT(data, seg, segEnd, qt);
    else if (marker === 0xc4) parseDHT(data, seg, segEnd, huffDC, huffAC);
    else if (marker === 0xcc) parseDAC(data, seg, segEnd, dcCond, acCond);
    else if (marker === 0xdd) restartInterval = u16(seg);
    else if (marker === 0xde) { /* DHP: geometry defined per-frame; presence already noted */ }
    else if (marker === 0xdf) { const b = data[seg]; expH = (b >> 4 & 1) === 1; expV = (b & 1) === 1; } // EXP (for the next frame)
    else if (marker === 0xee) { if (len >= 14 && data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobe = data[seg + 11]; }
    else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { finalize(); pending = parseSof(data, seg, marker, qt); pendingExpH = expH; pendingExpV = expV; expH = expV = false; }
    else if (marker === 0xda) {
      if (!pending) throw new PdfParseError('JPEG: SOS before SOF');
      pos = pending.lossless
        ? decodeLosslessScan(data, seg, pending, huffDC, dcCond, restartInterval)
        : pending.arithmetic
        ? decodeArithScan(data, seg, segEnd, pending, dcCond, acCond, restartInterval)
        : decodeScan(data, seg, segEnd, pending, huffDC, huffAC, restartInterval);
    }
  }
  finalize();
  if (!refPlanes || !refFrame || !refDims) throw new PdfParseError('JPEG: no frame data');
  return combineFinal(refFrame, refPlanes, refDims, adobe);
}
```

- [ ] **Step 6: Write the encoder `test/helpers/build-jpeg-hier.ts`**

Create `test/helpers/build-jpeg-hier.ts`:

```ts
// Minimal hierarchical (T.81 Annex J) JPEG frame-splitter encoder for tests.
// Frame 1 is a lossless low-res base (so its reconstruction equals the input
// exactly — no self-decode needed). Frame 2 is a differential frame encoding
// residual = full − upsample(base), reusing the single-frame encoders in their
// `differential` mode with the SOF marker rewritten to the differential variant.
import { encodeLosslessJpeg } from './build-jpeg-lossless.js';
import { encodeBaselineJpeg, encodeProgressiveJpeg } from './build-jpeg.js';
import { encodeSequentialArithJpeg, encodeProgressiveArithJpeg } from './build-jpeg-arith.js';
import { upsample2x } from '../../src/jpeghier.js';

export interface HierEncodeOptions {
  width: number; height: number;
  comps: 1 | 3;
  pixels: ArrayLike<number>;             // 0..255, comps-interleaved
  residual: 'seq-dct' | 'prog-dct' | 'lossless';
  mode?: 'huffman' | 'arithmetic';       // default 'huffman'
  expand?: 'h' | 'v' | 'hv';             // default 'hv'
}

// Non-differential → differential SOF marker rewrite.
const DIFF_MARKER: Record<number, number> = { 0xc0: 0xc5, 0xc1: 0xc5, 0xc2: 0xc6, 0xc3: 0xc7, 0xc9: 0xcd, 0xca: 0xce, 0xcb: 0xcf };

// Split a standalone JPEG into (marker, payload-with-length) segments between SOI
// and EOI. Returns the segment list; entropy data rides with its SOS segment.
function splitSegments(jpg: Uint8Array): { marker: number; bytes: number[] }[] {
  const segs: { marker: number; bytes: number[] }[] = [];
  let p = 2; // skip SOI
  while (p < jpg.length) {
    if (jpg[p] !== 0xff) { p++; continue; }
    const m = jpg[p + 1]; p += 2;
    if (m === 0xd9) break; // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    const len = (jpg[p] << 8) | jpg[p + 1];
    if (m === 0xda) { // SOS: header + entropy up to EOI
      const bytes: number[] = []; let q = p; const end = jpg.length - 2; // strip trailing EOI
      while (q < end) bytes.push(jpg[q++]);
      segs.push({ marker: m, bytes }); p = jpg.length; break;
    }
    const bytes: number[] = []; for (let i = 0; i < len; i++) bytes.push(jpg[p + i]);
    segs.push({ marker: m, bytes }); p += len;
  }
  return segs;
}

export function encodeHierarchicalJpeg(o: HierEncodeOptions): Uint8Array {
  const { width: w, height: h, comps, pixels } = o;
  const eh = o.expand !== 'v', ev = o.expand !== 'h'; // default 'hv'
  const bw = eh ? w >> 1 : w, bh = ev ? h >> 1 : h;   // base (low-res) dims

  // --- Base frame: decimate full image by 2 in expanded axes. ---
  const base = new Uint8Array(bw * bh * comps);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) for (let ci = 0; ci < comps; ci++) {
    const sx = eh ? x * 2 : x, sy = ev ? y * 2 : y;
    base[(y * bw + x) * comps + ci] = pixels[(sy * w + sx) * comps + ci];
  }
  const baseJpg = encodeLosslessJpeg({ width: bw, height: bh, comps: comps as 1 | 3, pixels: base });

  // --- Reference = upsample(base) per component (matches the decoder). ---
  const up: Int32Array[] = [];
  for (let ci = 0; ci < comps; ci++) {
    const plane = new Int32Array(bw * bh); for (let i = 0; i < bw * bh; i++) plane[i] = base[i * comps + ci];
    up.push(upsample2x(plane, bw, bh, eh, ev).plane);
  }
  const uw = eh ? bw * 2 : bw; // == w

  // --- Residual = full − reference, comps-interleaved (signed). ---
  const res: number[] = new Array(w * h * comps);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ci = 0; ci < comps; ci++)
    res[(y * w + x) * comps + ci] = pixels[(y * w + x) * comps + ci] - up[ci][y * uw + x];

  // --- Differential frame: encode the residual, then rewrite its SOF marker. ---
  const arith = o.mode === 'arithmetic';
  let diffJpg: Uint8Array;
  if (o.residual === 'lossless') diffJpg = encodeLosslessJpeg({ width: w, height: h, comps: comps as 1 | 3, pixels: res, differential: true, mode: arith ? 'arithmetic' : 'huffman' });
  else if (o.residual === 'seq-dct') diffJpg = arith ? encodeSequentialArithJpeg({ width: w, height: h, comps: comps as 1 | 3, pixels: res, differential: true }) : encodeBaselineJpeg({ width: w, height: h, comps: comps as 1 | 3, pixels: res, differential: true });
  else diffJpg = arith ? encodeProgressiveArithJpeg({ width: w, height: h, comps: comps as 1 | 3, pixels: res, differential: true }) : encodeProgressiveJpeg({ width: w, height: h, comps: comps as 1 | 3, pixels: res, differential: true });

  const baseSegs = splitSegments(baseJpg);
  const diffSegs = splitSegments(diffJpg);
  for (const s of diffSegs) if (DIFF_MARKER[s.marker] !== undefined) s.marker = DIFF_MARKER[s.marker]; // SOF → differential SOF

  // --- Assemble: SOI · [APP14 from base] · DHP · base(minus APP14) · EXP · diff · EOI. ---
  const out: number[] = []; const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  out.push(0xff, 0xd8); // SOI
  const app14 = baseSegs.find((s) => s.marker === 0xee);
  if (app14) { out.push(0xff, 0xee); for (const b of app14.bytes) out.push(b); }
  // DHP (0xDE): SOF-syntax header, full image dims, 1×1 comps, Tq=0.
  out.push(0xff, 0xde); u16(8 + comps * 3); out.push(8); u16(h); u16(w); out.push(comps); for (let i = 0; i < comps; i++) out.push(i + 1, 0x11, 0);
  for (const s of baseSegs) { if (s.marker === 0xee) continue; out.push(0xff, s.marker); for (const b of s.bytes) out.push(b); }
  out.push(0xff, 0xdf, 0x00, 0x03, ((eh ? 1 : 0) << 4) | (ev ? 1 : 0)); // EXP
  for (const s of diffSegs) { if (s.marker === 0xee) continue; out.push(0xff, s.marker); for (const b of s.bytes) out.push(b); }
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 7: Wire the detection branch into `decodeJpeg`**

In `src/jpeg.ts`, add the import and the top-of-function branch:

```ts
import { isHierarchical, decodeHierarchical } from './jpeghier.js';
```

At the very start of `decodeJpeg`, right after the SOI check:
```ts
export function decodeJpeg(data: Uint8Array): JpegImage {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) throw new PdfParseError('JPEG: missing SOI');
  if (isHierarchical(data)) return decodeHierarchical(data);
```

- [ ] **Step 8: Run the SOF7 test + typecheck**

Run: `npm run typecheck && npx vitest run test/jpeg.test.ts -t "hierarchical"`
Expected: PASS — grayscale recovers exactly. If it fails, print the first divergent `(x,y)` and compare `upsample2x(base)` on both encoder and decoder sides.

- [ ] **Step 9: Add SOF15 (arith lossless differential) + RGB tests**

Append inside the hierarchical describe block:

```ts
  it('SOF15 arithmetic: two-frame hierarchical recovers grayscale exactly', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', mode: 'arithmetic', expand: 'hv' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('recovers RGB exactly (SOF7 lossless differential)', () => {
    const w = 32, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'lossless', expand: 'hv' }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });
```

- [ ] **Step 10: Run + commit**

Run: `npm run typecheck && npx vitest run test/jpeg.test.ts -t "hierarchical"`
Expected: PASS — all three tests green.

```bash
git add src/jpeghier.ts src/jpeg.ts src/jpeglossless.ts test/helpers/build-jpeg-hier.ts test/helpers/build-jpeg-lossless.ts test/jpeg.test.ts
git commit -m "feat(ac6.3): hierarchical composition + lossless-differential (SOF7/15)"
```

---

### Task 3: DCT-differential frames (SOF5 / SOF13)

Adds a `differential` mode to the DCT encoders (shift-0 FDCT, per-component residual, no colour) so `encodeBaselineJpeg` / `encodeSequentialArithJpeg` can encode a residual frame. The decoder path already exists (Task 2).

**Files:**
- Modify: `test/helpers/build-jpeg.ts` (`buildComponentBlocks` differential mode; `encodeBaselineJpeg` differential SOF wiring)
- Modify: `test/helpers/build-jpeg-arith.ts` (`encodeSequentialArithJpeg` differential)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `JpegEncodeOptions` from `build-jpeg.ts`, `encodeHierarchicalJpeg` from Task 2.
- Produces: `JpegEncodeOptions` gains `differential?: boolean`; `buildComponentBlocks` honours it (shift-0 FDCT, per-component residual planes, `adobe: undefined`).

- [ ] **Step 1: Write the failing SOF5/SOF13 tests**

Append to the hierarchical describe block in `test/jpeg.test.ts`:

```ts
  it('SOF5 Huffman: differential sequential-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'seq-dct', expand: 'hv' }));
    expect(dec.width).toBe(w);
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('SOF13 arithmetic: differential sequential-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'seq-dct', mode: 'arithmetic', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });
```

- [ ] **Step 2: Run — confirm it fails**

Run: `npx vitest run test/jpeg.test.ts -t "differential sequential-DCT"`
Expected: FAIL — `encodeBaselineJpeg`/`encodeSequentialArithJpeg` don't yet accept `differential`, so the residual is colour-transformed / level-shifted and the decode diverges (or the option is ignored → large error).

- [ ] **Step 3: Add `differential` to `JpegEncodeOptions` and `buildComponentBlocks`**

In `test/helpers/build-jpeg.ts`, add to `JpegEncodeOptions`:
```ts
  differential?: boolean; // hierarchical differential DCT frame: shift-0 FDCT, per-component residual, no colour transform
```

In `buildComponentBlocks`, handle the differential case in the plane-building branch. Replace the plane-selection block (`if (o.comps === 1) { ... } else if (o.comps === 3) { ... } else { ... }`) so a differential option short-circuits to per-component signed residual planes with `shift = 0`:

```ts
  const { width, height, pixels } = o;
  const precision = o.precision ?? 8;
  const shift = o.differential ? 0 : 1 << (precision - 1);
  if (precision !== 8 && o.comps !== 1) throw new Error('12-bit encoding is grayscale-only in this test helper');
  let planes: { data: number[]; h: number; v: number }[];
  let adobe: number | undefined;
  if (o.differential) {
    planes = []; for (let ci = 0; ci < o.comps; ci++) { const d: number[] = []; for (let i = 0; i < width * height; i++) d.push(pixels[i * o.comps + ci]); planes.push({ data: d, h: 1, v: 1 }); }
  } else if (o.comps === 1) {
    const g: number[] = []; for (let i = 0; i < width * height; i++) g.push(pixels[i]);
    planes = [{ data: g, h: 1, v: 1 }];
  } else if (o.comps === 3) {
    // ...unchanged YCbCr branch...
```

(The existing `const shift = 1 << (precision - 1);` line inside `buildComponentBlocks` is replaced by the `o.differential ? 0 : ...` line above; keep the rest of the function — the `fdct(spatial, zz, shift)` call already threads `shift`.)

- [ ] **Step 4: Wire the differential SOF marker byte through `encodeBaselineJpeg`**

The hierarchical assembler rewrites SOF markers via `DIFF_MARKER`, so `encodeBaselineJpeg` needs no marker change — it emits SOF0 (`0xc0`) for 8-bit, which `DIFF_MARKER[0xc0] = 0xc5`. No code change needed here beyond Step 3; the residual is already colour-free and shift-0. Verify `encodeBaselineJpeg` passes `o` (including `differential`) into `buildComponentBlocks` (it does).

- [ ] **Step 5: Wire `differential` through `encodeSequentialArithJpeg`**

In `test/helpers/build-jpeg-arith.ts`, `encodeSequentialArithJpeg` calls `buildComponentBlocks(o)` — since `o` now carries `differential`, the residual blocks are produced correctly. It emits SOF9 (`0xc9`), which `DIFF_MARKER[0xc9] = 0xcd`. No further change unless it hard-codes colour assumptions; confirm it only uses `cinfo`/`blocks` from `buildComponentBlocks` (it does). No code change expected beyond inheriting Step 3.

- [ ] **Step 6: Run the SOF5/SOF13 tests + typecheck**

Run: `npm run typecheck && npx vitest run test/jpeg.test.ts -t "differential sequential-DCT"`
Expected: PASS — both within tolerance ≤2.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/build-jpeg.ts test/helpers/build-jpeg-arith.ts test/jpeg.test.ts
git commit -m "feat(ac6.3): differential sequential-DCT frames (SOF5/13)"
```

---

### Task 4: Progressive-differential frames (SOF6 / SOF14)

Extends the progressive encoders to the `differential` mode. Decoder path already exists (Task 2 dispatches progressive frames through `decodeScan`/`decodeArithScan`, then `dctPlanes` reconstructs the residual).

**Files:**
- Modify: `test/helpers/build-jpeg.ts` (`encodeProgressiveJpeg` differential)
- Modify: `test/helpers/build-jpeg-arith.ts` (`encodeProgressiveArithJpeg` differential)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `buildComponentBlocks` differential mode (Task 3), `encodeHierarchicalJpeg` (Task 2).
- Produces: `encodeProgressiveJpeg` / `encodeProgressiveArithJpeg` honour `differential` (shift-0 residual blocks, SOF2/SOF10 markers rewritten to SOF6/SOF14 by the hierarchical assembler).

- [ ] **Step 1: Write the failing SOF6/SOF14 tests**

Append to the hierarchical describe block:

```ts
  it('SOF6 Huffman: differential progressive-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'prog-dct', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });

  it('SOF14 arithmetic: differential progressive-DCT residual recovers grayscale within tolerance', () => {
    const w = 32, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 5 + y * 3) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'prog-dct', mode: 'arithmetic', expand: 'hv' }));
    for (let i = 0; i < w * h; i++) expect(Math.abs(dec.data[i] - px[i])).toBeLessThanOrEqual(2);
  });
```

- [ ] **Step 2: Run — confirm it fails**

Run: `npx vitest run test/jpeg.test.ts -t "differential progressive-DCT"`
Expected: FAIL — the progressive encoders don't yet pass `differential` into `buildComponentBlocks`, so the residual is colour/level-shifted and diverges.

- [ ] **Step 3: Confirm `differential` threads through the progressive encoders**

`encodeProgressiveJpeg` (in `build-jpeg.ts`) and `encodeProgressiveArithJpeg` (in `build-jpeg-arith.ts`) both start with `buildComponentBlocks(o)`. Since Task 3 added `differential` handling *inside* `buildComponentBlocks`, and `o` carries the flag, the residual coefficient blocks are already correct. The only requirement is that neither encoder re-applies a colour or level-shift assumption downstream of `buildComponentBlocks` — they operate purely on `cinfo`/`blocks`. Verify by reading both functions; **no code change is expected**. If a hard-coded `adobe`/`8`-precision assumption is found, thread `o.differential`/`o.precision` through it.

Note: the progressive encoders emit SOF2 (`0xc2`) / SOF10 (`0xca`); `DIFF_MARKER` maps these to SOF6 (`0xc6`) / SOF14 (`0xce`). The DHT/DAC and scan structure are unchanged — a differential progressive frame is decoded by the identical progressive entropy path, only the IDCT skips the level shift (via `frame.differential` in `dctPlanes`).

- [ ] **Step 4: Run the SOF6/SOF14 tests**

Run: `npm run typecheck && npx vitest run test/jpeg.test.ts -t "differential progressive-DCT"`
Expected: PASS — both within tolerance ≤2. If they fail with a large systematic offset, the residual level-shift is being applied — confirm `frame.differential` reaches `dctPlanes` for the SOF6/SOF14 frame (check `parseSof`'s `differential` computation includes 0xc6/0xce).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-jpeg.ts test/helpers/build-jpeg-arith.ts test/jpeg.test.ts
git commit -m "feat(ac6.3): differential progressive-DCT frames (SOF6/14)"
```

---

### Task 5: EXP variants, `decodeImageRgba`, redaction acceptance, real-file slot, docs, close

**Files:**
- Test: `test/jpeg.test.ts` (EXP variants, decodeImageRgba, real-file slot)
- Test: `test/redact-image.test.ts` (acceptance)
- Modify: `README.md`

**Interfaces:**
- Consumes: `encodeHierarchicalJpeg`, `decodeImageRgba`, `buildSingleImagePdf`/`buildSingleImagePdfWithCm`, `redactPage`.

- [ ] **Step 1: Write the EXP-variant tests (horizontal-only, vertical-only)**

Append to the hierarchical describe block:

```ts
  it('recovers exactly under horizontal-only expansion', () => {
    const w = 32, h = 16; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 9 + y * 2) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'h' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('recovers exactly under vertical-only expansion', () => {
    const w = 16, h = 32; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 2 + y * 9) & 0xff;
    const dec = decodeJpeg(encodeHierarchicalJpeg({ width: w, height: h, comps: 1, pixels: px, residual: 'lossless', expand: 'v' }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "expansion"`
Expected: PASS — both exact.

- [ ] **Step 3: Add the `decodeImageRgba` test + real-file slot**

Add a lossless-differential hierarchical XObject test as a sibling of the existing `decodeImageRgba` cases in `test/jpeg.test.ts` (in the `describe('decodeImageRgba — DCTDecode', ...)` block):

```ts
  it('decodes a hierarchical (SOF7 differential) JPEG image XObject to RGBA', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'lossless', expand: 'hv' });
    const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
    const res = doc.Pages[0].Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.data[0]).toBe(200); expect(img!.data[1]).toBe(100); expect(img!.data[2]).toBe(50);
  });
```

Then add a skip'd real-file slot after the hierarchical describe block:

```ts
// Hybrid fixture slot: drop a real, externally-generated hierarchical JPEG here to
// guard the EXP upsampling filter + composition against a shared encoder/decoder
// bug (the in-repo encoder validates against the known original, but uses the same
// upsample2x on both sides). libjpeg's cjpeg cannot emit hierarchical; provenance:
//   jpeg-9:  a hierarchical progression script, or PVRG pvrg-jpeg.
// Commit the bytes + known source pixels, then assert decodeJpeg(REF) matches.
describe('decodeJpeg — hierarchical real-file reference', () => {
  it.skip('decodes a real (externally-generated) hierarchical JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF); // ...compare to known source pixels
  });
});
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "hierarchical"`
Expected: PASS.

- [ ] **Step 5: Write the redaction acceptance test**

In `test/redact-image.test.ts`, add the import:
```ts
import { encodeHierarchicalJpeg } from './helpers/build-jpeg-hier.js';
```

Add after the lossless redaction tests:
```ts
  it('blacks only the covered columns of a hierarchical (SOF5) JPEG (decode + re-encode)', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'seq-dct', expand: 'hv' });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(12, 0)[0] - 200)).toBeLessThanOrEqual(6);
    expect(Math.abs(px2(15, 15)[1] - 100)).toBeLessThanOrEqual(6);
  });
```

- [ ] **Step 6: Run the acceptance test**

Run: `npx vitest run test/redact-image.test.ts -t "hierarchical"`
Expected: PASS.

- [ ] **Step 7: Update README**

In `README.md`, update the JPEG decode note (the line listing "Baseline, progressive, arithmetic-coded, and lossless JPEG") to add hierarchical/differential, and the redaction limitation line similarly. Example edit to the main note:

> Baseline, progressive, arithmetic-coded, lossless, and hierarchical JPEG (`DCTDecode`) images — Huffman DCT (SOF0/1/2), QM arithmetic DCT (SOF9/10), predictive lossless (SOF3/SOF11), and multi-frame differential/hierarchical (SOF5-7/13-15 + DHP/EXP), at 8- or 12-bit precision

Match the surrounding wording; keep the `JPXDecode`/`JBIG2Decode`-still-unsupported sentence intact.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green (existing ~1583 + new hierarchical tests, skips for the real-file slots).

- [ ] **Step 9: Commit**

```bash
git add test/jpeg.test.ts test/redact-image.test.ts README.md
git commit -m "feat(ac6.3): hierarchical EXP variants, decodeImageRgba, redaction acceptance; docs"
```

- [ ] **Step 10: Close the beads issue and sync**

```bash
bd close aspose-pdf-foss-for-ts-ac6.3
# also close the ac6 epic if all sub-projects are done:
bd show aspose-pdf-foss-for-ts-ac6   # verify ac6.1/6.2/6.3 all closed, then:
bd close aspose-pdf-foss-for-ts-ac6 || true
git add .beads/ && git commit -m "chore(ac6.3): close ac6.3 + ac6 epic (hierarchical JPEG shipped)" || true
git pull --rebase && git push && git status
```

Expected: `git status` shows "up to date with origin"; `bd ready` no longer lists ac6.3.

---

## Notes for the implementer

- **Two oracles.** Lossless-differential frames (SOF7/15) recover the original **exactly** — any mismatch is a real composition/EXP bug, no tolerance. DCT-differential frames (SOF5/6/13/14) use a small tolerance (≤2) for DCT rounding of the residual.
- **The encoder and decoder share `upsample2x`** (imported from `src/jpeghier.ts`), so the EXP filter can't drift between them — but that means the filter's *spec-correctness* is only checked by the skip'd real-file slot. This is intentional (documented in the spec's Risks).
- **Differential reconstruction differs only in two places:** DCT skips the level shift (`idct(..., differential=true)`), and lossless uses `Psv=0` (`px=0`). Everything else — entropy decode, geometry, restart — is the reused single-frame code.
- **The non-hierarchical path is untouched.** If any pre-existing test regresses, the detection branch (`isHierarchical`) is misfiring — check the pre-walk's segment-length advance and standalone-marker handling.
- **Quant snapshot matters:** DCT frame reconstruction is deferred to `finalize()`, which runs when the *next* frame's SOF (and its DQT) may have already changed `qt[]`. `Comp.quant` captured at `parseSof` time is what `dctPlanes` reads.
```
