# ICC CMYK Transform (`85l8.7.2`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real `CmykTransform` from an ICC destination profile's `B2A` tag, so `ConvertColors({ to: 'cmyk' })` can produce colour-managed ink instead of naive maximum-black removal.

**Architecture:** Two new pure leaves on top of `85l8.7.1`'s `src/icc.ts`. `src/icclut.ts` reads and evaluates a `mft2`/`mft1` LUT pipeline (curves → matrix → CLUT → curves). `src/icctransform.ts` composes sRGB → PCS → CMYK and exposes `iccCmykTransform`. `85l8.3` already threads a `CmykTransform` to every leg of the colour walk, so **no plumbing changes**.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies. Fixture generation uses Node + Windows PowerShell, and is not run by `npm test`.

**Spec:** `docs/superpowers/specs/2026-09-04-icc-cmyk-transform-design.md`

## Global Constraints

- **Zero runtime dependencies.** `src/icclut.ts` and `src/icctransform.ts` import only from `./icc.js`, `./errors.js` and `./colorrule.js` (for the `CmykTransform` type).
- **ESM + NodeNext:** every import specifier carries the `.js` extension.
- **Pure leaves:** no `Document`, no `Page`, no PDF object module, no `node:` import in either new `src/` file.
- **All integers are big-endian.**
- **Errors:** `PdfParseError` for a malformed profile; `UnsupportedFeatureError` for one we decline (v4, absolute colorimetric, no `B2A`, non-CMYK). Both thrown from the **factory**, before any conversion, so a refused profile leaves the document byte-identical.
- **Trilinear** CLUT interpolation, stated in the source as the choice whose arithmetic reads off the spec.
- Run `npm run typecheck` and the named test file before each commit; both must be green.

### Facts measured during the spike — do not re-derive

- ICC requires an N-component LUT-based **output** profile to carry `A2B0`, `A2B1`, `A2B2`, `B2A0`, `B2A1`, `B2A2` **and** `gamt`, besides `desc`, `cprt` and `wtpt`. WCS enforces it: with only `A2B0` + `B2A0` it reports `ERROR_INVALID_PROFILE` (2011) and refuses to build a transform. The fixture must carry all ten tags.
- `RSWOP.icm` and our fixture both use **`mft2`**. `RSWOP`'s `B2A0` is 3-in/4-out at grid 17.
- ⚠️ **This bullet was WRONG and the implementation corrected it.** It claimed
  WCS feeds the `B2A` input tables the legacy v2 encoding with L\* 100 at
  `0xFF00`, citing a spike measurement of 0.4984 for white. The spike actually
  printed `0.5000`, which inverts to an encoded **1.0**; I misread it and
  reasoned backwards. What is true, solved from the goldens: **L\* 100 arrives
  at the FULL input range**, while **a\*/b\* use the legacy `(v + 128) × 256`
  over 0..0xFFFF**, so a\* 0 sits at `0x8000`. See `src/icctransform.ts`, and
  Task 3's note below, which was right that this was the plan's one unmeasured
  reading — but wrong about which half.

---

### Task 1: Read a LUT tag

**Files:**
- Create: `src/icclut.ts`
- Test: `test/icclut.test.ts`

**Interfaces:**
- Consumes: `IccProfile`, `IccTag`, `sig`-style readers from `src/icc.ts` (Task 1 adds the two exports it needs).
- Produces:
  ```ts
  export interface IccLut {
    inputChannels: number;
    outputChannels: number;
    /** CLUT grid points per input dimension. */
    grid: number;
    /** Row-major 3x3; the identity for a Lab PCS. */
    matrix: readonly number[];
    /** One table per input channel, values 0..1. */
    inputTables: readonly Float64Array[];
    /** grid**inputChannels entries of outputChannels values, 0..1, first input
     *  channel varying SLOWEST. */
    clut: Float64Array;
    /** One table per output channel, values 0..1. */
    outputTables: readonly Float64Array[];
  }
  export function readLutTag(p: IccProfile, tag: IccTag): IccLut
  ```

- [ ] **Step 1: Export the two helpers `icclut.ts` needs from `src/icc.ts`**

`src/icc.ts` currently keeps `u32` and `sig` module-private. Change their declarations to be exported, adding this comment above `sig`:

```ts
/** Exported for `icclut.ts`, which reads tag data this module deliberately
 *  does not interpret. Both stay internal to the library — neither is
 *  re-exported from `index.ts`. */
```

Run `npm run typecheck`. Expected: clean.

- [ ] **Step 2: Write the failing test**

