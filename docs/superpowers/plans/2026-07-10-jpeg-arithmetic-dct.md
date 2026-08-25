# JPEG arithmetic-coded DCT decode (SOF9/SOF10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode arithmetic-coded sequential (SOF9) and progressive (SOF10) DCT JPEGs to pixel samples, so arithmetic `DCTDecode` images flow through the existing redaction pipeline unchanged.

**Architecture:** A new `src/jpegarith.ts` module holds the QM arithmetic entropy decoder (T.81 Annex D) plus arithmetic sequential/progressive scan procedures. It writes raw natural-order coefficients into the existing `Comp.blocks` store, so `jpeg.ts`'s dequant/IDCT/`assemble`/color path is reused byte-for-byte. `jpeg.ts` gains DAC-segment parsing, SOF9/SOF10 acceptance, an arithmetic SOS dispatch, and one extracted traversal helper shared by both entropy paths.

**Tech Stack:** TypeScript (ESM/NodeNext, strict), vitest. Zero runtime deps (only `node:` built-ins). Spec: `docs/superpowers/specs/2026-07-10-jpeg-arithmetic-dct-design.md`.

## Reference & fidelity (READ FIRST)

The entropy coder is **not to be invented**. Port it faithfully from the two authoritative public sources, which together implement exactly SOF9/SOF10 decode:

- **T.81 (ITU-T Rec. T.81 | ISO/IEC 10918-1)** — Annex D (arithmetic decoding procedures: `INITDEC`, `DECODE`, `RENORMD`, `BYTEIN`, MPS/LPS exchange), Annex F.1.4 (arithmetic sequential DC/AC decode), Annex G.2 (arithmetic progressive), Annex B.2.4.3 (DAC segment).
- **libjpeg `jdarith.c` + `jaricom.c`** — the reference C implementation. Port these functions to TS: `jaricom.c`'s `jpeg_aritab[]` (the packed 113-state Table D.3 — transcribe **verbatim**, do not hand-derive), and `jdarith.c`'s `arith_decode`, `decode_mcu` (sequential), `decode_mcu_DC_first`, `decode_mcu_AC_first`, `decode_mcu_DC_refine`, `decode_mcu_AC_refine`, and the stats sizing (`DC_STAT_BINS 64`, `AC_STAT_BINS 256`).

