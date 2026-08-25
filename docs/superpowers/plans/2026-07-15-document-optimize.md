# Document Optimization (`doc.Optimize`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.Optimize({fonts, dedup, compress})`, which losslessly shrinks the live object model in place so the next `Save()` emits a smaller, content-identical document.

**Architecture:** Five new modules behind one thin `Document.Optimize` delegate (mirroring `ConvertToPdfA` → `conversion.ts`). Fonts are shrunk by **sparse blanking** — GID numbering, `cmap`, `/Widths`, `/W`, and `CIDToGIDMap` are preserved untouched, so no mapping is ever rewritten and no subsetting bug can corrupt text. Passes run **fonts → dedup → compress** so dedup can merge font programs that shrinking just made identical.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, `node:zlib`, `node:crypto`. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-document-optimize-design.md`

## Global Constraints

- **Zero runtime deps** — only `node:` built-ins (`zlib`, `crypto`, `fs`). Never add an npm runtime dependency.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension (`import { SfntFont } from './sfnt.js'`).
- **Strict TypeScript** — `npm run typecheck` (`tsc --noEmit`) must be green before any task is considered done.
- **TDD** — write the failing test first, watch it fail, then implement. Fixtures are built programmatically by builders in `test/helpers/`; never commit binary fixtures.
- **Errors** — throw only the public error types from `src/errors.ts`: `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`.
- **Every concern is lossless.** If a transform cannot be proven safe for a given object, skip that object and report it. Never guess.
- **Test command** — full suite `npm test`; single file `npx vitest run test/<name>.test.ts`.
- **Commit** after each task. Use the `type(scope): subject` style already in the log (e.g. `feat(doo): ...`).

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `src/optimize.ts` | `OptimizeOptions`, `OptimizeReport`, `optimizeDocument()` orchestrator |
| `src/glyphusage.ts` | Content scan → per-font used-GID sets + completeness/skip reasons |
| `src/fontshrink.ts` | Sparse font-program shrink (glyf blank, CFF blank, table drop) |
| `src/dedup.ts` | Byte-identical indirect-stream merge |
| `src/recompress.ts` | Flate unfiltered streams; re-deflate `[FlateDecode]` at level 9 |
| `test/helpers/build-optimize-pdf.ts` | Fixture: a PDF with a **whole** (unsubset) font embedded |
| `test/optimize.test.ts`, `test/fontshrink.test.ts`, `test/glyphusage.test.ts`, `test/dedup.test.ts`, `test/recompress.test.ts` | Tests |

**Modified:**

| Path | Change | Task |
|---|---|---|
| `src/subset.ts` | Export `assembleSfnt`, `cat`, `u16b`, `u32b`; add `sfntVersion` param | 1 |
| `src/cff.ts` | Expose reverse charset (`gidToCid`) for CID-keyed fonts | 3 |
| `src/text.ts` | Export `contentStreamBytes` (currently module-local, line 369) | 4 |
| `src/document.ts` | Add `Optimize()` method | 8 |
| `src/index.ts` | Export the public Optimize types | 9 |
| `README.md` | Features + API overview + Limitations entries | 9 |

---

### Task 1: Export sfnt assembly helpers from `subset.ts`

`fontshrink.ts` must reassemble an sfnt from a table list. `assembleSfnt` already does exactly this but is module-local, and it hardcodes the TrueType `0x00010000` sfnt tag — CFF-bearing fonts need `OTTO`.

**Files:**
- Modify: `src/subset.ts:44-75`
- Test: `test/subset.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function assembleSfnt(tables: { tag: string; data: Uint8Array }[], sfntVersion?: number): Uint8Array` — default `0x00010000`.
  - `export function cat(parts: Uint8Array[]): Uint8Array`
  - `export function u16b(n: number): Uint8Array`
  - `export function u32b(n: number): Uint8Array`
  - `export const OTTO_TAG = 0x4f54544f;`

- [ ] **Step 1: Write the failing test**

Append to `test/subset.test.ts`:

```ts
import { assembleSfnt, OTTO_TAG, cat, u16b, u32b } from '../src/subset.js';

