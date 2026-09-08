import { PdfParseError } from './errors.js';
import { sig, type IccProfile, type IccTag } from './icc.js';

/**
 * The LUT pipeline an ICC `A2B`/`B2A` tag describes (85l8.7.2).
 *
 * A pure leaf over `icc.ts` — it reads tag data and evaluates it, and knows
 * nothing of colour spaces, rendering intents or PDF. `icctransform.ts`
 * composes it into an RGB→CMYK transform.
 *
 * Two tag types share one shape: `mft2` (lut16Type) holds 16-bit tables and
 * STATES their lengths, while `mft1` (lut8Type) holds 8-bit tables of exactly
 * 256 entries and states no lengths at all. Assuming 256 for an `mft2` reads
 * its CLUT as curve data — a plausible wrong picture rather than an error.
 *
 * **Note, and recorded rather than left to be discovered:** the `mft1` path is
 * exercised by no real profile available here. Both `RSWOP.icm` and the
 * authored fixture are `mft2`, so it is held by a synthetic case alone.
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
 * MULTILINEAR interpolation over the `2**n` corners of the enclosing cell,
 * each weighted by its distance. The arithmetic reads straight off the spec,
 * and it is the only reading available for an input count other than three:
 * a tetrahedral decomposition is a property of the CUBE, so there is no
 * 4-input counterpart for an `A2B`'s CMYK side.
 */
function multilinear(
  clut: Float64Array, grid: number, outputChannels: number,
  base: readonly number[], frac: readonly number[], out: number[],
): void {
  const corners = 1 << base.length;
  for (let mask = 0; mask < corners; mask++) {
    let weight = 1;
    let index = 0;
    for (let c = 0; c < base.length; c++) {
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
}

/**
 * TETRAHEDRAL interpolation, for a 3-input CLUT (`m3gs`).
 *
 * The cell is split into six tetrahedra sharing the `000`–`111` diagonal, and
 * which one holds the point is decided by the ORDER of the three fractions
 * alone — no geometry, six branches. Within it the interpolation is linear,
 * so only four of the eight corners are read.
 *
 * **Invariant, and it is what makes this a correction rather than a
 * preference:** this is what a reference CMS does. Measured against Windows
 * Color System through a purpose-built curved profile, our previous
 * multilinear walk missed WCS by up to **4.0×10⁻²** — four percentage points
 * of ink — where tetrahedral tracks it to 4.8×10⁻³, and typically to
 * 1.3×10⁻⁴. littlecms and Adobe's CMM subdivide the same way. See
 * `test/fixtures/icc/PROVENANCE.md`.
 *
 * **Invariant, and it is why the switch cost the shipped fixture nothing:**
 * the two methods agree EXACTLY on an affine CLUT, because both reproduce an
 * affine function. `synthetic-cmyk.icc` is affine by construction, so every
 * golden it anchors held unedited — measured at 1.1×10⁻¹⁶, one ulp. That is
 * also why a second, CURVED fixture had to exist before this could be
 * changed at all: the affine one provably cannot see the method.
 *
 * **Note the deviation is grid-dependent, so do not read the 4% as the
 * error on a real file.** It falls as the square of the cell size — measured
 * over a dense sweep of one curved function at 1.9×10⁻¹ (grid 2), 7.0×10⁻²
 * (3), 2.1×10⁻² (5), 5.3×10⁻³ (9), 1.4×10⁻³ (17) and 3.3×10⁻⁴ (33). A real
 * profile's `B2A0` is grid 17, so the practical change to output is about a
 * tenth of a percent. The reason to make it is agreement with the reference,
 * not the magnitude.
 */
function tetrahedral(
  clut: Float64Array, grid: number, outputChannels: number,
  base: readonly number[], frac: readonly number[], out: number[],
): void {
  const at = (i: number, j: number, k: number): number =>
    ((((base[0] as number) + i) * grid + ((base[1] as number) + j)) * grid
      + ((base[2] as number) + k)) * outputChannels;
  const o000 = at(0, 0, 0), o001 = at(0, 0, 1);
  const o010 = at(0, 1, 0), o011 = at(0, 1, 1);
  const o100 = at(1, 0, 0), o101 = at(1, 0, 1);
  const o110 = at(1, 1, 0), o111 = at(1, 1, 1);
  const f0 = frac[0] as number, f1 = frac[1] as number, f2 = frac[2] as number;

  // The three edges of the chosen tetrahedron, as (high, low) corner pairs.
  // Every branch starts at `000` and ends at `111`, which is what makes all
  // eight corners exact and the result continuous across the shared faces.
  let h0: number, l0: number, h1: number, l1: number, h2: number, l2: number;
  if (f0 >= f1) {
    if (f1 >= f2) {          // f0 >= f1 >= f2
      h0 = o100; l0 = o000; h1 = o110; l1 = o100; h2 = o111; l2 = o110;
    } else if (f0 >= f2) {   // f0 >= f2 > f1
      h0 = o100; l0 = o000; h1 = o111; l1 = o101; h2 = o101; l2 = o100;
    } else {                 // f2 > f0 >= f1
      h0 = o101; l0 = o001; h1 = o111; l1 = o101; h2 = o001; l2 = o000;
    }
  } else {
    if (f2 >= f1) {          // f2 >= f1 > f0
      h0 = o111; l0 = o011; h1 = o011; l1 = o001; h2 = o001; l2 = o000;
    } else if (f2 >= f0) {   // f1 > f2 >= f0
      h0 = o111; l0 = o011; h1 = o010; l1 = o000; h2 = o011; l2 = o010;
    } else {                 // f1 > f0 > f2
      h0 = o110; l0 = o010; h1 = o010; l1 = o000; h2 = o111; l2 = o110;
    }
  }
  for (let k = 0; k < outputChannels; k++) {
    out[k] = (clut[o000 + k] as number)
      + ((clut[h0 + k] as number) - (clut[l0 + k] as number)) * f0
      + ((clut[h1 + k] as number) - (clut[l1 + k] as number)) * f1
      + ((clut[h2 + k] as number) - (clut[l2 + k] as number)) * f2;
  }
}

/**
 * Evaluate the pipeline: input curves, CLUT, output curves.
 *
 * The CLUT is interpolated TETRAHEDRALLY for three inputs and MULTILINEARLY
 * otherwise — see those two functions for the measurement behind the split.
 * Three inputs is the `B2A` direction, which is the only one this library
 * evaluates today; the multilinear arm is what an `A2B`'s four CMYK inputs
 * would take, and is unreachable through `icctransform.ts`.
 *
 * The 3x3 matrix is deliberately NOT applied. ICC allows it only for an XYZ
 * PCS, and it is the identity in every profile this library reads;
 * `icctransform.ts` accepts a Lab PCS only, so a profile stating a real matrix
 * never reaches here.
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

  // The enclosing cell, and where in it the point sits. `grid - 2` is the
  // last cell origin, so a point at the very top of the range interpolates
  // within the final cell rather than off the end of the CLUT.
  const base: number[] = [];
  const frac: number[] = [];
  for (const q of pos) {
    const i = Math.min(Math.floor(q), grid - 2);
    base.push(i);
    frac.push(q - i);
  }

  const out = new Array<number>(outputChannels).fill(0);
  if (inputs.length === 3) {
    tetrahedral(clut, grid, outputChannels, base, frac, out);
  } else {
    multilinear(clut, grid, outputChannels, base, frac, out);
  }

  // Output curves.
  for (let k = 0; k < outputChannels; k++) {
    out[k] = sampleTable(lut.outputTables[k] as Float64Array, out[k] as number);
  }
  return out;
}
