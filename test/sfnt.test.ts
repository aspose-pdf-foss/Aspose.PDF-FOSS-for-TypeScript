import { describe, it, expect } from 'vitest';
import {
  buildMinimalTtf, makeOttoWithCff, stripTable, buildClosureTtf,
  buildCmapTable, cmapFormat0, cmapFormat4, cmapFormat6, buildPostV2,
} from './helpers/build-sfnt.js';
import { parseSfnt } from '../src/sfnt.js';
import { PdfParseError } from '../src/errors.js';

describe('build-sfnt fixture', () => {
  it('emits a TrueType sfnt header with 10 tables', () => {
    const ttf = buildMinimalTtf();
    const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    expect(v.getUint32(0)).toBe(0x00010000); // sfnt version 1.0 (TrueType)
    expect(v.getUint16(4)).toBe(10);          // numTables
  });
});

describe('parseSfnt: directory', () => {
  it('reads the table directory and reports a glyf TrueType font', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.outlines).toBe('glyf');
    expect(f.numGlyphs).toBe(3);
  });

  it('throws PdfParseError on a truncated header', () => {
    expect(() => parseSfnt(new Uint8Array([0, 1, 0]))).toThrow(/PdfParseError|unexpected end/i);
  });
});

describe('parseSfnt: head', () => {
  it('reads unitsPerEm, loca format, and bbox', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.unitsPerEm).toBe(1000);
    expect(f.indexToLocFormat).toBe(0);
    expect(f.bbox).toEqual([0, -200, 700, 800]);
  });
});

describe('parseSfnt: hmtx', () => {
  it('returns advance widths per glyph', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.advanceWidth(0)).toBe(500);
    expect(f.advanceWidth(1)).toBe(600);
    expect(f.advanceWidth(2)).toBe(700);
    expect(f.advanceWidth(99)).toBe(700); // beyond numberOfHMetrics -> last advance
  });
});

describe('parseSfnt: cmap', () => {
  it('maps code points to glyph ids (format 4)', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.cmapLookup(0x41)).toBe(1); // 'A'
    expect(f.cmapLookup(0x42)).toBe(2); // 'B'
    expect(f.cmapLookup(0x43)).toBeUndefined(); // 'C' unmapped
  });
  it('inverts the cmap (gid -> first code point)', () => {
    const rev = parseSfnt(buildMinimalTtf()).cmapReverse();
    expect(rev.get(1)).toBe(0x41);
    expect(rev.get(2)).toBe(0x42);
  });
});

describe('parseSfnt: cmapSubtable', () => {
  it('returns the named subtable, not the best Unicode one', () => {
    // A symbol (3,0) subtable alongside a Unicode (3,1) one. `cmap` resolves to
    // the Unicode table; cmapSubtable must hand back exactly what was asked for.
    const f = parseSfnt(buildMinimalTtf({
      cmap: buildCmapTable([
        { plat: 3, enc: 0, data: cmapFormat4([[0xf041, 2]]) },
        { plat: 3, enc: 1, data: cmapFormat4([[0x41, 1]]) },
      ]),
    }));
    expect(f.cmapLookup(0x41)).toBe(1);                  // best-Unicode selection
    expect(f.cmapSubtable(3, 0)!.get(0xf041)).toBe(2);
    expect(f.cmapSubtable(3, 0)!.get(0x41)).toBeUndefined();
    expect(f.cmapSubtable(3, 1)!.get(0x41)).toBe(1);
  });

  it('is undefined for an absent subtable and for a font with no cmap', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.cmapSubtable(3, 1)).toBeDefined();
    expect(f.cmapSubtable(1, 0)).toBeUndefined();
    expect(parseSfnt(stripTable(buildMinimalTtf(), 'cmap')).cmapSubtable(3, 1)).toBeUndefined();
  });

  it('parses format 0 (the Mac (1,0) shape)', () => {
    const f = parseSfnt(buildMinimalTtf({
      cmap: buildCmapTable([{ plat: 1, enc: 0, data: cmapFormat0({ 0x41: 1, 0x42: 2 }) }]),
    }));
    const sub = f.cmapSubtable(1, 0)!;
    expect(sub.get(0x41)).toBe(1);
    expect(sub.get(0x42)).toBe(2);
    expect(sub.get(0x43)).toBeUndefined();   // gid 0 is not a mapping
  });

  it('parses format 6 (a trimmed contiguous run)', () => {
    const f = parseSfnt(buildMinimalTtf({
      cmap: buildCmapTable([{ plat: 3, enc: 0, data: cmapFormat6(0xf041, [1, 2]) }]),
    }));
    const sub = f.cmapSubtable(3, 0)!;
    expect(sub.get(0xf041)).toBe(1);
    expect(sub.get(0xf042)).toBe(2);
    expect(sub.get(0xf043)).toBeUndefined();
  });
});