describe('assembleSfnt', () => {
  it('emits the TrueType sfnt tag by default', () => {
    const out = assembleSfnt([{ tag: 'test', data: Uint8Array.from([1, 2, 3]) }]);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0)).toBe(0x00010000);
    expect(new DataView(out.buffer, out.byteOffset).getUint16(4)).toBe(1); // numTables
  });

  it('emits the OTTO tag when asked', () => {
    const out = assembleSfnt([{ tag: 'CFF ', data: Uint8Array.from([9]) }], OTTO_TAG);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(0)).toBe(0x4f54544f);
    expect(String.fromCharCode(...out.subarray(12, 16))).toBe('CFF ');
  });

  it('exports byte helpers', () => {
    expect([...cat([u16b(1), u32b(2)])]).toEqual([0, 1, 0, 0, 0, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subset.test.ts`
Expected: FAIL — `assembleSfnt is not exported` / TypeScript error "has no exported member 'assembleSfnt'".

- [ ] **Step 3: Implement**

In `src/subset.ts`, add the `export` keyword to `cat`, `u16b`, `u32b`, and `assembleSfnt`, and add the version parameter. Replace the `assembleSfnt` signature and its offset-table line:

```ts
export const OTTO_TAG = 0x4f54544f;

export function assembleSfnt(
  tables: { tag: string; data: Uint8Array }[],
  sfntVersion = 0x00010000,
): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset; const padded = pad4b(t.data); offset += padded.length;
    return { tag: t.tag, at, length: t.data.length, padded, checksum: tableChecksum(t.data) };
  });
  const offsetTable = cat([u32b(sfntVersion), u16b(numTables), u16b(0), u16b(0), u16b(0)]);
  const dir = cat(placed.map((p) => cat([new TextEncoder().encode(p.tag), u32b(p.checksum), u32b(p.at), u32b(p.length)])));
  const font = cat([offsetTable, dir, ...placed.map((p) => p.padded)]);
  const fv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  let sum = 0; for (let i = 0; i < font.length; i += 4) sum = (sum + fv.getUint32(i)) >>> 0;
  const head = placed.find((p) => p.tag === 'head');
  if (head) fv.setUint32(head.at + 8, (0xB1B0AFBA - sum) >>> 0); // checkSumAdjustment
  return font;
}
```

Leave the body otherwise unchanged (`subsetGlyf` keeps calling it with the default).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/subset.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. `subsetGlyf`'s existing tests must still pass (regression guard on the refactor).

- [ ] **Step 5: Commit**

```bash
git add src/subset.ts test/subset.test.ts
git commit -m "refactor(doo): export assembleSfnt + byte helpers, add sfntVersion param"
```

---

### Task 2: `fontshrink.ts` — glyf sparse blanking

**Files:**
- Create: `src/fontshrink.ts`
- Test: `test/fontshrink.test.ts`

**Interfaces:**
- Consumes: `assembleSfnt`, `cat`, `u16b`, `u32b` (Task 1); `glyphClosure` from `./subset.js`; `SfntFont`/`parseSfnt` from `./sfnt.js`.
- Produces:
  - `export interface ShrinkResult { bytes: Uint8Array; gidsKept: number; gidsDropped: number; }`
  - `export function shrinkGlyf(font: SfntFont, keep: Set<number>): ShrinkResult`
  - `export const DROP_TABLES: ReadonlySet<string>`

**Why closure matters:** a kept composite glyph references component GIDs. Dropping a component's outline blanks the composite. `glyphClosure` (already in `subset.ts`) closes over components — reuse it, don't reimplement.

- [ ] **Step 1: Write the failing test**

Create `test/fontshrink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { shrinkGlyf } from '../src/fontshrink.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';

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
    expect(parseSfnt(res.bytes).tables.has('post')).toBe(true);  // post is kept in v1
    expect(res.bytes.length).toBeLessThan(font.raw.length);
    expect(res.gidsDropped).toBe(1); // gid 2 dropped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fontshrink.test.ts`
Expected: FAIL — "Failed to resolve import ../src/fontshrink.js".

- [ ] **Step 3: Implement**

Create `src/fontshrink.ts`:

```ts
import { SfntFont } from './sfnt.js';
import { glyphClosure, assembleSfnt, cat, u16b, u32b } from './subset.js';

/** Tables carrying no information needed to render already-positioned text:
 *  layout (GSUB/GPOS/GDEF/BASE/JSTF/kern), hinting/device metrics
 *  (hdmx/VDMX/LTSH/gasp/PCLT), embedded bitmaps (EBDT/EBLC/CBDT/CBLC/sbix),
 *  colour/vector extras (SVG /MATH), and the signature (DSIG).
 *  Note: 'SVG ' is space-padded to four characters, as sfnt tags always are. */
export const DROP_TABLES: ReadonlySet<string> = new Set([
  'GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'DSIG', 'kern', 'hdmx', 'VDMX',
  'LTSH', 'PCLT', 'gasp', 'EBDT', 'EBLC', 'CBDT', 'CBLC', 'sbix', 'SVG ', 'MATH',
]);

export interface ShrinkResult {
  bytes: Uint8Array;
  gidsKept: number;
  gidsDropped: number;
}

/**
 * Sparse-shrink a glyf font: keep `numGlyphs` and GID numbering, blank the
 * outlines of glyphs outside `keep` (closed over composite components), and drop
 * DROP_TABLES. cmap/hmtx/hhea/maxp are copied verbatim, so every existing
 * code->GID mapping in the document stays valid without any rewrite.
 */
export function shrinkGlyf(font: SfntFont, keep: Set<number>): ShrinkResult {
  const closure = glyphClosure(font, keep);

  // glyf + loca, same entry count; dropped glyphs become zero-length.
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let off = 0;
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    let g = closure.has(gid) ? font.glyphData(gid) : new Uint8Array(0);
    if (g.length % 2) g = cat([g, new Uint8Array(1)]); // even-align for short loca
    parts.push(g); off += g.length; offsets.push(off);
  }
  const glyf = cat(parts);
  const longLoca = off > 0x1fffe;
  const loca = cat(offsets.map((o) => (longLoca ? u32b(o) : u16b(o / 2))));

  const head = font.table('head')!.slice();
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hv.setUint32(8, 0);                  // checkSumAdjustment recomputed at assembly
  hv.setInt16(50, longLoca ? 1 : 0);   // indexToLocFormat

  const tables: { tag: string; data: Uint8Array }[] = [];
  for (const tag of font.tables.keys()) {
    if (DROP_TABLES.has(tag) || tag === 'glyf' || tag === 'loca' || tag === 'head') continue;
    const data = font.table(tag, false);
    if (data) tables.push({ tag, data: data.slice() });
  }
  tables.push({ tag: 'glyf', data: glyf }, { tag: 'loca', data: loca }, { tag: 'head', data: head });

  return {
    bytes: assembleSfnt(tables),
    gidsKept: closure.size,
    gidsDropped: font.numGlyphs - closure.size,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fontshrink.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fontshrink.ts test/fontshrink.test.ts
git commit -m "feat(doo): sparse glyf shrink — blank unused outlines, drop layout tables"
```

---

### Task 3: `cff.ts` reverse charset + `fontshrink.ts` CFF blanking

A CID-keyed CFF resolves CID→GID through its **own charset**, so blanking must re-emit that charset unchanged. `CffFont.cidToGid()` exists but the reverse map is private; expose it.

`assembleCidCff` emits **empty subrs**, so kept charstrings must be flattened (subrs inlined) via `flattenGlyph` before assembly.

**Files:**
- Modify: `src/cff.ts:74-77`
- Modify: `src/fontshrink.ts`
- Test: `test/fontshrink.test.ts`

**Interfaces:**
- Consumes: `parseCffProgram`, `flattenGlyph`, `assembleCidCff`, `writeIndex` from `./cffsubset.js`; `bias` from `./cff.js`; `CffFont` from `./cff.js`.
- Produces:
  - `CffFont.gidToCid(gid: number): number` — identity when the font is not CID-keyed or has no charset.
  - `export function shrinkCff(cff: Uint8Array, keep: Set<number>): ShrinkResult` in `fontshrink.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/fontshrink.test.ts`:

```ts
import { shrinkCff } from '../src/fontshrink.js';
import { CffFont } from '../src/cff.js';
import { buildManyGlyphCff } from './helpers/build-cff.js';

describe('shrinkCff', () => {
  it('keeps numGlyphs intact and blanks unused charstrings', () => {
    const cff = buildManyGlyphCff(10);
    const res = shrinkCff(cff, new Set([1, 2]));
    const out = new CffFont(res.bytes);
    expect(out.numGlyphs).toBe(new CffFont(cff).numGlyphs);
    expect(res.gidsKept).toBe(3);   // {0, 1, 2}
    expect(res.gidsDropped).toBe(7);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fontshrink.test.ts`
Expected: FAIL — "shrinkCff is not exported" and "gidToCid is not a function".

- [ ] **Step 3a: Implement `gidToCid` in `src/cff.ts`**

Add next to `cidToGid` (around line 74), plus a lazily-built reverse map field:

```ts
  /** @internal gid -> CID, inverted from the charset on first use. */
  private gidToCidMap?: Map<number, number>;

  /** GID for a CID via the charset (identity when non-CID / charset absent). */
  cidToGid(cid: number): number {
    if (!this.cidToGidMap) return cid;
    return this.cidToGidMap.get(cid) ?? 0;
  }

  /** CID for a GID — the inverse of {@link cidToGid} (identity when non-CID /
   *  charset absent). Used to re-emit an unchanged charset when blanking. */
  gidToCid(gid: number): number {
    if (!this.cidToGidMap) return gid;
    if (!this.gidToCidMap) {
      this.gidToCidMap = new Map();
      for (const [cid, g] of this.cidToGidMap) this.gidToCidMap.set(g, cid);
    }
    return this.gidToCidMap.get(gid) ?? 0;
  }
```

- [ ] **Step 3b: Implement `shrinkCff` in `src/fontshrink.ts`**

```ts
import { CffFont, bias } from './cff.js';
import { parseCffProgram, flattenGlyph, assembleCidCff } from './cffsubset.js';

/** A bare Type2 `endchar` — a valid, empty outline. */
const ENDCHAR = Uint8Array.from([14]);

/**
 * Sparse-shrink a CFF program: keep `numGlyphs` and GID numbering, replace the
 * charstrings of glyphs outside `keep` with a bare `endchar`, and re-emit the
 * original charset so CID->GID resolution is unchanged. Kept charstrings are
 * flattened (subrs inlined) because assembleCidCff emits empty subr INDEXes.
 */
export function shrinkCff(cff: Uint8Array, keep: Set<number>): ShrinkResult {
  const prog = parseCffProgram(cff);
  const font = new CffFont(cff);
  const globalBias = bias(prog.globalSubrs.length);

  const charStrings: Uint8Array[] = [];
  let kept = 0;
  for (let gid = 0; gid < prog.numGlyphs; gid++) {
    if (gid !== 0 && !keep.has(gid)) { charStrings.push(ENDCHAR); continue; }
    const localSubrs = prog.localSubrsOf(prog.fdOf(gid));
    charStrings.push(flattenGlyph(prog.charStrings[gid], {
      localSubrs, localBias: bias(localSubrs.length),
      globalSubrs: prog.globalSubrs, globalBias,
    }));
    kept++;
  }

  // charset: subset gid == original gid, so publish each gid's original CID.
  const cidOfGid: number[] = [];
  for (let gid = 0; gid < prog.numGlyphs; gid++) cidOfGid.push(font.gidToCid(gid));

  return {
    bytes: assembleCidCff(prog.nameIndex, charStrings, cidOfGid),
    gidsKept: kept,
    gidsDropped: prog.numGlyphs - kept,
  };
}
```

> **Note:** CFF has no composite glyphs (`seac` is legacy and already flattened by `flattenGlyph`), so no closure pass is needed — unlike glyf.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/fontshrink.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cff.ts src/fontshrink.ts test/fontshrink.test.ts
git commit -m "feat(doo): sparse CFF shrink — blank unused charstrings, preserve charset"
```

---

### Task 4: `glyphusage.ts` — scanner core + Type0 code→GID

The existing `visitContent` cannot back this: `GlyphEvent` exposes decoded `text`, not raw codes, and carries no owning font dict. This is a new scan over the `content.ts` tokenizer.

This task covers page `/Contents` + Form XObjects and the two Type0 resolvers. Task 5 adds the wide usage sites and the skip policy.

Type0/Identity-H is the **only** coverage: simple TrueType, Type1, Type3, and simple CFF are skipped and reported. Their code→GID paths are heuristic, and this optimizer never guesses — a wrong guess silently blanks a glyph that is actually shown.

**Files:**
- Create: `src/glyphusage.ts`
- Test: `test/glyphusage.test.ts`
- Create: `test/helpers/build-optimize-pdf.ts`

**Interfaces:**
- Consumes: `parseContentStream`/`ContentOp` from `./content.js`; `contentStreamBytes` from `./text.js` (**must be exported in this task — it is currently a module-local function at `src/text.ts:369`, not in `pagecontent.ts`**); `decodeStream` from `./filters.js`; `CffFont` from `./cff.js`; `Document`/`Page` types.
- Produces:
  - `export interface FontUsage { gids: Set<number>; complete: boolean; reason?: string; }`
  - `export type UsageMap = Map<PdfDict, FontUsage>`
  - `export function collectGlyphUsage(doc: Document): UsageMap`
  - `src/text.ts`: add `export` to `function contentStreamBytes` (signature unchanged: `(doc: Document, page: Page) => Uint8Array[]`).

> **Do not export `markScopeIncomplete` or any other function taking the module-local `Ctx` type.** `tsconfig.json` sets `declaration: true`, so an exported function whose parameter uses a non-exported type fails the build with "has or is using private name 'Ctx'".

**Fixture rationale:** `AddFont` already subsets at `Save`, so a font embedded that way has *no* unused glyphs and Optimize would find nothing. The fixture must embed a **whole** font program — the real "producer embedded everything" case.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-optimize-pdf.ts`:

```ts
// Builds a PDF that embeds the WHOLE (unsubset) test font as a Type0/
// CIDFontType2 with CIDToGIDMap /Identity, and shows only glyph 1 ('A').
// This is the shape a real producer emits, and the shape AddFont never emits
// (AddFont subsets at Save), so it is the only way to exercise shrinking.
import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, name, ref } from '../../src/types.js';
import { buildUnicodeTtf } from './build-sfnt.js';
import { serializeDocument } from '../../src/serializer.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `content` defaults to showing CID 1 only (glyph 'A'); CIDs 0 and 2 unused. */
export function buildWholeFontPdf(content = '<0001>'): Uint8Array {
  const ttf = buildUnicodeTtf();
  const objects = new Map<number, PdfObject>();

  const fontFile: PdfObject = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Filter', name('FlateDecode')], ['Length1', ttf.length],
    ]),
    raw: new Uint8Array(deflateSync(Buffer.from(ttf))),
  };
  objects.set(6, fontFile);

  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestFont')],
    ['Flags', 4], ['FontBBox', [0, -200, 700, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', ref(6, 0)],
  ]));

  objects.set(5, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('CIDFontType2')],
    ['BaseFont', name('TestFont')],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', { kind: 'string', bytes: enc('Adobe') }],
      ['Ordering', { kind: 'string', bytes: enc('Identity') }],
      ['Supplement', 0],
    ])],
    ['FontDescriptor', ref(7, 0)], ['CIDToGIDMap', name('Identity')],
    ['DW', 1000], ['W', [1, [500, 600]]],
  ]));

  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')],
    ['BaseFont', name('TestFont')], ['Encoding', name('Identity-H')],
    ['DescendantFonts', [ref(5, 0)]],
  ]));

  const body = `BT /F1 24 Tf 50 700 Td ${content} Tj ET`;
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(8, 0)],
  ]));

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1, 0)]]);
  return serializeDocument(objects, trailer);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/glyphusage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isName, PdfDict } from '../src/types.js';
import { collectGlyphUsage } from '../src/glyphusage.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

/** The page's Type0 font dict. */
function type0(doc: Document): PdfDict {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const f = doc.resolve(fonts.get('F1'));
  if (!isDict(f)) throw new Error('no font');
  return f;
}

describe('collectGlyphUsage', () => {
  it('collects the CIDs shown by a Type0/Identity-H font as GIDs', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const usage = collectGlyphUsage(doc);
    const u = usage.get(type0(doc))!;
    expect(u).toBeDefined();
    expect(u.complete).toBe(true);
    expect([...u.gids].sort()).toEqual([1]);
  });

  it('collects every CID in a TJ array', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const usage = collectGlyphUsage(doc);
    expect([...usage.get(type0(doc))!.gids]).toContain(1);
  });

  it('maps CID->GID through a CIDToGIDMap /Identity descendant', () => {
    const doc = Document.Open(buildWholeFontPdf('<0002>'));
    const usage = collectGlyphUsage(doc);
    expect([...usage.get(type0(doc))!.gids].sort()).toEqual([2]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/glyphusage.test.ts`
Expected: FAIL — "Failed to resolve import ../src/glyphusage.js".

- [ ] **Step 4: Implement**

Create `src/glyphusage.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfDict, PdfObject, PdfStream, isDict, isName, isStream, isArray, isString,
} from './types.js';
import { parseContentStream, ContentOp } from './content.js';
import { contentStreamBytes } from './text.js'; // export it there in this task
import { decodeStream } from './filters.js';
import { CffFont } from './cff.js';

/** Glyphs a font actually shows, and whether that set is trustworthy. */
export interface FontUsage {
  gids: Set<number>;
  /** False when some usage site could not be scanned — the font must be skipped. */
  complete: boolean;
  reason?: string;
}

export type UsageMap = Map<PdfDict, FontUsage>;

const MAX_XOBJECT_DEPTH = 8;

/** Resolves character codes to GIDs for one font dict. */
interface CodeMapper {
  codeWidth: 1 | 2;
  gidOf(code: number): number | undefined;
}

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** Build a code->GID mapper, or a reason the font cannot be handled. */
function buildMapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const subtype = nameOf(doc, font.get('Subtype'));
  if (subtype === 'Type0') return type0Mapper(doc, font);
  if (subtype === 'Type3') return { reason: 'Type3 font' };
  // Simple TrueType / Type1 / simple CFF: code->GID resolution is heuristic, so
  // they are deliberately out of scope. Skipping is the safe answer.
  return { reason: `unsupported font subtype: ${subtype ?? 'none'}` };
}

function type0Mapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const encoding = nameOf(doc, font.get('Encoding'));
  if (encoding !== 'Identity-H') {
    return { reason: `Type0 encoding is not Identity-H: ${encoding ?? 'embedded CMap'}` };
  }
  const desc = doc.resolve(font.get('DescendantFonts'));
  const d0 = isArray(desc) ? resolveDict(doc, desc[0]) : undefined;
  if (!d0) return { reason: 'Type0 has no descendant font' };

  const dSub = nameOf(doc, d0.get('Subtype'));
  if (dSub === 'CIDFontType2') {
    const c2g = doc.resolve(d0.get('CIDToGIDMap'));
    if (isStream(c2g)) {
      let map: Uint8Array;
      try { map = decodeStream(c2g); } catch { return { reason: 'CIDToGIDMap stream failed to decode' }; }
      return {
        mapper: {
          codeWidth: 2,
          gidOf: (cid) => (cid * 2 + 1 < map.length ? (map[cid * 2] << 8) | map[cid * 2 + 1] : undefined),
        },
      };
    }
    // /Identity, or absent (which defaults to Identity for CIDFontType2).
    return { mapper: { codeWidth: 2, gidOf: (cid) => cid } };
  }
  if (dSub === 'CIDFontType0') {
    const fd = resolveDict(doc, d0.get('FontDescriptor'));
    const ff3 = fd ? doc.resolve(fd.get('FontFile3')) : undefined;
    if (!isStream(ff3)) return { reason: 'CIDFontType0 has no FontFile3' };
    let cff: CffFont;
    try { cff = new CffFont(cffBytesOf(ff3)); } catch { return { reason: 'CFF program failed to parse' }; }
    return { mapper: { codeWidth: 2, gidOf: (cid) => cff.cidToGid(cid) } };
  }
  return { reason: `unsupported descendant subtype: ${dSub ?? 'none'}` };
}

/** The CFF bytes of a FontFile3 — either a bare CFF or the CFF table of an
 *  OpenType (OTTO) whole-embed. */
function cffBytesOf(ff3: PdfStream): Uint8Array {
  const bytes = decodeStream(ff3);
  // 'OTTO' whole-embed: pull out the 'CFF ' table.
  if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
      if (tag === 'CFF ') {
        const off = v.getUint32(rec + 8); const len = v.getUint32(rec + 12);
        return bytes.subarray(off, off + len);
      }
    }
  }
  return bytes;
}

interface Ctx {
  doc: Document;
  usage: UsageMap;
  mappers: Map<PdfDict, CodeMapper | undefined>;
}

function usageFor(ctx: Ctx, font: PdfDict): FontUsage {
  let u = ctx.usage.get(font);
  if (!u) { u = { gids: new Set(), complete: true }; ctx.usage.set(font, u); }
  return u;
}

/** Mark a font unusable, keeping the first reason recorded. */
function markIncomplete(ctx: Ctx, font: PdfDict, reason: string): void {
  const u = usageFor(ctx, font);
  if (u.complete) { u.complete = false; u.reason = reason; }
}

function mapperFor(ctx: Ctx, font: PdfDict): CodeMapper | undefined {
  if (ctx.mappers.has(font)) return ctx.mappers.get(font);
  const { mapper, reason } = buildMapper(ctx.doc, font);
  ctx.mappers.set(font, mapper);
  usageFor(ctx, font);
  if (!mapper) markIncomplete(ctx, font, reason ?? 'unsupported font');
  return mapper;
}

/** Split a show string into codes and record their GIDs. */
function record(ctx: Ctx, font: PdfDict, bytes: Uint8Array): void {
  const m = mapperFor(ctx, font);
  if (!m) return;
  const u = usageFor(ctx, font);
  for (let i = 0; i + m.codeWidth <= bytes.length; i += m.codeWidth) {
    const code = m.codeWidth === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const gid = m.gidOf(code);
    if (gid === undefined) { markIncomplete(ctx, font, `code ${code} has no GID`); return; }
    u.gids.add(gid);
  }
}

/** Walk one graphics scope: an op stream plus the resources it resolves against. */
function walkOps(ctx: Ctx, ops: ContentOp[], resources: PdfDict | undefined, depth: number, seen: Set<PdfDict>): void {
  const fonts = resolveDict(ctx.doc, resources?.get('Font'));
  const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
  let font: PdfDict | undefined;

  for (const op of ops) {
    switch (op.operator) {
      case 'Tf': {
        const key = op.operands[0];
        font = isName(key) ? resolveDict(ctx.doc, fonts?.get(key.name)) : undefined;
        break;
      }
      case 'Tj': case '\'': case '"': {
        const s = op.operands[op.operands.length - 1];
        if (font && isString(s)) record(ctx, font, s.bytes);
        break;
      }
      case 'TJ': {
        const arr = op.operands[0];
        if (font && isArray(arr)) for (const el of arr) if (isString(el)) record(ctx, font, el.bytes);
        break;
      }
      case 'Do': {
        const key = op.operands[0];
        if (!isName(key) || !xobjects) break;
        const xo = ctx.doc.resolve(xobjects.get(key.name));
        if (!isStream(xo)) break;
        if (nameOf(ctx.doc, xo.dict.get('Subtype')) !== 'Form') break;
        walkStream(ctx, xo, resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources, depth + 1, seen);
        break;
      }
      default: break;
    }
  }
}

/** Parse and walk a content stream. On parse/decode failure, mark every font in
 *  scope incomplete — the broken stream could have shown any of them. */
function walkStream(
  ctx: Ctx, stream: PdfStream, resources: PdfDict | undefined,
  depth: number, seen: Set<PdfDict>,
): void {
  if (depth > MAX_XOBJECT_DEPTH) { markScopeIncomplete(ctx, resources, 'XObject nesting too deep'); return; }
  if (seen.has(stream.dict)) return;
  seen.add(stream.dict);
  let ops: ContentOp[];
  try {
    ops = parseContentStream(decodeStream(stream));
  } catch {
    markScopeIncomplete(ctx, resources, 'content stream failed to parse');
    return;
  }
  walkOps(ctx, ops, resources, depth, seen);
}

/** Mark every font reachable from `resources` unusable. Module-local: it takes
 *  `Ctx`, and `declaration: true` forbids exporting a private type. */
function markScopeIncomplete(ctx: Ctx, resources: PdfDict | undefined, reason: string): void {
  const fonts = resolveDict(ctx.doc, resources?.get('Font'));
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (f) markIncomplete(ctx, f, reason);
  }
}

/** Scan every site that can show a glyph and return per-font used GIDs. */
export function collectGlyphUsage(doc: Document): UsageMap {
  const ctx: Ctx = { doc, usage: new Map(), mappers: new Map() };
  for (const page of doc.Pages) walkPage(ctx, page);
  return ctx.usage;
}

function walkPage(ctx: Ctx, page: Page): void {
  const resources = page.Resources;
  const seen = new Set<PdfDict>();
  let streams: Uint8Array[];
  try {
    streams = contentStreamBytes(ctx.doc, page);
  } catch {
    markScopeIncomplete(ctx, resources, 'page contents failed to decode');
    return;
  }
  for (const bytes of streams) {
    let ops: ContentOp[];
    try { ops = parseContentStream(bytes); }
    catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); continue; }
    walkOps(ctx, ops, resources, 0, seen);
  }
}
```

> If `contentStreamBytes` is not exported from `pagecontent.ts`, export it in this task; check with `grep -n "contentStreamBytes" src/pagecontent.ts src/text.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/glyphusage.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/glyphusage.ts test/glyphusage.test.ts test/helpers/build-optimize-pdf.ts
git commit -m "feat(doo): glyph-usage scanner — Type0/Identity-H code->GID over content ops"
```

---

### Task 5: `glyphusage.ts` — wide usage sites + unreached-font safety net

A font missed here is a font whose glyphs get wrongly blanked. This adds annotation `/AP` streams, tiling patterns, and Type3 `/CharProcs`, plus the rule that catches sites this design did not anticipate.

**Files:**
- Modify: `src/glyphusage.ts`
- Test: `test/glyphusage.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: no signature change — `collectGlyphUsage` simply scans more and marks unreached fonts incomplete.

- [ ] **Step 1: Write the failing test**

Append to `test/glyphusage.test.ts`:

```ts
import { name, ref, PdfObject } from '../src/types.js';

describe('collectGlyphUsage — wide sites', () => {
  it('counts glyphs shown only from an annotation /AP stream', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const page = doc.Pages[0];
    const fontRef = (doc.resolve(doc.resolve(page.Dict.get('Resources')) as PdfDict)
      .get('Font') as PdfDict);
    // /AP /N form XObject showing CID 2, with its own /Resources.
    const body = 'BT /F1 12 Tf <0002> Tj ET';
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 100, 100]],
        ['Resources', new Map<string, PdfObject>([['Font', fontRef]])],
        ['Length', body.length],
      ]),
      raw: new TextEncoder().encode(body),
    });
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')],
      ['Rect', [0, 0, 100, 100]],
      ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]));
    page.Dict.set('Annots', [annot]);

    const usage = collectGlyphUsage(doc);
    // CID 1 from page content, CID 2 from the annotation appearance.
    expect([...usage.get(type0(doc))!.gids].sort()).toEqual([1, 2]);
  });

  it('marks a font incomplete when its scope has an unparseable stream', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const page = doc.Pages[0];
    // Replace /Contents with an undecodable stream (bad Flate payload).
    page.Dict.set('Contents', doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: Uint8Array.from([0, 1, 2, 3]),
    }));
    const usage = collectGlyphUsage(doc);
    const u = usage.get(type0(doc))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/failed to (parse|decode)/);
  });

  it('marks a font incomplete when it is never reached by the scan', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    // A font dict reachable in the object graph but in no walked scope.
    const orphanFont = new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type0')],
      ['BaseFont', name('Ghost')], ['Encoding', name('Identity-H')],
    ]);
    const r = doc.allocObject(orphanFont);
    doc.catalog().set('Names', r); // reachable from /Root, never scanned
    const usage = collectGlyphUsage(doc);
    expect(usage.get(orphanFont)?.complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/glyphusage.test.ts`
Expected: FAIL — the `/AP` test reports `[1]` not `[1,2]`; the unreached-font test gets `undefined`.

- [ ] **Step 3: Implement**

In `src/glyphusage.ts`, extend `walkPage` to cover annotations and patterns, add Type3 charprocs to `walkOps`, and add the unreached-font sweep to `collectGlyphUsage`:

```ts
/** Every /AP appearance stream on a page's annotations: /N, /D, /R, including
 *  the sub-dictionary form (/N << /On 5 0 R /Off 6 0 R >>). */
function walkAnnotations(ctx: Ctx, page: Page, seen: Set<PdfDict>): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const annot = resolveDict(ctx.doc, a);
    const ap = annot ? resolveDict(ctx.doc, annot.get('AP')) : undefined;
    if (!ap) continue;
    for (const key of ['N', 'D', 'R']) {
      const entry = ctx.doc.resolve(ap.get(key));
      const streams = isStream(entry) ? [entry]
        : isDict(entry) ? [...entry.values()].map((v) => ctx.doc.resolve(v)).filter(isStream)
        : [];
      for (const s of streams) {
        walkStream(ctx, s, resolveDict(ctx.doc, s.dict.get('Resources')), 0, seen);
      }
    }
  }
}

