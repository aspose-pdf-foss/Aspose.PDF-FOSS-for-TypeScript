import { describe, it, expect } from 'vitest';
import { parseCffProgram, parseDictSpans } from '../src/cffsubset.js';
import { buildMinimalCff, buildCidCff } from './helpers/build-cff.js';

describe('parseCffProgram', () => {
  it('parses a non-CID program: glyphs, no CID, single FD', () => {
    const p = parseCffProgram(buildMinimalCff());
    expect(p.numGlyphs).toBe(2);
    expect(p.isCID).toBe(false);
    expect(p.charStrings.length).toBe(2);
    expect(p.fdCount).toBe(1);
    expect(p.fdOf(1)).toBe(0);
    expect(p.localSubrsOf(0)).toEqual([]);
  });

  it('parses a CID-keyed program with FDArray/FDSelect', () => {
    const p = parseCffProgram(buildCidCff());
    expect(p.isCID).toBe(true);
    expect(p.numGlyphs).toBe(2);
    expect(p.fdCount).toBeGreaterThanOrEqual(1);
    expect(p.fdOf(1)).toBe(0);
  });
});

import { flattenGlyph } from '../src/cffsubset.js';
import { buildRichCff } from './helpers/build-cff.js';
import { CffFont } from '../src/cff.js';
import { bias } from '../src/cff.js';

describe('buildRichCff fixture', () => {
  it('parses to 6 glyphs, 2 global subrs, 2 local subrs; gid1 renders the box', () => {
    const p = parseCffProgram(buildRichCff());
    expect(p.numGlyphs).toBe(6);
    expect(p.globalSubrs.length).toBe(2);
    expect(p.localSubrsOf(0).length).toBe(2);
    const f = new CffFont(buildRichCff());
    expect(f.glyphPath(1)).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });
});

describe('flattenGlyph', () => {
  function ctxFor() {
    const p = parseCffProgram(buildRichCff());
    return {
      p,
      ctx: {
        localSubrs: p.localSubrsOf(0), localBias: bias(p.localSubrsOf(0).length),
        globalSubrs: p.globalSubrs, globalBias: bias(p.globalSubrs.length),
      },
    };
  }

  it('inlines a global subr call, dropping the index literal and call op', () => {
    const { p, ctx } = ctxFor();
    // gid1 = [33,29,14] -> box body (boxG minus return) + endchar.
    expect([...flattenGlyph(p.charStrings[1], ctx)]).toEqual(
      [239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 14],
    );
  });

  it('inlines a local subr call', () => {
    const { p, ctx } = ctxFor();
    // gid2 = [33,10,14] -> boxL body (minus return) + endchar.
    expect([...flattenGlyph(p.charStrings[2], ctx)]).toEqual(
      [239, 139, 21, 139, 189, 5, 14],
    );
  });

  it('leaves a subr-free glyph byte-identical', () => {
    const { p, ctx } = ctxFor();
    expect([...flattenGlyph(p.charStrings[3], ctx)]).toEqual([...p.charStrings[3]]);
  });
});

import { assembleCidCff, writeIndex } from '../src/cffsubset.js';
import { readIndex } from '../src/cff.js';

describe('writeIndex', () => {
  it('round-trips through readIndex', () => {
    const items = [Uint8Array.from([1, 2, 3]), Uint8Array.from([]), Uint8Array.from([9])];
    const idx = writeIndex(items);
    const v = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    const back = readIndex(idx, v, 0);
    expect(back.items.map((x) => [...x])).toEqual([[1, 2, 3], [], [9]]);
    expect(back.end).toBe(idx.length);
  });
  it('emits an empty INDEX as a 2-byte zero count', () => {
    expect([...writeIndex([])]).toEqual([0, 0]);
  });
});

describe('assembleCidCff', () => {
  it('assembles a CID-keyed CFF that CffFont parses and renders', () => {
    const box = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 14]);
    const bytes = assembleCidCff([new TextEncoder().encode('SUB')], [Uint8Array.from([14]), box], [0, 7]);
    const f = new CffFont(bytes);
    expect(f.isCID).toBe(true);
    expect(f.numGlyphs).toBe(2);
    expect(f.cidToGid(7)).toBe(1);        // charset maps CID 7 -> subset gid 1
    expect(f.glyphPath(1)).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });
});

import { subsetCff } from '../src/cffsubset.js';
import { buildManyGlyphCff, buildNameKeyedCff } from './helpers/build-cff.js';

