import { describe, it, expect } from 'vitest';
import { encodeG4, encodeG3_1D, type Bitmap } from './helpers/ccitt-encode.js';

const row = (bits: string): number[] => bits.split('').map((c) => (c === '1' ? 1 : 0));

describe('ccitt-encode helper', () => {
  it('encodeG4 reproduces the all-white 8x1 golden vector', () => {
    const bm: Bitmap = [row('00000000')];
    expect(Array.from(encodeG4(bm))).toEqual([0x80]);
  });

  it('encodeG4 reproduces the horizontal-mode 8x2 golden vector', () => {
    const bm: Bitmap = [row('11110000'), row('00001111')];
    expect(Array.from(encodeG4(bm))).toEqual([0x26, 0xae, 0x6d, 0x80]);
  });

  it('encodeG4 reproduces the V0+VR1 8x2 golden vector', () => {
    const bm: Bitmap = [row('11110000'), row('11111000')];
    expect(Array.from(encodeG4(bm))).toEqual([0x26, 0xaf, 0x70]);
  });

  it('encodeG3_1D encodes a uniform 8-white row as a single white-8 code (0x98)', () => {
    // white run 8 = terminating code '10011' -> padded '10011000' = 0x98
    const bm: Bitmap = [row('00000000')];
    expect(Array.from(encodeG3_1D(bm))).toEqual([0x98]);
  });
});
