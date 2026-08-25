import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { parseSfnt } from '../src/sfnt.js';
import { buildEmbeddedFont } from '../src/fontembed.js';
import { TextFont } from '../src/font.js';
import { buildClosureTtf, makeOttoWithCff } from './helpers/build-sfnt.js';
import { buildCffOtto } from './helpers/build-cff.js';
import { CffFont } from '../src/cff.js';
import {
  PdfObject, PdfDict, PdfRef, PdfStream,
  isDict, isName, isArray, isStream, isRef, ref,
} from '../src/types.js';

/** A toy object store standing in for a Document's renumbering map. */
function makeStore() {
  const objects = new Map<number, PdfObject>();
  let next = 1;
  const alloc = (obj: PdfObject): PdfRef => { const n = next++; objects.set(n, obj); return ref(n); };
  const resolve = (o: PdfObject | undefined): PdfObject =>
    isRef(o) ? resolve(objects.get(o.num)) : (o as PdfObject);
  const inflate = (s: { dict: PdfDict; raw: Uint8Array }): Uint8Array => {
    const f = s.dict.get('Filter');
    return isName(f) && f.name === 'FlateDecode' ? new Uint8Array(inflateSync(s.raw)) : s.raw;
  };
  return { objects, alloc, resolve, inflate };
}

const nm = (o: PdfObject | undefined): string | undefined => (isName(o) ? o.name : undefined);

describe('buildEmbeddedFont — glyf/CIDFontType2', () => {
  // buildClosureTtf: gids 0=.notdef, 1='A'(U+0041, adv 600), 2='B'(U+0042, adv 700),
  // 3=composite->2 (adv 800). unitsPerEm 1000. cmap: 0x41->1, 0x42->2.
  function build() {
    const font = parseSfnt(buildClosureTtf());
    const store = makeStore();
    const usedGids = new Set<number>([1, 2]);
    const type0 = buildEmbeddedFont(font, usedGids, store.alloc);
    return { font, store, type0 };
  }

  it('emits a Type0/Identity-H font with a subset BaseFont tag', () => {
    const { type0 } = build();
    expect(nm(type0.get('Type'))).toBe('Font');
    expect(nm(type0.get('Subtype'))).toBe('Type0');
    expect(nm(type0.get('Encoding'))).toBe('Identity-H');
    const base = nm(type0.get('BaseFont'))!;
    expect(base).toMatch(/^[A-Z]{6}\+/); // six-letter subset tag prefix
  });

  it('emits a CIDFontType2 descendant with CIDSystemInfo (Adobe/Identity) and DW', () => {
    const { store, type0 } = build();
    const descArr = store.resolve(type0.get('DescendantFonts'));
    expect(isArray(descArr)).toBe(true);
    const cid = store.resolve((descArr as PdfObject[])[0]) as PdfDict;
    expect(nm(cid.get('Subtype'))).toBe('CIDFontType2');
    expect(nm(type0.get('BaseFont'))).toBe(nm(cid.get('BaseFont')));
    const sysinfo = store.resolve(cid.get('CIDSystemInfo')) as PdfDict;
    expect(new TextDecoder().decode((sysinfo.get('Registry') as any).bytes)).toBe('Adobe');
    expect(new TextDecoder().decode((sysinfo.get('Ordering') as any).bytes)).toBe('Identity');
    expect(sysinfo.get('Supplement')).toBe(0);
    expect(typeof cid.get('DW')).toBe('number');
  });

  it('keys /W by original GID (CID = original GID)', () => {
    const { store, type0 } = build();
    const cid = store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
    const w = store.resolve(cid.get('W')) as PdfObject[];
    // Parse W via the read side and check widths for CID 1 ('A') and 2 ('B').
    const wt = parseWidthsFromCidDict(cid, store.resolve);
    expect(wt.get(1)).toBe(600);
    expect(wt.get(2)).toBe(700);
    expect(isArray(w)).toBe(true);
  });

  it('embeds a FontDescriptor with FontFile2 (+ /Length1) re-parseable as an sfnt', () => {
    const { store, type0 } = build();
    const cid = store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    expect(nm(fd.get('Type'))).toBe('FontDescriptor');
    for (const k of ['Flags', 'FontBBox', 'ItalicAngle', 'Ascent', 'Descent', 'CapHeight', 'StemV'])
      expect(fd.has(k)).toBe(true);
    const ff = store.resolve(fd.get('FontFile2')) as PdfStream;
    expect(isStream(ff)).toBe(true);
    const subsetBytes = store.inflate(ff);
    expect(ff.dict.get('Length1')).toBe(subsetBytes.length);
    const sub = parseSfnt(subsetBytes);
    expect(sub.numGlyphs).toBe(3); // closure {0,1,2}
  });

  it('emits a /CIDToGIDMap stream mapping original GID -> subset GID', () => {
    const { store, type0 } = build();
    const cid = store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
    const map = store.resolve(cid.get('CIDToGIDMap')) as PdfStream;
    expect(isStream(map)).toBe(true);
    const bytes = store.inflate(map);
    // gidMap is identity here (closure {0,1,2} -> {0,1,2}); 3 CIDs * 2 bytes.
    expect(Array.from(bytes)).toEqual([0, 0, 0, 1, 0, 2]);
  });

  it('round-trips through TextFont: 2-byte CIDs decode to Unicode with widths', () => {
    const { store, type0 } = build();
    const tf = new TextFont(type0, store.resolve, store.inflate);
    expect(tf.codeWidth).toBe(2);
    expect(tf.decode(Uint8Array.of(0, 1, 0, 2))).toBe('AB'); // CID1='A', CID2='B'
    const run = tf.decodeRun(Uint8Array.of(0, 1, 0, 2));
    expect(run.width).toBeCloseTo(1.3, 5); // 600/1000 + 700/1000
  });

  it('produces a deterministic subset tag for identical inputs', () => {
    const a = build().type0;
    const b = build().type0;
    expect(nm(a.get('BaseFont'))).toBe(nm(b.get('BaseFont')));
  });
});

