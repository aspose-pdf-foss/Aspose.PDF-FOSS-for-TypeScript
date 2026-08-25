import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { shrinkCff, shrinkGlyf, shrinkNameKeyedCff } from '../src/fontshrink.js';
import { CffFont } from '../src/cff.js';
import { parseCffProgram } from '../src/cffsubset.js';
import { buildUnicodeTtf, buildPostV2 } from './helpers/build-sfnt.js';
import { buildManyGlyphCff, buildNameKeyedCff } from './helpers/build-cff.js';
import { buildManyGlyphTtf, customGlyphNames } from './helpers/build-optimize-pdf.js';

describe('shrinkGlyf', () => {
  it('keeps numGlyphs and GID numbering intact', () => {
    const font = parseSfnt(buildUnicodeTtf());
    const out = parseSfnt(shrinkGlyf(font, new Set([1])).bytes);
    expect(out.numGlyphs).toBe(font.numGlyphs);
  });

  it('preserves the outline of a kept glyph and blanks an unkept one', () => {
    const font = parseSfnt(buildUnicodeTtf());
    // Font has gid 0=.notdef, 1='A' (simple), 2='B' (composite -> 1).
    const out = parseSfnt(shrinkGlyf(font, new Set([1])).bytes);
    expect([...out.glyphData(1)]).toEqual([...font.glyphData(1)]);
    expect(out.glyphData(2).length).toBe(0);
  });

  it('closes over composite components so a kept composite still renders', () => {
    const font = parseSfnt(buildUnicodeTtf());
    const res = shrinkGlyf(font, new Set([2])); // composite -> pulls in gid 1
    const out = parseSfnt(res.bytes);
    expect(out.glyphData(2).length).toBeGreaterThan(0);
    expect(out.glyphData(1).length).toBeGreaterThan(0); // component survived
    expect(res.gidsKept).toBe(3); // {0, 1, 2}
    expect(res.gidsDropped).toBe(0);
  });

  it('preserves cmap so existing code->GID mappings still resolve', () => {
    const font = parseSfnt(buildUnicodeTtf());
    const out = parseSfnt(shrinkGlyf(font, new Set([1])).bytes);
    expect(out.cmapLookup(0x41)).toBe(font.cmapLookup(0x41));
  });

  it('drops layout tables and shrinks the program', () => {
    const font = parseSfnt(buildUnicodeTtf());
    const res = shrinkGlyf(font, new Set([1]));
    expect(parseSfnt(res.bytes).tables.has('post')).toBe(true); // post survives; only its names are droppable
    expect(res.bytes.length).toBeLessThan(font.raw.length);
    expect(res.gidsDropped).toBe(1); // gid 2 dropped
  });
});

/** A 200-glyph font whose post v2.0 names every glyph `g00`..`g199`.
 *  buildUnicodeTtf carries a v3.0 post — already nameless, so it cannot
 *  exercise the downgrade. */
const namedFont = (header?: { italicAngle?: number; underlinePosition?: number; isFixedPitch?: number }) =>
  parseSfnt(buildManyGlyphTtf(200, { post: buildPostV2(customGlyphNames(200), header) }));

const postOf = (bytes: Uint8Array): DataView => {
  const t = parseSfnt(bytes).table('post')!;
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
};

describe('shrinkGlyf — post glyph names', () => {
  it('rewrites post 2.0 to 3.0 when names are dropped', () => {
    const font = namedFont();
    expect(font.postNames()![3]).toBe('g03');            // v2.0 going in
    const res = shrinkGlyf(font, new Set([1]), { dropGlyphNames: true });
    const out = parseSfnt(res.bytes);
    expect(out.postNames()).toBeUndefined();             // names gone
    expect(out.table('post')!.length).toBe(32);          // header only
    expect(postOf(res.bytes).getUint32(0)).toBe(0x00030000);
  });

  it('carries over the header fields v3.0 keeps', () => {
    const font = namedFont({ italicAngle: -15 << 16, underlinePosition: -100, isFixedPitch: 1 });
    const v = postOf(shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes);
    expect(v.getInt32(4)).toBe(-15 << 16);
    expect(v.getInt16(8)).toBe(-100);
    expect(v.getUint32(12)).toBe(1);
  });

  it('keeps post verbatim by default', () => {
    const font = namedFont();
    const out = parseSfnt(shrinkGlyf(font, new Set([1])).bytes);
    expect([...out.table('post')!]).toEqual([...font.table('post')!]);
  });

  it('leaves a post that is not v2.0 alone', () => {
    // buildManyGlyphTtf's default post is v3.0 — already nameless.
    const v3 = parseSfnt(buildManyGlyphTtf(200));
    const outV3 = parseSfnt(shrinkGlyf(v3, new Set([1]), { dropGlyphNames: true }).bytes);
    expect([...outV3.table('post')!]).toEqual([...v3.table('post')!]);

    // v1.0: the 32-byte header alone, standard Macintosh ordering implied.
    const p1 = new Uint8Array(32);
    new DataView(p1.buffer).setUint32(0, 0x00010000);
    const v1 = parseSfnt(buildManyGlyphTtf(200, { post: p1 }));
    const outV1 = parseSfnt(shrinkGlyf(v1, new Set([1]), { dropGlyphNames: true }).bytes);
    expect([...outV1.table('post')!]).toEqual([...v1.table('post')!]);
  });

  it('shrinks the program further than keeping the names would', () => {
    const font = namedFont();
    const withNames = shrinkGlyf(font, new Set([1])).bytes.length;
    const without = shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes.length;
    expect(without).toBeLessThan(withNames);
  });

  it('leaves outlines and GID numbering untouched', () => {
    const font = namedFont();
    const out = parseSfnt(shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes);
    expect(out.numGlyphs).toBe(200);
    expect([...out.glyphData(1)]).toEqual([...font.glyphData(1)]);
    expect(out.glyphData(2).length).toBe(0);            // an unused glyph is still blanked
  });
});

