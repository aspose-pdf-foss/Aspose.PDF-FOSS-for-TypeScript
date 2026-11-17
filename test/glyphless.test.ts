import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { parseSfnt } from '../src/sfnt.js';
import { parseCMap } from '../src/cmap.js';
import { TextFont } from '../src/font.js';
import { decodeStream } from '../src/filters.js';
import { GlyphlessCodes, glyphlessProgram, createGlyphlessFont, GLYPHLESS_ADVANCE } from '../src/glyphless.js';
import { isDict, isRef, isStream, isArray, isName, type PdfObject, type PdfRef } from '../src/types.js';

describe('glyphless program (3ywf.3)', () => {
  it('is a two-glyph TrueType our own parser reads', () => {
    const f = parseSfnt(glyphlessProgram());
    expect(f.numGlyphs).toBe(2);
    expect(f.unitsPerEm).toBe(1000);
    expect(f.postScriptName).toBe('GlyphLessFont');
    expect(f.advanceWidth(1)).toBe(GLYPHLESS_ADVANCE);
    expect(f.glyphOutline(1)).toEqual([]);
  });

  it('is built once and reused', () => {
    expect(glyphlessProgram()).toBe(glyphlessProgram());
  });
});

describe('GlyphlessCodes (3ywf.3)', () => {
  it('keeps complete glyph strings and assigns different advances their own codes (izia)', () => {
    const c = new GlyphlessCodes();
    expect(c.encodeGlyph('fi\u{1d400}', -1)).toBe(1);
    expect(c.encodeGlyph('fi\u{1d400}', -1)).toBe(1);
    expect(c.encodeGlyph('fi\u{1d400}', -0.75)).toBe(2);
    expect(c.encodeGlyph('あ', 0)).toBe(3);
    expect(c.encodeGlyph('あ', 0.5)).toBe(4);
    expect(c.entries()).toEqual([[1, 'fi\u{1d400}'], [2, 'fi\u{1d400}'], [3, 'あ'], [4, 'あ']]);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite glyph advance %s before assignment', (advance) => {
    const c = new GlyphlessCodes();
    expect(() => c.encodeGlyph('A', advance)).toThrow(RangeError);
    expect(c.maxCode).toBe(0);
    expect(c.encodeGlyph('A', -1)).toBe(1);
  });

  it('bounds distinct glyph metrics atomically and keeps existing codes usable', () => {
    const c = new GlyphlessCodes();
    for (let i = 0; i < 65_535; i++) c.encodeGlyph('A', -i);
    expect(() => c.encodeGlyph('A', -65_535)).toThrow(RangeError);
    expect(c.maxCode).toBe(65_535);
    expect(c.encodeGlyph('A', -1)).toBe(2);
    expect(c.entries().at(-1)).toEqual([65_535, 'A']);
  });

  it('assigns codes from 1 in order of first use and reuses them', () => {
    const c = new GlyphlessCodes();
    expect(c.encode('abca')).toEqual([1, 2, 3, 1]);
    expect(c.encode('db')).toEqual([4, 2]);
    expect(c.maxCode).toBe(4);
    expect(c.entries()).toEqual([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  });

  it('gives an astral character ONE code', () => {
    const c = new GlyphlessCodes();
    expect(c.encode('𝐀x')).toEqual([1, 2]);
    expect(c.entries()[0]).toEqual([1, '𝐀']);
  });

  it('refuses past 65,535 distinct characters WITHOUT assigning any (Review Focus 4)', () => {
    const c = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_535; cp++) big += String.fromCodePoint(cp);
    c.encode(big);
    expect(c.maxCode).toBe(65_535);
    expect(() => c.encode('A')).toThrow(RangeError);
    expect(c.maxCode).toBe(65_535);
    expect(c.encode('𐀀')).toEqual([1]); // an existing character still encodes
  });

  it('is atomic: a string that would overflow assigns nothing', () => {
    const c = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_534; cp++) big += String.fromCodePoint(cp);
    c.encode(big);
    expect(() => c.encode('AB')).toThrow(RangeError); // needs 2, has room for 1
    expect(c.maxCode).toBe(65_534);
    expect(c.encode('A')).toEqual([65_535]);
  });
});

