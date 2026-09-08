import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseIccProfile, iccTag } from '../src/icc.js';
import { readLutTag, evalLut, type IccLut } from '../src/icclut.js';
import { PdfParseError } from '../src/errors.js';

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
  // exact under EVERY interpolation method, since every one of them
  // reproduces an affine function — which is the whole reason the fixture is
  // affine, and why these cases held unedited when the method changed.
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

/**
 * How the CLUT is interpolated (`m3gs`): TETRAHEDRALLY for three inputs,
 * MULTILINEARLY otherwise.
 *
 * Driven from hand-built LUTs rather than the fixture, so every expectation
 * is arithmetic anyone can check on paper. The end-to-end evidence that
 * tetrahedral is the RIGHT choice is `test/icc-goldens.test.ts`'s curved
 * profile, where a reference CMS is the judge.
 */
describe('evalLut CLUT interpolation', () => {
  /** A LUT whose curves are the identity, so only the CLUT is under test. */
  const build = (
    inputChannels: number, outputChannels: number, grid: number, clut: number[],
  ): IccLut => ({
    inputChannels,
    outputChannels,
    grid,
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    inputTables: Array.from({ length: inputChannels },
      () => Float64Array.from([0, 1])),
    clut: Float64Array.from(clut),
    outputTables: Array.from({ length: outputChannels },
      () => Float64Array.from([0, 1])),
  });

  // The PURE TRIPLE PRODUCT i*j*k: zero at seven corners, one at (1,1,1).
  // It is the term multilinear interpolation carries and tetrahedral does
  // not, so it separates the two as sharply as a CLUT can.
  const triple = build(3, 1, 2, [0, 0, 0, 0, 0, 0, 0, 1]);

  it('reproduces every corner of the cell exactly', () => {
    for (const [i, j, k] of [
      [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
      [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
    ]) {
      expect(evalLut(triple, [i, j, k])[0]).toBeCloseTo(i * j * k, 10);
    }
  });

  /**
   * The cell centre is where the two methods disagree most. Multilinear
   * averages all eight corners and gives 1/8; tetrahedral reads only the four
   * corners of the tetrahedron holding the point — here `000`, `100`, `110`,
   * `111` — and gives 1/2.
   *
   * Asserting BOTH numbers is the point: `not.toBeCloseTo(0.125)` alone would
   * pass for any wrong answer at all.
   */
  it('interpolates a 3-input CLUT tetrahedrally, not multilinearly', () => {
    expect(evalLut(triple, [0.5, 0.5, 0.5])[0]).toBeCloseTo(0.5, 10);
    expect(evalLut(triple, [0.5, 0.5, 0.5])[0]).not.toBeCloseTo(0.125, 3);
  });

  /**
   * Which tetrahedron holds the point is decided by the ORDER of the three
   * fractions, so permuting them routes through different branches. For THIS
   * CLUT every branch reduces to `min(f0, f1, f2)` — which is what makes the
   * case discriminating rather than uniform: a build stuck in one branch
   * answers with a FIXED fraction instead. Hardcode the `f0 >= f1 >= f2` arm
   * and the second and fifth lines below return 0.6 and 0.9.
   */
  it('selects the tetrahedron from the order of the fractions', () => {
    const at = (a: number, b: number, c: number): number =>
      evalLut(triple, [a, b, c])[0] as number;
    expect(at(0.6, 0.5, 0.4)).toBeCloseTo(0.4, 10);   // f0 >= f1 >= f2
    expect(at(0.4, 0.5, 0.6)).toBeCloseTo(0.4, 10);   // f2 >= f1 >  f0
    expect(at(0.5, 0.6, 0.4)).toBeCloseTo(0.4, 10);   // f1 >  f0 >  f2
    expect(at(0.9, 0.5, 0.1)).toBeCloseTo(0.1, 10);   // f0 >= f1 >= f2
    expect(at(0.1, 0.5, 0.9)).toBeCloseTo(0.1, 10);   // f2 >= f1 >  f0
  });

  /**
   * An AFFINE CLUT is where the two methods agree exactly, and that is not a
   * curiosity — it is why `synthetic-cmyk.icc`'s 29 goldens held unedited
   * through the switch, and why a second curved fixture had to be authored
   * before the method could be changed at all.
   */
  it('agrees with the multilinear answer on an affine CLUT', () => {
    // C = 0.1 + 0.4*i + 0.2*j + 0.1*k — no cross terms, so both methods are
    // exact and the expectation is the formula itself.
    const affine = build(3, 1, 2, [
      0.1, 0.2, 0.3, 0.4,   // i = 0: (j,k) = 00, 01, 10, 11
      0.5, 0.6, 0.7, 0.8,   // i = 1
    ]);
    for (const [a, b, c] of [
      [0.5, 0.5, 0.5], [0.25, 0.75, 0.5], [0.9, 0.1, 0.3], [0.33, 0.66, 0.99],
    ]) {
      expect(evalLut(affine, [a, b, c])[0])
        .toBeCloseTo(0.1 + 0.4 * a + 0.2 * b + 0.1 * c, 10);
    }
  });

  /**
   * Four inputs keep the multilinear walk. A tetrahedral decomposition is a
   * property of the CUBE, so there is no 4-input counterpart — which is why
   * the dispatch is on the input count rather than on a flag.
   */
  it('interpolates a 4-input CLUT multilinearly', () => {
    const quad = build(4, 1, 2, [...Array.from({ length: 15 }, () => 0), 1]);
    expect(evalLut(quad, [0.5, 0.5, 0.5, 0.5])[0]).toBeCloseTo(1 / 16, 10);
  });

  /**
   * Which CELL the point falls in, which grid 2 provably cannot test: there
   * the origin is always 0, so `Math.min(Math.floor(q), grid - 2)` is
   * unreachable arithmetic. The curved fixture is grid 3 for this reason too.
   */
  it('picks the enclosing cell on a grid larger than 2', () => {
    // Depends on the first axis alone, with a KINK at the middle grid point:
    // 0, 0.25, 1. A build stuck in cell 0 reads the 0 -> 0.25 slope
    // throughout and answers 0.375 where 0.625 is right.
    const kink = [0, 0.25, 1];
    const clut: number[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
        clut.push(kink[i] as number);
      }
    }
    const lut = build(3, 1, 3, clut);
    expect(evalLut(lut, [0.75, 0, 0])[0]).toBeCloseTo(0.625, 10);
    expect(evalLut(lut, [0.25, 0, 0])[0]).toBeCloseTo(0.125, 10);
    // The top of the range stays inside the LAST cell rather than running
    // off the end of the CLUT.
    expect(evalLut(lut, [1, 0, 0])[0]).toBeCloseTo(1, 10);
  });
});
