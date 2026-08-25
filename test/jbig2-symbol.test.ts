import { describe, it, expect } from 'vitest';
import { decodeSymbolDict } from '../src/jbig2symbol.js';
import * as F from './helpers/jbig2-symbol-vectors.js';



const SD_AT = [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];

describe('jbig2 symbol dictionary', () => {
  it('decodes two exported symbols with the expected sizes and pixels', () => {
    const syms = decodeSymbolDict(F.two_syms.bytes, 0, F.two_syms.bytes.length, {
      huffman: false, refAgg: false, template: 0, at: SD_AT, numExSyms: 2, numNewSyms: 2, inputSymbols: [],
      rTemplate: 0, rAt: [],
    });
    expect(syms.map((s) => [s.width, s.height])).toEqual(F.two_syms.sizes);
    expect(Array.from(syms[0].data)).toEqual(F.two_syms.sym0);
    expect(Array.from(syms[1].data)).toEqual(F.two_syms.sym1);
  });

});
