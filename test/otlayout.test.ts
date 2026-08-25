import { describe, it, expect } from 'vitest';
import { parseCoverage, parseClassDef, parseOtTable, resolveLookups, parseGdef, GlyphFilter, applyGsub, applyGpos, applyFeatures, type ShapedGlyph } from '../src/otlayout.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildGsub, buildGpos, buildOtFont, buildMinimalTtf, buildGdefClasses, singleSubstDelta, ligatureLookup, multipleLookup, alternateLookup, chainLookup, chainLookupFmt1, contextLookupFmt1, contextLookupFmt2, chainContextLookupFmt2, extensionLookup, reverseChainLookup, pairKernLookup, singleAdjustLookup, markBaseLookup, markMarkLookup, cursiveLookup, markLigLookup } from './helpers/build-sfnt.js';

function buf(gids: number[]): ShapedGlyph[] {
  return gids.map((g, i) => ({ gid: g, cluster: i, xAdvance: 0, xOffset: 0, yOffset: 0 }));
}
function pbuf(pairs: [number, number][]): ShapedGlyph[] {
  return pairs.map(([g, adv], i) => ({ gid: g, cluster: i, xAdvance: adv, xOffset: 0, yOffset: 0 }));
}

function u16a(...ns: number[]): Uint8Array { const b = new Uint8Array(ns.length * 2); const v = new DataView(b.buffer); ns.forEach((n, i) => v.setUint16(i * 2, n & 0xffff)); return b; }
function cat(...ps: Uint8Array[]): Uint8Array { const n = ps.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; }
function tag(s: string): Uint8Array { return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]); }

// Minimal GSUB: one script 'latn' (default langsys), one feature 'liga' (index 0)
// referencing lookup 0, and one lookup (type 1, 0 subtables — header-only test).
function miniGsub(): Uint8Array {
  const defaultLangSys = u16a(0, 0xFFFF, 1, 0);                        // lookupOrder, requiredFeatureIndex, featureCount, featureIndex[0]
  const scriptTable = cat(u16a(4, 0), defaultLangSys);               // defaultLangSysOff=4 (from ScriptTable), langSysCount=0
  const scriptList = cat(u16a(1), tag('latn'), u16a(8), scriptTable); // count, tag, ScriptTable off=8, then ScriptTable
  const feature = u16a(0, 1, 0);                                      // featureParams, lookupCount, lookupIndex[0]
  const featureList = cat(u16a(1), tag('liga'), u16a(8), feature);    // count, tag, Feature off=8, then Feature
  const lookup = u16a(1, 0, 0);                                       // type1, flag0, subtableCount0
  const lookupList = cat(u16a(1), u16a(4), lookup);                  // count, Lookup off=4, then Lookup
  const sOff = 10, fOff = sOff + scriptList.length, lOff = fOff + featureList.length;
  return cat(u16a(1, 0, sOff, fOff, lOff), scriptList, featureList, lookupList);
}

// Coverage format 1: sorted glyph list [5, 9, 12] -> indices 0,1,2.
function covFmt1(gids: number[]): Uint8Array {
  const b = new Uint8Array(4 + gids.length * 2);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1); v.setUint16(2, gids.length);
  gids.forEach((g, i) => v.setUint16(4 + i * 2, g));
  return b;
}
// Coverage format 2: ranges. Each range = start,end,startCoverageIndex.
function covFmt2(ranges: [number, number, number][]): Uint8Array {
  const b = new Uint8Array(4 + ranges.length * 6);
  const v = new DataView(b.buffer);
  v.setUint16(0, 2); v.setUint16(2, ranges.length);
  ranges.forEach(([s, e, i], k) => { v.setUint16(4 + k * 6, s); v.setUint16(6 + k * 6, e); v.setUint16(8 + k * 6, i); });
  return b;
}

describe('parseCoverage', () => {
  it('format 1 maps gid -> ordinal coverage index', () => {
    const c = parseCoverage(covFmt1([5, 9, 12]), 0);
    expect(c.index(5)).toBe(0);
    expect(c.index(9)).toBe(1);
    expect(c.index(12)).toBe(2);
    expect(c.index(7)).toBe(-1);
  });
  it('format 2 maps ranges to coverage indices', () => {
    const c = parseCoverage(covFmt2([[10, 12, 0], [20, 20, 3]]), 0);
    expect(c.index(10)).toBe(0);
    expect(c.index(12)).toBe(2);
    expect(c.index(20)).toBe(3);
    expect(c.index(13)).toBe(-1);
  });
});

