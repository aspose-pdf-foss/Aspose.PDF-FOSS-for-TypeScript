# Glyph Subsetting (gnr.3 / Track S) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal valid `glyf` sfnt from a parsed `SfntFont` plus a set of used glyph ids, returning the subset bytes and an original→subset GID map.

**Architecture:** One new pure module `src/subset.ts` exporting `subsetGlyf(font, usedGids) -> { bytes, gidMap }`, plus internal helpers `glyphClosure` and `remapCompositeGlyph`. Consumes the `SfntFont` from `src/sfnt.ts` (gnr.2). One parser correction: `parseSfnt` stops hard-requiring a Unicode cmap (a subset font has none); that enforcement moves to the authoring layer in gnr.5.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest, `DataView`.

## Global Constraints

- **Zero runtime dependencies** — `node:` built-ins only; none needed here.
- **ESM + NodeNext** — relative imports carry `.js` (e.g. `import { parseSfnt } from './sfnt.js'`).
- **Errors** — `UnsupportedFeatureError` when called on a non-`glyf` font; otherwise no throws. From `./errors.js`.
- **Internal module** — `subsetGlyf`/`SubsetResult` are `@internal`; not exported from `src/index.ts` in this task.
- **TDD** — failing test first; `npx vitest run test/subset.test.ts` per task; `npm run typecheck` stays green; `npm test` green before the final commit.
- **GID convention** — `gidMap: Map<origGid, subsetGid>`, dense subset gids `0..N-1` in ascending original-gid order, always including gid 0 (`.notdef`). This matches the embedding decision (CID = original GID; `/CIDToGIDMap` stream maps original→subset).
- Spec: `docs/superpowers/specs/2026-06-23-font-embedding-subsetting-design.md` (Track S).

---

## File Structure

- **Create** `src/subset.ts` — closure, composite remap, table assembly, `subsetGlyf`. One responsibility: parsed font + used gids → subset sfnt bytes.
- **Modify** `src/sfnt.ts` — drop the "no usable cmap" throw for glyf fonts (relocate to authoring layer later).
- **Modify** `test/helpers/build-sfnt.ts` — add `buildClosureTtf()`: a 4-glyph font that exercises glyph dropping, renumbering, and composite-component remapping.
- **Create** `test/subset.test.ts` — the subsetter's vitest suite.

`SubsetResult` delivered to gnr.4:

```ts
export interface SubsetResult {
  bytes: Uint8Array;            // a standalone valid glyf sfnt (head/maxp/hhea/hmtx/loca/glyf)
  gidMap: Map<number, number>;  // original GID -> subset GID (dense, 0=.notdef)
}
```

---

## Task 1: Relax cmap requirement + closure fixture

**Files:**
- Modify: `src/sfnt.ts`
- Modify: `test/helpers/build-sfnt.ts`
- Test: `test/sfnt.test.ts`

**Interfaces:**
- Produces: `parseSfnt` no longer throws on a glyf font lacking a usable cmap (`f.cmap` is simply empty). `buildClosureTtf(): Uint8Array` — glyphs: 0 `.notdef` (empty), 1 simple (advance 600, droppable), 2 simple (advance 700), 3 composite→gid 2 (advance 800); `numGlyphs`=4; a cmap mapping 0x41→1.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/sfnt.test.ts (it already imports stripTable, buildMinimalTtf, parseSfnt)
import { buildClosureTtf } from './helpers/build-sfnt.js';

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
```

Add `buildClosureTtf` to `test/helpers/build-sfnt.ts`:

```ts
// test/helpers/build-sfnt.ts — append (reuses module-scoped u16/i16/u32/concat/pad4
// and the exported buildHead/buildHhea/buildCmap/buildName/buildOS2/buildPost helpers)