**Adaptation mapping (libjpeg → this repo):**
- libjpeg per-block `coef`/`MCU_buffer` writes → `frame.comps[].blocks[off + naturalIndex]` (we store **raw** coefficients in **natural** order; `off = blockRow * bpl * 64 + blockCol * 64`; convert libjpeg's zig-zag index `k` via `ZIGZAG[k]`, exactly as the Huffman path in `src/jpeg.ts` does).
- libjpeg `cinfo->arith_dc_L[tbl]`, `arith_dc_U[tbl]`, `arith_ac_K[tbl]` → our `dcCond[tbl] = {L, U}`, `acCond[tbl] = {Kx}` (from DAC; defaults `L=0, U=1, Kx=5`).
- libjpeg `entropy->dc_stats[tbl]` / `ac_stats[tbl]` (`UINT8*`) → our `Uint8Array` per used table; each byte packs `(index<<1)|mps` exactly as libjpeg does.
- libjpeg predictor `entropy->last_dc_val[ci]` and `dc_context[ci]` → our per-component `Da` (previous diff) and derived context.
- Restart: libjpeg `process_restart` (re-`INITDEC`, reset all stats, zero predictors) → our `onRestart` callback.

**Validation strategy:** every arithmetic path is checked by decoding an in-repo arithmetic stream and comparing the pixels to the **baseline Huffman** decode of the *same source pixels* (different entropy coder, identical coefficients — a symmetric encoder bug cannot pass this). Plus a skip'd real-`cjpeg -arithmetic` reference slot.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins (`zlib`, `crypto`, `fs`). No npm runtime deps. (Test-only helpers may use `node:zlib`.)
- ESM + NodeNext: every relative import specifier carries the `.js` extension (e.g. `import { forEachBlockInScan } from './jpeg.js'`).
- Strict TypeScript. `npm run typecheck` and `npm test` must both be green before closing.
- Public error types only: `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`.
- Live-mutation model unchanged; the public `JpegImage` interface (`{ width, height, comps, data: Uint8Array }`) does not change. 12-bit precision already downscales in `assemble` — arithmetic reuses it.
- TDD: failing test first, watch it fail, minimal code, watch it pass, commit. Mirror existing builder/test style (`test/helpers/build-jpeg.ts`, `test/jpeg.test.ts`).

---

## File Structure

- **Create `src/jpegarith.ts`** — `ArithDecoder` (QM coder), `ArithStats`, `decodeArithScan`, the packed 113-state table. One responsibility: arithmetic entropy decoding of DCT scans into `Comp.blocks`.
- **Modify `src/jpeg.ts`** — export `Frame`/`Comp`/`ZIGZAG`/`forEachBlockInScan`; add `Frame.arithmetic`; parse DAC (0xCC); accept SOF9/SOF10; dispatch SOS to `decodeArithScan` when arithmetic. Refactor the traversal out of `decodeScan` (no behavior change).
- **Create `test/helpers/build-jpeg-arith.ts`** — in-repo QM *encoder* emitting SOF9/SOF10 (+ optional DAC, DRI/RSTn). Reuses `buildComponentBlocks` from `build-jpeg.ts`.
- **Modify `test/helpers/build-jpeg.ts`** — `export` `buildComponentBlocks` (and the `CompInfo`/`CompBlocks` types it returns) for reuse by the arithmetic encoder.
- **Modify `test/jpeg.test.ts`** — arithmetic unit tests.
- **Modify `test/redact-image.test.ts`** — arithmetic redaction acceptance test.
- **Modify `README.md`** — note arithmetic DCT is decoded for redaction.

---

## Task 1: Extract shared scan traversal in `jpeg.ts`

Pure refactor: lift the MCU/block loops + restart cadence out of `decodeScan` into an exported helper, so the arithmetic path can reuse it. Existing tests guard behavior (no new test needed to prove correctness, but we run the suite to confirm zero change).

**Files:**
- Modify: `src/jpeg.ts` (the tail of `decodeScan`, ~lines 213-231; plus `export` on `Frame`, `Comp`, `ZIGZAG`)

**Interfaces:**
- Produces: `export function forEachBlockInScan(frame: Frame, scan: { c: Comp }[], restartInterval: number, decodeBlock: (si: number, off: number) => void, onRestart: () => void): void`
- Produces: `export interface Frame`, `export interface Comp`, `export const ZIGZAG`

- [ ] **Step 1: Add the exported helper** (place above `decodeScan` in `src/jpeg.ts`)

```ts
/** Walk a scan's blocks in decode order, invoking `decodeBlock(si, off)` per
 *  block (off = coefficient offset into that component's `blocks`). Fires
 *  `onRestart` at each restart-interval boundary (before the next block).
 *  Shared by the Huffman and arithmetic entropy paths. */
export function forEachBlockInScan(
  frame: Frame,
  scan: { c: Comp }[],
  restartInterval: number,
  decodeBlock: (si: number, off: number) => void,
  onRestart: () => void,
): void {
  let mcu = 0;
  if (scan.length > 1) { // interleaved multi-component scan
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
      for (let si = 0; si < scan.length; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) decodeBlock(si, ((my * c.v + by) * c.bpl + (mx * c.h + bx)) * 64); }
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  } else { // non-interleaved single-component scan
    const c = scan[0].c;
    const total = c.blocksPerLine * c.blocksPerColumn;
    for (let by = 0; by < c.blocksPerColumn; by++) for (let bx = 0; bx < c.blocksPerLine; bx++) {
      decodeBlock(0, (by * c.bpl + bx) * 64);
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) onRestart();
    }
  }
}
```

- [ ] **Step 2: Rewrite the tail of `decodeScan` to call it**

Replace the existing block from `const resetPredictors = ...` through the two traversal loops (the `if (scan.length > 1) { ... } else { ... }` at the end of `decodeScan`) with:

```ts
  const resetPredictors = () => { pred.fill(0); eobrun = 0; };
  forEachBlockInScan(frame, scan, restartInterval, decodeBlock, () => { r.restart(); resetPredictors(); });
  return r.pos;
```

- [ ] **Step 3: Add `export` to `Frame`, `Comp`, `ZIGZAG`**

Change `interface Frame` → `export interface Frame`, `interface Comp` → `export interface Comp`, `const ZIGZAG` → `export const ZIGZAG`.

- [ ] **Step 4: Run the full JPEG + redaction suites to prove no behavior change**

Run: `npx vitest run test/jpeg.test.ts test/redact-image.test.ts`
Expected: PASS (all existing tests green — refactor is behavior-preserving).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/jpeg.ts
git commit -m "refactor(ac6.1): extract forEachBlockInScan shared by entropy paths"
```

---

## Task 2: QM arithmetic decoder + encoder primitives

Port the Annex D register machinery. Co-develop a minimal encoder (`ArithEncoder`) so we can round-trip at the bit level; the decoder is the deliverable, the encoder is test infrastructure that later tasks reuse.

**Files:**
- Create: `src/jpegarith.ts`
- Create: `test/helpers/build-jpeg-arith.ts` (encoder primitives added here)
- Test: `test/jpegarith.test.ts`

**Interfaces:**
- Produces (`src/jpegarith.ts`): `export class ArithDecoder { constructor(data: Uint8Array, pos: number); decode(stats: Uint8Array, s: number): 0 | 1; get pos(): number; init(): void }`
- Produces (`test/helpers/build-jpeg-arith.ts`): `export class ArithEncoder { encode(stats: Uint8Array, s: number, decision: 0 | 1): void; finish(): number[] }`
- Both share the packed table constant (encoder duplicates it — test-only, like the FDCT tables are duplicated in `build-jpeg.ts`).

- [ ] **Step 1: Write the failing bit-level round-trip test** (`test/jpegarith.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { ArithDecoder } from '../src/jpegarith.js';
import { ArithEncoder } from './helpers/build-jpeg-arith.js';

describe('QM arithmetic coder', () => {
  it('round-trips a pseudo-random decision sequence through one context', () => {
    // Deterministic LCG bit source.
    let seed = 0x12345;
    const nextBit = (): 0 | 1 => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >> 16) & 1) as 0 | 1; };
    const bits: (0 | 1)[] = []; for (let i = 0; i < 5000; i++) bits.push(nextBit());

    const enc = new ArithEncoder();
    const est = new Uint8Array(1); // single adaptive context
    for (const b of bits) enc.encode(est, 0, b);
    const bytes = Uint8Array.from(enc.finish());

    const dec = new ArithDecoder(bytes, 0);
    const dst = new Uint8Array(1);
    for (let i = 0; i < bits.length; i++) expect(dec.decode(dst, 0)).toBe(bits[i]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/jpegarith.test.ts`
Expected: FAIL — `ArithDecoder`/`ArithEncoder` not defined.

- [ ] **Step 3: Implement `src/jpegarith.ts` decoder core**

Port faithfully from `jaricom.c` + `jdarith.c` §D.2. Structure:

```ts
// Arithmetic (QM-coder) entropy decoder for JPEG SOF9/SOF10, per ITU-T T.81
// Annex D. Ported from libjpeg jdarith.c / jaricom.c. Statistics bins pack
// (index<<1)|mps per byte, exactly as libjpeg.
import { PdfParseError } from './errors.js';

// Packed Table D.3: each entry = (Qe<<16) | (nextMPS<<8) | (nextLPS<<... ) ...
// TRANSCRIBE VERBATIM from libjpeg jaricom.c `jpeg_aritab` (113 entries). The
// packing there is: (Qe << 16) | (Switch_MPS << 15?) ... use libjpeg's exact
// layout and the exact accessor shifts from arith_decode below to match it.
const ARITAB: Int32Array = /* verbatim from jaricom.c jpeg_aritab[] */ new Int32Array([ /* ... */ ]);

export class ArithDecoder {
  private c = 0; private a = 0; private ct = 0;
  private markerSeen = false;
  constructor(private d: Uint8Array, private p: number) { this.init(); }
  get pos(): number { return this.p; }

  // INITDEC (D.2.2) — port from jdarith.c start_pass / and arith_decode's first fill.
  init(): void { /* c = (getByte<<16); BYTEIN; c<<=7; ct-=7; a=0x8000; per libjpeg */ }

  // Fetch next entropy byte with 0xFF marker/stuffing handling (BYTEIN, D.2.6).
  private byteIn(): void { /* port jdarith.c inline byte fetch: 0xFF followed by >0x8F ⇒ marker, stuff zeros */ }

  // DECODE one binary decision against stats bin `s`; returns the decoded bit.
  // Port arith_decode(): renorm loop calling byteIn, Qe lookup via ARITAB[st&0x7f],
  // conditional MPS/LPS exchange, state transition write-back to stats[s].
  decode(stats: Uint8Array, s: number): 0 | 1 { /* ... */ return 0; }
}
```

Implementation notes for the porter (from `jdarith.c arith_decode`): keep `a` 16-bit-ish and `c` as libjpeg does; the renormalization `while (a < 0x8000)` decrements `ct`, calls the byte fetch when `ct < 0`, and shifts. On marker/EOF, stuff `0x00` data bytes (libjpeg sets `data = 0`). Match ARITAB's bit-packing to the accessor shifts — verify by making Step 6 pass.

- [ ] **Step 4: Implement `ArithEncoder` in `test/helpers/build-jpeg-arith.ts`**

Port `jcarith.c` `arith_encode` + `emit_byte` + `finish_pass` (INITENC/ENCODE/RENORME/BYTEOUT/FLUSH, D.1). Duplicate the same `ARITAB` constant. The encoder need only be correct enough to round-trip the decoder (validated by the baseline cross-check in later tasks, and this bit round-trip now).

```ts
export class ArithEncoder {
  // c, a, sc, ct, buffer per jcarith.c; encode(stats, s, decision) and finish() → number[]
  encode(stats: Uint8Array, s: number, decision: 0 | 1): void { /* port arith_encode */ }
  finish(): number[] { /* port finish_pass: flush, return entropy bytes (0xFF-stuffed) */ return []; }
}
```

- [ ] **Step 5: Run the round-trip test**

Run: `npx vitest run test/jpegarith.test.ts`
Expected: PASS. If it fails, the ARITAB packing and the `arith_decode`/`arith_encode` shifts disagree — align them (this is the intended validation of the verbatim table transcription).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expect clean)
```bash
git add src/jpegarith.ts test/helpers/build-jpeg-arith.ts test/jpegarith.test.ts
git commit -m "feat(ac6.1): QM arithmetic decoder + encoder primitives (bit round-trip)"
```

---

## Task 3: DAC parsing, Frame.arithmetic, SOF9/10 acceptance, SOS dispatch

Wire the container-level pieces so an arithmetic stream reaches `decodeArithScan` (added in Task 4). This task lands with a stub `decodeArithScan` that throws, plus the parsing/acceptance, verified by a unit test asserting SOF9 is recognized (reaches the scan) rather than rejected at SOF.

**Files:**
- Modify: `src/jpeg.ts` (marker loop: DAC branch, SOF9/10 acceptance, SOS dispatch; `Frame` gains `arithmetic`)
- Modify: `src/jpegarith.ts` (add `decodeArithScan` signature + `ArithStats`; sequential/progressive bodies come in Tasks 4-5)

**Interfaces:**
- Produces (`jpeg.ts`): `Frame.arithmetic: boolean`; DAC conditioning `dcCond: {L:number;U:number}[]`, `acCond: {Kx:number}[]` passed to `decodeArithScan`.
- Produces (`jpegarith.ts`): `export class ArithStats { dc: Uint8Array; ac: Uint8Array; da: number; reset(): void }` (sized 64/256 per used table — allocate per component); `export function decodeArithScan(data: Uint8Array, seg: number, entropy: number, frame: Frame, dcCond: {L:number;U:number}[], acCond: {Kx:number}[], restartInterval: number): number`

- [ ] **Step 1: Add `Frame.arithmetic` and DAC state in `jpeg.ts`**

In `decodeJpeg`, alongside `const huffDC ...`, add:
```ts
  const dcCond: { L: number; U: number }[] = [];
  const acCond: { Kx: number }[] = [];
```
Add `arithmetic: boolean` to `export interface Frame` and set it in the SOF branch (Step 3).

- [ ] **Step 2: Parse the DAC segment** (add a branch in the marker loop, after the DHT `0xc4` branch)

```ts
    } else if (marker === 0xcc) {                                // DAC (arithmetic conditioning)
      let p = seg;
      while (p < segEnd) {
        const tc = data[p] >> 4, tb = data[p] & 15, val = data[p + 1]; p += 2;
        if (tc === 0) dcCond[tb] = { L: val >> 4, U: val & 15 };
        else acCond[tb] = { Kx: val };
      }
```

- [ ] **Step 3: Accept SOF9/SOF10; set `arithmetic`**

Change the SOF branch condition from `marker === 0xc0 || marker === 0xc1 || marker === 0xc2` to also allow `0xc9 || 0xca`, and set:
```ts
      frame = { width, height, comps, maxH, maxV, progressive: marker === 0xc2 || marker === 0xca, arithmetic: marker === 0xc9 || marker === 0xca, precision, mcusPerLine: 0, mcusPerColumn: 0 };
```
Leave the "unsupported coding process" guard (the `0xc3..0xcf` else-if) in place for the still-unsupported markers; it must not catch `0xc9`/`0xca`/`0xcc` — verify the existing guard already excludes `0xc4`/`0xc8` and extend its exclusions to `0xc9`, `0xca`, `0xcc`, or reorder so the SOF/DAC branches run first (they already precede it — confirm `0xcc` DAC branch is before the guard).

- [ ] **Step 4: Dispatch SOS to the arithmetic scan**

In the `0xda` SOS branch, replace the single call with:
```ts
      pos = frame.arithmetic
        ? decodeArithScan(data, seg, segEnd, frame, dcCond, acCond, restartInterval)
        : decodeScan(data, seg, segEnd, frame, huffDC, huffAC, restartInterval);
```
Add `import { decodeArithScan } from './jpegarith.js';` at the top.

- [ ] **Step 5: Add `ArithStats` + a stub `decodeArithScan` that throws** (`jpegarith.ts`)

```ts
export class ArithStats {
  dc = new Uint8Array(64); ac = new Uint8Array(256); da = 0;
  reset(): void { this.dc.fill(0); this.ac.fill(0); this.da = 0; }
}
export function decodeArithScan(
  data: Uint8Array, seg: number, entropy: number, frame: Frame,
  dcCond: { L: number; U: number }[], acCond: { Kx: number }[], restartInterval: number,
): number {
  throw new UnsupportedFeatureError('JPEG: arithmetic scan not yet implemented');
}
```
Import `Frame` from `./jpeg.js` and `UnsupportedFeatureError` from `./errors.js`.

- [ ] **Step 6: Write the failing acceptance-of-marker test** (`test/jpeg.test.ts`)

```ts
it('recognizes an arithmetic SOF9 frame (reaches the scan, not rejected at SOF)', () => {
  // Minimal SOF9 + SOS; the scan stub throws its own message, proving SOF/SOS parsed.
  const b = Uint8Array.from([0xff, 0xd8, 0xff, 0xc9, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]);
  expect(() => decodeJpeg(b)).toThrow('arithmetic scan not yet implemented');
});
```

- [ ] **Step 7: Run — expect PASS** (SOF9 now parsed, stub throws the marker message)

Run: `npx vitest run test/jpeg.test.ts -t "arithmetic SOF9"`
Expected: PASS. Also run `npx vitest run test/jpeg.test.ts` to confirm the existing "arithmetic coding (SOF9)" negative test — WAIT: the existing test at `test/jpeg.test.ts` asserts SOF9 throws `UnsupportedFeatureError`. Update that test in this step: it now must assert the *scan-stub* message (still an `UnsupportedFeatureError`) or be replaced by this new test. Delete/replace the old "throws UnsupportedFeatureError for arithmetic coding (SOF9)" case so the suite is consistent.

- [ ] **Step 8: Typecheck + commit**

```bash
git add src/jpeg.ts src/jpegarith.ts test/jpeg.test.ts
git commit -m "feat(ac6.1): parse DAC, accept SOF9/10, dispatch arithmetic SOS (stub scan)"
```

---

## Task 4: Arithmetic sequential DC + AC decode (SOF9)

The first real decode. Implement sequential DC/AC per F.1.4 in `decodeArithScan`, and the matching encoder scan in `build-jpeg-arith.ts`. Validate against the baseline Huffman decode of the same pixels.

**Files:**
- Modify: `src/jpegarith.ts` (`decodeArithScan` sequential body: per-component `ArithStats`, DC decode, AC decode, via `forEachBlockInScan`)
- Modify: `test/helpers/build-jpeg-arith.ts` (`encodeSequentialArithJpeg(o: JpegEncodeOptions): Uint8Array`)
- Modify: `test/helpers/build-jpeg.ts` (`export function buildComponentBlocks`, and `export` its return types)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Consumes: `forEachBlockInScan`, `Frame`, `Comp`, `ZIGZAG` (Task 1); `ArithDecoder`, `ArithStats` (Tasks 2-3); `buildComponentBlocks` (from `build-jpeg.ts`).
- Produces: `export function encodeSequentialArithJpeg(o: JpegEncodeOptions): Uint8Array` (SOF9). `decodeArithScan` sequential path fully functional.

- [ ] **Step 1: Export `buildComponentBlocks` from `build-jpeg.ts`**

Add `export` to `function buildComponentBlocks` and to the `CompInfo`/`CompBlocks` interfaces it uses.

- [ ] **Step 2: Write the failing test** (`test/jpeg.test.ts`)

```ts
describe('decodeJpeg — arithmetic (SOF9), sequential', () => {
  it('round-trips grayscale and matches the baseline decode', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(ari.width).toBe(w); expect(ari.comps).toBe(1);
    for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB (interleaved) and matches baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px }));
    for (let i = 0; i < w * h * 3; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips a subsampled (4:2:0) flat RGB image matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });
});
```
Add `encodeSequentialArithJpeg` to the existing import from `./helpers/build-jpeg-arith.js`.

- [ ] **Step 3: Run — expect FAIL** (`encodeSequentialArithJpeg` undefined / scan stub throws)

Run: `npx vitest run test/jpeg.test.ts -t "arithmetic (SOF9)"`
Expected: FAIL.

- [ ] **Step 4: Implement sequential `decodeArithScan`** (`jpegarith.ts`)

Parse the SOS header (component selectors — arithmetic ignores Td/Ta but reads the byte; then `Ss,Se,Ah,Al`). Allocate one `ArithStats` per scan component. Build an `ArithDecoder` at `entropy`. Implement:

- `decodeDCSequential(dec, stats, cond, off, comp)` — port `jdarith.c decode_mcu` DC part / F.1.4.4.1: choose context from `stats.da` classified by `cond.L/U`; decode is-zero, sign, magnitude size, magnitude low bits; `stats.da = diff`; `comp.blocks[off] = (prevDcOfComponent += diff)`. Track the running DC predictor per component (separate from `da`, which is the *previous difference* used for context) — mirror libjpeg's `last_dc_val` vs `dc_context`.
- `decodeACSequential(dec, stats, cond, off)` — port `decode_mcu` AC part / F.1.4.4.2: for k=1..63, EOB decision, zero-run decisions, sign+magnitude; write `blocks[off + ZIGZAG[k]]`.

Drive both with `forEachBlockInScan(frame, scan, restartInterval, (si, off) => { decodeDC...; decodeAC...; }, () => { dec.init(); for (s of stats) s.reset(); resetDcPredictors(); })`. Return `dec.pos`.

Follow the adaptation mapping in "Reference & fidelity". Get the exact context-bin indices and decision tree from `jdarith.c`.

- [ ] **Step 5: Implement `encodeSequentialArithJpeg`** (`build-jpeg-arith.ts`)

Reuse `buildComponentBlocks(o)` for the coefficient blocks. Emit: SOI, optional Adobe APP14 (for comps≥3, mirror `encodeBaselineJpeg`), DQT (all-ones), **SOF9** (`0xff 0xc9`, precision 8), SOS header, then entropy from an `ArithEncoder` driving the mirror-image DC/AC *encode* procedures over the same block traversal as the decoder, then EOI. No DHT/DAC (defaults). Mirror `encodeBaselineJpeg`'s structure exactly except the entropy stage and SOF marker.

- [ ] **Step 6: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "arithmetic (SOF9)"`
Expected: PASS (arithmetic decode equals baseline decode).