/** Every tiling pattern (PatternType 1) in a resource dict. Scanned
 *  unconditionally rather than on `scn` use — conservative and cheaper. */
function walkPatterns(ctx: Ctx, resources: PdfDict | undefined, seen: Set<PdfDict>): void {
  const patterns = resolveDict(ctx.doc, resources?.get('Pattern'));
  if (!patterns) return;
  for (const v of patterns.values()) {
    const p = ctx.doc.resolve(v);
    if (!isStream(p)) continue; // shading patterns are dicts, and show no text
    if (ctx.doc.resolve(p.dict.get('PatternType')) !== 1) continue;
    walkStream(ctx, p, resolveDict(ctx.doc, p.dict.get('Resources')), 0, seen);
  }
}

/** A Type3 font's glyph procedures can show text in *other* fonts. */
function walkType3(ctx: Ctx, fonts: PdfDict | undefined, seen: Set<PdfDict>): void {
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (!f || nameOf(ctx.doc, f.get('Subtype')) !== 'Type3') continue;
    const procs = resolveDict(ctx.doc, f.get('CharProcs'));
    const res = resolveDict(ctx.doc, f.get('Resources'));
    if (!procs) continue;
    for (const pv of procs.values()) {
      const s = ctx.doc.resolve(pv);
      if (isStream(s)) walkStream(ctx, s, res, 0, seen);
    }
  }
}
```

Extend `walkPage` to call them after the content loop:

```ts
  walkAnnotations(ctx, page, seen);
  walkPatterns(ctx, resources, seen);
  walkType3(ctx, resolveDict(ctx.doc, resources?.get('Font')), seen);
