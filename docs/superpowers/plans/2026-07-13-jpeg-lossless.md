# JPEG lossless decode (SOF3 / SOF11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode lossless (Annex H) JPEGs — SOF3 (Huffman) and SOF11 (arithmetic) — to pixel samples so lossless `DCTDecode` images flow through the existing redaction / `decodeImageRgba` consumers.

**Architecture:** A new `src/jpeglossless.ts` module implements the predictive spatial pipeline (7 predictors + point transform, no DCT/quant/IDCT), reusing `jpeg.ts`'s Huffman primitives and `jpegarith.ts`'s QM decoder, and emitting per-component sample planes through a shared `combinePlanes` tail extracted from `assemble`. A test-only in-repo lossless encoder (`test/helpers/build-jpeg-lossless.ts`) drives round-trip tests whose oracle is exact sample equality (lossless is exact).

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { X } from './jpeg.js'`).
- **Errors** — throw `PdfParseError` / `UnsupportedFeatureError` from `./errors.js`.
- **TDD** — every feature lands with a failing vitest test first; fixtures built programmatically in `test/helpers/`.
- **Quality gates** — `npm run typecheck` and `npm test` must both be green before closing the issue. Target one file with `npx vitest run test/<name>.test.ts`.
- **Precision** — support 8-bit and 12-bit only (12-bit output downshifted to 8-bit), matching the existing DCT constraint.
- **Beads** — issue `aspose-pdf-foss-for-ts-ac6.2`; claim with `bd update <id> --claim`, close with `bd close <id>` when green.

---

### Task 1: Refactor `jpeg.ts` — export Huffman primitives, extract `combinePlanes`, add lossless fields

Pure refactor. No behavior change; the existing full test suite is the guard.

**Files:**
- Modify: `src/jpeg.ts`

**Interfaces:**
- Produces (newly exported):
  - `class BitReader { constructor(d: Uint8Array, pos: number); pos: number; readBit(): number; receive(n: number): number; restart(): void }`
  - `function buildHuff(bits: number[], vals: number[]): Huff`
  - `function decodeHuff(r: BitReader, h: Huff): number`
  - `function extend(v: number, n: number): number`
  - `interface Huff { map: Map<number, number> }`
  - `interface Plane { plane: Uint8Array; pw: number; ph: number; h: number; v: number }`
  - `function combinePlanes(frame: Frame, planes: Plane[], adobeTransform: number | undefined): JpegImage`
  - `Frame` gains `lossless: boolean`; `Comp` gains `samples?: Int32Array`.

- [ ] **Step 1: Export the Huffman primitives and types**

In `src/jpeg.ts`, add `export` to the four declarations and the `Huff` interface (currently module-private):

```ts
export interface Huff { map: Map<number, number> } // key = (len<<16)|code → symbol
export function buildHuff(bits: number[], vals: number[]): Huff {
```
```ts
export function extend(v: number, n: number): number { return n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v; }
```
```ts
export class BitReader {
```
```ts
export function decodeHuff(r: BitReader, h: Huff): number {
```

(Only the leading `export` keyword is added; bodies unchanged. Note `extend` is currently declared *after* `buildHuff`/`BitReader`; leave its position as-is — just add `export`.)

- [ ] **Step 2: Add `lossless` to `Frame` and `samples` to `Comp`**

```ts
export interface Comp { id: number; h: number; v: number; tq: number; blocks: Int32Array; bpl: number; bpc: number; blocksPerLine: number; blocksPerColumn: number; samples?: Int32Array }
export interface Frame { width: number; height: number; comps: Comp[]; maxH: number; maxV: number; progressive: boolean; arithmetic: boolean; lossless: boolean; precision: number; mcusPerLine: number; mcusPerColumn: number }
```

- [ ] **Step 3: Set `lossless: false` at the existing frame construction site**

In `decodeJpeg`, the `frame = { ... }` literal (currently in the SOF branch) must include the new field. Update it to:

```ts
      frame = { width, height, comps, maxH, maxV, progressive: marker === 0xc2 || marker === 0xca, arithmetic: marker === 0xc9 || marker === 0xca, lossless: false, precision, mcusPerLine: 0, mcusPerColumn: 0 };
```

- [ ] **Step 4: Extract `combinePlanes` from `assemble`**

Add the `Plane` type and a `combinePlanes` export, then rewrite `assemble` to call it. Replace the tail of `assemble` (everything from `const nc = comps.length;` through the final `return { width, height, comps: nc, data };`) so that `assemble` builds the planes and delegates:

```ts
export interface Plane { plane: Uint8Array; pw: number; ph: number; h: number; v: number }

// Upsample each component plane to full resolution, interleave, and apply the
// JPEG→output colour transform (YCbCr→RGB / CMYK). Shared by the DCT `assemble`
// and the lossless assembler.
export function combinePlanes(frame: Frame, planes: Plane[], adobeTransform: number | undefined): JpegImage {
  const { width, height, maxH, maxV } = frame;
  const nc = planes.length;
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
```

Then in `assemble`, change the `planes` map to produce `Plane` objects (it already returns `{ plane, pw, ph, h: c.h, v: c.v }`) and replace the tail with:

```ts
  return combinePlanes(frame, planes, adobeTransform);
```

So `assemble` now ends:
```ts
    return { plane, pw, ph, h: c.h, v: c.v };
  });
  return combinePlanes(frame, planes, adobeTransform);
}
```

- [ ] **Step 5: Run the full suite to confirm the refactor is a no-op**

Run: `npm run typecheck && npm test`
Expected: PASS — all existing tests green (no behavior change).

- [ ] **Step 6: Commit**

```bash
git add src/jpeg.ts
git commit -m "refactor(ac6.2): export Huffman primitives + extract combinePlanes"
```

---

### Task 2: Refactor `jpegarith.ts` — extract `decodeArithDiff`

Pure refactor. The existing `test/jpeg.test.ts` arithmetic cases are the guard.

**Files:**
- Modify: `src/jpegarith.ts`

**Interfaces:**
- Produces (newly exported):
  - `function decodeArithDiff(dec: ArithDecoder, stats: Uint8Array, ctx: Int32Array, si: number, L: number, U: number): number` — decodes one DC-difference binary tree (T.81 F.1.4.4.1); returns the signed difference and updates `ctx[si]` for the next sample.

- [ ] **Step 1: Add the `decodeArithDiff` helper**

In `src/jpegarith.ts`, after the `ArithDecoder` class (before `decodeArithScan`), add:

```ts
/** Decode one DC-difference value (T.81 F.1.4.4.1) against DC statistics `stats`
 *  with conditioning bounds L/U, returning the signed difference and updating the
 *  per-component conditioning context `ctx[si]`. Shared by the DCT DC decoder and
 *  the lossless (SOF11) difference decoder. */
export function decodeArithDiff(dec: ArithDecoder, stats: Uint8Array, ctx: Int32Array, si: number, L: number, U: number): number {
  let st = ctx[si];
  if (dec.decode(stats, st) === 0) { ctx[si] = 0; return 0; }
  const sign = dec.decode(stats, st + 1);
  st += 2 + sign;                                // SP (S0+2) if positive, SN (S0+3) if negative
  let m = dec.decode(stats, st);
  if (m !== 0) { st = 20; while (dec.decode(stats, st)) { if ((m <<= 1) === 0x8000) throw new PdfParseError('JPEG: arithmetic DC magnitude overflow'); st += 1; } }
  ctx[si] = m < ((1 << L) >> 1) ? 0 : m > ((1 << U) >> 1) ? 12 + sign * 4 : 4 + sign * 4;
  let v = m; st += 14; while ((m >>= 1) !== 0) if (dec.decode(stats, st)) v |= m;
  v += 1; return sign ? -v : v;
}
```

- [ ] **Step 2: Rewrite the DCT `decodeDC` to use the helper**

In `decodeArithScan`, replace the whole `decodeDC` closure with:

```ts
  // F.1.4.4.1 — decode one DC coefficient (natural index 0) into blocks[off].
  const decodeDC = (si: number, off: number) => {
    const sc = scan[si];
    lastDc[si] += decodeArithDiff(dec, sc.dcStats, dcContext, si, sc.L, sc.U);
    sc.c.blocks[off] = lastDc[si] << Al;
  };
```

- [ ] **Step 3: Run the arithmetic tests to confirm no behavior change**

Run: `npx vitest run test/jpeg.test.ts test/jpegarith.test.ts`
Expected: PASS — arithmetic sequential/progressive/restart/DAC cases all green.

- [ ] **Step 4: Commit**

```bash
git add src/jpegarith.ts
git commit -m "refactor(ac6.2): extract decodeArithDiff for lossless reuse"
```

---

### Task 3: Huffman lossless (SOF3) — encoder, decoder, wiring, exact round-trip

Lands the encoder + decoder + `decodeJpeg` wiring together (round-trip needs both). Oracle: decoded samples equal the input exactly.

**Files:**
- Create: `test/helpers/build-jpeg-lossless.ts`
- Create: `src/jpeglossless.ts`
- Modify: `src/jpeg.ts` (SOF3 accept, SOS/end dispatch)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `BitReader`, `buildHuff`, `decodeHuff`, `extend`, `Huff`, `Plane`, `combinePlanes`, `Frame`, `Comp` from `jpeg.ts` (Task 1); `JpegImage` from `jpeg.ts`.
- Produces:
  - `test/helpers/build-jpeg-lossless.ts`: `interface LosslessEncodeOptions { width: number; height: number; comps: 1 | 3 | 4; pixels: ArrayLike<number>; mode?: 'huffman' | 'arithmetic'; predictor?: 1|2|3|4|5|6|7; pointTransform?: number; restartInterval?: number; precision?: 8 | 12; dac?: { L: number; U: number } }` and `function encodeLosslessJpeg(o: LosslessEncodeOptions): Uint8Array`.
  - `src/jpeglossless.ts`: `function setupLosslessGeometry(frame: Frame): void`, `function decodeLosslessScan(data: Uint8Array, seg: number, frame: Frame, huffDC: (Huff | undefined)[], dcCond: { L: number; U: number }[], restartInterval: number): number`, `function assembleLossless(frame: Frame, adobeTransform: number | undefined): JpegImage`, `function losslessPredict(psv: number, ra: number, rb: number, rc: number): number`.

- [ ] **Step 1: Write the failing test — grayscale Huffman round-trip is exact**

Add to `test/jpeg.test.ts` (near the top, add the import; place the describe with the other decode blocks):

```ts
import { encodeLosslessJpeg } from './helpers/build-jpeg-lossless.js';
```

```ts
describe('decodeJpeg — lossless (SOF3 Huffman)', () => {
  it('decodes grayscale exactly (predictor 1)', () => {
    const w = 9, h = 7; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 13 + y * 7) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
    expect(Array.from(dec.data)).toEqual(Array.from(px)); // exact — lossless
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/jpeg.test.ts -t "lossless (SOF3 Huffman)"`
Expected: FAIL — `encodeLosslessJpeg` not found (module missing).

- [ ] **Step 3: Write the test encoder `build-jpeg-lossless.ts`**

Create `test/helpers/build-jpeg-lossless.ts`:

```ts
// Minimal lossless (SOF3 Huffman / SOF11 arithmetic) JPEG encoder for tests.
// Test-only counterpart to src/jpeglossless.ts. Operates on raw samples (no FDCT
// — lossless is exact). All components use 1×1 sampling (a single interleaved
// scan). Zero deps beyond build-jpeg-arith's ArithEncoder.
import { ArithEncoder } from './build-jpeg-arith.js';

export interface LosslessEncodeOptions {
  width: number; height: number;
  comps: 1 | 3 | 4;
  pixels: ArrayLike<number>;         // 0..255 (8-bit) or 0..4095 (12-bit)
  mode?: 'huffman' | 'arithmetic';   // default 'huffman'
  predictor?: 1 | 2 | 3 | 4 | 5 | 6 | 7; // default 1
  pointTransform?: number;           // Pt, default 0
  restartInterval?: number;          // in MCUs (= samples per component); default 0
  precision?: 8 | 12;                // default 8 (12-bit is grayscale-only)
  dac?: { L: number; U: number };    // arithmetic conditioning override
}

// H.1.2.1 predictor selection (psv 1..7) from neighbours.
function predict(psv: number, ra: number, rb: number, rc: number): number {
  switch (psv) {
    case 1: return ra; case 2: return rb; case 3: return rc;
    case 4: return ra + rb - rc;
    case 5: return ra + ((rb - rc) >> 1);
    case 6: return rb + ((ra - rc) >> 1);
    case 7: return (ra + rb) >> 1;
    default: throw new Error(`bad predictor ${psv}`);
  }
}
function category(v: number): number { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; }
function valueBits(v: number, n: number): number { return v < 0 ? v + (1 << n) - 1 : v; }

function fixedHuff(syms: Set<number>): { bits: number[]; vals: number[]; enc: Map<number, { code: number; len: number }> } {
  const vals = [...syms].sort((a, b) => a - b);
  const n = vals.length; let L = 1; while ((1 << L) - 1 < n) L++;
  const bits = new Array(16).fill(0); bits[L - 1] = n;
  const enc = new Map<number, { code: number; len: number }>();
  for (let i = 0; i < n; i++) enc.set(vals[i], { code: i, len: L });
  return { bits, vals, enc };
}

class BitWriter {
  bytes: number[] = []; private buf = 0; private cnt = 0;
  put(code: number, len: number): void { for (let i = len - 1; i >= 0; i--) { this.buf = (this.buf << 1) | ((code >> i) & 1); if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; } } }
  private emit(b: number): void { b &= 0xff; this.bytes.push(b); if (b === 0xff) this.bytes.push(0); }
  flush(): void { if (this.cnt > 0) { const pad = 8 - this.cnt; this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff); this.buf = 0; this.cnt = 0; } }
}

// Arithmetic DC-difference encode (mirror of src decodeArithDiff): encodes the
// signed `diff` against DC statistics `dcS` with conditioning L/U, updating ctx.
function encodeArithDiff(enc: ArithEncoder, dcS: Uint8Array, ctx: Int32Array, ci: number, diff: number, L: number, U: number): void {
  let st = ctx[ci]; let v = diff;
  if (v === 0) { enc.encode(dcS, st, 0); ctx[ci] = 0; return; }
  enc.encode(dcS, st, 1);
  if (v > 0) { enc.encode(dcS, st + 1, 0); st += 2; ctx[ci] = 4; }
  else { v = -v; enc.encode(dcS, st + 1, 1); st += 3; ctx[ci] = 8; }
  let m = 0;
  if (--v) { enc.encode(dcS, st, 1); m = 1; let v2 = v; st = 20; while (v2 >>= 1) { enc.encode(dcS, st, 1); m <<= 1; st += 1; } }
  enc.encode(dcS, st, 0);
  if (m < ((1 << L) >> 1)) ctx[ci] = 0; else if (m > ((1 << U) >> 1)) ctx[ci] += 8;
  st += 14; while (m >>= 1) enc.encode(dcS, st, (m & v) ? 1 : 0);
}

// Build raw per-component sample planes (all 1×1, plane = width×height), applying
// the point transform (>> Pt) and Adobe-inverting CMYK. Returns Adobe transform.
function buildPlanes(o: LosslessEncodeOptions): { planes: number[][]; adobe: number | undefined } {
  const { width, height, pixels } = o; const Pt = o.pointTransform ?? 0; const n = width * height;
  const sh = (v: number) => v >> Pt;
  if (o.comps === 1) { const g: number[] = []; for (let i = 0; i < n; i++) g.push(sh(pixels[i])); return { planes: [g], adobe: undefined }; }
  if (o.comps === 3) {
    const R: number[] = [], G: number[] = [], B: number[] = [];
    for (let i = 0; i < n; i++) { R.push(sh(pixels[i * 3])); G.push(sh(pixels[i * 3 + 1])); B.push(sh(pixels[i * 3 + 2])); }
    return { planes: [R, G, B], adobe: 0 }; // transform 0 → decoder stores RGB verbatim (exact)
  }
  const C: number[] = [], M: number[] = [], Y: number[] = [], K: number[] = [];
  for (let i = 0; i < n; i++) { C.push(sh(255 - pixels[i * 4])); M.push(sh(255 - pixels[i * 4 + 1])); Y.push(sh(255 - pixels[i * 4 + 2])); K.push(sh(255 - pixels[i * 4 + 3])); }
  return { planes: [C, M, Y, K], adobe: 0 };
}

export function encodeLosslessJpeg(o: LosslessEncodeOptions): Uint8Array {
  const { width, height } = o; const w = width, h = height;
  const nc = o.comps; const psv = o.predictor ?? 1; const Pt = o.pointTransform ?? 0;
  const precision = o.precision ?? 8; const ri = o.restartInterval ?? 0;
  const arith = o.mode === 'arithmetic';
  if (precision === 12 && nc !== 1) throw new Error('12-bit lossless is grayscale-only in this helper');
  const { planes, adobe } = buildPlanes(o);
  const def = 1 << (precision - Pt - 1);

  // Prediction at (x,y) in component plane; `reset` forces the default (start of
  // scan / restart interval).
  const predAt = (plane: number[], x: number, y: number, reset: boolean): number => {
    if (reset) return def;
    if (y === 0) return plane[x - 1];          // first row (x>0): Ra
    if (x === 0) return plane[(y - 1) * w];     // first col of later rows: Rb
    return predict(psv, plane[y * w + x - 1], plane[(y - 1) * w + x], plane[(y - 1) * w + x - 1]);
  };

  // --- Entropy coding: iterate MCUs (one sample per component per MCU, 1×1). ---
  const total = w * h; // MCUs (= samples, since 1×1)
  let entropy: number[] = [];

  if (!arith) {
    // Pass 1: collect DC-difference categories actually used.
    const dcSyms = new Set<number>([0]);
    { const reset = new Array(nc).fill(true); let mcu = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let ci = 0; ci < nc; ci++) { const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false; dcSyms.add(category(diff)); }
        mcu++; if (ri && mcu % ri === 0 && mcu < total) reset.fill(true);
      } }
    const dcH = fixedHuff(dcSyms);
    // Pass 2: emit, splicing RSTn at restart boundaries.
    const bw = new BitWriter(); const marks: { at: number; marker: number }[] = [];
    { const reset = new Array(nc).fill(true); let mcu = 0, rstIdx = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        for (let ci = 0; ci < nc; ci++) {
          const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false;
          const cat = category(diff); const c = dcH.enc.get(cat)!; bw.put(c.code, c.len); if (cat) bw.put(valueBits(diff, cat), cat);
        }
        mcu++; if (ri && mcu % ri === 0 && mcu < total) { bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); reset.fill(true); }
      } }
    bw.flush();
    // Splice markers.
    let prev = 0; for (const m of marks) { for (let i = prev; i < m.at; i++) entropy.push(bw.bytes[i]); entropy.push(0xff, m.marker); prev = m.at; }
    for (let i = prev; i < bw.bytes.length; i++) entropy.push(bw.bytes[i]);
    return assembleFile(o, planes, adobe, dcH, entropy, precision, psv, Pt, ri, false);
  }

  // Arithmetic (SOF11).
  const L = o.dac?.L ?? 0, U = o.dac?.U ?? 1;
  const dcS = new Uint8Array(64); const ctx = new Int32Array(nc);
  let enc = new ArithEncoder();
  { const reset = new Array(nc).fill(true); let mcu = 0, rstIdx = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let ci = 0; ci < nc; ci++) { const diff = planes[ci][y * w + x] - predAt(planes[ci], x, y, reset[ci]); reset[ci] = false; encodeArithDiff(enc, dcS, ctx, ci, diff, L, U); }
      mcu++;
      if (ri && mcu % ri === 0 && mcu < total) { for (const b of enc.finish()) entropy.push(b); entropy.push(0xff, 0xd0 + (rstIdx++ & 7)); enc = new ArithEncoder(); dcS.fill(0); ctx.fill(0); reset.fill(true); }
    } }
  for (const b of enc.finish()) entropy.push(b);
  return assembleFile(o, planes, adobe, null, entropy, precision, psv, Pt, ri, true, o.dac);
}