- [ ] **Step 7: CMYK case** — add to the same describe:

```ts
  it('round-trips a flat CMYK (Adobe) image matching baseline', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i * 4] = 30; px[i * 4 + 1] = 60; px[i * 4 + 2] = 90; px[i * 4 + 3] = 120; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 4, pixels: px }));
    const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 4, pixels: px }));
    for (let i = 0; i < w * h * 4; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });
```
Run: `npx vitest run test/jpeg.test.ts -t "arithmetic (SOF9)"` → PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
git add src/jpegarith.ts test/helpers/build-jpeg-arith.ts test/helpers/build-jpeg.ts test/jpeg.test.ts
git commit -m "feat(ac6.1): arithmetic sequential DCT decode (SOF9) matches baseline"
```

---

## Task 5: Arithmetic progressive decode (SOF10)

Add the four progressive block procedures + encoder scans. Same spectral-selection / successive-approximation structure as the Huffman progressive path.

**Files:**
- Modify: `src/jpegarith.ts` (progressive DC-first/DC-refine/AC-first/AC-refine; dispatch on `Ss/Ah`)
- Modify: `test/helpers/build-jpeg-arith.ts` (`encodeProgressiveArithJpeg(o: JpegEncodeOptions): Uint8Array` — DC scan then per-component AC scans, first + refine when `successive`)
- Test: `test/jpeg.test.ts`

**Interfaces:**
- Produces: `export function encodeProgressiveArithJpeg(o: JpegEncodeOptions): Uint8Array` (SOF10). `decodeArithScan` progressive dispatch complete.

- [ ] **Step 1: Write the failing tests** (`test/jpeg.test.ts`)

```ts
describe('decodeJpeg — arithmetic progressive (SOF10)', () => {
  it('round-trips grayscale (spectral selection) matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const ari = decodeJpeg(encodeProgressiveArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
    for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB with successive approximation matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 17) % 256; px[i * 3 + 1] = (i * 31) % 256; px[i * 3 + 2] = (i * 47) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const ari = decodeJpeg(encodeProgressiveArithJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true }));
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(ari.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run test/jpeg.test.ts -t "arithmetic progressive"`
Expected: FAIL.

- [ ] **Step 3: Implement progressive procedures** (`jpegarith.ts`)

Port from `jdarith.c`: `decode_mcu_DC_first`, `decode_mcu_DC_refine`, `decode_mcu_AC_first`, `decode_mcu_AC_refine`. Dispatch inside `decodeArithScan`: `Ss===0 ? (Ah===0 ? DCfirst : DCrefine) : (Ah===0 ? ACfirst : ACrefine)`. Store coefficients `<< Al` (first scans) / OR-in refinement bits, matching the Huffman path so `assemble` dequantizes uniformly. DC-refine and AC-refine correction bits use the fixed (0.5) decode. AC scans are non-interleaved (single component) — `forEachBlockInScan` already handles that.

- [ ] **Step 4: Implement `encodeProgressiveArithJpeg`** (`build-jpeg-arith.ts`)

Mirror `encodeProgressiveJpeg`'s scan sequencing (interleaved DC scan at `Al`, then refine to 0 when `successive`; per-component AC first at `Al`, then refine) but arithmetic-coded and with SOF10 (`0xff 0xca`). Reuse `buildComponentBlocks` and the scan-band traversal logic.

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "arithmetic progressive"`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
git add src/jpegarith.ts test/helpers/build-jpeg-arith.ts test/jpeg.test.ts
git commit -m "feat(ac6.1): arithmetic progressive DCT decode (SOF10) matches baseline"
```

---

## Task 6: Restart interval + custom DAC conditioning

Prove the decoder + statistics reset at RST boundaries, and that non-default DAC conditioning round-trips.

**Files:**
- Modify: `test/helpers/build-jpeg-arith.ts` (honor `restartInterval` → emit DRI + RSTn with encoder flush/reset at each boundary; accept optional `dac` conditioning override)
- Test: `test/jpeg.test.ts`

- [ ] **Step 1: Write the failing restart test** (`test/jpeg.test.ts`)

```ts
it('decodes an arithmetic stream with a restart interval identically', () => {
  const w = 24, h = 24; const px = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
  const rstBytes = encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px, restartInterval: 3 });
  let hasDri = false, hasRst = false;
  for (let i = 0; i + 1 < rstBytes.length; i++) { if (rstBytes[i] === 0xff) { const m = rstBytes[i + 1]; if (m === 0xdd) hasDri = true; if (m >= 0xd0 && m <= 0xd7) hasRst = true; } }
  expect(hasDri).toBe(true); expect(hasRst).toBe(true);
  const plain = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px }));
  const rst = decodeJpeg(rstBytes);
  for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
});
```

- [ ] **Step 2: Run — expect FAIL** (encoder ignores `restartInterval`)

Run: `npx vitest run test/jpeg.test.ts -t "restart interval identically"`
Expected: FAIL.

- [ ] **Step 3: Implement restart in the encoder**

At each restart boundary: `ArithEncoder.finish()` (flush) the current segment, emit `0xff 0xd0+n`, start a fresh `ArithEncoder` + reset stats + zero DC predictors — mirroring the decoder's `onRestart`. Emit the DRI segment (`0xff 0xdd`, len 4, interval) before the SOS. The decoder side already resets via `onRestart` (Task 4) — the `ArithDecoder.init()` re-sync consumes the RSTn marker and re-`INITDEC`s. Confirm `ArithDecoder` skips to past the RSTn marker on `init()` at a restart (port `jdarith.c process_restart`).

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run test/jpeg.test.ts -t "restart interval identically"`
Expected: PASS.