describe('parseClassDef', () => {
  it('format 2 (range) returns the class of a gid, 0 if unlisted', () => {
    const b = new Uint8Array(4 + 6);
    const v = new DataView(b.buffer);
    v.setUint16(0, 2); v.setUint16(2, 1);            // format 2, 1 range
    v.setUint16(4, 5); v.setUint16(6, 8); v.setUint16(8, 2); // gids 5..8 -> class 2
    const cd = parseClassDef(b, 0);
    expect(cd.classOf(6)).toBe(2);
    expect(cd.classOf(4)).toBe(0);
    expect(cd.classOf(9)).toBe(0);
  });
  it('format 1 returns per-gid classes from a start gid', () => {
    const b = new Uint8Array(6 + 6);
    const v = new DataView(b.buffer);
    v.setUint16(0, 1); v.setUint16(2, 10); v.setUint16(4, 3); // format 1, startGid 10, count 3
    v.setUint16(6, 1); v.setUint16(8, 2); v.setUint16(10, 3); // gid10->1, 11->2, 12->3
    const cd = parseClassDef(b, 0);
    expect(cd.classOf(10)).toBe(1);
    expect(cd.classOf(12)).toBe(3);
    expect(cd.classOf(13)).toBe(0);
  });
});

describe('parseOtTable + resolveLookups', () => {
  it('parses scripts/features/lookups and resolves an enabled feature to lookups', () => {
    const t = parseOtTable(miniGsub())!;
    expect(t.lookups.length).toBe(1);
    expect(t.lookups[0].type).toBe(1);
    expect(resolveLookups(t, 'latn', undefined, ['liga'])).toEqual([0]);
    expect(resolveLookups(t, 'latn', undefined, ['kern'])).toEqual([]); // feature not present
  });
  it('falls back to first script when requested script is absent', () => {
    const t = parseOtTable(miniGsub())!;
    expect(resolveLookups(t, 'arab', undefined, ['liga'])).toEqual([0]);
  });
});

// GDEF with a glyph ClassDef (format 2): gid 3 -> class 3 (mark), gid 4 -> class 1 (base).
function miniGdef(): Uint8Array {
  const cd = (() => {
    const b = new Uint8Array(4 + 12); const v = new DataView(b.buffer);
    v.setUint16(0, 2); v.setUint16(2, 2);
    v.setUint16(4, 3); v.setUint16(6, 3); v.setUint16(8, 3);   // 3..3 -> class 3
    v.setUint16(10, 4); v.setUint16(12, 4); v.setUint16(14, 1); // 4..4 -> class 1
    return b;
  })();
  const header = new Uint8Array(12); const v = new DataView(header.buffer);
  v.setUint16(0, 1); v.setUint16(2, 0);        // version 1.0
  v.setUint16(4, 12);                          // glyphClassDefOffset = 12 (right after header)
  const out = new Uint8Array(12 + cd.length); out.set(header, 0); out.set(cd, 12); return out;
}

describe('GDEF glyph filtering', () => {
  it('IgnoreMarks skips class-3 glyphs', () => {
    const g = parseGdef(miniGdef())!;
    const f = new GlyphFilter(g, 0x0008 /*IgnoreMarks*/, undefined);
    expect(f.skip(3)).toBe(true);   // mark
    expect(f.skip(4)).toBe(false);  // base
  });
  it('no flags skips nothing', () => {
    const g = parseGdef(miniGdef())!;
    const f = new GlyphFilter(g, 0, undefined);
    expect(f.skip(3)).toBe(false);
  });
  it('IgnoreBaseGlyphs skips class-1 glyphs', () => {
    const g = parseGdef(miniGdef())!;
    const f = new GlyphFilter(g, 0x0002 /*IgnoreBaseGlyphs*/, undefined);
    expect(f.skip(4)).toBe(true);
    expect(f.skip(3)).toBe(false);
  });
});

describe('GSUB type 1 Single', () => {
  it('substitutes a covered gid by delta (format 1)', () => {
    const t = parseOtTable(buildGsub([singleSubstDelta('ccmp', 1, 6)]))!; // gid1 -> gid7
    const b = buf([1, 2]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);
    expect(b.map((x) => x.gid)).toEqual([7, 2]);
  });
});