// Assemble the JPEG byte stream (SOF3 or SOF11). Lossless has no DQT.
function assembleFile(
  o: LosslessEncodeOptions, planes: number[][], adobe: number | undefined,
  dcH: { bits: number[]; vals: number[] } | null, entropy: number[],
  precision: number, psv: number, Pt: number, ri: number, arith: boolean,
  dac?: { L: number; U: number },
): Uint8Array {
  const nc = planes.length; const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  if (arith && dac) { out.push(0xff, 0xcc); u16(2 + 2); out.push(0x00, (dac.L << 4) | dac.U); } // DAC: DC table 0
  out.push(0xff, arith ? 0xcb : 0xc3); u16(8 + nc * 3); out.push(precision); u16(o.height); u16(o.width); out.push(nc); // SOF3/SOF11
  for (let i = 0; i < nc; i++) out.push(i + 1, 0x11, 0); // id, sampling 1×1, Tq=0
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); } // DRI
  if (!arith && dcH) { out.push(0xff, 0xc4); u16(2 + 1 + 16 + dcH.vals.length); out.push(0x00); for (let i = 0; i < 16; i++) out.push(dcH.bits[i]); for (const v of dcH.vals) out.push(v); } // DHT: DC table 0
  out.push(0xff, 0xda); u16(6 + nc * 2); out.push(nc);
  for (let i = 0; i < nc; i++) out.push(i + 1, 0x00); // comp selector, Td=0 Ta=0
  out.push(psv, 0, Pt & 15); // Ss=predictor, Se=0, Ah/Al=(0<<4)|Pt
  for (const b of entropy) out.push(b);
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Write the decoder `src/jpeglossless.ts` (Huffman path)**

