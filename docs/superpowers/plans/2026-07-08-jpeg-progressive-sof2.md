# Progressive JPEG (SOF2) Decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the baseline JPEG decoder (`src/jpeg.ts`) to decode progressive DCT (SOF2) images so progressive `DCTDecode` images can be partially redacted.

**Architecture:** Progressive JPEGs spread each 8×8 block's coefficients across multiple scans, so the decoder must accumulate *raw* (un-dequantized) coefficients in a persistent per-component store and dequantize+IDCT once after EOI. `decodeScan` gains a dispatcher that reads the scan's `Ss/Se/Ah/Al` header and runs one of four progressive procedures (DC-first, DC-refine, AC-first, AC-refine, the AC pair with EOB-run tracking), over either interleaved (multi-component DC) or non-interleaved (single-component AC) block traversal. The baseline path is refactored to share the same raw-coefficient store and reconstruct.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest. Zero runtime deps (`node:` built-ins only). Test fixtures are built programmatically in `test/helpers/`.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. The JPEG encoder is a **test helper** in `test/helpers/`, never shipped.
- ESM + NodeNext: import specifiers carry the `.js` extension (e.g. `import { X } from './y.js'`).
- Strict TypeScript. Public error types only: `PdfParseError`, `UnsupportedFeatureError` (from `src/errors.ts`).
- TDD: every change lands with a vitest test. Run `npm run typecheck` and `npm test` green before closing.
- Match the terse, single-line-dense style of the existing `src/jpeg.ts` and `test/helpers/build-jpeg.ts`.
- Progressive **successive approximation for negative coefficients** relies on two's-complement arithmetic-shift + bitwise-OR reconstruction, matching libjpeg `jdphuff.c` — do not "simplify" the sign handling.

---

## File Structure

- **Modify `src/jpeg.ts`** — the whole feature. Marker walk accepts SOF2; coefficient store becomes persistent + raw; `decodeScan` becomes a dispatcher with four progressive block procedures; `assemble` dequantizes.
- **Modify `test/helpers/build-jpeg.ts`** — extract a shared `buildComponentBlocks()` and add `encodeProgressiveJpeg()` (spectral-selection + successive-approximation modes).
- **Modify `test/jpeg.test.ts`** — progressive decoder unit tests, cross-validated against baseline; flip the SOF2-throws assertion.
- **Modify `test/helpers/build-jpeg.test.ts`** — a structural test for the progressive encoder.
- **Modify `test/redact-image.test.ts`** — end-to-end progressive partial-redaction test; flip the b3b progressive-throws assertion.
- **Modify `README.md`** — move progressive JPEG from unsupported → supported in redaction limitations.

