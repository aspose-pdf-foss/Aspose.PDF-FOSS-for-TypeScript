# Render-Time Font Substitution Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller hand the *renderer* font folders, so a non-embedded font
draws from an installed face instead of the bundled Standard-14 substitute.

**Architecture:** One new pure leaf, `src/fontsubst.ts`, decides which indexed
face substitutes for a font dict — by `/BaseFont` name through the existing
`matchChain`, then by Unicode coverage. It takes both its face list and its
`cmap` reader as **arguments**, so every rule is drivable from hand-built
records with no filesystem. `document.ts` owns a render folder list separate
from the authoring one; `raster.ts`'s `buildGlyphSource` consults it in the
branch `lqcs.1` already established for non-embedded fonts.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, `node:fs` only in
`fontsource.ts` and `document.ts`.

**Spec:** `docs/superpowers/specs/2026-09-11-render-font-substitution-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only. Do not add npm runtime deps.
- **ESM + NodeNext**, `strict` TypeScript. Import specifiers carry the `.js` extension (`import { X } from './y.js'`).
- **Nothing added by this plan throws.** `fontsubst.ts` and `peekCmap` degrade to `undefined`; one unreadable file in a system font folder must not break every lookup. (`errors.ts`'s three public error types are not used here.)
- **Opt-in is structural.** With no render folder registered the face list is empty, `resolveSubstitute` returns on its first line, and the bundled Standard-14 path runs exactly as today. Every existing render golden must stay green **unedited**.
- **`npm run typecheck` and `npm test` must both be green before the issue closes.** Target one file with `npx vitest run test/<name>.test.ts`.
- **`CHANGELOG.md`** gets an `## [Unreleased]` entry in the **same commit** as the user-visible change (Task 7).
- **`CLAUDE.md`** earns a Source-list entry for `fontsubst.ts` **when it lands** (Task 7). The Docs-section sweep must come back empty.
- **Issue tracking is `bd`**, never TodoWrite or markdown TODO lists. This work is `lqcs.2`; `lqcs.3` closes with it as folded in.
- **Every rule gets a mutation check.** Break the line, confirm the suite goes red, restore. A green suite on first run is not evidence.

---

### Task 1: `FontNames` carries the two OS/2 fields coverage scoring needs

**Files:**
- Modify: `src/fontnames.ts:11-28` (the `FontNames` interface), `src/fontnames.ts:110-130` (`namesFromTables`)
- Test: `test/fontnames.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FontNames.unicodeRange?: readonly [number, number, number, number]` and `FontNames.familyClass?: number`. Tasks 4 and 6 read both.

**Why this is free:** `namesFromTables` already receives the whole `OS/2`
slice and reads `usWeightClass` at offset 4 (`fontnames.ts:117`). Both new
fields come out of a buffer already in hand, so `fontsource.ts`'s partial-read
cost model is untouched — no extra I/O during indexing.

**Offsets, from the OpenType `OS/2` table:** `sFamilyClass` is an `int16` at
byte 30 whose **high byte** is the class; `ulUnicodeRange1..4` are `uint32` at
bytes 42, 46, 50, 54. A version-0 `OS/2` is 78 bytes and covers both.

- [ ] **Step 1: Write the failing tests**

Add to `test/fontnames.test.ts`. It already imports from `../src/fontnames.js`;
add `buildNameRecords` from `./helpers/build-sfnt.js` if it is not imported yet.

```ts
describe('FontNames OS/2 coverage fields', () => {
  const nameTable = () => buildNameRecords([
    { plat: 3, nameID: 1, text: 'Probe Sans' },
    { plat: 3, nameID: 2, text: 'Regular' },
  ]);

  it('reads sFamilyClass and ulUnicodeRange1..4 from OS/2', () => {
    const os2 = new Uint8Array(78);
    const v = new DataView(os2.buffer);
    v.setUint16(4, 400);          // usWeightClass, the field already read
    v.setInt16(30, 0x0805);       // sFamilyClass: class 8 (sans serif), subclass 5
    v.setUint32(42, 0x00000001);  // ulUnicodeRange1: bit 0, Basic Latin
    v.setUint32(46, 0x00020000);  // ulUnicodeRange2
    v.setUint32(50, 0x08000000);  // ulUnicodeRange3: bit 59, CJK Unified Ideographs
    v.setUint32(54, 0x00000004);  // ulUnicodeRange4

    const n = namesFromTables({ name: nameTable(), os2 })!;
    expect(n.familyClass).toBe(8);
    expect(n.unicodeRange).toEqual([0x00000001, 0x00020000, 0x08000000, 0x00000004]);
  });

  // The guard, and it needs its OWN case: a 96-byte buildOS2() covers both
  // fields, so every other fixture in the suite passes with the guards deleted.
  it('leaves both undefined when OS/2 is too short to state them', () => {
    const os2 = new Uint8Array(31);            // usWeightClass yes, sFamilyClass no
    new DataView(os2.buffer).setUint16(4, 700);

    const n = namesFromTables({ name: nameTable(), os2 })!;
    expect(n.weight).toBe(700);                // the existing field still reads
    expect(n.familyClass).toBeUndefined();
    expect(n.unicodeRange).toBeUndefined();
  });

  it('leaves both undefined when OS/2 is absent entirely', () => {
    const n = namesFromTables({ name: nameTable() })!;
    expect(n.familyClass).toBeUndefined();
    expect(n.unicodeRange).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/fontnames.test.ts`
Expected: FAIL — `familyClass` and `unicodeRange` are `undefined` in the first
case (the property does not exist yet).

- [ ] **Step 3: Add the fields to the interface**

In `src/fontnames.ts`, inside `export interface FontNames`, after `weight`:

```ts
  /** `OS/2.ulUnicodeRange1..4`. Undefined when the table is absent or too
   *  short to state them.
   *
   *  A PRE-FILTER and never a decision: it is the producer's claim about its
   *  own font and is routinely optimistic, so `fontsubst.ts` uses it to select
   *  candidates and confirms every one against the real `cmap`. */
  unicodeRange?: readonly [number, number, number, number];
  /** `OS/2.sFamilyClass`'s HIGH BYTE -- the class, without its subclass: 1..7
   *  are the serif families, 8 sans serif, 0 unclassified. Undefined when the
   *  table is absent or too short. */
  familyClass?: number;
```

- [ ] **Step 4: Read them in `namesFromTables`**

In `src/fontnames.ts`, beside the existing `weight` line (`fontnames.ts:117`):

```ts
  const weight = t.os2 && t.os2.length >= 6 ? u16(t.os2, 4) || 400 : 400;
  // Each field needs its OWN length guard: a truncated OS/2 that still states
  // usWeightClass must not be read past its end.
  const familyClass = t.os2 && t.os2.length >= 32 ? t.os2[30] : undefined;
  const unicodeRange: readonly [number, number, number, number] | undefined =
    t.os2 && t.os2.length >= 58
      ? [u32(t.os2, 42), u32(t.os2, 46), u32(t.os2, 50), u32(t.os2, 54)]
      : undefined;
```

and add `familyClass` and `unicodeRange` to the returned object literal.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/fontnames.test.ts test/fontsource.test.ts test/sfnt.test.ts`
Expected: PASS. `fontsource.test.ts` and `sfnt.test.ts` are the fence — they
are the other consumers of `namesFromTables` and must pass **unedited**.

- [ ] **Step 6: Mutation-check both guards**

Change `t.os2.length >= 32` to `>= 6`, run `npx vitest run test/fontnames.test.ts`,
confirm the too-short case goes RED, restore. Repeat for `>= 58`.

- [ ] **Step 7: Commit**

```bash
git add src/fontnames.ts test/fontnames.test.ts
git commit -m "feat(lqcs.2): read ulUnicodeRange and sFamilyClass into FontNames

Both come out of the OS/2 slice namesFromTables already holds for
usWeightClass, so indexing pays no extra I/O. Each gets its own length
guard: a truncated table that still states usWeightClass must not be
read past its end.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `peekCmap` — confirm a candidate's real coverage with a partial read

**Files:**
- Modify: `src/sfnt.ts:315` (export `readCmap`), `src/fontsource.ts:126-186` (extract the face walk, add `peekCmap`)
- Modify: `test/helpers/build-sfnt.ts:849` (`buildNamedFont` gains `cmap`, `unicodeRange`, `familyClass`)
- Test: `test/fontsource.test.ts`

**Interfaces:**
- Consumes: `FontNames` from Task 1.
- Produces: `peekCmap(path: string, faceIndex?: number): Set<number> | undefined` exported from `src/fontsource.ts`. Task 6 passes it into `resolveSubstitute`.
- Produces: `buildNamedFont(opts)` gains `cmap?: [number, number][]`, `unicodeRange?: [number, number, number, number]`, `familyClass?: number`. Tasks 4 and 7 use all three.