Create `src/jpeglossless.ts`:

```ts
// Lossless (Annex H) JPEG decode: SOF3 (Huffman) and SOF11 (arithmetic). A
// predictive spatial pipeline — no DCT/quant/IDCT. Reuses jpeg.ts's Huffman
// primitives and combinePlanes, and jpegarith.ts's QM decoder; emits per-
// component sample planes consumed by combinePlanes.
import { PdfParseError } from './errors.js';
import { BitReader, decodeHuff, extend, combinePlanes } from './jpeg.js';
import type { Frame, Huff, Plane, JpegImage } from './jpeg.js';
import { ArithDecoder, decodeArithDiff } from './jpegarith.js';

// Allocate per-component full-resolution sample planes (T.81 A.2: a lossless data
// unit is one sample). bpl/bpc are the padded plane stride/height;
// blocksPerLine/blocksPerColumn hold the actual (unpadded) sample extent.
export function setupLosslessGeometry(frame: Frame): void {
  frame.mcusPerLine = Math.ceil(frame.width / frame.maxH);
  frame.mcusPerColumn = Math.ceil(frame.height / frame.maxV);
  for (const c of frame.comps) {
    c.bpl = frame.mcusPerLine * c.h;
    c.bpc = frame.mcusPerColumn * c.v;
    c.blocksPerLine = Math.ceil((frame.width * c.h) / frame.maxH);
    c.blocksPerColumn = Math.ceil((frame.height * c.v) / frame.maxV);
    c.samples = new Int32Array(c.bpl * c.bpc);
  }
}

// H.1.2.1 predictor selection (psv 1..7) from neighbours Ra (left), Rb (above),
// Rc (above-left).
export function losslessPredict(psv: number, ra: number, rb: number, rc: number): number {
  switch (psv) {
    case 1: return ra; case 2: return rb; case 3: return rc;
    case 4: return ra + rb - rc;
    case 5: return ra + ((rb - rc) >> 1);
    case 6: return rb + ((ra - rc) >> 1);
    case 7: return (ra + rb) >> 1;
    default: throw new PdfParseError(`JPEG: unsupported lossless predictor ${psv}`);
  }
}

interface LScan { c: Frame['comps'][number]; td: number }

export function decodeLosslessScan(
  data: Uint8Array, seg: number, frame: Frame,
  huffDC: (Huff | undefined)[], dcCond: { L: number; U: number }[], restartInterval: number,
): number {
  const ns = data[seg]; let p = seg + 1;
  const scan: LScan[] = [];
  for (let i = 0; i < ns; i++) {
    const cs = data[p], td = data[p + 1] >> 4; p += 2;
    const c = frame.comps.find((k) => k.id === cs); if (!c) throw new PdfParseError('JPEG: bad scan component');
    scan.push({ c, td });
  }
  const psv = data[p], Pt = data[p + 2] & 15; p += 3;
  const P = frame.precision;
  const def = 1 << (P - Pt - 1);
  const reset = new Array(ns).fill(true); // start-of-scan default for first sample

  // Per-component difference readers (Huffman table or arithmetic stats+context).
  let readDiff: (si: number) => number;
  let onRestart: () => void;
  let endPos: () => number;
  if (!frame.arithmetic) {
    const r = new BitReader(data, p);
    const tables = scan.map((s) => { const t = huffDC[s.td]; if (!t) throw new PdfParseError('JPEG: missing lossless Huffman table'); return t; });
    readDiff = (si) => { const s = decodeHuff(r, tables[si]); return s === 0 ? 0 : s === 16 ? 32768 : extend(r.receive(s), s); };
    onRestart = () => { r.restart(); reset.fill(true); };
    endPos = () => r.pos;
  } else {
    const dec = new ArithDecoder(data, p);
    const statsByTd = new Map<number, Uint8Array>();
    const dcStats = (td: number) => { let s = statsByTd.get(td); if (!s) statsByTd.set(td, s = new Uint8Array(64)); return s; };
    const ctx = new Int32Array(ns);
    const stats = scan.map((s) => dcStats(s.td));
    const bounds = scan.map((s) => dcCond[s.td] ?? { L: 0, U: 1 });
    readDiff = (si) => decodeArithDiff(dec, stats[si], ctx, si, bounds[si].L, bounds[si].U);
    onRestart = () => { dec.restart(); for (const s of statsByTd.values()) s.fill(0); ctx.fill(0); reset.fill(true); };
    endPos = () => dec.endPos();
  }

  // Decode one sample of component si at plane coordinate (x,y).
  const decodeSample = (si: number, x: number, y: number) => {
    const c = scan[si].c; const S = c.samples!; const bpl = c.bpl;
    let px: number;
    if (reset[si]) { px = def; reset[si] = false; }
    else if (y === 0) px = S[x - 1];
    else if (x === 0) px = S[(y - 1) * bpl];
    else px = losslessPredict(psv, S[y * bpl + x - 1], S[(y - 1) * bpl + x], S[(y - 1) * bpl + x - 1]);
    S[y * bpl + x] = (px + readDiff(si)) & 0xffff;
  };

  // Traversal: interleaved MCUs for ns>1, else per-sample raster.
  let mcu = 0;
  if (ns > 1) {
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
      for (let si = 0; si < ns; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) decodeSample(si, mx * c.h + bx, my * c.v + by); }
      mcu++; if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  } else {
    const c = scan[0].c; const total = c.blocksPerLine * c.blocksPerColumn;
    for (let y = 0; y < c.blocksPerColumn; y++) for (let x = 0; x < c.blocksPerLine; x++) {
      decodeSample(0, x, y);
      mcu++; if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  }

  // Apply point transform (samples were coded point-transformed; scale back up).
  if (Pt) for (const s of scan) { const S = s.c.samples!; for (let i = 0; i < S.length; i++) S[i] <<= Pt; }
  return endPos();
}

// Emit per-component planes (precision-downshifted to 8-bit) and interleave/colour
// via the shared combinePlanes.
export function assembleLossless(frame: Frame, adobeTransform: number | undefined): JpegImage {
  const down = frame.precision - 8;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const planes: Plane[] = frame.comps.map((c) => {
    const S = c.samples!; const plane = new Uint8Array(S.length);
    for (let i = 0; i < S.length; i++) plane[i] = clamp(S[i] >> down);
    return { plane, pw: c.bpl, ph: c.bpc, h: c.h, v: c.v };
  });
  return combinePlanes(frame, planes, adobeTransform);
}
```

