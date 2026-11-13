import { describe, it, expect } from 'vitest';
import { applyPredictor } from '../src/predictor.js';
import { PdfParseError } from '../src/errors.js';
import { TIFF_PREDICTOR_VECTORS } from './helpers/predictor-vectors.js';

describe('applyPredictor', () => {
  it('returns input unchanged for predictor 1', () => {
    const d = Uint8Array.from([1, 2, 3, 4]);
    expect(Array.from(applyPredictor(d, { predictor: 1, colors: 1, bpc: 8, columns: 4 }))).toEqual([1, 2, 3, 4]);
  });
  it('reverses PNG Up filter (tag 2)', () => {
    // 2 rows, columns=3, each row prefixed by filter-tag byte.
    // row0 tag=2 (Up) data [10,20,30] -> previous row is zeros -> stays [10,20,30]
    // row1 tag=2 (Up) data [1,1,1] -> add previous row [10,20,30] -> [11,21,31]
    const input = Uint8Array.from([2, 10, 20, 30, 2, 1, 1, 1]);
    const out = applyPredictor(input, { predictor: 12, colors: 1, bpc: 8, columns: 3 });
    expect(Array.from(out)).toEqual([10, 20, 30, 11, 21, 31]);
  });
});

describe('TIFF Predictor 2 component arithmetic', () => {
  it.each(TIFF_PREDICTOR_VECTORS)('$label', ({ bpc, colors, columns, encoded, decoded }) => {
    const input = Uint8Array.from(encoded);
    expect(applyPredictor(input, { predictor: 2, bpc, colors, columns })).toEqual(Uint8Array.from(decoded));
    expect(input).toEqual(Uint8Array.from(encoded));
  });

  it('reconstructs a byte-aligned all-white 1-bit row', () => {
    expect(applyPredictor(Uint8Array.from([0x80, 0, 0, 0]),
      { predictor: 2, colors: 1, bpc: 1, columns: 32 })).toEqual(new Uint8Array(4).fill(255));
  });

  it('preserves an incomplete final row without inventing samples', () => {
    expect(applyPredictor(Uint8Array.from([0x12, 0x11, 0x9f]),
      { predictor: 2, colors: 1, bpc: 4, columns: 4 })).toEqual(Uint8Array.from([0x13, 0x45, 0x9f]));
  });

  it('does not allocate from declared row dimensions when input is short', () => {
    expect(applyPredictor(Uint8Array.from([1, 2, 3]),
      { predictor: 2, colors: 1, bpc: 1, columns: 100_000_000 })).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it.each([1, 2, 4, 8, 16])('keeps empty input empty at %i bits', (bpc) => {
    expect(applyPredictor(new Uint8Array(), { predictor: 2, colors: 1, bpc, columns: 1 })).toHaveLength(0);
  });

  it.each([
    { bpc: 3, colors: 1, columns: 2 },
    { bpc: 1, colors: 0, columns: 2 },
    { bpc: 1, colors: -1, columns: 2 },
    { bpc: 4, colors: 1.5, columns: 2 },
    { bpc: 8, colors: 1, columns: 0 },
    { bpc: 8, colors: 1, columns: -1 },
    { bpc: 16, colors: Number.MAX_SAFE_INTEGER, columns: 2 },
  ])('refuses invalid dimensions or component widths %j', (params) => {
    expect(() => applyPredictor(Uint8Array.from([1, 2, 3]), { predictor: 2, ...params })).toThrow(PdfParseError);
  });
});
