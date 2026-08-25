import { describe, it, expect } from 'vitest';
import { applyPredictor } from '../src/predictor.js';

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