(Note: `readDiff`, `onRestart`, and `endPos` are declared with `let` before the `if` and assigned in both branches, with a single `return endPos()` at the bottom.)

- [ ] **Step 5: Wire SOF3/SOF11 + dispatch into `decodeJpeg`**

In `src/jpeg.ts`, add the import at the top (next to the `jpegarith` import):

```ts
import { setupLosslessGeometry, decodeLosslessScan, assembleLossless } from './jpeglossless.js';
```

Extend the accepted-SOF branch condition and body. Change the `else if (marker === 0xc0 || ...)` line to also accept `0xc3` and `0xcb`:

```ts
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 || marker === 0xc9 || marker === 0xca || marker === 0xcb) { // SOF0/1 seq, SOF2 prog, SOF3 lossless, SOF9/10 arith DCT, SOF11 arith lossless
```

Update the `frame = { ... }` literal in that branch to set `lossless` and call the right geometry:

```ts
      const lossless = marker === 0xc3 || marker === 0xcb;
      frame = { width, height, comps, maxH, maxV, progressive: marker === 0xc2 || marker === 0xca, arithmetic: marker === 0xc9 || marker === 0xca || marker === 0xcb, lossless, precision, mcusPerLine: 0, mcusPerColumn: 0 };
      if (lossless) setupLosslessGeometry(frame); else setupGeometry(frame);
```