describe('shrinkCff', () => {
  it('keeps numGlyphs intact and blanks unused charstrings', () => {
    const cff = buildManyGlyphCff(10);
    const res = shrinkCff(cff, new Set([1, 2]));
    const out = new CffFont(res.bytes);
    expect(out.numGlyphs).toBe(new CffFont(cff).numGlyphs);
    expect(res.gidsKept).toBe(3);   // {0, 1, 2}
    expect(res.gidsDropped).toBe(7);
  });

  // Blanking trades per-glyph charstring bytes against the fixed cost of the
  // CID-keyed wrapper (ROS/charset/FDArray/FDSelect). It only pays off once the
  // font is big enough for the former to dominate — which every real embedded
  // font is, but a 10-glyph fixture is not.
  it('shrinks the program when the dropped glyphs outweigh the CID wrapper', () => {
    const cff = buildManyGlyphCff(100);
    const res = shrinkCff(cff, new Set([1, 2]));
    expect(res.gidsDropped).toBe(97);
    expect(res.bytes.length).toBeLessThan(cff.length);
  });

  it('preserves the CID->GID charset mapping', () => {
    const cff = buildManyGlyphCff(10);
    const before = new CffFont(cff);
    const after = new CffFont(shrinkCff(cff, new Set([1, 2])).bytes);
    for (let cid = 0; cid < 10; cid++) {
      expect(after.cidToGid(cid)).toBe(before.cidToGid(cid));
    }
  });
});

describe('CffFont.gidToCid', () => {
  it('inverts cidToGid for a CID-keyed font', () => {
    const f = new CffFont(buildManyGlyphCff(5));
    for (let cid = 0; cid < 5; cid++) expect(f.gidToCid(f.cidToGid(cid))).toBe(cid);
  });
});

describe('shrinkNameKeyedCff', () => {
  it('keeps numGlyphs and GID numbering intact', () => {
    const out = new CffFont(shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1])).bytes);
    expect(out.numGlyphs).toBe(8);
  });

  it('preserves the charset name chain a simple font dict resolves through', () => {
    const out = new CffFont(shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1])).bytes);
    const names = out.charsetNames();
    expect(names[1]).toBe('A');          // standard SID
    expect(names[2]).toBe('g07');        // custom SID survived via the String INDEX
    expect(names[7]).toBe('g12');
  });

  it('preserves the built-in Encoding', () => {
    const out = new CffFont(shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1])).bytes);
    const e = out.builtinEncoding()!;
    expect(e.get(0x41)).toBe(1);
    expect(e.get(0x42)).toBe(2);
  });

  it('is NOT CID-keyed — that is exactly what shrinkCff would wrongly produce here', () => {
    const out = new CffFont(shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1])).bytes);
    expect(out.isCID).toBe(false);
  });

  it('keeps a kept glyph drawable, inlining the subr it drew through', () => {
    const orig = new CffFont(buildNameKeyedCff(8));
    const res = shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1]));
    const out = new CffFont(res.bytes);
    // gid1 drew via a local subr; Subrs are dropped, so it must have been inlined.
    expect(out.glyphPath(1)).toEqual(orig.glyphPath(1));
    expect(parseCffProgram(res.bytes).localSubrsOf(0).length).toBe(0);
  });

  it('blanks an unkept glyph', () => {
    const res = shrinkNameKeyedCff(buildNameKeyedCff(8), new Set([1]));
    const out = new CffFont(res.bytes);
    expect(out.glyphPath(3).length).toBe(0);   // blanked -> bare endchar
    expect(res.gidsKept).toBe(2);              // .notdef + gid1
    expect(res.gidsDropped).toBe(6);
  });

  it('shrinks the program once the dropped glyphs outweigh the rebuild', () => {
    const cff = buildNameKeyedCff(100);
    expect(shrinkNameKeyedCff(cff, new Set([1])).bytes.length).toBeLessThan(cff.length);
  });
});
