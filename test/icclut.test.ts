import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseIccProfile, iccTag } from '../src/icc.js';
import { readLutTag, evalLut } from '../src/icclut.js';
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