No changes to `src/raster.ts` are required: it already routes `DCTDecode` through `decodeJpeg` in a `try/catch` ([src/raster.ts:580-582](../../../src/raster.ts#L580-L582)); once SOF2 decodes, redaction "just works".

---

## Task 1: Refactor baseline to raw-coefficient store + dequant-at-reconstruct

**Files:**
- Modify: `src/jpeg.ts` — `decodeScan` block body (~147-159), `decodeJpeg` SOS call (~117), `assemble` (~170-197)
- Test: `test/jpeg.test.ts` (existing baseline tests are the guard — no new test)

**Interfaces:**
- Produces: `assemble(frame: Frame, adobe: number | undefined, qt: (Int32Array | undefined)[]): JpegImage` — now dequantizes. Coefficient store `Comp.blocks` now holds **raw** (un-dequantized) coefficients in natural order.

This is a behavior-preserving refactor; the existing baseline tests in `test/jpeg.test.ts` are the safety net.

- [ ] **Step 1: Run the baseline suite to confirm a green starting point**

Run: `npx vitest run test/jpeg.test.ts`
Expected: PASS (all baseline + the two "throws" tests).

- [ ] **Step 2: Store raw DC/AC coefficients in `decodeScan`'s `block()`**

In `src/jpeg.ts`, the `block` closure currently multiplies by the quant table. Remove the quant multiply and the now-unused `q` lookup so it stores raw coefficients:

```ts
  const block = (si: number, blockRow: number, blockCol: number) => {
    const sc = scan[si], c = sc.c;
    const off = (blockRow * c.bpl + blockCol) * 64;
    const t = decodeHuff(r, sc.dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    c.blocks[off] = pred[si];
    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(r, sc.ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run === 15) { k += 16; continue; } break; } // ZRL or EOB
      k += run; if (k > 63) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size); k++;
    }
  };
```

Also remove the now-unused `qt` parameter from `decodeScan`'s signature and its call. Change the signature line to:

```ts
function decodeScan(
  data: Uint8Array, seg: number, entropy: number, frame: Frame,
  huffDC: (Huff | undefined)[], huffAC: (Huff | undefined)[], restartInterval: number,
): number {
```

- [ ] **Step 3: Update the SOS call site to drop `qt` and pass it to `assemble` instead**

In `decodeJpeg`, change the SOS branch call:

```ts
    } else if (marker === 0xda) {                                // SOS
      if (!frame) throw new PdfParseError('JPEG: SOS before SOF');
      pos = decodeScan(data, seg, segEnd, frame, huffDC, huffAC, restartInterval);
    }
```

And the return:

```ts
  if (!frame) throw new PdfParseError('JPEG: no frame header');
  return assemble(frame, adobe, qt);
```

- [ ] **Step 4: Dequantize in `assemble`**

Change `assemble`'s signature and its per-component plane loop to dequantize each block into a scratch buffer before the IDCT:

```ts
function assemble(frame: Frame, adobeTransform: number | undefined, qt: (Int32Array | undefined)[]): JpegImage {
  const { width, height, comps, maxH, maxV } = frame;
  const planes = comps.map((c) => {
    const q = qt[c.tq]; if (!q) throw new PdfParseError('JPEG: missing quant table');
    const qn = new Int32Array(64); for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k]; // natural-order quant
    const pw = c.bpl * 8, ph = c.bpc * 8; const plane = new Uint8Array(pw * ph);
    const out = new Array(64); const dq = new Int32Array(64);
    for (let br = 0; br < c.bpc; br++) for (let bc = 0; bc < c.bpl; bc++) {
      const off = (br * c.bpl + bc) * 64;
      for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
      idct(dq, 0, out);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) plane[(br * 8 + y) * pw + (bc * 8 + x)] = out[y * 8 + x];
    }
    return { plane, pw, ph, h: c.h, v: c.v };
  });
  // ... rest unchanged (upsample + color transform) ...
```

Leave the remainder of `assemble` (the `nc`/interleave loop and color transforms) unchanged.

- [ ] **Step 5: Run the baseline suite — must still pass**

Run: `npx vitest run test/jpeg.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/jpeg.ts
git commit -m "refactor(3ee): store raw JPEG coefficients, dequantize at reconstruct

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extract one-time geometry setup + persistent block allocation

**Files:**
- Modify: `src/jpeg.ts` — `Comp`/`Frame` interfaces (~69-70), SOF handlers (~105-114), new `setupGeometry`, `decodeScan` (remove per-scan allocation ~139-141; parse `Ss/Se/Ah/Al`)
- Test: `test/jpeg.test.ts` (existing baseline tests are the guard)

**Interfaces:**
- Produces: `Frame` gains `progressive: boolean`, `mcusPerLine: number`, `mcusPerColumn: number`. `Comp` gains `blocksPerLine: number`, `blocksPerColumn: number`. `setupGeometry(frame: Frame): void` allocates each component's `blocks` **once** (persists across scans).

Progressive images have multiple SOS scans that accumulate into the *same* block store, so allocation must happen once after the frame header — not per scan (the current code re-allocates and zeroes on every scan).

- [ ] **Step 1: Extend the `Comp` and `Frame` interfaces**

```ts
interface Comp { id: number; h: number; v: number; tq: number; blocks: Int32Array; bpl: number; bpc: number; blocksPerLine: number; blocksPerColumn: number }
interface Frame { width: number; height: number; comps: Comp[]; maxH: number; maxV: number; progressive: boolean; mcusPerLine: number; mcusPerColumn: number }
```

Update the `comps.push({...})` in the SOF handler to include the new fields with zero defaults:

```ts
        comps.push({ id, h, v, tq, blocks: new Int32Array(0), bpl: 0, bpc: 0, blocksPerLine: 0, blocksPerColumn: 0 });
```

And the `frame = {...}` assignment:

```ts
      frame = { width, height, comps, maxH, maxV, progressive: marker === 0xc2, mcusPerLine: 0, mcusPerColumn: 0 };
      setupGeometry(frame);
```

- [ ] **Step 2: Accept SOF2 and share the SOF0/1 header parse**

Replace the SOF0/SOF1 branch and the SOF2 throw. Merge SOF2 (`0xc2`) into the same header-parsing branch (it differs only in the `progressive` flag, already derived from `marker === 0xc2` above):

```ts
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) { // SOF0/1 baseline/extended, SOF2 progressive
      const precision = data[seg]; if (precision !== 8) throw new UnsupportedFeatureError('JPEG: only 8-bit precision is supported');
      const height = u16(seg + 1), width = u16(seg + 3), nc = data[seg + 5];
      let maxH = 1, maxV = 1; const comps: Comp[] = []; let p = seg + 6;
      for (let i = 0; i < nc; i++) { const id = data[p], h = data[p + 1] >> 4, v = data[p + 1] & 15, tq = data[p + 2]; p += 3; maxH = Math.max(maxH, h); maxV = Math.max(maxV, v); comps.push({ id, h, v, tq, blocks: new Int32Array(0), bpl: 0, bpc: 0, blocksPerLine: 0, blocksPerColumn: 0 }); }
      frame = { width, height, comps, maxH, maxV, progressive: marker === 0xc2, mcusPerLine: 0, mcusPerColumn: 0 };
      setupGeometry(frame);
    } else if ((marker >= 0xc3 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8) {
      throw new UnsupportedFeatureError(`JPEG: unsupported coding process (SOF${marker - 0xc0})`);
```

(The standalone `marker === 0xc2` throw branch is now removed.)

- [ ] **Step 3: Add `setupGeometry` (place it just above `decodeScan`)**

```ts
function setupGeometry(frame: Frame): void {
  frame.mcusPerLine = Math.ceil(frame.width / (frame.maxH * 8));
  frame.mcusPerColumn = Math.ceil(frame.height / (frame.maxV * 8));
  for (const c of frame.comps) {
    c.bpl = frame.mcusPerLine * c.h;
    c.bpc = frame.mcusPerColumn * c.v;
    c.blocksPerLine = Math.ceil(Math.ceil((frame.width * c.h) / frame.maxH) / 8);
    c.blocksPerColumn = Math.ceil(Math.ceil((frame.height * c.v) / frame.maxV) / 8);
    c.blocks = new Int32Array(c.bpl * c.bpc * 64);
  }
}
```

- [ ] **Step 4: Remove per-scan allocation and parse the scan header in `decodeScan`**

Delete the geometry/allocation lines currently at the top of `decodeScan`:

```ts
  // DELETE these lines:
  const mcusPerLine = Math.ceil(frame.width / (frame.maxH * 8));
  const mcusPerColumn = Math.ceil(frame.height / (frame.maxV * 8));
  for (const c of frame.comps) { c.bpl = mcusPerLine * c.h; c.bpc = mcusPerColumn * c.v; c.blocks = new Int32Array(c.bpl * c.bpc * 64); }
```

After the component-selection loop (where `p` points just past the components), read the spectral/approximation bytes:

```ts
  const Ss = data[p], Se = data[p + 1], Ah = data[p + 2] >> 4, Al = data[p + 2] & 15;
```

Then update the MCU traversal to use `frame.mcusPerLine`/`frame.mcusPerColumn` (replacing the deleted locals) and `total`:

```ts
  const total = frame.mcusPerLine * frame.mcusPerColumn;
  // ... existing block() definition unchanged from Task 1 ...
  let mcu = 0;
  for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
    for (let si = 0; si < scan.length; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) block(si, my * c.v + by, mx * c.h + bx); }
    mcu++;
    if (restartInterval && mcu % restartInterval === 0 && mcu < total) { r.restart(); pred.fill(0); }
  }
  return r.pos;
```

(`Ss/Se/Ah/Al` are parsed but unused until Task 3; for baseline they are `0/63/0/0`.)

- [ ] **Step 5: Run the baseline suite — must still pass**

Run: `npx vitest run test/jpeg.test.ts && npm run typecheck`
Expected: PASS. Note: the *"throws UnsupportedFeatureError for progressive (SOF2)"* test now fails to throw `UnsupportedFeatureError` — that is expected and is fixed in Task 3. **Temporarily** skip it so this task is green:

Change `test/jpeg.test.ts` line ~59 from `it('throws UnsupportedFeatureError for progressive (SOF2)', () => {` to `it.skip('throws UnsupportedFeatureError for progressive (SOF2)', () => {`.

Run again: `npx vitest run test/jpeg.test.ts`
Expected: PASS (with 1 skipped).

- [ ] **Step 6: Commit**

```bash
git add src/jpeg.ts test/jpeg.test.ts
git commit -m "refactor(3ee): one-time JPEG geometry setup, accept SOF2 header, parse Ss/Se/Ah/Al

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Progressive decode — spectral selection (DC-first, AC-first, EOB-run)

**Files:**
- Modify: `src/jpeg.ts` — restructure `decodeScan` into a dispatcher with progressive block procedures + interleaved/non-interleaved traversal
- Modify: `test/helpers/build-jpeg.ts` — extract `buildComponentBlocks()`; add `encodeProgressiveJpeg()` (spectral-only)
- Modify: `test/helpers/build-jpeg.test.ts` — structural test for the progressive encoder
- Modify: `test/jpeg.test.ts` — progressive round-trip tests (cross-validated vs baseline); un-skip + convert the SOF2 test

**Interfaces:**
- Consumes: `Frame.progressive`, `Frame.mcusPerLine/mcusPerColumn`, `Comp.blocksPerLine/blocksPerColumn`, parsed `Ss/Se/Ah/Al` (Task 2).
- Produces:
  - `test/helpers/build-jpeg.ts`: `export function encodeProgressiveJpeg(o: JpegEncodeOptions): Uint8Array` — emits SOI, DQT(all-ones), SOF2, DHT, one interleaved DC scan (`Ss=0,Se=0,Ah=Al=0`), then one non-interleaved AC scan per component (`Ss=1,Se=63,Ah=Al=0`), EOI. Spectral-only (no successive approximation) in this task.
  - `buildComponentBlocks(o: JpegEncodeOptions)` (internal): returns `{ cinfo, blocks, mcusPerLine, mcusPerColumn, adobe }` shared by both encoders.

### 3a — Progressive decoder

- [ ] **Step 1: Write failing tests (progressive round-trips vs baseline)**

Add to `test/jpeg.test.ts` (after the baseline `describe`), importing `encodeProgressiveJpeg`:

```ts
import { encodeProgressiveJpeg } from './helpers/build-jpeg.js';

describe('decodeJpeg — progressive (SOF2), spectral selection', () => {
  it('round-trips a grayscale image and matches the baseline decode', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 7) % 256;
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(prog.width).toBe(w); expect(prog.height).toBe(h); expect(prog.comps).toBe(1);
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]); // exact: same coeffs
  });

  it('round-trips an RGB image (interleaved DC scan) and matches baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 11) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px }));
    expect(prog.comps).toBe(3);
    for (let i = 0; i < w * h * 3; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('handles an EOB run across flat blocks (matches baseline)', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h).fill(120); // flat → all-zero AC → one big EOB run
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/jpeg.test.ts -t "progressive"`
Expected: FAIL — `encodeProgressiveJpeg` is not exported yet (import error). (The encoder is added in 3b; if executing strictly test-first, expect the module-resolution failure here, then a decode failure after 3b until the decoder lands.)

- [ ] **Step 3: Restructure `decodeScan` into a dispatcher with progressive procedures**

Replace the body of `decodeScan` (from the `const r = new BitReader(...)` line to the end) with the following. It keeps the baseline `decodeBaseline` procedure, adds `decodeDCFirst`/`decodeACFirst`, defines refine procedures as "not yet supported" stubs (implemented in Task 4), and picks interleaved vs non-interleaved traversal:

```ts
  const r = new BitReader(data, entropy);
  const pred = new Int32Array(scan.length);
  let eobrun = 0;

  // Baseline sequential: full DC+AC block (raw coefficients).
  const decodeBaseline = (si: number, off: number) => {
    const sc = scan[si], c = sc.c;
    const t = decodeHuff(r, sc.dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    c.blocks[off] = pred[si];
    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(r, sc.ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run === 15) { k += 16; continue; } break; }
      k += run; if (k > 63) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size); k++;
    }
  };
  // Progressive DC first scan: coeff[0] = accumulated predictor << Al.
  const decodeDCFirst = (si: number, off: number) => {
    const t = decodeHuff(r, scan[si].dc); const diff = t === 0 ? 0 : extend(r.receive(t), t); pred[si] += diff;
    scan[si].c.blocks[off] = pred[si] << Al;
  };
  // Progressive AC first scan: run/size over band Ss..Se, with EOB-run tracking.
  const decodeACFirst = (si: number, off: number) => {
    const c = scan[si].c;
    if (eobrun > 0) { eobrun--; return; }
    let k = Ss;
    while (k <= Se) {
      const rs = decodeHuff(r, scan[si].ac); const run = rs >> 4, size = rs & 15;
      if (size === 0) { if (run < 15) { eobrun = (1 << run) + (run ? r.receive(run) : 0) - 1; break; } k += 16; continue; }
      k += run; if (k > Se) break;
      c.blocks[off + ZIGZAG[k]] = extend(r.receive(size), size) << Al; k++;
    }
  };
  const notYet = () => { throw new UnsupportedFeatureError('JPEG: progressive successive approximation not yet supported'); };
  const decodeDCRefine = notYet;
  const decodeACRefine = notYet;

  const progressive = frame.progressive;
  let decodeBlock: (si: number, off: number) => void;
  if (!progressive) decodeBlock = decodeBaseline;
  else if (Ss === 0) decodeBlock = Ah === 0 ? decodeDCFirst : decodeDCRefine;
  else decodeBlock = Ah === 0 ? decodeACFirst : decodeACRefine;

  const resetPredictors = () => { pred.fill(0); eobrun = 0; };
  let mcu = 0;
  if (scan.length > 1) { // interleaved: multi-component (DC or baseline) scan
    const total = frame.mcusPerLine * frame.mcusPerColumn;
    for (let my = 0; my < frame.mcusPerColumn; my++) for (let mx = 0; mx < frame.mcusPerLine; mx++) {
      for (let si = 0; si < scan.length; si++) { const c = scan[si].c; for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) decodeBlock(si, ((my * c.v + by) * c.bpl + (mx * c.h + bx)) * 64); }
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) { r.restart(); resetPredictors(); }
    }
  } else { // non-interleaved: single-component scan (all AC scans, single-comp DC/baseline)
    const c = scan[0].c;
    const total = c.blocksPerLine * c.blocksPerColumn;
    for (let by = 0; by < c.blocksPerColumn; by++) for (let bx = 0; bx < c.blocksPerLine; bx++) {
      decodeBlock(0, (by * c.bpl + bx) * 64);
      mcu++;
      if (restartInterval && mcu % restartInterval === 0 && mcu < total) { r.restart(); resetPredictors(); }
    }
  }
  return r.pos;
```

Ensure `UnsupportedFeatureError` is already imported at the top of `src/jpeg.ts` (it is).

- [ ] **Step 4: Run the decoder tests (they will pass once the encoder lands in 3b)**

Proceed to 3b, then run: `npx vitest run test/jpeg.test.ts`
Expected after 3b: PASS for the grayscale, RGB, and EOB-run progressive tests.

### 3b — Progressive encoder (spectral-only) + structural test

- [ ] **Step 5: Extract `buildComponentBlocks` from `encodeBaselineJpeg`**

In `test/helpers/build-jpeg.ts`, factor the plane-building + FDCT block computation (currently inline in `encodeBaselineJpeg`, the `planes`/`cinfo`/`blocks` construction) into a shared exported-internal function. Add near the top (after the helpers):

```ts
interface CompInfo { sp: number[]; cw: number; ch: number; h: number; v: number }
interface CompBlocks { arr: Int32Array[]; bpl: number; bpc: number }

function buildComponentBlocks(o: JpegEncodeOptions): {
  cinfo: CompInfo[]; blocks: CompBlocks[]; mcusPerLine: number; mcusPerColumn: number; adobe: number | undefined;
} {
  const { width, height, pixels } = o;
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
    planes = [{ data: Y, h: s, v: s }, { data: Cb, h: 1, v: 1 }, { data: Cr, h: 1, v: 1 }]; adobe = 1;
  } else {
    const C: number[] = [], M: number[] = [], Yc: number[] = [], K: number[] = [];
    for (let i = 0; i < width * height; i++) { C.push(255 - pixels[i * 4]); M.push(255 - pixels[i * 4 + 1]); Yc.push(255 - pixels[i * 4 + 2]); K.push(255 - pixels[i * 4 + 3]); }
    planes = [{ data: C, h: 1, v: 1 }, { data: M, h: 1, v: 1 }, { data: Yc, h: 1, v: 1 }, { data: K, h: 1, v: 1 }]; adobe = 0;
  }
  const maxH = Math.max(...planes.map((p) => p.h));
  const maxV = Math.max(...planes.map((p) => p.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const cinfo: CompInfo[] = planes.map((p) => {
    const cw = mcusPerLine * p.h * 8, ch = mcusPerColumn * p.v * 8;
    const sp = new Array(cw * ch).fill(0);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const fx = Math.min(width - 1, Math.floor(((x + 0.5) * maxH) / p.h));
      const fy = Math.min(height - 1, Math.floor(((y + 0.5) * maxV) / p.v));
      sp[y * cw + x] = p.data[fy * width + fx];
    }
    return { sp, cw, ch, h: p.h, v: p.v };
  });
  const blocks: CompBlocks[] = cinfo.map((c) => {
    const bpl = mcusPerLine * c.h, bpc = mcusPerColumn * c.v; const arr: Int32Array[] = [];
    for (let br = 0; br < bpc; br++) for (let bc = 0; bc < bpl; bc++) {
      const spatial = new Array(64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) spatial[y * 8 + x] = c.sp[(br * 8 + y) * c.cw + (bc * 8 + x)];
      const zz = new Int32Array(64); fdct(spatial, zz); arr.push(zz);
    }
    return { arr, bpl, bpc };
  });
  return { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe };
}
```

Then refactor `encodeBaselineJpeg` to call `buildComponentBlocks(o)` instead of its inline construction (replace the `planes`/`maxH`/`maxV`/`mcusPerLine`/`mcusPerColumn`/`cinfo`/`blocks` block with `const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);`). Leave the rest of `encodeBaselineJpeg` (symbol collection, entropy, assembly) unchanged.

- [ ] **Step 6: Add `encodeProgressiveJpeg` (spectral-only)**

Append to `test/helpers/build-jpeg.ts`:

```ts
// Non-interleaved block counts for a component (matches the decoder).
function actualBlocks(width: number, height: number, c: CompInfo, maxH: number, maxV: number): { bpl: number; bpc: number } {
  return { bpl: Math.ceil(Math.ceil((width * c.h) / maxH) / 8), bpc: Math.ceil(Math.ceil((height * c.v) / maxV) / 8) };
}

// Encode one component's AC band (Ss..Se) at point transform Al=0, spectral-only,
// coalescing empty-band blocks into EOB runs. Writes into `bw`.
function writeACSpectral(bw: BitWriter, B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, enc: Map<number, { code: number; len: number }>): void {
  let eobrun = 0;
  const flushEob = () => {
    if (eobrun === 0) return;
    let nbits = 0; while ((1 << (nbits + 1)) <= eobrun) nbits++; // floor(log2(eobrun))
    const e = enc.get(nbits << 4)!; bw.put(e.code, e.len);
    if (nbits) bw.put(eobrun & ((1 << nbits) - 1), nbits);
    eobrun = 0;
  };
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx];
    let run = 0; let emitted = false;
    for (let k = 1; k <= 63; k++) {
      const v = zz[k];
      if (v === 0) { run++; continue; }
      flushEob();
      while (run > 15) { const z = enc.get(0xf0)!; bw.put(z.code, z.len); run -= 16; }
      const size = category(v); const e = enc.get((run << 4) | size)!; bw.put(e.code, e.len); bw.put(valueBits(v, size), size);
      run = 0; emitted = true;
    }
    if (run > 0 || !emitted) { eobrun++; if (eobrun === 0x7fff) flushEob(); } // band ended early
  }
  flushEob();
}

function collectACSpectral(B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, syms: Set<number>): void {
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx];
    let run = 0;
    for (let k = 1; k <= 63; k++) {
      const v = zz[k]; if (v === 0) { run++; continue; }
      while (run > 15) { syms.add(0xf0); run -= 16; }
      syms.add((run << 4) | category(v)); run = 0;
    }
  }
  for (let s = 0; s <= 14; s++) syms.add(s << 4); // possible EOBn symbols
}

export function encodeProgressiveJpeg(o: JpegEncodeOptions): Uint8Array {
  const { cinfo, blocks, mcusPerLine, mcusPerColumn, adobe } = buildComponentBlocks(o);
  const nc = cinfo.length;
  const maxH = Math.max(...cinfo.map((c) => c.h)), maxV = Math.max(...cinfo.map((c) => c.v));
  const width = o.width, height = o.height;

  // ---- Symbol collection ----
  const dcSyms = new Set<number>([0]);
  const acSyms = new Set<number>([0x00]);
  { const pred = new Array(nc).fill(0);
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let ci = 0; ci < nc; ci++) { const c = cinfo[ci], B = blocks[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) { const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)]; const diff = zz[0] - pred[ci]; pred[ci] = zz[0]; dcSyms.add(category(diff)); } }
  }
  for (let ci = 0; ci < nc; ci++) { const ab = actualBlocks(width, height, cinfo[ci], maxH, maxV); collectACSpectral(blocks[ci], ab.bpl, ab.bpc, acSyms); }
  const dcH = fixedHuff(dcSyms), acH = fixedHuff(acSyms);

  // ---- DC scan entropy (interleaved) ----
  const dcbw = new BitWriter();
  { const pred = new Array(nc).fill(0);
    for (let my = 0; my < mcusPerColumn; my++) for (let mx = 0; mx < mcusPerLine; mx++)
      for (let ci = 0; ci < nc; ci++) { const c = cinfo[ci], B = blocks[ci];
        for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) { const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)]; const diff = zz[0] - pred[ci]; pred[ci] = zz[0]; const cat = category(diff); const d = dcH.enc.get(cat)!; dcbw.put(d.code, d.len); if (cat) dcbw.put(valueBits(diff, cat), cat); } }
  }
  dcbw.flush();
  // ---- AC scans entropy (one per component, non-interleaved) ----
  const acBytes = cinfo.map((c, ci) => { const bw = new BitWriter(); const ab = actualBlocks(width, height, c, maxH, maxV); writeACSpectral(bw, blocks[ci], ab.bpl, ab.bpc, acH.enc); bw.flush(); return bw.bytes; });

  // ---- Assemble ----
  const out: number[] = [];
  const u16 = (n: number) => { out.push((n >> 8) & 0xff, n & 0xff); };
  out.push(0xff, 0xd8); // SOI
  if (adobe !== undefined) { out.push(0xff, 0xee); u16(14); for (const ch of 'Adobe') out.push(ch.charCodeAt(0)); out.push(0, 0x64, 0, 0, 0, 0, adobe); }
  out.push(0xff, 0xdb); u16(2 + 65); out.push(0x00); for (let i = 0; i < 64; i++) out.push(1); // DQT all ones
  out.push(0xff, 0xc2); u16(8 + nc * 3); out.push(8); u16(height); u16(width); out.push(nc); // SOF2
  for (let i = 0; i < nc; i++) out.push(i + 1, (cinfo[i].h << 4) | cinfo[i].v, 0);
  const writeDHT = (tc: number, th: number, t: { bits: number[]; vals: number[] }) => { out.push(0xff, 0xc4); u16(2 + 1 + 16 + t.vals.length); out.push((tc << 4) | th); for (let i = 0; i < 16; i++) out.push(t.bits[i]); for (const v of t.vals) out.push(v); };
  writeDHT(0, 0, dcH); writeDHT(1, 0, acH);
  // DC scan (all components, Ss=0 Se=0 Ah=Al=0)
  out.push(0xff, 0xda); u16(6 + nc * 2); out.push(nc); for (let i = 0; i < nc; i++) out.push(i + 1, 0x00); out.push(0, 0, 0);
  for (const b of dcbw.bytes) out.push(b);
  // AC scans (per component, Ss=1 Se=63 Ah=Al=0)
  for (let ci = 0; ci < nc; ci++) { out.push(0xff, 0xda); u16(8); out.push(1, ci + 1, 0x00); out.push(1, 63, 0); for (const b of acBytes[ci]) out.push(b); }
  out.push(0xff, 0xd9); // EOI
  return Uint8Array.from(out);
}
```

- [ ] **Step 7: Add a structural test for the encoder**

Add to `test/helpers/build-jpeg.test.ts`:

```ts
import { encodeProgressiveJpeg } from './build-jpeg.js';

it('encodeProgressiveJpeg emits SOF2 and multiple SOS scans', () => {
  const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 3) % 256; px[i * 3 + 1] = (i * 5) % 256; px[i * 3 + 2] = (i * 7) % 256; }
  const b = encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px });
  expect(b[0]).toBe(0xff); expect(b[1]).toBe(0xd8); // SOI
  let sof2 = false, sos = 0, p = 2;
  while (p < b.length - 1) {
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xc2) sof2 = true;
    if (m === 0xda) { sos++; break; } // stop at first scan (entropy follows)
    if (m === 0xd9) break;
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    p += 2 + ((b[p + 2] << 8) | b[p + 3]);
  }
  expect(sof2).toBe(true); expect(sos).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 8: Convert the SOF2 unit test from "throws" to "decodes"**

In `test/jpeg.test.ts`, replace the previously-skipped SOF2 test (~59-63) with a positive check that SOF2 is now accepted (the round-trip tests already cover correctness; this one guards that the marker is handled):

```ts
  it('decodes a progressive (SOF2) stream instead of throwing', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) px[i] = (i * 9) % 256;
    const dec = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px }));
    expect(dec.width).toBe(w); expect(dec.height).toBe(h); expect(dec.comps).toBe(1);
  });