describe('GSUB type 4 Ligature', () => {
  it('replaces a component sequence with the ligature glyph and merges clusters', () => {
    const t = parseOtTable(buildGsub([ligatureLookup('liga', 2, [3], 9)]))!; // (2,3) -> 9
    const b = buf([2, 3, 4]);
    applyGsub(t, b, undefined, 'latn', undefined, ['liga']);
    expect(b.map((x) => x.gid)).toEqual([9, 4]);
    expect(b[0].cluster).toBe(0); // min(0,1)
    expect(b[1].cluster).toBe(2);
  });
});

describe('GSUB type 2 Multiple', () => {
  it('decomposes one gid into a sequence, copying the cluster', () => {
    const t = parseOtTable(buildGsub([multipleLookup('ccmp', 5, [6, 7])]))!; // 5 -> 6,7
    const b = buf([5, 8]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);
    expect(b.map((x) => x.gid)).toEqual([6, 7, 8]);
    expect(b.map((x) => x.cluster)).toEqual([0, 0, 1]);
  });
});

describe('GSUB type 3 Alternate', () => {
  it('replaces with the first alternate', () => {
    const t = parseOtTable(buildGsub([alternateLookup('aalt', 5, [11, 12])]))!;
    const b = buf([5]);
    applyGsub(t, b, undefined, 'latn', undefined, ['aalt']);
    expect(b[0].gid).toBe(11);
  });
});

describe('GSUB type 6 Chaining (format 3) + nested lookup', () => {
  it('applies a nested single-subst only in context [4] _ where input is [5]', () => {
    // lookup0 = Single 5->99 (nested, tag not applied). lookup1 = Chain fmt3 back{4} input{5} -> seq(0,0).
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 5, 94),
      chainLookup('calt', [[4]], [[5]], [], [{ seqIndex: 0, lookupIndex: 0 }]),
    ]))!;
    const inCtx = buf([4, 5]);
    applyGsub(t, inCtx, undefined, 'latn', undefined, ['calt']);
    expect(inCtx.map((x) => x.gid)).toEqual([4, 99]);
    const noCtx = buf([5]);
    applyGsub(t, noCtx, undefined, 'latn', undefined, ['calt']);
    expect(noCtx.map((x) => x.gid)).toEqual([5]);
  });
});

describe('GSUB type 6 Chaining (format 1) + nested lookup', () => {
  it('applies a nested single-subst on a glyph-sequence rule', () => {
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 5, 94),                       // 5->99
      chainLookupFmt1('calt', 5, [4], [], [], [{ seqIndex: 0, lookupIndex: 0 }]), // cover 5, backtrack 4
    ]))!;
    const inCtx = buf([4, 5]);
    applyGsub(t, inCtx, undefined, 'latn', undefined, ['calt']);
    expect(inCtx.map((x) => x.gid)).toEqual([4, 99]);
    const noCtx = buf([9, 5]);
    applyGsub(t, noCtx, undefined, 'latn', undefined, ['calt']);
    expect(noCtx.map((x) => x.gid)).toEqual([9, 5]);
  });
});

describe('GSUB type 5 Contextual (format 1, glyph-sequence) + nested', () => {
  it('reads seqLookupCount before inputSequence (spec SequenceRule order)', () => {
    // cover {4}; rule input {5} (full sequence 4,5) applies nested lookup 0 (5 -> 99)
    // at seq index 1. A spec-compliant SequenceRule puts seqLookupCount right after
    // glyphCount, before the input glyphs — misreading the order breaks the match.
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      contextLookupFmt1('calt', 4, [5], [{ seqIndex: 1, lookupIndex: 0 }]),
    ]))!;
    const yes = buf([4, 5]);
    applyGsub(t, yes, undefined, 'latn', undefined, ['calt']);
    expect(yes.map((x) => x.gid)).toEqual([4, 99]);
    const no = buf([4, 6]);                                // second glyph not 5, no match
    applyGsub(t, no, undefined, 'latn', undefined, ['calt']);
    expect(no.map((x) => x.gid)).toEqual([4, 6]);
  });
});