Create `test/icclut.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIccProfile, iccTag } from '../src/icc.js';
import { readLutTag } from '../src/icclut.js';
import { PdfParseError } from '../src/errors.js';
import { readFileSync } from 'node:fs';

const fixture = (): Uint8Array =>
  new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));

/**
 * `mft2` / `mft1`, the LUT pipeline a `B2A` tag is built from (85l8.7.2).
 *
 * The fixture is a profile we AUTHORED — `RSWOP.icm` is Microsoft-copyrighted
 * and cannot be vendored, and unlike a golden table our engine needs profile
 * bytes at test time. See `test/fixtures/icc/PROVENANCE.md`.
 */
describe('readLutTag', () => {
  const p = parseIccProfile(fixture());
  const b2a = () => {
    const t = iccTag(p, 'B2A0');
    if (!t) throw new Error('no B2A0');
    return readLutTag(p, t);
  };

  it('reads the channel counts and grid size', () => {
    const lut = b2a();
    expect(lut.inputChannels).toBe(3);    // Lab
    expect(lut.outputChannels).toBe(4);   // CMYK
    expect(lut.grid).toBe(2);
  });

  it('reads the identity matrix a Lab PCS requires', () => {
    expect([...b2a().matrix]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  // One table per channel, and the CLUT sized grid**inputChannels *
  // outputChannels. Getting the CLUT length wrong reads output-table data as
  // colour, which produces a plausible wrong picture rather than an error.
  it('sizes the tables and the CLUT from the header fields', () => {
    const lut = b2a();
    expect(lut.inputTables).toHaveLength(3);
    expect(lut.outputTables).toHaveLength(4);
    expect(lut.clut).toHaveLength(2 ** 3 * 4);
  });

  it('normalises table and CLUT entries to 0..1', () => {
    const lut = b2a();
    for (const v of lut.clut) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  /**
   * The CLUT's first input channel varies SLOWEST, so entry 0 is the corner
   * where every input is 0. Our fixture's affine rule there is
   * C = 0.10, M = 0.20, Y = 0.30, K = 0.05.
   */
  it('lays the CLUT out with the first input varying slowest', () => {
    const lut = b2a();
    expect(lut.clut[0]).toBeCloseTo(0.10, 4);
    expect(lut.clut[1]).toBeCloseTo(0.20, 4);
    expect(lut.clut[2]).toBeCloseTo(0.30, 4);
    expect(lut.clut[3]).toBeCloseTo(0.05, 4);
  });

  it('refuses a tag that is not a LUT type', () => {
    const t = iccTag(p, 'wtpt');
    if (!t) throw new Error('no wtpt');
    expect(() => readLutTag(p, t)).toThrow(PdfParseError);
  });

  it('refuses a LUT whose declared sizes do not fit its tag', () => {
    const bytes = fixture();
    const t = iccTag(p, 'B2A0');
    if (!t) throw new Error('no B2A0');
    bytes[t.offset + 10] = 200;   // grid 200 needs 200^3 * 4 * 2 bytes
    const q = parseIccProfile(bytes);
    const t2 = iccTag(q, 'B2A0');
    if (!t2) throw new Error('no B2A0');
    expect(() => readLutTag(q, t2)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/icclut.test.ts`
Expected: FAIL — `Failed to resolve import "../src/icclut.js"`. (The fixture file does not exist yet either; Task 5 creates it. Run Task 5 first if you prefer a clean red — see the note at the head of Task 5.)

- [ ] **Step 4: Write the minimal implementation**

Create `src/icclut.ts`:

```ts
import { PdfParseError } from './errors.js';
import { sig, u32, type IccProfile, type IccTag } from './icc.js';

/**
 * The LUT pipeline an ICC `A2B`/`B2A` tag describes (85l8.7.2).
 *
 * A pure leaf over `icc.ts` — it reads tag data and evaluates it, and knows
 * nothing of colour spaces, rendering intents or PDF. `icctransform.ts`
 * composes it into an RGB→CMYK transform.
 *
 * Two tag types share one shape: `mft2` (lut16Type) holds 16-bit tables and
 * states their lengths, while `mft1` (lut8Type) holds 8-bit tables of exactly
 * 256 entries and states no lengths at all. Assuming 256 for an `mft2` reads
 * its CLUT as curve data — a plausible wrong picture rather than an error.
 */
export interface IccLut {
  inputChannels: number;
  outputChannels: number;
  /** CLUT grid points per input dimension. */
  grid: number;
  /** Row-major 3x3. The identity for a Lab PCS, which is where it is ignored. */
  matrix: readonly number[];
  /** One table per input channel, values 0..1. */
  inputTables: readonly Float64Array[];
  /** `grid ** inputChannels` entries of `outputChannels` values, 0..1, with
   *  the FIRST input channel varying SLOWEST. */
  clut: Float64Array;
  /** One table per output channel, values 0..1. */
  outputTables: readonly Float64Array[];
}

const u16 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) << 8) | (b[o + 1] as number);

/** A signed 16.16 fixed-point number. */
const s15Fixed16 = (b: Uint8Array, o: number): number =>
  (((b[o] as number) << 24 | (b[o + 1] as number) << 16
    | (b[o + 2] as number) << 8 | (b[o + 3] as number))) / 65536;

export function readLutTag(p: IccProfile, tag: IccTag): IccLut {
  const b = p.bytes;
  const type = sig(b, tag.offset);
  if (type !== 'mft2' && type !== 'mft1') {
    throw new PdfParseError(
      `ICC tag ${JSON.stringify(tag.signature)} is type ${JSON.stringify(type)}, `
      + 'expected "mft2" or "mft1"');
  }
  const wide = type === 'mft2';
  // 4 type, 4 reserved, then i/o/grid/pad, then the 3x3 matrix.
  const inputChannels = b[tag.offset + 8] as number;
  const outputChannels = b[tag.offset + 9] as number;
  const grid = b[tag.offset + 10] as number;
  if (inputChannels === 0 || outputChannels === 0 || grid < 2) {
    throw new PdfParseError(
      `ICC LUT has ${inputChannels} inputs, ${outputChannels} outputs, grid ${grid}`);
  }
  const matrix: number[] = [];
  for (let i = 0; i < 9; i++) matrix.push(s15Fixed16(b, tag.offset + 12 + i * 4));

  // `mft2` STATES its table lengths; `mft1` has no such fields and is fixed at
  // 256 entries. Reading an mft2 as 256 entries walks into its CLUT.
  let cursor = tag.offset + 48;
  let nIn = 256;
  let nOut = 256;
  if (wide) {
    nIn = u16(b, cursor);
    nOut = u16(b, cursor + 2);
    cursor += 4;
    if (nIn < 2 || nOut < 2) {
      throw new PdfParseError(`ICC mft2 declares ${nIn}/${nOut} table entries`);
    }
  }

  const step = wide ? 2 : 1;
  const scale = wide ? 65535 : 255;
  const read = (o: number): number => (wide ? u16(b, o) : (b[o] as number)) / scale;

  const need = (inputChannels * nIn + grid ** inputChannels * outputChannels
    + outputChannels * nOut) * step;
  const end = tag.offset + tag.size;
  if (cursor + need > end) {
    throw new PdfParseError(
      `ICC LUT needs ${need} bytes of table data but its tag has `
      + `${end - cursor} left`);
  }

  const inputTables: Float64Array[] = [];
  for (let c = 0; c < inputChannels; c++) {
    const t = new Float64Array(nIn);
    for (let i = 0; i < nIn; i++) t[i] = read(cursor + (c * nIn + i) * step);
    inputTables.push(t);
  }
  cursor += inputChannels * nIn * step;

  const clutEntries = grid ** inputChannels * outputChannels;
  const clut = new Float64Array(clutEntries);
  for (let i = 0; i < clutEntries; i++) clut[i] = read(cursor + i * step);
  cursor += clutEntries * step;

  const outputTables: Float64Array[] = [];
  for (let c = 0; c < outputChannels; c++) {
    const t = new Float64Array(nOut);
    for (let i = 0; i < nOut; i++) t[i] = read(cursor + (c * nOut + i) * step);
    outputTables.push(t);
  }

  return { inputChannels, outputChannels, grid, matrix, inputTables, clut, outputTables };
}
```