```

Keep the arithmetic-coding (SOF9) and truncated-stream throw tests unchanged.

- [ ] **Step 9: Run all decoder + helper tests**

Run: `npx vitest run test/jpeg.test.ts test/helpers/build-jpeg.test.ts && npm run typecheck`
Expected: PASS (grayscale/RGB/EOB progressive round-trips exact-match baseline; encoder structural test passes; typecheck clean).

- [ ] **Step 10: Commit**

```bash
git add src/jpeg.ts test/helpers/build-jpeg.ts test/helpers/build-jpeg.test.ts test/jpeg.test.ts
git commit -m "feat(3ee): progressive JPEG spectral-selection decode (DC-first, AC-first, EOB-run)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Successive approximation (DC-refine, AC-refine)

**Files:**
- Modify: `src/jpeg.ts` — replace the `decodeDCRefine`/`decodeACRefine` stubs with real implementations
- Modify: `test/helpers/build-jpeg.ts` — add a `successive?: boolean` mode to `encodeProgressiveJpeg`
- Modify: `test/jpeg.test.ts` — successive-approximation round-trip tests (vs baseline)

**Interfaces:**
- Consumes: `JpegEncodeOptions.successive?: boolean` (new). When true, `encodeProgressiveJpeg` emits DC-first(Al=1)+DC-refine(Al=0) and, per component, AC-first(Al=1)+AC-refine(Al=0), refining to bit 0 so decoded coefficients equal the full-precision quantized coefficients.
- Produces: complete four-procedure progressive decoder.

