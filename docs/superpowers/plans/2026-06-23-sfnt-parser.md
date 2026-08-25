# sfnt/TrueType Parser (gnr.2 / Track P) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse a TrueType/OpenType (`sfnt`) font program into an in-memory table model (`SfntFont`) that downstream Phase 7 tracks (subsetting, embedding) consume.

**Architecture:** One new pure module `src/sfnt.ts` exporting `parseSfnt(bytes) -> SfntFont`. No PDF objects, no document state, no new runtime deps — only big-endian reads over the input `Uint8Array`. A programmatic fixture builder (`test/helpers/build-sfnt.ts`) emits a minimal valid 3-glyph TrueType font so tests stay deterministic, matching the repo's "fixtures built by builders in test/helpers/" convention.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, `DataView` for binary reads.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins; this module needs none. Do not add npm deps.
- **ESM + NodeNext** — all relative imports carry the `.js` extension (e.g. `import { PdfParseError } from './errors.js'`).
- **Errors** — throw `PdfParseError` (malformed/truncated/missing table) or `UnsupportedFeatureError` (non-sfnt container, or `glyf` font with no usable Unicode cmap) from `./errors.js`. No other error types.
- **Internal module** — `parseSfnt`/`SfntFont` are `@internal`; not added to `src/index.ts` in this task (E1/A1 decide the public surface).
- **TDD** — failing test first; run `npx vitest run test/sfnt.test.ts` per task; `npm run typecheck` must stay green.
- **Units** — all metrics returned in **font units** (the caller scales by `1000/unitsPerEm`). cmap maps a Unicode code point to a glyph id (GID).
- Spec: `docs/superpowers/specs/2026-06-23-font-embedding-subsetting-design.md` (Track P).

---

## File Structure

- **Create** `src/sfnt.ts` — the parser: `Reader` (big-endian byte reader), `parseSfnt`, the `SfntFont` class, and table-decode helpers. One responsibility: bytes → table model.
- **Create** `test/helpers/build-sfnt.ts` — programmatic minimal TrueType font builder for fixtures.
- **Create** `test/sfnt.test.ts` — the parser's vitest suite.

The `SfntFont` shape this task delivers (consumed by gnr.3/gnr.4):

```ts
export type OutlineKind = 'glyf' | 'cff';

export interface SfntFont {
  outlines: OutlineKind;
  unitsPerEm: number;
  numGlyphs: number;
  indexToLocFormat: 0 | 1;
  bbox: [number, number, number, number]; // xMin,yMin,xMax,yMax (font units)
  ascent: number; descent: number; capHeight: number;
  italicAngle: number; flags: number; stemV: number;
  postScriptName: string | undefined;
  raw: Uint8Array;                          // original sfnt bytes (CFF whole-embed)
  advanceWidth(gid: number): number;        // hmtx, font units
  cmapLookup(cp: number): number | undefined; // code point -> GID
  cmapReverse(): Map<number, number>;       // GID -> first code point
  glyphData(gid: number): Uint8Array;       // raw glyf bytes (glyf only; [] if empty/cff)
  componentGids(gid: number): number[];     // composite component GIDs (glyf only)
}
```

---

## Task 1: Minimal TrueType fixture builder

**Files:**
- Create: `test/helpers/build-sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `buildMinimalTtf(): Uint8Array` — a valid TrueType sfnt with 3 glyphs: gid 0 `.notdef` (empty), gid 1 `'A'`=0x41 (simple), gid 2 `'B'`=0x42 (composite referencing gid 1). `unitsPerEm`=1000; advance widths 500/600/700; OS/2 weight 400, capHeight 700, ascent 800, descent −200; PostScript name `TestFont`.

- [ ] **Step 1: Write the failing test**

```ts
// test/sfnt.test.ts
import { describe, it, expect } from 'vitest';
import { buildMinimalTtf } from './helpers/build-sfnt.js';