function buildMaxp4(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, 4); // numGlyphs = 4
  return b;
}
function buildHhea4(): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200);
  v.setUint16(34, 4); // numberOfHMetrics = 4
  return b;
}
function buildHmtx4(): Uint8Array {
  return concat([u16(500), i16(0), u16(600), i16(0), u16(700), i16(0), u16(800), i16(0)]);
}
function buildClosureGlyf(): { glyf: Uint8Array; loca: Uint8Array } {
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);  // simple (10)
  const g2 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);  // simple (10)
  const flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
  const g3 = concat([i16(-1), i16(0), i16(0), i16(0x100), i16(0x100), u16(flags), u16(2), i16(0), i16(0)]); // composite -> gid 2 (18)
  const glyf = concat([g0, g1, g2, g3]);
  const offs = [0, 0, 10, 20, 38];
  const loca = concat(offs.map((o) => u16(o / 2)));
  return { glyf, loca };
}
export function buildClosureTtf(): Uint8Array {
  const { glyf, loca } = buildClosureGlyf();
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea4() },
    { tag: 'hmtx', data: buildHmtx4() },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp4() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  const dirSize = 12 + numTables * 16;
  let offset = dirSize;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sfnt.test.ts`
Expected: FAIL — the no-cmap case throws `UnsupportedFeatureError` (current parser behavior).

- [ ] **Step 3: Relax the parser**

In `src/sfnt.ts`, delete the throw so a missing cmap leaves `f.cmap` empty:

```ts
// REMOVE these two lines from parseSfnt:
//   if (f.outlines === 'glyf' && f.cmap.size === 0)
//     throw new UnsupportedFeatureError('font has no usable Unicode cmap (need format 4 or 12)');
```

Keep the cmap *parsing* (`if (cmapTable) f.cmap = readCmap(cmapTable);`) and keep `cmapTable` non-required for both kinds:

```ts
  const cmapTable = f.table('cmap', false); // optional: subset fonts carry none
  if (cmapTable) f.cmap = readCmap(cmapTable);
```

If `UnsupportedFeatureError` becomes unused in `sfnt.ts` after this, leave the import — it is still thrown for WOFF/WOFF2. (It is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sfnt.test.ts` and `npm run typecheck`
Expected: PASS (all sfnt suites, including the two new cases); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts test/sfnt.test.ts test/helpers/build-sfnt.ts
git commit -m "refactor(gnr.3): make cmap optional in parseSfnt; add closure fixture"
```

---

## Task 2: Glyph closure

**Files:**
- Create: `src/subset.ts`
- Test: `test/subset.test.ts`

**Interfaces:**
- Produces: `glyphClosure(font: SfntFont, used: Iterable<number>): Set<number>` — `{0} ∪ used`, transitively adding composite component gids, ignoring out-of-range gids.

- [ ] **Step 1: Write the failing test**

```ts
// test/subset.test.ts
import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { buildClosureTtf } from './helpers/build-sfnt.js';
import { glyphClosure } from '../src/subset.js';