- [ ] **Step 1: Add `successive?: boolean` to `JpegEncodeOptions`**

In `test/helpers/build-jpeg.ts`:

```ts
export interface JpegEncodeOptions {
  width: number; height: number;
  comps: 1 | 3 | 4;
  pixels: Uint8Array;
  subsample?: boolean;
  restartInterval?: number;
  successive?: boolean;
}
```

- [ ] **Step 2: Write failing tests (successive approximation round-trips vs baseline)**

Add to the progressive `describe` in `test/jpeg.test.ts`:

```ts
  it('round-trips grayscale with successive approximation (DC/AC refine) matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 37 + (i % 5) * 13) % 256; // varied coeffs incl. negatives
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true }));
    for (let i = 0; i < w * h; i++) expect(prog.data[i]).toBe(base.data[i]);
  });

  it('round-trips RGB with successive approximation matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = (i * 17) % 256; px[i * 3 + 1] = (i * 31) % 256; px[i * 3 + 2] = (i * 47) % 256; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true }));
    for (let i = 0; i < w * h * 3; i++) expect(prog.data[i]).toBe(base.data[i]);
  });
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run test/jpeg.test.ts -t "successive"`
Expected: FAIL — either the encoder ignores `successive` (still spectral-only, but should still pass?) — to be safe the decoder stubs `notYet` throw once the encoder emits refine scans. After Step 4 (encoder) they throw `UnsupportedFeatureError`; after Step 5 (decoder) they pass.

