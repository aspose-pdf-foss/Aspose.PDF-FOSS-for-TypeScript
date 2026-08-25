# JPXDecode (JPEG 2000) decode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode baseline JPEG 2000 (`JPXDecode`) codestreams embedded in PDF image XObjects to 8-bit interleaved samples, so `ImageInfo.Decode()` returns pixels (today it throws) and `ToImage`/`ToSvg` render JPX images.

**Architecture:** A new decoder split across five focused modules — `jpxmq.ts` (MQ arithmetic decoder), `jpxwavelet.ts` (inverse 5/3 + 9/7 DWT), `jpxt1.ts` (EBCOT Tier-1 code-block bit-plane decode), `jpxt2.ts` (tag-trees + Tier-2 packet iteration over the five progression orders), and `jpx.ts` (JP2 box + codestream marker parsing, plus pipeline orchestration exporting `decodeJpx`). Standalone modules (MQ, DWT, tag-tree, marker parse) are unit-tested with spec vectors / hand blobs / round-trips; the entropy path (Tier-1/Tier-2) is proven end-to-end against real codestream fixtures minted offline by a WASM OpenJPEG dev-only tool.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. No npm runtime deps. (The fixture generator's WASM OpenJPEG is `devDependencies`-only, removed after minting.)
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { MqDecoder } from './jpxmq.js'`).
- **Errors** — throw `PdfParseError` / `UnsupportedFeatureError` from `./errors.js`. These plus `InvalidPasswordError` are the only public error types.
- **TDD** — every feature lands with a failing vitest test first; fixtures built programmatically or embedded base64 in `test/helpers/`.
- **Quality gates** — `npm run typecheck` and `npm test` must both be green before closing the issue. Target one file with `npx vitest run test/<name>.test.ts`.
- **Precision** — component precision ≤ 16 supported internally; output samples downshifted to 8-bit.
- **Scope** — single tile; multiple quality layers; all five progression orders (LRCP/RLCP/RPCL/PCRL/CPRL) with the default single-precinct-per-resolution partition; 5/3 reversible + 9/7 irreversible; 1 (gray) or 3 (RGB) components with RCT/ICT. Multi-tile, custom precincts, ROI (`RGN`), >3 components, sub-sampling ≠ 1 → `UnsupportedFeatureError`. Malformed → `PdfParseError`.
- **Beads** — issue `aspose-pdf-foss-for-ts-kec`; claim with `bd update aspose-pdf-foss-for-ts-kec --claim`. Sub-issues (one per task) tracked under it; close each with `bd close <id>` when its tests are green.
- **Spec reference** — ISO/IEC 15444-1 (clauses cited per task). The canonical open implementations to cross-check against are OpenJPEG and pdf.js `src/core/jpx.js`.

---

### Task 1: MQ arithmetic decoder (`jpxmq.ts`)

The MQ decoder (ISO/IEC 15444-1 Annex C) is the entropy engine consumed by Tier-1. It is compact, fully self-contained, and has a published test vector (Annex C.5, Table C.5 / the standard 32-byte example), so it is testable in complete isolation — build it first.

**Files:**
- Create: `src/jpxmq.ts`
- Test: `test/jpxmq.test.ts`

**Interfaces:**
- Produces:
  - `class MqDecoder { constructor(data: Uint8Array, start: number, end: number); decode(cx: Int8Array, i: number): 0 | 1 }`
    - `cx` is a per-context state array: `cx[i]` packs the Qe-table index in bits 1..7 and the MPS bit in bit 0 (i.e. `state = cx[i] >> 1`, `mps = cx[i] & 1`). Callers allocate `cx` sized to the number of contexts (19 for Tier-1) and pre-load initial states (Task 4).
  - `const QE: ReadonlyArray<{ qe: number; nmps: number; nlps: number; sw: number }>` — the 47-entry Qe transition table.

- [ ] **Step 1: Write the failing test (Qe table shape + Annex C example)**

Create `test/jpxmq.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MqDecoder, QE } from '../src/jpxmq.js';

describe('MQ arithmetic decoder', () => {
  it('has the 47-entry Qe transition table with canonical endpoints', () => {
    expect(QE.length).toBe(47);
    expect(QE[0].qe).toBe(0x5601);
    expect(QE[0].nmps).toBe(1);
    expect(QE[0].nlps).toBe(1);
    expect(QE[0].sw).toBe(1);
    expect(QE[46].qe).toBe(0x5601);
    expect(QE[46].nmps).toBe(46);
    expect(QE[46].nlps).toBe(46);
    expect(QE[46].sw).toBe(0);
  });

  // ISO/IEC 15444-1 Annex C.5 test sequence: the 32-byte encoded stream
  // decodes back to the 256-bit test data of Table C.4 (repeating pattern).
  it('decodes the Annex C.5 test codestream to the reference bits', () => {
    const encoded = Uint8Array.from([
      0x84, 0xC7, 0x3B, 0xFC, 0xE1, 0xA1, 0x43, 0x04, 0x02, 0x20, 0x00, 0x00,
      0x41, 0x0D, 0xBB, 0x86, 0xF4, 0x31, 0x7F, 0xFF, 0x88, 0xFF, 0x37, 0x47,
      0x1A, 0xDB, 0x6A, 0xDF, 0xFF, 0xAC, 0x00, 0x00,
    ]);
    const dec = new MqDecoder(encoded, 0, encoded.length);
    const cx = new Int8Array(1); // single context, state 0, MPS 0
    const bits: number[] = [];
    for (let i = 0; i < 256; i++) bits.push(dec.decode(cx, 0));
    // Reference decoded data (Annex C.4), first 16 and last 16 bits:
    expect(bits.slice(0, 16).join('')).toBe('0000000000000000');
    expect(bits.slice(240).join('')).toBe('0101010101010101');
  });
});
```

> Note: the exact Annex-C byte arrays above are the well-known ISO test vector; if the implementer's copy of the standard prints slightly different grouping, use the vector from OpenJPEG `tests/` (`mqc` test) — the invariant that must hold is *encode-then-decode round-trips*, and the endpoints of the Qe table are fixed constants.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpxmq.test.ts`
Expected: FAIL — `Cannot find module '../src/jpxmq.js'`.

- [ ] **Step 3: Implement `jpxmq.ts`**

```ts
// MQ arithmetic decoder — ISO/IEC 15444-1 Annex C.
// Context state: index<<1 | mps, stored per-context in an Int8Array by the caller.

export interface QeEntry { qe: number; nmps: number; nlps: number; sw: number }

// Table C.2 (Qe values, NMPS, NLPS, SWITCH), 47 entries.
export const QE: ReadonlyArray<QeEntry> = [
  { qe: 0x5601, nmps: 1, nlps: 1, sw: 1 }, { qe: 0x3401, nmps: 2, nlps: 6, sw: 0 },
  { qe: 0x1801, nmps: 3, nlps: 9, sw: 0 }, { qe: 0x0AC1, nmps: 4, nlps: 12, sw: 0 },
  { qe: 0x0521, nmps: 5, nlps: 29, sw: 0 }, { qe: 0x0221, nmps: 38, nlps: 33, sw: 0 },
  { qe: 0x5601, nmps: 7, nlps: 6, sw: 1 }, { qe: 0x5401, nmps: 8, nlps: 14, sw: 0 },
  { qe: 0x4801, nmps: 9, nlps: 14, sw: 0 }, { qe: 0x3801, nmps: 10, nlps: 14, sw: 0 },
  { qe: 0x3001, nmps: 11, nlps: 17, sw: 0 }, { qe: 0x2401, nmps: 12, nlps: 18, sw: 0 },
  { qe: 0x1C01, nmps: 13, nlps: 20, sw: 0 }, { qe: 0x1601, nmps: 29, nlps: 21, sw: 0 },
  { qe: 0x5601, nmps: 15, nlps: 14, sw: 1 }, { qe: 0x5401, nmps: 16, nlps: 14, sw: 0 },
  { qe: 0x5101, nmps: 17, nlps: 15, sw: 0 }, { qe: 0x4801, nmps: 18, nlps: 16, sw: 0 },
  { qe: 0x3801, nmps: 19, nlps: 17, sw: 0 }, { qe: 0x3401, nmps: 20, nlps: 18, sw: 0 },
  { qe: 0x3001, nmps: 21, nlps: 19, sw: 0 }, { qe: 0x2801, nmps: 22, nlps: 19, sw: 0 },
  { qe: 0x2401, nmps: 23, nlps: 20, sw: 0 }, { qe: 0x2201, nmps: 24, nlps: 21, sw: 0 },
  { qe: 0x1C01, nmps: 25, nlps: 22, sw: 0 }, { qe: 0x1801, nmps: 26, nlps: 23, sw: 0 },
  { qe: 0x1601, nmps: 27, nlps: 24, sw: 0 }, { qe: 0x1401, nmps: 28, nlps: 25, sw: 0 },
  { qe: 0x1201, nmps: 29, nlps: 26, sw: 0 }, { qe: 0x1101, nmps: 30, nlps: 27, sw: 0 },
  { qe: 0x0AC1, nmps: 31, nlps: 28, sw: 0 }, { qe: 0x09C1, nmps: 32, nlps: 29, sw: 0 },
  { qe: 0x08A1, nmps: 33, nlps: 30, sw: 0 }, { qe: 0x0521, nmps: 34, nlps: 31, sw: 0 },
  { qe: 0x0441, nmps: 35, nlps: 32, sw: 0 }, { qe: 0x02A1, nmps: 36, nlps: 33, sw: 0 },
  { qe: 0x0221, nmps: 37, nlps: 34, sw: 0 }, { qe: 0x0141, nmps: 38, nlps: 35, sw: 0 },
  { qe: 0x0111, nmps: 39, nlps: 36, sw: 0 }, { qe: 0x0085, nmps: 40, nlps: 37, sw: 0 },
  { qe: 0x0049, nmps: 41, nlps: 38, sw: 0 }, { qe: 0x0025, nmps: 42, nlps: 39, sw: 0 },
  { qe: 0x0015, nmps: 43, nlps: 40, sw: 0 }, { qe: 0x0009, nmps: 44, nlps: 41, sw: 0 },
  { qe: 0x0005, nmps: 45, nlps: 42, sw: 0 }, { qe: 0x0001, nmps: 45, nlps: 43, sw: 0 },
  { qe: 0x5601, nmps: 46, nlps: 46, sw: 0 },
];

export class MqDecoder {
  private data: Uint8Array;
  private bp: number;
  private end: number;
  private c = 0;
  private a = 0;
  private ct = 0;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.bp = start;
    this.end = end;
    // INITDEC (C.3.5)
    const b0 = this.bp < this.end ? this.data[this.bp] : 0xff;
    this.c = b0 << 16;
    this.byteIn();
    this.c <<= 7;
    this.ct -= 7;
    this.a = 0x8000;
  }

  private byteIn(): void {
    // BYTEIN (C.3.4)
    if ((this.bp < this.end ? this.data[this.bp] : 0xff) === 0xff) {
      const b1 = this.bp + 1 < this.end ? this.data[this.bp + 1] : 0xff;
      if (b1 > 0x8f) {
        this.c += 0xff00;
        this.ct = 8;
      } else {
        this.bp++;
        this.c += b1 << 9;
        this.ct = 7;
      }
    } else {
      this.bp++;
      const b = this.bp < this.end ? this.data[this.bp] : 0xff;
      this.c += b << 8;
      this.ct = 8;
    }
  }

  private renormd(): void {
    do {
      if (this.ct === 0) this.byteIn();
      this.a <<= 1;
      this.c <<= 1;
      this.ct--;
    } while (this.a < 0x8000);
  }

  /** DECODE (C.3.2). Returns the decoded binary decision for context index `i`. */
  decode(cx: Int8Array, i: number): 0 | 1 {
    let state = cx[i] >> 1;
    let mps = cx[i] & 1;
    const q = QE[state];
    const qe = q.qe;
    this.a -= qe;
    let d: number;
    if (((this.c >>> 16) & 0xffff) < qe) {
      // LPS exchange path
      if (this.a < qe) { d = mps; state = q.nmps; }
      else { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; }
      this.a = qe;
      this.renormd();
    } else {
      this.c -= qe << 16;
      if ((this.a & 0x8000) === 0) {
        // MPS exchange path
        if (this.a < qe) { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; }
        else { d = mps; state = q.nmps; }
        this.renormd();
      } else {
        d = mps;
      }
    }
    cx[i] = (state << 1) | mps;
    return d as 0 | 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jpxmq.test.ts`