- [ ] **Step 5: Custom DAC test** — add:

```ts
it('round-trips non-default DAC conditioning (L/U/Kx) matching baseline', () => {
  const w = 16, h = 16; const px = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) px[i] = (i * 37) % 256;
  const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
  const ari = decodeJpeg(encodeSequentialArithJpeg({ width: w, height: h, comps: 1, pixels: px, dac: { L: 1, U: 3, Kx: 6 } }));
  for (let i = 0; i < w * h; i++) expect(ari.data[i]).toBe(base.data[i]);
});
```
Add `dac?: { L: number; U: number; Kx: number }` to the arith encoder options; when set, emit a DAC segment (`0xff 0xcc`) and have the encoder use those bounds for context selection (its DC/AC encode must use the same `L/U/Kx` as the decoder reads). Run → PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
git add src/jpegarith.ts test/helpers/build-jpeg-arith.ts test/jpeg.test.ts
git commit -m "feat(ac6.1): arithmetic restart intervals + custom DAC conditioning"
```

---

## Task 7: RGBA decode + redaction acceptance + docs + close

End-to-end: the ac6 acceptance criterion, plus `decodeImageRgba` coverage, the hybrid reference slot, README, and issue close.

**Files:**
- Modify: `test/jpeg.test.ts` (`decodeImageRgba` arithmetic case + skip'd hybrid slot)
- Modify: `test/redact-image.test.ts` (redaction acceptance)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-10-jpeg-arithmetic-dct-design.md` (status → shipped)