- [ ] **Step 4: Implement successive-approximation encoding**

Replace `encodeProgressiveJpeg`'s scan-emission section to branch on `o.successive`. Add these helpers to `test/helpers/build-jpeg.ts`:

```ts
// DC scan at a given point transform Al (Ah tells refine vs first). Interleaved.
function writeDCScan(bw: BitWriter, cinfo: CompInfo[], blocks: CompBlocks[], mpl: number, mpc: number, Al: number, refine: boolean, dcEnc: Map<number, { code: number; len: number }>): void {
  const nc = cinfo.length; const pred = new Array(nc).fill(0);
  for (let my = 0; my < mpc; my++) for (let mx = 0; mx < mpl; mx++)
    for (let ci = 0; ci < nc; ci++) { const c = cinfo[ci], B = blocks[ci];
      for (let by = 0; by < c.v; by++) for (let bx = 0; bx < c.h; bx++) {
        const zz = B.arr[(my * c.v + by) * B.bpl + (mx * c.h + bx)];
        if (!refine) { const t = zz[0] >> Al; const diff = t - pred[ci]; pred[ci] = t; const cat = category(diff); const d = dcEnc.get(cat)!; bw.put(d.code, d.len); if (cat) bw.put(valueBits(diff, cat), cat); }
        else { bw.put((zz[0] >> Al) & 1, 1); }
      } }
}

// AC-refine scan for one component band (Ss=1..Se=63) at point transform Al.
function writeACRefine(bw: BitWriter, B: CompBlocks, bpl: number, bpc: number, Al: number, enc: Map<number, { code: number; len: number }>): void {
  let eobrun = 0; const pending: number[] = []; // correction bits deferred until EOB flush
  const flushEob = () => {
    if (eobrun === 0) { for (const b of pending) bw.put(b, 1); pending.length = 0; return; }
    let nbits = 0; while ((1 << (nbits + 1)) <= eobrun) nbits++;
    const e = enc.get(nbits << 4)!; bw.put(e.code, e.len); if (nbits) bw.put(eobrun & ((1 << nbits) - 1), nbits);
    for (const b of pending) bw.put(b, 1); pending.length = 0; eobrun = 0;
  };
  for (let by = 0; by < bpc; by++) for (let bx = 0; bx < bpl; bx++) {
    const zz = B.arr[by * B.bpl + bx];
    // Determine, for this band at level Al: newly-nonzero positions (|zz[k]>>Al|==1 && zz[k]>>(Al+1)==0)
    // and already-nonzero positions (zz[k]>>(Al+1) != 0), whose correction bit is (zz[k]>>Al)&1.
    let run = 0; const blockBits: number[] = []; let lastNewIdx = -1;
    const corr: { k: number; bit: number }[] = [];
    for (let k = 1; k <= 63; k++) {
      const hi = zz[k] >> (Al + 1);
      if (hi !== 0) { corr.push({ k, bit: (zz[k] >> Al) & 1 }); continue; } // already nonzero → correction bit
      const nv = zz[k] >> Al;
      if (nv === 1 || nv === -1) lastNewIdx = k; // newly nonzero at this level
    }
    // Emit run/size for new coeffs, interleaving correction bits of intervening already-nonzero coeffs.
    if (lastNewIdx < 0) { // no new coeffs this block → whole band is EOB; correction bits deferred
      for (const c of corr) pending.push(c.bit);
      eobrun++; if (eobrun === 0x7fff) flushEob();
      continue;
    }
    flushEob();
    run = 0;
    for (let k = 1; k <= lastNewIdx; k++) {
      const hi = zz[k] >> (Al + 1);
      if (hi !== 0) { blockBits.push((zz[k] >> Al) & 1); continue; } // correction bit for existing coeff
      const nv = zz[k] >> Al;
      if (nv === 0) { run++; if (run === 16) { const z = enc.get(0xf0)!; bw.put(z.code, z.len); for (const b of blockBits) bw.put(b, 1); blockBits.length = 0; run = 0; } continue; }
      // new coeff (nv === ±1): emit (run<<4)|1 then sign bit, then the queued correction bits
      const e = enc.get((run << 4) | 1)!; bw.put(e.code, e.len); bw.put(nv > 0 ? 1 : 0, 1);
      for (const b of blockBits) bw.put(b, 1); blockBits.length = 0; run = 0;
    }
    // After the last new coeff, remaining higher-band already-nonzero corrections belong to EOB → defer.
    for (let k = lastNewIdx + 1; k <= 63; k++) { const hi = zz[k] >> (Al + 1); if (hi !== 0) pending.push((zz[k] >> Al) & 1); }
    eobrun++; if (eobrun === 0x7fff) flushEob(); // this block ends its band → contributes to next EOB run
  }
  flushEob();
}
```

