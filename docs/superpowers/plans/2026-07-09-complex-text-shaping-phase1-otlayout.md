# Complex-text shaping Phase 1 — OpenType layout core (GSUB/GPOS/GDEF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse `GDEF`/`GSUB`/`GPOS` from an embedded sfnt and apply an OpenType feature set to a glyph buffer — substitution (GSUB) and positioning (GPOS) — with no PDF integration, tested against synthetic fonts.

**Architecture:** One new pure module `src/otlayout.ts` (parser + applier) reachable from `SfntFont` via a lazily-cached `otLayout()` accessor. The engine follows HarfBuzz's model: a mutable **glyph buffer** (`ShapedGlyph[]`) is transformed by the enabled lookups in lookup-list order — GSUB rewrites gids/clusters, then GPOS fills advances/offsets. Everything absent or malformed **degrades to a no-op**, never throws. `test/helpers/build-sfnt.ts` is extended to emit synthetic `GDEF`/`GSUB`/`GPOS` tables so tests are deterministic.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, big-endian `DataView` reads over `Uint8Array`.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins (this module needs none). Do not add npm deps.
- **ESM + NodeNext** — every relative import carries the `.js` extension (e.g. `import { SfntFont } from './sfnt.js'`).
- **Internal module** — `otlayout.ts` symbols are `@internal`; do **not** add anything to `src/index.ts` in this phase (Phase 3 owns the public surface).
- **No PDF integration** — no `document.ts`/`page.ts`/`stamp.ts`/`embeddedfont.ts` edits in this phase. The only touched existing files are `src/sfnt.ts` (expose `otLayout()`) and `test/helpers/build-sfnt.ts` (emit synthetic OT tables).
- **Degrade, never throw** — absent/malformed `GDEF`/`GSUB`/`GPOS` (or any sub-structure) makes the affected step a pass-through. Wrap parse bodies so a `PdfParseError`/`RangeError` from an out-of-bounds read yields `undefined`/no-op, matching the library's "unsupported content degrades" convention. Do **not** introduce new public error types.
- **Units** — all positions/advances are **font units** (caller scales by `1000/unitsPerEm`). A "gid" is a glyph id; under Identity-H it equals the CID.
- **Offsets** — every OpenType sub-offset is relative to the **start of its parent table/subtable**, not the file. Track the base carefully per structure.
- **TDD** — failing test first; run `npx vitest run test/otlayout.test.ts` per task; `npm run typecheck` must stay green before closing.
- **Spec:** `docs/superpowers/specs/2026-07-08-complex-text-shaping-design.md` (Sections: Architecture, OpenType layout coverage, Testing). **bd issue:** `aspose-pdf-foss-for-ts-8u0.1`.

---

## File Structure

- **Create** `src/otlayout.ts` — the whole engine: OT byte reader, shared table primitives (Coverage, ClassDef, Script/Feature/Lookup lists, LangSys), `GDEF`, all GSUB/GPOS subtables, the `applyFeatures` driver, and the `parseOtLayout(sfnt)` entry point. One responsibility: OpenType layout parse + apply. It is large but cohesive; keep it one file (it mirrors how `sfnt.ts`/`cff.ts` keep a self-contained binary domain in one module).
- **Modify** `src/sfnt.ts` — add a lazily-cached `otLayout()` accessor (delegates to `parseOtLayout`).
- **Modify** `test/helpers/build-sfnt.ts` — add builders that emit `GDEF`/`GSUB`/`GPOS` and assemble fonts carrying them.
- **Create** `test/otlayout.test.ts` — the engine's vitest suite (parsing primitives + one test per lookup type + degradation).

### Data model (defined in Task 1, referenced everywhere)

```ts
// src/otlayout.ts — the mutable shaping buffer element.
export interface ShapedGlyph {
  gid: number;       // current glyph id (rewritten by GSUB)
  cluster: number;   // smallest source index this glyph descends from (merges on ligature)
  xAdvance: number;  // font units; seeded from hmtx, adjusted by GPOS
  xOffset: number;   // font units; GPOS placement (0 until positioned)
  yOffset: number;   // font units; GPOS placement (0 until positioned)
}

// Parsed layout for one font, cached on SfntFont.
export interface OtLayout {
  gsub?: OtTable;    // undefined when GSUB absent/malformed
  gpos?: OtTable;
  gdef?: Gdef;
}

// One of GSUB/GPOS.
export interface OtTable {
  scripts: Map<string, ScriptTable>;   // 4-char script tag -> script record
  features: FeatureRecord[];           // by feature index
  lookups: Lookup[];                   // by lookup index (parsed subtables)
}
export interface ScriptTable {
  dfltFeatures?: number[];             // feature indices for DefaultLangSys
  langSys: Map<string, number[]>;      // 4-char lang tag -> feature indices
}
export interface FeatureRecord { tag: string; lookupIndices: number[]; }
export interface Lookup {
  type: number;                        // 1..9 (post-extension-resolved)
  flag: number;                        // LookupFlag bits
  markFilteringSet?: number;           // present iff UseMarkFilteringSet
  subtables: Uint8Array[];             // raw subtable bytes; parsed on demand by type
}

// GDEF.
export interface Gdef {
  glyphClass?: ClassDef;               // 1=base 2=ligature 3=mark 4=component
  markAttachClass?: ClassDef;          // mark attachment class per gid
  markGlyphSets?: Coverage[];          // for UseMarkFilteringSet
}
```

LookupFlag bits (used by the mark filter):

```ts
const RIGHT_TO_LEFT = 0x0001, IGNORE_BASE = 0x0002, IGNORE_LIGATURES = 0x0004,
  IGNORE_MARKS = 0x0008, USE_MARK_FILTERING_SET = 0x0010, MARK_ATTACH_TYPE = 0xFF00;
```

---

## Task 1: OT byte reader + Coverage + ClassDef primitives

**Files:**
- Create: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Produces: `class OtReader` (big-endian reads with an absolute base); `interface Coverage { index(gid): number | -1 }` via `parseCoverage(bytes, off): Coverage`; `interface ClassDef { classOf(gid): number }` via `parseClassDef(bytes, off): ClassDef`. `off` is relative to the table these live in; the parser is given the parent table bytes plus the offset. Also the `ShapedGlyph`/`OtLayout`/… types above.

Coverage maps a gid to a **coverage index** (its ordinal position in the table) or `-1` if absent. ClassDef maps a gid to a class number (0 if unlisted). Both come in two formats; both are the shared backbone of every lookup.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts
import { describe, it, expect } from 'vitest';
import { parseCoverage, parseClassDef, OtReader } from '../src/otlayout.js';

// Coverage format 1: sorted glyph list [5, 9, 12] -> indices 0,1,2.
function covFmt1(gids: number[]): Uint8Array {
  const b = new Uint8Array(4 + gids.length * 2);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1); v.setUint16(2, gids.length);
  gids.forEach((g, i) => v.setUint16(4 + i * 2, g));
  return b;
}
// Coverage format 2: ranges. Each range = start,end,startCoverageIndex.
function covFmt2(ranges: [number, number, number][]): Uint8Array {
  const b = new Uint8Array(4 + ranges.length * 6);
  const v = new DataView(b.buffer);
  v.setUint16(0, 2); v.setUint16(2, ranges.length);
  ranges.forEach(([s, e, i], k) => { v.setUint16(4 + k * 6, s); v.setUint16(6 + k * 6, e); v.setUint16(8 + k * 6, i); });
  return b;
}

describe('parseCoverage', () => {
  it('format 1 maps gid -> ordinal coverage index', () => {
    const c = parseCoverage(covFmt1([5, 9, 12]), 0);
    expect(c.index(5)).toBe(0);
    expect(c.index(9)).toBe(1);
    expect(c.index(12)).toBe(2);
    expect(c.index(7)).toBe(-1);
  });
  it('format 2 maps ranges to coverage indices', () => {
    const c = parseCoverage(covFmt2([[10, 12, 0], [20, 20, 3]]), 0);
    expect(c.index(10)).toBe(0);
    expect(c.index(12)).toBe(2);
    expect(c.index(20)).toBe(3);
    expect(c.index(13)).toBe(-1);
  });
});