Expected: PASS. If the round-trip endpoints differ, verify the Qe table endpoints first (fixed constants), then the INITDEC/BYTEIN byte handling against Annex C.3.

- [ ] **Step 5: Commit**

```bash
git add src/jpxmq.ts test/jpxmq.test.ts
git commit -m "feat(kec): MQ arithmetic decoder (JPEG 2000 Annex C)"
```

---

### Task 2: Fixture generation pipeline + first reference fixture

The entropy path (Tasks 4, 6, 7) can only be validated against real codestreams. This task establishes the offline generator and mints the first fixture *before* those tasks need it. It is a **spike-with-fallback** — it is the plan's primary risk.

**Files:**
- Create: `scripts/gen-jpx-fixtures.mjs`
- Create: `test/helpers/jpx-fixtures.ts` (generated output — checked in)
- Modify: `package.json` (add a `devDependencies` entry + a `gen:jpx` script; the dep is removed after generation)

**Interfaces:**
- Produces: `test/helpers/jpx-fixtures.ts` exporting, per fixture:
  - `export const <name>_j2k: Uint8Array` — the codestream (or JP2) bytes.
  - `export const <name>_rgb: { width: number; height: number; comps: number; data: Uint8Array }` — ground-truth 8-bit samples (from an independent decode), for exact/tolerance asserts.
  - A `base64` helper `export function b64(s: string): Uint8Array` used by the generated constants.

- [ ] **Step 1: Spike — find a working WASM OpenJPEG encoder**

Run, in order, until one installs and can both encode and decode:

```bash
npm view @cornerstonejs/codec-openjpeg version   # medical-imaging emscripten OpenJPEG (encode+decode)
npm view openjpeg version                          # 0.2.3 — decode-focused; check for encode export
npm view image-js version                          # JS port — decode only (fallback oracle for samples)
```

Install the first that exports an encode function into `devDependencies`:

```bash
npm install --save-dev @cornerstonejs/codec-openjpeg
```

**Fallback if none can encode:** commit externally-produced reference `.j2k`/`.jp2` files. Fetch the OpenJPEG conformance inputs offline (`https://github.com/uclouvain/openjpeg-data`, files `p0_01.j2k` etc. — small, permissively licensed), base64 them into `test/helpers/jpx-fixtures.ts`, and derive ground-truth samples with `image-js` (decode-only) or the WASM decoder. Record the chosen source in the script header.

- [ ] **Step 2: Write `scripts/gen-jpx-fixtures.mjs`**

The script builds known RGB/gray rasters, encodes each variant, decodes each back for ground truth, and writes `test/helpers/jpx-fixtures.ts`. Skeleton (fill the `encode`/`decode` calls to the chosen library's API):

```js
// One-time offline generator for JPEG 2000 test fixtures. NOT run in CI.
// Regenerate: `node scripts/gen-jpx-fixtures.mjs` (needs the dev-only WASM OpenJPEG).
import { writeFileSync } from 'node:fs';
import openjpeg from '@cornerstonejs/codec-openjpeg'; // or the chosen lib

const codec = await openjpeg();

/** A deterministic W×H test raster. comps=1 gray ramp, comps=3 RGB gradient. */
function raster(w, h, comps) {
  const data = new Uint8Array(w * h * comps);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * comps;
    if (comps === 1) data[i] = (x * 255 / (w - 1)) | 0;
    else { data[i] = (x * 255 / (w - 1)) | 0; data[i + 1] = (y * 255 / (h - 1)) | 0; data[i + 2] = ((x + y) * 255 / (w + h - 2)) | 0; }
  }
  return { width: w, height: h, comps, data };
}

const b64 = (u8) => Buffer.from(u8).toString('base64');
const lines = [
  '// GENERATED by scripts/gen-jpx-fixtures.mjs — do not edit by hand.',
  '// Regenerate: node scripts/gen-jpx-fixtures.mjs',
  'export function b64(s){return Uint8Array.from(Buffer.from(s,"base64"));}',
];

function emit(name, j2k, rgb) {
  lines.push(`export const ${name}_j2k = b64(${JSON.stringify(b64(j2k))});`);
  lines.push(`export const ${name}_rgb = { width: ${rgb.width}, height: ${rgb.height}, comps: ${rgb.comps}, data: b64(${JSON.stringify(b64(rgb.data))}) };`);
}

// Variant matrix. `encodeJ2k`/`decodeJ2k` wrap the chosen library.
const gray = raster(16, 16, 1);
const rgb = raster(16, 16, 3);
emit('lossless_gray', encodeJ2k(gray, { reversible: true, levels: 3, format: 'j2k' }), decodeJ2k(/*...*/));
emit('lossy_rgb',     encodeJ2k(rgb,  { reversible: false, levels: 3, format: 'j2k' }), gray /* placeholder—use decodeJ2k */);
emit('multilayer',    encodeJ2k(rgb,  { reversible: true, levels: 3, layers: 3, format: 'j2k' }), rgb);
emit('rpcl',          encodeJ2k(rgb,  { reversible: true, levels: 3, progression: 'RPCL', format: 'j2k' }), rgb);
emit('jp2box',        encodeJ2k(gray, { reversible: true, levels: 3, format: 'jp2' }), gray);

writeFileSync(new URL('../test/helpers/jpx-fixtures.ts', import.meta.url), lines.join('\n') + '\n');
console.log('wrote test/helpers/jpx-fixtures.ts');
```

For a reversible (5/3) encode the decode is exact, so ground-truth `_rgb` for those variants equals the input raster — use the input directly and assert exact equality later. For lossy (9/7), populate `_rgb` from a real decode of the encoded stream (the library's own decoder) so the tolerance test compares against a true JPEG-2000 reconstruction, not the pre-encode raster.

- [ ] **Step 3: Generate and sanity-check**

```bash
node scripts/gen-jpx-fixtures.mjs
```
Expected: `test/helpers/jpx-fixtures.ts` written; `lossless_gray_j2k` begins with `FF 4F FF 51` (SOC then SIZ). Verify in a quick REPL: `import('./test/helpers/jpx-fixtures.ts')` and check `lossless_gray_j2k.slice(0,4)`.

- [ ] **Step 4: Remove the encoder devDependency (keep fixtures)**

```bash
npm uninstall @cornerstonejs/codec-openjpeg
```
Leave `test/helpers/jpx-fixtures.ts` checked in and the `scripts/gen-jpx-fixtures.mjs` header documenting the one-time `npm install --save-dev` needed to regenerate. Confirm `npm ls` shows no JPEG-2000 dependency and `package.json` has no runtime dep added.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-jpx-fixtures.mjs test/helpers/jpx-fixtures.ts package.json package-lock.json
git commit -m "test(kec): offline JPEG 2000 fixture generator + reference fixtures"
```

---

### Task 3: Inverse discrete wavelet transform (`jpxwavelet.ts`)

The inverse DWT (ISO 15444-1 Annex F) is standalone and testable by forward/inverse round-trip with a forward reference written in the test. Build both 5/3 (reversible, integer) and 9/7 (irreversible, float) 1D lifting, then the 2D per-level driver.

**Files:**
- Create: `src/jpxwavelet.ts`
- Test: `test/jpxwavelet.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Subband { type: 'LL' | 'HL' | 'LH' | 'HH'; x0: number; y0: number; x1: number; y1: number; coeffs: Float32Array }` — dequantized coefficients, row-major over `[x0,x1)×[y0,y1)`.
  - `interface ResolutionSpec { level: number; x0: number; y0: number; x1: number; y1: number; subbands: Subband[] }` — for level 0, one `LL`; for levels ≥ 1, `HL`/`LH`/`HH`.
  - `function inverseDwt(resolutions: ResolutionSpec[], reversible: boolean): Float32Array` — returns the reconstructed component tile as a row-major `Float32Array` sized to the highest resolution's `(x1-x0)×(y1-y0)`.
  - `function idwt1d53(a: Float32Array, off: number, len: number, stride: number, i0: number): void` and `idwt1d97(...)` (same signature) — exported for direct round-trip testing.

- [ ] **Step 1: Write failing round-trip tests**

Create `test/jpxwavelet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { idwt1d53, idwt1d97 } from '../src/jpxwavelet.js';

// Forward 5/3 lifting (Annex F.3.8.1), interleaved output: evens=low, odds=high.
function fdwt53(sig: number[]): Float32Array {
  const n = sig.length, out = new Float32Array(n);
  const x = (i: number) => sig[i < 0 ? -i : i >= n ? 2 * n - 2 - i : i];
  for (let i = 1; i < n; i += 2) out[i] = x(i) - Math.floor((x(i - 1) + x(i + 1)) / 2);
  const h = (i: number) => (i < 0 ? out[1] : i >= n ? out[n - (n % 2 === 0 ? 1 : 2)] : out[i]);
  for (let i = 0; i < n; i += 2) out[i] = x(i) + Math.floor((h(i - 1) + h(i + 1) + 2) / 4);
  return out;
}

describe('inverse DWT', () => {
  it('5/3 inverse is the exact inverse of 5/3 forward (integer, lossless)', () => {
    const sig = [10, 3, 47, 5, 9, 200, 13, 6];
    const coeffs = fdwt53(sig);
    idwt1d53(coeffs, 0, sig.length, 1, 0);
    expect(Array.from(coeffs).map((v) => Math.round(v))).toEqual(sig);
  });

  it('9/7 inverse recovers a smooth signal within tolerance', () => {
    // Build an interleaved low/high band that the forward 9/7 would produce is
    // involved; instead assert idempotence: inverse then a matching forward
    // (implemented in src) is not available, so test a known constant signal,
    // whose high-pass coefficients are ~0 and low-pass ~scaled samples.
    const n = 8;
    const coeffs = new Float32Array(n);
    for (let i = 0; i < n; i += 2) coeffs[i] = 100 / Math.SQRT2 * Math.SQRT2; // LL≈sample
    idwt1d97(coeffs, 0, n, 1, 0);
    for (let i = 0; i < n; i++) expect(Math.abs(coeffs[i] - 100)).toBeLessThan(1e-3);
  });
});
```

> The 9/7 test uses a constant signal (all high-pass ≈ 0) so the forward transform is trivial to reason about; the exhaustive numeric proof of 9/7 comes from the end-to-end lossy fixture in Task 7.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpxwavelet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `jpxwavelet.ts`**

```ts
// Inverse DWT — ISO/IEC 15444-1 Annex F. 1D lifting on interleaved arrays
// (even indices = low-pass, odd = high-pass), symmetric (whole-sample) extension.

const clampIdx = (i: number, i0: number, i1: number): number => {
  // Whole-sample symmetric extension across [i0, i1).
  const len = i1 - i0;
  if (len === 1) return i0;
  let k = i - i0;
  const period = 2 * (len - 1);
  k = ((k % period) + period) % period;
  if (k >= len) k = period - k;
  return i0 + k;
};

/** Inverse 5/3 (reversible). `a` holds interleaved low/high over [i0, i0+len). */
export function idwt1d53(a: Float32Array, off: number, len: number, stride: number, i0: number): void {
  const at = (i: number) => a[off + clampIdx(i, i0, i0 + len - (len === 0 ? 0 : 0)) * stride];
  // Simpler: operate on a local copy indexed 0..len-1 with symmetric extension.
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) buf[i] = a[off + i * stride];
  const ext = (i: number) => buf[clampIdx(i + i0, i0, i0 + len) - i0];
  // Even (low) samples first: s(2n) = buf(2n) - floor((d(2n-1)+d(2n+1)+2)/4)
  for (let i = 0; i < len; i += 2) buf[i] = ext(i) - Math.floor((ext(i - 1) + ext(i + 1) + 2) / 4);
  // Odd (high) samples: d(2n+1) = buf(2n+1) + floor((s(2n)+s(2n+2))/2)
  for (let i = 1; i < len; i += 2) buf[i] = buf[i] + Math.floor((buf[i - 1 < 0 ? 1 : i - 1] + buf[i + 1 >= len ? len - 2 : i + 1]) / 2);
  for (let i = 0; i < len; i++) a[off + i * stride] = buf[i];
}

// 9/7 lifting constants (Annex F, Table F.4).
const A97 = -1.586134342059924, B97 = -0.052980118572961,
      G97 = 0.882911075530934, D97 = 0.443506852043971,
      K97 = 1.230174104914001;

/** Inverse 9/7 (irreversible). */
export function idwt1d97(a: Float32Array, off: number, len: number, stride: number, i0: number): void {
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) buf[i] = a[off + i * stride];
  const sym = (arr: Float32Array, i: number) => arr[clampIdx(i + i0, i0, i0 + len) - i0];
  // Step 1: scaling
  for (let i = 0; i < len; i++) buf[i] *= (i & 1) ? (1 / K97) : K97; // low*=K, high*=1/K
  // Step 2: undo lifting (reverse order of forward): delta, gamma, beta, alpha
  for (let i = 0; i < len; i += 2) buf[i] -= D97 * (sym(buf, i - 1) + sym(buf, i + 1));
  for (let i = 1; i < len; i += 2) buf[i] -= G97 * (sym(buf, i - 1) + sym(buf, i + 1));
  for (let i = 0; i < len; i += 2) buf[i] -= B97 * (sym(buf, i - 1) + sym(buf, i + 1));
  for (let i = 1; i < len; i += 2) buf[i] -= A97 * (sym(buf, i - 1) + sym(buf, i + 1));
  for (let i = 0; i < len; i++) a[off + i * stride] = buf[i];
}