Note: `writeACRefine` treats every block as ending its band with an EOB (progressive AC always ends a block with either the last new coefficient's placement or an EOB run). The deferred `pending` correction bits are the correction bits for already-nonzero coefficients that fall *within* an EOB run — they are emitted immediately after the EOBn symbol, matching the decoder's `eobrun` correction loop.

Then rewrite `encodeProgressiveJpeg`'s scan section to branch:

```ts
  const maxHb = maxH, maxVb = maxV; // (already computed)
  // symbol collection unchanged (spectral) — the same DC/AC symbol universe covers refine (refine adds only single bits + EOBn + (run<<4)|1)
  // ...build dcH, acH as before, but ensure acSyms includes (run<<4)|1 for run 0..15:
```

Add, before `fixedHuff`, to guarantee refine symbols exist:

```ts
  if (o.successive) { for (let run2 = 0; run2 <= 15; run2++) acSyms.add((run2 << 4) | 1); }
```

Replace the DC + AC scan emission and assembly's SOS writing with:

```ts
  const dcAl = o.successive ? 1 : 0;
  // DC scans
  const dcScans: { Ss: number; Se: number; Ah: number; Al: number; bytes: number[] }[] = [];
  { const bw = new BitWriter(); writeDCScan(bw, cinfo, blocks, mcusPerLine, mcusPerColumn, dcAl, false, dcH.enc); bw.flush(); dcScans.push({ Ss: 0, Se: 0, Ah: 0, Al: dcAl, bytes: bw.bytes }); }
  if (o.successive) { const bw = new BitWriter(); writeDCScan(bw, cinfo, blocks, mcusPerLine, mcusPerColumn, 0, true, dcH.enc); bw.flush(); dcScans.push({ Ss: 0, Se: 0, Ah: 1, Al: 0, bytes: bw.bytes }); }
  // AC scans per component
  const acScans: { ci: number; Ss: number; Se: number; Ah: number; Al: number; bytes: number[] }[] = [];
  for (let ci = 0; ci < nc; ci++) {
    const ab = actualBlocks(width, height, cinfo[ci], maxHb, maxVb);
    const acAl = o.successive ? 1 : 0;
    const bw = new BitWriter(); writeACFirst(bw, blocks[ci], ab.bpl, ab.bpc, acAl, acH.enc); bw.flush();
    acScans.push({ ci, Ss: 1, Se: 63, Ah: 0, Al: acAl, bytes: bw.bytes });
    if (o.successive) { const bw2 = new BitWriter(); writeACRefine(bw2, blocks[ci], ab.bpl, ab.bpc, 0, acH.enc); bw2.flush(); acScans.push({ ci, Ss: 1, Se: 63, Ah: 1, Al: 0, bytes: bw2.bytes }); }
  }
```

Rename the spectral `writeACSpectral` to `writeACFirst` and generalize it to take an `Al` argument (point-transform the coefficient before category/EOB decisions):

```ts
function writeACFirst(bw: BitWriter, B: CompBlocks, blocksPerLine: number, blocksPerColumn: number, Al: number, enc: Map<number, { code: number; len: number }>): void {
  let eobrun = 0;
  const flushEob = () => { if (eobrun === 0) return; let nbits = 0; while ((1 << (nbits + 1)) <= eobrun) nbits++; const e = enc.get(nbits << 4)!; bw.put(e.code, e.len); if (nbits) bw.put(eobrun & ((1 << nbits) - 1), nbits); eobrun = 0; };
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    const zz = B.arr[by * B.bpl + bx];
    let run = 0; let emitted = false;
    for (let k = 1; k <= 63; k++) {
      const v = zz[k] >> Al;
      if (v === 0) { run++; continue; }
      flushEob();
      while (run > 15) { const z = enc.get(0xf0)!; bw.put(z.code, z.len); run -= 16; }
      const size = category(v); const e = enc.get((run << 4) | size)!; bw.put(e.code, e.len); bw.put(valueBits(v, size), size);
      run = 0; emitted = true;
    }
    if (run > 0 || !emitted) { eobrun++; if (eobrun === 0x7fff) flushEob(); }
  }
  flushEob();
}
```

Update `collectACSpectral` similarly to point-transform (accept `Al`, use `zz[k] >> Al`), and call the collectors with `Al = o.successive ? 1 : 0` for the first scan (the refine scan adds only single bits + `(run<<4)|1` + EOBn, already in the symbol set). For simplicity, collect over both Al=0 and (if successive) Al=1 passes to be safe.

Finally, emit the scans in the assembly section (replacing the single DC-scan + AC-scan writes):

```ts
  const sos = (comps: number[], Ss: number, Se: number, Ah: number, Al: number, bytes: number[]) => {
    out.push(0xff, 0xda); u16(6 + comps.length * 2); out.push(comps.length); for (const id of comps) out.push(id, 0x00); out.push(Ss, Se, (Ah << 4) | Al); for (const b of bytes) out.push(b);
  };
  for (const s of dcScans) sos(cinfo.map((_, i) => i + 1), s.Ss, s.Se, s.Ah, s.Al, s.bytes);
  for (const s of acScans) sos([s.ci + 1], s.Ss, s.Se, s.Ah, s.Al, s.bytes);
  out.push(0xff, 0xd9);
```

- [ ] **Step 5: Replace the decoder refine stubs with real implementations**

In `src/jpeg.ts` `decodeScan`, replace the `notYet` stubs:

```ts
  // Progressive DC refinement: append one lower-order bit to the DC coefficient.
  const decodeDCRefine = (si: number, off: number) => {
    if (r.readBit()) scan[si].c.blocks[off] |= (1 << Al);
  };
  // Progressive AC refinement: correction bits for existing coeffs + new ±(1<<Al) coeffs, with EOB-run.
  const decodeACRefine = (si: number, off: number) => {
    const c = scan[si].c; const bit = 1 << Al; let k = Ss;
    if (eobrun > 0) { // inside an EOB run: only correction bits for already-nonzero coeffs
      for (; k <= Se; k++) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0 && r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; }
      eobrun--; return;
    }
    while (k <= Se) {
      const rs = decodeHuff(r, scan[si].ac); let run = rs >> 4; const size = rs & 15; let value = 0;
      if (size === 0) {
        if (run < 15) { eobrun = (1 << run) + (run ? r.receive(run) : 0) - 1; for (; k <= Se; k++) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0 && r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; } return; }
        // run === 15 → skip 16 zero-history coefficients (ZRL)
      } else { value = r.readBit() ? bit : -bit; }
      while (k <= Se) { const z = ZIGZAG[k], v = c.blocks[off + z]; if (v !== 0) { if (r.readBit()) c.blocks[off + z] += v > 0 ? bit : -bit; } else { if (run === 0) break; run--; } k++; }
      if (value !== 0 && k <= Se) c.blocks[off + ZIGZAG[k]] = value;
      k++;
    }
  };
```

- [ ] **Step 6: Run the successive-approximation tests**

Run: `npx vitest run test/jpeg.test.ts && npm run typecheck`
Expected: PASS — all progressive tests (spectral + successive) exact-match baseline; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/jpeg.ts test/helpers/build-jpeg.ts test/jpeg.test.ts
git commit -m "feat(3ee): progressive JPEG successive approximation (DC-refine, AC-refine)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Subsampling + restart interval coverage

**Files:**
- Modify: `test/jpeg.test.ts` — subsampled + restart-interval progressive tests
- Modify: `test/helpers/build-jpeg.ts` — splice RSTn markers into progressive scans when `restartInterval` is set
- Modify: `src/jpeg.ts` — only if a bug surfaces (restart in non-interleaved traversal already handled in Task 3)

**Interfaces:**
- Consumes: `JpegEncodeOptions.subsample`, `JpegEncodeOptions.restartInterval` in `encodeProgressiveJpeg`.

- [ ] **Step 1: Write failing tests (subsampling + restart)**

Add to the progressive `describe`:

```ts
  it('round-trips a subsampled (4:2:0) flat RGB image matching baseline', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 80; px[i * 3 + 2] = 40; }
    const base = decodeJpeg(encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true }));
    const prog = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, subsample: true, successive: true }));
    expect(prog.width).toBe(w); expect(prog.height).toBe(h);
    for (let i = 0; i < w * h * 3; i++) expect(Math.abs(prog.data[i] - base.data[i])).toBeLessThanOrEqual(1);
  });

  it('decodes a progressive stream with a restart interval identically', () => {
    const w = 24, h = 24; const px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = (i * 13) % 256;
    const plain = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true }));
    const rst = decodeJpeg(encodeProgressiveJpeg({ width: w, height: h, comps: 1, pixels: px, successive: true, restartInterval: 3 }));
    for (let i = 0; i < w * h; i++) expect(rst.data[i]).toBe(plain.data[i]);
  });
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/jpeg.test.ts -t "subsampled|restart interval identically"`
Expected: FAIL — subsampling likely already passes (encoder/decoder both handle it); the restart-interval test FAILS because `encodeProgressiveJpeg` ignores `restartInterval` (emits no RSTn), so decoder and encoder disagree on predictor/eobrun reset.

- [ ] **Step 3: Emit RSTn markers per scan when `restartInterval` is set**

In `test/helpers/build-jpeg.ts`, make each scan writer restart-aware. The simplest robust approach: give each scan's entropy-writer a restart callback that flushes the `BitWriter`, records the byte offset, and resets predictor/eobrun state; then splice `FF Dn` markers at those offsets (mirroring `encodeBaselineJpeg`'s existing RSTn splice).

