import { describe, it, expect } from 'vitest';
import { decodeTextRegion } from '../src/jbig2text.js';
import { decodeSymbolDict } from '../src/jbig2symbol.js';
import type { Bitmap } from '../src/jbig2.js';
import * as F from './helpers/jbig2-refagg-vectors.js';

function rows(bm: Bitmap): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

const NOMINAL_RAT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];

describe('jbig2 text region with SBREFINE', () => {
  // The vector places one plain instance of a 4x4 box and one refined into a
  // solid 5x5. Ignoring RI would place the box twice AND desynchronise, since
  // the refinement's arithmetic decisions are still in the stream.
  it('refines a symbol instance in place', () => {
    const v = F.refine_text;
    const bm = decodeTextRegion(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, numInstances: v.numInstances,
      symbols: v.symbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      logStrips: 0, refCorner: 1 /* TOPLEFT */, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0,
      refine: true, rTemplate: v.rTemplate, rAt: NOMINAL_RAT,
    });
    expect(rows(bm)).toEqual(v.rows);
    // The base symbol is 4 wide with 0 either side, so only the 5-wide
    // refinement can produce a run of five. This is what separates "the
    // refinement was decoded" from "the base symbol was placed twice".
    expect(rows(bm).some((r) => r.includes('11111'))).toBe(true);
  });

  // §6.4.11.1 offsets by (RDW >> 1) + RDX. `>>` floors toward negative infinity;
  // `(RDW / 2) | 0` truncates toward zero, and the two agree for every
  // NON-NEGATIVE delta — so the growing vector above cannot tell them apart, and
  // a truncating build passes it (measured). Only a shrinking refinement, with
  // an odd negative RDW/RDH, can fence the rule.
  it('floors the half-delta on a shrinking refinement', () => {
    const v = F.refine_text_shrink;
    const bm = decodeTextRegion(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, numInstances: v.numInstances,
      symbols: v.symbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      logStrips: 0, refCorner: 1, transposed: false, combOp: 0,
      defPixel: 0, dsOffset: 0,
      refine: true, rTemplate: v.rTemplate, rAt: NOMINAL_RAT,
    });
    expect(rows(bm)).toEqual(v.rows);
  });
});

describe('jbig2 symbol dictionary with REFAGG', () => {
  const SD_AT = [{ x: 3, y: -1 }, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];

  function run(v: { bytes: Uint8Array; numExSyms: number; numNewSyms: number; rTemplate: number;
                    inputSymbols: ReadonlyArray<{ w: number; h: number; data: readonly number[] }> }) {
    return decodeSymbolDict(v.bytes, 0, v.bytes.length, {
      huffman: false, refAgg: true, template: 0, at: SD_AT,
      numExSyms: v.numExSyms, numNewSyms: v.numNewSyms,
      inputSymbols: v.inputSymbols.map((s) => ({ width: s.w, height: s.h, data: Uint8Array.from(s.data) })),
      rTemplate: v.rTemplate, rAt: NOMINAL_RAT,
    });
  }

  // §6.5.8.2.2. The offsets are RDX/RDY PLAIN here — no half-delta, unlike the
  // text region's §6.4.11.1 — because the refined symbol's size comes from the
  // height class rather than from a decoded delta.
  it('refines an existing symbol when REFAGGNINST is 1', () => {
    const v = F.refagg_one;
    const out = run(v);
    expect(out.map((s) => [s.width, s.height])).toEqual(v.sizes);
    expect(out.map((s) => Array.from(s.data))).toEqual(v.syms);
  });

  // §6.5.8.2.1: more than one instance is decoded as a text region over the
  // dictionary's current symbols, sharing its stream and contexts. The fixture's
  // counts are chosen so the symCodeLen override is load-bearing: the declared
  // total is 3 (2 bits) while the count decoded so far is 2 (1 bit).
  it('aggregates a text region when REFAGGNINST is greater than 1', () => {
    const v = F.refagg_many;
    const out = run(v);
    expect(out.map((s) => [s.width, s.height])).toEqual(v.sizes);
    expect(out.map((s) => Array.from(s.data))).toEqual(v.syms);
  });

  // MIXED paths in one dictionary: a REFAGGNINST == 1 symbol followed by an
  // aggregate. This is the ONLY shape that can observe whether the aggregate
  // text region shares the dictionary's IAID/IARDX/IARDY (T.88 §6.5.8.2.1) or
  // keeps its own — in the two fixtures above the other path never runs, so the
  // contexts it would have touched are in their initial state either way, and
  // both readings decode them identically.
  //
  // What this pins is that our encoder and our decoder agree about the sharing.
  // It does NOT pin that the sharing matches T.88: both halves are written from
  // the same reading of §6.5.8.2.1 and no independent reference is available.
  // Recorded as unanchored, in the shape utax.5 already uses for its three
  // offset rules.
  it('shares one context set between a single-instance refinement and an aggregate', () => {
    const v = F.refagg_mixed;
    const out = run(v);
    expect(out.map((s) => [s.width, s.height])).toEqual(v.sizes);
    expect(out.map((s) => Array.from(s.data))).toEqual(v.syms);
  });
});