**Why a set of code points and not the map:** the gids in a face's `cmap` are
that FACE's, and the caller never uses them — at draw time `raster.ts` looks a
code point up in its own parsed `SfntFont`. Returning coverage alone is the
honest contract.

**Why the walk is extracted:** `peekNames` and `peekCmap` must not disagree
about where face N of a `.ttc` or `.dfont` begins. A second copy of that walk
is how an index and a confirm come to describe different faces of one file.

- [ ] **Step 1: Extend the test-font builder**

In `test/helpers/build-sfnt.ts`, widen `buildNamedFont`'s options and use them:

```ts
export function buildNamedFont(opts: {
  family: string; subfamily?: string;
  typographicFamily?: string;
  bold?: boolean; italic?: boolean; weight?: number;
  padGlyf?: number;
  /** Code point -> gid. Default: buildCmap()'s 0x41->1, 0x42->2. */
  cmap?: [number, number][];
  /** OS/2.ulUnicodeRange1..4. Default: all zero. */
  unicodeRange?: [number, number, number, number];
  /** OS/2.sFamilyClass high byte. Default: 0 (unclassified). */
  familyClass?: number;
}): Uint8Array {
```

Inside, after the existing `os2` weight write, add:

```ts
  const os2v = new DataView(os2.buffer, os2.byteOffset);
  if (opts.familyClass !== undefined) os2v.setUint16(30, opts.familyClass << 8);
  if (opts.unicodeRange) {
    os2v.setUint32(42, opts.unicodeRange[0]); os2v.setUint32(46, opts.unicodeRange[1]);
    os2v.setUint32(50, opts.unicodeRange[2]); os2v.setUint32(54, opts.unicodeRange[3]);
  }
```

and replace the `cmap` table entry with:

```ts
    { tag: 'cmap', data: opts.cmap ? buildCmapTable([{ plat: 3, enc: 1, data: cmapFormat4(opts.cmap) }]) : buildCmap() },
```

`buildOS2()` returns 96 bytes, so offsets 30 and 42..57 are in range. Every
existing caller passes none of the three and is byte-identical.

- [ ] **Step 2: Write the failing tests**

Add to `test/fontsource.test.ts`, which already defines `folderWith` at line 32
and imports `join` from `node:path`:

```ts
describe('peekCmap', () => {
  it('reports the code points a face actually covers', () => {
    const dir = folderWith({ 'cjk.ttf': buildNamedFont({
      family: 'Probe CJK', cmap: [[0x41, 1], [0x4e00, 1], [0x4e8c, 1]],
    }) });
    const cov = peekCmap(join(dir, 'cjk.ttf'))!;
    expect(cov.has(0x4e00)).toBe(true);
    expect(cov.has(0x4e8c)).toBe(true);
    expect(cov.has(0x3042)).toBe(false);   // hiragana A, not in this face
  });

  // The reason the walk is extracted rather than copied: a path-only or
  // index-blind read hands back face 0 for every face of a collection.
  it('reads the named face of a collection, not face 0', () => {
    const a = buildNamedFont({ family: 'Coll A', cmap: [[0x41, 1]] });
    const b = buildNamedFont({ family: 'Coll B', cmap: [[0x4e00, 1]] });
    const dir = folderWith({ 'c.ttc': buildTtc([a, b]) });
    expect(peekCmap(join(dir, 'c.ttc'), 0)!.has(0x41)).toBe(true);
    expect(peekCmap(join(dir, 'c.ttc'), 0)!.has(0x4e00)).toBe(false);
    expect(peekCmap(join(dir, 'c.ttc'), 1)!.has(0x4e00)).toBe(true);
  });

  it('returns undefined rather than throwing for a missing or junk file', () => {
    const dir = folderWith({ 'junk.ttf': new Uint8Array([1, 2, 3, 4]) });
    expect(peekCmap(join(dir, 'junk.ttf'))).toBeUndefined();
    expect(peekCmap(join(dir, 'absent.ttf'))).toBeUndefined();
  });

  it('returns undefined for a face index the file does not have', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha' }) });
    expect(peekCmap(join(dir, 'a.ttf'), 3)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/fontsource.test.ts`
Expected: FAIL — `peekCmap is not a function` / not exported.

- [ ] **Step 4: Export `readCmap` from `sfnt.ts`**

`src/sfnt.ts:315`: change `function readCmap(` to `export function readCmap(`
and add above it:

```ts
/** A `cmap` table's best Unicode subtable as code point -> gid.
 *
 *  Exported so `fontsource.ts`'s `peekCmap` reads a candidate face's coverage
 *  through THIS parser rather than a second one written beside it -- the rule
 *  `cidcmap.ts` already follows for the bundled CMaps and a document's own. */
```

- [ ] **Step 5: Extract the face walk in `fontsource.ts`**

Replace the body of `peekNames`'s sfnt half with a generic walk. Keep the
Type 1 early-return branch exactly where it is.

```ts
/**
 * Walk one open file's faces, handing each a `table(tag)` reader over ITS OWN
 * directory, and keep whatever `pick` returns.
 *
 * **Invariant: ONE owner for "where does face N begin".** `peekNames` and
 * `peekCmap` must not disagree about it -- a second walk is how an index and a
 * coverage confirm come to describe different faces of one `.ttc`.
 */
function eachFace<T>(
  fd: number,
  pick: (table: (tag: string) => Uint8Array | undefined, faceIndex: number) => T | undefined,
): { faceIndex: number; value: T }[] {
  const faceAt = (dirOffset: number, base: number, faceIndex: number): T | undefined => {
    const head12 = readAt(fd, dirOffset, 12);
    if (head12.length < 12) return undefined;
    const numTables = (head12[4] << 8) | head12[5];
    if (numTables === 0 || numTables > 512) return undefined;
    const dir = parseTableDirectory(readAt(fd, dirOffset, 12 + numTables * 16));
    if (!dir) return undefined;
    const table = (tag: string): Uint8Array | undefined => {
      const r = dir.get(tag);
      if (!r || r.length === 0 || r.length > 4 * 1024 * 1024) return undefined;
      // A collection's table offsets are absolute into the FILE, so with
      // `base` 0 this is the same read whether the face stands alone or shares
      // a container. A `.dfont`'s are relative to its resource, which is the
      // one caller that passes a non-zero base.
      const b = readAt(fd, base + r.offset, r.length);
      return b.length === r.length ? b : undefined;
    };
    return pick(table, faceIndex);
  };

  const out: { faceIndex: number; value: T }[] = [];
  const push = (i: number, v: T | undefined) => { if (v !== undefined) out.push({ faceIndex: i, value: v }); };

  const offsets = ttcFaceOffsets(readAt(fd, 0, 4096));
  if (offsets) {
    for (let i = 0; i < offsets.length; i++) push(i, faceAt(offsets[i], 0, i));
    return out;
  }
  const dfont = dfontSfntRanges((o, l) => readAt(fd, o, l), fstatSync(fd).size);
  if (dfont) {
    for (let i = 0; i < dfont.length; i++) push(i, faceAt(dfont[i].offset, dfont[i].offset, i));
    return out;
  }
  push(0, faceAt(0, 0, 0));
  return out;
}
```

Then `peekNames`'s sfnt half becomes:

```ts
    return eachFace(fd, (table) =>
      namesFromTables({ name: table('name'), head: table('head'), os2: table('OS/2') }))
      .map(({ faceIndex, value }) => ({ faceIndex, names: value }));
```

- [ ] **Step 6: Add `peekCmap`**

At the end of `src/fontsource.ts`:

```ts
/**
 * The Unicode code points one face's `cmap` covers.
 *
 * A SECOND partial read: the table directory, then the `cmap` range, and
 * nothing else -- so confirming a candidate costs roughly what indexing it did
 * rather than reading a 20 MB CJK font. `undefined` for a file that will not
 * open, a face index the file does not have, or a face carrying no `cmap`.
 *
 * It exists because `OS/2.ulUnicodeRange` is the PRODUCER'S CLAIM about its
 * own font and is routinely optimistic: that field selects candidates, and
 * this decides between them. Never throws.
 *
 * **Note a Type 1 face has no `cmap` and so answers `undefined`.** That is
 * correct rather than a gap: such a face can still win on NAME, and a
 * coverage score for a format that states no Unicode mapping would be
 * invented. The consequence is real and deliberate -- a `.pfb` in a render
 * folder is reachable by name and never by coverage.
 */
export function peekCmap(path: string, faceIndex = 0): Set<number> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const hit = eachFace(fd, (table, i) => (i === faceIndex ? table('cmap') : undefined))[0];
    if (!hit) return undefined;
    // The gids are the FACE's and mean nothing to the caller, which resolves a
    // code point through its own parsed SfntFont at draw time. Coverage alone
    // is the honest contract.
    return new Set(readCmap(hit.value).keys());
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}
```