describe('GSUB type 5 Contextual (format 2, class-based) + nested', () => {
  it('applies a nested single-subst when input classes match', () => {
    // classDef: gid 4 -> class 1, gid 5 -> class 2. Rule set for class 1 fires when
    // the second glyph is class 2, applying nested lookup 0 (5 -> 99) at seq index 1.
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      contextLookupFmt2('calt', [[4, 1], [5, 2]], [
        [],                                                // class 0: no rules
        [{ input: [2], recs: [{ seqIndex: 1, lookupIndex: 0 }] }], // class 1: [_ , class2]
        [],                                                // class 2: no rules
      ], 5),
    ]))!;
    const yes = buf([4, 5]);
    applyGsub(t, yes, undefined, 'latn', undefined, ['calt']);
    expect(yes.map((x) => x.gid)).toEqual([4, 99]);
    const no = buf([4, 6]);                                // second glyph class 0, no match
    applyGsub(t, no, undefined, 'latn', undefined, ['calt']);
    expect(no.map((x) => x.gid)).toEqual([4, 6]);
  });
});

describe('GSUB type 6 Chaining (format 2, class-based) + nested', () => {
  it('applies a nested subst gated by backtrack/input/lookahead classes', () => {
    // backtrack class: gid 4 -> 1. input class: gid 5 -> 1. lookahead class: gid 6 -> 1.
    // Rule set for input class 1: back {class1}, ahead {class1} -> apply nested at seq 0.
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      chainContextLookupFmt2('calt',
        [[4, 1]], [[5, 1]], [[6, 1]],
        [
          [],                                              // input class 0: none
          [{ back: [1], input: [], ahead: [1], recs: [{ seqIndex: 0, lookupIndex: 0 }] }],
        ], 6),
    ]))!;
    const yes = buf([4, 5, 6]);
    applyGsub(t, yes, undefined, 'latn', undefined, ['calt']);
    expect(yes.map((x) => x.gid)).toEqual([4, 99, 6]);
    const noBack = buf([9, 5, 6]);                         // backtrack class 0, no match
    applyGsub(t, noBack, undefined, 'latn', undefined, ['calt']);
    expect(noBack.map((x) => x.gid)).toEqual([9, 5, 6]);
    const noAhead = buf([4, 5, 9]);                        // lookahead class 0, no match
    applyGsub(t, noAhead, undefined, 'latn', undefined, ['calt']);
    expect(noAhead.map((x) => x.gid)).toEqual([4, 5, 9]);
  });
});

describe('GSUB type 7 Extension', () => {
  it('unwraps an extension to a Single subst', () => {
    const t = parseOtTable(buildGsub([extensionLookup('ccmp', singleSubstDelta('ccmp', 1, 6))]))!;
    const b = buf([1]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);
    expect(b[0].gid).toBe(7);
  });
});

describe('GSUB type 8 Reverse chaining single', () => {
  it('substitutes a covered glyph in context, right-to-left', () => {
    // cover {5} -> {77}, only when followed (lookahead) by 6.
    const t = parseOtTable(buildGsub([reverseChainLookup('rlig', [5], [], [[6]], [77])]))!;
    const yes = buf([5, 6]);
    applyGsub(t, yes, undefined, 'latn', undefined, ['rlig']);
    expect(yes.map((x) => x.gid)).toEqual([77, 6]);
    const no = buf([5, 9]);
    applyGsub(t, no, undefined, 'latn', undefined, ['rlig']);
    expect(no.map((x) => x.gid)).toEqual([5, 9]);
  });
});