Note `u32` is imported but not yet used; remove it from the import if `strict` complains, and re-add it in Task 2 only if needed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/icclut.test.ts`
Expected: PASS, 7 tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/icc.ts src/icclut.ts test/icclut.test.ts
git commit -m "feat(85l8.7.2): read an ICC mft2/mft1 LUT tag

mft2 STATES its table lengths where mft1 is fixed at 256 entries; assuming
256 for an mft2 reads its CLUT as curve data, which is a plausible wrong
picture rather than an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Evaluate a LUT

**Files:**
- Modify: `src/icclut.ts`
- Test: `test/icclut.test.ts`

**Interfaces:**
- Consumes: `IccLut` from Task 1.
- Produces:
  ```ts
  export function evalLut(lut: IccLut, inputs: readonly number[]): number[]
  ```
  Inputs and outputs are 0..1, inputs clamped.

- [ ] **Step 1: Write the failing test**

Append to `test/icclut.test.ts`:

```ts
import { evalLut } from '../src/icclut.js';

/**
 * Evaluating the pipeline: input curves, then the CLUT, then output curves.
 *
 * Every expectation here is computed from the fixture's own affine rule
 * — C = 0.10 + 0.40·l, M = 0.20 + 0.30·a, Y = 0.30 + 0.20·b, K = 0.05 + 0.10·l
 * — rather than recorded from a run, so a wrong answer is caught by
 * arithmetic rather than by a snapshot nobody can check.
 */