- [ ] **Step 1: `decodeImageRgba` arithmetic test** (`test/jpeg.test.ts`, in the `decodeImageRgba — DCTDecode` describe)

```ts
it('decodes an arithmetic (SOF9) JPEG image XObject to RGBA', () => {
  const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
  const jpg = encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px });
  const doc = Document.Open(buildSingleImagePdf({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg }));
  const res = doc.Pages[0].Resources!;
  const xobj = doc.resolve(res.get('XObject')) as PdfDict;
  const stream = doc.resolve(xobj.get('Im0'));
  if (!isStream(stream)) throw new Error('expected image stream');
  const img = decodeImageRgba(doc, stream, [0, 0, 0]);
  expect(img).toBeDefined();
  near(img!.data[0], 200, 5); near(img!.data[1], 100, 5); near(img!.data[2], 50, 5);
});
```

- [ ] **Step 2: Redaction acceptance test** (`test/redact-image.test.ts`, after the progressive-JPEG redaction test)

```ts
it('blacks only the covered columns of an arithmetic JPEG (decode + re-encode)', () => {
  const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
  const jpg = encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px });
  const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
  redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
  const reopened = Document.Open(doc.Save());
  const imgs = reopened.Pages[0].Images;
  expect(imgs).toHaveLength(1);
  const iw = imgs[0].Width, samples = imgs[0].Decode();
  const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
  expect(px2(0, 0)).toEqual([0, 0, 0]);
  expect(px2(1, 4)).toEqual([0, 0, 0]);
  expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5);
  expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
});
```
Add `encodeSequentialArithJpeg` to the `./helpers/build-jpeg-arith.js` import in this file.