describe('parseSfnt: postNames', () => {
  it('reads custom glyph names from a post v2.0 table', () => {
    const f = parseSfnt(buildMinimalTtf({ post: buildPostV2(['.notdef', 'g01', 'g02']) }));
    expect(f.postNames()).toEqual(['.notdef', 'g01', 'g02']);
  });

  it('is undefined for post v3.0, which carries no names', () => {
    expect(parseSfnt(buildMinimalTtf()).postNames()).toBeUndefined();
  });
});

describe('parseSfnt: glyf', () => {
  it('returns raw glyph data sized by loca', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.glyphData(0).length).toBe(0);  // .notdef empty
    expect(f.glyphData(1).length).toBe(10); // simple glyph
    expect(f.glyphData(2).length).toBe(18); // composite glyph
  });
  it('extracts composite component gids', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.componentGids(1)).toEqual([]);  // simple
    expect(f.componentGids(2)).toEqual([1]); // composite -> gid 1
  });
});

describe('parseSfnt: descriptor metadata', () => {
  it('derives descriptor fields from name/OS2/post', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.postScriptName).toBe('TestFont');
    expect(f.ascent).toBe(800);
    expect(f.descent).toBe(-200);
    expect(f.capHeight).toBe(700);
    expect(f.italicAngle).toBe(0);
    expect(f.flags & 32).toBe(32);   // Nonsymbolic
    expect(f.stemV).toBeGreaterThan(0);
  });
});

describe('parseSfnt: edge cases', () => {
  it('routes WOFF containers through the unwrapper (malformed → PdfParseError)', () => {
    // WOFF/WOFF2 are now unwrapped to sfnt (see woff.test.ts for round-trips);
    // a truncated container surfaces as PdfParseError, not UnsupportedFeatureError.
    const woff = new Uint8Array(16); new DataView(woff.buffer).setUint32(0, 0x774F4646);
    expect(() => parseSfnt(woff)).toThrow(PdfParseError);
  });

  it('reports a CFF OpenType font as cff outlines without requiring glyf', () => {
    const f = parseSfnt(makeOttoWithCff());
    expect(f.outlines).toBe('cff');
    expect(f.unitsPerEm).toBe(1000);
    expect(f.glyphData(1).length).toBe(0); // cff: no glyf access
  });

  it('throws PdfParseError when a required table is missing', () => {
    const noMaxp = stripTable(buildMinimalTtf(), 'maxp');
    expect(() => parseSfnt(noMaxp)).toThrow(PdfParseError);
  });
});

describe('parseSfnt: cmap is optional', () => {
  it('parses a glyf font with no cmap (subset fonts have none)', () => {
    const noCmap = stripTable(buildMinimalTtf(), 'cmap');
    const f = parseSfnt(noCmap);
    expect(f.outlines).toBe('glyf');
    expect(f.cmap.size).toBe(0);
  });
  it('builds a 4-glyph closure fixture', () => {
    expect(parseSfnt(buildClosureTtf()).numGlyphs).toBe(4);
  });
});