describe('evalLut', () => {
  const p = parseIccProfile(fixture());
  const lut = (() => {
    const t = iccTag(p, 'B2A0');
    if (!t) throw new Error('no B2A0');
    return readLutTag(p, t);
  })();

  it('returns one value per output channel', () => {
    expect(evalLut(lut, [0, 0, 0])).toHaveLength(4);
  });

  it('reproduces the CLUT corners exactly', () => {
    expect(evalLut(lut, [0, 0, 0])[0]).toBeCloseTo(0.10, 4);
    expect(evalLut(lut, [1, 0, 0])[0]).toBeCloseTo(0.50, 4);
    expect(evalLut(lut, [0, 1, 0])[1]).toBeCloseTo(0.50, 4);
    expect(evalLut(lut, [0, 0, 1])[2]).toBeCloseTo(0.50, 4);
  });

  // The affine rule evaluated between corners. With an affine CLUT this is
  // exact under trilinear interpolation — which is the whole reason the
  // fixture is affine.
  it('interpolates between corners', () => {
    const out = evalLut(lut, [0.5, 0.25, 0.75]);
    expect(out[0]).toBeCloseTo(0.10 + 0.40 * 0.5, 4);
    expect(out[1]).toBeCloseTo(0.20 + 0.30 * 0.25, 4);
    expect(out[2]).toBeCloseTo(0.30 + 0.20 * 0.75, 4);
    expect(out[3]).toBeCloseTo(0.05 + 0.10 * 0.5, 4);
  });

  // Each output depends on ONE input in this fixture, which is what makes a
  // transposed CLUT walk visible: read the axes in the wrong order and
  // changing `a` moves C rather than M.
  it('maps each input axis to the output the fixture ties it to', () => {
    const base = evalLut(lut, [0, 0, 0]);
    const movedA = evalLut(lut, [0, 1, 0]);
    expect(movedA[0]).toBeCloseTo(base[0] as number, 4);   // C unmoved by a
    expect(movedA[1]).not.toBeCloseTo(base[1] as number, 2);
  });

  it('clamps an input outside 0..1', () => {
    expect(evalLut(lut, [-1, 0, 0])[0]).toBeCloseTo(0.10, 4);
    expect(evalLut(lut, [2, 0, 0])[0]).toBeCloseTo(0.50, 4);
  });

  it('refuses a wrong number of inputs', () => {
    expect(() => evalLut(lut, [0, 0])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icclut.test.ts`
Expected: FAIL — `evalLut is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/icclut.ts`:

```ts
/** Sample a table at `x` in 0..1, interpolating between entries. */
function sampleTable(t: Float64Array, x: number): number {
  if (t.length === 0) return x;
  if (t.length === 1) return t[0] as number;
  const pos = x * (t.length - 1);
  const i = Math.floor(pos);
  if (i >= t.length - 1) return t[t.length - 1] as number;
  const lo = t[i] as number;
  return lo + ((t[i + 1] as number) - lo) * (pos - i);
}

/**
 * Evaluate the pipeline: input curves, CLUT, output curves.
 *
 * The CLUT is interpolated TRILINEARLY (multilinearly, for any input count):
 * the arithmetic reads straight off the spec, where tetrahedral interpolation
 * — which littlecms and probably WCS use — is a different subdivision that
 * agrees with it only for an AFFINE CLUT. `test/fixtures/icc/`'s profile is
 * affine precisely so the two coincide and the goldens admit no tolerance.
 *
 * The 3x3 matrix is deliberately NOT applied. ICC allows it only for an XYZ
 * PCS, and it is the identity in every profile this library reads; applying it
 * unconditionally would be a no-op there and wrong nowhere we can test, so it
 * is left to `icctransform.ts` to reject a profile that states a real one.
 */
export function evalLut(lut: IccLut, inputs: readonly number[]): number[] {
  if (inputs.length !== lut.inputChannels) {
    throw new RangeError(
      `ICC LUT takes ${lut.inputChannels} inputs, given ${inputs.length}`);
  }
  const { grid, outputChannels, clut } = lut;

  // Input curves, then the position in grid coordinates.
  const pos: number[] = [];
  for (let c = 0; c < inputs.length; c++) {
    const raw = inputs[c] as number;
    const v = sampleTable(lut.inputTables[c] as Float64Array,
      raw < 0 ? 0 : raw > 1 ? 1 : raw);
    pos.push((v < 0 ? 0 : v > 1 ? 1 : v) * (grid - 1));
  }

  // Multilinear interpolation over the 2**n corners of the enclosing cell.
  const base: number[] = [];
  const frac: number[] = [];
  for (const q of pos) {
    const i = Math.min(Math.floor(q), grid - 2);
    base.push(i);
    frac.push(q - i);
  }
  const out = new Array<number>(outputChannels).fill(0);
  const corners = 1 << inputs.length;
  for (let mask = 0; mask < corners; mask++) {
    let weight = 1;
    let index = 0;
    for (let c = 0; c < inputs.length; c++) {
      const hi = (mask >> c) & 1;
      weight *= hi ? (frac[c] as number) : 1 - (frac[c] as number);
      // The FIRST input channel varies SLOWEST, so its stride is the largest.
      index = index * grid + ((base[c] as number) + hi);
    }
    if (weight === 0) continue;
    const o = index * outputChannels;
    for (let k = 0; k < outputChannels; k++) {
      out[k] = (out[k] as number) + weight * (clut[o + k] as number);
    }
  }

  // Output curves.
  for (let k = 0; k < outputChannels; k++) {
    out[k] = sampleTable(lut.outputTables[k] as Float64Array, out[k] as number);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icclut.test.ts`
Expected: PASS, 13 tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Verify the CLUT stride is load-bearing**

Temporarily reverse the stride by changing the index line to
`index = index + ((base[c] as number) + hi) * grid ** c;`, then run:

`npx vitest run test/icclut.test.ts`

Expected: "maps each input axis to the output the fixture ties it to" goes RED. Restore and confirm green. This is the mutation the fixture's one-input-per-output design exists to catch.

- [ ] **Step 6: Commit**

```bash
git add src/icclut.ts test/icclut.test.ts
git commit -m "feat(85l8.7.2): evaluate an ICC LUT pipeline

Trilinear rather than tetrahedral, stated in the source: the arithmetic reads
off the spec, and the fixture is affine precisely so the two coincide and the
goldens admit no tolerance.

The first input channel varies SLOWEST. Measured: reversing the stride reddens
the axis case, which the fixture's one-input-per-output design exists to catch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: sRGB to the PCS

**Files:**
- Create: `src/icctransform.ts`
- Test: `test/icctransform.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** sRGB 0..1 to D50-adapted CIE XYZ. */
  export function srgbToXyzD50(r: number, g: number, b: number): [number, number, number]
  /** D50 XYZ to CIE L*a*b*. L in 0..100, a and b in roughly -128..127. */
  export function xyzToLab(x: number, y: number, z: number): [number, number, number]
  /** L*a*b* to the legacy v2 16-bit encoding, as 0..1 fractions of full scale. */
  export function labToV2(l: number, a: number, b: number): [number, number, number]
  ```

- [ ] **Step 1: Write the failing test**

Create `test/icctransform.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { srgbToXyzD50, xyzToLab, labToV2 } from '../src/icctransform.js';

/**
 * The source leg: sRGB to the profile connection space (85l8.7.2).
 *
 * sRGB is defined by a specification rather than by a file, so this leg is
 * written out rather than parsed from `srgb.ts` — which keeps the whole
 * feature dependent on exactly one profile, the caller's destination.
 *
 * Every expectation is a published value, not one recorded from our own run.
 */
describe('srgbToXyzD50', () => {
  // White must land on the D50 illuminant, which is what "D50-adapted" means.
  it('maps white to the D50 illuminant', () => {
    const [x, y, z] = srgbToXyzD50(1, 1, 1);
    expect(x).toBeCloseTo(0.9642, 3);
    expect(y).toBeCloseTo(1.0000, 3);
    expect(z).toBeCloseTo(0.8249, 3);
  });

  it('maps black to zero', () => {
    expect(srgbToXyzD50(0, 0, 0)).toEqual([0, 0, 0]);
  });

  /**
   * The sRGB transfer function is a linear segment below 0.04045 and a
   * 2.4 power above it — NOT a plain 2.2 gamma. The two differ most in the
   * shadows, so mid grey is where a plain-gamma implementation looks nearly
   * right: sRGB 128/255 has L* 53.6, and a 2.2 gamma gives 53.0.
   */
  it('uses the piecewise transfer function, not a plain 2.2 gamma', () => {
    const [, y] = srgbToXyzD50(128 / 255, 128 / 255, 128 / 255);
    const [l] = xyzToLab(0, y, 0);
    expect(l).toBeCloseTo(53.6, 1);
  });
});

describe('xyzToLab', () => {
  it('maps the D50 white to L* 100', () => {
    const [l, a, b] = xyzToLab(0.9642, 1.0, 0.8249);
    expect(l).toBeCloseTo(100, 2);
    expect(a).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it('maps zero to L* 0', () => {
    expect(xyzToLab(0, 0, 0)[0]).toBeCloseTo(0, 6);
  });
});

/**
 * The v2 16-bit Lab encoding, and it is NOT v4's. L* 100 is 0xFF00 in v2 and
 * 0xFFFF in v4; a and b are offset by 128 in both. Using the v4 scaling on a
 * v2 table is a 0.4% error on L — a plausible slightly-light image rather
 * than an obvious fault.
 *
 * Measured against Windows Color System during the spike: white through an
 * affine CLUT `C = 0.10 + 0.40·l` came back 0.4984, which is
 * `0.10 + 0.40 × 65280/65535` — the 0xFF00 convention, not 0xFFFF.
 */
describe('labToV2', () => {
  it('encodes L* 100 as 0xFF00 of full scale', () => {
    expect(labToV2(100, 0, 0)[0]).toBeCloseTo(65280 / 65535, 6);
  });

  it('encodes L* 0 as zero', () => {
    expect(labToV2(0, 0, 0)[0]).toBe(0);
  });

  it('encodes a* and b* 0 at the half-scale offset', () => {
    const [, a, b] = labToV2(50, 0, 0);
    expect(a).toBeCloseTo(32768 / 65535, 6);
    expect(b).toBeCloseTo(32768 / 65535, 6);
  });

  it('clamps an out-of-range value into the encoding', () => {
    expect(labToV2(200, 0, 0)[0]).toBeLessThanOrEqual(1);
    expect(labToV2(-50, 0, 0)[0]).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icctransform.test.ts`
Expected: FAIL — `Failed to resolve import "../src/icctransform.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/icctransform.ts`:

```ts
/**
 * sRGB → PCS → CMYK through an ICC destination profile (85l8.7.2).
 *
 * A pure leaf over `icc.ts`, `icclut.ts` and `errors.js`. It builds a
 * `CmykTransform` — `85l8.3`'s seam — so nothing in the colour walk changes.
 *
 * The SOURCE leg is written out rather than parsed: sRGB is defined by a
 * specification rather than by a file, so hard-coding its transfer function
 * and matrix keeps the whole feature dependent on exactly one profile, the
 * caller's destination.
 */

/** The sRGB → XYZ matrix already Bradford-adapted to D50 (IEC 61966-2.1 with
 *  the adaptation ICC mandates for the PCS). Rows are X, Y, Z. */
const SRGB_TO_XYZ_D50: readonly (readonly number[])[] = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];

/** D50, the ICC profile connection space illuminant. */
const D50: readonly [number, number, number] = [0.9642, 1.0, 0.8249];

/** The sRGB transfer function: a linear segment in the shadows and a 2.4
 *  power above it. NOT a plain 2.2 gamma — the two differ most exactly where
 *  a plain gamma looks nearly right. */
function srgbToLinear(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB 0..1 to D50-adapted CIE XYZ. */
export function srgbToXyzD50(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const m = SRGB_TO_XYZ_D50;
  return [
    (m[0]![0] as number) * lr + (m[0]![1] as number) * lg + (m[0]![2] as number) * lb,
    (m[1]![0] as number) * lr + (m[1]![1] as number) * lg + (m[1]![2] as number) * lb,
    (m[2]![0] as number) * lr + (m[2]![1] as number) * lg + (m[2]![2] as number) * lb,
  ];
}

const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

const labF = (t: number): number =>
  (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);

/** D50 XYZ to CIE L*a*b*. */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / (D50[0] as number));
  const fy = labF(y / (D50[1] as number));
  const fz = labF(z / (D50[2] as number));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * L*a*b* to the LEGACY v2 16-bit encoding, as 0..1 fractions of full scale.
 *
 * v2 puts L* 100 at 0xFF00 where v4 puts it at 0xFFFF; a* and b* carry a +128
 * offset in both. Using v4's scaling on a v2 table is a 0.4% error on L — a
 * plausible slightly-light image. Measured against Windows Color System: white
 * through an affine CLUT came back at exactly the 0xFF00 convention.
 */
export function labToV2(l: number, a: number, b: number): [number, number, number] {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  return [
    clamp((l / 100) * 65280 / 65535),
    clamp((a + 128) / 255 * 65280 / 65535 + 0),
    clamp((b + 128) / 255 * 65280 / 65535 + 0),
  ];
}
```

> **Note for the implementer:** the a\*/b\* line above is the plan's best
> reading and is the one thing here not yet measured. The test asserts
> `a* 0 → 32768/65535`. If that assertion fails, the encoding is
> `(a + 128) / 255` scaled to `0xFFFF` rather than `0xFF00`; adjust the
> implementation to satisfy the test, and record which reading won in a
> comment. Do **not** adjust the test to match the code.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icctransform.test.ts`
Expected: PASS, 9 tests. If the a\*/b\* case fails, follow the note above.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Verify the transfer function is load-bearing**

Temporarily replace `srgbToLinear`'s body with `return Math.pow(c, 2.2);`, then run:

`npx vitest run test/icctransform.test.ts`

Expected: "uses the piecewise transfer function, not a plain 2.2 gamma" goes RED (it reports about 53.0 where 53.6 is right). Restore and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/icctransform.ts test/icctransform.test.ts
git commit -m "feat(85l8.7.2): sRGB to the ICC profile connection space

The source leg is written out rather than parsed from srgb.ts: sRGB is defined
by a specification rather than by a file, which keeps the feature dependent on
exactly one profile -- the caller's destination.

Two rules that render plausibly when wrong: the transfer function is piecewise
rather than a 2.2 gamma (measured, mid grey is L* 53.6 against 53.0), and the
v2 Lab encoding puts L* 100 at 0xFF00 where v4 puts it at 0xFFFF.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `iccCmykTransform`

**Files:**
- Modify: `src/icctransform.ts`
- Test: `test/icctransform.test.ts`

**Interfaces:**
- Consumes: `parseIccProfile`, `iccTag` from `src/icc.ts`; `readLutTag`, `evalLut` from `src/icclut.ts`; `CmykTransform` from `src/colorrule.js`.
- Produces:
  ```ts
  export interface IccTransformOptions {
    /** 0 perceptual (default), 1 media-relative, 2 saturation. */
    intent?: 0 | 1 | 2;
  }
  export function iccCmykTransform(
    profile: Uint8Array, opts?: IccTransformOptions,
  ): CmykTransform
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/icctransform.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { iccCmykTransform } from '../src/icctransform.js';
import { srgbIcc } from '../src/srgb.js';
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';

const fixture = (): Uint8Array =>
  new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));

/**
 * The whole composition, against the fixture's own affine rule:
 *   C = 0.10 + 0.40·l, M = 0.20 + 0.30·a, Y = 0.30 + 0.20·b, K = 0.05 + 0.10·l
 * with l, a, b the v2-encoded Lab fractions. Every expectation is arithmetic
 * rather than a recorded number.
 */
describe('iccCmykTransform', () => {
  it('transforms black through the profile', () => {
    const t = iccCmykTransform(fixture());
    const [c, m, y, k] = t(0, 0, 0);
    expect(c).toBeCloseTo(0.10, 3);
    expect(m).toBeCloseTo(0.35, 3);
    expect(y).toBeCloseTo(0.40, 3);
    expect(k).toBeCloseTo(0.05, 3);
  });

  it('transforms white through the profile', () => {
    const t = iccCmykTransform(fixture());
    const [c, , , k] = t(1, 1, 1);
    // l = 65280/65535 at L* 100.
    expect(c).toBeCloseTo(0.10 + 0.40 * (65280 / 65535), 3);
    expect(k).toBeCloseTo(0.05 + 0.10 * (65280 / 65535), 3);
  });

  // The value this whole feature exists for: a mid grey inks all four
  // channels, where the naive rgbToCmyk leaves three empty.
  it('inks a mid grey through the profile rather than leaving it to K', () => {
    const t = iccCmykTransform(fixture());
    const [c, m, y, k] = t(128 / 255, 128 / 255, 128 / 255);
    // L* 53.6 -> l = 0.536 * 65280/65535
    expect(c).toBeCloseTo(0.10 + 0.40 * 0.536 * (65280 / 65535), 2);
    expect(m).toBeCloseTo(0.35, 2);
    expect(y).toBeCloseTo(0.40, 2);
    expect(k).toBeCloseTo(0.05 + 0.10 * 0.536 * (65280 / 65535), 2);
  });

  it('returns four numbers in 0..1 for every corner of the cube', () => {
    const t = iccCmykTransform(fixture());
    for (const [r, g, b] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]) {
      const out = t(r as number, g as number, b as number);
      expect(out).toHaveLength(4);
      for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('selects the tag the intent names', () => {
    // Our fixture's three B2A tags hold identical data, so this asserts only
    // that a stated intent is accepted and resolves to a tag.
    expect(() => iccCmykTransform(fixture(), { intent: 1 })).not.toThrow();
    expect(() => iccCmykTransform(fixture(), { intent: 2 })).not.toThrow();
  });
});

/**
 * Every refusal happens in the FACTORY, before any conversion — so a profile
 * we decline leaves the document byte-identical, which is the rule
 * `checkTarget` and `checkTransform` already follow.
 */
describe('iccCmykTransform — refusals', () => {
  it('refuses a profile whose device space is not CMYK', () => {
    expect(() => iccCmykTransform(srgbIcc())).toThrow(UnsupportedFeatureError);
  });

  it('refuses bytes that are not a profile at all', () => {
    expect(() => iccCmykTransform(new Uint8Array(200))).toThrow(PdfParseError);
  });

  it('refuses absolute colorimetric, which has no B2A tag of its own', () => {
    expect(() => iccCmykTransform(fixture(), { intent: 3 as 0 }))
      .toThrow(UnsupportedFeatureError);
  });

  /**
   * A v4 profile is DECLINED, not mis-read. Its `B2A` is an `mBA ` lutBtoAType
   * with a different element order, so reading it as an `mft2` would produce
   * confident nonsense. Only the header version is changed here — enough to
   * reach the version check, which runs first.
   */
  it('refuses a v4 profile rather than reading its tags as v2', () => {
    const v4 = fixture();
    v4[8] = 4;
    expect(() => iccCmykTransform(v4)).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icctransform.test.ts`
Expected: FAIL — `iccCmykTransform is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/icctransform.ts` (and add the imports it needs at the top of the file):

```ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { parseIccProfile, iccTag } from './icc.js';
import { readLutTag, evalLut } from './icclut.js';
import type { CmykTransform } from './colorrule.js';

export interface IccTransformOptions {
  /** 0 perceptual (default), 1 media-relative colorimetric, 2 saturation. */
  intent?: 0 | 1 | 2;
}

/**
 * Build a `CmykTransform` from an ICC destination profile.
 *
 * Every refusal happens HERE, before any colour is converted, so a profile we
 * decline leaves the document byte-identical — `checkTarget`'s rule.
 *
 * What is declined rather than guessed at: a v4 profile (its `B2A` is an
 * `mBA ` with a different element order, and reading it as an `mft2` would
 * produce confident nonsense), absolute colorimetric (it is relative plus a
 * white-point adaptation and has no `B2A` tag of its own), a profile whose
 * device space is not CMYK, and one carrying no `B2A` tag at all.
 */
export function iccCmykTransform(
  profile: Uint8Array, opts: IccTransformOptions = {},
): CmykTransform {
  const p = parseIccProfile(profile);
  if (p.header.version.major >= 4) {
    throw new UnsupportedFeatureError(
      `ICC profile is version ${p.header.version.major}; only version 2 `
      + 'profiles are supported (a v4 B2A is an "mBA " with a different '
      + 'element order)');
  }
  if (p.header.dataColorSpace !== 'CMYK') {
    throw new UnsupportedFeatureError(
      `ICC profile device space is ${JSON.stringify(p.header.dataColorSpace)}, `
      + 'expected "CMYK"');
  }
  const intent = opts.intent ?? 0;
  if (intent !== 0 && intent !== 1 && intent !== 2) {
    throw new UnsupportedFeatureError(
      `ICC rendering intent ${String(intent)} has no B2A tag; `
      + 'expected 0 (perceptual), 1 (relative) or 2 (saturation)');
  }
  const tag = iccTag(p, `B2A${intent}`) ?? iccTag(p, 'B2A0');
  if (!tag) {
    throw new UnsupportedFeatureError(
      'ICC profile carries no B2A tag, so it cannot be a conversion destination');
  }
  const lut = readLutTag(p, tag);
  if (lut.inputChannels !== 3 || lut.outputChannels !== 4) {
    throw new PdfParseError(
      `ICC B2A tag is ${lut.inputChannels}-in/${lut.outputChannels}-out, `
      + 'expected 3-in/4-out for a Lab-to-CMYK transform');
  }
  const lab = p.header.pcs === 'Lab ';
  if (!lab) {
    throw new UnsupportedFeatureError(
      `ICC profile connection space is ${JSON.stringify(p.header.pcs)}; `
      + 'only "Lab " is supported');
  }
  return (r, g, b) => {
    const [x, y, z] = srgbToXyzD50(r, g, b);
    const [l, a, bb] = xyzToLab(x, y, z);
    const out = evalLut(lut, labToV2(l, a, bb));
    const at = (i: number): number => {
      const v = out[i] as number;
      return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    };
    return [at(0), at(1), at(2), at(3)];
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icctransform.test.ts`
Expected: PASS, 18 tests.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/icctransform.ts test/icctransform.test.ts
git commit -m "feat(85l8.7.2): build a CmykTransform from an ICC B2A tag

Every refusal happens in the factory, before any colour is converted, so a
declined profile leaves the document byte-identical. v4, absolute
colorimetric, a non-CMYK device space and a missing B2A are each declined
rather than guessed at -- a v4 B2A is an mBA with a different element order,
and reading it as an mft2 would produce confident nonsense.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The fixture, the generator and the goldens

> Run this task FIRST if you want Tasks 1-4 to fail cleanly rather than on a
> missing file. It is placed last because it is the only task that needs
> Windows, and the code it verifies is written by then.

**Files:**
- Create: `scripts/gen-icc-fixture.mjs`
- Create: `test/fixtures/icc/synthetic-cmyk.icc` (generated, committed)
- Create: `test/fixtures/icc/goldens.json` (generated, committed)
- Create: `test/fixtures/icc/PROVENANCE.md`
- Create: `test/icc-goldens.test.ts`
- Modify: `package.json` (a `gen:icc` script)

- [ ] **Step 1: Write the fixture generator**

Create `scripts/gen-icc-fixture.mjs` from the spike script at
`<scratchpad>/build-icc.mjs`, which is known to produce a profile WCS accepts.
It must write `test/fixtures/icc/synthetic-cmyk.icc` and be deterministic —
no clock reads, so re-running it produces byte-identical output.

The profile must carry all ten tags (`desc`, `cprt`, `wtpt`, `A2B0`, `A2B1`,
`A2B2`, `B2A0`, `B2A1`, `B2A2`, `gamt`): with only `A2B0` and `B2A0`, WCS
reports `ERROR_INVALID_PROFILE` (2011) and refuses to build a transform.

- [ ] **Step 2: Write the golden generator**

Add to `scripts/gen-icc-fixture.mjs` (or a sibling) the PowerShell driver from
`<scratchpad>/wcs-synth.ps1`, writing `test/fixtures/icc/goldens.json` as

```json
{ "profile": "synthetic-cmyk.icc",
  "sha256": "…",
  "intent": 0,
  "samples": [ { "rgb": [255, 255, 255], "cmyk": [0.5, 0.35, 0.4, 0.15] } ] }
```

Sample at least the 8 cube corners, mid grey, and a scatter of 20 further
values.

- [ ] **Step 3: Add the npm script**

In `package.json`, beside the other `gen:` entries:

```json
"gen:icc": "node scripts/gen-icc-fixture.mjs"
```

It is **not** run by `npm test`, exactly as `gen:fonts` and the rest are not.

- [ ] **Step 4: Write the golden test**

Create `test/icc-goldens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { iccCmykTransform } from '../src/icctransform.js';

/**
 * Our transform against Windows Color System's, through the same profile.
 *
 * The comparison is EXACT to 3 decimal places rather than tolerant, and that
 * is what the fixture's affine CLUT buys: trilinear and tetrahedral
 * interpolation agree exactly on an affine function, so there is no
 * interpolation-method slack for a bug to hide in. See PROVENANCE.md for the
 * ceiling this oracle does and does not reach.
 */
describe('iccCmykTransform agrees with Windows Color System', () => {
  const bytes = new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));
  const goldens = JSON.parse(
    readFileSync('test/fixtures/icc/goldens.json', 'utf8')) as {
      sha256: string;
      samples: { rgb: [number, number, number]; cmyk: [number, number, number, number] }[];
    };

  // The goldens describe ONE profile. Without this, editing the fixture and
  // forgetting to regenerate leaves the comparison silently meaningless.
  it('is comparing against the profile the goldens were made from', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(goldens.sha256);
  });

  it('reproduces every sample', () => {
    const t = iccCmykTransform(bytes);
    for (const { rgb, cmyk } of goldens.samples) {
      const got = t(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
      for (let i = 0; i < 4; i++) {
        expect(got[i]).toBeCloseTo(cmyk[i] as number, 3);
      }
    }
  });
});
```

- [ ] **Step 5: Generate, and run**

Run: `npm run gen:icc`
Then: `npx vitest run test/icc-goldens.test.ts test/icclut.test.ts test/icctransform.test.ts`
Expected: PASS.

If the goldens disagree, **do not loosen the tolerance**. A disagreement on an
affine fixture means a real difference — most likely the a\*/b\* encoding from
Task 3's note, or the CLUT stride. Fix the code and record what was wrong.

- [ ] **Step 6: Write PROVENANCE.md**

Create `test/fixtures/icc/PROVENANCE.md` recording: that the profile is
authored by `scripts/gen-icc-fixture.mjs` rather than vendored, and why
(`RSWOP.icm` is "Copyright (c) 2000 Microsoft Corporation" with no licence
grant, and the engine needs profile bytes at test time); that the goldens come
from Windows Color System via `mscms.dll`; the sha256 of both files; and the
ceiling, verbatim from the design doc:

- one CMS, one machine, no second engine to arbitrate;
- a profile we authored exercises only what we chose to put in it, and says
  nothing about v4 tags, `para` curves, matrix-based CMYK or unusual CLUT
  grids;
- the `mft1` path is exercised by no real profile available here — both
  `RSWOP.icm` and the fixture are `mft2`;
- colour errors are silent, which is why the affine fixture, the one that
  admits no tolerance, is the load-bearing one.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-icc-fixture.mjs test/fixtures/icc/ test/icc-goldens.test.ts package.json
git commit -m "test(85l8.7.2): an authored ICC fixture and WCS goldens

The profile is authored rather than vendored: RSWOP.icm is Microsoft
copyright, and unlike a golden table our engine needs profile bytes at test
time, so vendoring would cost the suite its hermeticity. Windows Color System
reads what we wrote -- it must both accept the profile and agree with our
transform through it.

The CLUT is affine so trilinear and tetrahedral interpolation coincide, which
is what lets the comparison be exact rather than tolerant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Export, document, close

**Files:**
- Modify: `src/index.ts`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Export the public surface**

In `src/index.ts`, beside the other colour exports:

```ts
export { iccCmykTransform } from './icctransform.js';
export type { IccTransformOptions } from './icctransform.js';
```

`parseIccProfile`, `readLutTag` and `evalLut` stay internal: nothing outside
this feature needs them, and exporting them would commit the library to an ICC
API before anyone has asked for one — `htmldom.ts`'s rule about
`parseHtmlFragment`.

- [ ] **Step 2: Add an end-to-end test through `ConvertColors`**

Append to `test/icc-goldens.test.ts`:

```ts
import { Document } from '../src/document.js';
import { buildGrayscalePdf } from './helpers/build-grayscale-pdf.js';

// 85l8.3 already threads a CmykTransform to every leg, so this asserts the
// composition rather than any new plumbing.
describe('ConvertColors through an ICC profile', () => {
  it('reports a supplied transform and inks all four channels', () => {
    const bytes = new Uint8Array(readFileSync('test/fixtures/icc/synthetic-cmyk.icc'));
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertColors({ to: 'cmyk', transform: iccCmykTransform(bytes) });
    expect(report.cmykTransform).toBe('supplied');
    expect(report.skipped).toEqual([]);
  });
});
```

Run: `npx vitest run test/icc-goldens.test.ts`
Expected: PASS.

- [ ] **Step 3: CHANGELOG**

Add under `## [Unreleased]` → `### Added`, an entry describing
`iccCmykTransform`, stating plainly that only ICC **v2** CMYK output profiles
with a Lab PCS are supported, that v4 and absolute colorimetric are declined
before anything converts, that interpolation is trilinear, and that the
default remains the naive transform when no `transform` is passed.

- [ ] **Step 4: CLAUDE.md**

Add `icclut.ts` and `icctransform.ts` entries to the Source list, then run the
sweep and confirm neither appears:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 5: README**

In the colour-conversion section, replace the "hand the leg in" snippet's
`cms(r, g, b)` placeholder with the real call, noting the v2/Lab limit:

```ts
import { iccCmykTransform } from '@asposefoss/pdf';
doc.ConvertColors({ to: 'cmyk', transform: iccCmykTransform(profileBytes) });
```

- [ ] **Step 6: Full suite, commit, close**

```bash
npm run typecheck && npx vitest run
git add -A
git commit -m "feat(85l8.7.2): iccCmykTransform, and the docs for it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-85l8.7.2 --reason "..."
git pull --rebase && git push
```

---

## Self-Review

**Spec coverage.** The design's `85l8.7.2` scope — `icclut.ts`, `icctransform.ts`, the authored fixture, the generator and the goldens — maps to Tasks 1-2, 3-4, and 5 respectively; Task 6 covers the export and docs. The design's declines (v4, absolute colorimetric, no `B2A`, non-CMYK) are each a case in Task 4. The affine/non-affine fixture split is **partially** covered: Task 5 builds the affine profile only. The non-affine one, which would pin interpolation with a tolerance, is deliberately deferred — with an affine CLUT the interpolation method is unobservable, so that fixture tests a rule this plan does not otherwise exercise, and it should be its own issue once the exact path is green.

**Placeholders.** One is deliberate and flagged inline: Task 3's a\*/b\* encoding carries a note saying it is the plan's best reading, that the test is the authority, and that the implementer must record which reading won. Everything else carries its code.

**Type consistency.** `IccLut` is defined in Task 1 and consumed unchanged in Task 2. `CmykTransform` comes from `colorrule.ts` and is `(r, g, b) => readonly [number, number, number, number]`, which Task 4's returned closure satisfies. `sig` and `u32` are exported from `icc.ts` in Task 1 Step 1 — without that step `icclut.ts` cannot compile.
