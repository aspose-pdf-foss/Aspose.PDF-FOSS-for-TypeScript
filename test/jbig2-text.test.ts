import { describe, it, expect } from 'vitest';
import { decodeTextRegion } from '../src/jbig2text.js';
import * as F from './helpers/jbig2-text-vectors.js';

function rows(bm: { width: number; height: number; data: Uint8Array }): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

describe('jbig2 text region', () => {
  it('places symbols at the expected positions', () => {
    const bm = decodeTextRegion(F.two_placed.bytes, 0, F.two_placed.bytes.length, {
      width: F.two_placed.width, height: F.two_placed.height, numInstances: F.two_placed.numInstances,
      symbols: F.two_placed.symbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      logStrips: 0, refCorner: 1 /*TOPLEFT*/, transposed: false, combOp: 0, defPixel: 0, dsOffset: 0, refine: false, rTemplate: 0, rAt: [],
    });
    expect(rows(bm)).toEqual(F.two_placed.rows);
  });

  it('produces an empty region (def pixel) when there are no instances', () => {
    const bm = decodeTextRegion(new Uint8Array(4), 0, 4, {
      width: 3, height: 2, numInstances: 0, symbols: [],
      logStrips: 0, refCorner: 1, transposed: false, combOp: 0, defPixel: 0, dsOffset: 0, refine: false, rTemplate: 0, rAt: [],
    });
    expect(rows(bm)).toEqual(['000', '000']);
  });
});
