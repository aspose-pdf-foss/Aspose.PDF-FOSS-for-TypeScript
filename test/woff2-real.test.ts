import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSfnt, type SfntFont } from '../src/sfnt.js';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

const ORIGINAL = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));
const FIXTURE = new Uint8Array(readFileSync('test/fixtures/fonts/LiberationSans-Regular.woff2'));

/** Raw bytes of one table, from whichever sfnt the font was reconstructed from. */
export function tableBytes(f: SfntFont, tag: string): Uint8Array {
  const rec = f.tables.get(tag);
  if (!rec) throw new Error(`missing table ${tag}`);
  return f.raw.subarray(rec.offset, rec.offset + rec.length);
}

export const src = (): SfntFont => parseSfnt(ORIGINAL);
export const back = (): SfntFont => parseSfnt(FIXTURE);

describe('WOFF2 real fixture — parse', () => {
  it('reconstructs a glyf font with the original glyph count and metrics', () => {
    const a = back(), b = src();
    expect(a.outlines).toBe('glyf');
    expect(a.numGlyphs).toBe(b.numGlyphs);
    expect(a.numGlyphs).toBe(2620);
    expect(a.unitsPerEm).toBe(b.unitsPerEm);
  });

  it('reconstructs exactly the original table set', () => {
    expect([...back().tables.keys()].sort()).toEqual([...src().tables.keys()].sort());
  });

  it('reconstructs the original cmap', () => {
    expect([...back().cmap.entries()].sort()).toEqual([...src().cmap.entries()].sort());
  });
});

/** Tables the WOFF2 round-trip preserves byte-for-byte. Measured; see
 *  test/fixtures/fonts/PROVENANCE.md. */
const BYTE_IDENTICAL = [
  'FFTM', 'GDEF', 'GPOS', 'GSUB', 'OS/2', 'cmap', 'cvt ', 'fpgm',
  'gasp', 'hhea', 'hmtx', 'kern', 'maxp', 'name', 'post', 'prep',
];

/** Tables WOFF2 legitimately rebuilds. Each is asserted structurally below. */
const REBUILT = ['glyf', 'head', 'loca'];

describe('WOFF2 real fixture — byte-identical tables', () => {
  it.each(BYTE_IDENTICAL)('reconstructs %s byte-for-byte', (tag) => {
    expect(Array.from(tableBytes(back(), tag)))
      .toEqual(Array.from(tableBytes(src(), tag)));
  });

  it('classifies every table in the font', () => {
    expect([...BYTE_IDENTICAL, ...REBUILT].sort()).toEqual([...src().tables.keys()].sort());
  });
});

/** Hinting instruction bytes of a *simple* glyph (`[]` for composite/empty). */
function simpleInstructions(f: SfntFont, gid: number): number[] {
  const g = f.glyphData(gid);
  if (g.length < 12) return [];
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const numContours = v.getInt16(0);
  if (numContours <= 0) return [];                 // composite or contourless
  const p = 10 + numContours * 2;
  return Array.from(g.subarray(p + 2, p + 2 + v.getUint16(p)));
}

// `glyf` is re-encoded rather than copied (see PROVENANCE.md), so it is asserted
// structurally. These are the only assertions in the tree that exercise the
// transform's compositeStream and instructionStream against real encoder output.
describe('WOFF2 real fixture — glyf reconstruction', () => {
  it('reproduces every glyph outline', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (JSON.stringify(a.glyphOutline(g)) !== JSON.stringify(b.glyphOutline(g))) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces every composite glyph component list', () => {
    const a = back(), b = src();
    let composites = 0;
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      const want = b.componentGids(g);
      if (want.length > 0) composites++;
      if (JSON.stringify(a.componentGids(g)) !== JSON.stringify(want)) bad.push(g);
    }
    expect(bad).toEqual([]);
    expect(composites).toBe(1076);   // guards the fixture against silent replacement
  });

  it("reproduces every simple glyph's hinting instructions", () => {
    const a = back(), b = src();
    let instructed = 0;
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      const want = simpleInstructions(b, g);
      if (want.length > 0) instructed++;
      if (JSON.stringify(simpleInstructions(a, g)) !== JSON.stringify(want)) bad.push(g);
    }
    expect(bad).toEqual([]);
    expect(instructed).toBe(1484);   // guards the fixture against silent replacement
  });
});

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