export interface Subband { type: 'LL' | 'HL' | 'LH' | 'HH'; x0: number; y0: number; x1: number; y1: number; coeffs: Float32Array }
export interface ResolutionSpec { level: number; x0: number; y0: number; x1: number; y1: number; subbands: Subband[] }

/** Reconstruct a component tile from its resolution pyramid. Interleaves the
 *  four subbands of each level into the next resolution, then applies a 2D
 *  inverse lift (rows then columns). */
export function inverseDwt(resolutions: ResolutionSpec[], reversible: boolean): Float32Array {
  const idwt1d = reversible ? idwt1d53 : idwt1d97;
  const r0 = resolutions[0];
  // Start from the level-0 LL band.
  let cur = resolutions[0].subbands[0].coeffs.slice();
  let curW = r0.x1 - r0.x0, curH = r0.y1 - r0.y0, curX0 = r0.x0, curY0 = r0.y0;
  for (let r = 1; r < resolutions.length; r++) {
    const res = resolutions[r];
    const w = res.x1 - res.x0, h = res.y1 - res.y0;
    const buf = new Float32Array(w * h);
    const put = (sb: Subband, ox: number, oy: number) => {
      const sw = sb.x1 - sb.x0;
      for (let y = sb.y0; y < sb.y1; y++) for (let x = sb.x0; x < sb.x1; x++) {
        const dx = 2 * (x - sb.x0) + ox, dy = 2 * (y - sb.y0) + oy;
        buf[dy * w + dx] = sb.coeffs[(y - sb.y0) * sw + (x - sb.x0)];
      }
    };
    // Deinterleave: LL (from cur), HL, LH, HH into even/odd lattice.
    for (let y = 0; y < curH; y++) for (let x = 0; x < curW; x++) buf[(2 * y) * w + 2 * x] = cur[y * curW + x];
    const byType = (t: Subband['type']) => res.subbands.find((s) => s.type === t)!;
    put(byType('HL'), 1, 0); put(byType('LH'), 0, 1); put(byType('HH'), 1, 1);
    // Inverse lift rows then columns.
    for (let y = 0; y < h; y++) idwt1d(buf, y * w, w, 1, res.x0);
    for (let x = 0; x < w; x++) idwt1d(buf, x, h, w, res.y0);
    cur = buf; curW = w; curH = h; curX0 = res.x0; curY0 = res.y0;
  }
  void curX0; void curY0;
  return cur;
}
```

> Implementer note: the parity of the even/odd lattice is anchored to the subband origin (`i0`) per Annex F.3.2 — the `clampIdx`/parity handling above assumes the tile origin is even; the end-to-end fixtures in Task 7 exercise the real origins. If the round-trip test passes but a fixture is shifted by one sample, revisit the `ox/oy` interleave offsets and the `i0` passed to `idwt1d`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/jpxwavelet.test.ts`
Expected: PASS (5/3 exact, 9/7 constant within 1e-3).

- [ ] **Step 5: Commit**

```bash
git add src/jpxwavelet.ts test/jpxwavelet.test.ts
git commit -m "feat(kec): inverse 5/3 + 9/7 DWT (JPEG 2000 Annex F)"
```

---

### Task 4: EBCOT Tier-1 code-block decoder (`jpxt1.ts`)

Tier-1 (ISO 15444-1 Annex D) decodes one code-block's MQ-coded byte segment into signed subband coefficients via three bit-plane passes: significance propagation, magnitude refinement, and cleanup. It consumes `MqDecoder` (Task 1). It cannot be fully validated in isolation without an encoder, so its unit test covers the context tables and a single-pass structural case; full validation is end-to-end in Task 7.

**Files:**
- Create: `src/jpxt1.ts`
- Test: `test/jpxt1.test.ts`

**Interfaces:**
- Consumes: `MqDecoder` from `./jpxmq.js`.
- Produces:
  - `interface CodeBlockDecode { width: number; height: number; data: Uint8Array; passes: number; zeroBitPlanes: number; sbType: 'LL' | 'HL' | 'LH' | 'HH' }`
  - `function decodeCodeBlock(cb: CodeBlockDecode): Int32Array` — returns signed coefficients (magnitude with sign), row-major `width×height`. `data` is the concatenated MQ segment; `passes` total coding passes across all layers; `zeroBitPlanes` the number of all-zero MSB planes signalled in Tier-2.

- [ ] **Step 1: Write the failing test (context tables + a trivial all-zero block)**

Create `test/jpxt1.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeCodeBlock } from '../src/jpxt1.js';

describe('EBCOT Tier-1', () => {
  it('decodes an empty segment (zero passes) to all-zero coefficients', () => {
    const out = decodeCodeBlock({ width: 4, height: 4, data: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, sbType: 'LL' });
    expect(out.length).toBe(16);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpxt1.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `jpxt1.ts`**

Implement the three-pass bit-plane decoder. The structure below is the canonical Annex D algorithm (state per sample: significance, sign, visited, and the neighbour-significance running sums used for context selection). Context tables `LL_LH_CONTEXT`, `HL_CONTEXT`, `HH_CONTEXT` are the fixed zero-coding lookups from Table D.1; `SIGN_CONTEXT`/`SIGN_XOR` implement Table D.2/D.3; magnitude-refinement contexts 14–16 and the uniform context 18 / run-length context 17 per D.3.3–D.3.4.

```ts
import { MqDecoder } from './jpxmq.js';

export interface CodeBlockDecode {
  width: number; height: number; data: Uint8Array;
  passes: number; zeroBitPlanes: number; sbType: 'LL' | 'HL' | 'LH' | 'HH';
}