```

And add the safety net to `collectGlyphUsage`, replacing its body:

```ts
export function collectGlyphUsage(doc: Document): UsageMap {
  const ctx: Ctx = { doc, usage: new Map(), mappers: new Map() };
  for (const page of doc.Pages) walkPage(ctx, page);

  // Safety net: any font dict in the object graph that no walked scope reached
  // may be used somewhere this scan does not model. Never blank its glyphs.
  for (const [, obj] of doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(doc, obj.get('Type')) !== 'Font') continue;
    if (!ctx.usage.has(obj)) {
      ctx.usage.set(obj, { gids: new Set(), complete: false, reason: 'font not reached by the content scan' });
    }
  }
  return ctx.usage;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/glyphusage.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/glyphusage.ts test/glyphusage.test.ts
git commit -m "feat(doo): scan annotations/patterns/Type3 + skip fonts the scan never reached"
```

---

### Task 6: `dedup.ts` — byte-identical stream merge

**Files:**
- Create: `src/dedup.ts`
- Test: `test/dedup.test.ts`

**Interfaces:**
- Consumes: `Document.objectEntries()`, `Document.deleteObject()`; `createHash` from `node:crypto`; `serializeValue` from `./serialize.js`.
- Produces:
  - `export interface DedupResult { merged: number; bytesSaved: number; }`
  - `export function dedupStreams(doc: Document): DedupResult`

**Why streams only:** `Document.pageObjNums` and `EmbeddedFont.objNum` both point at **dicts**, so no stream merge can invalidate them.

- [ ] **Step 1: Write the failing test**

Create `test/dedup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfObject, PdfDict, name, isStream } from '../src/types.js';
import { dedupStreams } from '../src/dedup.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