describe('build-sfnt fixture', () => {
  it('emits a TrueType sfnt header with 10 tables', () => {
    const ttf = buildMinimalTtf();
    const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
    expect(v.getUint32(0)).toBe(0x00010000); // sfnt version 1.0 (TrueType)
    expect(v.getUint16(4)).toBe(10);          // numTables
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — cannot find module `./helpers/build-sfnt.js`.

- [ ] **Step 3: Write the fixture builder**

```ts
// test/helpers/build-sfnt.ts
// Builds a minimal valid TrueType (glyf) sfnt for parser tests.
// Glyphs: 0=.notdef (empty), 1='A' (simple), 2='B' (composite -> 1).

function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function i16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function pad4(b: Uint8Array): Uint8Array {
  const r = b.length % 4; if (r === 0) return b;
  return concat([b, new Uint8Array(4 - r)]);
}

function buildHead(): Uint8Array {
  const b = new Uint8Array(54); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setUint32(12, 0x5F0F3CF5);  // magicNumber
  v.setUint16(18, 1000);        // unitsPerEm
  v.setInt16(36, 0); v.setInt16(38, -200); v.setInt16(40, 700); v.setInt16(42, 800); // bbox
  v.setInt16(50, 0);            // indexToLocFormat = 0 (short)
  return b;
}
function buildMaxp(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setUint16(4, 3);            // numGlyphs
  return b;
}
function buildHhea(): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setInt16(4, 800); v.setInt16(6, -200); // ascender/descender
  v.setUint16(34, 3);           // numberOfHMetrics
  return b;
}
function buildHmtx(): Uint8Array {
  // 3 longHorMetrics: (advanceWidth u16, lsb i16)
  return concat([u16(500), i16(0), u16(600), i16(0), u16(700), i16(0)]);
}
function buildCmap(): Uint8Array {
  // format 4 mapping 0x41->1, 0x42->2 (+ required 0xFFFF terminator segment)
  const idDelta0 = (1 - 0x41) & 0xffff; // -64 -> 65472; 0x41+(-64)=1, 0x42+(-64)=2
  const sub = concat([
    u16(4), u16(32), u16(0),          // format, length, language
    u16(4), u16(4), u16(1), u16(0),   // segCountX2, searchRange, entrySelector, rangeShift
    u16(0x42), u16(0xFFFF),           // endCode[2]
    u16(0),                            // reservedPad
    u16(0x41), u16(0xFFFF),           // startCode[2]
    u16(idDelta0), u16(1),            // idDelta[2]
    u16(0), u16(0),                   // idRangeOffset[2]
  ]);
  const header = concat([u16(0), u16(1), u16(3), u16(1), u32(12)]); // version, numTables, (plat3,enc1,offset12)
  return concat([header, sub]);
}
function buildGlyf(): { glyf: Uint8Array; loca: Uint8Array } {
  const g0 = new Uint8Array(0); // .notdef empty
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]); // simple: numContours=1 + bbox (10 bytes)
  const flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
  const g2 = concat([i16(-1), i16(0), i16(0), i16(0x100), i16(0x100), u16(flags), u16(1), i16(0), i16(0)]); // composite -> gid 1 (18 bytes)
  const glyf = concat([g0, g1, g2]);
  const offs = [0, g0.length, g0.length + g1.length, g0.length + g1.length + g2.length]; // 0,0,10,28
  const loca = concat(offs.map((o) => u16(o / 2))); // short loca: offset/2 -> [0,0,5,14]
  return { glyf, loca };
}
function buildName(): Uint8Array {
  const psName = new TextEncoder().encode('TestFont'); // platform 1 ASCII
  const header = concat([u16(0), u16(1), u16(6 + 12)]); // format, count, stringOffset
  const record = concat([u16(1), u16(0), u16(0), u16(6), u16(psName.length), u16(0)]); // plat1,enc0,lang0,nameID6,len,off
  return concat([header, record, psName]);
}
function buildOS2(): Uint8Array {
  const b = new Uint8Array(96); const v = new DataView(b.buffer);
  v.setUint16(0, 4);            // version
  v.setUint16(4, 400);         // usWeightClass
  v.setUint16(62, 0x40);       // fsSelection: REGULAR
  v.setInt16(68, 800);         // sTypoAscender
  v.setInt16(70, -200);        // sTypoDescender
  v.setInt16(88, 700);         // sCapHeight
  return b;
}
function buildPost(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00030000);   // version 3.0 (no glyph names)
  v.setInt32(4, 0);             // italicAngle (16.16) = 0
  return b;
}

export function buildMinimalTtf(): Uint8Array {
  const { glyf, loca } = buildGlyf();
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea() },
    { tag: 'hmtx', data: buildHmtx() },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  const dirSize = 12 + numTables * 16;
  // Lay out table bodies 4-byte aligned after the directory.
  let offset = dirSize;
  const placed = tables.map((t) => {
    const at = offset; const padded = pad4(t.data); offset += padded.length;
    return { tag: t.tag, at, length: t.data.length, padded };
  });
  // Offset table (searchRange etc. are ignored by the parser; computed for realism).
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const offsetTable = concat([
    u32(0x00010000), u16(numTables), u16(searchRange), u16(entrySelector),
    u16(numTables * 16 - searchRange),
  ]);
  const dir = concat(placed.map((p) =>
    concat([new TextEncoder().encode(p.tag), u32(0) /*checksum ignored*/, u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-sfnt.ts test/sfnt.test.ts
git commit -m "test(gnr.2): minimal TrueType fixture builder for sfnt parser"
```

---

## Task 2: Table directory + outline-kind detection

**Files:**
- Create: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `parseSfnt(bytes: Uint8Array): SfntFont`. After this task `SfntFont` exposes `outlines`, `numGlyphs`, `raw`, and an internal table map; later tasks fill the rest.
- Internal: `class Reader` (big-endian `u16`/`i16`/`u32`/`i32`/`tag`, bounds-checked, throwing `PdfParseError`).

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
import { parseSfnt } from '../src/sfnt.js';

describe('parseSfnt: directory', () => {
  it('reads the table directory and reports a glyf TrueType font', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.outlines).toBe('glyf');
    expect(f.numGlyphs).toBe(3);
  });

  it('throws PdfParseError on a truncated header', () => {
    expect(() => parseSfnt(new Uint8Array([0, 1, 0]))).toThrow(/PdfParseError|truncat/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — cannot find module `../src/sfnt.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/sfnt.ts
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export type OutlineKind = 'glyf' | 'cff';

interface TableRec { offset: number; length: number; }

class Reader {
  private view: DataView;
  constructor(public bytes: Uint8Array, public pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new PdfParseError('unexpected end of font data', this.pos);
  }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  tag(): string { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4)); this.pos += 4; return s; }
}

export class SfntFont {
  readonly outlines: OutlineKind;
  readonly raw: Uint8Array;
  /** @internal */ readonly tables: Map<string, TableRec>;
  numGlyphs = 0;

  constructor(bytes: Uint8Array) {
    this.raw = bytes;
    const r = new Reader(bytes);
    const version = r.u32();
    if (version === 0x74727565 /* 'true' */ || version === 0x00010000) { /* TrueType */ }
    else if (version === 0x4F54544F /* 'OTTO' */) { /* OpenType CFF */ }
    else if (version === 0x774F4646 /* 'wOFF' */ || version === 0x774F4632 /* 'wOF2' */)
      throw new UnsupportedFeatureError('WOFF/WOFF2 fonts are not supported; provide a raw sfnt (.ttf/.otf)');
    else throw new PdfParseError(`unrecognized sfnt version 0x${version.toString(16)}`, 0);

    const numTables = r.u16();
    r.u16(); r.u16(); r.u16(); // searchRange, entrySelector, rangeShift (ignored)
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const tag = r.tag(); const checksum = r.u32(); void checksum;
      const offset = r.u32(); const length = r.u32();
      this.tables.set(tag, { offset, length });
    }
    this.outlines = this.tables.has('CFF ') ? 'cff' : 'glyf';
    if (this.outlines === 'glyf' && !this.tables.has('glyf'))
      throw new PdfParseError('font has neither a glyf nor a CFF table');
  }

  /** @internal Return a table's bytes, or throw if a required table is absent. */
  table(tag: string, required = true): Uint8Array | undefined {
    const rec = this.tables.get(tag);
    if (!rec) { if (required) throw new PdfParseError(`missing required '${tag}' table`); return undefined; }
    if (rec.offset + rec.length > this.raw.length) throw new PdfParseError(`'${tag}' table out of bounds`, rec.offset);
    return this.raw.subarray(rec.offset, rec.offset + rec.length);
  }
}

export function parseSfnt(bytes: Uint8Array): SfntFont {
  const f = new SfntFont(bytes);
  const maxp = f.table('maxp')!;
  f.numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
  return f;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): sfnt table directory + outline-kind detection"
```

---

## Task 3: head & maxp metrics (unitsPerEm, indexToLocFormat, bbox)

**Files:**
- Modify: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `f.unitsPerEm`, `f.indexToLocFormat`, `f.bbox` on `SfntFont`.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
describe('parseSfnt: head', () => {
  it('reads unitsPerEm, loca format, and bbox', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.unitsPerEm).toBe(1000);
    expect(f.indexToLocFormat).toBe(0);
    expect(f.bbox).toEqual([0, -200, 700, 800]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `f.unitsPerEm` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Add fields to `SfntFont` and populate them in `parseSfnt` (after `numGlyphs`):

```ts
// in class SfntFont, add fields:
  unitsPerEm = 1000;
  indexToLocFormat: 0 | 1 = 0;
  bbox: [number, number, number, number] = [0, 0, 0, 0];
```

```ts
// in parseSfnt, after setting numGlyphs:
  const head = f.table('head')!;
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  f.unitsPerEm = hv.getUint16(18) || 1000;
  f.bbox = [hv.getInt16(36), hv.getInt16(38), hv.getInt16(40), hv.getInt16(42)];
  f.indexToLocFormat = hv.getInt16(50) === 1 ? 1 : 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): parse head (unitsPerEm, loca format, bbox)"
```

---

## Task 4: hhea & hmtx (advanceWidth)

**Files:**
- Modify: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `f.advanceWidth(gid: number): number` (font units). For `gid >= numberOfHMetrics`, returns the last long metric's advance (monospace tail rule).

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
describe('parseSfnt: hmtx', () => {
  it('returns advance widths per glyph', () => {
    const f = parseSfnt(buildMinimalTtf());
    expect(f.advanceWidth(0)).toBe(500);
    expect(f.advanceWidth(1)).toBe(600);
    expect(f.advanceWidth(2)).toBe(700);
    expect(f.advanceWidth(99)).toBe(700); // beyond numberOfHMetrics -> last advance
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `f.advanceWidth is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// in class SfntFont add a private field + method:
  private advances: number[] = [];

  advanceWidth(gid: number): number {
    if (this.advances.length === 0) return 0;
    const i = Math.min(gid, this.advances.length - 1);
    return this.advances[i] ?? this.advances[this.advances.length - 1];
  }
```

```ts
// in parseSfnt, after head:
  const hhea = f.table('hhea')!;
  const numberOfHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
  const hmtx = f.table('hmtx')!;
  const mv = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
  const advances: number[] = [];
  for (let i = 0; i < numberOfHMetrics; i++) advances.push(mv.getUint16(i * 4));
  (f as unknown as { advances: number[] }).advances = advances;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): parse hhea/hmtx advance widths"
```

---

## Task 5: cmap format 4 (cmapLookup, cmapReverse)

**Files:**
- Modify: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `f.cmapLookup(cp): number | undefined` and `f.cmapReverse(): Map<number, number>` (GID → first code point). Supports cmap subtable formats 4 and 12; prefers a Windows Unicode subtable `(3,1)`/`(3,10)`, falling back to `(0,*)`. A `glyf` font with no usable Unicode subtable throws `UnsupportedFeatureError`.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `f.cmapLookup is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// in class SfntFont add:
  private cmap: Map<number, number> = new Map(); // code point -> gid

  cmapLookup(cp: number): number | undefined { return this.cmap.get(cp); }

  cmapReverse(): Map<number, number> {
    const rev = new Map<number, number>();
    for (const [cp, gid] of this.cmap) if (!rev.has(gid)) rev.set(gid, cp);
    return rev;
  }
```

```ts
// at module scope in src/sfnt.ts:
function parseCmapSubtable(data: Uint8Array, base: number): Map<number, number> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = v.getUint16(base);
  const out = new Map<number, number>();
  if (format === 4) {
    const segX2 = v.getUint16(base + 6); const segCount = segX2 / 2;
    const endBase = base + 14;
    const startBase = endBase + segX2 + 2;        // + reservedPad
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let s = 0; s < segCount; s++) {
      const end = v.getUint16(endBase + s * 2);
      const start = v.getUint16(startBase + s * 2);
      const delta = v.getUint16(deltaBase + s * 2);
      const rangeOff = v.getUint16(rangeBase + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let gid: number;
        if (rangeOff === 0) gid = (c + delta) & 0xffff;
        else {
          const gi = v.getUint16(rangeBase + s * 2 + rangeOff + (c - start) * 2);
          gid = gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        if (gid !== 0) out.set(c, gid);
      }
    }
  } else if (format === 12) {
    const nGroups = v.getUint32(base + 12);
    let g = base + 16;
    for (let i = 0; i < nGroups; i++) {
      const startChar = v.getUint32(g); const endChar = v.getUint32(g + 4); const startGid = v.getUint32(g + 8);
      for (let c = startChar; c <= endChar; c++) out.set(c, startGid + (c - startChar));
      g += 12;
    }
  }
  return out;
}

function readCmap(data: Uint8Array): Map<number, number> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = v.getUint16(2);
  const candidates: { score: number; offset: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 4 + i * 8;
    const plat = v.getUint16(rec); const enc = v.getUint16(rec + 2); const off = v.getUint32(rec + 4);
    let score = -1;
    if (plat === 3 && enc === 10) score = 4;       // Windows UCS-4
    else if (plat === 3 && enc === 1) score = 3;   // Windows BMP
    else if (plat === 0) score = 2;                // Unicode
    else if (plat === 3 && enc === 0) score = 1;   // Windows Symbol
    if (score >= 0) candidates.push({ score, offset: off });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    const m = parseCmapSubtable(data, c.offset);
    if (m.size > 0) return m;
  }
  return new Map();
}
```

```ts
// in parseSfnt, after hmtx:
  const cmapTable = f.table('cmap', f.outlines === 'glyf'); // required for glyf authoring
  if (cmapTable) (f as unknown as { cmap: Map<number, number> }).cmap = readCmap(cmapTable);
  if (f.outlines === 'glyf' && (f as unknown as { cmap: Map<number, number> }).cmap.size === 0)
    throw new UnsupportedFeatureError('font has no usable Unicode cmap (need format 4 or 12)');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): parse cmap formats 4 and 12 (lookup + reverse)"
```

---

## Task 6: loca & glyf (glyphData, componentGids)

**Files:**
- Modify: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `f.glyphData(gid): Uint8Array` (raw glyf bytes; empty `Uint8Array` for empty/`.notdef` or CFF), and `f.componentGids(gid): number[]` (composite component GIDs; `[]` for simple/empty glyphs). These feed gnr.3's glyph-closure subsetting.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `f.glyphData is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// in class SfntFont add:
  private loca: number[] = []; // numGlyphs+1 byte offsets into glyf
  private glyf: Uint8Array = new Uint8Array(0);

  glyphData(gid: number): Uint8Array {
    if (this.outlines !== 'glyf' || gid < 0 || gid + 1 >= this.loca.length) return new Uint8Array(0);
    return this.glyf.subarray(this.loca[gid], this.loca[gid + 1]);
  }

  componentGids(gid: number): number[] {
    const g = this.glyphData(gid);
    if (g.length < 2) return [];
    const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
    if (v.getInt16(0) >= 0) return []; // simple glyph
    const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
      X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080;
    const gids: number[] = [];
    let p = 10; // skip numberOfContours(2) + bbox(8)
    for (;;) {
      const flags = v.getUint16(p); const glyphIndex = v.getUint16(p + 2);
      gids.push(glyphIndex);
      p += 4;
      p += (flags & ARG_WORDS) ? 4 : 2;
      if (flags & WE_HAVE_A_SCALE) p += 2;
      else if (flags & X_AND_Y_SCALE) p += 4;
      else if (flags & TWO_BY_TWO) p += 8;
      if (!(flags & MORE)) break;
    }
    return gids;
  }
```

```ts
// in parseSfnt, after cmap (glyf fonts only):
  if (f.outlines === 'glyf') {
    const locaBytes = f.table('loca')!;
    const lv = new DataView(locaBytes.buffer, locaBytes.byteOffset, locaBytes.byteLength);
    const loca: number[] = [];
    for (let i = 0; i <= f.numGlyphs; i++)
      loca.push(f.indexToLocFormat === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4));
    (f as unknown as { loca: number[] }).loca = loca;
    (f as unknown as { glyf: Uint8Array }).glyf = f.table('glyf')!;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): parse loca/glyf (glyph data + composite components)"
```

---

## Task 7: Descriptor metadata (name, OS/2, post)

**Files:**
- Modify: `src/sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `f.postScriptName`, `f.ascent`, `f.descent`, `f.capHeight`, `f.italicAngle`, `f.flags`, `f.stemV` (font units / FontDescriptor values). `stemV` is approximated from OS/2 weight class. `flags` sets Nonsymbolic (bit 6 = 32) and Italic (bit 7 = 64) when applicable.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `f.postScriptName` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```ts
// in class SfntFont add fields:
  ascent = 0; descent = 0; capHeight = 0; italicAngle = 0; flags = 0; stemV = 0;
  postScriptName: string | undefined;
```

```ts
// module scope: read PostScript name (nameID 6) from the name table.
function readPostScriptName(data: Uint8Array): string | undefined {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(2); const stringOffset = v.getUint16(4);
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    const plat = v.getUint16(rec); const nameID = v.getUint16(rec + 6);
    const len = v.getUint16(rec + 8); const off = v.getUint16(rec + 10);
    if (nameID !== 6) continue;
    const bytes = data.subarray(stringOffset + off, stringOffset + off + len);
    if (plat === 3) { // UTF-16BE
      let s = ''; for (let j = 0; j + 1 < bytes.length; j += 2) s += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
      return s;
    }
    return String.fromCharCode(...bytes); // platform 1 ASCII
  }
  return undefined;
}
```

```ts
// in parseSfnt, after glyf block:
  const name = f.table('name', false);
  if (name) f.postScriptName = readPostScriptName(name);

  const head2 = f.table('head')!;
  const macStyle = new DataView(head2.buffer, head2.byteOffset, head2.byteLength).getUint16(44);

  const os2 = f.table('OS/2', false);
  let weight = 400;
  if (os2) {
    const ov = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    const ver = ov.getUint16(0);
    weight = ov.getUint16(4) || 400;
    f.ascent = ov.getInt16(68);
    f.descent = ov.getInt16(70);
    f.capHeight = ver >= 2 && os2.length >= 90 ? ov.getInt16(88) : Math.round(f.ascent * 0.7);
  } else {
    const hh = f.table('hhea')!; const hv = new DataView(hh.buffer, hh.byteOffset, hh.byteLength);
    f.ascent = hv.getInt16(4); f.descent = hv.getInt16(6); f.capHeight = Math.round(f.ascent * 0.7);
  }

  const post = f.table('post', false);
  if (post) {
    const pv = new DataView(post.buffer, post.byteOffset, post.byteLength);
    f.italicAngle = pv.getInt32(4) / 65536; // 16.16 fixed
  }

  const italic = (macStyle & 0x02) !== 0 || f.italicAngle !== 0;
  f.flags = 32 /* Nonsymbolic */ | (italic ? 64 /* Italic */ : 0);
  f.stemV = Math.max(50, Math.round((weight / 1000) * 220)); // approximation
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts
git commit -m "feat(gnr.2): derive FontDescriptor metadata (name/OS2/post)"
```

---

## Task 8: Error & CFF-detection edge cases

**Files:**
- Modify: `src/sfnt.ts` (only if a test reveals a gap)
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Consumes: everything above. Locks the error contract: WOFF → `UnsupportedFeatureError`; missing required table → `PdfParseError`; CFF `OTTO` font → `outlines: 'cff'` with metrics still readable and no `glyf` requirement.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts
import { UnsupportedFeatureError, PdfParseError } from '../src/errors.js';

describe('parseSfnt: edge cases', () => {
  it('rejects WOFF containers', () => {
    const woff = new Uint8Array(16); new DataView(woff.buffer).setUint32(0, 0x774F4646);
    expect(() => parseSfnt(woff)).toThrow(UnsupportedFeatureError);
  });

  it('reports a CFF OpenType font as cff outlines without requiring glyf', () => {
    // Re-tag the minimal font as OTTO and add an empty 'CFF ' table by hand.
    const cff = makeOttoWithCff();
    const f = parseSfnt(cff);
    expect(f.outlines).toBe('cff');
    expect(f.unitsPerEm).toBe(1000);
    expect(f.glyphData(1).length).toBe(0); // cff: no glyf access
  });

  it('throws PdfParseError when a required table is missing', () => {
    const noMaxp = stripTable(buildMinimalTtf(), 'maxp');
    expect(() => parseSfnt(noMaxp)).toThrow(PdfParseError);
  });
});
```

Add these two helpers to `test/helpers/build-sfnt.ts` and export them:

```ts
// test/helpers/build-sfnt.ts — append

/** Rebuild a font's offset table + directory with `tag` removed (body left in place,
 *  directory entry dropped) to simulate a missing required table. */
export function stripTable(ttf: Uint8Array, tag: string): Uint8Array {
  const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const numTables = v.getUint16(4);
  const keep: { tag: string; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = String.fromCharCode(...ttf.subarray(rec, rec + 4));
    if (t === tag) continue;
    keep.push({ tag: t, checksum: v.getUint32(rec + 4), offset: v.getUint32(rec + 8), length: v.getUint32(rec + 12) });
  }
  const header = concat([u32(v.getUint32(0)), u16(keep.length), u16(0), u16(0), u16(0)]);
  const dir = concat(keep.map((k) =>
    concat([new TextEncoder().encode(k.tag), u32(k.checksum), u32(k.offset), u32(k.length)])));
  // Body offsets shift because the directory shrank by 16 bytes; rebuild bodies fresh.
  const dirSize = 12 + keep.length * 16;
  let offset = dirSize;
  const bodies: Uint8Array[] = [];
  const dir2parts: Uint8Array[] = [];
  for (const k of keep) {
    const body = pad4(ttf.subarray(k.offset, k.offset + k.length));
    dir2parts.push(concat([new TextEncoder().encode(k.tag), u32(0), u32(offset), u32(k.length)]));
    bodies.push(body); offset += body.length;
  }
  void header; void dir;
  return concat([concat([u32(v.getUint32(0)), u16(keep.length), u16(0), u16(0), u16(0)]), ...dir2parts, ...bodies]);
}

/** Minimal OTTO (CFF) font: the glyf-flavored fixture's metric tables plus an
 *  empty 'CFF ' table, re-tagged 'OTTO', with no 'glyf'/'loca'. */
export function makeOttoWithCff(): Uint8Array {
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'CFF ', data: new Uint8Array(4) },
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea() },
    { tag: 'hmtx', data: buildHmtx() },
    { tag: 'maxp', data: buildMaxp() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const dirSize = 12 + tables.length * 16;
  let offset = dirSize;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x4F54544F), u16(tables.length), u16(0), u16(0), u16(0)]); // 'OTTO'
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}
```

To export the table-builder helpers `makeOttoWithCff` reuses, change their declarations in `build-sfnt.ts` from `function buildOS2()`… to `export function buildOS2()` for `buildHead`, `buildMaxp`, `buildHhea`, `buildHmtx`, `buildCmap`, `buildName`, `buildOS2`, `buildPost` (the `concat`/`pad4`/`u16`/`u32` helpers are already module-scoped and reachable).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — `makeOttoWithCff`/`stripTable` not exported (and the CFF case may surface a real gap).

- [ ] **Step 3: Adjust implementation if needed**

The Task 2 constructor already detects `OTTO`/`CFF ` and the Task 3–7 `parseSfnt` reads head/hmtx/cmap/metadata for all fonts while gating loca/glyf behind `outlines === 'glyf'`. If the CFF test fails because `cmap` is marked required only for glyf (correct) or a metric read overruns, fix by guarding the offending read. Expected outcome: no `src/sfnt.ts` change beyond what Tasks 2–7 produced; if one is needed, keep it to a guarded read.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS (all suites); typecheck clean.

- [ ] **Step 5: Run the full suite + commit**

Run: `npm test` and `npm run typecheck`
Expected: full suite green (no regression in existing tests); typecheck clean.

```bash
git add src/sfnt.ts test/sfnt.test.ts test/helpers/build-sfnt.ts
git commit -m "feat(gnr.2): lock sfnt error contract + CFF outline detection"
```

---

## Self-Review (completed during planning)

- **Spec coverage (Track P):** table directory + version (Task 2); head/maxp metrics (Task 3); hhea/hmtx widths (Task 4); cmap 4/12 lookup + reverse (Task 5); loca/glyf opaque data + composite components for closure (Task 6); name/OS2/post descriptor metadata incl. StemV approximation (Task 7); error taxonomy + CFF detection (Task 8). All Track-P bullets map to a task.
- **Type consistency:** `SfntFont` field/method names (`unitsPerEm`, `indexToLocFormat`, `advanceWidth`, `cmapLookup`, `cmapReverse`, `glyphData`, `componentGids`, `postScriptName`, `ascent`, `descent`, `capHeight`, `italicAngle`, `flags`, `stemV`, `raw`, `outlines`, `numGlyphs`, `bbox`) match the spec's `SfntFont` interface and are introduced once, then reused.
- **Placeholder scan:** none — every code step is concrete and runnable.
- **Out of scope (later children):** `glyf` outline point decoding, subsetting (gnr.3), any PDF object emission (gnr.4), authoring wiring (gnr.5). `parseSfnt` stays `@internal` (not exported from `index.ts`) until E1/A1.

## Notes for the executor

- The `(f as unknown as { field })` casts populate private fields from the free `parseSfnt` function; if you prefer, fold these reads into the `SfntFont` constructor instead — keep the public field/method names identical either way.
- Run `npx vitest run test/sfnt.test.ts` after each task and `npm test` before the final commit. `npm run typecheck` must stay green throughout.