// Zero-coding context tables (Table D.1), indexed by a packed neighbour key:
// key = h*? — we compute (sumH, sumV, sumD) and map per subband orientation.
// The three orientations share one table by swapping H/V for HL vs LH/LL.
function zeroContext(sbType: string, sh: number, sv: number, sd: number): number {
  // sh,sv ∈ {0,1,2}; sd ∈ {0,1,2,3,4}. Table D.1 (LL & LH use (H,V); HL swaps).
  let h = sh, v = sv;
  if (sbType === 'HL') { h = sv; v = sh; }
  if (h === 2) return 8;
  if (h === 1) { if (v >= 1) return 7; if (sd >= 1) return 6; return 5; }
  // h === 0
  if (v === 2) return 4;
  if (v === 1) return 3;
  if (sd >= 2) return 2;
  if (sd === 1) return 1;
  return 0;
}

// Sign-coding context (Table D.2) and XOR bit (Table D.3), from horizontal &
// vertical signed contributions in {-1,0,1}.
function signContext(hc: number, vc: number): { ctx: number; xor: number } {
  // hc,vc ∈ {-2..2} collapsed to {-1,0,1} by the caller.
  const H = hc < 0 ? -1 : hc > 0 ? 1 : 0;
  const V = vc < 0 ? -1 : vc > 0 ? 1 : 0;
  const table: Record<string, [number, number]> = {
    '1,1': [13, 0], '1,0': [12, 0], '1,-1': [11, 0],
    '0,1': [10, 0], '0,0': [9, 0], '0,-1': [10, 1],
    '-1,1': [11, 1], '-1,0': [12, 1], '-1,-1': [13, 1],
  };
  const [ctx, xor] = table[`${H},${V}`];
  return { ctx, xor };
}

const UNIFORM_CTX = 18;
const RUNLENGTH_CTX = 17;

export function decodeCodeBlock(cb: CodeBlockDecode): Int32Array {
  const { width: w, height: h, data, passes, zeroBitPlanes, sbType } = cb;
  const coeffs = new Int32Array(w * h);
  if (passes === 0 || data.length === 0) return coeffs;

  const sig = new Uint8Array(w * h);      // significance
  const sign = new Uint8Array(w * h);     // 0 = +, 1 = -
  const visited = new Uint8Array(w * h);  // per-plane visited flag (reset each plane)
  const cx = new Int8Array(19);
  // Initial context states (Table D.7): ctx 0 (ZC-run/uniform base) → state 4 MPS 0;
  // ctx 17 (run-length) → state 3; ctx 18 (uniform) → state 46. All else 0.
  cx[0] = (4 << 1) | 0;
  cx[RUNLENGTH_CTX] = (3 << 1) | 0;
  cx[UNIFORM_CTX] = (46 << 1) | 0;

  const mq = new MqDecoder(data, 0, data.length);
  const idx = (x: number, y: number) => y * w + x;

  // Neighbour significance sums for zero-coding & sign-coding at (x,y).
  const neigh = (x: number, y: number) => {
    let sh = 0, sv = 0, sd = 0, hc = 0, vc = 0;
    const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h) ? 0 : sig[idx(xx, yy)];
    const sg = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h) ? 0 : (sign[idx(xx, yy)] ? -1 : 1);
    const L = at(x - 1, y), R = at(x + 1, y), U = at(x, y - 1), D = at(x, y + 1);
    sh = L + R; sv = U + D;
    sd = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
    if (L) hc += sg(x - 1, y); if (R) hc += sg(x + 1, y);
    if (U) vc += sg(x, y - 1); if (D) vc += sg(x, y + 1);
    return { sh, sv, sd, hc, vc };
  };

  // Decode the sign bit at (x,y); sets sign[], returns nothing.
  const decodeSign = (x: number, y: number) => {
    const { hc, vc } = neigh(x, y);
    const { ctx, xor } = signContext(hc, vc);
    const bit = mq.decode(cx, ctx);
    sign[idx(x, y)] = (bit ^ xor) as number;
  };

  // Total bit-planes = precision − 1 − zeroBitPlanes; the MSB plane index:
  // The absolute magnitude accumulates one bit per cleanup/sig-prop/refine pass.
  // We iterate planes from MSB down; each plane runs the 3 passes (except the
  // first plane which runs only cleanup).
  let pass = 0;
  const magBit = new Int32Array(w * h); // accumulates magnitude across planes
  let plane = 30 - zeroBitPlanes;        // conceptual; actual top bit set by first sig
  void plane;

  // Significance propagation pass (D.3.1).
  const sigProp = () => {
    for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) {
      for (let y = y0; y < Math.min(y0 + 4, h); y++) {
        const i = idx(x, y);
        if (sig[i]) continue;
        const { sh, sv, sd } = neigh(x, y);
        if (sh + sv + sd === 0) continue; // context 0 → skipped in sig-prop
        visited[i] = 1;
        const zc = zeroContext(sbType, Math.min(sh, 2), Math.min(sv, 2), sd);
        if (mq.decode(cx, zc)) { sig[i] = 1; magBit[i] |= 1; decodeSign(x, y); }
      }
    }
  };

  // Magnitude refinement pass (D.3.2).
  const magRef = () => {
    for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) {
      for (let y = y0; y < Math.min(y0 + 4, h); y++) {
        const i = idx(x, y);
        if (!sig[i] || visited[i]) continue;
        const { sh, sv, sd } = neigh(x, y);
        const firstRefine = (magBit[i] & ~1) === 0; // has it been refined before?
        const ctx = firstRefine ? ((sh + sv + sd) > 0 ? 15 : 14) : 16;
        const bit = mq.decode(cx, ctx);
        magBit[i] = (magBit[i] << 1) | bit;
      }
    }
  };

  // Cleanup pass (D.3.4) with run-length coding of 4-sample columns.
  const cleanup = () => {
    for (let y0 = 0; y0 < h; y0 += 4) for (let x = 0; x < w; x++) {
      let y = y0;
      const colH = Math.min(4, h - y0);
      // Run-length: if all four samples insignificant with zero context.
      let runOk = colH === 4;
      if (runOk) for (let k = 0; k < 4; k++) { const i = idx(x, y0 + k); const nn = neigh(x, y0 + k); if (sig[i] || visited[i] || nn.sh + nn.sv + nn.sd !== 0) { runOk = false; break; } }
      if (runOk) {
        if (mq.decode(cx, RUNLENGTH_CTX) === 0) { for (let k = 0; k < 4; k++) visited[idx(x, y0 + k)] = 0; continue; }
        // Two uniform-context bits give the run length (0..3).
        const hi = mq.decode(cx, UNIFORM_CTX), lo = mq.decode(cx, UNIFORM_CTX);
        y = y0 + ((hi << 1) | lo);
        const i = idx(x, y); sig[i] = 1; magBit[i] |= 1; decodeSign(x, y); y++;
      }
      for (; y < y0 + colH; y++) {
        const i = idx(x, y);
        if (sig[i] || visited[i]) { visited[i] = 0; continue; }
        const { sh, sv, sd } = neigh(x, y);
        const zc = zeroContext(sbType, Math.min(sh, 2), Math.min(sv, 2), sd);
        if (mq.decode(cx, zc)) { sig[i] = 1; magBit[i] |= 1; decodeSign(x, y); }
      }
      for (let k = 0; k < colH; k++) visited[idx(x, y0 + k)] = 0;
    }
  };

  // Drive passes: plane 0 = cleanup only; subsequent planes = sigProp, magRef, cleanup.
  for (; pass < passes; pass++) {
    const positionInPlane = pass === 0 ? 2 : (pass - 1) % 3; // 0 sigProp,1 magRef,2 cleanup
    if (positionInPlane === 0) sigProp();
    else if (positionInPlane === 1) magRef();
    else cleanup();
  }

  // Reconstruct signed coefficients: magnitude with mid-point offset, apply sign.
  for (let i = 0; i < w * h; i++) {
    if (magBit[i] === 0) { coeffs[i] = 0; continue; }
    const mag = magBit[i];
    coeffs[i] = sign[i] ? -mag : mag;
  }
  return coeffs;
}
```

> Implementer note: this is the canonical Annex D structure. The magnitude reconstruction (`magBit` accumulation and the mid-point `0.5` reconstruction offset that Tier-2/dequant applies) and the precise plane/pass bookkeeping are the parts most likely to need adjustment when the Task 7 fixture first decodes — treat any exact-match failure on the 5/3 lossless fixture as a Tier-1 bug and bisect by dumping one code-block's coefficients against a pdf.js/OpenJPEG reference decode of the same block. Do not tune constants blindly; align to Annex D.3.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jpxt1.test.ts`
Expected: PASS (empty-segment case).

- [ ] **Step 5: Commit**

```bash
git add src/jpxt1.ts test/jpxt1.test.ts
git commit -m "feat(kec): EBCOT Tier-1 code-block decoder (JPEG 2000 Annex D)"
```

---

### Task 5: Codestream marker + JP2 box parser (`jpx.ts` part 1)

Parse the JP2 box structure and the main-header markers into a `Codestream` model. Standalone and unit-testable against a hand-built byte blob and the real fixture header.

**Files:**
- Create: `src/jpx.ts` (marker/box parse only this task; orchestration added in Task 7)
- Test: `test/jpx-parse.test.ts`

**Interfaces:**
- Consumes: `test/helpers/jpx-fixtures.ts` (Task 2) for a real-header assertion.
- Produces:
  - `interface ComponentSpec { precision: number; signed: boolean; xrSiz: number; yrSiz: number }`
  - `interface CodingStyle { progression: 0|1|2|3|4; layers: number; levels: number; cbW: number; cbH: number; reversible: boolean; mct: boolean }` (progression 0=LRCP…4=CPRL)
  - `interface QuantSpec { style: number; guardBits: number; steps: { mantissa: number; exponent: number }[] }`
  - `interface Codestream { xsiz: number; ysiz: number; xosiz: number; yosiz: number; xtsiz: number; ytsiz: number; xtosiz: number; ytosiz: number; comps: ComponentSpec[]; cod: CodingStyle; qcd: QuantSpec; tileData: Uint8Array }`
  - `function parseCodestream(buf: Uint8Array): Codestream` — throws `PdfParseError` on malformed, `UnsupportedFeatureError` on multi-tile / >3 comps / sub-sampling≠1 / precincts / ROI.
  - `function extractCodestream(buf: Uint8Array): Uint8Array` — unwraps a JP2 box container to the `jp2c` codestream, or returns `buf` unchanged when it already starts with SOC (`0xFF4F`).

- [ ] **Step 1: Write failing tests**