- [ ] **Step 3: Hybrid reference slot** (`test/jpeg.test.ts`)

```ts
// Provenance: cjpeg -arithmetic -sample 1x1 -outfile ref.jpg input.ppm  (libjpeg).
// Paste the bytes + known source pixels, then assert decodeJpeg(REF) matches within tolerance.
it.skip('decodes a real (externally-generated) arithmetic JPEG reference stream', () => {
  // const REF = Uint8Array.from([/* paste bytes */]);
  // const dec = decodeJpeg(REF); // ...compare dec.data to known source pixels
});
```

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run test/jpeg.test.ts test/jpegarith.test.ts test/redact-image.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 6: Update README** — in the redaction Limitations/description paragraph (the "Baseline and progressive JPEG (`DCTDecode`) ..." sentence and the "Arithmetic-coded JPEG, JPEG 2000 ... are not decoded" sentence), move arithmetic out of the unsupported list:

Change "Arithmetic-coded JPEG, JPEG 2000 (`JPXDecode`), and JBIG2 (`JBIG2Decode`) are not decoded" → "JPEG 2000 (`JPXDecode`) and JBIG2 (`JBIG2Decode`) are not decoded", and extend the supported sentence to note arithmetic-coded (SOF9/SOF10) DCT is decoded.

- [ ] **Step 7: Mark spec shipped** — set the spec's `**Status:**` line to `shipped`.