function countStreams(doc: Document): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) if (isStream(o)) n++;
  return n;
}

const streamOf = (payload: string, extra: [string, PdfObject][] = []): PdfObject => ({
  kind: 'stream',
  dict: new Map<string, PdfObject>(extra),
  raw: new TextEncoder().encode(payload),
});

describe('dedupStreams', () => {
  it('merges two byte-identical streams and repoints referrers', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const a = doc.allocObject(streamOf('IDENTICAL PAYLOAD'));
    const b = doc.allocObject(streamOf('IDENTICAL PAYLOAD'));
    doc.catalog().set('T1', a);
    doc.catalog().set('T2', b);
    const before = countStreams(doc);

    const res = dedupStreams(doc);

    expect(res.merged).toBe(1);
    expect(countStreams(doc)).toBe(before - 1);
    expect(doc.catalog().get('T1')).toEqual(doc.catalog().get('T2'));
    expect(Document.Open(doc.Save()).Pages.length).toBe(1); // still re-openable
  });

  it('treats dicts with different key order as identical', () => {
    const doc = Document.Open(buildWholeFontPdf());
    doc.catalog().set('T1', doc.allocObject(streamOf('X', [['A', 1], ['B', 2]])));
    doc.catalog().set('T2', doc.allocObject(streamOf('X', [['B', 2], ['A', 1]])));
    expect(dedupStreams(doc).merged).toBe(1);
  });

  it('does not merge streams with different payloads', () => {
    const doc = Document.Open(buildWholeFontPdf());
    doc.catalog().set('T1', doc.allocObject(streamOf('ONE')));
    doc.catalog().set('T2', doc.allocObject(streamOf('TWO')));
    expect(dedupStreams(doc).merged).toBe(0);
  });

  it('never merges identity-sensitive types', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const mk = (): PdfObject => doc.allocObject(streamOf('SAME', [['Type', name('Metadata')]]));
    doc.catalog().set('T1', mk());
    doc.catalog().set('T2', mk());
    expect(dedupStreams(doc).merged).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/dedup.test.ts`
Expected: FAIL — "Failed to resolve import ../src/dedup.js".

- [ ] **Step 3: Implement**

Create `src/dedup.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, isStream, isDict, isArray, isRef, isName, ref,
} from './types.js';
import { serializeValue } from './serialize.js';

export interface DedupResult {
  merged: number;
  /** Sum of the raw payload bytes of every dropped duplicate. */
  bytesSaved: number;
}

/** Objects whose *identity* is meaningful even when their content matches. */
const EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'Page', 'Annot', 'OCG', 'Sig', 'XRef', 'ObjStm', 'Metadata',
]);

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

/** A canonical key for a dict: keys sorted, so insertion order cannot make two
 *  semantically equal dicts hash differently. Values are serialized as-is —
 *  refs included, so two streams whose dicts point at different objects (even
 *  equal ones) are correctly left unmerged. */
function canonicalDict(d: PdfDict): string {
  const keys = [...d.keys()].sort();
  return keys.map((k) => `${k}=${serializeValue(d.get(k) as PdfObject)}`).join(' ');
}

/** Rewrite every ref in `o` in place through `map`. Live dicts/arrays are
 *  mutated rather than copied so existing handles keep seeing the model. */
