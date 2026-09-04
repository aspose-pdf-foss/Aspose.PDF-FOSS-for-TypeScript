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
 * Evaluate the pipeline: input curves, CLUT, output curves.
 *
 * The CLUT is interpolated TRILINEARLY (multilinearly, for any input count):
 * the arithmetic reads straight off the spec, where tetrahedral interpolation
 * — which littlecms and probably WCS use — is a different subdivision that
 * agrees with it only for an AFFINE CLUT. `test/fixtures/icc/`'s profile is
 * affine precisely so the two coincide and the goldens admit no tolerance.
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