describe('createGlyphlessFont (3ywf.3)', () => {
  function store() {
    const objs = new Map<number, PdfObject>();
    let next = 1;
    const alloc = (o: PdfObject): PdfRef => { const r = { kind: 'ref' as const, num: next++, gen: 0 }; objs.set(r.num, o); return r; };
    const replace = (r: PdfRef, o: PdfObject): void => { objs.set(r.num, o); };
    const get = (o: PdfObject | undefined): PdfObject | undefined => (isRef(o) ? objs.get(o.num) : o);
    return { objs, alloc, replace, get };
  }

  it('decodes a vertical font with per-glyph advances and complete Unicode strings (izia)', () => {
    const s = store(), codes = new GlyphlessCodes();
    codes.encodeGlyph('fi\u{1d400}', -1.2);
    codes.encodeGlyph('fi\u{1d400}', -0.6);
    codes.encodeGlyph('あ', 0);
    const font = createGlyphlessFont(s.alloc, s.replace, true);
    font.finish(codes);
    const dict = s.get(font.font);
    if (!isDict(dict)) throw new Error('no font');
    const decoded = new TextFont(dict, (o) => s.get(o)!, (s) => decodeStream({ kind: 'stream', ...s }))
      .decodeGlyphs(Uint8Array.of(0, 1, 0, 2, 0, 3));
    expect(decoded.map((g) => g.text)).toEqual(['fi\u{1d400}', 'fi\u{1d400}', 'あ']);
    expect(decoded.map((g) => g.vertical)).toEqual([
      { w1: -1.2, vx: 0.25, vy: 0.88 },
      { w1: -0.6, vx: 0.25, vy: 0.88 },
      { w1: 0, vx: 0.25, vy: 0.88 },
    ]);
    const cid = s.get((dict.get('DescendantFonts') as PdfObject[])[0]);
    if (!isDict(cid)) throw new Error('no descendant');
    const map = s.get(cid.get('CIDToGIDMap'));
    if (!isStream(map)) throw new Error('no CID map');
    expect([...decodeStream(map)]).toEqual([0, 0, 0, 1, 0, 1, 0, 1]);
  });

  it('builds a Type0 / CIDFontType2 font over the embedded program', () => {
    const s = store();
    const { font } = createGlyphlessFont(s.alloc, s.replace);
    const t0 = s.get(font);
    expect(isDict(t0)).toBe(true);
    if (!isDict(t0)) return;
    expect((t0.get('Subtype') as { name: string }).name).toBe('Type0');
    expect((t0.get('BaseFont') as { name: string }).name).toBe('GlyphLessFont');
    expect((t0.get('Encoding') as { name: string }).name).toBe('Identity-H');
    const desc = t0.get('DescendantFonts');
    expect(isArray(desc)).toBe(true);
    const cid = s.get((desc as PdfObject[])[0]);
    if (!isDict(cid)) throw new Error('no CIDFont');
    expect((cid.get('Subtype') as { name: string }).name).toBe('CIDFontType2');
    expect(cid.get('DW')).toBe(500);
    const fd = s.get(cid.get('FontDescriptor'));
    if (!isDict(fd)) throw new Error('no descriptor');
    const ff2 = s.get(fd.get('FontFile2'));
    expect(isStream(ff2)).toBe(true);
    if (isStream(ff2)) expect(new Uint8Array(inflateSync(ff2.raw))).toEqual(glyphlessProgram());
  });

  it('finish() maps every code to GID 1 and writes /ToUnicode for each character', () => {
    const s = store();
    const { font, finish } = createGlyphlessFont(s.alloc, s.replace);
    const codes = new GlyphlessCodes();
    codes.encode('Aж𝐀');
    finish(codes);
    const t0 = s.get(font) as Map<string, PdfObject>;
    const cid = s.get((t0.get('DescendantFonts') as PdfObject[])[0]) as Map<string, PdfObject>;
    const map = s.get(cid.get('CIDToGIDMap'));
    if (!isStream(map)) throw new Error('no CIDToGIDMap stream');
    const bytes = new Uint8Array(inflateSync(map.raw));
    expect(bytes.length).toBe(2 * 4); // codes 0..3
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect([0, 1, 2, 3].map((c) => dv.getUint16(c * 2))).toEqual([0, 1, 1, 1]);
    const tu = s.get(t0.get('ToUnicode'));
    if (!isStream(tu)) throw new Error('no ToUnicode');
    const cmap = parseCMap(new Uint8Array(inflateSync(tu.raw)));
    expect([1, 2, 3].map((c) => cmap.lookup(c))).toEqual(['A', 'ж', '𝐀']);
  });

  it('allocates its objects once; finish() replaces in place', () => {
    const s = store();
    const { finish } = createGlyphlessFont(s.alloc, s.replace);
    const n = s.objs.size;
    finish(new GlyphlessCodes());
    expect(s.objs.size).toBe(n);
  });

  it('names its descriptor font and flags it symbolic', () => {
    const s = store();
    const { font } = createGlyphlessFont(s.alloc, s.replace);
    const t0 = s.get(font) as Map<string, PdfObject>;
    const cid = s.get((t0.get('DescendantFonts') as PdfObject[])[0]) as Map<string, PdfObject>;
    const fd = s.get(cid.get('FontDescriptor')) as Map<string, PdfObject>;
    expect(isName(fd.get('FontName'))).toBe(true);
    expect(fd.get('Flags')).toBe(4);
  });
});
