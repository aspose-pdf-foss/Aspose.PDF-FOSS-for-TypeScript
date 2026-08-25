import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { buildClosureTtf, makeOttoWithCff } from './helpers/build-sfnt.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import {
  assembleSfnt, cat, glyphClosure, OTTO_TAG, remapCompositeGlyph, subsetGlyf, u16b, u32b,
} from '../src/subset.js';

describe('glyphClosure', () => {
  it('always includes .notdef and the used gids', () => {
    const f = parseSfnt(buildClosureTtf());
    expect([...glyphClosure(f, [2])].sort((a, b) => a - b)).toEqual([0, 2]);
  });
  it('pulls in composite component gids transitively', () => {
    const f = parseSfnt(buildClosureTtf());
    // gid 3 is composite -> gid 2; closure must include {0, 2, 3}
    expect([...glyphClosure(f, [3])].sort((a, b) => a - b)).toEqual([0, 2, 3]);
  });
});

describe('remapCompositeGlyph', () => {
  it('rewrites composite component gids through the map', () => {
    const f = parseSfnt(buildClosureTtf());
    const g3 = f.glyphData(3); // composite -> component gid 2
    const out = remapCompositeGlyph(g3, new Map([[2, 1]]));
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(v.getInt16(0)).toBeLessThan(0);   // still composite
    expect(v.getUint16(12)).toBe(1);          // component gid 2 -> 1 (at offset 10+2)
  });
  it('returns simple glyphs unchanged', () => {
    const f = parseSfnt(buildClosureTtf());
    const g2 = f.glyphData(2);
    expect(Array.from(remapCompositeGlyph(g2, new Map([[2, 1]])))).toEqual(Array.from(g2));
  });
});

describe('subsetGlyf', () => {
  it('produces a re-parseable subset preserving advances and remapped components', () => {
    const f = parseSfnt(buildClosureTtf());
    const { bytes, gidMap } = subsetGlyf(f, [3]); // closure {0,2,3} -> map 0:0, 2:1, 3:2
    expect([...gidMap.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [2, 1], [3, 2]]);

    const sub = parseSfnt(bytes);
    expect(sub.numGlyphs).toBe(3);
    expect(sub.advanceWidth(1)).toBe(700); // original gid 2
    expect(sub.advanceWidth(2)).toBe(800); // original gid 3
    expect(sub.componentGids(2)).toEqual([1]); // gid3's component (orig 2) -> subset 1
  });

  it('keeps .notdef and drops unused glyphs', () => {
    const f = parseSfnt(buildClosureTtf());
    const { gidMap } = subsetGlyf(f, [2]); // closure {0,2}
    expect([...gidMap.keys()].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it('rejects a non-glyf font', () => {
    const cff = parseSfnt(makeOttoWithCff()); // outlines 'cff'
    expect(() => subsetGlyf(cff, [1])).toThrow(UnsupportedFeatureError);
  });
});

describe('assembleSfnt', () => {
  it('emits the TrueType sfnt tag by default', () => {
    const out = assembleSfnt([{ tag: 'test', data: Uint8Array.from([1, 2, 3]) }]);
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(v.getUint32(0)).toBe(0x00010000);
    expect(v.getUint16(4)).toBe(1); // numTables
  });

  it('emits the OTTO tag when asked', () => {
    const out = assembleSfnt([{ tag: 'CFF ', data: Uint8Array.from([9]) }], OTTO_TAG);
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(v.getUint32(0)).toBe(0x4f54544f);
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe('CFF ');
  });

  it('exports byte helpers', () => {
    expect([...cat([u16b(1), u32b(2)])]).toEqual([0, 1, 0, 0, 0, 2]);
  });
});
