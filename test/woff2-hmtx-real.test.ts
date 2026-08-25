import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSfnt, type SfntFont } from '../src/sfnt.js';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

// A second real-world WOFF2, from a second encoder, chosen for the one thing the
// wawoff2 fixture cannot reach: the optional hmtx transform. fontTools elects it;
// wawoff2 never does. See test/fixtures/fonts/PROVENANCE.md.
const ORIGINAL = new Uint8Array(readFileSync('fonts/LiberationMono-Italic.ttf'));
const FIXTURE = new Uint8Array(readFileSync('test/fixtures/fonts/LiberationMono-Italic.woff2'));

const src = (): SfntFont => parseSfnt(ORIGINAL);
const back = (): SfntFont => parseSfnt(FIXTURE);

const tableBytes = (f: SfntFont, tag: string): Uint8Array => {
  const rec = f.tables.get(tag);
  if (!rec) throw new Error(`missing table ${tag}`);
  return f.raw.subarray(rec.offset, rec.offset + rec.length);
};
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

describe('WOFF2 hmtx transform — fixture shape', () => {
  // The whole point of this fixture. If an encoder change ever stops electing the
  // hmtx transform, these assertions still pass but stop meaning anything — so
  // assert the transform is actually present in the bytes.
  it('stores hmtx with transform version 1', () => {
    const dv = view(FIXTURE);
    expect(String.fromCharCode(...FIXTURE.subarray(0, 4))).toBe('wOF2');
    const numTables = dv.getUint16(12);
    let p = 48;
    const base128 = (): number => {
      let a = 0;
      for (let i = 0; i < 5; i++) { const b = FIXTURE[p++]; a = (a << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
      return a >>> 0;
    };
    const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post'];
    const transformed: string[] = [];
    for (let i = 0; i < numTables; i++) {
      const flags = FIXTURE[p++];
      const idx = flags & 0x3f, tv = (flags >> 6) & 0x3;
      const tag = idx === 0x3f
        ? String.fromCharCode(...FIXTURE.subarray((p += 4) - 4, p))
        : (KNOWN[idx] ?? (idx === 10 ? 'glyf' : idx === 11 ? 'loca' : `#${idx}`));
      base128();                                     // origLength
      const isTransformed = tag === 'glyf' || tag === 'loca' ? tv !== 3 : tv !== 0;
      if (isTransformed) { transformed.push(`${tag}:${tv}`); base128(); }
    }
    expect(transformed.sort()).toEqual(['glyf:0', 'hmtx:1', 'loca:0']);
  });

  // Both optional arrays must actually be exercised: the proportional lsbs, and
  // the trailing ones for glyphs past numHMetrics. This face is the only vendored
  // one with numGlyphs > numHMetrics.
  it('has both proportional and trailing metrics to reconstruct', () => {
    const f = src();
    const numHMetrics = view(tableBytes(f, 'hhea')).getUint16(34);
    expect(numHMetrics).toBe(2423);
    expect(f.numGlyphs).toBe(2425);                  // 2 trailing glyphs
  });
});

describe('WOFF2 hmtx transform — reconstruction', () => {
  it('reproduces hmtx byte for byte', () => {
    expect([...tableBytes(back(), 'hmtx')]).toEqual([...tableBytes(src(), 'hmtx')]);
  });

  it('reproduces every advance width', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) if (a.advanceWidth(g) !== b.advanceWidth(g)) bad.push(g);
    expect(bad).toEqual([]);
  });

  it('reproduces every proportional left side bearing', () => {
    const av = view(tableBytes(back(), 'hmtx')), bv = view(tableBytes(src(), 'hmtx'));
    const numHMetrics = view(tableBytes(src(), 'hhea')).getUint16(34);
    const bad: number[] = [];
    for (let g = 0; g < numHMetrics; g++) if (av.getInt16(g * 4 + 2) !== bv.getInt16(g * 4 + 2)) bad.push(g);
    expect(bad).toEqual([]);
  });

  it('reproduces the trailing left side bearings', () => {
    const av = view(tableBytes(back(), 'hmtx')), bv = view(tableBytes(src(), 'hmtx'));
    const numHMetrics = view(tableBytes(src(), 'hhea')).getUint16(34);
    const base = numHMetrics * 4;
    const bad: number[] = [];
    for (let g = numHMetrics; g < src().numGlyphs; g++) {
      const o = base + (g - numHMetrics) * 2;
      if (av.getInt16(o) !== bv.getInt16(o)) bad.push(g);
    }
    expect(bad).toEqual([]);
  });
});

// fontTools is a different encoder from wawoff2, so its glyf/loca output is an
// independent cross-check of the same paths the other fixture covers.
describe('WOFF2 hmtx fixture — second encoder cross-check', () => {
  it('reconstructs the font with the original glyph count and metrics', () => {
    const a = back(), b = src();
    expect(a.outlines).toBe('glyf');
    expect(a.numGlyphs).toBe(b.numGlyphs);
    expect(a.unitsPerEm).toBe(b.unitsPerEm);
  });

  it('reproduces every glyph outline', () => {
    const a = back(), b = src();
    const bad: number[] = [];
    for (let g = 0; g < b.numGlyphs; g++) {
      if (JSON.stringify(a.glyphOutline(g)) !== JSON.stringify(b.glyphOutline(g))) bad.push(g);
    }
    expect(bad).toEqual([]);
  });

  it('reproduces the original cmap', () => {
    expect([...back().cmap.entries()].sort()).toEqual([...src().cmap.entries()].sort());
  });

  it('embeds and subsets through AddFont/Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(FIXTURE);
    doc.Pages[0].AddText('Hamburgefonstiv', 20, 50, { font });
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toContain('Hamburgefonstiv');
  });
});