describe('WOFF2 real fixture — hmtx and rebuilt tables', () => {
  // NB: wawoff2 stores hmtx with the NULL transform, so these do not reach
  // reconstructHmtx — the transform stays covered only by the golden vector in
  // woff.test.ts. See "Not covered" in PROVENANCE.md. They still earn their
  // place: they assert the passed-through table also parses to the right values,
  // which the byte comparison alone does not.
  it('reproduces every advance width', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (a.advanceWidth(g) !== b.advanceWidth(g)) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces every left side bearing', () => {
    const av = view(tableBytes(back(), 'hmtx')), bv = view(tableBytes(src(), 'hmtx'));
    const numHMetrics = view(tableBytes(src(), 'hhea')).getUint16(34);
    const bad: number[] = [];
    for (let g = 0; g < numHMetrics; g++) {
      if (av.getInt16(g * 4 + 2) !== bv.getInt16(g * 4 + 2)) bad.push(g);
    }
    expect(bad).toEqual([]);
    expect(numHMetrics).toBe(2620);
  });

  // head differs in exactly two places, both required. See PROVENANCE.md.
  it('sets head.flags bit 11 and changes no other flag', () => {
    const orig = view(tableBytes(src(), 'head')).getUint16(16);
    const rebuilt = view(tableBytes(back(), 'head')).getUint16(16);
    expect(rebuilt).toBe(orig | 0x0800);   // WOFF2 'lossless transform' bit
  });

  it('preserves indexToLocFormat', () => {
    expect(back().indexToLocFormat).toBe(src().indexToLocFormat);
    expect(back().indexToLocFormat).toBe(1);   // long loca
  });

  it('reproduces head apart from checkSumAdjustment and flags', () => {
    const a = Array.from(tableBytes(back(), 'head'));
    const b = Array.from(tableBytes(src(), 'head'));
    expect(a.length).toBe(b.length);
    // 8..11 checkSumAdjustment (recomputed), 16..17 flags (asserted exactly above).
    const mask = (t: number[]) => t.map((v, i) => (i >= 8 && i < 12) || i === 16 || i === 17 ? 0 : v);
    expect(mask(a)).toEqual(mask(b));
  });

  it('rebuilds loca consistently with glyf', () => {
    const a = back();
    expect(a.loca.length).toBe(a.numGlyphs + 1);
    expect(a.loca[0]).toBe(0);
    const bad: number[] = [];
    for (let g = 0; g < a.numGlyphs; g++) if (a.loca[g + 1] < a.loca[g]) bad.push(g);
    expect(bad).toEqual([]);
    expect(a.loca[a.numGlyphs]).toBeLessThanOrEqual(a.glyf.length);
    // Same length and format as the original, even though the offsets differ.
    expect(tableBytes(back(), 'loca').length).toBe(tableBytes(src(), 'loca').length);
  });
});

/** Count the compact-encoding choices made across every simple glyph: points
 *  whose delta went out as one signed byte, and flag bytes carrying REPEAT. */
function flagStats(f: SfntFont): { xShort: number; yShort: number; repeats: number } {
  let xShort = 0, yShort = 0, repeats = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    const d = f.glyphData(g);
    if (d.length < 12) continue;
    const v = view(d);
    const nContours = v.getInt16(0);
    if (nContours <= 0) continue;                    // composite or contourless
    const nPoints = v.getUint16(10 + (nContours - 1) * 2) + 1;
    let p = 10 + nContours * 2;
    p += 2 + v.getUint16(p);                         // skip the instructions
    for (let i = 0; i < nPoints;) {
      const flag = d[p++];
      let run = 1;
      if (flag & 0x08) { run += d[p++]; repeats++; }
      if (flag & 0x02) xShort += run;
      if (flag & 0x04) yShort += run;
      i += run;
    }
  }
  return { xShort, yShort, repeats };
}

// Reconstruction must re-encode glyf as compactly as the source did: subset.ts
// copies glyph bytes verbatim, so any bloat here reaches the embedded PDF.
describe('WOFF2 real fixture — glyf re-encoding is compact', () => {
  // At least as compact, not identical: the original leaves a handful of deltas
  // long that fit a byte (measured 21222 vs 21216 short x), so it is a floor.
  it('uses short coordinates and REPEAT runs at least as often as the original', () => {
    const a = flagStats(back()), b = flagStats(src());
    expect(b).toEqual({ xShort: 21216, yShort: 17430, repeats: 2050 });   // guards the fixture
    expect(a.xShort).toBeGreaterThanOrEqual(b.xShort);
    expect(a.yShort).toBeGreaterThanOrEqual(b.yShort);
    expect(a.repeats).toBeGreaterThanOrEqual(b.repeats);
  });

  it('re-encodes glyf no larger than the original', () => {
    expect(back().glyf.length).toBeLessThanOrEqual(src().glyf.length);
  });
});

// The assertions above check reconstruction in isolation. These check the
// reconstructed font survives the path a user actually takes.
describe('WOFF2 real fixture — end to end', () => {
  it('embeds and subsets through AddFont/Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hamburgefonstiv', 20, 50, { font });
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toContain('Hamburgefonstiv');
  });

  it('subsets to far less than the full face', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hi', 20, 50, { font });
    // 2620 glyphs subset to a handful must not approach the 410KB source face.
    expect(doc.Save().length).toBeLessThan(100_000);
  });
});
