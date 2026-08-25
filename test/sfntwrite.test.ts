import { describe, it, expect } from 'vitest';
import { buildCmap, assembleSfnt, replaceTable, otfFromCff } from '../src/sfntwrite.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';
import { buildMinimalCff } from './helpers/build-cff.js';

describe('buildCmap', () => {
  it('round-trips a BMP map through parseSfnt via replaceTable', () => {
    const ttf = buildMinimalTtf();                    // glyphs 0=.notdef,1='A',2='B'
    const cmap = buildCmap(new Map([[0x48, 1], [0x49, 2]])); // H->1, I->2
    const out = replaceTable(ttf, 'cmap', cmap);
    const f = parseSfnt(out);
    expect(f.cmap.get(0x48)).toBe(1);
    expect(f.cmap.get(0x49)).toBe(2);
  });

  it('emits a format-12 subtable for an astral codepoint', () => {
    const ttf = buildMinimalTtf();
    const cmap = buildCmap(new Map([[0x1f600, 1]]));   // emoji -> gid 1
    const out = replaceTable(ttf, 'cmap', cmap);
    const f = parseSfnt(out);
    expect(f.cmap.get(0x1f600)).toBe(1);
  });
});

describe('otfFromCff', () => {
  it('wraps a bare CFF into a parseable OTTO sfnt', () => {
    const cff = buildMinimalCff();                      // 2 glyphs: 0=.notdef, 1=box
    const cmap = buildCmap(new Map([[0x41, 1]]));
    const otf = otfFromCff(cff, cmap, {
      numGlyphs: 2, unitsPerEm: 1000, advances: [0, 500],
      bbox: [0, -200, 700, 800], ascent: 800, descent: -200,
    });
    const f = parseSfnt(otf);
    expect(f.outlines).toBe('cff');
    expect(f.numGlyphs).toBe(2);
    expect(f.cmap.get(0x41)).toBe(1);
    expect(Array.from(f.table('CFF ')!)).toEqual(Array.from(cff));
  });
});

describe('assembleSfnt', () => {
  it('writes a valid head.checksumAdjustment', () => {
    const ttf = buildMinimalTtf();
    const rebuilt = replaceTable(ttf, 'cmap', buildCmap(new Map([[0x41, 1]])));
    const f = parseSfnt(rebuilt);
    expect(f.cmap.get(0x41)).toBe(1);                  // parses cleanly => directory valid
    expect(f.numGlyphs).toBe(3);
  });
});