Add `readCmap` to the `./sfnt.js` import in `fontsource.ts`. **Check the import
does not close a cycle:** `sfnt.ts` must not value-import `fontsource.ts`.
Confirm in Step 8.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/fontsource.test.ts test/font-byname.test.ts test/sfnt.test.ts test/ttc.test.ts test/dfont.test.ts`
Expected: PASS. All but `fontsource.test.ts` must pass **unedited** — they are
the fence proving the walk extraction moved nothing.

- [ ] **Step 8: Check for an import cycle and mutation-check the face index**

```bash
npx vitest run test/import-cycles.test.ts
```
Expected: PASS (no new 2-cycle).

Then change `i === faceIndex` to `i === 0`, run
`npx vitest run test/fontsource.test.ts`, confirm the collection case goes RED,
restore.

- [ ] **Step 9: Commit**

```bash
git add src/sfnt.ts src/fontsource.ts test/helpers/build-sfnt.ts test/fontsource.test.ts
git commit -m "feat(lqcs.2): peekCmap, a partial-read coverage confirm

ulUnicodeRange is the producer's claim about its own font and is
routinely optimistic, so it selects candidates and this decides. The
face walk is EXTRACTED rather than copied: peekNames and peekCmap must
not disagree about where face N of a .ttc or .dfont begins.

Returns code points, not the cmap's gids -- those are the face's and the
caller resolves through its own parsed SfntFont at draw time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `fontsubst.ts` — what code points a font dict can emit

**Files:**
- Create: `src/fontsubst.ts`
- Modify: `src/font.ts:562` (export `cidSystemOrdering`)
- Modify: `test/helpers/build-text-pdf.ts:61` (`buildType0Pdf` gains an options object; `fontDictOf` added)
- Test: `test/fontsubst.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces:
  - `WANTED_CAP: number`, `CID_PROBE_LIMIT: number`, `CID_PROBE_STEP: number`
  - `wantedCodepoints(dict: PdfDict, resolve: (o: PdfObject | undefined) => PdfObject | undefined, inflate: (s: PdfStream) => Uint8Array): Set<number>`
  - `cidSystemOrdering(dict: PdfDict, resolve: Resolve): string | undefined` — newly exported from `src/font.ts`
  - `buildType0Pdf(stream: string, cmap: string, opts?: { baseFont?: string; ordering?: string; toUnicode?: boolean }): Uint8Array` — the widened test builder, used by Tasks 6 and 7
  - `fontDictOf(doc: Document): PdfDict` — exported from `test/helpers/build-text-pdf.ts`, imported by Tasks 6 and 7
- Task 4 adds `resolveSubstitute` to the same file; Task 6 calls both.

**Three sources, in order, and the second one's mechanism is the trap:**
`CMap.entries()` exists (`cmap.ts:11`) so `/ToUnicode` enumerates outright, but
`CidToUnicode` exposes **`lookup(cid)` and nothing else** — there is no
enumeration. That set is therefore *probed*, which is sufficient because the
score is a fraction rather than a census, and it leaves `cidunicode.ts`
untouched instead of widening a public interface for one consumer.

**Why the probe step is prime:** Adobe-Japan1's CIDs are grouped by kind —
1..230 are proportional Latin — so a small step would sample Latin and report
that a Latin-only face covers a Japanese font. A prime step spans the whole
collection instead.

- [ ] **Step 1: Widen the existing Type0 fixture builder**

`buildType0Pdf` (`test/helpers/build-text-pdf.ts:61`) hardcodes
`/BaseFont /AAAAAA+Foo`, `/Ordering (Identity)` and a `/ToUnicode`. Tasks 3, 6
and 7 need all three varied. Widen it with an options object whose **defaults
reproduce today's strings exactly**, so every existing caller is byte-identical:

```ts
export function buildType0Pdf(
  stream: string, cmap: string,
  opts: { baseFont?: string; ordering?: string; toUnicode?: boolean } = {},
): Uint8Array {
  const base = opts.baseFont ?? 'AAAAAA+Foo';
  const ordering = opts.ordering ?? 'Identity';
  const tu = opts.toUnicode === false ? '' : ' /ToUnicode 6 0 R';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [7 0 R]${tu} >>`,
    6: contentObj(cmap),
    7: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 0 >> >>`,
  };
  return serialize(objects, 7);
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/fontsubst.test.ts`. Fixtures are built through the real PDF
builders and opened, rather than from hand-made dicts — that is how
`test/type0-substitute.test.ts` reaches a font dict and it keeps the fixture
honest about what a document actually carries.

Add `fontDictOf` to `test/helpers/build-text-pdf.ts`, beside the builders whose
output it reads back — **not** to a `.test.ts` file, which two other suites
would then have to import from:

```ts
/** The /F1 font dict of a fixture built by this module, opened and resolved. */
export function fontDictOf(doc: Document): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  if (!isDict(fonts)) throw new Error('fixture has no /Font');
  const f1 = doc.resolve(fonts.get('F1'));
  if (!isDict(f1)) throw new Error('fixture has no /F1');
  return f1;
}
```

Then `test/fontsubst.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject, PdfStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';
import { wantedCodepoints, WANTED_CAP } from '../src/fontsubst.js';
import { buildType0Pdf, buildSimpleTextPdf, fontDictOf } from './helpers/build-text-pdf.js';

/** The resolve/inflate pair raster.ts hands `wantedCodepoints`. */
const rs = (doc: Document) => (o: PdfObject | undefined) => doc.resolve(o);
const inf = (s: PdfStream) => inflateStream(s as Parameters<typeof inflateStream>[0]);

/** A /ToUnicode CMap mapping one CID range to a run of code points.
 *
 *  `test/type0-substitute.test.ts:25` has its own copy and keeps it. Nine lines
 *  of string building that cannot drift silently — a wrong CMap fails that
 *  file's own cases immediately — which is the reasoning CLAUDE.md already
 *  records for `measuringDriverFor` living in two places. */
const bfrange = (loCid: number, hiCid: number, loUni: number) =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n`
  + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n`
  + `1 beginbfrange <${loCid.toString(16).padStart(4, '0')}> `
  + `<${hiCid.toString(16).padStart(4, '0')}> `
  + `<${loUni.toString(16).padStart(4, '0')}> endbfrange\n`
  + `endcmap end end`;

const SHOW = 'BT /F1 48 Tf 20 100 Td <00410042> Tj ET';