Add a shared restart splicer:

```ts
function spliceRst(bytes: number[], marks: { at: number; marker: number }[]): number[] {
  if (marks.length === 0) return bytes;
  const out: number[] = []; let prev = 0;
  for (const m of marks) { for (let i = prev; i < m.at; i++) out.push(bytes[i]); out.push(0xff, m.marker); prev = m.at; }
  for (let i = prev; i < bytes.length; i++) out.push(bytes[i]);
  return out;
}
```

Thread `restartInterval` (call it `ri`) into `writeDCScan`, `writeACFirst`, and `writeACRefine`: increment an MCU/block counter after each MCU (DC interleaved) or block (AC non-interleaved); when `ri && count % ri === 0 && not-last`, call `bw.flush()`, push a mark `{ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }`, and reset predictors/eobrun (**including flushing any pending EOB run before the marker**). Return the marks alongside the bytes and run them through `spliceRst` before assembly. Set the `DRI` segment (`0xff 0xdd`, len 4, `ri`) in the header when `ri` is set, exactly as `encodeBaselineJpeg` does.

Concretely, change each writer to accept `ri: number` and return `{ bytes, marks }`, e.g. for `writeACFirst`:

```ts
function writeACFirst(B, blocksPerLine, blocksPerColumn, Al, enc, ri): { bytes: number[]; marks: { at: number; marker: number }[] } {
  const bw = new BitWriter(); const marks: { at: number; marker: number }[] = []; let eobrun = 0; let count = 0, rstIdx = 0;
  const total = blocksPerLine * blocksPerColumn;
  const flushEob = () => { /* as before, using bw */ };
  for (let by = 0; by < blocksPerColumn; by++) for (let bx = 0; bx < blocksPerLine; bx++) {
    /* ...emit block as before... */
    count++;
    if (ri && count % ri === 0 && count < total) { flushEob(); bw.flush(); marks.push({ at: bw.bytes.length, marker: 0xd0 + (rstIdx++ & 7) }); eobrun = 0; }
  }
  flushEob(); bw.flush();
  return { bytes: bw.bytes, marks };
}
```

Apply the same pattern to `writeACRefine` (reset `eobrun` **and** clear/flush the `pending` correction-bit queue at each restart — a restart boundary ends any EOB run) and `writeDCScan` (reset `pred` to zero and count per MCU). In `encodeProgressiveJpeg`, replace `bw.flush(); …bytes` usages with the returned `{ bytes, marks }`, run `spliceRst(bytes, marks)`, and add the `DRI` segment to the header when `o.restartInterval` is set:

```ts
  const ri = o.restartInterval ?? 0;
  // ...after writeDHT(...):
  if (ri) { out.push(0xff, 0xdd); u16(4); u16(ri); }
```

- [ ] **Step 4: Run the subsampling + restart tests**

Run: `npx vitest run test/jpeg.test.ts && npm run typecheck`
Expected: PASS. If the restart test still diverges, the fault is a predictor/eobrun reset mismatch between `spliceRst` offsets and the decoder's `r.restart()` — verify the encoder flushes the `BitWriter` (byte-aligned, `FF` byte-stuffed) *before* recording each mark, exactly like `encodeBaselineJpeg`.

- [ ] **Step 5: Commit**