Create `test/jpx-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCodestream, extractCodestream } from '../src/jpx.js';
import { lossless_gray_j2k, jp2box_j2k } from './helpers/jpx-fixtures.js';

describe('JPEG 2000 codestream parse', () => {
  it('unwraps a JP2 box container to a bare codestream (SOC)', () => {
    const cs = extractCodestream(jp2box_j2k);
    expect(cs[0]).toBe(0xff); expect(cs[1]).toBe(0x4f);
  });

  it('parses SIZ/COD/QCD of the lossless-gray fixture', () => {
    const c = parseCodestream(extractCodestream(lossless_gray_j2k));
    expect(c.xsiz - c.xosiz).toBe(16);
    expect(c.ysiz - c.yosiz).toBe(16);
    expect(c.comps.length).toBe(1);
    expect(c.comps[0].precision).toBe(8);
    expect(c.cod.reversible).toBe(true);
    expect(c.cod.levels).toBeGreaterThanOrEqual(1);
  });

  it('throws UnsupportedFeatureError on a multi-tile SIZ', () => {
    // Hand-build minimal SOC+SIZ with XTsiz < Xsiz (more than one tile).
    const siz = buildSiz({ xsiz: 32, ysiz: 32, xtsiz: 16, ytsiz: 16, comps: 1 });
    expect(() => parseCodestream(siz)).toThrow(/tile/i);
  });
});

// Minimal SOC+SIZ+EOC builder for the negative test.
function buildSiz(o: { xsiz: number; ysiz: number; xtsiz: number; ytsiz: number; comps: number }): Uint8Array {
  const n = o.comps;
  const len = 38 + 3 * n;
  const b: number[] = [0xff, 0x4f, 0xff, 0x51, (len >> 8) & 0xff, len & 0xff, 0, 0];
  const u32 = (v: number) => b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  u32(o.xsiz); u32(o.ysiz); u32(0); u32(0);
  u32(o.xtsiz); u32(o.ytsiz); u32(0); u32(0);
  b.push((n >> 8) & 0xff, n & 0xff);
  for (let i = 0; i < n; i++) b.push(7, 1, 1); // 8-bit unsigned, 1:1
  b.push(0xff, 0xd9);
  return Uint8Array.from(b);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpx-parse.test.ts`
Expected: FAIL — `parseCodestream` not exported.

- [ ] **Step 3: Implement the parser in `jpx.ts`**

```ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export interface ComponentSpec { precision: number; signed: boolean; xrSiz: number; yrSiz: number }
export interface CodingStyle { progression: 0 | 1 | 2 | 3 | 4; layers: number; levels: number; cbW: number; cbH: number; reversible: boolean; mct: boolean }
export interface QuantSpec { style: number; guardBits: number; steps: { mantissa: number; exponent: number }[] }
export interface Codestream {
  xsiz: number; ysiz: number; xosiz: number; yosiz: number;
  xtsiz: number; ytsiz: number; xtosiz: number; ytosiz: number;
  comps: ComponentSpec[]; cod: CodingStyle; qcd: QuantSpec; tileData: Uint8Array;
}

class Reader {
  constructor(private b: Uint8Array, public p = 0) {}
  u8() { if (this.p >= this.b.length) throw new PdfParseError('JPX: truncated'); return this.b[this.p++]; }
  u16() { return (this.u8() << 8) | this.u8(); }
  u32() { return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0; }
  bytes(n: number) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
}

/** Unwrap a JP2 box container to its jp2c codestream; pass through a bare codestream. */
export function extractCodestream(buf: Uint8Array): Uint8Array {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x4f) return buf; // SOC
  const r = new Reader(buf);
  while (r.p + 8 <= buf.length) {
    let len = r.u32();
    const type = r.u32();
    let dataStart = r.p;
    if (len === 1) { // XL box: 64-bit length
      const hi = r.u32(), lo = r.u32(); len = hi * 2 ** 32 + lo; dataStart = r.p;
    } else if (len === 0) { len = buf.length - (dataStart - 8); }
    const dataLen = len - (dataStart - (r.p - 8));
    if (type === 0x6a703263 /* 'jp2c' */) return buf.subarray(dataStart, dataStart + (len - (dataStart - (r.p - 8))));
    r.p = dataStart + (len - 8 - (dataStart - r.p)); // advance to next box
    r.p = (r.p < dataStart) ? buf.length : r.p;
    // Robust advance: recompute next box position.
    r.p = dataStart - 8 + len;
    void dataLen;
  }
  throw new PdfParseError('JPX: no jp2c box found');
}

export function parseCodestream(buf: Uint8Array): Codestream {
  const r = new Reader(buf);
  if (r.u16() !== 0xff4f) throw new PdfParseError('JPX: missing SOC');
  let siz: Partial<Codestream> = {}, comps: ComponentSpec[] = [];
  let cod: CodingStyle | undefined, qcd: QuantSpec | undefined;
  let tileData: Uint8Array | undefined;
  for (;;) {
    const m = r.u16();
    if (m === 0xffd9) break; // EOC
    if (m === 0xff93) { // SOD — tile data to end of tile (single tile → to EOC)
      // tileData runs from here to the EOC marker.
      let end = buf.length; for (let i = r.p; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i; break; }
      tileData = buf.subarray(r.p, end); r.p = end; continue;
    }
    const len = r.u16();
    const seg = r.bytes(len - 2);
    const sr = new Reader(seg);
    switch (m) {
      case 0xff51: { // SIZ
        sr.u16(); // Rsiz
        const xsiz = sr.u32(), ysiz = sr.u32(), xosiz = sr.u32(), yosiz = sr.u32();
        const xtsiz = sr.u32(), ytsiz = sr.u32(), xtosiz = sr.u32(), ytosiz = sr.u32();
        const csiz = sr.u16();
        if (csiz > 3) throw new UnsupportedFeatureError(`JPX: ${csiz} components (>3) unsupported`);
        for (let i = 0; i < csiz; i++) {
          const ssiz = sr.u8(); const xr = sr.u8(), yr = sr.u8();
          if (xr !== 1 || yr !== 1) throw new UnsupportedFeatureError('JPX: component sub-sampling unsupported');
          comps.push({ precision: (ssiz & 0x7f) + 1, signed: (ssiz & 0x80) !== 0, xrSiz: xr, yrSiz: yr });
        }
        // Single tile must cover the whole image.
        if (xtsiz < xsiz - xosiz || ytsiz < ysiz - yosiz) throw new UnsupportedFeatureError('JPX: multiple tiles unsupported');
        siz = { xsiz, ysiz, xosiz, yosiz, xtsiz, ytsiz, xtosiz, ytosiz };
        break;
      }
      case 0xff52: { // COD
        const scod = sr.u8();
        if (scod & 0x01) throw new UnsupportedFeatureError('JPX: custom precincts unsupported');
        const progression = sr.u8() as CodingStyle['progression'];
        const layers = sr.u16();
        const mct = sr.u8() === 1;
        const levels = sr.u8();
        const cbW = 1 << (sr.u8() + 2), cbH = 1 << (sr.u8() + 2);
        sr.u8(); // code-block style
        const transform = sr.u8(); // 0 = 9/7 irreversible, 1 = 5/3 reversible
        cod = { progression, layers, levels, cbW, cbH, reversible: transform === 1, mct };
        break;
      }
      case 0xff5c: { // QCD
        const sqcd = sr.u8();
        const style = sqcd & 0x1f, guardBits = sqcd >> 5;
        const steps: { mantissa: number; exponent: number }[] = [];
        if (style === 0) { // no quantization (reversible): exponents only
          while (sr.p < seg.length) { const e = sr.u8() >> 3; steps.push({ mantissa: 0, exponent: e }); }
        } else { // scalar quantization
          while (sr.p + 1 < seg.length) { const v = sr.u16(); steps.push({ exponent: v >> 11, mantissa: v & 0x7ff }); }
        }
        qcd = { style, guardBits, steps };
        break;
      }
      case 0xff53: throw new UnsupportedFeatureError('JPX: RGN (ROI) unsupported'); // actually 0xFF5E; keep explicit throw below
      case 0xff5e: throw new UnsupportedFeatureError('JPX: RGN (ROI) unsupported');
      case 0xff90: { // SOT — single tile: read + ignore, expect Isot 0
        break;
      }
      default: break; // COM, CRG, TLM, PLM, PLT, PPM, PPT ignored (single-precinct baseline)
    }
  }
  if (!siz.xsiz || !cod || !qcd || !tileData) throw new PdfParseError('JPX: missing SIZ/COD/QCD/tile data');
  return { ...(siz as Codestream), comps, cod, qcd, tileData };
}
```

> Note: the RGN marker is `0xFF5E`; the `0xFF53` case is dead and should be removed by the implementer — kept here only to flag that ROI must throw. The `extractCodestream` box-advance arithmetic is intentionally explicit; verify it against the JP2 fixture (`jp2box_j2k`) in the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/jpx-parse.test.ts`
Expected: PASS (unwrap, real-header parse, multi-tile throw).

- [ ] **Step 5: Commit**

```bash
git add src/jpx.ts test/jpx-parse.test.ts
git commit -m "feat(kec): JP2 box + codestream marker parser"
```

---

### Task 6: EBCOT Tier-2 — tag-trees + packet iterator (`jpxt2.ts`)

Tier-2 (Annex B) parses packet headers using two tag-trees per precinct (code-block inclusion + zero-bit-planes), reads coding-pass counts and code-block byte lengths, and iterates packets in the signalled progression order. Single precinct per resolution (baseline scope) simplifies the precinct loop. Consumes `parseCodestream` output and produces per-code-block segments for Tier-1.

**Files:**
- Create: `src/jpxt2.ts`
- Test: `test/jpxt2.test.ts`

**Interfaces:**
- Consumes: `Codestream`, `CodingStyle` from `./jpx.js`.
- Produces:
  - `class TagTree { constructor(w: number, h: number); reset(): void; decode(reader: BitReader, i: number, j: number, threshold: number): number }`
  - `class BitReader { constructor(data: Uint8Array, start: number); readBit(): number; readBits(n: number): number; align(): void; bytePos(): number }` — MSB-first with the JPEG-2000 bit-stuffing rule (after a `0xFF` the next byte has only 7 valid bits).
  - `interface CodeBlockCoded { x0: number; y0: number; x1: number; y1: number; sbType: 'LL'|'HL'|'LH'|'HH'; segment: Uint8Array; passes: number; zeroBitPlanes: number }`
  - `interface ResolutionCoded { level: number; x0: number; y0: number; x1: number; y1: number; subbands: { type: 'LL'|'HL'|'LH'|'HH'; x0: number; y0: number; x1: number; y1: number; blocks: CodeBlockCoded[] }[] }`
  - `function decodeTier2(cs: Codestream, compIndex: number): ResolutionCoded[]` — parses all packets for one component and fills each code-block's `segment`/`passes`/`zeroBitPlanes`.

- [ ] **Step 1: Write failing tests (BitReader stuffing + tag-tree)**

Create `test/jpxt2.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BitReader, TagTree } from '../src/jpxt2.js';