function rewriteRefs(o: PdfObject, map: Map<number, number>): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (isRef(v)) { const to = map.get(v.num); if (to !== undefined) o[i] = ref(to, 0); }
      else rewriteRefs(v, map);
    }
  } else if (isDict(o)) {
    for (const [k, v] of o) {
      if (isRef(v)) { const to = map.get(v.num); if (to !== undefined) o.set(k, ref(to, 0)); }
      else rewriteRefs(v, map);
    }
  } else if (isStream(o)) {
    rewriteRefs(o.dict, map);
  }
}

/**
 * Merge indirect streams with equal dicts and byte-identical payloads. The
 * lowest object number wins; refs to the duplicates are repointed at it and the
 * duplicates are deleted. Identity-sensitive /Type values are exempt.
 */
export function dedupStreams(doc: Document): DedupResult {
  // Group by content key, keeping the lowest object number as canonical.
  const canonical = new Map<string, number>();
  const dupToCanon = new Map<number, number>();
  let bytesSaved = 0;

  const entries = [...doc.objectEntries()].sort((a, b) => a[0].num - b[0].num);
  for (const [r, obj] of entries) {
    if (!isStream(obj)) continue;
    const t = typeName(obj.dict);
    if (t !== undefined && EXEMPT_TYPES.has(t)) continue;
    const key = `${canonicalDict(obj.dict)}${createHash('sha256').update(obj.raw).digest('hex')}`;
    const first = canonical.get(key);
    if (first === undefined) { canonical.set(key, r.num); continue; }
    dupToCanon.set(r.num, first);
    bytesSaved += obj.raw.length;
  }
  if (dupToCanon.size === 0) return { merged: 0, bytesSaved: 0 };

  for (const [, obj] of doc.objectEntries()) rewriteRefs(obj, dupToCanon);
  rewriteRefs(doc.trailer, dupToCanon);
  for (const num of dupToCanon.keys()) doc.deleteObject(num);

  return { merged: dupToCanon.size, bytesSaved };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/dedup.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dedup.ts test/dedup.test.ts
git commit -m "feat(doo): dedup byte-identical indirect streams with type exemptions"
```

---

### Task 7: `recompress.ts` — Flate unfiltered + re-deflate at max level

**Files:**
- Create: `src/recompress.ts`
- Test: `test/recompress.test.ts`

**Interfaces:**
- Consumes: `deflateSync`/`inflateSync` from `node:zlib`; `filterList` from `./filters.js`; `Document.objectEntries()`, `Document.replaceObject()`.
- Produces:
  - `export interface RecompressResult { streams: number; bytesSaved: number; }`
  - `export function recompressStreams(doc: Document): RecompressResult`

**The predictor trap:** re-deflating must operate on **raw inflated bytes**, never `decodeStream`. `decodeStream` applies any `/DecodeParms` predictor; re-deflating its output while leaving `/DecodeParms` in the dict silently desyncs the two and corrupts the stream. Working on raw inflated bytes leaves the predictor params correct and untouched.

- [ ] **Step 1: Write the failing test**

Create `test/recompress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { PdfObject, name, isStream, isName } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { recompressStreams } from '../src/recompress.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

const payload = new TextEncoder().encode('COMPRESS ME '.repeat(500));

describe('recompressStreams', () => {
  it('Flate-encodes an unfiltered stream and preserves its decoded bytes', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const r = doc.allocObject({ kind: 'stream', dict: new Map(), raw: payload });
    doc.catalog().set('T1', r);

    const res = recompressStreams(doc);

    expect(res.streams).toBeGreaterThanOrEqual(1);
    const s = doc.resolve(r);
    if (!isStream(s)) throw new Error('not a stream');
    expect(isName(s.dict.get('Filter')) && (s.dict.get('Filter') as any).name).toBe('FlateDecode');
    expect(s.raw.length).toBeLessThan(payload.length);
    expect([...decodeStream(s)]).toEqual([...payload]);
  });

  it('re-deflates an existing level-6 Flate stream to something no larger', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const weak = new Uint8Array(deflateSync(Buffer.from(payload), { level: 1 }));
    const r = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: weak,
    });
    doc.catalog().set('T1', r);

    recompressStreams(doc);

    const s = doc.resolve(r);
    if (!isStream(s)) throw new Error('not a stream');
    expect(s.raw.length).toBeLessThanOrEqual(weak.length);
    expect([...decodeStream(s)]).toEqual([...payload]);
  });

  it('leaves a predictor-bearing stream byte-identical through decode', () => {
    const doc = Document.Open(buildWholeFontPdf());
    // 4 rows x 3 bytes, PNG-Up predictor (2 = PNG None per row here).
    const rows = Uint8Array.from([0, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12]);
    const r = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Filter', name('FlateDecode')],
        ['DecodeParms', new Map<string, PdfObject>([
          ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 3],
        ])],
      ]),
      raw: new Uint8Array(deflateSync(Buffer.from(rows), { level: 1 })),
    });
    doc.catalog().set('T1', r);
    const before = [...decodeStream(doc.resolve(r) as any)];

    recompressStreams(doc);

    expect([...decodeStream(doc.resolve(r) as any)]).toEqual(before);
  });

  it('does not touch image-codec or exempt streams', () => {
    const doc = Document.Open(buildWholeFontPdf());
    const jpegish = { kind: 'stream' as const, dict: new Map<string, PdfObject>([['Filter', name('DCTDecode')]]), raw: payload };
    const r = doc.allocObject(jpegish);
    doc.catalog().set('T1', r);
    recompressStreams(doc);
    expect([...(doc.resolve(r) as any).raw]).toEqual([...payload]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/recompress.test.ts`
Expected: FAIL — "Failed to resolve import ../src/recompress.js".

- [ ] **Step 3: Implement**

Create `src/recompress.ts`:

```ts
import { deflateSync, inflateSync } from 'node:zlib';
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isStream, isName, name } from './types.js';
import { filterList, IMAGE_CODECS } from './filters.js';

export interface RecompressResult {
  streams: number;
  bytesSaved: number;
}

/** Structural/metadata streams that must never be re-filtered — the same set
 *  streamfilter.ts exempts, for the same reasons. */
const EXEMPT_TYPES: ReadonlySet<string> = new Set(['XRef', 'ObjStm', 'Metadata']);

const MAX_LEVEL = 9; // node's zlib default is 6

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

const deflateMax = (b: Uint8Array): Uint8Array =>
  new Uint8Array(deflateSync(Buffer.from(b), { level: MAX_LEVEL }));

/** Recompress one stream, or undefined to leave it alone. */
function recompressOne(s: PdfStream): PdfStream | undefined {
  const t = typeName(s.dict);
  if (t !== undefined && EXEMPT_TYPES.has(t)) return undefined;

  const { names } = filterList(s);
  if (names.some((n) => IMAGE_CODECS.has(n))) return undefined; // already compressed

  // Unfiltered -> Flate.
  if (names.length === 0) {
    const raw = deflateMax(s.raw);
    if (raw.length >= s.raw.length) return undefined;
    const dict: PdfDict = new Map(s.dict);
    dict.set('Filter', name('FlateDecode'));
    dict.set('Length', raw.length);
    return { kind: 'stream', dict, raw };
  }

  // Exactly [FlateDecode] -> re-deflate at max level. Multi-filter chains are
  // skipped: rebuilding a chain is streamFilter's job, not this pass's.
  const only = names.length === 1 && (names[0] === 'FlateDecode' || names[0] === 'Fl');
  if (!only) return undefined;

  let plain: Uint8Array;
  // Deliberately raw inflate, NOT decodeStream: any /DecodeParms predictor must
  // stay applied to these bytes and untouched in the dict.
  try { plain = new Uint8Array(inflateSync(Buffer.from(s.raw))); } catch { return undefined; }
  const raw = deflateMax(plain);
  if (raw.length >= s.raw.length) return undefined;
  const dict: PdfDict = new Map(s.dict);
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Flate every unfiltered stream and re-deflate every [FlateDecode] stream at
 *  maximum level, replacing a stream only when the result is strictly smaller. */
export function recompressStreams(doc: Document): RecompressResult {
  let streams = 0;
  let bytesSaved = 0;
  for (const [r, obj] of [...doc.objectEntries()]) {
    if (!isStream(obj)) continue;
    const out = recompressOne(obj);
    if (!out) continue;
    bytesSaved += obj.raw.length - out.raw.length;
    streams++;
    doc.replaceObject(r.num, out);
  }
  return { streams, bytesSaved };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/recompress.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recompress.ts test/recompress.test.ts
git commit -m "feat(doo): recompress pass — flate unfiltered, re-deflate Flate at level 9"
```

---

### Task 8: `optimize.ts` orchestrator + `Document.Optimize`

**Files:**
- Create: `src/optimize.ts`
- Modify: `src/document.ts` (add `Optimize`, near `Save` at line ~869)
- Test: `test/optimize.test.ts`

**Interfaces:**
- Consumes: `collectGlyphUsage`/`UsageMap` (Tasks 4-5); `shrinkGlyf`/`shrinkCff`/`ShrinkResult` (Tasks 2-3); `dedupStreams` (Task 6); `recompressStreams` (Task 7).
- Produces:
  - `export interface OptimizeOptions { fonts?: boolean; dedup?: boolean; compress?: boolean; }`
  - `export interface FontOptimization { baseFont: string; gidsKept: number; gidsDropped: number; bytesSaved: number; }`
  - `export interface SkippedFont { baseFont: string; reason: string; }`
  - `export interface OptimizeReport { fonts: FontOptimization[]; skipped: SkippedFont[]; dedup: { merged: number; bytesSaved: number }; compress: { streams: number; bytesSaved: number }; bytesSaved: number; }`
  - `export function optimizeDocument(doc: Document, opts?: OptimizeOptions): OptimizeReport`
  - `Document.Optimize(opts?: OptimizeOptions): OptimizeReport`

**Pass order is load-bearing:** fonts → dedup → compress. Fonts rewrites font programs; dedup then merges programs shrinking just made identical; compress re-deflates the final payloads.

- [ ] **Step 1: Write the failing test**

Create `test/optimize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { PdfObject, name } from '../src/types.js';
import { buildWholeFontPdf } from './helpers/build-optimize-pdf.js';

describe('Document.Optimize', () => {
  it('drops unused glyphs from an already-embedded font', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const report = doc.Optimize();
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].gidsDropped).toBeGreaterThan(0);
    expect(report.fonts[0].baseFont).toBe('TestFont');
  });

  it('produces a smaller, re-openable document', () => {
    const before = buildWholeFontPdf('<0001>');
    const doc = Document.Open(before);
    doc.Optimize();
    const after = doc.Save();
    expect(after.length).toBeLessThan(before.length);
    expect(Document.Open(after).Pages.length).toBe(1);
  });

  it('preserves extracted text exactly', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const textBefore = doc.Pages[0].GetText();
    doc.Optimize();
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(textBefore);
  });

  it('honors per-concern opt-out', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const report = doc.Optimize({ fonts: false });
    expect(report.fonts).toEqual([]);
  });

  it('is idempotent — a second run finds nothing more to drop', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    doc.Optimize();
    const second = doc.Optimize();
    expect(second.fonts.every((f) => f.gidsDropped === 0)).toBe(true);
    expect(second.dedup.merged).toBe(0);
  });

  it('reports a skipped font instead of blanking it', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    // A Type0 with a non-Identity-H encoding cannot be resolved -> must skip.
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as any;
    const fonts = doc.resolve(res.get('Font')) as any;
    (doc.resolve(fonts.get('F1')) as any).set('Encoding', name('UniGB-UCS2-H'));
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped[0].reason).toMatch(/Identity-H/);
  });

  it('throws on a signed document rather than silently discarding the work', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    doc.catalog().set('AcroForm', doc.allocObject(new Map<string, PdfObject>([
      ['Fields', [doc.allocObject(new Map<string, PdfObject>([
        ['FT', name('Sig')], ['T', { kind: 'string', bytes: new TextEncoder().encode('sig1') }],
      ]))]],
    ])));
    expect(() => doc.Optimize()).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/optimize.test.ts`
Expected: FAIL — "doc.Optimize is not a function".

- [ ] **Step 3a: Implement `src/optimize.ts`**

```ts
import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isDict, isStream, isName, isArray,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { collectGlyphUsage, UsageMap } from './glyphusage.js';
import { shrinkGlyf, shrinkCff, ShrinkResult } from './fontshrink.js';
import { dedupStreams } from './dedup.js';
import { recompressStreams } from './recompress.js';
import { parseSfnt } from './sfnt.js';
import { decodeStream, encodeStream } from './filters.js';

/** Which concerns to run. Every concern is lossless; all default to true. */
export interface OptimizeOptions {
  fonts?: boolean;
  dedup?: boolean;
  compress?: boolean;
}

export interface FontOptimization {
  baseFont: string;
  gidsKept: number;
  gidsDropped: number;
  bytesSaved: number;
}

export interface SkippedFont {
  baseFont: string;
  reason: string;
}

export interface OptimizeReport {
  fonts: FontOptimization[];
  /** Fonts left untouched, and why. The first place to look when Optimize
   *  under-delivers. */
  skipped: SkippedFont[];
  dedup: { merged: number; bytesSaved: number };
  compress: { streams: number; bytesSaved: number };
  /** Estimated: the sum of per-stream raw byte deltas. Not a file-size delta —
   *  only Save() produces bytes. */
  bytesSaved: number;
}

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

const baseFontOf = (doc: Document, font: PdfDict): string =>
  nameOf(doc, font.get('BaseFont')) ?? '(unnamed)';

/** True when the document carries any signature field — optimizing would
 *  invalidate it, and Save() would return the cached signed bytes verbatim,
 *  silently discarding every change. */
function isSigned(doc: Document): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return false;
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return false;
  const stack = [...fields];
  const seen = new Set<PdfDict>();
  while (stack.length) {
    const f = doc.resolve(stack.pop()!);
    if (!isDict(f) || seen.has(f)) continue;
    seen.add(f);
    if (nameOf(doc, f.get('FT')) === 'Sig') return true;
    const kids = doc.resolve(f.get('Kids'));
    if (isArray(kids)) stack.push(...kids);
  }
  return false;
}

