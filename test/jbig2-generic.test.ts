import { describe, it, expect } from 'vitest';
import { decodeGeneric } from '../src/jbig2generic.js';
import { encodeG4 } from './helpers/ccitt-encode.js';
import * as F from './helpers/jbig2-generic-vectors.js';

function rows(bm: { width: number; height: number; data: Uint8Array }): string[] {
  const out: string[] = [];
  for (let y = 0; y < bm.height; y++) out.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return out;
}

describe('jbig2 generic region', () => {
  it('decodes an arithmetic GB0 region (with TPGDON) to the known bitmap', () => {
    const bm = decodeGeneric(F.arith_gb0.bytes, 0, F.arith_gb0.bytes.length, {
      width: F.arith_gb0.width, height: F.arith_gb0.height, template: 0,
      at: [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }], tpgdon: true, mmr: false,
    });
    expect(rows(bm)).toEqual(F.arith_gb0.rows);
  });

  it('decodes an MMR (Group-4) generic region via the shared CCITT engine', () => {
    // A known 12x6 bitmap (0=white,1=black), G4-encoded with the repo helper.
    const pixels = [
      [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1],
      [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0],
      [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0],
      [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0],
      [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0],
      [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1],
    ];
    const g4 = encodeG4(pixels);
    const bm = decodeGeneric(g4, 0, g4.length, { width: 12, height: 6, template: 0, at: [], tpgdon: false, mmr: true });
    expect(rows(bm)).toEqual(pixels.map((r) => r.join('')));
  });
});