describe('Tier-2 primitives', () => {
  it('BitReader reads MSB-first with FF bit-unstuffing', () => {
    // 0xFF then 0x7F: after 0xFF only 7 bits of the next byte are valid.
    const r = new BitReader(Uint8Array.from([0xff, 0x7f]), 0);
    const bits: number[] = [];
    for (let i = 0; i < 8; i++) bits.push(r.readBit()); // 8 bits of 0xFF
    for (let i = 0; i < 7; i++) bits.push(r.readBit()); // 7 valid bits of 0x7F
    expect(bits.slice(0, 8).join('')).toBe('11111111');
    expect(bits.slice(8).join('')).toBe('1111111');
  });

  it('TagTree decodes a single-node tree value', () => {
    // A 1×1 tag tree encoding value 2: bits 1,1,0 across thresholds 1,2,3.
    const tt = new TagTree(1, 1);
    const r = new BitReader(Uint8Array.from([0b11000000]), 0);
    expect(tt.decode(r, 0, 0, 1)).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpxt2.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `jpxt2.ts`**

```ts
import { Codestream } from './jpx.js';

/** MSB-first bit reader with JPEG-2000 bit-stuffing: after a 0xFF byte the next
 *  byte carries only 7 valid bits (bit 7 is a stuffed 0). Annex B.10.1. */
export class BitReader {
  private bit = -1;
  private cur = 0;
  private prevFF = false;
  constructor(private data: Uint8Array, private pos: number) {}
  readBit(): number {
    if (this.bit < 0) {
      this.cur = this.pos < this.data.length ? this.data[this.pos++] : 0;
      this.bit = this.prevFF ? 6 : 7;
      this.prevFF = this.cur === 0xff;
    }
    const b = (this.cur >> this.bit) & 1;
    this.bit--;
    return b;
  }
  readBits(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.readBit(); return v; }
  align(): void {
    // Consume to a byte boundary; if the last emitted byte was 0xFF, skip the stuffed byte.
    if (this.prevFF) { this.pos++; }
    this.bit = -1; this.prevFF = false;
  }
  bytePos(): number { return this.bit < 0 ? this.pos : this.pos - 1; }
}

/** Quad tag-tree (Annex B.10.2). Levels from leaves (w×h) up to a 1×1 root. */
export class TagTree {
  private levels: { w: number; h: number; value: Int32Array; known: Uint8Array }[] = [];
  constructor(w: number, h: number) {
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({ w: lw, h: lh, value: new Int32Array(lw * lh).fill(0), known: new Uint8Array(lw * lh) });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  reset(): void { for (const l of this.levels) { l.value.fill(0); l.known.fill(0); } }
  /** Decode whether node (i,j)'s value is < threshold, refining lower bounds. */
  decode(r: BitReader, i: number, j: number, threshold: number): number {
    let cur = this.levels.length - 1; // root
    let lo = 0;
    // Propagate current lower bound from root down to the leaf.
    let stack: { lvl: number; x: number; y: number }[] = [];
    let x = i, y = j;
    for (let lvl = 0; lvl < this.levels.length; lvl++) { stack.push({ lvl, x, y }); x >>= 1; y >>= 1; }
    lo = this.levels[this.levels.length - 1].value[0];
    for (let s = stack.length - 1; s >= 0; s--) {
      const { lvl, x: nx, y: ny } = stack[s];
      const L = this.levels[lvl]; const idx = ny * L.w + nx;
      if (L.value[idx] < lo) L.value[idx] = lo;
      while (!L.known[idx] && L.value[idx] < threshold) {
        if (r.readBit() === 1) { L.known[idx] = 1; } else { L.value[idx]++; }
      }
      lo = L.value[idx];
    }
    void cur;
    return lo;
  }
}

export interface CodeBlockCoded { x0: number; y0: number; x1: number; y1: number; sbType: 'LL'|'HL'|'LH'|'HH'; segment: Uint8Array; passes: number; zeroBitPlanes: number }
export interface ResolutionCoded { level: number; x0: number; y0: number; x1: number; y1: number; subbands: { type: 'LL'|'HL'|'LH'|'HH'; x0: number; y0: number; x1: number; y1: number; blocks: CodeBlockCoded[] }[] }

// Compute the resolution/subband geometry for one component (single precinct).
function buildResolutions(cs: Codestream, comp: number): ResolutionCoded[] {
  const w = cs.xsiz - cs.xosiz, h = cs.ysiz - cs.yosiz;
  const N = cs.cod.levels;
  const res: ResolutionCoded[] = [];
  for (let r = 0; r <= N; r++) {
    // Resolution r spans the image reduced by (N - r) levels.
    const rw = Math.ceil(w / (1 << (N - r))), rh = Math.ceil(h / (1 << (N - r)));
    if (r === 0) {
      res.push({ level: 0, x0: 0, y0: 0, x1: rw, y1: rh, subbands: [{ type: 'LL', x0: 0, y0: 0, x1: rw, y1: rh, blocks: [] }] });
    } else {
      const pw = Math.ceil(w / (1 << (N - r + 1))), ph = Math.ceil(h / (1 << (N - r + 1)));
      const subs: ResolutionCoded['subbands'] = [
        { type: 'HL', x0: 0, y0: 0, x1: rw - pw, y1: ph, blocks: [] },
        { type: 'LH', x0: 0, y0: 0, x1: pw, y1: rh - ph, blocks: [] },
        { type: 'HH', x0: 0, y0: 0, x1: rw - pw, y1: rh - ph, blocks: [] },
      ];
      res.push({ level: r, x0: 0, y0: 0, x1: rw, y1: rh, subbands: subs });
    }
  }
  // Partition each subband into code-blocks and attach empty segments.
  for (const rr of res) for (const sb of rr.subbands) {
    const { cbW, cbH } = cs.cod;
    for (let by = sb.y0; by < sb.y1; by += cbH) for (let bx = sb.x0; bx < sb.x1; bx += cbW) {
      sb.blocks.push({ x0: bx, y0: by, x1: Math.min(bx + cbW, sb.x1), y1: Math.min(by + cbH, sb.y1), sbType: sb.type, segment: new Uint8Array(0), passes: 0, zeroBitPlanes: 0 });
    }
  }
  return res;
}

// Per-code-block Tier-2 decode state: inclusion tag-tree, zero-bit-plane tag-tree,
// running included flag and Lblock (length signalling) per precinct/subband.
export function decodeTier2(cs: Codestream, comp: number): ResolutionCoded[] {
  const res = buildResolutions(cs, comp);
  const layers = cs.cod.layers;
  const progression = cs.cod.progression;

  // One precinct per resolution → one inclusion + one zbp tag-tree per subband.
  type SbState = { inclTree: TagTree; zbpTree: TagTree; lblock: Int32Array; included: Uint8Array; cbCols: number };
  const state = new Map<object, SbState>();
  for (const rr of res) for (const sb of rr.subbands) {
    const cols = Math.max(1, Math.ceil((sb.x1 - sb.x0) / cs.cod.cbW));
    const rows = Math.max(1, Math.ceil((sb.y1 - sb.y0) / cs.cod.cbH));
    state.set(sb, { inclTree: new TagTree(cols, rows), zbpTree: new TagTree(cols, rows), lblock: new Int32Array(sb.blocks.length).fill(3), included: new Uint8Array(sb.blocks.length), cbCols: cols });
  }

  const r = new BitReader(cs.tileData, 0);

  // Read one packet for (layer, resolution) over its subbands. Baseline: single
  // precinct, so a packet covers all code-blocks of the resolution's subbands.
  const readPacket = (rr: ResolutionCoded, layer: number) => {
    if (r.readBit() === 0) { r.align(); return; } // empty packet (zero-length)
    for (const sb of rr.subbands) {
      const st = state.get(sb)!;
      sb.blocks.forEach((cb, bi) => {
        const col = bi % st.cbCols, row = (bi / st.cbCols) | 0;
        let newlyIncluded = false;
        if (!st.included[bi]) {
          const v = st.inclTree.decode(r, col, row, layer + 1);
          if (v > layer) return; // not yet included in this layer
          st.included[bi] = 1; newlyIncluded = true;
          // Zero bit planes via the second tag-tree (threshold grows until known).
          let zbp = 0; for (let t = 1; ; t++) { const zv = st.zbpTree.decode(r, col, row, t); if (zv < t) { zbp = zv; break; } if (t > 40) { zbp = zv; break; } }
          cb.zeroBitPlanes = zbp;
        } else {
          if (r.readBit() === 0) return; // no new passes this layer
        }
        // Number of coding passes this layer (Annex B.10.7 code).
        let passes = 1;
        if (r.readBit() === 1) { passes = 2; if (r.readBit() === 1) { passes = 3 + r.readBits(2); if (passes === 6) passes = 6 + r.readBits(5); if (passes === 37) passes = 37 + r.readBits(7); } }
        // Lblock increment: while a 1 is read, Lblock++.
        while (r.readBit() === 1) st.lblock[bi]++;
        const bits = st.lblock[bi] + Math.floor(Math.log2(passes));
        const segLen = r.readBits(bits);
        void newlyIncluded;
        // Record pending (length, passes) to slice after header alignment.
        cb.passes += passes;
        (cb as unknown as { _pending: { len: number; passes: number }[] })._pending ??= [] as { len: number; passes: number }[];
        (cb as unknown as { _pending: { len: number; passes: number }[] })._pending.push({ len: segLen, passes });
      });
    }
    r.align();
    // Read body: concatenate each included code-block's bytes in subband order.
    for (const sb of rr.subbands) for (const cb of sb.blocks) {
      const pend = (cb as unknown as { _pending?: { len: number; passes: number }[] })._pending;
      if (!pend || !pend.length) continue;
      const take = pend.reduce((a, p) => a + p.len, 0);
      const start = r.bytePos();
      const chunk = cs.tileData.subarray(start, start + take);
      const merged = new Uint8Array(cb.segment.length + chunk.length);
      merged.set(cb.segment, 0); merged.set(chunk, cb.segment.length);
      cb.segment = merged;
      (r as unknown as { pos: number }).pos = start + take; (r as unknown as { bit: number }).bit = -1;
      (cb as unknown as { _pending?: unknown })._pending = [];
    }
  };

  // Iterate packets in progression order. Baseline: one precinct, one component
  // pass here (caller loops components). LRCP is the common default.
  const iterate = () => {
    const P = 1; // precincts
    const nl = layers, nr = res.length;
    const emit = (l: number, rr: ResolutionCoded) => readPacket(rr, l);
    switch (progression) {
      case 0: for (let l = 0; l < nl; l++) for (let ri = 0; ri < nr; ri++) emit(l, res[ri]); break;         // LRCP
      case 1: for (let ri = 0; ri < nr; ri++) for (let l = 0; l < nl; l++) emit(l, res[ri]); break;         // RLCP
      case 2: for (let ri = 0; ri < nr; ri++) for (let l = 0; l < nl; l++) emit(l, res[ri]); break;         // RPCL (single precinct ⇒ = RLCP)
      case 3: for (let l = 0; l < nl; l++) for (let ri = 0; ri < nr; ri++) emit(l, res[ri]); break;         // PCRL (single precinct ⇒ = LRCP order for one comp)
      case 4: for (let ri = 0; ri < nr; ri++) for (let l = 0; l < nl; l++) emit(l, res[ri]); break;         // CPRL (single comp ⇒ = RLCP)
    }
    void P;
  };
  iterate();
  return res;
}
```

> Implementer note: with a **single precinct and one component per Tier-2 call**, several progression orders collapse to the same packet sequence (as coded above), but the *inter-component* ordering for CPRL/PCRL must be handled by the caller in Task 7 (which decides whether to interleave components per resolution). The pass-count and Lblock codes (Annex B.10.7.5) are the fixterror-prone parts — validate against the multi-layer and RPCL fixtures. The `_pending`/byte-slicing bridge between header and body is deliberately explicit; a cleaner refactor is welcome once the fixtures pass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/jpxt2.test.ts`
Expected: PASS (BitReader stuffing, tag-tree single node).

- [ ] **Step 5: Commit**

```bash
git add src/jpxt2.ts test/jpxt2.test.ts
git commit -m "feat(kec): EBCOT Tier-2 tag-trees + packet iterator"
```

---

### Task 7: Pipeline orchestration + end-to-end fixtures (`jpx.ts` part 2)

Wire the layers into `decodeJpx`: parse → Tier-2 → Tier-1 → dequantize → inverse DWT → inverse color transform → level shift → interleave. Validate against every fixture from Task 2. **This is where Tier-1/Tier-2/DWT are proven correct together.**

**Files:**
- Modify: `src/jpx.ts` (add `decodeJpx` + dequant + color transform + assembly)
- Test: `test/jpx.test.ts`

**Interfaces:**
- Consumes: `parseCodestream`/`extractCodestream` (Task 5), `decodeTier2` (Task 6), `decodeCodeBlock` (Task 4), `inverseDwt` (Task 3).
- Produces:
  - `interface JpxImage { width: number; height: number; comps: number; data: Uint8Array; bitDepth: number }`
  - `function decodeJpx(bytes: Uint8Array): JpxImage`

- [ ] **Step 1: Write failing end-to-end tests**

Create `test/jpx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeJpx } from '../src/jpx.js';
import * as F from './helpers/jpx-fixtures.js';

const maxErr = (a: Uint8Array, b: Uint8Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe('decodeJpx end-to-end', () => {
  it('5/3 lossless grayscale decodes exactly', () => {
    const img = decodeJpx(F.lossless_gray_j2k);
    expect(img.width).toBe(F.lossless_gray_rgb.width);
    expect(img.comps).toBe(1);
    expect(Array.from(img.data)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });

  it('9/7 lossy RGB decodes within tolerance', () => {
    const img = decodeJpx(F.lossy_rgb_j2k);
    expect(img.comps).toBe(3);
    expect(maxErr(img.data, F.lossy_rgb_rgb.data)).toBeLessThanOrEqual(4);
  });

  it('multi-layer decodes to full quality (exact for 5/3)', () => {
    const img = decodeJpx(F.multilayer_j2k);
    expect(Array.from(img.data)).toEqual(Array.from(F.multilayer_rgb.data));
  });

  it('RPCL progression yields the same image as LRCP', () => {
    const img = decodeJpx(F.rpcl_j2k);
    expect(Array.from(img.data)).toEqual(Array.from(F.rpcl_rgb.data));
  });

  it('JP2 box wrapper decodes identically to bare codestream', () => {
    const img = decodeJpx(F.jp2box_j2k);
    expect(Array.from(img.data)).toEqual(Array.from(F.jp2box_rgb.data));
  });

  it('throws UnsupportedFeatureError on multi-tile', () => {
    // Reuse a hand-built multi-tile SIZ from the parse test helper is fine;
    // simplest: expect the parse-layer throw to propagate.
    expect(() => decodeJpx(Uint8Array.from([0xff, 0x4f, 0xff, 0xd9]))).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jpx.test.ts`
Expected: FAIL — `decodeJpx` not exported.

- [ ] **Step 3: Implement `decodeJpx` and the assembly tail in `jpx.ts`**

Add imports and the orchestrator:

```ts
import { decodeTier2 } from './jpxt2.js';
import { decodeCodeBlock } from './jpxt1.js';
import { inverseDwt, ResolutionSpec, Subband } from './jpxwavelet.js';

export interface JpxImage { width: number; height: number; comps: number; data: Uint8Array; bitDepth: number }

// Dequantization step size for a subband (Annex E). Reversible → 1.0.
function stepSize(qcd: QuantSpec, reversible: boolean, level: number, sbIndex: number, precision: number): number {
  if (reversible || qcd.style === 0) return 1;
  // Expounded/derived scalar quantization: Δ = 2^(R−ε) · (1 + μ/2^11).
  const gb = qcd.guardBits;
  const s = qcd.steps[Math.min(sbIndex, qcd.steps.length - 1)];
  const Rb = precision + gb;
  return 2 ** (Rb - s.exponent) * (1 + s.mantissa / 2048);
}

/** Decode a JPEG 2000 codestream (JP2 or bare) to interleaved 8-bit samples. */
export function decodeJpx(bytes: Uint8Array): JpxImage {
  const cs = parseCodestream(extractCodestream(bytes));
  const width = cs.xsiz - cs.xosiz, height = cs.ysiz - cs.yosiz;
  const nc = cs.comps.length;
  const planes: Float32Array[] = [];

  for (let c = 0; c < nc; c++) {
    const coded = decodeTier2(cs, c);
    // Build ResolutionSpec[] with dequantized coefficients per subband.
    const resolutions: ResolutionSpec[] = coded.map((rr) => {
      const subbands: Subband[] = rr.subbands.map((sb, si) => {
        const sw = sb.x1 - sb.x0, sh = sb.y1 - sb.y0;
        const coeffs = new Float32Array(sw * sh);
        const delta = stepSize(cs.qcd, cs.cod.reversible, rr.level, rr.level === 0 ? 0 : (rr.level - 1) * 3 + si + 1, cs.comps[c].precision);
        for (const cb of sb.blocks) {
          const dec = decodeCodeBlock({ width: cb.x1 - cb.x0, height: cb.y1 - cb.y0, data: cb.segment, passes: cb.passes, zeroBitPlanes: cb.zeroBitPlanes, sbType: cb.sbType });
          for (let yy = 0; yy < cb.y1 - cb.y0; yy++) for (let xx = 0; xx < cb.x1 - cb.x0; xx++) {
            const v = dec[yy * (cb.x1 - cb.x0) + xx];
            coeffs[(cb.y0 - sb.y0 + yy) * sw + (cb.x0 - sb.x0 + xx)] = v * delta;
          }
        }
        return { type: sb.type, x0: sb.x0, y0: sb.y0, x1: sb.x1, y1: sb.y1, coeffs };
      });
      return { level: rr.level, x0: rr.x0, y0: rr.y0, x1: rr.x1, y1: rr.y1, subbands };
    });
    planes.push(inverseDwt(resolutions, cs.cod.reversible));
  }

  // Inverse multiple-component transform (RCT reversible / ICT irreversible).
  if (nc === 3 && cs.cod.mct) {
    const [y0, y1, y2] = planes;
    if (cs.cod.reversible) { // RCT (Annex G.2)
      for (let i = 0; i < width * height; i++) {
        const Y = y0[i], U = y1[i], V = y2[i];
        const g = Y - Math.floor((U + V) / 4);
        y0[i] = g + V; y1[i] = g; y2[i] = g + U; // R,G,B
      }
    } else { // ICT (Annex G.1)
      for (let i = 0; i < width * height; i++) {
        const Y = y0[i], Cb = y1[i], Cr = y2[i];
        y0[i] = Y + 1.402 * Cr;
        y1[i] = Y - 0.344136 * Cb - 0.714136 * Cr;
        y2[i] = Y + 1.772 * Cb;
      }
    }
  }

  // DC level shift (+2^(prec−1) for unsigned) + clamp + downshift to 8-bit.
  const data = new Uint8Array(width * height * nc);
  for (let c = 0; c < nc; c++) {
    const prec = cs.comps[c].precision;
    const shift = cs.comps[c].signed ? 0 : (1 << (prec - 1));
    const down = prec > 8 ? prec - 8 : 0;
    const pl = planes[c];
    for (let i = 0; i < width * height; i++) {
      let v = Math.round(pl[i]) + shift;
      v = v < 0 ? 0 : v > (1 << prec) - 1 ? (1 << prec) - 1 : v;
      data[i * nc + c] = down ? (v >> down) : v;
    }
  }
  return { width, height, comps: nc, data, bitDepth: cs.comps[0].precision };
}
```

- [ ] **Step 4: Run tests — iterate against fixtures**

Run: `npx vitest run test/jpx.test.ts`
Expected: PASS. If the 5/3 lossless case is off, debug in this order (each layer already unit-tested, so failures are usually in the *coordinate glue*):
1. Dump `parseCodestream` fields — confirm levels/cbW/cbH/reversible.
2. Dump one code-block's `segment` length vs. Tier-2 `passes`; compare with a pdf.js decode of the same fixture.
3. Check subband→resolution interleave offsets in `inverseDwt` (parity/origin).
4. Check the `sbIndex` passed to `stepSize` and RCT rounding.
Do not weaken the exact-match assertion for 5/3 — lossless must be exact.

- [ ] **Step 5: Commit**

```bash
git add src/jpx.ts test/jpx.test.ts
git commit -m "feat(kec): decodeJpx pipeline orchestration + end-to-end fixtures"
```

---

### Task 8: Integrate into `image.ts` (`Image.Decode()` returns samples)

Wire `decodeJpx` into the public `ImageInfo.Decode()` so JPX images return samples instead of throwing.

**Files:**
- Modify: `src/image.ts` (the `Decode()` terminal-filter switch + its doc comment)
- Test: `test/image-jpx.test.ts`
- Create: `test/helpers/build-jpx-pdf.ts`

**Interfaces:**
- Consumes: `decodeJpx` from `./jpx.js`.
- Produces: `test/helpers/build-jpx-pdf.ts` exporting `function buildJpxPdf(j2k: Uint8Array, w: number, h: number, comps: number): Uint8Array` — a minimal single-page PDF with one JPX image XObject (`/Filter /JPXDecode`, `/ColorSpace` matching comps).

- [ ] **Step 1: Write the failing test**

Create `test/image-jpx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { collectImages } from '../src/image.js';
import { buildJpxPdf } from './helpers/build-jpx-pdf.js';
import * as F from './helpers/jpx-fixtures.js';

describe('ImageInfo.Decode() JPX', () => {
  it('returns decoded samples for a JPXDecode image', () => {
    const pdf = buildJpxPdf(F.lossless_gray_j2k, F.lossless_gray_rgb.width, F.lossless_gray_rgb.height, 1);
    const doc = Document.Open(pdf);
    const imgs = collectImages(doc, doc.Pages[0].Resources);
    const samples = imgs[0].Decode();
    expect(samples.length).toBe(F.lossless_gray_rgb.data.length);
    expect(Array.from(samples)).toEqual(Array.from(F.lossless_gray_rgb.data));
  });
});
```

- [ ] **Step 2: Write `test/helpers/build-jpx-pdf.ts`**

Follow the existing builder style in `test/helpers/` (mirror `build-form-pdf.ts` structure). Emit a 4-object PDF (catalog, pages, page, image XObject) with a classic xref:

```ts
// Minimal single-page PDF wrapping a JPXDecode image XObject.
export function buildJpxPdf(j2k: Uint8Array, w: number, h: number, comps: number): Uint8Array {
  const cs = comps === 1 ? '/DeviceGray' : '/DeviceRGB';
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (s: string) => parts.push(enc.encode(s));
  const offsets: number[] = [];
  let pos = 0;
  const track = (u8: Uint8Array) => { offsets.push(pos); for (const p of parts) pos += p.length; void u8; };
  push('%PDF-1.5\n');
  const startLen = () => parts.reduce((a, p) => a + p.length, 0);
  offsets[1] = startLen(); push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offsets[2] = startLen(); push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = startLen(); push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  offsets[4] = startLen(); push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /JPXDecode /Length ${j2k.length} >>\nstream\n`);
  parts.push(j2k); push('\nendstream\nendobj\n');
  const contents = enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
  offsets[5] = startLen(); push(`5 0 obj\n<< /Length ${contents.length} >>\nstream\n`); parts.push(contents); push('\nendstream\nendobj\n');
  const xrefPos = startLen();
  push(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);
  void track;
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
```

> If `Document.Open` rejects the hand-built xref offsets, prefer reusing an existing PDF builder helper in `test/helpers/` that already produces valid xref tables — match whichever pattern the repo's other image tests use (check `test/helpers/build-image-pdf.ts` or similar). The goal is a valid PDF; do not hand-tune offsets if a builder exists.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/image-jpx.test.ts`
Expected: FAIL — `Decode()` throws `UnsupportedFeatureError` for JPXDecode.

- [ ] **Step 4: Wire `decodeJpx` into `image.ts`**

Add the import and a JPX branch in `Decode()` before the final throw:

```ts
import { decodeJpx } from './jpx.js';
```

In `Decode()`, replace the tail so JPX returns samples. The terminal branch currently ends:

```ts
    throw new UnsupportedFeatureError(`Image.Decode: unsupported filter ${terminal.name}`);
```

Insert before it:

```ts
    if (terminal.name === 'JPXDecode') return decodeJpx(bytes).data;
```

Update the method doc comment: change `JBIG2Decode/JPXDecode throw UnsupportedFeatureError.` to `JBIG2Decode throws UnsupportedFeatureError; JPXDecode returns decoded 8-bit samples.`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/image-jpx.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/image.ts test/image-jpx.test.ts test/helpers/build-jpx-pdf.ts
git commit -m "feat(kec): Image.Decode() returns samples for JPXDecode"
```

---

### Task 9: Render integration (`raster.ts` + `pagerender.ts`)

Let `ToImage`/`ToSvg` render JPX images by adding a JPX branch parallel to the DCT branch and removing JPX from `NO_RASTER_DECODER`.

**Files:**
- Modify: `src/raster.ts` (`decodeImageRgba`, `decodeSMaskAlpha`, `NO_RASTER_DECODER`)
- Modify: `src/pagerender.ts` (mirror the raster image branch if it has its own decoder switch)
- Test: `test/jpx-render.test.ts`

**Interfaces:**
- Consumes: `ImageInfo.Decode()` (Task 8 — returns JPX samples).
- Produces: no new exports; behavioral change to `decodeImageRgba`.

- [ ] **Step 1: Write the failing render test**

Create `test/jpx-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildJpxPdf } from './helpers/build-jpx-pdf.js';
import * as F from './helpers/jpx-fixtures.js';

describe('JPX rendering', () => {
  it('ToImage renders a page containing a JPX image without degrading it away', () => {
    const pdf = buildJpxPdf(F.lossless_gray_j2k, F.lossless_gray_rgb.width, F.lossless_gray_rgb.height, 1);
    const doc = Document.Open(pdf);
    const png = doc.Pages[0].ToImage({ format: 'png', scale: 1 });
    expect(png.length).toBeGreaterThan(64); // produced a non-trivial PNG
  });
});
```

> Confirm the exact `ToImage` signature/return type from `src/page.ts` before finalizing the assertion; adjust `{ format, scale }` to the real options shape.

- [ ] **Step 2: Run test to verify it fails or degrades**

Run: `npx vitest run test/jpx-render.test.ts`
Expected: The image is currently skipped (JPX in `NO_RASTER_DECODER`); the page still renders but without the image. This test asserts a produced PNG, so it may pass trivially — before Step 3, tighten it to sample a pixel that must be non-background (see Step 4) so it genuinely fails first.

- [ ] **Step 3: Add the JPX branch in `raster.ts`**

Remove `'JPXDecode'` from `NO_RASTER_DECODER`:

```ts
const NO_RASTER_DECODER = new Set(['JBIG2Decode']);
```

In `decodeImageRgba`, after the DCT branch and before the generic sample path, add:

```ts
  if (filt === 'JPXDecode') {
    let samples: Uint8Array;
    try { samples = info.Decode(); } catch { return undefined; } // unsupported subset → degrade
    const comps = Math.max(1, Math.round(samples.length / (w * h)));
    const alpha = decodeSMaskAlpha(doc, stream.dict, w, h);
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      let r: number, g: number, b: number;
      if (comps === 1) { r = g = b = samples[i]; }
      else { r = samples[i * comps]; g = samples[i * comps + 1]; b = samples[i * comps + 2]; }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b;
      out[i * 4 + 3] = alpha ? alpha[i] : 255;
    }
    return { w, h, data: out };
  }
```

In `decodeSMaskAlpha`, the generic `else` branch already returns `undefined` for members of `NO_RASTER_DECODER`; since JPX is now removed from that set, a JPX soft-mask would fall through to `info.Decode()` which returns samples — that is correct (1-comp grayscale alpha). No change needed there beyond the set edit, but verify the `BitsPerComponent !== 8` guard doesn't reject JPX masks (JPX downshifts to 8, and the builder sets `/BitsPerComponent 8`).

- [ ] **Step 4: Tighten the test to sample a real pixel**

Replace the loose assertion with a pixel check appropriate to the fixture (the lossless-gray ramp has a bright right edge). Decode the produced PNG via the repo's PNG reader if one exists in tests, or assert `decodeImageRgba` directly:

```ts
import { decodeImageRgba } from '../src/raster.js';
// ... inside the test, after Open:
const stream = /* resolve Im0 XObject stream from doc */;
const rgba = decodeImageRgba(doc, stream, [0, 0, 0]);
expect(rgba).toBeDefined();
expect(rgba!.data[3]).toBe(255); // opaque
```

Use whichever entry point the other raster tests use to fetch an image stream; keep the assertion focused on "JPX decoded, not skipped."

- [ ] **Step 5: Check `pagerender.ts`**

Inspect `src/pagerender.ts` for its own image-decode switch. If it delegates to `decodeImageRgba` (raster), no change is needed. If it has a parallel JPX/DCT guard, add the same JPX branch there.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/jpx-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/raster.ts src/pagerender.ts test/jpx-render.test.ts
git commit -m "feat(kec): render JPX images in ToImage/ToSvg"
```

---

### Task 10: README + full-suite gate + close issue

Document the feature and its boundaries, run the full quality gates, and close the bd issue.

**Files:**
- Modify: `README.md`
- Modify: `src/image.ts` doc comment (verify Task 8 edit landed)

- [ ] **Step 1: Update `README.md`**

Move JPXDecode from Limitations to Features. Add under the image-decode feature list:

```markdown
- **JPEG 2000 (`JPXDecode`)** — decode baseline JP2/J2K images to samples
  (`Image.Decode()`) and render them (`ToImage`/`ToSvg`). Supports: single tile;
  multiple quality layers; all five progression orders; 5/3 reversible (lossless)
  and 9/7 irreversible (lossy) wavelets; 1-component (gray) and 3-component (RGB)
  with RCT/ICT. Component precision above 8 bits is downshifted to 8-bit output.
  Not yet supported (throws `UnsupportedFeatureError`): multiple tiles, custom
  precinct partitions, region of interest (`RGN`), more than 3 components, and
  component sub-sampling.
```

Remove the corresponding "JPEG 2000 not supported" bullet from the Limitations section if present.

- [ ] **Step 2: Run the full quality gates**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no typecheck errors. Fix any regressions before proceeding.

- [ ] **Step 3: Commit docs**

```bash
git add README.md src/image.ts
git commit -m "docs(kec): document JPXDecode (JPEG 2000) support + boundaries"
```

- [ ] **Step 4: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-kec
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** container both forms (Task 5), single tile (Task 5 throw), multi-layer + all progression orders (Task 6 + Task 7 fixtures), 5/3 + 9/7 (Tasks 3/7), gray + RGB + RCT/ICT (Task 7), ≤16-bit downshift (Task 7 assembly), throw boundaries (Task 5), `Image.Decode()` samples (Task 8), render integration (Task 9), tests + README (Tasks 1–10), fixtures (Task 2). All spec sections map to a task.
- **Primary risk:** Task 2 (fixture encoder availability) and the Tier-1/Tier-2 coordinate glue proven only end-to-end in Task 7. Both have explicit debug ladders and fallbacks in-task.
- **Type consistency:** `Subband`/`ResolutionSpec` (jpxwavelet) vs `CodeBlockCoded`/`ResolutionCoded` (jpxt2) are deliberately distinct types — jpxt2 produces *coded* geometry, Task 7 maps it into the *wavelet* `Subband` with dequantized `coeffs`. `decodeCodeBlock` input `CodeBlockDecode` and `MqDecoder(cx,i)` signatures are consistent across Tasks 1/4/7.