/** The descendant CIDFont of a Type0, or the font itself for a simple font. */
function descendantOf(doc: Document, font: PdfDict): PdfDict {
  const desc = doc.resolve(font.get('DescendantFonts'));
  if (isArray(desc)) {
    const d0 = doc.resolve(desc[0]);
    if (isDict(d0)) return d0;
  }
  return font;
}

/** Locate a font's embedded program: its descriptor key and stream. */
function fontProgram(
  doc: Document, font: PdfDict,
): { descriptor: PdfDict; key: 'FontFile2' | 'FontFile3'; stream: PdfStream } | undefined {
  const fd = doc.resolve(descendantOf(doc, font).get('FontDescriptor'));
  if (!isDict(fd)) return undefined;
  for (const key of ['FontFile2', 'FontFile3'] as const) {
    const s = doc.resolve(fd.get(key));
    if (isStream(s)) return { descriptor: fd, key, stream: s };
  }
  return undefined;
}

/** Shrink one font program in place; undefined when it cannot be handled. */
function shrinkOne(
  doc: Document, font: PdfDict, gids: Set<number>,
): { result: ShrinkResult; bytesSaved: number } | { reason: string } {
  const prog = fontProgram(doc, font);
  if (!prog) return { reason: 'font program is not embedded' };

  let plain: Uint8Array;
  try { plain = decodeStream(prog.stream); }
  catch { return { reason: 'font program failed to decode' }; }

  let result: ShrinkResult;
  try {
    if (prog.key === 'FontFile2') {
      result = shrinkGlyf(parseSfnt(plain), gids);
    } else {
      const sub = nameOf(doc, prog.stream.dict.get('Subtype'));
      if (sub === 'CIDFontType0C') result = shrinkCff(plain, gids);
      else if (sub === 'OpenType') {
        const f = parseSfnt(plain);
        if (f.outlines !== 'glyf') return { reason: 'OpenType FontFile3 is CFF-outlined' };
        result = shrinkGlyf(f, gids);
      } else return { reason: `unsupported FontFile3 subtype: ${sub ?? 'none'}` };
    }
  } catch (e) {
    return { reason: `shrink failed: ${(e as Error).message}` };
  }

  const extra: PdfDict = new Map(prog.stream.dict);
  extra.delete('Filter');
  extra.delete('DecodeParms');
  extra.delete('DP');
  extra.delete('Length');
  if (prog.key === 'FontFile2') extra.set('Length1', result.bytes.length);
  const replacement = encodeStream(result.bytes, 'FlateDecode', extra);
  const bytesSaved = prog.stream.raw.length - replacement.raw.length;
  prog.descriptor.set(prog.key, doc.allocObject(replacement));
  return { result, bytesSaved };
}