describe('GPOS type 2 Pair (format 1)', () => {
  it('adds an xAdvance kern delta to the first glyph of a matching pair', () => {
    const t = parseOtTable(buildGpos([pairKernLookup('kern', 1, 2, -40)]))!;
    const b = pbuf([[1, 500], [2, 500]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xAdvance).toBe(460); // 500 + (-40)
    expect(b[1].xAdvance).toBe(500);
  });
});

describe('GPOS type 1 Single', () => {
  it('adds an xPlacement/xAdvance to a covered glyph', () => {
    const t = parseOtTable(buildGpos([singleAdjustLookup('kern', 3, 5, 10)]))!;
    const b = pbuf([[3, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xOffset).toBe(5);
    expect(b[0].xAdvance).toBe(710);
  });
});

describe('GPOS type 4 Mark-to-base', () => {
  it('positions a mark relative to the preceding base anchor', () => {
    // base gid 4 baseAnchor (300,0); mark gid 3 (class 0) markAnchor (10,-50).
    // GDEF marks gid3 as class 3 (mark) so the base scan skips marks.
    const t = parseOtTable(buildGpos([markBaseLookup('mark', 3, { x: 10, y: -50 }, 4, { x: 300, y: 0 })]))!;
    const gdef = parseGdef(miniGdef()); // gid3->mark(3), gid4->base(1)
    const b = pbuf([[4, 600], [3, 0]]);
    applyGpos(t, b, gdef, 'latn', undefined, ['mark']);
    // xOffset = (baseAnchor.x - markAnchor.x) - baseAdvance = (300 - 10) - 600 = -310
    expect(b[1].xOffset).toBe(-310);
    expect(b[1].yOffset).toBe(50);  // (baseAnchor.y - markAnchor.y) = 0 - (-50)
    expect(b[1].xAdvance).toBe(0);  // marks are zero-advance
  });
});

describe('GPOS type 6 Mark-to-mark', () => {
  it('stacks a mark on the preceding mark anchor', () => {
    // mark2 gid 5 anchor (100,700); mark1 gid 3 anchor (10,0). Sequence [5, 3].
    const t = parseOtTable(buildGpos([markMarkLookup('mkmk', 3, { x: 10, y: 0 }, 5, { x: 100, y: 700 })]))!;
    const b = pbuf([[5, 0], [3, 0]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['mkmk']);
    expect(b[1].xOffset).toBe(90);   // (100 - 10) - 0
    expect(b[1].yOffset).toBe(700);
  });
});

describe('GPOS type 3 Cursive (format 1)', () => {
  it('LTR: aligns exit->entry, adjusting advances and cross-direction y-offset', () => {
    const t = parseOtTable(buildGpos([cursiveLookup('curs', [
      { gid: 10, exit: { x: 500, y: 100 } },
      { gid: 11, entry: { x: 30, y: 40 } },
    ])]))!;
    const b = pbuf([[10, 600], [11, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['curs']);
    expect(b[0].xAdvance).toBe(500);        // prev advance clamped to exit.x
    expect(b[1].xOffset).toBe(-30);         // cur shifted left by entry.x
    expect(b[1].xAdvance).toBe(700 - 30);
    expect(b[1].yOffset).toBe(60);          // exit.y - entry.y
  });

  it('LTR chain: cross-direction y-offset propagates back along 3 joined glyphs', () => {
    const t = parseOtTable(buildGpos([cursiveLookup('curs', [
      { gid: 10, exit: { x: 500, y: 100 } },
      { gid: 11, entry: { x: 0, y: 40 }, exit: { x: 400, y: 200 } },
      { gid: 12, entry: { x: 0, y: 70 } },
    ])]))!;
    const b = pbuf([[10, 600], [11, 700], [12, 800]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['curs']);
    expect(b[1].yOffset).toBe(60);          // 100 - 40
    expect(b[2].yOffset).toBe(190);         // (200 - 70) + 60 (propagated from b[1])
  });

  it('RTL run + RIGHT_TO_LEFT flag: attaches prev->cur with mirrored advance/offset', () => {
    const t = parseOtTable(buildGpos([cursiveLookup('curs', [
      { gid: 10, exit: { x: 500, y: 100 } },
      { gid: 11, entry: { x: 30, y: 40 } },
    ], 0x0001)]))!;
    const b = pbuf([[10, 600], [11, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['curs'], true);  // rtl run
    expect(b[0].xOffset).toBe(-500);        // prev shifted by exit.x (RTL main-direction)
    expect(b[0].xAdvance).toBe(600 - 500);
    expect(b[1].xAdvance).toBe(30);         // cur advance clamped to entry.x
    expect(b[0].yOffset).toBe(-60);         // entry.y - exit.y; child = prev (flag)
    expect(b[1].yOffset).toBe(0);           // cur is the parent, not attached
  });

  // Regression for issue 97x: main-direction advance follows the run direction,
  // while the parent link follows the lookup RIGHT_TO_LEFT flag — independently.
  it('RTL run without the flag: RTL advance math but child = cur (parent link from flag)', () => {
    const t = parseOtTable(buildGpos([cursiveLookup('curs', [
      { gid: 10, exit: { x: 500, y: 100 } },
      { gid: 11, entry: { x: 30, y: 40 } },
    ])]))!;                                   // no RIGHT_TO_LEFT flag
    const b = pbuf([[10, 600], [11, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['curs'], true);  // rtl run
    expect(b[0].xOffset).toBe(-500);        // same RTL main-direction math as flagged case
    expect(b[0].xAdvance).toBe(600 - 500);
    expect(b[1].xAdvance).toBe(30);
    expect(b[1].yOffset).toBe(60);          // exit.y - entry.y; child = cur (no flag)
    expect(b[0].yOffset).toBe(0);           // prev is the parent, not attached
  });

  it('LTR run with the RIGHT_TO_LEFT flag: LTR advance math but child = prev (parent link from flag)', () => {
    const t = parseOtTable(buildGpos([cursiveLookup('curs', [
      { gid: 10, exit: { x: 500, y: 100 } },
      { gid: 11, entry: { x: 30, y: 40 } },
    ], 0x0001)]))!;                           // RIGHT_TO_LEFT flag set
    const b = pbuf([[10, 600], [11, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['curs'], false); // ltr run (default)
    expect(b[0].xAdvance).toBe(500);        // LTR main-direction: prev advance clamped to exit.x
    expect(b[1].xOffset).toBe(-30);
    expect(b[1].xAdvance).toBe(700 - 30);
    expect(b[0].yOffset).toBe(-60);         // entry.y - exit.y; child = prev (flag)
    expect(b[1].yOffset).toBe(0);           // cur is the parent, not attached
  });
});

describe('GSUB type 4 Ligature component tracking', () => {
  it('assigns ligId/ligComp to marks interspersed among ligature components', () => {
    const t = parseOtTable(buildGsub([ligatureLookup('liga', 1, [2], 9, 0x0008)]))!; // IGNORE_MARKS
    const gdef = parseGdef(buildGdefClasses([[3, 3], [4, 3]]));   // gid3,gid4 = marks
    const b = buf([1, 3, 2, 4]);                                  // b1, m1, b2, m2
    applyGsub(t, b, gdef, 'latn', undefined, ['liga']);
    expect(b.map((x) => x.gid)).toEqual([9, 3, 4]);              // ligature keeps interspersed/trailing marks
    expect(b[1].ligComp).toBe(0);           // m1 between comp 0 and comp 1 -> comp 0
    expect(b[2].ligComp).toBe(1);           // m2 trails last component -> comp 1
    expect(b[0].ligId).toBeGreaterThan(0);
    expect(b[1].ligId).toBe(b[0].ligId);
    expect(b[2].ligId).toBe(b[0].ligId);
  });
});

describe('GPOS type 5 Mark-to-ligature (format 1)', () => {
  it('attaches each mark to the anchor of its own ligature component', () => {
    const t = parseOtTable(buildGpos([markLigLookup('mark',
      [{ gid: 3, cls: 0, anchor: { x: 10, y: 0 } }],
      9,
      [[{ x: 200, y: 0 }], [{ x: 600, y: 0 }]],           // comp0 anchor, comp1 anchor
    )]))!;
    const gdef = parseGdef(buildGdefClasses([[3, 3], [9, 2]]));  // gid3 mark, gid9 ligature
    const onComp1: ShapedGlyph[] = [
      { gid: 9, cluster: 0, xAdvance: 1000, xOffset: 0, yOffset: 0, ligId: 7, ligComp: 0 },
      { gid: 3, cluster: 1, xAdvance: 0, xOffset: 0, yOffset: 0, ligId: 7, ligComp: 1 },
    ];
    applyGpos(t, onComp1, gdef, 'latn', undefined, ['mark']);
    expect(onComp1[1].xOffset).toBe((600 - 10) - 1000);  // comp1 anchor - mark - ligAdvance
    const onComp0: ShapedGlyph[] = [
      { gid: 9, cluster: 0, xAdvance: 1000, xOffset: 0, yOffset: 0, ligId: 7, ligComp: 0 },
      { gid: 3, cluster: 1, xAdvance: 0, xOffset: 0, yOffset: 0, ligId: 7, ligComp: 0 },
    ];
    applyGpos(t, onComp0, gdef, 'latn', undefined, ['mark']);
    expect(onComp0[1].xOffset).toBe((200 - 10) - 1000);  // comp0 anchor
  });

  it('end-to-end: ligation tracks components, marks land on them', () => {
    const f = parseSfnt(buildOtFont({
      gsub: buildGsub([ligatureLookup('liga', 1, [2], 9, 0x0008)]),
      gpos: buildGpos([markLigLookup('mark',
        [{ gid: 3, cls: 0, anchor: { x: 10, y: 20 } }],
        9, [[{ x: 200, y: 0 }], [{ x: 600, y: 0 }]])]),
      gdef: buildGdefClasses([[1, 1], [2, 1], [3, 3], [9, 2]]),
    }));
    // logical [b1, m1, b2] -> ligate b1+b2 -> [L, m1]; m1 was between comps -> comp 0
    const out = applyFeatures(f, [
      { gid: 1, cluster: 0 }, { gid: 3, cluster: 1 }, { gid: 2, cluster: 2 },
    ], { features: ['liga', 'mark'] });
    expect(out.map((g) => g.gid)).toEqual([9, 3]);
    expect(out[1].xOffset).toBe((200 - 10) - f.advanceWidth(9));  // comp 0 anchor
    expect(out[1].yOffset).toBe(0 - 20);
  });
});

describe('GPOS type 7 Contextual (format 2, class-based) + nested', () => {
  it('applies a nested single-adjust when input classes match', () => {
    // classDef: gid 4 -> class 1, gid 5 -> class 2. Rule set for class 1 fires when
    // the second glyph is class 2, applying nested lookup 0 (+20 xAdvance) at seq 1.
    const t = parseOtTable(buildGpos([
      singleAdjustLookup('__nested', 5, 0, 20),
      contextLookupFmt2('kern', [[4, 1], [5, 2]], [
        [],
        [{ input: [2], recs: [{ seqIndex: 1, lookupIndex: 0 }] }],
        [],
      ], 7),
    ]))!;
    const yes = pbuf([[4, 100], [5, 200]]);
    applyGpos(t, yes, undefined, 'latn', undefined, ['kern']);
    expect(yes[1].xAdvance).toBe(220);
    const no = pbuf([[4, 100], [6, 200]]);
    applyGpos(t, no, undefined, 'latn', undefined, ['kern']);
    expect(no[1].xAdvance).toBe(200);
  });
});

describe('GPOS type 8 Chaining (format 2, class-based) + nested', () => {
  it('applies a nested single-adjust gated by backtrack/lookahead classes', () => {
    const t = parseOtTable(buildGpos([
      singleAdjustLookup('__nested', 5, 0, 20),
      chainContextLookupFmt2('kern',
        [[4, 1]], [[5, 1]], [[6, 1]],
        [
          [],
          [{ back: [1], input: [], ahead: [1], recs: [{ seqIndex: 0, lookupIndex: 0 }] }],
        ], 8),
    ]))!;
    const yes = pbuf([[4, 100], [5, 200], [6, 300]]);
    applyGpos(t, yes, undefined, 'latn', undefined, ['kern']);
    expect(yes[1].xAdvance).toBe(220);
    const no = pbuf([[9, 100], [5, 200], [6, 300]]);   // backtrack class 0
    applyGpos(t, no, undefined, 'latn', undefined, ['kern']);
    expect(no[1].xAdvance).toBe(200);
  });
});

describe('GPOS type 8 Chaining (format 3) + nested', () => {
  it('applies a nested single-adjust only in context', () => {
    // lookup0 = Single adjust gid5 xAdvance +20 (nested). lookup1 = Chain fmt3 back{4} input{5} -> seq(0,0).
    const t = parseOtTable(buildGpos([
      singleAdjustLookup('__nested', 5, 0, 20),
      chainLookup('kern', [[4]], [[5]], [], [{ seqIndex: 0, lookupIndex: 0 }], 8),
    ]))!;
    const inCtx = pbuf([[4, 100], [5, 200]]);
    applyGpos(t, inCtx, undefined, 'latn', undefined, ['kern']);
    expect(inCtx[1].xAdvance).toBe(220);
    const noCtx = pbuf([[5, 200]]);
    applyGpos(t, noCtx, undefined, 'latn', undefined, ['kern']);
    expect(noCtx[0].xAdvance).toBe(200);
  });
});

describe('GPOS type 9 Extension', () => {
  it('unwraps an extension to a Pair kern', () => {
    const t = parseOtTable(buildGpos([extensionLookup('kern', pairKernLookup('kern', 1, 2, -40), 9)]))!;
    const b = pbuf([[1, 500], [2, 500]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xAdvance).toBe(460);
  });
});

describe('applyFeatures degradation', () => {
  it('a font with no GSUB/GPOS/GDEF passes glyphs through with hmtx advances', () => {
    const f = parseSfnt(buildMinimalTtf()); // no OT layout tables
    expect(f.otLayout()).toBeUndefined();
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], {});
    expect(out.map((g) => g.gid)).toEqual([1, 2]);
    expect(out.map((g) => g.xAdvance)).toEqual([f.advanceWidth(1), f.advanceWidth(2)]);
    expect(out.every((g) => g.xOffset === 0 && g.yOffset === 0)).toBe(true);
  });
  it('malformed GSUB bytes degrade to pass-through (never throw)', () => {
    const f = parseSfnt(buildOtFont({ gsub: new Uint8Array([0, 1, 0, 0, 0, 99]) }));
    expect(() => applyFeatures(f, [{ gid: 1, cluster: 0 }], { features: ['liga'] })).not.toThrow();
  });
});

describe('applyFeatures end-to-end (liga)', () => {
  it('shapes f+i -> fi using a synthetic GSUB Ligature font', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([ligatureLookup('liga', 1, [2], 9)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['liga'] });
    expect(out.map((g) => g.gid)).toEqual([9]);
    expect(out[0].cluster).toBe(0);
    expect(out[0].xAdvance).toBe(f.advanceWidth(9));
  });
});

describe('otlayout acceptance (synthetic fonts, via applyFeatures)', () => {
  it('liga: f+i -> fi', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([ligatureLookup('liga', 1, [2], 9)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['liga'] });
    expect(out.map((g) => g.gid)).toEqual([9]);
  });

  it('calt: contextual single subst 5->99 only after 4', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      chainLookup('calt', [[4]], [[5]], [], [{ seqIndex: 0, lookupIndex: 0 }]), // lookup 1
    ]) }));
    const yes = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 5, cluster: 1 }], { features: ['calt'] });
    expect(yes.map((g) => g.gid)).toEqual([4, 99]);
    const no = applyFeatures(f, [{ gid: 5, cluster: 0 }], { features: ['calt'] });
    expect(no.map((g) => g.gid)).toEqual([5]);
  });

  it('Arabic init/medi/fina select positional forms by feature', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([
      singleSubstDelta('init', 20, 1),  // 20->21
      singleSubstDelta('medi', 20, 2),  // 20->22
      singleSubstDelta('fina', 20, 3),  // 20->23
    ]) }));
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['init'] })[0].gid).toBe(21);
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['medi'] })[0].gid).toBe(22);
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['fina'] })[0].gid).toBe(23);
  });

  it('kern: pair adds an advance delta', () => {
    const f = parseSfnt(buildOtFont({ gpos: buildGpos([pairKernLookup('kern', 1, 2, -40)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['kern'] });
    expect(out[0].xAdvance).toBe(f.advanceWidth(1) - 40);
  });

  it('calt (class-based fmt2): contextual subst selected by glyph classes', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      contextLookupFmt2('calt', [[4, 1], [5, 2]], [
        [], [{ input: [2], recs: [{ seqIndex: 1, lookupIndex: 0 }] }], [],
      ], 5),
    ]) }));
    const yes = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 5, cluster: 1 }], { features: ['calt'] });
    expect(yes.map((g) => g.gid)).toEqual([4, 99]);
    const no = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 6, cluster: 1 }], { features: ['calt'] });
    expect(no.map((g) => g.gid)).toEqual([4, 6]);
  });

  it('fmt2 rule with a 3-glyph input matches only the full class sequence', () => {
    // input class 1 (gid 4) selects a rule requiring next two glyphs classes [2, 3].
    const t = parseOtTable(buildGsub([
      singleSubstDelta('__nested', 4, 90),                 // lookup 0: 4 -> 94
      contextLookupFmt2('calt', [[4, 1], [5, 2], [6, 3]], [
        [], [{ input: [2, 3], recs: [{ seqIndex: 0, lookupIndex: 0 }] }], [], [],
      ], 5),
    ]))!;
    const full = buf([4, 5, 6]);
    applyGsub(t, full, undefined, 'latn', undefined, ['calt']);
    expect(full.map((x) => x.gid)).toEqual([94, 5, 6]);
    const partial = buf([4, 5, 9]);                        // third glyph class 0
    applyGsub(t, partial, undefined, 'latn', undefined, ['calt']);
    expect(partial.map((x) => x.gid)).toEqual([4, 5, 9]);
  });

  it('mark-to-base: mark placed on base anchor', () => {
    const f = parseSfnt(buildOtFont({
      gpos: buildGpos([markBaseLookup('mark', 3, { x: 10, y: -50 }, 4, { x: 300, y: 0 })]),
      gdef: buildGdefClasses([[3, 3], [4, 1]]),
    }));
    const out = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 3, cluster: 1 }], { features: ['mark'] });
    expect(out[1].xOffset).toBe((300 - 10) - f.advanceWidth(4));
    expect(out[1].yOffset).toBe(50);
  });
});