```bash
git add src/jpeg.ts test/helpers/build-jpeg.ts test/jpeg.test.ts
git commit -m "test(3ee): progressive JPEG subsampling + restart-interval coverage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: End-to-end progressive partial redaction

**Files:**
- Modify: `test/redact-image.test.ts` — add a progressive partial-redaction success test; flip the b3b progressive-throws assertion
- Test uses existing helpers: `buildSingleImagePdfWithCm`, `redactPage`, `encodeProgressiveJpeg`

**Interfaces:**
- Consumes: `encodeProgressiveJpeg` (Task 3/4), `raster.ts` DCT path (already present).

- [ ] **Step 1: Check the current b3b progressive-coverage assertion**

Read `test/redact-image.test.ts`. The b3b spec noted a "progressive-JPEG under partial coverage throws `UnsupportedFeatureError`" assertion. Locate it (search `progressive`). If present, it must flip to success; if the only DCT throw-test is the *truncated* stream (line ~131), leave that one as-is (a truncated stream still fails to decode → still throws) and just add the new success test.

Run: `grep -n -i progressive test/redact-image.test.ts`
Expected: identify any progressive-specific assertion to flip.

- [ ] **Step 2: Write the failing end-to-end test**

Add to `test/redact-image.test.ts` (mirroring the baseline test at ~139), importing `encodeProgressiveJpeg` from `./helpers/build-jpeg.js`:

```ts
  it('blacks only the covered columns of a progressive JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; } // flat colour
    const jpg = encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered (right) → preserved
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });
```

If Step 1 found a progressive-throws assertion, delete/convert it now.

- [ ] **Step 3: Run**

Run: `npx vitest run test/redact-image.test.ts && npm run typecheck`
Expected: PASS — the progressive image is decoded, left columns blacked, right preserved.

- [ ] **Step 4: Commit**

```bash
git add test/redact-image.test.ts
git commit -m "test(3ee): end-to-end progressive JPEG partial redaction

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Documentation, real-stream slot, full suite, close

**Files:**
- Modify: `src/jpeg.ts` header comment (line 1-2), `README.md`
- Modify: `test/jpeg.test.ts` — documented real-stream fixture slot

**Interfaces:** none.

- [ ] **Step 1: Update the `src/jpeg.ts` header comment**

Change lines 1-2 to reflect progressive support:

```ts
// Baseline (SOF0/SOF1) and progressive (SOF2) DCT JPEG decoder. Zero deps beyond
// ./errors.js. Arithmetic, lossless, and 12-bit coding are unsupported.
```

- [ ] **Step 2: Update README redaction limitations**

In `README.md`, find the redaction/JPEG limitation note (search "progressive" / "DCTDecode" / "baseline"). Change the exclusion so **baseline and progressive** `DCTDecode` are supported; keep the remaining DCT limitations (arithmetic/lossless/12-bit JPEG and DCT-encoded soft masks degrade gracefully — follow-ups `ac6`/`1hw`/`hu8`; JPX/JBIG2 still undecodable). Example edit:

> Partial redaction decodes and re-encodes baseline **and progressive** JPEG (`DCTDecode`) images. Arithmetic-coded, lossless, and 12-bit JPEGs, and DCT-encoded soft masks, are not decoded and degrade to the pre-existing whole-image behavior; `JPXDecode`/`JBIG2Decode` remain undecodable.

Verify the exact surrounding wording and match the existing README style.

- [ ] **Step 3: Add a documented real-stream fixture slot (Hybrid)**

Add to `test/jpeg.test.ts`, at the end of the progressive `describe`, a skipped placeholder with a provenance recipe so a real reference stream can be committed later:

```ts
  // Hybrid fixture slot: drop a real progressive JPEG here when a real encoder is
  // available, to guard against an encoder/decoder shared bug. Provenance recipe:
  //   convert (ImageMagick):  magick input.png -interlace JPEG -sampling-factor 4:4:4 ref.jpg
  //   libjpeg:                cjpeg -progressive -sample 1x1 -outfile ref.jpg input.pgm
  // Commit the bytes as a Uint8Array constant + the known source pixels, then assert
  // decodeJpeg(ref) matches the source within DCT tolerance.
  it.skip('decodes a real (externally-generated) progressive JPEG reference stream', () => {
    // const REF = Uint8Array.from([/* paste bytes */]);
    // const dec = decodeJpeg(REF);
    // expect(dec.width).toBe(/* known */); ...
  });
```

- [ ] **Step 4: Run the full suite + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS across the whole suite; clean typecheck; `dist/` builds.

- [ ] **Step 5: Commit**

```bash
git add src/jpeg.ts README.md test/jpeg.test.ts
git commit -m "docs(3ee): progressive JPEG supported in redaction; real-stream fixture slot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-3ee
git pull --rebase
git push -u origin feat/jpeg-progressive-sof2-3ee
git status   # MUST show up to date with origin
```

(Open a PR / merge per the project's finishing-a-development-branch flow.)

---

## Self-Review

**Spec coverage:**
- SOF2 accepted, `progressive` flag → Task 2. ✅
- Persistent raw-coefficient store + `blocksPerLine/Column` → Task 2. ✅
- Dequant-at-reconstruct → Task 1. ✅
- DC-first / DC-refine / AC-first / AC-refine + EOB-run → Tasks 3 (first) + 4 (refine). ✅
- Interleaved vs non-interleaved traversal + restart/eobrun reset → Task 3 (traversal) + Task 5 (restart). ✅
- Self-contained progressive encoder (spectral + successive, subsample, restart) → Tasks 3/4/5. ✅
- Cross-validation vs baseline → Tasks 3/4/5 (exact-match assertions). ✅
- End-to-end redaction + flip b3b assertion → Task 6. ✅
- Flip jpeg.test SOF2-throws assertion → Task 3 Step 8. ✅
- Real-stream slot + provenance recipe → Task 7. ✅
- README update → Task 7. ✅
- Non-goals (arithmetic/12-bit/DCT-SMask still throw) → unchanged; filed as `ac6`/`1hw`/`hu8`. ✅

**Type consistency:** `decodeScan` signature drops `qt` (Task 1) consistently at definition + call site; `assemble` gains `qt` at definition + call. `Comp`/`Frame` new fields defined in Task 2 and consumed in Task 3. `JpegEncodeOptions.successive` defined in Task 4 before use. `buildComponentBlocks` return shape consumed identically in both encoders. `writeACFirst`/`writeACRefine`/`writeDCScan`/`spliceRst` signatures consistent across Tasks 3-5.

**Placeholder scan:** No TBD/TODO in shipped code. The only `it.skip` is the intentional, documented Hybrid real-stream slot (Task 7). Task 2's temporary `it.skip` on the SOF2 test is explicitly converted to a real test in Task 3 Step 8.

**Risk note for the executor:** The `writeACRefine` encoder (Task 4 Step 4) is the most intricate piece. If a successive-approximation round-trip diverges from baseline, the fault is almost certainly encoder/decoder disagreement on (a) which coefficients count as "already nonzero" (`zz[k] >> (Al+1) != 0`) vs "newly nonzero" (`|zz[k] >> Al| == 1`), or (b) the ordering of correction bits relative to the EOBn symbol. Cross-check the decoder's `decodeACRefine` correction loop against the encoder's `pending` queue: correction bits for coefficients inside an EOB run are emitted immediately **after** the EOBn symbol and its extra bits, in ascending `k` order.