describe('buildEmbeddedFont — CFF/CIDFontType0 (whole-embed fallback)', () => {
  it('falls back to FontFile3 /Subtype /OpenType (whole) when the CFF is unparseable', () => {
    const font = parseSfnt(makeOttoWithCff());   // 'CFF ' table is 4 zero bytes -> subsetCff throws
    const store = makeStore();
    const type0 = buildEmbeddedFont(font, new Set([1]), store.alloc);
    expect(nm(type0.get('Subtype'))).toBe('Type0');
    const cid = store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
    expect(nm(cid.get('Subtype'))).toBe('CIDFontType0');
    expect(nm(cid.get('CIDToGIDMap'))).toBe('Identity');
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    expect(isStream(ff)).toBe(true);
    expect(nm(ff.dict.get('Subtype'))).toBe('OpenType');
    expect(Array.from(store.inflate(ff))).toEqual(Array.from(font.raw)); // whole, not subset
  });
});

describe('buildEmbeddedFont — CFF subsetting', () => {
  function build(used: number[]) {
    const font = parseSfnt(buildCffOtto());   // OTTO wrapping buildMinimalCff, cmap 'A'->gid1
    const store = makeStore();
    const type0 = buildEmbeddedFont(font, new Set(used), store.alloc);
    return { font, store, type0 };
  }
  function cidFontOf(store: ReturnType<typeof makeStore>, type0: PdfDict): PdfDict {
    return store.resolve((store.resolve(type0.get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
  }

  it('emits CIDFontType0 + FontFile3 /Subtype /CIDFontType0C with /CIDToGIDMap /Identity', () => {
    const { store, type0 } = build([1]);
    const cid = cidFontOf(store, type0);
    expect(nm(cid.get('Subtype'))).toBe('CIDFontType0');
    expect(nm(cid.get('CIDToGIDMap'))).toBe('Identity');
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    expect(nm(ff.dict.get('Subtype'))).toBe('CIDFontType0C');
  });

  it('the embedded CFF resolves the drawn original GID to the right outline', () => {
    const { store, type0 } = build([1]);
    const cid = cidFontOf(store, type0);
    const fd = store.resolve(cid.get('FontDescriptor')) as PdfDict;
    const ff = store.resolve(fd.get('FontFile3')) as PdfStream;
    const sub = new CffFont(store.inflate(ff));
    // Draw-time code is original GID 1 (treated as CID) -> resolves to the box.
    expect(sub.glyphPath(sub.cidToGid(1))).toEqual([
      { op: 'M', x: 100, y: 0 }, { op: 'L', x: 900, y: 0 },
      { op: 'L', x: 900, y: 700 }, { op: 'L', x: 100, y: 700 }, { op: 'Z' },
    ]);
  });
});

/** Mirror parseType0Widths to read /W back from a CIDFont dict for assertions. */
function parseWidthsFromCidDict(cid: PdfDict, resolve: (o: PdfObject | undefined) => PdfObject): Map<number, number> {
  const widths = new Map<number, number>();
  const w = resolve(cid.get('W'));
  if (!isArray(w)) return widths;
  for (let i = 0; i < w.length; ) {
    const c = resolve(w[i]);
    const next = resolve(w[i + 1]);
    if (typeof c === 'number' && isArray(next)) {
      next.forEach((wi, j) => { const n = resolve(wi); if (typeof n === 'number') widths.set(c + j, n); });
      i += 2;
    } else { i += 1; }
  }
  return widths;
}