(Replace the existing `frame = {...}; setupGeometry(frame);` two lines with the three lines above.)

In the SOS branch, add the lossless dispatch:

```ts
      pos = frame.lossless
        ? decodeLosslessScan(data, seg, frame, huffDC, dcCond, restartInterval)
        : frame.arithmetic
        ? decodeArithScan(data, seg, segEnd, frame, dcCond, acCond, restartInterval)
        : decodeScan(data, seg, segEnd, frame, huffDC, huffAC, restartInterval);
```

At the end of `decodeJpeg`, change the final return to dispatch:

```ts
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return frame.lossless ? assembleLossless(frame, adobe) : assemble(frame, adobe, qt);
```

- [ ] **Step 6: Run the grayscale test — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "lossless (SOF3 Huffman)"`
Expected: PASS — grayscale decodes to the exact input.

- [ ] **Step 7: Add RGB, CMYK, and all-7-predictors tests**

Append inside the `describe('decodeJpeg — lossless (SOF3 Huffman)', ...)` block:

```ts
  it('decodes RGB (4:4:4) exactly', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes CMYK exactly', () => {
    const w = 6, h = 5; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 2) & 0xff; px[i * 4 + 1] = (i * 9) & 0xff; px[i * 4 + 2] = (i * 4 + 3) & 0xff; px[i * 4 + 3] = (i * 6 + 1) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 4, pixels: px }));
    expect(dec.comps).toBe(4); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes exactly under every predictor (1..7)', () => {
    const w = 10, h = 8; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 11 + y * 19 + x * y) & 0xff;
    for (let psv = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7; psv <= 7; psv++) {
      const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, predictor: psv }));
      expect(Array.from(dec.data), `predictor ${psv}`).toEqual(Array.from(px));
    }
  });
