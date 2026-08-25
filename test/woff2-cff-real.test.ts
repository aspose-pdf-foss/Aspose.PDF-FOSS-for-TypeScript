import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSfnt, type SfntFont } from '../src/sfnt.js';
import { CffFont } from '../src/cff.js';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

// The third real-world WOFF2, and the first CFF-flavoured one. A CFF font has no
// glyf/loca, so the transform machinery is bypassed entirely: every table is
// brotli-compressed and passed through, and the OTTO flavour must survive the
// round-trip. This is also the repo's first real CFF font of any kind -- every
// other CFF test runs on bytes test/helpers/build-cff.ts produced.
// See test/fixtures/fonts/PROVENANCE.md.
const ORIGINAL = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
const FIXTURE = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.woff2'));

const src = (): SfntFont => parseSfnt(ORIGINAL);
const back = (): SfntFont => parseSfnt(FIXTURE);

const tableBytes = (f: SfntFont, tag: string): Uint8Array => {
  const rec = f.tables.get(tag);
  if (!rec) throw new Error(`missing table ${tag}`);
  return f.raw.subarray(rec.offset, rec.offset + rec.length);
};

describe('WOFF2 CFF fixture — shape', () => {
  it('is an OTTO-flavoured WOFF2 with no transformed table', () => {
    const dv = new DataView(FIXTURE.buffer, FIXTURE.byteOffset, FIXTURE.byteLength);
    expect(String.fromCharCode(...FIXTURE.subarray(0, 4))).toBe('wOF2');
    expect(String.fromCharCode(...FIXTURE.subarray(4, 8))).toBe('OTTO');
    const numTables = dv.getUint16(12);
    let p = 48;
    const base128 = (): number => {
      let a = 0;
      for (let i = 0; i < 5; i++) { const b = FIXTURE[p++]; a = (a << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
      return a >>> 0;
    };
    let transformed = 0;
    for (let i = 0; i < numTables; i++) {
      const flags = FIXTURE[p++];
      const idx = flags & 0x3f, tv = (flags >> 6) & 0x3;
      if (idx === 0x3f) p += 4;
      base128();
      // No glyf/loca in a CFF font, so any non-zero version means a transform.
      if (tv !== 0) { transformed++; base128(); }
    }
    expect(transformed).toBe(0);
    expect(numTables).toBe(12);
  });

  it('preserves the OTTO flavour through reconstruction', () => {
    const f = back();
    expect(f.outlines).toBe('cff');
    expect(String.fromCharCode(...f.raw.subarray(0, 4))).toBe('OTTO');
  });
});

describe('WOFF2 CFF fixture — reconstruction', () => {
  it('reconstructs exactly the original table set', () => {
    expect([...back().tables.keys()].sort()).toEqual([...src().tables.keys()].sort());
  });

  // Nothing is transformed, so every table comes back byte for byte -- including
  // CFF itself, which no other assertion in the tree checks against third-party
  // bytes. head is the sole exception, for the same two reasons as the
  // LiberationSans fixture; it is asserted exactly below rather than skipped.
  it('reproduces every table but head byte for byte', () => {
    const a = back(), b = src();
    const differing: string[] = [];
    for (const tag of [...b.tables.keys()].sort()) {
      if (tag === 'head') continue;
      const x = tableBytes(a, tag), y = tableBytes(b, tag);
      if (x.length !== y.length || !x.every((v, i) => v === y[i])) differing.push(tag);
    }
    expect(differing).toEqual([]);
  });

  // Note this holds even though nothing was transformed: fontTools sets bit 11
  // at encode time and we pass head through untouched, since with no glyf there
  // is no indexToLocFormat to patch.
  it('sets head.flags bit 11 and changes no other flag', () => {
    const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const orig = dv(tableBytes(src(), 'head')).getUint16(16);
    expect(dv(tableBytes(back(), 'head')).getUint16(16)).toBe(orig | 0x0800);
  });

  it('reproduces head apart from checkSumAdjustment and flags', () => {
    const a = Array.from(tableBytes(back(), 'head'));
    const b = Array.from(tableBytes(src(), 'head'));
    expect(a.length).toBe(b.length);
    const mask = (t: number[]) => t.map((v, i) => (i >= 8 && i < 12) || i === 16 || i === 17 ? 0 : v);
    expect(mask(a)).toEqual(mask(b));
  });
});

describe('WOFF2 CFF fixture — the CFF font parses', () => {
  it('reports the original glyph count and metrics', () => {
    const a = back(), b = src();
    expect(a.numGlyphs).toBe(b.numGlyphs);
    expect(a.unitsPerEm).toBe(b.unitsPerEm);
    expect(a.unitsPerEm).toBe(1000);          // CFF convention, unlike the TTFs
  });

  it('reproduces the original cmap', () => {
    expect([...back().cmap.entries()].sort()).toEqual([...src().cmap.entries()].sort());
  });

  it('reproduces every advance width', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) if (a.advanceWidth(g) !== b.advanceWidth(g)) bad.push(g);
    expect(bad).toEqual([]);
  });

  // NB: not SfntFont.glyphOutline -- that decodes glyf and returns [] for a CFF
  // font, so comparing it here would pass vacuously on two empty results. The
  // charstrings have to go through the CFF interpreter to be checked at all.
  it('reproduces every charstring outline', () => {
    const a = new CffFont(tableBytes(back(), 'CFF ')), b = new CffFont(tableBytes(src(), 'CFF '));
    expect(a.numGlyphs).toBe(b.numGlyphs);
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (JSON.stringify(a.glyphPath(g)) !== JSON.stringify(b.glyphPath(g))) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('draws real outlines rather than empty ones', () => {
    // Guards the comparison above against passing on two empty results, which is
    // exactly what happened when it was first written against glyphOutline.
    const f = back();
    const cff = new CffFont(tableBytes(f, 'CFF '));
    const gid = f.cmap.get('A'.codePointAt(0)!);
    expect(gid).toBeGreaterThan(0);
    expect(cff.glyphPath(gid!).length).toBeGreaterThan(0);
  });

  // The comparison above runs BOTH fonts through our own interpreter, so an
  // interpreter bug cancels out and it cannot catch one -- verified: shifting the
  // local-subr bias leaves it green. This checks the interpreted geometry against
  // hmtx instead, a table the interpreter never reads, so it is the assertion
  // that actually validates cff.ts against third-party bytes.
  //
  // A charstring's control points bound its curves (convex hull), so the minimum
  // control-point x can never exceed the glyph's true left extremum, which is
  // what lsb records. Garbled subr resolution moves coordinates and breaks it.
  it('interprets charstrings consistently with the hmtx left side bearings', () => {
    const f = back();
    const cff = new CffFont(tableBytes(f, 'CFF '));
    const hv = new DataView(tableBytes(f, 'hmtx').buffer, tableBytes(f, 'hmtx').byteOffset, tableBytes(f, 'hmtx').byteLength);
    const numHMetrics = new DataView(tableBytes(f, 'hhea').buffer, tableBytes(f, 'hhea').byteOffset, tableBytes(f, 'hhea').byteLength).getUint16(34);

    let checked = 0, exact = 0;
    const leftOfBearing: string[] = [];
    for (let g = 0; g < cff.numGlyphs; g++) {
      const xs: number[] = [];
      for (const seg of cff.glyphPath(g)) {
        if (seg.op === 'M' || seg.op === 'L') xs.push(seg.x);
        else if (seg.op === 'C') xs.push(seg.x1, seg.x2, seg.x);
      }
      if (xs.length === 0) continue;
      const lsb = g < numHMetrics
        ? hv.getInt16(g * 4 + 2)
        : hv.getInt16(numHMetrics * 4 + (g - numHMetrics) * 2);
      const minX = Math.min(...xs);
      checked++;
      if (minX === lsb) exact++;
      if (minX > lsb) leftOfBearing.push(`gid ${g}: minX ${minX} > lsb ${lsb}`);
    }

    expect(leftOfBearing).toEqual([]);              // the hull invariant, never violable
    expect(checked).toBe(851);
    expect(exact).toBe(841);                        // the 10 others are curve-hull slack
  });
});

describe('WOFF2 CFF fixture — end to end', () => {
  it('embeds and subsets through AddFont/Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hamburgefonstiv', 20, 50, { font });
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toContain('Hamburgefonstiv');
  });
});