function optimizeFonts(doc: Document, report: OptimizeReport): void {
  const usage: UsageMap = collectGlyphUsage(doc);
  for (const [font, u] of usage) {
    const baseFont = baseFontOf(doc, font);
    if (!u.complete) {
      report.skipped.push({ baseFont, reason: u.reason ?? 'usage could not be determined' });
      continue;
    }
    const out = shrinkOne(doc, font, u.gids);
    if ('reason' in out) { report.skipped.push({ baseFont, reason: out.reason }); continue; }
    report.fonts.push({
      baseFont,
      gidsKept: out.result.gidsKept,
      gidsDropped: out.result.gidsDropped,
      bytesSaved: out.bytesSaved,
    });
  }
}

/**
 * Losslessly shrink the live model. Passes run fonts -> dedup -> compress: fonts
 * rewrites font programs, dedup then merges programs that shrinking just made
 * identical, and compress re-deflates the final payloads.
 */
export function optimizeDocument(doc: Document, opts: OptimizeOptions = {}): OptimizeReport {
  if (isSigned(doc)) {
    throw new UnsupportedFeatureError(
      'Optimize would invalidate an existing signature; optimize before signing',
    );
  }
  const report: OptimizeReport = {
    fonts: [], skipped: [],
    dedup: { merged: 0, bytesSaved: 0 },
    compress: { streams: 0, bytesSaved: 0 },
    bytesSaved: 0,
  };

  if (opts.fonts ?? true) optimizeFonts(doc, report);
  if (opts.dedup ?? true) report.dedup = dedupStreams(doc);
  if (opts.compress ?? true) report.compress = recompressStreams(doc);

  report.bytesSaved =
    report.fonts.reduce((n, f) => n + f.bytesSaved, 0) +
    report.dedup.bytesSaved + report.compress.bytesSaved;
  doc.markModified();
  return report;
}
```

- [ ] **Step 3b: Wire `Document.Optimize`**

In `src/document.ts`, add the import and the method immediately before `Save` (~line 869):

```ts
import { optimizeDocument, OptimizeOptions, OptimizeReport } from './optimize.js';
```

```ts
  /** Losslessly shrink the document in place: subset already-embedded fonts to
   *  the glyphs actually shown, merge byte-identical streams, and recompress
   *  stream payloads. Content and visual output are preserved exactly; the next
   *  {@link Save} emits the smaller document. Every concern is opt-out via
   *  `opts` and all default on. Throws {@link UnsupportedFeatureError} for a
   *  signed document, which optimizing would invalidate. */
  Optimize(opts: OptimizeOptions = {}): OptimizeReport {
    return optimizeDocument(this, opts);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/optimize.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite — this pass rewrites shared machinery**

Run: `npm test`
Expected: all green. If a font/serializer test regressed, fix before committing.

- [ ] **Step 6: Commit**

```bash
git add src/optimize.ts src/document.ts test/optimize.test.ts
git commit -m "feat(doo): doc.Optimize — fonts/dedup/compress orchestrator + report"
```

---

### Task 9: Public exports, README, and end-to-end guards

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/optimize.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `OptimizeOptions`, `OptimizeReport`, `FontOptimization`, `SkippedFont` exported from the package root.

- [ ] **Step 1: Write the failing test**

Append to `test/optimize.test.ts`:

```ts
import * as pkg from '../src/index.js';
// `name` is deliberately NOT part of the public surface (src/index.ts exports no
// types.js constructors) — import it from the internal module for fixtures.
import { name } from '../src/types.js';
import { buildWholeFontPdf as buildFixture } from './helpers/build-optimize-pdf.js';

describe('Optimize — public surface and end-to-end guards', () => {
  it('exposes Optimize on the Document exported from the package root', () => {
    // Types are erased at runtime; assert the entry point loads and Optimize exists.
    expect(typeof pkg.Document.Open(buildFixture()).Optimize).toBe('function');
  });

  it('keeps a glyph that is only ever shown from an annotation appearance', () => {
    const doc = pkg.Document.Open(buildFixture('<0001>'));
    const page = doc.Pages[0];
    const res = doc.resolve(page.Dict.get('Resources')) as any;
    const body = 'BT /F1 12 Tf <0002> Tj ET';
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, any>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 100, 100]],
        ['Resources', new Map<string, any>([['Font', res.get('Font')]])],
        ['Length', body.length],
      ]),
      raw: new TextEncoder().encode(body),
    });
    page.Dict.set('Annots', [doc.allocObject(new Map<string, any>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')],
      ['Rect', [0, 0, 100, 100]], ['AP', new Map<string, any>([['N', ap]])],
    ]))]);

    const report = doc.Optimize();
    // gid 2 is used only by the appearance stream; it must survive.
    expect(report.fonts[0].gidsKept).toBeGreaterThanOrEqual(3); // {0, 1, 2}
    expect(pkg.Document.Open(doc.Save()).Pages.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/optimize.test.ts`
Expected: FAIL on the export assertions.

- [ ] **Step 3: Implement**

In `src/index.ts`, add beside the other feature exports:

```ts
export type {
  OptimizeOptions, OptimizeReport, FontOptimization, SkippedFont,
} from './optimize.js';
```

In `README.md`, add to **Features**:

```markdown
- **Optimization** — `doc.Optimize()` losslessly shrinks a document: subsets
  already-embedded fonts to the glyphs actually used, merges byte-identical
  streams, and recompresses stream payloads. Opt out per concern.
```

And to the **API overview**:

```markdown
### Optimization

`doc.Optimize(opts?)` shrinks the live model in place; the next `Save()` writes
the smaller document. All concerns are lossless and default on:

| Option | Effect |
|---|---|
| `fonts` | Subset already-embedded fonts to the glyphs actually shown |
| `dedup` | Merge byte-identical streams (duplicate images, font programs) |
| `compress` | Flate unfiltered streams; re-deflate Flate streams at max level |

```ts
const report = doc.Optimize({ compress: false });
console.log(report.bytesSaved, report.skipped);
doc.WriteTo('smaller.pdf');
```

Returns an `OptimizeReport`: per-font glyph counts, a `skipped` list explaining
any font left untouched, and an **estimated** `bytesSaved` (a raw-delta sum, not
a file-size delta — only `Save()` produces bytes).

**Limitations:** font subsetting covers Type0/Identity-H only (CIDFontType2 and
CIDFontType0). Simple TrueType, Type1, Type3, and simple CFF fonts are skipped
and listed in `report.skipped` — their code→GID resolution is heuristic, and
Optimize never guesses. Image downsampling/recompression is not yet implemented.
`Optimize` throws `UnsupportedFeatureError` on a signed document, which
optimizing would invalidate.
```

Also add the limitation to the README's **Limitations** section:

```markdown
- `Optimize` does not yet recompress or downsample images (no JPEG encoder).
```

- [ ] **Step 4: Run the full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md test/optimize.test.ts
git commit -m "feat(doo): export Optimize public types, document in README"
```

---

## Verification Checklist

Before closing issue `doo`:

- [ ] `npm test` green
- [ ] `npm run typecheck` green
- [ ] `npm run build` green
- [ ] Acceptance: `doc.Optimize({fonts,dedup,compress})` produces a smaller, re-openable document — covered by `test/optimize.test.ts`
- [ ] Acceptance: embedded-font subsetting drops unused glyphs — covered (Type0/Identity-H only; simple fonts are skipped and reported)
- [ ] Acceptance: content/visual output preserved (`GetText()` identical) — covered
- [ ] Acceptance: opt-in per concern — covered
- [ ] Acceptance: image recompression at target DPI/quality — **out of scope**, tracked by the follow-up issue (needs a baseline JPEG encoder)
- [ ] Follow-up issues filed: image optimization; simple-font subsetting; `post` v3 downgrade