describe('parseClassDef', () => {
  it('format 2 (range) returns the class of a gid, 0 if unlisted', () => {
    const b = new Uint8Array(4 + 6);
    const v = new DataView(b.buffer);
    v.setUint16(0, 2); v.setUint16(2, 1);            // format 2, 1 range
    v.setUint16(4, 5); v.setUint16(6, 8); v.setUint16(8, 2); // gids 5..8 -> class 2
    const cd = parseClassDef(b, 0);
    expect(cd.classOf(6)).toBe(2);
    expect(cd.classOf(4)).toBe(0);
    expect(cd.classOf(9)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — cannot find module `../src/otlayout.js` / exports not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts
// OpenType Layout (GDEF/GSUB/GPOS) parse + apply. Zero deps. Degrades to no-op
// on malformed data — never throws out of the public entry points.

export interface ShapedGlyph { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number; }

/** Big-endian reader over a slice, with an absolute base for offset arithmetic. */
export class OtReader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(p: number): number { return this.view.getUint16(p); }
  i16(p: number): number { return this.view.getInt16(p); }
  u32(p: number): number { return this.view.getUint32(p); }
  tag(p: number): string { return String.fromCharCode(this.bytes[p], this.bytes[p + 1], this.bytes[p + 2], this.bytes[p + 3]); }
}

export interface Coverage { index(gid: number): number; }

/** Parse a Coverage table at `off` within `bytes`. `index` returns -1 if absent. */
export function parseCoverage(bytes: Uint8Array, off: number): Coverage {
  const r = new OtReader(bytes);
  const format = r.u16(off);
  if (format === 1) {
    const count = r.u16(off + 2);
    const map = new Map<number, number>();
    for (let i = 0; i < count; i++) map.set(r.u16(off + 4 + i * 2), i);
    return { index: (g) => map.get(g) ?? -1 };
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    const ranges: { start: number; end: number; base: number }[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({ start: r.u16(p), end: r.u16(p + 2), base: r.u16(p + 4) });
    }
    return {
      index: (g) => {
        for (const rg of ranges) if (g >= rg.start && g <= rg.end) return rg.base + (g - rg.start);
        return -1;
      },
    };
  }
  return { index: () => -1 };
}

export interface ClassDef { classOf(gid: number): number; }

/** Parse a ClassDef table at `off`. Unlisted gids are class 0. */
export function parseClassDef(bytes: Uint8Array, off: number): ClassDef {
  const r = new OtReader(bytes);
  const format = r.u16(off);
  if (format === 1) {
    const startGid = r.u16(off + 2);
    const count = r.u16(off + 4);
    const classes: number[] = [];
    for (let i = 0; i < count; i++) classes.push(r.u16(off + 6 + i * 2));
    return { classOf: (g) => (g >= startGid && g < startGid + count) ? classes[g - startGid] : 0 };
  }
  if (format === 2) {
    const count = r.u16(off + 2);
    const ranges: { start: number; end: number; cls: number }[] = [];
    for (let i = 0; i < count; i++) {
      const p = off + 4 + i * 6;
      ranges.push({ start: r.u16(p), end: r.u16(p + 2), cls: r.u16(p + 4) });
    }
    return {
      classOf: (g) => {
        for (const rg of ranges) if (g >= rg.start && g <= rg.end) return rg.cls;
        return 0;
      },
    };
  }
  return { classOf: () => 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS (all Coverage/ClassDef cases). Then `npm run typecheck` — green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): OT reader + Coverage/ClassDef primitives"
```

---

## Task 2: Header parsing — Script/Feature/Lookup lists + feature resolution

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `OtReader`, the `OtTable`/`ScriptTable`/`FeatureRecord`/`Lookup` types.
- Produces: `parseOtTable(bytes: Uint8Array): OtTable | undefined` (parses one GSUB/GPOS header: ScriptList, FeatureList, LookupList — subtable *bytes* only, no per-type decode yet); `resolveLookups(t: OtTable, script: string | undefined, lang: string | undefined, features: string[]): number[]` (enabled lookup indices, ascending/dedup, i.e. lookup-list order).

A GSUB/GPOS header (both share layout): `majorVersion(u16) minorVersion(u16) scriptListOffset(u16) featureListOffset(u16) lookupListOffset(u16)` — offsets relative to table start. Resolution: pick the `ScriptTable` for `script` (fallback to `'DFLT'`, then the first script); within it pick the `LangSys` for `lang` (fallback to default); that yields feature indices; keep those whose tag ∈ `features`; union their lookup indices; apply lookups in ascending index order.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
import { parseOtTable, resolveLookups } from '../src/otlayout.js';
import { buildGsub } from './helpers/build-sfnt.js'; // added in Task 11; here a local mini-builder:

// Minimal GSUB with one script 'latn' (default langsys), one feature 'liga'
// (feature index 0) referencing lookup 0, and one lookup (type 1, 0 subtables
// for this header-only test). See build-sfnt Task 11 for the real emitter.
```

Because the full GSUB emitter lands in Task 11, drive Task 2 with a **local inline builder** in the test file:

```ts
function u16a(...ns: number[]): Uint8Array { const b = new Uint8Array(ns.length * 2); const v = new DataView(b.buffer); ns.forEach((n, i) => v.setUint16(i * 2, n & 0xffff)); return b; }
function cat(...ps: Uint8Array[]): Uint8Array { const n = ps.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of ps) { o.set(p, k); k += p.length; } return o; }

// Assemble GSUB header: scripts at 10, features right after, lookups right after.
function miniGsub(): Uint8Array {
  // Layout offsets are computed to keep the test honest.
  const header = u16a(1, 0, /*script*/10, /*feature*/0, /*lookup*/0); // fill script/feature/lookup below
  // ScriptList: 1 record 'latn' -> ScriptTable
  //   ScriptList @ S: count(1) tag('latn') off-> ScriptTable
  //   ScriptTable @ ST: defaultLangSysOff, langSysCount(0)
  //   DefaultLangSys: lookupOrderOff(0) requiredFeatureIndex(0xFFFF) featureCount(1) featureIndex(0)
  // FeatureList: count(1) tag('liga') off-> Feature
  //   Feature: featureParamsOff(0) lookupCount(1) lookupIndex(0)
  // LookupList: count(1) off-> Lookup
  //   Lookup: type(1) flag(0) subtableCount(0)
  const tag = (s: string) => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);

  const defaultLangSys = u16a(0, 0xFFFF, 1, 0);                  // 8 bytes
  const scriptTable = cat(u16a(4 /*defaultLangSysOff from ScriptTable start*/, 0 /*langSysCount*/), defaultLangSys);
  const scriptList = cat(u16a(1), tag('latn'), u16a(0 /*ScriptTable off from ScriptList start, patched below*/));
  // ScriptTable off = 2(count)+4(tag)+2(off)=8 from ScriptList start:
  new DataView(scriptList.buffer).setUint16(6, 8);
  const feature = u16a(0, 1, 0);                                 // featureParams, lookupCount, lookupIndex
  const featureList = cat(u16a(1), tag('liga'), u16a(8 /*Feature off*/));
  const lookup = u16a(1, 0, 0);                                  // type1, flag0, subtableCount0
  const lookupList = cat(u16a(1), u16a(4 /*Lookup off from LookupList start*/), lookup);

  // Now place blocks after the 10-byte header and patch header offsets.
  const sOff = 10, fOff = sOff + scriptList.length, lOff = fOff + featureList.length;
  const hdr = u16a(1, 0, sOff, fOff, lOff);
  return cat(hdr, scriptList, featureList, lookupList);
}

describe('parseOtTable + resolveLookups', () => {
  it('parses scripts/features/lookups and resolves an enabled feature to lookups', () => {
    const t = parseOtTable(miniGsub())!;
    expect(t.lookups.length).toBe(1);
    expect(t.lookups[0].type).toBe(1);
    expect(resolveLookups(t, 'latn', undefined, ['liga'])).toEqual([0]);
    expect(resolveLookups(t, 'latn', undefined, ['kern'])).toEqual([]); // feature not present
  });
  it('falls back to first script when requested script is absent', () => {
    const t = parseOtTable(miniGsub())!;
    expect(resolveLookups(t, 'arab', undefined, ['liga'])).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `parseOtTable`/`resolveLookups` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)
export interface OtTable { scripts: Map<string, ScriptTable>; features: FeatureRecord[]; lookups: Lookup[]; }
export interface ScriptTable { dfltFeatures?: number[]; langSys: Map<string, number[]>; }
export interface FeatureRecord { tag: string; lookupIndices: number[]; }
export interface Lookup { type: number; flag: number; markFilteringSet?: number; subtables: Uint8Array[]; }

function parseLangSys(r: OtReader, off: number): number[] {
  // lookupOrder(u16, ignored) requiredFeatureIndex(u16) featureIndexCount(u16) featureIndices[]
  const count = r.u16(off + 4);
  const idx: number[] = [];
  const req = r.u16(off + 2);
  if (req !== 0xFFFF) idx.push(req);
  for (let i = 0; i < count; i++) idx.push(r.u16(off + 6 + i * 2));
  return idx;
}

function parseScriptList(r: OtReader, off: number): Map<string, ScriptTable> {
  const out = new Map<string, ScriptTable>();
  const count = r.u16(off);
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 6;
    const tag = r.tag(rec);
    const stOff = off + r.u16(rec + 4);           // ScriptTable off is from ScriptList start
    const dfltOff = r.u16(stOff);                 // from ScriptTable start (0 = none)
    const langCount = r.u16(stOff + 2);
    const st: ScriptTable = { langSys: new Map() };
    if (dfltOff) st.dfltFeatures = parseLangSys(r, stOff + dfltOff);
    for (let j = 0; j < langCount; j++) {
      const lrec = stOff + 4 + j * 6;
      const ltag = r.tag(lrec);
      st.langSys.set(ltag, parseLangSys(r, stOff + r.u16(lrec + 4)));
    }
    out.set(tag, st);
  }
  return out;
}

function parseFeatureList(r: OtReader, off: number): FeatureRecord[] {
  const count = r.u16(off);
  const out: FeatureRecord[] = [];
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 6;
    const tag = r.tag(rec);
    const fOff = off + r.u16(rec + 4);            // Feature off from FeatureList start
    const lookupCount = r.u16(fOff + 2);          // skip featureParams(u16)
    const lookupIndices: number[] = [];
    for (let k = 0; k < lookupCount; k++) lookupIndices.push(r.u16(fOff + 4 + k * 2));
    out.push({ tag, lookupIndices });
  }
  return out;
}

function parseLookupList(r: OtReader, off: number): Lookup[] {
  const count = r.u16(off);
  const out: Lookup[] = [];
  for (let i = 0; i < count; i++) {
    const lkOff = off + r.u16(off + 2 + i * 2);   // Lookup off from LookupList start
    const type = r.u16(lkOff);
    const flag = r.u16(lkOff + 2);
    const subCount = r.u16(lkOff + 4);
    const subtables: Uint8Array[] = [];
    for (let s = 0; s < subCount; s++) {
      const subOff = lkOff + r.u16(lkOff + 6 + s * 2); // subtable off from Lookup start
      subtables.push(r.bytes.subarray(subOff));        // slice from subtable start to end of table
    }
    const lk: Lookup = { type, flag, subtables };
    if (flag & USE_MARK_FILTERING_SET) lk.markFilteringSet = r.u16(lkOff + 6 + subCount * 2);
    out.push(lk);
  }
  return out;
}

/** Parse one GSUB or GPOS table header + sub-structure. `undefined` on malformed. */
export function parseOtTable(bytes: Uint8Array): OtTable | undefined {
  try {
    const r = new OtReader(bytes);
    const scriptOff = r.u16(4), featureOff = r.u16(6), lookupOff = r.u16(8);
    return {
      scripts: parseScriptList(r, scriptOff),
      features: parseFeatureList(r, featureOff),
      lookups: parseLookupList(r, lookupOff),
    };
  } catch { return undefined; }
}

/** Enabled lookup indices for (script, lang, features), in lookup-list order. */
export function resolveLookups(t: OtTable, script: string | undefined, lang: string | undefined, features: string[]): number[] {
  const want = new Set(features);
  let st = (script && t.scripts.get(script)) || t.scripts.get('DFLT') || t.scripts.get('dflt');
  if (!st) { const first = t.scripts.values().next(); st = first.done ? undefined : first.value; }
  if (!st) return [];
  const featureIdx = (lang && st.langSys.get(lang)) || st.dfltFeatures || [];
  const lookups = new Set<number>();
  for (const fi of featureIdx) {
    const f = t.features[fi];
    if (f && want.has(f.tag)) for (const li of f.lookupIndices) lookups.add(li);
  }
  return [...lookups].sort((a, b) => a - b);
}
```

Add the `USE_MARK_FILTERING_SET` constant (and the other flag bits) near the top of the file if not yet present:

```ts
const RIGHT_TO_LEFT = 0x0001, IGNORE_BASE = 0x0002, IGNORE_LIGATURES = 0x0004,
  IGNORE_MARKS = 0x0008, USE_MARK_FILTERING_SET = 0x0010, MARK_ATTACH_TYPE = 0xFF00;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS. `npm run typecheck` green (temporarily allow `RIGHT_TO_LEFT` etc. to be unused, or prefix with `void` usage — they are consumed in Task 3; if `noUnusedLocals` errors, keep them and finish Task 3 in the same session, or reference them in `MARK_ATTACH_TYPE`-based code added there).

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GSUB/GPOS header parsing + feature->lookup resolution"
```

---

## Task 3: GDEF + LookupFlag glyph filtering

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `parseCoverage`/`parseClassDef`, the flag constants, `Gdef`.
- Produces: `parseGdef(bytes): Gdef | undefined`; `class GlyphFilter` with `constructor(gdef, flag, markFilteringSet)` and `skip(gid): boolean` — the shared "does this lookup ignore this glyph?" predicate honoring `IgnoreBaseGlyphs`/`IgnoreLigatures`/`IgnoreMarks`/`MarkAttachmentType`/`UseMarkFilteringSet`.

GDEF header (v1.0): `majorVersion(u16) minorVersion(u16) glyphClassDefOffset(u16) attachListOffset(u16) ligCaretListOffset(u16) markAttachClassDefOffset(u16)`; v1.2 adds `markGlyphSetsDefOffset(u16)`. Glyph classes: 1=base, 2=ligature, 3=mark, 4=component. The filter is applied when *scanning* the buffer for a lookup's input glyphs.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
import { parseGdef, GlyphFilter } from '../src/otlayout.js';

// GDEF with a glyph ClassDef (format 2): gid 3 -> class 3 (mark), gid 4 -> class 1 (base).
function miniGdef(): Uint8Array {
  const cd = (() => { const b = new Uint8Array(4 + 12); const v = new DataView(b.buffer);
    v.setUint16(0, 2); v.setUint16(2, 2);
    v.setUint16(4, 3); v.setUint16(6, 3); v.setUint16(8, 3);   // 3..3 -> class 3
    v.setUint16(10, 4); v.setUint16(12, 4); v.setUint16(14, 1); // 4..4 -> class 1
    return b; })();
  const header = new Uint8Array(12); const v = new DataView(header.buffer);
  v.setUint16(0, 1); v.setUint16(2, 0);        // version 1.0
  v.setUint16(4, 12);                          // glyphClassDefOffset = 12 (right after header)
  const out = new Uint8Array(12 + cd.length); out.set(header, 0); out.set(cd, 12); return out;
}

describe('GDEF glyph filtering', () => {
  it('IgnoreMarks skips class-3 glyphs', () => {
    const g = parseGdef(miniGdef())!;
    const f = new GlyphFilter(g, 0x0008 /*IgnoreMarks*/, undefined);
    expect(f.skip(3)).toBe(true);   // mark
    expect(f.skip(4)).toBe(false);  // base
  });
  it('no flags skips nothing', () => {
    const g = parseGdef(miniGdef())!;
    const f = new GlyphFilter(g, 0, undefined);
    expect(f.skip(3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `parseGdef`/`GlyphFilter` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)
export interface Gdef { glyphClass?: ClassDef; markAttachClass?: ClassDef; markGlyphSets?: Coverage[]; }

export function parseGdef(bytes: Uint8Array): Gdef | undefined {
  try {
    const r = new OtReader(bytes);
    const minor = r.u16(2);
    const glyphClassOff = r.u16(4);
    const markAttachOff = r.u16(10);
    const g: Gdef = {};
    if (glyphClassOff) g.glyphClass = parseClassDef(bytes, glyphClassOff);
    if (markAttachOff) g.markAttachClass = parseClassDef(bytes, markAttachOff);
    if (minor >= 2) {
      const setsOff = r.u16(12);
      if (setsOff) {
        const count = r.u16(setsOff + 2);       // MarkGlyphSetsTable: format(u16) count(u16) coverageOffsets[](u32)
        const sets: Coverage[] = [];
        for (let i = 0; i < count; i++) sets.push(parseCoverage(bytes, setsOff + r.u32(setsOff + 4 + i * 4)));
        g.markGlyphSets = sets;
      }
    }
    return g;
  } catch { return undefined; }
}

/** "Should this lookup ignore glyph `gid`?" per LookupFlag + GDEF. */
export class GlyphFilter {
  private markAttach: number;
  constructor(private gdef: Gdef | undefined, private flag: number, private markSet: number | undefined) {
    this.markAttach = (flag & MARK_ATTACH_TYPE) >> 8;
  }
  skip(gid: number): boolean {
    const cls = this.gdef?.glyphClass?.classOf(gid) ?? 0;
    if ((this.flag & IGNORE_BASE) && cls === 1) return true;
    if ((this.flag & IGNORE_LIGATURES) && cls === 2) return true;
    if (cls === 3) { // mark
      if (this.flag & IGNORE_MARKS) return true;
      if ((this.flag & USE_MARK_FILTERING_SET) && this.markSet !== undefined) {
        const cov = this.gdef?.markGlyphSets?.[this.markSet];
        if (cov && cov.index(gid) === -1) return true; // mark not in the filtering set -> skip
      } else if (this.markAttach) {
        const ma = this.gdef?.markAttachClass?.classOf(gid) ?? 0;
        if (ma !== this.markAttach) return true;       // mark not of the required attach class -> skip
      }
    }
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS. `npm run typecheck` green (all flag constants now referenced).

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GDEF parsing + LookupFlag glyph filtering"
```

---

## Task 4: Buffer scanner + GSUB type 1 (Single) & type 4 (Ligature)

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `ShapedGlyph`, `Lookup`, `GlyphFilter`, `parseCoverage`.
- Produces: `applyGsubLookup(lk: Lookup, buf: ShapedGlyph[], gdef, layout: OtTable): void` (mutates `buf`; this task handles type 1 & 4, later tasks extend the `switch`); a `nextInputIndex(buf, from, filter)` helper for skipping ignored glyphs; and the cluster-merge convention.

**Cluster rule:** a ligature (N→1) sets the surviving glyph's `cluster` to the **minimum** cluster of its components; the removed glyphs are spliced out. Multiple/decomposition (1→N, Task 5) copies the source cluster to every output glyph. This yields the `gid → source code points` map Phase 3 needs.

GSUB type 1 Single: fmt1 = `format(u16) coverageOff(u16) deltaGlyphID(i16)`; fmt2 = `format coverageOff glyphCount substitutes[]`. GSUB type 4 Ligature: `format(u16) coverageOff(u16) ligSetCount(u16) ligSetOffsets[]`; each LigatureSet = `count ligatureOffsets[]`; each Ligature = `ligGlyph(u16) compCount(u16) componentGids[compCount-1]` (first component is the coverage glyph, implicit).

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
import { applyGsub } from '../src/otlayout.js'; // top-level: apply all resolved GSUB lookups

// Build a GSUB with: lookup0 = Single subst gid1->gid7; lookup1 = Ligature (2,3)->9.
// (Uses the real build-sfnt GSUB emitter from Task 11; until then, inline builders.)
```

Drive with the real emitter added in Task 11 — but since Task 11 comes last, add a **focused inline builder** here that emits exactly these two lookups, then assert via the top-level `applyGsub`:

```ts
function buf(gids: number[]): { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number }[] {
  return gids.map((g, i) => ({ gid: g, cluster: i, xAdvance: 0, xOffset: 0, yOffset: 0 }));
}

describe('GSUB type 1 Single', () => {
  it('substitutes a covered gid by delta (format 1)', () => {
    const t = parseOtTable(gsubSingleDelta(/*cover*/[1], /*delta*/6))!; // gid1 -> gid7
    const b = buf([1, 2]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);            // feature tag chosen by builder
    expect(b.map((x) => x.gid)).toEqual([7, 2]);
  });
});

describe('GSUB type 4 Ligature', () => {
  it('replaces a component sequence with the ligature glyph and merges clusters', () => {
    const t = parseOtTable(gsubLiga(/*first*/2, /*rest*/[3], /*lig*/9))!;  // (2,3) -> 9
    const b = buf([2, 3, 4]);
    applyGsub(t, b, undefined, 'latn', undefined, ['liga']);
    expect(b.map((x) => x.gid)).toEqual([9, 4]);
    expect(b[0].cluster).toBe(0); // min(0,1)
    expect(b[1].cluster).toBe(2);
  });
});
```

Provide `gsubSingleDelta`, `gsubLiga` as small inline emitters in the test file (they wrap the header layout from Task 2's `miniGsub`, swapping the lookup body + feature tag). Fold them into the shared `build-sfnt` emitters in Task 11 and delete the inline copies then.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `applyGsub` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)

/** Index of the next non-ignored glyph at or after `from`, or buf.length. */
function nextInput(buf: ShapedGlyph[], from: number, filter: GlyphFilter): number {
  let i = from;
  while (i < buf.length && filter.skip(buf[i].gid)) i++;
  return i;
}

/** Apply one GSUB lookup across the buffer (left→right; type 8 handled reversed in Task 6). */
export function applyGsubLookup(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  if (lk.type === 8) { applyReverseChain(lk, buf, gdef); return; }         // Task 6
  let i = 0;
  while (i < buf.length) {
    if (filter.skip(buf[i].gid)) { i++; continue; }
    const consumed = applyGsubAt(lk, buf, i, filter, gdef, layout);
    i += consumed > 0 ? consumed : 1;
  }
}

/** Try each subtable at position `i`. Returns glyphs consumed (>=1) or 0 if no match. */
function applyGsubAt(lk: Lookup, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  for (const sub of lk.subtables) {
    const n = gsubSubtable(lk.type, sub, buf, i, filter, gdef, layout);
    if (n > 0) return n;
  }
  return 0;
}

function gsubSubtable(type: number, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  const r = new OtReader(sub);
  switch (type) {
    case 1: return gsubSingle(r, sub, buf, i);
    case 4: return gsubLigature(r, sub, buf, i, filter);
    // 2,3 -> Task 5; 5,6,7 -> Task 6
    default: return 0;
  }
}

function gsubSingle(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  if (format === 1) buf[i].gid = (buf[i].gid + r.i16(4)) & 0xffff;
  else if (format === 2) buf[i].gid = r.u16(6 + ci * 2);
  else return 0;
  return 1;
}

function gsubLigature(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const setCount = r.u16(4);
  if (ci >= setCount) return 0;
  const setOff = r.u16(6 + ci * 2);
  const ligCount = r.u16(setOff);
  for (let l = 0; l < ligCount; l++) {
    const ligOff = setOff + r.u16(setOff + 2 + l * 2);
    const ligGlyph = r.u16(ligOff);
    const compCount = r.u16(ligOff + 2);              // includes the first (coverage) component
    // Match components 2..compCount against following non-ignored glyphs.
    const matched: number[] = [i];
    let p = i;
    let ok = true;
    for (let c = 1; c < compCount; c++) {
      p = nextInput(buf, p + 1, filter);
      if (p >= buf.length || buf[p].gid !== r.u16(ligOff + 4 + (c - 1) * 2)) { ok = false; break; }
      matched.push(p);
    }
    if (!ok) continue;
    // Replace: first matched slot becomes the ligature; remove the rest (in reverse).
    const minCluster = Math.min(...matched.map((m) => buf[m].cluster));
    buf[i].gid = ligGlyph;
    buf[i].cluster = minCluster;
    for (let k = matched.length - 1; k >= 1; k--) buf.splice(matched[k], 1);
    return 1; // reprocess from the ligature slot; outer loop advances
  }
  return 0;
}

/** Top-level: run every GSUB lookup enabled for (script, lang, features). */
export function applyGsub(t: OtTable, buf: ShapedGlyph[], gdef: Gdef | undefined, script: string | undefined, lang: string | undefined, features: string[]): void {
  for (const li of resolveLookups(t, script, lang, features)) {
    const lk = t.lookups[li];
    if (lk) applyGsubLookup(lk, buf, gdef, t);
  }
}
```

Add a temporary stub so the file compiles until Task 6:

```ts
function applyReverseChain(_lk: Lookup, _buf: ShapedGlyph[], _gdef: Gdef | undefined): void { /* filled in Task 6 */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS (Single + Ligature; cluster merge correct). `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GSUB apply loop + Single (type 1) and Ligature (type 4)"
```

---

## Task 5: GSUB type 2 (Multiple) & type 3 (Alternate)

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: the `gsubSubtable` switch, `nextInput`, cluster rule.
- Produces: `gsubMultiple`/`gsubAlternate` cases. Multiple (1→N, e.g. `ccmp` decomposition) copies the source cluster to every output glyph and returns the count so the loop skips past them. Alternate (1→1) picks the **first** alternate (design decision: no alternate selection UI).

Type 2 Multiple: `format(u16) coverageOff(u16) seqCount(u16) sequenceOffsets[]`; each Sequence = `glyphCount(u16) substituteGids[]`. Type 3 Alternate: `format coverageOff altSetCount altSetOffsets[]`; each AlternateSet = `glyphCount altGids[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
describe('GSUB type 2 Multiple', () => {
  it('decomposes one gid into a sequence, copying the cluster', () => {
    const t = parseOtTable(gsubMultiple(/*cover*/5, /*seq*/[6, 7]))!; // 5 -> 6,7
    const b = buf([5, 8]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);
    expect(b.map((x) => x.gid)).toEqual([6, 7, 8]);
    expect(b.map((x) => x.cluster)).toEqual([0, 0, 1]);
  });
});
describe('GSUB type 3 Alternate', () => {
  it('replaces with the first alternate', () => {
    const t = parseOtTable(gsubAlternate(/*cover*/5, /*alts*/[11, 12]))!;
    const b = buf([5]);
    applyGsub(t, b, undefined, 'latn', undefined, ['aalt']);
    expect(b[0].gid).toBe(11);
  });
});
```

Add `gsubMultiple`, `gsubAlternate` inline emitters (fold into build-sfnt in Task 11).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — Multiple/Alternate return 0 (default case), gids unchanged.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts — extend the gsubSubtable switch:
//   case 2: return gsubMultiple(r, sub, buf, i);
//   case 3: return gsubAlternate(r, sub, buf, i);

function gsubMultiple(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const seqCount = r.u16(4);
  if (ci >= seqCount) return 0;
  const seqOff = r.u16(6 + ci * 2);
  const glyphCount = r.u16(seqOff);
  const cluster = buf[i].cluster;
  const outs: ShapedGlyph[] = [];
  for (let g = 0; g < glyphCount; g++) outs.push({ gid: r.u16(seqOff + 2 + g * 2), cluster, xAdvance: 0, xOffset: 0, yOffset: 0 });
  buf.splice(i, 1, ...outs);
  return Math.max(1, glyphCount); // advance past the inserted glyphs
}

function gsubAlternate(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): number {
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return 0;
  const setCount = r.u16(4);
  if (ci >= setCount) return 0;
  const setOff = r.u16(6 + ci * 2);
  if (r.u16(setOff) < 1) return 0;                    // glyphCount
  buf[i].gid = r.u16(setOff + 2);                     // first alternate
  return 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GSUB Multiple (type 2) and Alternate (type 3)"
```

---

## Task 6: GSUB type 5/6 (Contextual/Chaining), 7 (Extension), 8 (Reverse chaining)

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `gsubSubtable`, `applyGsubLookup`, `resolveLookups`, `nextInput`, `parseClassDef`.
- Produces: a shared `matchSequence`/`matchContext` engine used by both GSUB chaining and GPOS chaining (Task 9); `gsubContext` (type 5, fmt 1/2/3), `gsubChain` (type 6, fmt 1/2/3), Extension unwrap (type 7), and `applyReverseChain` (type 8). Context lookups apply **nested lookups** (by index into the current table's LookupList) at matched positions.

Extension (GSUB type 7 / GPOS type 9): `format(u16=1) extensionLookupType(u16) extensionOffset(u32)` → treat as a subtable of `extensionLookupType` at `sub + extensionOffset`. Resolve it **before** the type switch so `lk.type` reflects the real type. Chaining fmt 3 (the common one): `format(u16=3) backtrackCount backtrackCoverage[] inputCount inputCoverage[] lookaheadCount lookaheadCoverage[] substCount (SequenceLookupRecord: seqIdx(u16) lookupIdx(u16))[]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
describe('GSUB type 6 Chaining (format 3) + nested lookup', () => {
  it('applies a nested single-subst only in context [10] _ [12]', () => {
    // lookup0 = Single 11->99 (nested). lookup1 = Chain fmt3: backtrack[cov{10}] input[cov{11}] lookahead[cov{12}] -> seqLookup(0, 0).
    const t = parseOtTable(gsubChainNested())!;
    const inCtx = buf([10, 11, 12]);
    applyGsub(t, inCtx, undefined, 'latn', undefined, ['calt']);
    expect(inCtx.map((x) => x.gid)).toEqual([10, 99, 12]);
    const noCtx = buf([11, 12]);           // no backtrack 10
    applyGsub(t, noCtx, undefined, 'latn', undefined, ['calt']);
    expect(noCtx.map((x) => x.gid)).toEqual([11, 12]);
  });
});
describe('GSUB type 7 Extension', () => {
  it('unwraps an extension to a Single subst', () => {
    const t = parseOtTable(gsubExtSingle(/*cover*/1, /*delta*/6))!;
    const b = buf([1]);
    applyGsub(t, b, undefined, 'latn', undefined, ['ccmp']);
    expect(b[0].gid).toBe(7);
  });
});
```

Add `gsubChainNested`, `gsubExtSingle` inline emitters (fold into build-sfnt Task 11).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — chaining/extension return 0; gids unchanged.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)

// Resolve Extension (GSUB 7 / GPOS 9) subtable to {type, bytes}.
function resolveExtension(type: number, sub: Uint8Array): { type: number; sub: Uint8Array } {
  if (type !== 7 && type !== 9) return { type, sub };
  const r = new OtReader(sub);
  if (r.u16(0) !== 1) return { type, sub };
  const extType = r.u16(2);
  const extOff = r.u32(4);
  return { type: extType, sub: sub.subarray(extOff) };
}

// A SequenceLookupRecord list: apply nested lookups at (matched positions).
interface SeqLookup { seqIndex: number; lookupIndex: number; }

/** Match backtrack/input/lookahead by predicate; return matched input positions or null. */
function matchChain(
  buf: ShapedGlyph[], i: number, filter: GlyphFilter,
  back: ((g: number) => boolean)[], input: ((g: number) => boolean)[], ahead: ((g: number) => boolean)[],
): number[] | null {
  // input[0] is buf[i] itself.
  const inputPos: number[] = [i];
  if (!input[0](buf[i].gid)) return null;
  let p = i;
  for (let k = 1; k < input.length; k++) {
    p = nextInput(buf, p + 1, filter);
    if (p >= buf.length || !input[k](buf[p].gid)) return null;
    inputPos.push(p);
  }
  // lookahead after last input pos.
  let a = inputPos[inputPos.length - 1];
  for (let k = 0; k < ahead.length; k++) {
    a = nextInput(buf, a + 1, filter);
    if (a >= buf.length || !ahead[k](buf[a].gid)) return null;
  }
  // backtrack before i (reverse order).
  let btk = i;
  for (let k = 0; k < back.length; k++) {
    btk--;
    while (btk >= 0 && filter.skip(buf[btk].gid)) btk--;
    if (btk < 0 || !back[k](buf[btk].gid)) return null;
  }
  return inputPos;
}

function applySeqLookups(recs: SeqLookup[], inputPos: number[], buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable): void {
  for (const rec of recs) {
    const pos = inputPos[rec.seqIndex];
    const lk = layout.lookups[rec.lookupIndex];
    if (pos === undefined || !lk) continue;
    const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
    applyGsubAt(lk, buf, pos, filter, gdef, layout); // nested: apply at that single position
  }
}

function readSeqLookups(r: OtReader, off: number, count: number): SeqLookup[] {
  const out: SeqLookup[] = [];
  for (let k = 0; k < count; k++) out.push({ seqIndex: r.u16(off + k * 4), lookupIndex: r.u16(off + 2 + k * 4) });
  return out;
}

// GSUB chaining, format 3 (coverage-based; the case real fonts emit).
function gsubChain3(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  let p = 2;
  const backCount = r.u16(p); p += 2;
  const back = readCovPreds(r, sub, p, backCount); p += backCount * 2;
  const inCount = r.u16(p); p += 2;
  const input = readCovPreds(r, sub, p, inCount); p += inCount * 2;
  const aheadCount = r.u16(p); p += 2;
  const ahead = readCovPreds(r, sub, p, aheadCount); p += aheadCount * 2;
  const substCount = r.u16(p); p += 2;
  const recs = readSeqLookups(r, p, substCount);
  const matched = matchChain(buf, i, filter, back, input, ahead);
  if (!matched) return 0;
  applySeqLookups(recs, matched, buf, gdef, layout);
  return Math.max(1, matched.length);
}

function readCovPreds(r: OtReader, sub: Uint8Array, off: number, count: number): ((g: number) => boolean)[] {
  const preds: ((g: number) => boolean)[] = [];
  for (let k = 0; k < count; k++) { const cov = parseCoverage(sub, r.u16(off + k * 2)); preds.push((g) => cov.index(g) >= 0); }
  return preds;
}

// Reverse chaining single (type 8): fmt1 only. Applied right→left; single subst per match.
function applyReverseChainImpl(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  for (const sub of lk.subtables) {
    const { sub: s } = resolveExtension(lk.type, sub);
    const r = new OtReader(s);
    if (r.u16(0) !== 1) continue;
    let p = 2;
    const cov = parseCoverage(s, r.u16(p)); p += 2;
    const backCount = r.u16(p); p += 2;
    const back = readCovPreds(r, s, p, backCount); p += backCount * 2;
    const aheadCount = r.u16(p); p += 2;
    const ahead = readCovPreds(r, s, p, aheadCount); p += aheadCount * 2;
    const glyphCount = r.u16(p); p += 2;
    const subGids: number[] = [];
    for (let k = 0; k < glyphCount; k++) subGids.push(r.u16(p + k * 2));
    for (let i = buf.length - 1; i >= 0; i--) {
      if (filter.skip(buf[i].gid)) continue;
      const ci = cov.index(buf[i].gid);
      if (ci < 0) continue;
      if (matchChain(buf, i, filter, back, [() => true], ahead)) buf[i].gid = subGids[ci];
    }
  }
}
```

Wire the switch and stub:

```ts
// gsubSubtable: add before default:
//   case 5: return gsubContext(r, sub, buf, i, filter, gdef, layout);
//   case 6: { const rr = new OtReader(sub); if (rr.u16(0) === 3) return gsubChain3(rr, sub, buf, i, filter, gdef, layout); return gsubContextClassOrSimple(...); }
// Replace the Task 4 stub:
function applyReverseChain(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined): void { applyReverseChainImpl(lk, buf, gdef); }
```

Also resolve Extension at the top of `applyGsubAt` so type 7 works:

```ts
function applyGsubAt(lk: Lookup, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): number {
  for (const raw of lk.subtables) {
    const { type, sub } = resolveExtension(lk.type, raw);
    const n = gsubSubtable(type, sub, buf, i, filter, gdef, layout);
    if (n > 0) return n;
  }
  return 0;
}
```

Implement `gsubContext` (type 5) fmt 3 with the same `matchChain` (no backtrack/lookahead — input + seqLookups only), and provide fmt 1/2 (glyph/class sequence) as a straightforward `matchSequence` over `SequenceRuleSet`s; if a format is unrecognized return 0 (degrade). Keep them small and mirror `gsubChain3`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS (chaining applies nested subst only in context; extension unwraps). `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GSUB contextual/chaining (5/6), extension (7), reverse chain (8)"
```

---

## Task 7: GPOS type 1 (Single) & type 2 (Pair/kerning)

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `ShapedGlyph`, `GlyphFilter`, `parseCoverage`, `parseClassDef`.
- Produces: `applyGpos(t, buf, gdef, script, lang, features): void` (mutates advances/offsets), `applyGposLookup`, `gposSingle`, `gposPair`, and a shared `readValueRecord(r, base, format)` (ValueRecord decoder). Advances must be **seeded before GPOS** (by `applyFeatures` in Task 10 via `sfnt.advanceWidth`); GPOS *adds* deltas.

ValueRecord: a bitmask `valueFormat` selects which of `xPlacement,yPlacement,xAdvance,yAdvance,...` (i16 each, in that order) are present. Bits: `0x0001 xPlacement, 0x0002 yPlacement, 0x0004 xAdvance, 0x0008 yAdvance` (device tables 0x10..0x80 ignored — skip their 2 bytes each). Type 1 Single: fmt1 = `format coverageOff valueFormat valueRecord`; fmt2 = `format coverageOff valueFormat valueCount valueRecords[]`. Type 2 Pair: fmt1 = `format coverageOff valueFormat1 valueFormat2 pairSetCount pairSetOffsets[]`; PairSet = `pairValueCount (secondGlyph value1 value2)[]`; fmt2 = class-based.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
import { applyGpos } from '../src/otlayout.js';

function pbuf(pairs: [number, number][]): { gid: number; cluster: number; xAdvance: number; xOffset: number; yOffset: number }[] {
  return pairs.map(([g, adv], i) => ({ gid: g, cluster: i, xAdvance: adv, xOffset: 0, yOffset: 0 }));
}

describe('GPOS type 2 Pair (format 1)', () => {
  it('adds an xAdvance kern delta to the first glyph of a matching pair', () => {
    const t = parseOtTable(gposPairKern(/*first*/1, /*second*/2, /*kern*/-40))!;
    const b = pbuf([[1, 500], [2, 500]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xAdvance).toBe(460); // 500 + (-40)
    expect(b[1].xAdvance).toBe(500);
  });
});
describe('GPOS type 1 Single', () => {
  it('adds an xPlacement/xAdvance to a covered glyph', () => {
    const t = parseOtTable(gposSingleAdj(/*cover*/3, /*dx*/5, /*dAdv*/10))!;
    const b = pbuf([[3, 700]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xOffset).toBe(5);
    expect(b[0].xAdvance).toBe(710);
  });
});
```

Add `gposPairKern`, `gposSingleAdj` inline emitters (fold into build-sfnt Task 11).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `applyGpos` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)

interface Value { xPlacement: number; yPlacement: number; xAdvance: number; yAdvance: number; size: number; }

/** Decode a ValueRecord at `off`; `size` is its byte length (for stepping arrays). */
function readValue(r: OtReader, off: number, format: number): Value {
  let p = off;
  const take = (bit: number) => { if (format & bit) { const v = r.i16(p); p += 2; return v; } return 0; };
  const xPlacement = take(0x0001), yPlacement = take(0x0002), xAdvance = take(0x0004), yAdvance = take(0x0008);
  for (const bit of [0x0010, 0x0020, 0x0040, 0x0080]) if (format & bit) p += 2; // device offsets: skip
  return { xPlacement, yPlacement, xAdvance, yAdvance, size: p - off };
}
function valueSize(format: number): number { let n = 0; for (let b = 1; b <= 0x80; b <<= 1) if (format & b) n += 2; return n; }
function applyValue(g: ShapedGlyph, v: Value): void { g.xOffset += v.xPlacement; g.yOffset += v.yPlacement; g.xAdvance += v.xAdvance; }

export function applyGposLookup(lk: Lookup, buf: ShapedGlyph[], gdef: Gdef | undefined, layout: OtTable): void {
  const filter = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
  let i = 0;
  while (i < buf.length) {
    if (filter.skip(buf[i].gid)) { i++; continue; }
    applyGposAt(lk, buf, i, filter, gdef, layout);
    i++;
  }
}

function applyGposAt(lk: Lookup, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): void {
  for (const raw of lk.subtables) {
    const { type, sub } = resolveExtension(lk.type, raw);
    if (gposSubtable(type, sub, buf, i, filter, gdef, layout)) return;
  }
}

function gposSubtable(type: number, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): boolean {
  const r = new OtReader(sub);
  switch (type) {
    case 1: return gposSingle(r, sub, buf, i);
    case 2: return gposPair(r, sub, buf, i, filter);
    // 4,6,3,5 -> Task 8; 7,8 -> Task 9
    default: return false;
  }
}

function gposSingle(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number): boolean {
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return false;
  const vf = r.u16(4);
  if (format === 1) { applyValue(buf[i], readValue(r, 6, vf)); return true; }
  if (format === 2) { const sz = valueSize(vf); applyValue(buf[i], readValue(r, 8 + ci * sz, vf)); return true; }
  return false;
}

function gposPair(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter): boolean {
  const j = nextInput(buf, i + 1, filter);
  if (j >= buf.length) return false;
  const format = r.u16(0);
  const cov = parseCoverage(sub, r.u16(2));
  const ci = cov.index(buf[i].gid);
  if (ci < 0) return false;
  const vf1 = r.u16(4), vf2 = r.u16(6);
  if (format === 1) {
    const setOff = r.u16(10 + ci * 2);
    const count = r.u16(setOff);
    const sz1 = valueSize(vf1), sz2 = valueSize(vf2);
    const stride = 2 + sz1 + sz2;
    for (let k = 0; k < count; k++) {
      const rec = setOff + 2 + k * stride;
      if (r.u16(rec) !== buf[j].gid) continue;
      if (vf1) applyValue(buf[i], readValue(r, rec + 2, vf1));
      if (vf2) applyValue(buf[j], readValue(r, rec + 2 + sz1, vf2));
      return true;
    }
    return false;
  }
  if (format === 2) {
    const cd1 = parseClassDef(sub, r.u16(8));
    const cd2 = parseClassDef(sub, r.u16(10));
    const c1Count = r.u16(12), c2Count = r.u16(14);
    const c1 = cd1.classOf(buf[i].gid), c2 = cd2.classOf(buf[j].gid);
    if (c1 >= c1Count || c2 >= c2Count) return false;
    const sz1 = valueSize(vf1), sz2 = valueSize(vf2);
    const stride = sz1 + sz2;
    const rec = 16 + (c1 * c2Count + c2) * stride;
    if (vf1) applyValue(buf[i], readValue(r, rec, vf1));
    if (vf2) applyValue(buf[j], readValue(r, rec + sz1, vf2));
    return true;
  }
  return false;
}

export function applyGpos(t: OtTable, buf: ShapedGlyph[], gdef: Gdef | undefined, script: string | undefined, lang: string | undefined, features: string[]): void {
  for (const li of resolveLookups(t, script, lang, features)) {
    const lk = t.lookups[li];
    if (lk) applyGposLookup(lk, buf, gdef, t);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS (kern delta + single adjustment). `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GPOS Single (type 1) and Pair/kern (type 2)"
```

---

## Task 8: GPOS type 4/6 (Mark-to-base / mark-to-mark) + 3/5 (cursive / mark-to-ligature, best-effort)

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: GPOS apply loop, `parseCoverage`, GDEF glyph classes.
- Produces: `gposMarkToBase` (type 4), `gposMarkToMark` (type 6), `gposCursive` (type 3, best-effort), `gposMarkToLig` (type 5, best-effort); a shared `readAnchor(r, off)` and `readMarkArray`. A mark's placement is computed so its mark-anchor coincides with the base's base-anchor; the mark receives `xOffset`/`yOffset` relative to the base **and** its own advance is typically 0 (marks are zero-width). Because PDF emission (Phase 3) places marks by explicit offset, here we set `xOffset`/`yOffset` on the mark to `baseAnchor - markAnchor` accumulated from the base's pen position.

Type 4 Mark-to-base: `format(=1) markCoverageOff baseCoverageOff markClassCount markArrayOff baseArrayOff`. MarkArray = `count (markClass(u16) markAnchorOff(u16))[]`. BaseArray = `count (baseAnchorOff[markClassCount])[]`. Anchor fmt1 = `format(=1) xCoord(i16) yCoord(i16)`. The base is the **preceding non-mark** glyph; the mark's offset = `(baseAnchor.x − markAnchor.x)` minus the advance width already accumulated between base and mark, and `(baseAnchor.y − markAnchor.y)` for y.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
describe('GPOS type 4 Mark-to-base', () => {
  it('positions a mark relative to the preceding base anchor', () => {
    // base gid 4 baseAnchor (300,0); mark gid 3 (class 0) markAnchor (10,-50).
    // GDEF marks gid3 as class 3 so the base scan skips it.
    const t = parseOtTable(gposMarkBase())!;
    const gdef = parseGdef(miniGdef()); // gid3->mark, gid4->base
    const b = pbuf([[4, 600], [3, 0]]);
    applyGpos(t, b, gdef, 'latn', undefined, ['mark']);
    // mark placed so markAnchor lands on baseAnchor, accounting for base advance already passed:
    // xOffset = (baseAnchor.x - markAnchor.x) - baseAdvance = (300 - 10) - 600 = -310
    expect(b[1].xOffset).toBe(-310);
    expect(b[1].yOffset).toBe(50);  // (baseAnchor.y - markAnchor.y) = 0 - (-50)
  });
});
```

Add `gposMarkBase` inline emitter (fold into build-sfnt Task 11).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — mark offsets stay 0 (type 4 unhandled).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)

interface Anchor { x: number; y: number; }
function readAnchor(r: OtReader, off: number): Anchor { return { x: r.i16(off + 2), y: r.i16(off + 4) }; } // fmt1/2/3: x,y at +2,+4

interface MarkRecord { cls: number; anchor: Anchor | null; }
function readMarkArray(r: OtReader, base: Uint8Array, off: number): MarkRecord[] {
  const count = new OtReader(base).u16(off);
  const out: MarkRecord[] = [];
  for (let i = 0; i < count; i++) {
    const rec = off + 2 + i * 4;
    const anchorOff = r.u16(rec + 2);
    out.push({ cls: r.u16(rec), anchor: anchorOff ? readAnchor(r, off + anchorOff) : null });
  }
  return out;
}

// Extend gposSubtable switch: case 4 -> gposMarkToBase; case 6 -> gposMarkToMark;
//                             case 3 -> gposCursive; case 5 -> gposMarkToLig.

function gposMarkToBase(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined): boolean {
  const markCov = parseCoverage(sub, r.u16(2));
  const mi = markCov.index(buf[i].gid);
  if (mi < 0) return false;
  const baseCov = parseCoverage(sub, r.u16(4));
  const markClassCount = r.u16(6);
  const marks = readMarkArray(r, sub, r.u16(8));
  const baseArrayOff = r.u16(10);
  const mark = marks[mi];
  if (!mark || !mark.anchor) return false;
  // Find the preceding base glyph (skip marks; use GDEF class to identify).
  let b = i - 1;
  while (b >= 0 && (gdef?.glyphClass?.classOf(buf[b].gid) === 3)) b--;
  if (b < 0) return false;
  const bi = baseCov.index(buf[b].gid);
  if (bi < 0) return false;
  const baseCount = r.u16(baseArrayOff);
  if (bi >= baseCount) return false;
  const anchorOff = r.u16(baseArrayOff + 2 + (bi * markClassCount + mark.cls) * 2);
  if (!anchorOff) return false;
  const baseAnchor = readAnchor(r, baseArrayOff + anchorOff);
  // Advance accumulated between the base and this mark (base advance + any glyphs between).
  let between = 0;
  for (let k = b; k < i; k++) between += buf[k].xAdvance;
  buf[i].xOffset = (baseAnchor.x - mark.anchor.x) - between;
  buf[i].yOffset = baseAnchor.y - mark.anchor.y;
  buf[i].xAdvance = 0; // marks are zero-advance
  return true;
}
```

Implement `gposMarkToMark` (type 6) identically but the attachment glyph is the **preceding mark** (walk back to the nearest mark instead of base; use its recorded offset). Implement `gposCursive` (type 3) and `gposMarkToLig` (type 5) best-effort: parse their coverage/anchor arrays and set offsets analogously; if any structure is absent, return false (degrade). Keep each small; they reuse `readAnchor`/`readMarkArray`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS (mark placed at computed offsets). `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GPOS mark-to-base/mark (4/6) + cursive/mark-to-lig (3/5)"
```

---

## Task 9: GPOS type 7/8 (Contextual/Chaining) + Extension wiring

**Files:**
- Modify: `src/otlayout.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `matchChain`, `readCovPreds`, `readSeqLookups`, the GPOS apply loop, `resolveExtension` (type 9 already handled by `applyGposAt`).
- Produces: `gposContext` (type 7) and `gposChain` (type 8) — same chaining engine as GSUB, but nested `SequenceLookupRecord`s invoke **GPOS** lookups (`applyGposAt`). Type 9 Extension already unwraps via `applyGposAt` (added in Task 7); add a test asserting an extension-wrapped Pair applies.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
describe('GPOS type 8 Chaining + nested', () => {
  it('applies a nested single-adjust only in context', () => {
    // lookup0 = Single adjust gid 5: xAdvance +20. lookup1 = Chain fmt3 back[cov{4}] input[cov{5}] -> seq(0,0).
    const t = parseOtTable(gposChainNested())!;
    const inCtx = pbuf([[4, 100], [5, 200]]);
    applyGpos(t, inCtx, undefined, 'latn', undefined, ['kern']);
    expect(inCtx[1].xAdvance).toBe(220);
    const noCtx = pbuf([[5, 200]]);
    applyGpos(t, noCtx, undefined, 'latn', undefined, ['kern']);
    expect(noCtx[0].xAdvance).toBe(200);
  });
});
describe('GPOS type 9 Extension', () => {
  it('unwraps an extension to a Pair kern', () => {
    const t = parseOtTable(gposExtPair(1, 2, -40))!;
    const b = pbuf([[1, 500], [2, 500]]);
    applyGpos(t, b, undefined, 'latn', undefined, ['kern']);
    expect(b[0].xAdvance).toBe(460);
  });
});
```

Add `gposChainNested`, `gposExtPair` inline emitters (fold into build-sfnt Task 11).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — chaining returns false; extension pair not applied (case 7/8 unhandled).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts — extend gposSubtable switch:
//   case 7: return gposContext(r, sub, buf, i, filter, gdef, layout);
//   case 8: { if (r.u16(0) === 3) return gposChain3(r, sub, buf, i, filter, gdef, layout); return gposContextOther(...); }

function gposChain3(r: OtReader, sub: Uint8Array, buf: ShapedGlyph[], i: number, filter: GlyphFilter, gdef: Gdef | undefined, layout: OtTable): boolean {
  let p = 2;
  const backCount = r.u16(p); p += 2;
  const back = readCovPreds(r, sub, p, backCount); p += backCount * 2;
  const inCount = r.u16(p); p += 2;
  const input = readCovPreds(r, sub, p, inCount); p += inCount * 2;
  const aheadCount = r.u16(p); p += 2;
  const ahead = readCovPreds(r, sub, p, aheadCount); p += aheadCount * 2;
  const recCount = r.u16(p); p += 2;
  const recs = readSeqLookups(r, p, recCount);
  const matched = matchChain(buf, i, filter, back, input, ahead);
  if (!matched) return false;
  for (const rec of recs) {
    const pos = matched[rec.seqIndex];
    const lk = layout.lookups[rec.lookupIndex];
    if (pos === undefined || !lk) continue;
    const f = new GlyphFilter(gdef, lk.flag, lk.markFilteringSet);
    applyGposAt(lk, buf, pos, f, gdef, layout);
  }
  return true;
}
```

Implement `gposContext` (type 7, fmt 3) like `gposChain3` without backtrack/lookahead. Provide fmt 1/2 for both as small `matchSequence`-based variants (glyph/class); unrecognized formats return false (degrade).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS. `npm run typecheck` green.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): GPOS contextual/chaining (7/8) + extension (9) wiring"
```

---

## Task 10: Top-level `parseOtLayout` + `applyFeatures` + sfnt exposure + degradation

**Files:**
- Modify: `src/otlayout.ts`, `src/sfnt.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Consumes: `parseOtTable`, `parseGdef`, `applyGsub`, `applyGpos`, `SfntFont`.
- Produces:
  - `parseOtLayout(sfnt: SfntFont): OtLayout | undefined` — reads `GSUB`/`GPOS`/`GDEF` raw bytes via `sfnt.table(tag, false)`, parses each (each independently degradable), returns `undefined` only when **all three** are absent.
  - `applyFeatures(sfnt, gids, opts): ShapedGlyph[]` — the phase's headline entry: seed advances from `sfnt.advanceWidth`, run GSUB then GPOS for the enabled feature set; when `sfnt.otLayout()` is `undefined`, return nominal glyphs (advances from hmtx, zero offsets) — the "no shaping tables → pass-through" guarantee.
  - `SfntFont.otLayout(): OtLayout | undefined` — lazily parses once and caches (`sfnt.ts`).

`opts`: `{ script?: string; lang?: string; features?: string[]; rtl?: boolean }`. Default feature set: `['ccmp','liga','rlig','calt','kern','mark','mkmk']` plus any Arabic joining features the caller pre-selects (Phase 3 supplies `init/medi/fina/isol`; Phase 1 accepts them verbatim in `features`).

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts (append)
import { parseSfnt } from '../src/sfnt.js';
import { applyFeatures } from '../src/otlayout.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';

describe('applyFeatures degradation', () => {
  it('a font with no GSUB/GPOS/GDEF passes glyphs through with hmtx advances', () => {
    const f = parseSfnt(buildMinimalTtf()); // no OT layout tables
    expect(f.otLayout()).toBeUndefined();
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], {});
    expect(out.map((g) => g.gid)).toEqual([1, 2]);
    expect(out.map((g) => g.xAdvance)).toEqual([f.advanceWidth(1), f.advanceWidth(2)]);
    expect(out.every((g) => g.xOffset === 0 && g.yOffset === 0)).toBe(true);
  });
  it('malformed GSUB bytes degrade to pass-through (never throw)', () => {
    // buildOtFont with a deliberately truncated GSUB (see build-sfnt Task 11).
    const f = parseSfnt(buildOtFont({ gsub: new Uint8Array([0, 1, 0, 0, 0, 99]) }));
    expect(() => applyFeatures(f, [{ gid: 1, cluster: 0 }], { features: ['liga'] })).not.toThrow();
  });
});

describe('applyFeatures end-to-end (liga)', () => {
  it('shapes f+i -> fi using a synthetic GSUB Ligature font', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([ligatureLookup('liga', 1, [2], 9)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['liga'] });
    expect(out.map((g) => g.gid)).toEqual([9]);
    expect(out[0].cluster).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `applyFeatures`/`sfnt.otLayout` not defined (and `buildOtFont`/`buildGsub`/`ligatureLookup` land in Task 11; if running Task 10 before 11, these two end-to-end cases fail to import — that's expected; the degradation case using `buildMinimalTtf` must at least reach `otLayout()`).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/otlayout.ts (append)
import type { SfntFont } from './sfnt.js';

export interface OtLayout { gsub?: OtTable; gpos?: OtTable; gdef?: Gdef; }

/** Parse GSUB/GPOS/GDEF from a font. `undefined` when none present. Each table degrades independently. */
export function parseOtLayout(sfnt: SfntFont): OtLayout | undefined {
  const gsubBytes = sfnt.table('GSUB', false);
  const gposBytes = sfnt.table('GPOS', false);
  const gdefBytes = sfnt.table('GDEF', false);
  if (!gsubBytes && !gposBytes && !gdefBytes) return undefined;
  const layout: OtLayout = {};
  if (gsubBytes) layout.gsub = parseOtTable(gsubBytes);
  if (gposBytes) layout.gpos = parseOtTable(gposBytes);
  if (gdefBytes) layout.gdef = parseGdef(gdefBytes);
  return layout;
}

export interface ShapeOptions { script?: string; lang?: string; features?: string[]; rtl?: boolean; }
const DEFAULT_FEATURES = ['ccmp', 'liga', 'rlig', 'calt', 'kern', 'mark', 'mkmk'];

/** Shape a gid run: GSUB then GPOS, advances seeded from hmtx. Pure; returns a new buffer. */
export function applyFeatures(sfnt: SfntFont, gids: { gid: number; cluster: number }[], opts: ShapeOptions): ShapedGlyph[] {
  const buf: ShapedGlyph[] = gids.map((g) => ({ gid: g.gid, cluster: g.cluster, xAdvance: sfnt.advanceWidth(g.gid), xOffset: 0, yOffset: 0 }));
  const layout = sfnt.otLayout();
  if (!layout) return buf;
  const features = opts.features ?? DEFAULT_FEATURES;
  try {
    if (layout.gsub) applyGsub(layout.gsub, buf, layout.gdef, opts.script, opts.lang, features);
    // Re-seed advances for any glyphs GSUB introduced (splice inserts had xAdvance 0).
    for (const g of buf) if (g.xAdvance === 0 && g.xOffset === 0 && g.yOffset === 0) g.xAdvance = sfnt.advanceWidth(g.gid);
    if (layout.gpos) applyGpos(layout.gpos, buf, layout.gdef, opts.script, opts.lang, features);
  } catch { /* degrade: return whatever we have without throwing */ }
  return buf;
}
```

> **Note on advance re-seeding:** GSUB Single/Ligature edit gids in place (advance already seeded is now stale for Single). To be correct, re-seed **every** glyph's advance from its final gid right before GPOS instead of the heuristic above:
> ```ts
> if (layout.gpos) { for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid); applyGpos(...); }
> else { for (const g of buf) g.xAdvance = sfnt.advanceWidth(g.gid); }
> ```
> Use this simpler, always-correct re-seed (replace the heuristic line). GPOS then adds deltas on top.

```ts
// src/sfnt.ts — add near the other accessors on SfntFont, and the import at top.
// Top of file:
import { parseOtLayout, type OtLayout } from './otlayout.js';
// Inside class SfntFont:
  /** @internal Lazily-parsed & cached OpenType layout tables (GDEF/GSUB/GPOS). */
  private _otLayout?: OtLayout | null;
  otLayout(): OtLayout | undefined {
    if (this._otLayout === undefined) this._otLayout = parseOtLayout(this) ?? null;
    return this._otLayout ?? undefined;
  }
```

> The `sfnt.ts` ↔ `otlayout.ts` import is circular, but safe: `otlayout.ts` uses `SfntFont` only as a **type** (`import type`) and calls its methods at runtime; `sfnt.ts` calls `parseOtLayout` only inside `otLayout()` at runtime, never at module top-level. ESM tolerates this.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts` (degradation case). Full end-to-end cases pass after Task 11. `npm run typecheck` green; `npm test` — no regressions in `test/sfnt.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/otlayout.ts src/sfnt.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): applyFeatures driver + SfntFont.otLayout accessor + degradation"
```

---

## Task 11: `build-sfnt.ts` OT emitters + acceptance integration tests

**Files:**
- Modify: `test/helpers/build-sfnt.ts`
- Test: `test/otlayout.test.ts`

**Interfaces:**
- Produces (all exported from `build-sfnt.ts`):
  - Low-level lookup emitters returning **raw Lookup subtable bytes** paired with a feature tag:
    `singleSubstDelta(featureTag, coverGid, delta)`, `ligatureLookup(featureTag, first, rest, ligGid)`, `multipleLookup(featureTag, coverGid, seq)`, `alternateLookup(featureTag, coverGid, alts)`, `chainLookup(featureTag, back, input, ahead, seqLookups, nestedLookups)`, `extensionLookup(featureTag, innerType, innerSubtable)`, `pairKernLookup(featureTag, first, second, kern)`, `singleAdjustLookup(featureTag, coverGid, dx, dAdv)`, `markBaseLookup(featureTag, markGid, markAnchor, baseGid, baseAnchor)`.
  - `buildGsub(lookups)` / `buildGpos(lookups)` — assemble a full GSUB/GPOS table (ScriptList `latn`+`DFLT`, FeatureList from the lookups' tags, LookupList) from an array of `{ tag, type, flag, subtables }`.
  - `buildGdefClasses(classes: [gid, cls][])` — a GDEF with a glyph ClassDef.
  - `buildOtFont({ gsub?, gpos?, gdef? })` — a full glyf font (reuse `assembleGlyfFont`/existing helpers) with the given OT tables appended to the table directory.
- Consumes: existing `u16`/`i16`/`u32`/`concat`/`pad4` helpers and the font-assembly pattern already in `build-sfnt.ts`.

This task **replaces every inline builder** used in Tasks 2/4/5/6/7/8/9 with these shared emitters, then adds the acceptance integration tests from the spec's Testing section (Phase 1 bullets): `liga` (f+i→fi), a chaining `calt`, an Arabic `init/medi/fina` set (three Single substitutions gated by joining features), a `kern` pair, and a mark-to-base anchor — each asserted through `applyFeatures`.

- [ ] **Step 1: Write the failing test**

```ts
// test/otlayout.test.ts — the acceptance block (replaces inline-builder helpers).
import {
  buildOtFont, buildGsub, buildGpos, buildGdefClasses,
  ligatureLookup, chainLookup, singleSubstDelta, pairKernLookup, markBaseLookup,
} from './helpers/build-sfnt.js';

describe('otlayout acceptance (synthetic fonts)', () => {
  it('liga: f+i -> fi', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([ligatureLookup('liga', 1, [2], 9)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['liga'] });
    expect(out.map((g) => g.gid)).toEqual([9]);
  });

  it('calt: contextual single subst 5->99 only after 4', () => {
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([
      singleSubstDelta('__nested', 5, 94),                 // lookup 0: 5 -> 99
      chainLookup('calt', [[4]], [[5]], [], [{ seqIndex: 0, lookupIndex: 0 }]), // lookup 1
    ]) }));
    const yes = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 5, cluster: 1 }], { features: ['calt'] });
    expect(yes.map((g) => g.gid)).toEqual([4, 99]);
    const no = applyFeatures(f, [{ gid: 5, cluster: 0 }], { features: ['calt'] });
    expect(no.map((g) => g.gid)).toEqual([5]);
  });

  it('Arabic init/medi/fina select positional forms by feature', () => {
    // gid 20 has init->21, medi->22, fina->23 (three Single lookups on distinct features).
    const f = parseSfnt(buildOtFont({ gsub: buildGsub([
      singleSubstDelta('init', 20, 1),  // 20->21
      singleSubstDelta('medi', 20, 2),  // 20->22
      singleSubstDelta('fina', 20, 3),  // 20->23
    ]) }));
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['init'] })[0].gid).toBe(21);
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['medi'] })[0].gid).toBe(22);
    expect(applyFeatures(f, [{ gid: 20, cluster: 0 }], { features: ['fina'] })[0].gid).toBe(23);
  });

  it('kern: pair adds an advance delta', () => {
    const f = parseSfnt(buildOtFont({ gpos: buildGpos([pairKernLookup('kern', 1, 2, -40)]) }));
    const out = applyFeatures(f, [{ gid: 1, cluster: 0 }, { gid: 2, cluster: 1 }], { features: ['kern'] });
    expect(out[0].xAdvance).toBe(f.advanceWidth(1) - 40);
  });

  it('mark-to-base: mark placed on base anchor', () => {
    const f = parseSfnt(buildOtFont({
      gpos: buildGpos([markBaseLookup('mark', /*mark*/3, { x: 10, y: -50 }, /*base*/4, { x: 300, y: 0 })]),
      gdef: buildGdefClasses([[3, 3], [4, 1]]),
    }));
    const out = applyFeatures(f, [{ gid: 4, cluster: 0 }, { gid: 3, cluster: 1 }], { features: ['mark'] });
    expect(out[1].xOffset).toBe((300 - 10) - f.advanceWidth(4));
    expect(out[1].yOffset).toBe(50);
  });

  it('malformed GSUB degrades to pass-through', () => {
    const f = parseSfnt(buildOtFont({ gsub: new Uint8Array([0, 1, 0, 0, 0, 99]) }));
    expect(() => applyFeatures(f, [{ gid: 1, cluster: 0 }], { features: ['liga'] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/otlayout.test.ts`
Expected: FAIL — `buildOtFont`/`buildGsub`/`ligatureLookup`/etc. not exported from `build-sfnt.ts`.

- [ ] **Step 3: Write minimal implementation**

Add to `test/helpers/build-sfnt.ts` (reusing its `u16`/`i16`/`u32`/`concat`/`pad4`). Emit each subtable, wrap in the shared header assembler, and append OT tables to a glyf font. Representative core:

```ts
// test/helpers/build-sfnt.ts (append)
const tag4 = (s: string) => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);

export interface LookupDef { tag: string; type: number; flag: number; subtables: Uint8Array[]; }

/** Coverage format 1 over a sorted gid list. */
function coverage1(gids: number[]): Uint8Array {
  const s = [...gids].sort((a, b) => a - b);
  return concat([u16(1), u16(s.length), ...s.map(u16)]);
}

export function singleSubstDelta(tag: string, coverGid: number, delta: number): LookupDef {
  // Single fmt1: format, coverageOff(6), deltaGlyphID. Coverage placed at 6.
  const sub = concat([u16(1), u16(6), i16(delta), coverage1([coverGid])]);
  return { tag, type: 1, flag: 0, subtables: [sub] };
}

export function ligatureLookup(tag: string, first: number, rest: number[], ligGid: number): LookupDef {
  const compCount = 1 + rest.length;
  const ligature = concat([u16(ligGid), u16(compCount), ...rest.map(u16)]);
  const ligSet = concat([u16(1), u16(4), ligature]);                       // count=1, ligOff=4
  // Ligature fmt1: format, coverageOff, ligSetCount, ligSetOffsets[1], then LigatureSet, then Coverage.
  const headLen = 2 + 2 + 2 + 2;                                           // 8
  const covOff = headLen + ligSet.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), ligSet, coverage1([first])]);
  return { tag, type: 4, flag: 0, subtables: [sub] };
}

export function pairKernLookup(tag: string, first: number, second: number, kern: number): LookupDef {
  // Pair fmt1, valueFormat1 = 0x0004 (xAdvance), valueFormat2 = 0.
  const pairValue = concat([u16(second), i16(kern)]);                      // secondGlyph + value1(xAdvance)
  const pairSet = concat([u16(1), pairValue]);                            // pairValueCount=1
  const headLen = 2 + 2 + 2 + 2 + 2 + 2;                                   // 12 (through pairSetOffsets[1])
  const covOff = headLen + pairSet.length;
  const sub = concat([u16(1), u16(covOff), u16(0x0004), u16(0), u16(1), u16(headLen), pairSet, coverage1([first])]);
  return { tag, type: 2, flag: 0, subtables: [sub] };
}

export interface SeqLookupRec { seqIndex: number; lookupIndex: number; }
export function chainLookup(tag: string, back: number[][], input: number[][], ahead: number[][], recs: SeqLookupRec[]): LookupDef {
  // Chain fmt3. Layout: format(3) backCount backCov[] inCount inCov[] aheadCount aheadCov[] recCount recs[].
  // Coverage tables placed after the record array; offsets relative to subtable start.
  const parts: Uint8Array[] = [];
  const covs: Uint8Array[] = [];
  const covOffsets: number[] = [];
  const header: number[] = [3];
  const push = (groups: number[][], sink: number[]) => {
    sink.push(groups.length);
    for (const g of groups) { covOffsets.push(0); covs.push(coverage1(g)); sink.push(-1 /*patched*/); }
  };
  const back0: number[] = []; push(back, back0);
  const in0: number[] = []; push(input, in0);
  const ah0: number[] = []; push(ahead, ah0);
  const flat = [...header, ...back0, ...in0, ...ah0, recs.length];
  for (const rc of recs) { flat.push(rc.seqIndex, rc.lookupIndex); }
  // Compute base offset where coverage tables begin, then patch the -1 slots.
  const headerBytes = flat.length * 2;
  let at = headerBytes;
  const covPlaced: Uint8Array[] = [];
  let ci = 0;
  const out = flat.slice();
  for (let k = 0; k < out.length; k++) if (out[k] === -1) { out[k] = at; at += covs[ci].length; covPlaced.push(covs[ci]); ci++; }
  const sub = concat([...out.map((n) => u16(n)), ...covPlaced]);
  return { tag, type: 6, flag: 0, subtables: [sub] };
}

export function markBaseLookup(tag: string, markGid: number, markAnchor: { x: number; y: number }, baseGid: number, baseAnchor: { x: number; y: number }): LookupDef {
  const anchor = (a: { x: number; y: number }) => concat([u16(1), i16(a.x), i16(a.y)]);
  // Layout: format(1) markCovOff baseCovOff markClassCount(1) markArrayOff baseArrayOff, then arrays + coverages + anchors.
  const markCov = coverage1([markGid]);
  const baseCov = coverage1([baseGid]);
  // MarkArray: count(1) [markClass(0) markAnchorOff]; anchor after array.
  const markArray = concat([u16(1), u16(0), u16(2 + 4) /*anchorOff from markArray start*/, anchor(markAnchor)]);
  // BaseArray: count(1) [baseAnchorOff (markClassCount=1)]; anchor after array.
  const baseArray = concat([u16(1), u16(2 + 2) /*anchorOff from baseArray start*/, anchor(baseAnchor)]);
  const headLen = 12;
  let at = headLen;
  const markCovOff = at; at += markCov.length;
  const baseCovOff = at; at += baseCov.length;
  const markArrayOff = at; at += markArray.length;
  const baseArrayOff = at; at += baseArray.length;
  const sub = concat([u16(1), u16(markCovOff), u16(baseCovOff), u16(1), u16(markArrayOff), u16(baseArrayOff), markCov, baseCov, markArray, baseArray]);
  return { tag, type: 4, flag: 0, subtables: [sub] };
}

function buildOtTable(lookups: LookupDef[]): Uint8Array {
  // ScriptList: 'DFLT' + 'latn', both default langsys pointing at ALL feature indices.
  const featureCount = lookups.length;
  const featureIdx = lookups.map((_, i) => i);
  const langSys = concat([u16(0), u16(0xFFFF), u16(featureCount), ...featureIdx.map(u16)]);
  const scriptTable = concat([u16(4), u16(0), langSys]);  // defaultLangSysOff=4, langSysCount=0
  // Two script records ('DFLT','latn') both pointing at the same ScriptTable.
  const slHeader = concat([u16(2), tag4('DFLT'), u16(0 /*patch*/), tag4('latn'), u16(0 /*patch*/)]);
  const stOff = slHeader.length;
  const slV = new DataView(slHeader.buffer);
  slV.setUint16(6, stOff); slV.setUint16(14, stOff);
  const scriptList = concat([slHeader, scriptTable]);
  // FeatureList: one feature per lookup, each referencing its own lookup index.
  const featHeader: Uint8Array[] = [u16(featureCount)];
  const featBodies: Uint8Array[] = [];
  let fAt = 2 + featureCount * 6;
  const featRecs: Uint8Array[] = [];
  lookups.forEach((lk, i) => {
    const body = concat([u16(0), u16(1), u16(i)]);       // featureParams, lookupCount=1, lookupIndex=i
    featRecs.push(concat([tag4(lk.tag), u16(fAt)]));
    featBodies.push(body); fAt += body.length;
  });
  const featureList = concat([u16(featureCount), ...featRecs, ...featBodies]);
  // LookupList.
  const lkHeader: Uint8Array[] = [u16(lookups.length)];
  let lAt = 2 + lookups.length * 2;
  const lkOffs: Uint8Array[] = [];
  const lkBodies: Uint8Array[] = [];
  for (const lk of lookups) {
    const subOffsets: number[] = [];
    let subAt = 6 + lk.subtables.length * 2;
    const subBytes: Uint8Array[] = [];
    for (const s of lk.subtables) { subOffsets.push(subAt); subBytes.push(s); subAt += s.length; }
    const body = concat([u16(lk.type), u16(lk.flag), u16(lk.subtables.length), ...subOffsets.map(u16), ...subBytes]);
    lkOffs.push(u16(lAt)); lkBodies.push(body); lAt += body.length;
  }
  const lookupList = concat([...lkHeader, ...lkOffs, ...lkBodies]);
  // Header: version 1.0, scriptListOff, featureListOff, lookupListOff.
  const hdrLen = 10;
  const sOff = hdrLen, fOff = sOff + scriptList.length, lOff = fOff + featureList.length;
  return concat([u16(1), u16(0), u16(sOff), u16(fOff), u16(lOff), scriptList, featureList, lookupList]);
}

export function buildGsub(lookups: LookupDef[]): Uint8Array { return buildOtTable(lookups); }
export function buildGpos(lookups: LookupDef[]): Uint8Array { return buildOtTable(lookups); }

export function buildGdefClasses(classes: [number, number][]): Uint8Array {
  const sorted = [...classes].sort((a, b) => a[0] - b[0]);
  const cd = concat([u16(2), u16(sorted.length), ...sorted.flatMap(([g, c]) => [u16(g), u16(g), u16(c)])]);
  return concat([u16(1), u16(0), u16(12), u16(0), u16(0), u16(0), cd]); // glyphClassDefOff=12
}

/** A glyf font (many glyphs) carrying optional GSUB/GPOS/GDEF. Advances: gid*100 (>=100). */
export function buildOtFont(ot: { gsub?: Uint8Array; gpos?: Uint8Array; gdef?: Uint8Array }): Uint8Array {
  const numGlyphs = 100;
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]); // one shared non-empty simple glyph shape
  const glyphs = [g0]; for (let i = 1; i < numGlyphs; i++) glyphs.push(g1);
  const glyf = concat(glyphs);
  const offs = [0]; for (let i = 0; i < numGlyphs; i++) offs.push(offs[i] + glyphs[i].length);
  const loca = concat(offs.map((o) => u16(o / 2)));
  const maxp = (() => { const b = new Uint8Array(32); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, numGlyphs); return b; })();
  const hhea = (() => { const b = new Uint8Array(36); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, numGlyphs); return b; })();
  const hmtxParts: Uint8Array[] = []; for (let i = 0; i < numGlyphs; i++) hmtxParts.push(u16(Math.max(100, i * 100)), i16(0));
  const hmtx = concat(hmtxParts);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmap() }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  if (ot.gdef) tables.push({ tag: 'GDEF', data: ot.gdef });
  if (ot.gsub) tables.push({ tag: 'GSUB', data: ot.gsub });
  if (ot.gpos) tables.push({ tag: 'GPOS', data: ot.gpos });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1)); // sfnt directory: tags ascending
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}
```

Then delete the inline builders (`miniGsub`, `gsubSingleDelta`, `gsubLiga`, `gsubMultiple`, `gsubAlternate`, `gsubChainNested`, `gsubExtSingle`, `gposPairKern`, `gposSingleAdj`, `gposMarkBase`, `gposChainNested`, `gposExtPair`) from `test/otlayout.test.ts`, re-pointing the earlier Task 2–9 tests at the shared emitters (`buildGsub([...])`, `buildGpos([...])`). Add `multipleLookup`/`alternateLookup`/`singleAdjustLookup`/`extensionLookup`/`markMarkLookup` following the same pattern so those tasks' tests use them too.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/otlayout.test.ts`
Expected: PASS — all acceptance cases (liga, calt, init/medi/fina, kern, mark-to-base, malformed degrade). Then the **full gate**:

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green (no regression in `test/sfnt.test.ts` — the shared `build-sfnt.ts` additions are purely additive).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-sfnt.ts test/otlayout.test.ts
git commit -m "feat(8u0.1): synthetic GSUB/GPOS/GDEF emitters + otlayout acceptance suite"
```

---

## Self-Review

**Spec coverage (design §"OpenType layout coverage" + §Testing, Phase 1 bullets):**

| Spec item | Task |
|---|---|
| Coverage 1/2, ClassDef 1/2 | Task 1 |
| Script/Feature/Lookup lists, LangSys (`dflt` + language) | Task 2 |
| GDEF glyph classes, mark-attach class, mark-filtering sets; `LookupFlag` bits | Task 3 |
| GSUB 1 Single, 4 Ligature | Task 4 |
| GSUB 2 Multiple, 3 Alternate (→first) | Task 5 |
| GSUB 5/6 Contextual/Chaining, 7 Extension, 8 Reverse chaining single | Task 6 |
| GPOS 1 Single, 2 Pair/kern (1/2) | Task 7 |
| GPOS 4 Mark-to-base, 6 Mark-to-mark, 3 Cursive, 5 Mark-to-lig (best-effort) | Task 8 |
| GPOS 7/8 Contextual/Chaining, 9 Extension | Task 9 |
| No-PDF-integration entry point; malformed→no-op; advances from hmtx | Task 10 |
| Extended `build-sfnt.ts` emitting GDEF/GSUB/GPOS; acceptance tests (liga, calt, Arabic init/medi/fina, kern, mark-to-base) | Task 11 |
| sfnt.ts exposes lazily-parsed/cached tables | Task 10 |

**Test-fixture bootstrapping note:** Tasks 2–9 are written with small **inline** table builders in the test file so each task is independently runnable in isolation; Task 11 replaces them with the shared `build-sfnt.ts` emitters and adds the acceptance suite. If executing strictly in order, the inline builders keep every task green on its own; a reviewer may instead choose to land Task 11's emitters first and skip the inline copies — either order satisfies the plan.

**Interface consistency:** `ShapedGlyph` (gid/cluster/xAdvance/xOffset/yOffset) is the single mutable buffer type across every task. `OtReader.u16/i16/u32/tag` naming is uniform. `applyGsub`/`applyGpos` share `resolveLookups`; chaining shares `matchChain`/`readCovPreds`/`readSeqLookups` between GSUB (Task 6) and GPOS (Task 9). `applyFeatures` is the sole cross-phase entry Phase 3 consumes (spec §Shaping pipeline step 3).

**Degradation:** `parseOtTable`/`parseGdef` wrap in try/catch → `undefined`; `applyFeatures` wraps GSUB+GPOS in try/catch and always returns a buffer; unknown lookup formats/types return 0/false (pass-through). Satisfies design's "Anything absent/malformed degrades to a no-op, never throws."

**Out of scope (correctly deferred to Phase 3):** bidi/RTL reversal, script itemization, Arabic joining-type derivation, `/ToUnicode`, PDF emission, `AddFont`/`AddText` API. Phase 1 accepts `script`/`lang`/`features`/`rtl` as inputs but does not compute them.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-09-complex-text-shaping-phase1-otlayout.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