- [ ] **Step 8: Commit**

```bash
git add test/jpeg.test.ts test/redact-image.test.ts README.md docs/superpowers/specs/2026-07-10-jpeg-arithmetic-dct-design.md
git commit -m "feat(ac6.1): arithmetic DCT RGBA + redaction acceptance; docs"
```

- [ ] **Step 9: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-ac6.1 --reason "SOF9/SOF10 arithmetic DCT decoded via QM coder; validated against baseline decode + redaction end-to-end."
```

---

## Self-Review

**Spec coverage:** module split (`jpegarith.ts`) → Tasks 2-5; `forEachBlockInScan` refactor → Task 1; `ArithDecoder`/`ArithStats`/`decodeArithScan` → Tasks 2-5; DAC parse + defaults → Tasks 3, 6; DC/AC sequential → Task 4; progressive 4-way → Task 5; reset semantics → Tasks 4, 6; wiring in `decodeJpeg` → Task 3; test encoder → Tasks 2, 4-6; full test plan (sequential, progressive, restart, DAC, RGBA, redaction, hybrid slot) → Tasks 4-7. All spec sections covered.

**Placeholder scan:** the entropy-coder internals (ARITAB table, `arith_decode` register logic, the four MCU decoders, exact context-bin indices) are intentionally specified as *verbatim ports of cited authoritative sources* (T.81 Annex D/F.1.4/G.2 + libjpeg `jdarith.c`/`jaricom.c`) rather than reconstructed pseudocode, because fabricated numeric tables/indices would be a correctness liability. This is a deliberate fidelity decision, validated by the bit round-trip (Task 2) and the baseline cross-check (Tasks 4-6), not an under-specified "TODO".

**Type consistency:** `decodeArithScan(data, seg, entropy, frame, dcCond, acCond, restartInterval)` — signature identical in Task 3 (stub) and Tasks 4-5 (impl). `ArithDecoder.decode(stats, s)` and `ArithEncoder.encode(stats, s, decision)` consistent across Tasks 2-6. `encodeSequentialArithJpeg`/`encodeProgressiveArithJpeg`/`buildComponentBlocks` names consistent. `dcCond: {L,U}[]` / `acCond: {Kx}[]` consistent Tasks 3-6.