```

- [ ] **Step 8: Run the full lossless-Huffman block + typecheck**

Run: `npm run typecheck && npx vitest run test/jpeg.test.ts -t "lossless (SOF3 Huffman)"`
Expected: PASS — all four tests green.

- [ ] **Step 9: Commit**

```bash
git add src/jpeg.ts src/jpeglossless.ts test/helpers/build-jpeg-lossless.ts test/jpeg.test.ts
git commit -m "feat(ac6.2): Huffman lossless (SOF3) decode matches input exactly"
```

---

### Task 4: Arithmetic lossless (SOF11) — decode + exact round-trip + custom DAC

The encoder's arithmetic path already exists (Task 3, Step 3). This task adds the tests that exercise the SOF11 decode path (also already wired in Task 3, Step 5) and the custom-DAC round-trip.

**Files:**
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `encodeLosslessJpeg({ mode: 'arithmetic', ... })` from Task 3; `decodeLosslessScan` arithmetic branch from Task 3.

- [ ] **Step 1: Write the failing arithmetic tests**

Add a new describe block to `test/jpeg.test.ts`:

```ts
describe('decodeJpeg — lossless (SOF11 arithmetic)', () => {
  const A = 'arithmetic' as const;
  it('decodes grayscale exactly', () => {
    const w = 9, h = 7; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 13 + y * 7) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes RGB exactly', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) & 0xff; px[i * 3 + 1] = (i * 5 + 17) & 0xff; px[i * 3 + 2] = (i * 7 + 40) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px, mode: A }));
    expect(dec.comps).toBe(3); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes CMYK exactly', () => {
    const w = 6, h = 5; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = (i * 2) & 0xff; px[i * 4 + 1] = (i * 9) & 0xff; px[i * 4 + 2] = (i * 4 + 3) & 0xff; px[i * 4 + 3] = (i * 6 + 1) & 0xff; }
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 4, pixels: px, mode: A }));
    expect(dec.comps).toBe(4); expect(Array.from(dec.data)).toEqual(Array.from(px));
  });

  it('decodes exactly under every predictor (1..7)', () => {
    const w = 10, h = 8; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 11 + y * 19 + x * y) & 0xff;
    for (let psv = 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7; psv <= 7; psv++) {
      const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A, predictor: psv }));
      expect(Array.from(dec.data), `predictor ${psv}`).toEqual(Array.from(px));
    }
  });

  it('round-trips custom DAC conditioning', () => {
    const w = 12, h = 9; const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 21 + y * 5) & 0xff;
    const dec = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: A, dac: { L: 1, U: 3 } }));
    expect(Array.from(dec.data)).toEqual(Array.from(px));
  });
});
```

- [ ] **Step 2: Run — expect PASS (path already implemented in Task 3)**

Run: `npx vitest run test/jpeg.test.ts -t "lossless (SOF11 arithmetic)"`
Expected: PASS — all five tests green. If any fail, the arithmetic encode/decode symmetry is off; debug `encodeArithDiff` vs `decodeArithDiff` before proceeding.

- [ ] **Step 3: Commit**

```bash
git add test/jpeg.test.ts
git commit -m "feat(ac6.2): arithmetic lossless (SOF11) decode + custom DAC"
```

---

### Task 5: Restart intervals (both entropy coders)

**Files:**
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `encodeLosslessJpeg({ restartInterval, ... })` from Task 3; restart handling in `decodeLosslessScan`.

- [ ] **Step 1: Write the failing restart tests**

Add a describe block to `test/jpeg.test.ts`:

```ts
describe('decodeJpeg — lossless restart intervals', () => {
  const contains = (b: Uint8Array, m: number) => { for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === m) return true; return false; };
  const gradient = (w: number, h: number) => { const px = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 7 + y * 3) & 0xff; return px; };

  it('Huffman: restart stream decodes identically to no-restart (row-aligned)', () => {
    const w = 8, h = 6; const px = gradient(w, h);
    const rst = encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: w * 2 }); // every 2 rows
    expect(contains(rst, 0xdd)).toBe(true);           // DRI present
    expect(contains(rst, 0xd0)).toBe(true);           // at least one RST0
    const a = decodeJpeg(rst);
    const b = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(Array.from(a.data)).toEqual(Array.from(px)); // exact
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('arithmetic: restart stream decodes identically to no-restart (row-aligned)', () => {
    const w = 8, h = 6; const px = gradient(w, h);
    const rst = encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: 'arithmetic', restartInterval: w * 2 });
    expect(contains(rst, 0xdd)).toBe(true);
    expect(contains(rst, 0xd0)).toBe(true);
    const a = decodeJpeg(rst);
    const b = decodeJpeg(encodeLosslessJpeg({ width: w, height: h, comps: 1, pixels: px, mode: 'arithmetic' }));
    expect(Array.from(a.data)).toEqual(Array.from(px));
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});
```

- [ ] **Step 2: Run — expect PASS (restart handled in Task 3)**

Run: `npx vitest run test/jpeg.test.ts -t "lossless restart intervals"`
Expected: PASS. If the arithmetic case fails at a boundary, verify `ArithDecoder.restart()` resync and that both encoder and decoder set the predictor `reset` flags at the same MCU count.

- [ ] **Step 3: Commit**

```bash
git add test/jpeg.test.ts
git commit -m "feat(ac6.2): lossless restart intervals (Huffman + arithmetic)"
```

---

### Task 6: `decodeImageRgba` + redaction acceptance + real-file slot; close issue

**Files:**
- Test: `test/jpeg.test.ts` (decodeImageRgba + skip'd slot)
- Test: `test/redact-image.test.ts` (acceptance)
- Modify: `README.md` (Limitations — note lossless now supported)

**Interfaces:**
- Consumes: `decodeImageRgba` (already imported in `test/jpeg.test.ts`), `encodeLosslessJpeg`, `buildSingleImagePdfWithCm` / `redactPage` (already imported in `test/redact-image.test.ts`).

- [ ] **Step 1: Write the failing `decodeImageRgba` test**

Add to the `describe` block in `test/jpeg.test.ts` that already holds the arithmetic `decodeImageRgba` test (search for `'decodes an arithmetic (SOF9) JPEG image XObject to RGBA'`), a sibling:

```ts
  it('decodes a lossless (SOF3) JPEG image XObject to RGBA', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
    const res = doc.Pages[0].Resources!;
    const xobj = doc.resolve(res.get('XObject')) as PdfDict;
    const stream = doc.resolve(xobj.get('Im0'));
    if (!isStream(stream)) throw new Error('expected image stream');
    const img = decodeImageRgba(doc, stream, [0, 0, 0]);
    expect(img).toBeDefined();
    expect(img!.data[0]).toBe(200); expect(img!.data[1]).toBe(100); expect(img!.data[2]).toBe(50); // exact
  });
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "lossless (SOF3) JPEG image XObject"`
Expected: PASS.

- [ ] **Step 3: Add the skip'd real-file slot**

Append to `test/jpeg.test.ts`, after the last lossless describe block:

```ts
// Hybrid fixture slot: drop a real, externally-generated lossless JPEG here to
// guard against a shared encoder/decoder bug (the in-repo encoder validates only
// against the known input pixels — a strong oracle since lossless is exact, but it
// cannot catch a symmetric restart/predictor-reset bug). libjpeg's cjpeg cannot
// emit lossless; provenance recipe:
//   jpeg-9:   cjpeg -rgb1 ...  (jpeg-9 supports lossless via -precision/-restart)
//   PVRG:     pvrg-jpeg -l -s ref.jpg -ci 0 input.raw
// Commit the bytes as a Uint8Array + the known source pixels, then assert
// decodeJpeg(REF) equals the source exactly.
describe('decodeJpeg — lossless real-file reference', () => {
  it.skip('decodes a real (externally-generated) lossless JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF); // ...compare dec.data to known source pixels exactly
  });
});
```

- [ ] **Step 4: Write the failing redaction acceptance tests**

In `test/redact-image.test.ts`, add the import:

```ts
import { encodeLosslessJpeg } from './helpers/build-jpeg-lossless.js';
```

Then, after the arithmetic redaction test (`'blacks only the covered columns of an arithmetic JPEG (decode + re-encode)'`), add two tests:

```ts
  it('blacks only the covered columns of a lossless Huffman JPEG (decode + re-encode)', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5);
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of a lossless arithmetic JPEG (decode + re-encode)', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px, mode: 'arithmetic' });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5);
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });
```

- [ ] **Step 5: Run the acceptance tests**

Run: `npx vitest run test/redact-image.test.ts -t "lossless"`
Expected: PASS — both covered-column tests green (the covered pixels re-encode via the lossless path since the redacted image is re-saved through the normal image pipeline).

Note: `redactPage` decodes the lossless DCTDecode image, blacks the covered region, and re-encodes. Confirm the re-encode path (baseline) accepts the decoded RGBA — if the redaction re-encoder only handles specific inputs, no change is needed here because `decodeImageRgba`/`Decode()` already normalize to samples; the lossless work is purely on the decode side.

- [ ] **Step 6: Update README limitations**

In `README.md`, find the JPEG/DCTDecode limitation note (search for `lossless` or `arithmetic` under Limitations / Features). Update it to reflect that arithmetic (SOF9/10) and lossless (SOF3/SOF11) DCTDecode are now decoded; only differential/hierarchical (SOF5-7/13-15) remain unsupported. Match the surrounding wording.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green.

- [ ] **Step 8: Commit**

```bash
git add test/jpeg.test.ts test/redact-image.test.ts README.md
git commit -m "feat(ac6.2): lossless decodeImageRgba + redaction acceptance; docs"
```

- [ ] **Step 9: Close the beads issue and sync**

```bash
bd close aspose-pdf-foss-for-ts-ac6.2
git add .beads/ && git commit -m "chore(ac6.2): close ac6.2 (lossless JPEG shipped)" || true
git pull --rebase && git push && git status
```

Expected: `git status` shows "up to date with origin"; `bd ready` no longer lists ac6.2 (and ac6.3 is unblocked).

---

## Notes for the implementer

- **Oracle is exact equality.** Unlike the DCT paths (which compare within a DCT-rounding tolerance), lossless decodes must equal the input *byte for byte*. Any mismatch is a real bug — do not add tolerance.
- **Encoder/decoder symmetry.** The QM `encodeArithDiff` (helper) and `decodeArithDiff` (src) must mirror exactly; likewise the Huffman category/valueBits ↔ decodeHuff/extend. When debugging a mismatch, print the first divergent sample `(x,y,ci)` and compare predicted `Px` and decoded `diff` on both sides.
- **Restart reset is the committed jpeg-9 interpretation** (predictor resets to the start-of-scan default at each restart boundary). Both sides share the `reset` flag logic; the row-aligned test interval keeps it spec-plausible. The skip'd real-file slot is the eventual independent check.
- **`endPos` in `decodeLosslessScan`** is declared `let endPos: () => number;` before the `if`, assigned in both entropy branches, with one `return endPos()` at the bottom — strict-mode clean.
```