describe('glyphClosure', () => {
  it('always includes .notdef and the used gids', () => {
    const f = parseSfnt(buildClosureTtf());
    expect([...glyphClosure(f, [2])].sort((a, b) => a - b)).toEqual([0, 2]);
  });
  it('pulls in composite component gids transitively', () => {
    const f = parseSfnt(buildClosureTtf());
    // gid 3 is composite -> gid 2; closure must include {0, 2, 3}
    expect([...glyphClosure(f, [3])].sort((a, b) => a - b)).toEqual([0, 2, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subset.test.ts`
Expected: FAIL — cannot find module `../src/subset.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/subset.ts
import { SfntFont } from './sfnt.js';
import { UnsupportedFeatureError } from './errors.js';

export interface SubsetResult {
  bytes: Uint8Array;
  gidMap: Map<number, number>;
}

/** {0} ∪ used, closed over composite-glyph component gids. */
export function glyphClosure(font: SfntFont, used: Iterable<number>): Set<number> {
  const set = new Set<number>([0]);
  for (const g of used) if (Number.isInteger(g) && g >= 0 && g < font.numGlyphs) set.add(g);
  const stack = [...set];
  while (stack.length) {
    const g = stack.pop()!;
    for (const c of font.componentGids(g))
      if (!set.has(c) && c >= 0 && c < font.numGlyphs) { set.add(c); stack.push(c); }
  }
  return set;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subset.test.ts` and `npm run typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/subset.ts test/subset.test.ts
git commit -m "feat(gnr.3): glyph closure over composite components"
```

---

## Task 3: Composite-glyph component remapping

**Files:**
- Modify: `src/subset.ts`
- Test: `test/subset.test.ts`

**Interfaces:**
- Produces: `remapCompositeGlyph(bytes: Uint8Array, gidMap: Map<number, number>): Uint8Array` — returns a copy of a composite glyph's bytes with each component `glyphIndex` rewritten through `gidMap`. Simple/empty glyphs are copied unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/subset.test.ts
import { remapCompositeGlyph } from '../src/subset.js';

describe('remapCompositeGlyph', () => {
  it('rewrites composite component gids through the map', () => {
    const f = parseSfnt(buildClosureTtf());
    const g3 = f.glyphData(3); // composite -> component gid 2
    const out = remapCompositeGlyph(g3, new Map([[2, 1]]));
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(v.getInt16(0)).toBeLessThan(0);   // still composite
    expect(v.getUint16(12)).toBe(1);          // component gid 2 -> 1 (at offset 10+2)
  });
  it('returns simple glyphs unchanged', () => {
    const f = parseSfnt(buildClosureTtf());
    const g2 = f.glyphData(2);
    expect(Array.from(remapCompositeGlyph(g2, new Map([[2, 1]])))).toEqual(Array.from(g2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subset.test.ts`
Expected: FAIL — `remapCompositeGlyph` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/subset.ts
/** Copy a glyph's bytes, rewriting any composite component gids via `gidMap`. */
export function remapCompositeGlyph(bytes: Uint8Array, gidMap: Map<number, number>): Uint8Array {
  const out = bytes.slice();
  if (out.length < 2) return out;
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (v.getInt16(0) >= 0) return out; // simple/empty glyph
  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
    X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080;
  let p = 10; // numberOfContours(2) + bbox(8)
  for (;;) {
    const flags = v.getUint16(p); const comp = v.getUint16(p + 2);
    const mapped = gidMap.get(comp);
    if (mapped !== undefined) v.setUint16(p + 2, mapped);
    p += 4;
    p += (flags & ARG_WORDS) ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) p += 2;
    else if (flags & X_AND_Y_SCALE) p += 4;
    else if (flags & TWO_BY_TWO) p += 8;
    if (!(flags & MORE)) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subset.test.ts` and `npm run typecheck`
Expected: PASS (4 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/subset.ts test/subset.test.ts
git commit -m "feat(gnr.3): remap composite component gids for subsetting"
```

---

## Task 4: subsetGlyf — assemble the subset sfnt

**Files:**
- Modify: `src/subset.ts`
- Test: `test/subset.test.ts`

**Interfaces:**
- Produces: `subsetGlyf(font: SfntFont, used: Iterable<number>): SubsetResult`. Emits a standalone sfnt with `head/maxp/hhea/hmtx/loca/glyf` (cmap/name dropped), recomputed table checksums and `head.checkSumAdjustment`, glyph data in subset-gid order with composite components remapped, `loca` short/long by size. `gidMap` is original→subset (dense, ascending). Throws `UnsupportedFeatureError` for a non-`glyf` font.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/subset.test.ts
import { subsetGlyf } from '../src/subset.js';

describe('subsetGlyf', () => {
  it('produces a re-parseable subset preserving advances and remapped components', () => {
    const f = parseSfnt(buildClosureTtf());
    const { bytes, gidMap } = subsetGlyf(f, [3]); // closure {0,2,3} -> map 0:0, 2:1, 3:2
    expect([...gidMap.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 0], [2, 1], [3, 2]]);

    const sub = parseSfnt(bytes);
    expect(sub.numGlyphs).toBe(3);
    expect(sub.advanceWidth(1)).toBe(700); // original gid 2
    expect(sub.advanceWidth(2)).toBe(800); // original gid 3
    expect(sub.componentGids(2)).toEqual([1]); // gid3's component (orig 2) -> subset 1
  });

  it('keeps .notdef and drops unused glyphs', () => {
    const f = parseSfnt(buildClosureTtf());
    const { gidMap } = subsetGlyf(f, [2]); // closure {0,2}
    expect([...gidMap.keys()].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it('rejects a non-glyf font', () => {
    // makeOttoWithCff -> outlines 'cff'
    const cff = parseSfnt(makeOttoWithCff());
    expect(() => subsetGlyf(cff, [1])).toThrow(UnsupportedFeatureError);
  });
});
```

Add `makeOttoWithCff` and `UnsupportedFeatureError` to the test imports:

```ts
import { buildClosureTtf, makeOttoWithCff } from './helpers/build-sfnt.js';
import { UnsupportedFeatureError } from '../src/errors.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subset.test.ts`
Expected: FAIL — `subsetGlyf` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/subset.ts
function u16b(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function u32b(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function pad4b(b: Uint8Array): Uint8Array { const r = b.length % 4; return r ? cat([b, new Uint8Array(4 - r)]) : b; }
function tableChecksum(b: Uint8Array): number {
  const p = pad4b(b); const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let sum = 0; for (let i = 0; i < p.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum >>> 0;
}
function assembleSfnt(tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset; const padded = pad4b(t.data); offset += padded.length;
    return { tag: t.tag, at, length: t.data.length, padded, checksum: tableChecksum(t.data) };
  });
  const offsetTable = cat([u32b(0x00010000), u16b(numTables), u16b(0), u16b(0), u16b(0)]);
  const dir = cat(placed.map((p) => cat([new TextEncoder().encode(p.tag), u32b(p.checksum), u32b(p.at), u32b(p.length)])));
  const font = cat([offsetTable, dir, ...placed.map((p) => p.padded)]);
  const fv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  let sum = 0; for (let i = 0; i < font.length; i += 4) sum = (sum + fv.getUint32(i)) >>> 0;
  const head = placed.find((p) => p.tag === 'head');
  if (head) fv.setUint32(head.at + 8, (0xB1B0AFBA - sum) >>> 0); // checkSumAdjustment
  return font;
}

export function subsetGlyf(font: SfntFont, used: Iterable<number>): SubsetResult {
  if (font.outlines !== 'glyf') throw new UnsupportedFeatureError('subsetGlyf requires a glyf-outline font');
  const order = [...glyphClosure(font, used)].sort((a, b) => a - b);
  const gidMap = new Map<number, number>();
  order.forEach((g, i) => gidMap.set(g, i));
  const n = order.length;

  // glyf + loca (each glyph padded to even length for short-loca compatibility).
  const parts: Uint8Array[] = []; const offsets: number[] = [0]; let off = 0;
  for (const origGid of order) {
    let g = remapCompositeGlyph(font.glyphData(origGid), gidMap);
    if (g.length % 2) g = cat([g, new Uint8Array(1)]);
    parts.push(g); off += g.length; offsets.push(off);
  }
  const glyf = cat(parts);
  const longLoca = off > 0x1fffe;
  const loca = cat(offsets.map((o) => (longLoca ? u32b(o) : u16b(o / 2))));

  const head = font.table('head')!.slice();
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hv.setUint32(8, 0);                  // checkSumAdjustment recomputed at assembly
  hv.setInt16(50, longLoca ? 1 : 0);   // indexToLocFormat

  const maxp = font.table('maxp')!.slice();
  new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, n);

  const hhea = font.table('hhea')!.slice();
  new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, n);

  const hmtx = new Uint8Array(n * 4); const mv = new DataView(hmtx.buffer);
  order.forEach((origGid, i) => { mv.setUint16(i * 4, font.advanceWidth(origGid) & 0xffff); mv.setInt16(i * 4 + 2, 0); });

  const bytes = assembleSfnt([
    { tag: 'glyf', data: glyf }, { tag: 'head', data: head }, { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx }, { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp },
  ]);
  return { bytes, gidMap };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subset.test.ts` and `npm run typecheck`
Expected: PASS (7 subset tests); typecheck clean.

- [ ] **Step 5: Run full suite + commit**

Run: `npm test` and `npm run typecheck`
Expected: full suite green; typecheck clean.

```bash
git add src/subset.ts test/subset.test.ts
git commit -m "feat(gnr.3): subsetGlyf assembles a minimal glyf sfnt with remapped gids"
```

---

## Self-Review (completed during planning)

- **Spec coverage (Track S):** glyph closure incl. composites (Task 2); dense renumber + `gidMap` (Task 4); glyf rebuild with composite-component rewriting (Tasks 3–4); loca short/long (Task 4); reassembly of head/maxp/hhea/hmtx/loca/glyf with cmap dropped and recomputed checksums + `head.checkSumAdjustment` (Task 4); `SubsetResult { bytes, gidMap }` (Task 4). The CID = original GID note is honored by keeping `gidMap` original→subset for gnr.4's `/CIDToGIDMap` stream.
- **Type consistency:** `glyphClosure`, `remapCompositeGlyph`, `subsetGlyf`, `SubsetResult` names are introduced once and reused; `SfntFont` members used (`numGlyphs`, `componentGids`, `glyphData`, `advanceWidth`, `table`, `outlines`) all exist from gnr.2.
- **Placeholder scan:** none — every step has concrete, runnable code.
- **Parser correction:** Task 1 relaxes the cmap requirement (a subset font has no cmap). The "needs a Unicode cmap" check belongs to the authoring layer that loads a *user* font (gnr.5), not the parser; no existing test asserted the old throw, so removing it is safe.
- **Out of scope (later children):** PDF object emission / `/CIDToGIDMap` / `/W` / FontFile2 (gnr.4); `lsb` fidelity (subset hmtx uses `lsb = 0`, advances preserved — sufficient for embedded, explicitly-positioned text); CFF subsetting (whole-embed in gnr.4).

## Notes for the executor

- Run `npx vitest run test/subset.test.ts` after each task; `npm test` + `npm run typecheck` before the final commit.
- `subsetGlyf`/`SubsetResult` stay `@internal` (not exported from `index.ts`) until gnr.4/gnr.5.
- The subset hmtx sets `lsb = 0` deliberately (advances are what the spec requires preserved); revisit only if a real font renders mispositioned in gnr.5 verification.