describe('wantedCodepoints', () => {
  it("takes a simple font's set from its encoding", () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 48 Tf 20 100 Td (AB) Tj ET'));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.has(0x41)).toBe(true);        // 'A', WinAnsi
    expect(got.has(0x4e00)).toBe(false);     // no CJK from a Latin encoding
  });

  it('takes a composite font\'s set from /ToUnicode when it has one', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, bfrange(0x41, 0x42, 0x4e00)));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.has(0x4e00)).toBe(true);
    expect(got.has(0x4e01)).toBe(true);
  });

  it('probes the collection table for a composite font with no /ToUnicode', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '',
      { baseFont: 'KozMinPr6N-Regular', ordering: 'Japan1', toUnicode: false }));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.size).toBeGreaterThan(32);
    // The point of the PRIME step: the sample must reach past Japan1's
    // proportional-Latin CIDs (1..230) into the kanji, or a Latin-only face
    // would score 1.0 against a Japanese document.
    expect([...got].filter((cp) => cp >= 0x3000).length).toBeGreaterThan(16);
  });

  it('never exceeds WANTED_CAP', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '',
      { ordering: 'Japan1', toUnicode: false }));
    expect(wantedCodepoints(fontDictOf(doc), rs(doc), inf).size)
      .toBeLessThanOrEqual(WANTED_CAP);
  });

  it('returns an empty set for an Identity ordering, which has no characters', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '', { toUnicode: false }));
    expect(wantedCodepoints(fontDictOf(doc), rs(doc), inf).size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/fontsubst.test.ts`
Expected: FAIL — cannot resolve `../src/fontsubst.js`.

- [ ] **Step 4: Export `cidSystemOrdering` from `font.ts`**

`src/font.ts:562`: change `function cidSystemOrdering(` to
`export function cidSystemOrdering(` and add above it:

```ts
/** The `/CIDSystemInfo /Ordering` of a composite font's DESCENDANT, or
 *  undefined when it states none or names a registry other than Adobe.
 *
 *  Exported for `fontsubst.ts`, which needs the same answer to find the
 *  collection a non-embedded composite font belongs to. The registry test is
 *  load-bearing and must not be re-derived: a private collection may call its
 *  ordering `Japan1` and number its CIDs however it likes. */
```

- [ ] **Step 5: Write `src/fontsubst.ts`**

```ts
/**
 * Which INSTALLED face substitutes for a font dict the document did not embed
 * (`lqcs.2`).
 *
 * **Invariant: a pure leaf that takes its faces as an ARGUMENT.** It receives a
 * `FaceRecord[]` and a `cmap` reader, never a `Document` and never a path, so
 * every resolution rule is drivable from hand-built records with no PDF built,
 * no folder registered and no filesystem touched -- the seam `colorimage.ts`
 * takes `resolve`/`inflate` through. It never throws.
 */
import { PdfDict, PdfObject, PdfStream, isStream, isName } from './types.js';
import { parseCMap } from './cmap.js';
import { getCidToUnicode } from './cidunicode.js';
import { cidSystemOrdering, resolveSimpleEncoding, type FontStyle } from './font.js';

type Resolve = (o: PdfObject | undefined) => PdfObject | undefined;
type Inflate = (s: PdfStream) => Uint8Array;

/** How many code points a coverage score is taken over. The score is a
 *  FRACTION rather than a census, so past a sample the answer stops improving
 *  and only the cost grows. */
export const WANTED_CAP = 256;
/** How far into a collection the CID probe walks. */
export const CID_PROBE_LIMIT = 20000;
/** PRIME, and that is the whole point: a collection's CIDs are grouped by kind
 *  -- Adobe-Japan1's 1..230 are proportional Latin -- so a step sharing a
 *  factor with that structure samples one region and reports that a Latin-only
 *  face covers a Japanese font. */
export const CID_PROBE_STEP = 61;

/**
 * The code points this font dict can emit, bounded to {@link WANTED_CAP}.
 *
 * Three sources in order, and the second one's mechanism is the trap:
 * `CMap.entries()` enumerates a `/ToUnicode` outright, but `CidToUnicode`
 * exposes `lookup(cid)` and NOTHING else, so a collection's set is PROBED
 * rather than iterated. That leaves `cidunicode.ts` untouched instead of
 * widening a public interface for one consumer.
 *
 * Empty is a real answer: a composite font with an `Identity` ordering and no
 * `/ToUnicode` states no characters at all, so no coverage score is possible
 * and the caller keeps its placeholder boxes.
 */
export function wantedCodepoints(dict: PdfDict, resolve: Resolve, inflate: Inflate): Set<number> {
  const out = new Set<number>();
  const add = (s: string | undefined): void => {
    if (!s) return;
    const cp = s.codePointAt(0);
    if (cp !== undefined) out.add(cp);
  };

  // 1. /ToUnicode -- the font's own statement, and the only enumerable source.
  const tu = resolve(dict.get('ToUnicode'));
  if (isStream(tu)) {
    try {
      for (const [, text] of parseCMap(inflate(tu)).entries()) {
        add(text);
        if (out.size >= WANTED_CAP) return out;
      }
    } catch { /* a damaged /ToUnicode costs its own contribution, not the font */ }
  }
  if (out.size > 0) return out;

  // 2. A composite font's character collection.
  const ordering = cidSystemOrdering(dict, resolve);
  const table = ordering ? getCidToUnicode(ordering) : undefined;
  if (table) {
    for (let cid = 1; cid <= CID_PROBE_LIMIT && out.size < WANTED_CAP; cid += CID_PROBE_STEP) {
      add(table.lookup(cid));
    }
    return out;
  }

  // 3. A simple font: its encoding already answers code -> Unicode.
  const sub = resolve(dict.get('Subtype'));
  if (!(isName(sub) && sub.name === 'Type0')) {
    for (const s of resolveSimpleEncoding(dict, resolve).unicode) {
      add(s);
      if (out.size >= WANTED_CAP) break;
    }
  }
  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/fontsubst.test.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 7: Mutation-check the probe step and the cap**

Change `CID_PROBE_STEP` to `1`, run `npx vitest run test/fontsubst.test.ts`,
confirm the "reaches past the proportional Latin" assertion goes RED, restore.
Then remove the `out.size >= WANTED_CAP` bound in the CID loop, confirm the cap
case goes RED, restore.

- [ ] **Step 8: Check for an import cycle**

```bash
npx vitest run test/import-cycles.test.ts
```
Expected: PASS. `font.ts` must not value-import `fontsubst.ts`.

- [ ] **Step 9: Commit**

```bash
git add src/fontsubst.ts src/font.ts test/fontsubst.test.ts test/helpers/build-text-pdf.ts
git commit -m "feat(lqcs.2): fontsubst.ts, the code points a font dict can emit

CidToUnicode exposes lookup() alone with no enumeration, so a
collection's set is PROBED rather than iterated -- sufficient for a
fraction, and it leaves cidunicode.ts untouched. The probe step is prime
because Adobe-Japan1's CIDs 1..230 are proportional Latin: a step
sharing a factor with that structure samples one region and would report
that a Latin-only face covers a Japanese font.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `resolveSubstitute` — name, then coverage

**Files:**
- Modify: `src/fontsubst.ts`
- Test: `test/fontsubst.test.ts`

**Interfaces:**
- Consumes: `FontNames.unicodeRange` / `.familyClass` (Task 1); `wantedCodepoints` (Task 3).
- Produces:
  - `interface SubstRequest { baseFont: string; style: FontStyle; wanted: ReadonlySet<number>; serif: boolean }`
  - `interface SubstMatch { face: FaceRecord; rung: 'name' | 'coverage' }`
  - `resolveSubstitute(faces: readonly FaceRecord[], req: SubstRequest, cmapOf: (face: FaceRecord) => ReadonlySet<number> | undefined): SubstMatch | undefined`
  - `CONFIRM_CAP: number`, `MIN_COVERAGE: number`
- Task 6 calls `resolveSubstitute` with `cmapOf = (f) => peekCmap(f.path, f.faceIndex)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/fontsubst.test.ts`. Note the three fixture shapes are chosen so
each rule is *falsifiable* — the obvious fixture measures nothing.

```ts
import { resolveSubstitute } from '../src/fontsubst.js';
import type { FaceRecord } from '../src/fontsource.js';

const face = (family: string, extra: Partial<FaceRecord['names']> = {}, i = 0): FaceRecord => ({
  path: `/fake/${family}.ttf`, faceIndex: i,
  names: { family, subfamily: 'Regular', bold: false, italic: false, weight: 400, ...extra },
});
const style = { bold: false, italic: false };

describe('resolveSubstitute', () => {
  it('returns undefined when no face is registered', () => {
    expect(resolveSubstitute([], { baseFont: 'X', style, wanted: new Set([0x41]), serif: false },
      () => undefined)).toBeUndefined();
  });

  // NAME MUST OUTRANK COVERAGE, and the named face has to cover LESS than its
  // rival or the two rungs agree and the ordering is unfalsifiable.
  it('prefers a family named by /BaseFont over a better-covering rival', () => {
    const named = face('MS Mincho');
    const rival = face('Some Other CJK');
    const cov = new Map([[named.path, new Set([0x4e00])],
                         [rival.path, new Set([0x4e00, 0x4e8c, 0x4e09])]]);
    const hit = resolveSubstitute([rival, named],
      { baseFont: 'MS Mincho', style, wanted: new Set([0x4e00, 0x4e8c, 0x4e09]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('MS Mincho');
    expect(hit.rung).toBe('name');
  });

  it('falls to coverage when /BaseFont names nothing installed', () => {
    const poor = face('Latin Only');
    const rich = face('Wide CJK');
    const cov = new Map([[poor.path, new Set([0x41])],
                         [rich.path, new Set([0x41, 0x4e00, 0x4e8c])]]);
    const hit = resolveSubstitute([poor, rich],
      { baseFont: 'Absent Family', style, wanted: new Set([0x41, 0x4e00, 0x4e8c]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('Wide CJK');
    expect(hit.rung).toBe('coverage');
  });

  // THE CMAP CONFIRM MUST OUTRANK ulUnicodeRange: the liar has to CLAIM the
  // range and not deliver it, or the pre-filter and the confirm agree and the
  // confirm can be deleted with the suite still green.
  it('believes the cmap over a ulUnicodeRange that lies', () => {
    const liar = face('Liar', { unicodeRange: [0, 0, 0x08000000, 0] });   // claims bit 59
    const honest = face('Honest', { unicodeRange: [0, 0, 0x08000000, 0] });
    const cov = new Map([[liar.path, new Set<number>()], [honest.path, new Set([0x4e00])]]);
    const hit = resolveSubstitute([liar, honest],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('Honest');
  });

  it('keeps a face that states no ulUnicodeRange at all', () => {
    const silent = face('Silent');                       // no unicodeRange field
    const hit = resolveSubstitute([silent],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      () => new Set([0x4e00]))!;
    expect(hit.face.names.family).toBe('Silent');
  });

  it('excludes a face whose stated range cannot hold any wanted code point', () => {
    const latin = face('Latin', { unicodeRange: [0x00000001, 0, 0, 0] });  // bit 0 only
    expect(resolveSubstitute([latin],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      () => new Set([0x4e00]))).toBeUndefined();
  });

  // THE SERIF TIE-BREAK needs EQUAL coverage: any difference settles it first
  // and this rule goes unmeasured.
  it('breaks an equal-coverage tie on the descriptor\'s serif flag', () => {
    const sans = face('Tie Sans', { familyClass: 8 });
    const serif = face('Tie Serif', { familyClass: 2 });
    const both = () => new Set([0x4e00]);
    expect(resolveSubstitute([sans, serif],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: true }, both)!.face.names.family)
      .toBe('Tie Serif');
    expect(resolveSubstitute([serif, sans],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false }, both)!.face.names.family)
      .toBe('Tie Sans');
  });

  it('returns undefined when nothing covers enough, rather than a bad face', () => {
    const f = face('Latin Only');
    expect(resolveSubstitute([f],
      { baseFont: '', style, wanted: new Set([0x4e00, 0x4e8c, 0x4e09, 0x56db]), serif: false },
      () => new Set([0x41]))).toBeUndefined();
  });

  it('returns undefined when the font can emit nothing', () => {
    expect(resolveSubstitute([face('Anything')],
      { baseFont: '', style, wanted: new Set(), serif: false },
      () => new Set([0x41]))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/fontsubst.test.ts`
Expected: FAIL — `resolveSubstitute` is not exported.

- [ ] **Step 3: Add the range table and the two predicates**

Append to `src/fontsubst.ts`:

```ts
/**
 * Code-point block -> `OS/2.ulUnicodeRange` bit, from the OpenType `OS/2`
 * specification's Unicode Character Range table.
 *
 * **DELIBERATELY PARTIAL, and that is what makes it safe.** Transcribing all
 * ~170 rows would be a large unverified table for a pre-filter; these are the
 * blocks that actually discriminate for font substitution. A code point no row
 * covers contributes NO bit, and a face is excluded only when every wanted
 * point maps to a known bit and the face sets none of them -- so an omission
 * costs a confirm, never a wrong answer. Rows may be added; none may be
 * guessed.
 */
const RANGE_BITS: readonly { lo: number; hi: number; bit: number }[] = [
  { lo: 0x0000, hi: 0x007f, bit: 0 },    // Basic Latin
  { lo: 0x0080, hi: 0x00ff, bit: 1 },    // Latin-1 Supplement
  { lo: 0x0370, hi: 0x03ff, bit: 7 },    // Greek and Coptic
  { lo: 0x0400, hi: 0x04ff, bit: 9 },    // Cyrillic
  { lo: 0x0590, hi: 0x05ff, bit: 11 },   // Hebrew
  { lo: 0x0600, hi: 0x06ff, bit: 13 },   // Arabic
  { lo: 0x0900, hi: 0x097f, bit: 15 },   // Devanagari
  { lo: 0x0e00, hi: 0x0e7f, bit: 24 },   // Thai
  { lo: 0x1100, hi: 0x11ff, bit: 28 },   // Hangul Jamo
  { lo: 0x3000, hi: 0x303f, bit: 48 },   // CJK Symbols and Punctuation
  { lo: 0x3040, hi: 0x309f, bit: 49 },   // Hiragana
  { lo: 0x30a0, hi: 0x30ff, bit: 50 },   // Katakana
  { lo: 0x3100, hi: 0x312f, bit: 51 },   // Bopomofo
  { lo: 0xac00, hi: 0xd7af, bit: 56 },   // Hangul Syllables
  { lo: 0x4e00, hi: 0x9fff, bit: 59 },   // CJK Unified Ideographs
  { lo: 0xf900, hi: 0xfaff, bit: 61 },   // CJK Compatibility Ideographs
];

const rangeBit = (cp: number): number | undefined =>
  RANGE_BITS.find((r) => cp >= r.lo && cp <= r.hi)?.bit;

/** Whether a face's stated ranges could hold any of `wanted`. Conservative: a
 *  face is refused only on POSITIVE evidence that it cannot. */
function rangeAdmits(range: readonly [number, number, number, number], wanted: readonly number[]): boolean {
  let sawKnown = false;
  for (const cp of wanted) {
    const bit = rangeBit(cp);
    if (bit === undefined) continue;
    sawKnown = true;
    if ((range[bit >> 5] >>> (bit & 31)) & 1) return true;
  }
  return !sawKnown;   // nothing we can judge -> admit, and let the cmap decide
}

/** `OS/2.sFamilyClass` classes 1..7 are the serif families; 8 is sans serif.
 *  Anything else (0 unclassified, 9..14 ornamental/script/symbolic) is not a
 *  serif claim. */
const isSerifClass = (cls: number | undefined): boolean => cls !== undefined && cls >= 1 && cls <= 7;

/** How many admitted faces are confirmed against their real `cmap`. A cost
 *  bound with a stated consequence: a folder offering more than this many
 *  admitted faces confirms the first {@link CONFIRM_CAP} in index order, which
 *  is registration then directory order. */
export const CONFIRM_CAP = 64;
/** Below this fraction of `wanted`, a face is not a substitute for this font --
 *  drawing a tenth of a page's characters is worse than boxes throughout,
 *  because it looks like a font that works. */
export const MIN_COVERAGE = 0.5;
```

- [ ] **Step 4: Add `resolveSubstitute`**

```ts
/** What a non-embedded font dict asks of a substitute. */
export interface SubstRequest {
  /** `/BaseFont` with any six-letter subset prefix stripped. `''` when absent. */
  baseFont: string;
  /** From `font.ts`'s `fontStyleOf` -- the ONE owner of "is this bold or
   *  italic", shared with `fragmentsFromGlyphs` and `struct.ts`. */
  style: FontStyle;
  /** {@link wantedCodepoints}'s answer for this dict. */
  wanted: ReadonlySet<number>;
  /** The descriptor's `/Flags` bit 2 (Serif). */
  serif: boolean;
}

/** A chosen face, and WHICH rung chose it. The rung is reported so a test can
 *  pin the ORDER rather than only the outcome, and so a caller can tell a name
 *  hit from a guess. */
export interface SubstMatch {
  face: FaceRecord;
  rung: 'name' | 'coverage';
}

/**
 * The installed face that substitutes for a non-embedded font, or `undefined`
 * when none should -- an ordinary outcome, where the caller falls back to the
 * bundled Standard-14 face exactly as it did before this existed.
 *
 * **Rung 1, NAME.** The document named a family, so a coverage score must not
 * overrule a name that matched -- the rule `matchChain` already applies for
 * authoring, reused rather than re-derived.
 *
 * **Rung 2, COVERAGE.** `ulUnicodeRange` pre-filters (free: `fontnames.ts`
 * already read that slice) and the real `cmap` decides. This is also where
 * `lqcs.3`'s collection step lands: for a composite font with a known
 * ordering, `wanted` IS that collection's table, so a face covering Simplified
 * Chinese is found without anybody writing PingFang SC's name down.
 */
export function resolveSubstitute(
  faces: readonly FaceRecord[],
  req: SubstRequest,
  cmapOf: (face: FaceRecord) => ReadonlySet<number> | undefined,
): SubstMatch | undefined {
  if (faces.length === 0) return undefined;

  if (req.baseFont !== '') {
    const hit = matchChain(faces, [req.baseFont],
      { weight: req.style.bold ? 700 : 400, italic: req.style.italic });
    if (hit) return { face: hit, rung: 'name' };
  }

  if (req.wanted.size === 0) return undefined;
  const wanted = [...req.wanted];

  const admitted = faces
    .filter((f) => !f.names.unicodeRange || rangeAdmits(f.names.unicodeRange, wanted))
    .slice(0, CONFIRM_CAP);

  let best: SubstMatch | undefined;
  let bestScore = 0;
  let bestSerif = false;
  for (const f of admitted) {
    const cov = cmapOf(f);
    if (!cov) continue;
    let hits = 0;
    for (const cp of wanted) if (cov.has(cp)) hits++;
    const score = hits / wanted.length;
    if (score < MIN_COVERAGE) continue;
    const serif = isSerifClass(f.names.familyClass) === req.serif;
    // Strict >, so an equal score and an equal serif verdict leave the EARLIER
    // face in place -- index order, which is registration then directory
    // order, exactly as `matchFace` breaks its own ties.
    if (score > bestScore || (score === bestScore && serif && !bestSerif)) {
      best = { face: f, rung: 'coverage' };
      bestScore = score;
      bestSerif = serif;
    }
  }
  return best;
}
```

Add to the imports at the top of `src/fontsubst.ts`:

```ts
import { matchChain } from './fontmatch.js';
import type { FaceRecord } from './fontsource.js';
```

`FaceRecord` is imported as a **type**, so `fontsubst.ts` stays free of
`node:fs`. `matchChain` is a value import and `fontmatch.ts` imports nothing
back.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/fontsubst.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Mutation-check all four rules**

One at a time; run `npx vitest run test/fontsubst.test.ts` after each, confirm
the named case goes RED, restore.

| Mutation | Must redden |
|---|---|
| Move the name rung *after* the coverage loop | "prefers a family named by /BaseFont" |
| Make `cmapOf`'s result unused — score from `rangeAdmits` alone | "believes the cmap over a ulUnicodeRange that lies" |
| Drop the `!f.names.unicodeRange \|\|` clause | "keeps a face that states no ulUnicodeRange" |
| Drop the `serif && !bestSerif` tie-break | "breaks an equal-coverage tie" |
| Change `return !sawKnown` to `return false` | "keeps a face that states no ulUnicodeRange" (via an unmapped point) |

- [ ] **Step 7: Check for an import cycle**

```bash
npx vitest run test/import-cycles.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/fontsubst.ts test/fontsubst.test.ts
git commit -m "feat(lqcs.2): resolveSubstitute -- name, then Unicode coverage

Folds lqcs.3 in. Its collection step needs no family-name table: for a
composite font with a known ordering the wanted set IS cidunidata.ts's
table for that collection, so a face covering Simplified Chinese is
found without anybody writing PingFang SC's name down. Nothing
unanchored ships.

RANGE_BITS is deliberately partial and safe because of it -- an
unmapped code point contributes no bit and a face is excluded only on
positive evidence, so an omission costs a confirm, never an answer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: the `Document` API and the parsed-face memo

**Files:**
- Modify: `src/document.ts:341-342` (fields), `src/document.ts:1805-1822` (beside the authoring methods)
- Test: `test/render-fonts.test.ts` (create)

**Interfaces:**
- Consumes: `peekCmap` is not used here; `indexFolder`, `systemFontFolders` already imported by `document.ts`.
- Produces:
  - `Document.RegisterRenderFontFolder(dir: string, opts?: { sniff?: boolean }): void`
  - `Document.RegisterRenderSystemFonts(): void`
  - `Document.renderFontFaces(): FaceRecord[]` — `@internal`
  - `Document.loadRenderFace(path: string, faceIndex: number): SfntFont | undefined` — `@internal`
- Task 6 calls the last two.

- [ ] **Step 1: Write the failing tests**

Create `test/render-fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-renderfonts-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('render font sources', () => {
  it('indexes a registered render folder', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Render Alpha' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    expect(doc.renderFontFaces().map((f) => f.names.family)).toContain('Render Alpha');
  });

  it('is EMPTY with nothing registered, which is what keeps rendering opt-in', () => {
    expect(Document.New().renderFontFaces()).toEqual([]);
  });

  // The lists are SEPARATE: an authoring folder must not change any render.
  it('does not draw on the authoring folder list', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Authoring Only' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.renderFontFaces()).toEqual([]);
  });

  it('does not let a render folder reach LoadFontByName', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Render Only' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    expect(doc.LoadFontByName('Render Only')).toBeUndefined();
  });

  it('re-registering a held path does not move it or grow the list', () => {
    const a = folderWith({ 'a.ttf': buildNamedFont({ family: 'First' }) });
    const b = folderWith({ 'b.ttf': buildNamedFont({ family: 'Second' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(a);
    doc.RegisterRenderFontFolder(b);
    doc.RegisterRenderFontFolder(a);
    expect(doc.renderFontFaces().map((f) => f.names.family)).toEqual(['First', 'Second']);
  });

  it('returns the SAME parsed face for one path and index', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Memo' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    const p = join(dir, 'a.ttf');
    expect(doc.loadRenderFace(p, 0)).toBe(doc.loadRenderFace(p, 0));
  });

  it('returns undefined for a face it cannot read, rather than throwing', () => {
    const dir = folderWith({ 'junk.ttf': new Uint8Array([1, 2, 3, 4]) });
    expect(() => Document.New().loadRenderFace(join(dir, 'junk.ttf'), 0)).not.toThrow();
    expect(Document.New().loadRenderFace(join(dir, 'junk.ttf'), 0)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/render-fonts.test.ts`
Expected: FAIL — `RegisterRenderFontFolder is not a function`.

- [ ] **Step 3: Add the fields**

Beside `private readonly fontFolders` (`src/document.ts:342`):

```ts
  /** Folders to search when RENDERING a non-embedded font, in registration
   *  order. Separate from {@link fontFolders} on purpose: reusing that list
   *  would change what an existing caller's pages look like merely because
   *  they registered a folder for `AddText`. */
  private readonly renderFontFolders: { dir: string; sniff: boolean }[] = [];
  /** Parsed render substitute faces, keyed `path#faceIndex`. */
  private readonly renderFaces = new Map<string, SfntFont | null>();
```

Ensure `SfntFont` and `parseSfnt` are imported in `document.ts` (it already
imports `parseSfnt` indirectly through `AddFont`; add
`import { parseSfnt, type SfntFont } from './sfnt.js';` if absent), and
`FaceRecord` as a type from `./fontsource.js`.

- [ ] **Step 4: Add the two public methods**

After `RegisterSystemFonts` (`src/document.ts:1822`):

```ts
  /**
   * Search `dir`, recursively, when RENDERING a font the document did not
   * embed.
   *
   * Opt-in, and that is the whole design: with no folder registered the
   * renderer uses only the bundled substitute faces and a page looks the same
   * on every machine, which is what keeps the render goldens meaningful. A
   * document that registers one renders a non-embedded CJK font in a real face
   * instead of placeholder boxes.
   *
   * A SEPARATE list from {@link RegisterFontFolder}, which goes on feeding
   * {@link LoadFontByName} alone — sharing them would change what an existing
   * caller's pages look like merely because they registered a folder for
   * authoring.
   *
   * The scanning rules are {@link RegisterFontFolder}'s exactly: no I/O here,
   * the folder is scanned on the first render that needs it; re-registering a
   * held path neither moves it nor grows the list; `sniff` is sticky-on and
   * upgrades a held path in place.
   *
   * Rendering only. Extraction, editing and PDF/A font embedding are
   * unchanged, and no substituted program is ever written into the document.
   */
  RegisterRenderFontFolder(dir: string, opts: { sniff?: boolean } = {}): void {
    const sniff = opts.sniff ?? false;
    const already = this.renderFontFolders.find((f) => f.dir === dir);
    if (already) { already.sniff ||= sniff; return; }
    this.renderFontFolders.push({ dir, sniff });
  }

  /**
   * Also search the platform's own font directories when rendering.
   *
   * Opt-in for {@link RegisterSystemFonts}'s reason, and one more: a render
   * that silently depends on what is installed makes the same code produce
   * different pixels on different machines.
   */
  RegisterRenderSystemFonts(): void {
    for (const dir of systemFontFolders()) this.RegisterRenderFontFolder(dir);
  }

  /**
   * Every face the registered render folders hold.
   *
   * @internal — `raster.ts` reaches this through the `Document` it is handed.
   * Empty with nothing registered, which is the line that makes opt-in
   * structural rather than tested for.
   */
  renderFontFaces(): FaceRecord[] {
    const out: FaceRecord[] = [];
    for (const f of this.renderFontFolders) out.push(...indexFolder(f.dir, f.sniff));
    return out;
  }

  /**
   * One render substitute face, parsed and memoized.
   *
   * Keyed by path AND face index: the faces of a collection share one path, so
   * a path-only key hands back face 0's font for every face of the file and
   * every glyph is drawn from the wrong one, silently — the bug
   * {@link LoadFontByName}'s own key records.
   *
   * This is where the cost is: indexing is partial reads, but a chosen face is
   * read whole, and a CJK font runs to tens of megabytes. Two font dicts
   * resolving to one file share one parse. Never throws.
   *
   * @internal
   */
  loadRenderFace(path: string, faceIndex: number): SfntFont | undefined {
    const key = `${path}#${faceIndex}`;
    const hit = this.renderFaces.get(key);
    if (hit !== undefined) return hit ?? undefined;
    let font: SfntFont | null = null;
    try {
      font = parseSfnt(new Uint8Array(readFileSync(path)), faceIndex);
    } catch {
      font = null;   // indexable, not parseable
    }
    this.renderFaces.set(key, font);
    return font ?? undefined;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/render-fonts.test.ts test/font-byname.test.ts && npm run typecheck`
Expected: PASS. `font-byname.test.ts` must pass **unedited** — it is the fence
that the authoring path did not move.

- [ ] **Step 6: Mutation-check the separation and the memo key**

Change `renderFontFaces` to read `this.fontFolders`, run
`npx vitest run test/render-fonts.test.ts`, confirm "does not draw on the
authoring folder list" goes RED, restore. Then change the memo key to `path`
alone and confirm nothing reddens yet — **note this in the commit body**: the
`.ttc` case that pins it arrives in Task 7's acceptance fixtures, and until
then the key rests on `LoadFontByName`'s precedent rather than on this suite.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/render-fonts.test.ts
git commit -m "feat(lqcs.2): render font folders, separate from the authoring list

Opt-in is STRUCTURAL: with nothing registered renderFontFaces() is
empty, so the substitute resolver returns on its first line and the
bundled path runs exactly as before. Sharing the authoring list would
change what an existing caller's pages look like merely because they
registered a folder for AddText.

The parsed-face memo is keyed path#faceIndex, not path: a collection's
faces share one path, and a path-only key draws every glyph from face 0.
Measured as NOT yet pinned by this suite -- the .ttc case lands with the
acceptance fixtures.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: wire it into `buildGlyphSource`

**Files:**
- Modify: `src/raster.ts:584-602` (`GlyphSource`), `src/raster.ts:606-661` (`buildGlyphSource`)
- Test: `test/type0-substitute.test.ts`

**Interfaces:**
- Consumes: `resolveSubstitute`, `wantedCodepoints`, `SubstRequest` (Tasks 3–4); `peekCmap` (Task 2); `renderFontFaces`, `loadRenderFace` (Task 5); `fontStyleOf` from `font.js`.
- Produces: `GlyphSource.substituteFamily?: string`.

**What must NOT change:** `gidForCode`'s rule. A substituted composite font
selects by **Unicode** and never through `gidForProgram`, whose
`cmapLookup(code)` / `cmapLookup(0xF000 + code)` fallbacks draw a confident
wrong glyph for a CID. That holds whether the substitute is bundled or
installed, so this task adds no branch there.

- [ ] **Step 1: Write the failing tests**

Append to `test/type0-substitute.test.ts`, which already holds `lqcs.1`'s
fixtures — its `bfrange` and `show` helpers at lines 25–35, `inkCount` at 36 and
`render` at 48. Add the imports it lacks:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlyphSource } from '../src/raster.js';
import { buildNamedFont } from './helpers/build-sfnt.js';
import { fontDictOf } from './helpers/build-text-pdf.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-type0sub-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('installed-face substitution (lqcs.2)', () => {
  /** A non-embedded Identity-H page whose four CIDs mean four kanji. */
  const cjkPdf = (baseFont?: string) => buildType0Pdf(
    show([0x41, 0x42, 0x43, 0x44]), bfrange(0x41, 0x44, 0x4e00), { baseFont });
  const MINCHO_CMAP: [number, number][] =
    [[0x4e00, 1], [0x4e01, 1], [0x4e02, 1], [0x4e03, 1]];

  it('reports no substitute family with no render folder registered', () => {
    const doc = Document.Open(cjkPdf());
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituted).toBe(true);
    expect(src.substituteFamily).toBeUndefined();    // the bundled face
  });

  it('resolves /BaseFont to an installed face when one is registered', () => {
    const dir = folderWith({ 'm.ttf': buildNamedFont({
      family: 'MS Mincho', cmap: MINCHO_CMAP,
    }) });
    const doc = Document.Open(cjkPdf('MS-Mincho'));
    doc.RegisterRenderFontFolder(dir);
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });

  it('falls back to the bundled face when the folder holds nothing usable', () => {
    const dir = folderWith({ 'l.ttf': buildNamedFont({
      family: 'Latin Only', cmap: [[0x41, 1]], unicodeRange: [1, 0, 0, 0],
    }) });
    const doc = Document.Open(cjkPdf('Absent Family'));
    doc.RegisterRenderFontFolder(dir);
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituted).toBe(true);
    expect(src.substituteFamily).toBeUndefined();
  });

  it('strips a subset prefix before matching by name', () => {
    const dir = folderWith({ 'm.ttf': buildNamedFont({
      family: 'MS Mincho', cmap: MINCHO_CMAP,
    }) });
    const doc = Document.Open(cjkPdf('AAAAAB+MS-Mincho'));
    doc.RegisterRenderFontFolder(dir);
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/type0-substitute.test.ts`
Expected: FAIL — `substituteFamily` is `undefined` in the second case.

- [ ] **Step 3: Add the field to `GlyphSource`**

In `src/raster.ts`, after `substituted`:

```ts
  /** The family of the INSTALLED face chosen for a substituted font, when one
   *  was — undefined when the bundled Standard-14 face answered instead.
   *
   *  The render-side counterpart of `FontMatch.exact`: the only way a caller
   *  or a test can learn that a real face was resolved and which one it was. */
  substituteFamily?: string;
```

- [ ] **Step 4: Resolve an installed face in `buildGlyphSource`**

Add a module-private helper above `buildGlyphSource`:

```ts
/** The installed face for a non-embedded font, or undefined to fall back to the
 *  bundled Standard-14 substitute.
 *
 *  Every rule lives in `fontsubst.ts`, which takes its faces and its `cmap`
 *  reader as arguments; this function is only the wiring that supplies them. */
function installedSubstitute(
  doc: Document, fontDict: PdfDict, fd: PdfObject | undefined,
): { sfnt: SfntFont; family: string } | undefined {
  const faces = doc.renderFontFaces();
  if (faces.length === 0) return undefined;      // opt-in, structurally

  const bf = doc.resolve(fontDict.get('BaseFont'));
  const flags = isDict(fd) ? doc.resolve(fd.get('Flags')) : undefined;
  const req: SubstRequest = {
    baseFont: isName(bf) ? bf.name.replace(/^[A-Z]{6}\+/, '') : '',
    style: fontStyleOf(fontDict, (o) => doc.resolve(o)),
    wanted: wantedCodepoints(fontDict, (o) => doc.resolve(o),
      (s) => inflateStream(s as Parameters<typeof inflateStream>[0])),
    serif: typeof flags === 'number' ? (flags & 2) !== 0 : false,
  };

  const hit = resolveSubstitute(faces, req, (f) => peekCmap(f.path, f.faceIndex));
  if (!hit) return undefined;
  const sfnt = doc.loadRenderFace(hit.face.path, hit.face.faceIndex);
  if (!sfnt) return undefined;                   // indexable, not parseable
  return { sfnt, family: hit.face.names.typographicFamily ?? hit.face.names.family };
}
```

Then replace the substitute block in `buildGlyphSource` (`src/raster.ts:644-649`):

```ts
  let substituted = false;
  let substituteFamily: string | undefined;
  if (!sfnt && !cff && !type1) {
    const installed = installedSubstitute(doc, fontDict, fd);
    if (installed) {
      sfnt = installed.sfnt;
      substituteFamily = installed.family;
    } else {
      // Unchanged from lqcs.1, verbatim: with no render folder registered this
      // is the only line that runs and output is byte-identical to before.
      const bf = doc.resolve(fontDict.get('BaseFont'));
      sfnt = getStd14Sfnt(normalizeFont(isName(bf) ? bf.name : 'Helvetica'));
    }
    substituted = true;
  }
```

and add `substituteFamily` to the returned object. Add the imports:

```ts
import { peekCmap } from './fontsource.js';
import { resolveSubstitute, wantedCodepoints, type SubstRequest } from './fontsubst.js';
import { fontStyleOf } from './font.js';
```

`fontStyleOf` may already be imported in `raster.ts`'s `./font.js` block —
check before adding a second import statement.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/type0-substitute.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Run the full fence**

Run: `npm test`
Expected: ALL green, **with no test file edited except `type0-substitute.test.ts`**.
`test/html-identity.test.ts`, `test/cjk-end-to-end.test.ts`,
`test/raster-text.test.ts` and every render suite must pass unedited — that is
the byte-identity guarantee. If any of them moved, the opt-in property is
broken: `installedSubstitute` returned something for a document that registered
no folder.

- [ ] **Step 7: Mutation-check the opt-in guard and the prefix strip**

Delete the `if (faces.length === 0) return undefined;` line and run `npm test` —
it should still be green (no other suite registers a render folder), which
*confirms* the guard is a cost bound rather than a correctness one; restore it
and say so in the commit. Then remove `.replace(/^[A-Z]{6}\+/, '')`, run
`npx vitest run test/type0-substitute.test.ts`, confirm the subset-prefix case
goes RED, restore.

- [ ] **Step 8: Commit**

```bash
git add src/raster.ts test/type0-substitute.test.ts
git commit -m "feat(lqcs.2): draw a non-embedded font from an installed face

buildGlyphSource consults the registered render folders in the branch
lqcs.1 already established. gidForCode is UNCHANGED: a substituted
composite font still selects by Unicode and never through
gidForProgram, whose cmapLookup(code) fallback draws a confident wrong
glyph for a CID -- and that holds whether the substitute is bundled or
installed, which is why this adds no branch there.

Measured: the faces.length === 0 early return is a COST bound, not a
correctness one -- deleting it leaves the suite green, because the
resolver returns undefined for an empty list anyway.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: end-to-end acceptance, and the docs

**Files:**
- Test: `test/render-fonts.test.ts` (extend)
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new in `src/`.

**The acceptance case must compare renders, not assert that ink appears.**
`lqcs.1` measured that an unresolved composite font paints hairline
**placeholder boxes** — 1120 ink pixels for a four-CID run at 48pt — so a
fixture asserting ink passes on a build where nothing resolved at all.

- [ ] **Step 1: Write the failing acceptance tests**

Append to `test/render-fonts.test.ts`:

Add these imports to `test/render-fonts.test.ts`:

```ts
import { buildTtc, buildNamedFont } from './helpers/build-sfnt.js';
import { buildType0Pdf } from './helpers/build-text-pdf.js';
import { decodePng } from './helpers/decode-png.js';
import { buildGlyphSource } from '../src/raster.js';
import { fontDictOf } from './helpers/build-text-pdf.js';
```

```ts
/** Ink pixels in a rendered page — `test/type0-substitute.test.ts:36`'s rule,
 *  repeated rather than exported: it is nine lines and a shared one would make
 *  two test files depend on each other's internals. */
function inkCount(bytes: Uint8Array): number {
  const png = decodePng(bytes);
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r !== 255 || g !== 255 || b !== 255) n++;
    }
  }
  return n;
}

/** A /ToUnicode CMap mapping one CID range to a run of code points. */
const bfrange = (loCid: number, hiCid: number, loUni: number) =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n`
  + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n`
  + `1 beginbfrange <${loCid.toString(16).padStart(4, '0')}> `
  + `<${hiCid.toString(16).padStart(4, '0')}> `
  + `<${loUni.toString(16).padStart(4, '0')}> endbfrange\n`
  + `endcmap end end`;

describe('acceptance: a non-embedded CJK font draws real glyphs', () => {
  /** CIDs 0x41..0x44 mean U+4E00..U+4E03; the face below covers exactly those. */
  const cjkPdf = (baseFont?: string) => buildType0Pdf(
    'BT /F1 48 Tf 20 100 Td <0041004200430044> Tj ET',
    bfrange(0x41, 0x44, 0x4e00), { baseFont });
  const CJK: [number, number][] = [[0x4e00, 1], [0x4e01, 1], [0x4e02, 1], [0x4e03, 1]];
  const minchoFace = () => buildNamedFont({
    family: 'MS Mincho', cmap: CJK,
    unicodeRange: [0, 0, 0x08000000, 0],     // bit 59, CJK Unified Ideographs
  });

  it('renders differently with a render folder than without', () => {
    const dir = folderWith({ 'mincho.ttf': minchoFace() });

    const bare = Document.Open(cjkPdf());
    const withFolder = Document.Open(cjkPdf());
    withFolder.RegisterRenderFontFolder(dir);

    const a = inkCount(bare.Pages[0].ToImage());
    const b = inkCount(withFolder.Pages[0].ToImage());

    // The face's glyph is a FILLED box; the placeholder is a HAIRLINE box, so
    // the resolved render must carry substantially more ink. An assertion that
    // the two merely DIFFER would also pass for two broken renders, and one
    // that ink appears passes on the unfixed build — see lqcs.1.
    expect(b).toBeGreaterThan(a * 2);
  });

  it('renders identically to the bundled path with no folder registered', () => {
    const a = Document.Open(cjkPdf()).Pages[0].ToImage();
    const b = Document.Open(cjkPdf()).Pages[0].ToImage();
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it('leaves ToSvg untouched, which it structurally must', () => {
    const dir = folderWith({ 'mincho.ttf': minchoFace() });
    const bare = Document.Open(cjkPdf());
    const withFolder = Document.Open(cjkPdf());
    withFolder.RegisterRenderFontFolder(dir);
    // SvgSink.glyphRun emits <text> with a CSS family stack and never resolves
    // a glyph program, so no font directory can change one byte of it.
    expect(withFolder.Pages[0].ToSvg()).toBe(bare.Pages[0].ToSvg());
  });

  // This is the case that finally pins loadRenderFace's path#faceIndex key.
  it('draws from the named face of a collection, not face 0', () => {
    const latin = buildNamedFont({ family: 'Coll Latin', cmap: [[0x41, 1]] });
    const dir = folderWith({ 'c.ttc': buildTtc([latin, minchoFace()]) });
    const doc = Document.Open(cjkPdf());
    doc.RegisterRenderFontFolder(dir);
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituteFamily).toBe('MS Mincho');
    expect(src.sfnt!.cmapLookup(0x4e00)).toBeDefined();   // face 1's cmap, not face 0's
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/render-fonts.test.ts`
Expected: **PASS**, and that is the point of running it here — Tasks 1–6
implement the behaviour, so this task is the end-to-end check that they compose.
A failure is a real gap; fix it in the module that owns the rule, never by
weakening an assertion. The one case that should be red before Step 5 is the
collection case, and only under that step's mutation.

- [ ] **Step 3: If anything failed, fix it at its owner**

A red "renders differently" means `installedSubstitute` found nothing: check
the render folder reached `renderFontFaces()` (Task 5), that `wantedCodepoints`
returned the four kanji from `/ToUnicode` (Task 3), and that `peekCmap` read
the face (Task 2). A red "renders identically with no folder" means the opt-in
guard is broken — the most serious possible failure here, since it means every
render golden in the suite is now machine-dependent.

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: ALL green.

- [ ] **Step 5: Mutation-check the collection key**

Change `loadRenderFace`'s memo key from `` `${path}#${faceIndex}` `` to `path`,
run `npx vitest run test/render-fonts.test.ts`, confirm the collection case goes
RED, restore. This closes the gap Task 5 recorded as unpinned.

- [ ] **Step 6: Update `CHANGELOG.md`**

Under `## [Unreleased]`, in **Added**:

```markdown
- **Render-time font substitution sources.** `RegisterRenderFontFolder(dir)`
  and `RegisterRenderSystemFonts()` let a caller hand the *renderer* font
  folders, so a font the document did not embed draws from an installed face
  instead of the bundled Standard-14 substitute — which for a non-embedded CJK
  font was a page of placeholder boxes, the commonest way an East Asian
  document reaches this library. A face is chosen by `/BaseFont` name first,
  then by how much of what the font can emit its `cmap` actually covers;
  `ulUnicodeRange` narrows the candidates and the real `cmap` decides, because
  that field is the producer's claim about its own font. No family-name table
  ships: for a composite font the wanted set is its own character collection's,
  so a PDF naming SimSun finds PingFang SC without anybody writing either name
  down. Opt-in — with no folder registered the renderer uses only the bundled
  faces and a page looks the same on every machine. Rendering only: extraction,
  editing and PDF/A embedding are unchanged, and no substituted program is
  written into the document. `ToSvg` is unaffected by construction, since it
  emits text with a CSS family stack and resolves no glyph program.
  (`lqcs.2`, `lqcs.3`)
```

- [ ] **Step 7: Update `README.md`**

Add the two methods to the API Reference table they belong in (the fonts /
core rows — note the types table is several alphabetical runs concatenated, so
find the right run rather than the first name that sorts higher). Add one line
to Key Capabilities. If there is a Scope and Limitations entry saying a
non-embedded CJK font cannot be drawn, correct it — and state the two residual
limits: byte-supplied programs are not a source, and a Type 1 face is
reachable by name but never by coverage, having no `cmap`.

- [ ] **Step 8: Update `CLAUDE.md`**

Add a Source-list entry for **fontsubst.ts** near `fontmatch.ts`, recording:
the leaf-and-injected-faces rule; that name outranks coverage; that
`ulUnicodeRange` selects and the `cmap` decides; that `RANGE_BITS` is
deliberately partial and why that is safe; that the prime probe step exists
because Adobe-Japan1's CIDs 1..230 are Latin; that no family-name table ships
and why; that `CONFIRM_CAP` is a cost bound with a stated consequence; and the
measured note that `raster.ts`'s `faces.length === 0` early return is a cost
bound rather than a correctness one. Mention `peekCmap` in the `fontsource.ts`
prose so the doc sweep is satisfied for it.

Then run the sweep from `CLAUDE.md`'s Docs section and confirm it is **empty**:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 9: Commit**

```bash
git add test/render-fonts.test.ts test/helpers/ CHANGELOG.md README.md CLAUDE.md
git commit -m "feat(lqcs.2): acceptance for installed-face substitution, plus docs

The acceptance case compares renders rather than asserting ink appears:
lqcs.1 measured that an unresolved composite font paints hairline
placeholder boxes, so an ink assertion passes on a build where nothing
resolved. The face's glyph is filled, so the comparison is against
2x the bare render.

Pins loadRenderFace's path#faceIndex key, which Task 5 recorded as
unpinned, and asserts ToSvg is unchanged -- structurally true, and
worth stating so the next reader does not file it as a gap.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Close the issues**

```bash
bd close lqcs.2 --reason "Shipped on feat/lqcs.2-render-font-substitution. <summary>"
bd close lqcs.3 --reason "Folded into lqcs.2: its collection step needs no family-name table, since for a composite font with a known ordering the wanted coverage set IS cidunidata.ts's table for that collection."
```

Then follow `CLAUDE.md`'s Session Completion workflow: `git pull --rebase`,
`git push`, `git status` showing up to date with origin.

---

## Follow-ups to file

- **Font programs supplied as bytes** as a render source. `FaceRecord.path` is
  a filesystem path `LoadFontByName` reads with `readFileSync`, so a bytes
  source makes it a discriminated union and reaches the authoring path too.
- **`lqcs.4`** is unblocked but untouched: box an unknown *symbolic* font
  rather than substituting Latin. Note it interacts — a symbolic font may now
  match an installed face by name, which is the right answer and changes what
  "no face matches" means for that issue.