describe('subsetCff (end to end)', () => {
  it('preserves outlines through inlining + renumbering and maps CID->subsetGID', () => {
    const orig = new CffFont(buildRichCff());
    const { bytes, gidMap } = subsetCff(buildRichCff(), [1, 2, 4]);   // keep {0,1,2,4}
    expect([...gidMap.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [1, 1], [2, 2], [4, 3]]);
    const sub = new CffFont(bytes);
    expect(sub.isCID).toBe(true);
    expect(sub.numGlyphs).toBe(4);
    for (const [origG, subG] of gidMap) {
      expect(sub.cidToGid(origG)).toBe(subG);                   // charset: CID(=origGID) -> subsetGID
      expect(sub.glyphPath(subG)).toEqual(orig.glyphPath(origG)); // outline preserved
    }
  });

  it('drops unused glyphs and empties the subr INDEXes', () => {
    const { bytes } = subsetCff(buildRichCff(), [3]);   // keep {0,3}
    const p = parseCffProgram(bytes);
    expect(p.numGlyphs).toBe(2);                  // was 6
    expect(p.globalSubrs.length).toBe(0);         // inlined away (were 2)
    expect(p.localSubrsOf(0).length).toBe(0);     // were 2
  });

  it('shrinks a many-glyph font subset to a handful of glyphs', () => {
    const original = buildManyGlyphCff(40);
    const orig = new CffFont(original);
    const { bytes, gidMap } = subsetCff(original, [1, 7]);   // keep {0,1,7}
    const sub = new CffFont(bytes);
    expect(sub.numGlyphs).toBe(3);
    expect(bytes.length).toBeLessThan(original.length);
    for (const [origG, subG] of gidMap) expect(sub.glyphPath(subG)).toEqual(orig.glyphPath(origG));
  });

  it('subsets a bare non-CID CFF (buildMinimalCff) to a CID-keyed CFF', () => {
    const orig = new CffFont(buildMinimalCff());
    const { bytes, gidMap } = subsetCff(buildMinimalCff(), [1]);
    const sub = new CffFont(bytes);
    expect(sub.isCID).toBe(true);
    expect(sub.cidToGid(1)).toBe(gidMap.get(1));
    expect(sub.glyphPath(gidMap.get(1)!)).toEqual(orig.glyphPath(1));
  });

  it('always retains gid 0 (.notdef) even if unused', () => {
    const { gidMap } = subsetCff(buildRichCff(), [3]);
    expect(gidMap.get(0)).toBe(0);
    expect(gidMap.get(3)).toBe(1);
  });
});

describe('parseDictSpans', () => {
  it('returns each operator with its raw operand bytes', () => {
    const d = Uint8Array.from([29, 0, 0, 0, 42, 17]);   // dictInt5(42) CharStrings
    const spans = parseDictSpans(d);
    expect(spans.length).toBe(1);
    expect(spans[0].op).toBe(17);
    expect([...spans[0].operands]).toEqual([29, 0, 0, 0, 42]);
  });

  it('keys a two-byte operator as 0xc00 | b1', () => {
    const d = Uint8Array.from([139, 12, 30]);            // operand 0, then ROS
    expect(parseDictSpans(d)[0].op).toBe(0xc1e);
  });

  it('preserves a real (BCD) operand verbatim', () => {
    // 30 = real marker; nibbles a=. 1 f=terminator  => ".1"
    const d = Uint8Array.from([30, 0xa1, 0xff, 12, 7]);  // FontMatrix
    const spans = parseDictSpans(d);
    expect(spans[0].op).toBe(0xc07);
    expect([...spans[0].operands]).toEqual([30, 0xa1, 0xff]);
  });

  it('carries every operand width the DICT grammar allows', () => {
    // 28 = int16, 29 = int32, 32..246 = 1 byte, 247..250 and 251..254 = 2 bytes
    const d = Uint8Array.from([28, 1, 2, 139, 247, 0, 251, 0, 29, 0, 0, 0, 1, 17]);
    const spans = parseDictSpans(d);
    expect(spans.length).toBe(1);
    expect([...spans[0].operands]).toEqual([28, 1, 2, 139, 247, 0, 251, 0, 29, 0, 0, 0, 1]);
  });

  it('round-trips a dict when every span is re-emitted unchanged', () => {
    const d = Uint8Array.from([29, 0, 0, 0, 42, 17, 139, 12, 30]);
    const out: number[] = [];
    for (const s of parseDictSpans(d)) {
      out.push(...s.operands);
      if (s.op > 0xc00) out.push(12, s.op & 0xff); else out.push(s.op);
    }
    expect(out).toEqual([...d]);
  });
});

describe('parseDictSpans on real font data', () => {
  it('round-trips a real Top DICT byte-for-byte, Private two-operand span included', () => {
    const cff = buildNameKeyedCff();
    const v = new DataView(cff.buffer, cff.byteOffset, cff.byteLength);
    const nameEnd = readIndex(cff, v, v.getUint8(2)).end;
    const top = readIndex(cff, v, nameEnd).items[0];

    const spans = parseDictSpans(top);
    expect(spans.map((s) => s.op)).toEqual([15, 16, 17, 18]);  // charset, Encoding, CharStrings, Private
    expect(spans[3].operands.length).toBe(10);                 // Private carries [size, offset]

    const out: number[] = [];
    for (const s of spans) {
      out.push(...s.operands);
      if (s.op > 0xc00) out.push(12, s.op & 0xff); else out.push(s.op);
    }
    expect(out).toEqual([...top]);
  });
});
