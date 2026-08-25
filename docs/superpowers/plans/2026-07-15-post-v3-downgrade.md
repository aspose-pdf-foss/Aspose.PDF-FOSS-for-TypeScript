# `post` 2.0 → 3.0 Downgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink embedded `glyf` font programs further by rewriting a `post` v2.0 table to v3.0 — dropping its glyph-name pool — but only for programs no font dict can resolve glyphs by name against.

**Architecture:** `shrinkGlyf` gains a default-off `dropGlyphNames` option backed by a `rewritePostV3` helper in `fontshrink.ts`. `optimize.ts` builds a veto set of font programs reachable from any name-resolving font dict, once per `optimizeFonts` call, by scanning the whole object graph; `shrinkOne` sets the option to the negation of that set's membership.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:zlib`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-15-post-v3-downgrade-design.md`
**Issue:** `aspose-pdf-foss-for-ts-gfs`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (e.g. `import { SfntFont } from './sfnt.js';`).
- **Strict TypeScript.** No `any`, no non-null assertions in `src/` where a guard reads better. (Test files may use `!` freely — the existing tests do.)
- **TDD.** Write the failing test, watch it fail, then implement.
- **Both gates green before closing:** `npm run typecheck` and `npm test`.
- **Do not modify `test/optimize.test.ts:105`** (`keeps the cmap and post tables the code->GID chain runs through`). It must pass unmodified — it is the primary regression signal that the downgrade stayed conditional.
- **No new `OptimizeReport` field.** Savings roll into the existing per-font `bytesSaved`.
- `post` layout reference (all big-endian, offsets from table start): `version` u32 @0, `italicAngle` i32 (16.16 fixed) @4, `underlinePosition` i16 @8, `underlineThickness` i16 @10, `isFixedPitch` u32 @12, `minMemType42` @16, `maxMemType42` @20, `minMemType1` @24, `maxMemType1` @28. Header is 32 bytes. v2.0 continues with `numGlyphs` u16 @32, then the index array, then the Pascal-string pool.

---

### Task 1: `rewritePostV3` + `dropGlyphNames` on `shrinkGlyf`

Self-contained: the shrinker learns to drop names on request. Nothing calls it with the option yet, so `Optimize` behavior is unchanged after this task.

**Files:**
- Modify: `src/fontshrink.ts` (add `rewritePostV3` + `ShrinkOptions`; `shrinkGlyf` signature at line 28 and its table loop at lines 49-55)
- Modify: `test/helpers/build-sfnt.ts:97-102` (`buildPostV2` gains optional header fields)
- Test: `test/fontshrink.test.ts`

**Interfaces:**
- Consumes: `SfntFont` (`src/sfnt.js`), `buildManyGlyphTtf(n, over?)` and `customGlyphNames(n)` (`test/helpers/build-optimize-pdf.js`), `buildPostV2` (`test/helpers/build-sfnt.js`).
- Produces:
  - `export interface ShrinkOptions { dropGlyphNames?: boolean }` in `src/fontshrink.ts`
  - `export function shrinkGlyf(font: SfntFont, keep: Set<number>, opts?: ShrinkOptions): ShrinkResult` — Task 2 calls this with `{ dropGlyphNames }`.
  - `buildPostV2(names: string[], header?: { italicAngle?: number; underlinePosition?: number; isFixedPitch?: number }): Uint8Array` — the second parameter is new and optional; existing single-argument callers are unaffected.

- [ ] **Step 1: Give `buildPostV2` optional header fields**

`buildPostV2` currently writes an all-zero 32-byte header, which would make a "header survived" assertion vacuous (0 === 0 whether or not the code copies it). Add real values to assert on.

In `test/helpers/build-sfnt.ts`, replace the existing `buildPostV2` (lines 95-102):

```ts
/** A `post` v2.0 table naming each glyph. Names are emitted as custom Pascal
 *  strings (index >= 258) rather than Macintosh standard indices. `header` sets
 *  the v2.0 fields a v3.0 downgrade must carry over; all default to 0. */
export function buildPostV2(
  names: string[],
  header: { italicAngle?: number; underlinePosition?: number; isFixedPitch?: number } = {},
): Uint8Array {
  const strings = names.map((s) => concat([Uint8Array.from([s.length]), new TextEncoder().encode(s)]));
  const h = new Uint8Array(32);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x00020000);                    // version 2.0
  v.setInt32(4, header.italicAngle ?? 0);        // 16.16 fixed
  v.setInt16(8, header.underlinePosition ?? 0);
  v.setUint32(12, header.isFixedPitch ?? 0);
  return concat([h, u16(names.length), ...names.map((_, i) => u16(258 + i)), ...strings]);
}
```

- [ ] **Step 2: Write the failing tests**

Note `buildUnicodeTtf` (used by the existing `shrinkGlyf` tests) carries a **v3.0** `post` — already nameless, so it cannot exercise the downgrade. These tests use `buildManyGlyphTtf`, which takes a `post` override.

Add to `test/fontshrink.test.ts` — extend the imports at the top of the file:

```ts
import { buildUnicodeTtf, buildPostV2 } from './helpers/build-sfnt.js';
import { buildManyGlyphTtf, customGlyphNames } from './helpers/build-optimize-pdf.js';
```

(The existing `import { buildUnicodeTtf } from './helpers/build-sfnt.js';` line is replaced by the first line above.)

Then add this block after the existing `describe('shrinkGlyf', ...)` block:

```ts
/** A 200-glyph font whose post v2.0 names every glyph `g00`..`g199`. */
const namedFont = (header?: { italicAngle?: number; underlinePosition?: number; isFixedPitch?: number }) =>
  parseSfnt(buildManyGlyphTtf(200, { post: buildPostV2(customGlyphNames(200), header) }));

const postOf = (bytes: Uint8Array): DataView => {
  const t = parseSfnt(bytes).table('post')!;
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
};

describe('shrinkGlyf — post glyph names', () => {
  it('rewrites post 2.0 to 3.0 when names are dropped', () => {
    const font = namedFont();
    expect(font.postNames()![3]).toBe('g03');            // v2.0 going in
    const res = shrinkGlyf(font, new Set([1]), { dropGlyphNames: true });
    const out = parseSfnt(res.bytes);
    expect(out.postNames()).toBeUndefined();             // names gone
    expect(out.table('post')!.length).toBe(32);          // header only
    expect(postOf(res.bytes).getUint32(0)).toBe(0x00030000);
  });

  it('carries over the header fields v3.0 keeps', () => {
    const font = namedFont({ italicAngle: -15 << 16, underlinePosition: -100, isFixedPitch: 1 });
    const v = postOf(shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes);
    expect(v.getInt32(4)).toBe(-15 << 16);
    expect(v.getInt16(8)).toBe(-100);
    expect(v.getUint32(12)).toBe(1);
  });

  it('keeps post verbatim by default', () => {
    const font = namedFont();
    const out = parseSfnt(shrinkGlyf(font, new Set([1])).bytes);
    expect([...out.table('post')!]).toEqual([...font.table('post')!]);
  });

  it('leaves a post that is not v2.0 alone', () => {
    // buildManyGlyphTtf's default post is v3.0 — already nameless.
    const v3 = parseSfnt(buildManyGlyphTtf(200));
    const outV3 = parseSfnt(shrinkGlyf(v3, new Set([1]), { dropGlyphNames: true }).bytes);
    expect([...outV3.table('post')!]).toEqual([...v3.table('post')!]);

    // v1.0: the 32-byte header alone, standard Macintosh ordering implied.
    const p1 = new Uint8Array(32);
    new DataView(p1.buffer).setUint32(0, 0x00010000);
    const v1 = parseSfnt(buildManyGlyphTtf(200, { post: p1 }));
    const outV1 = parseSfnt(shrinkGlyf(v1, new Set([1]), { dropGlyphNames: true }).bytes);
    expect([...outV1.table('post')!]).toEqual([...v1.table('post')!]);
  });

  it('shrinks the program further than keeping the names would', () => {
    const font = namedFont();
    const withNames = shrinkGlyf(font, new Set([1])).bytes.length;
    const without = shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes.length;
    expect(without).toBeLessThan(withNames);
  });

  it('leaves outlines and GID numbering untouched', () => {
    const font = namedFont();
    const out = parseSfnt(shrinkGlyf(font, new Set([1]), { dropGlyphNames: true }).bytes);
    expect(out.numGlyphs).toBe(200);
    expect([...out.glyphData(1)]).toEqual([...font.glyphData(1)]);
    expect(out.glyphData(2).length).toBe(0);            // an unused glyph is still blanked
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/fontshrink.test.ts`
Expected: FAIL. The `dropGlyphNames` tests fail to compile / error — `shrinkGlyf` takes 2 arguments but 3 were provided.

- [ ] **Step 4: Implement `rewritePostV3` and the option**

In `src/fontshrink.ts`, add after the `ShrinkResult` interface (line 20):

```ts
export interface ShrinkOptions {
  /** Rewrite a `post` v2.0 table to v3.0, discarding its glyph names. Only set
   *  this where nothing can resolve a glyph by name — a nonsymbolic simple
   *  TrueType font resolves `/Differences` names outside the AGL through `post`
   *  (PDF 32000 9.6.6.4), and dropping them there shows the wrong glyph.
   *  See `nameResolvingPrograms` in optimize.ts. */
  dropGlyphNames?: boolean;
}

/** Rewrite a `post` v2.0 table as v3.0: the same 32-byte header, without the
 *  glyph-name index and string pool that follow it. On a large face that pool
 *  runs to tens of kilobytes.
 *
 *  `undefined` for every other version, leaving the caller to keep the table
 *  verbatim: v3.0 is already nameless, v1.0 names glyphs by the implied
 *  Macintosh ordering, and v2.5/v4.0 carry no pool this could drop. Returning
 *  `undefined` rather than guessing also makes a second `Optimize` a no-op. */
function rewritePostV3(post: Uint8Array): Uint8Array | undefined {
  if (post.length < 32) return undefined;
  const v = new DataView(post.buffer, post.byteOffset, post.byteLength);
  if (v.getUint32(0) !== 0x00020000) return undefined;
  const out = post.slice(0, 32);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, 0x00030000);
  return out;
}
```

Change the `shrinkGlyf` signature (line 28) from:

```ts
export function shrinkGlyf(font: SfntFont, keep: Set<number>): ShrinkResult {
```

to:

```ts
export function shrinkGlyf(font: SfntFont, keep: Set<number>, opts: ShrinkOptions = {}): ShrinkResult {
```

And update its doc comment (lines 22-27) to end with:

```
 * cmap/hmtx/hhea/maxp are copied verbatim, so every existing code->GID mapping in
 * the document stays valid without any rewrite. `post` is copied verbatim too
 * unless `opts.dropGlyphNames` says its names are provably unused.
```

Then replace the table-copy loop (lines 50-54):

```ts
  for (const tag of font.tables.keys()) {
    if (DROP_TABLES.has(tag) || tag === 'glyf' || tag === 'loca' || tag === 'head') continue;
    const data = font.table(tag, false);
    if (!data) continue;
    if (tag === 'post' && opts.dropGlyphNames) {
      const v3 = rewritePostV3(data);
      if (v3) { tables.push({ tag, data: v3 }); continue; }
    }
    tables.push({ tag, data: data.slice() });
  }
```

- [ ] **Step 5: Update the stale marker comment on the existing test**

`test/fontshrink.test.ts:42` reads `expect(parseSfnt(res.bytes).tables.has('post')).toBe(true); // post is kept in v1`. That comment marked this issue as pending work. The assertion still holds (the option defaults off, and `buildUnicodeTtf`'s `post` is v3.0 anyway), so only the comment changes:

```ts
    expect(parseSfnt(res.bytes).tables.has('post')).toBe(true); // post survives; only its names are droppable
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/fontshrink.test.ts`
Expected: PASS — all `describe('shrinkGlyf — post glyph names')` tests green, and the pre-existing `shrinkGlyf` / `shrinkCff` / `CffFont.gidToCid` tests still green.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/fontshrink.ts test/fontshrink.test.ts test/helpers/build-sfnt.ts
git commit -m "feat(gfs): shrinkGlyf can rewrite post 2.0 -> 3.0 on request

Default off, so every existing caller is unchanged. rewritePostV3 keeps the
32-byte header and drops the name pool; any non-2.0 post is left verbatim."
```

---

### Task 2: Veto set — only Type0-reachable programs lose their names

Wires the option to a proof. This is where `Optimize` behavior changes.

> **Corrected during execution.** Steps 5-6 below specced `nameResolvingPrograms(doc): Set<PdfStream>`, consulted at shrink time as `!nameResolving.has(prog.stream)`. It shipped as `glyphNameDroppableFonts(doc): Set<PdfDict>`, consulted as `nameDroppable.has(font)`. Reason: `shrinkOne` replaces a shrunk program with a newly allocated stream, so with two dicts sharing a `/FontDescriptor` the second resolves to a stream the first pass just created — invisible to a stream-keyed set, which then drops the names on the very case the veto protects. The shared-program test in Step 3 caught it. The code below is the shipped version; see `src/optimize.ts` and the spec's correction note.

**Files:**
- Modify: `src/optimize.ts` (add `NAME_FREE_SUBTYPES` + `nameResolvingPrograms`; `shrinkOne` at lines 110-152; `optimizeFonts` at lines 154-162)
- Modify: `test/helpers/build-optimize-pdf.ts:156` (`buildWholeFontPdf` gains a `post` option; add `buildSharedProgramPdf`)
- Test: `test/optimize.test.ts`

**Interfaces:**
- Consumes: `shrinkGlyf(font, keep, opts?)` and `ShrinkOptions` from Task 1; `doc.objectEntries()` (`src/document.ts:564`, `@internal`, yields `[PdfRef, PdfObject]`); the module-local `nameOf(doc, obj)`, `fontProgram(doc, font)`, `isDict`, `isStream`, `PdfStream` already present in `optimize.ts`.
- Produces: nothing consumed by a later task — this is the final task.

- [ ] **Step 1: Give `buildWholeFontPdf` a `post` option**

The Type0 fixture hardcodes `buildManyGlyphTtf(200)`, which defaults to a v3.0 `post` — nothing for the downgrade to drop. In `test/helpers/build-optimize-pdf.ts`, change line 155-157 from:

```ts
/** `content` defaults to showing CID 1 only (glyph 'A'); every other CID unused. */
export function buildWholeFontPdf(content = '<0001>'): Uint8Array {
  const ttf = buildManyGlyphTtf(200);
```

to:

```ts
/** `content` defaults to showing CID 1 only (glyph 'A'); every other CID unused.
 *  `over.post` overrides the font's post table, which defaults to v3.0. */
export function buildWholeFontPdf(content = '<0001>', over: { post?: Uint8Array } = {}): Uint8Array {
  const ttf = buildManyGlyphTtf(200, { post: over.post });
```

- [ ] **Step 2: Add the shared-program fixture**

Append to `test/helpers/build-optimize-pdf.ts`. This is the one shape where the veto has to look past the dict being shrunk: one `FontFile2`, reached by both a Type0 dict and a simple `/TrueType` dict through a shared `/FontDescriptor`.

```ts
/** A PDF where a Type0 dict (/F1) and a simple /TrueType dict (/F2) share one
 *  /FontDescriptor, and so one /FontFile2. The Type0 dict alone would license
 *  dropping the program's glyph names; the simple dict must veto it. */
export function buildSharedProgramPdf(): Uint8Array {
  const ttf = buildManyGlyphTtf(200, { post: buildPostV2(customGlyphNames(200)) });
  const objects = new Map<number, PdfObject>();

  objects.set(6, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')], ['Length1', ttf.length]]),
    raw: new Uint8Array(deflateSync(Buffer.from(ttf))),
  });

  // The shared descriptor: both font dicts below point at this one object.
  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestFont')],
    ['Flags', 32], ['FontBBox', [0, -200, 700, 800]], ['ItalicAngle', 0],
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

  objects.set(9, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('TrueType')],
    ['BaseFont', name('TestFont')],
    ['FirstChar', 65], ['LastChar', 66], ['Widths', [500, 600]],
    ['FontDescriptor', ref(7, 0)],
    ['Encoding', new Map<string, PdfObject>([['Differences', [65, name('g03')]]])],
  ]));

  const body = 'BT /F1 24 Tf 50 700 Td <0001> Tj ET BT /F2 24 Tf 50 650 Td (A) Tj ET';
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)], ['F2', ref(9, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));

  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}
```

Update that file's import on line 7 to pull in `buildPostV2`:

```ts
import { buildCmap, buildHead, buildName, buildOS2, buildPost, buildPostV2 } from './build-sfnt.js';
```

- [ ] **Step 3: Write the failing tests**

Add to `test/optimize.test.ts`. Extend the fixture import on line 6:

```ts
import { buildWholeFontPdf, buildSimpleTtfPdf, buildSharedProgramPdf, customGlyphNames } from './helpers/build-optimize-pdf.js';
```

The file's existing `embeddedProgram` helper resolves `/F1 -> /FontDescriptor`, which only works for a *simple* font — a Type0 dict has no `/FontDescriptor` of its own. Add a companion helper next to it:

```ts
/** The /FontFile2 of the document's Type0 font, reached through its descendant
 *  CIDFont — which is where a Type0's /FontDescriptor actually lives. */
function type0Program(doc: Document, key = 'F1'): PdfStream {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get(key)) as PdfDict;
  const descendants = doc.resolve(font.get('DescendantFonts')) as PdfObject[];
  const d0 = doc.resolve(descendants[0]) as PdfDict;
  const fd = doc.resolve(d0.get('FontDescriptor')) as PdfDict;
  const s = doc.resolve(fd.get('FontFile2'));
  if (!isStream(s)) throw new Error('no FontFile2');
  return s;
}
```

Then add this block:

```ts
describe('Optimize — post glyph names', () => {
  const namedPost = () => buildPostV2(customGlyphNames(200));

  it('drops post names from a Type0 program, which never resolves by name', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>', { post: namedPost() }));
    expect(parseSfnt(decodeStream(type0Program(doc))).postNames()![3]).toBe('g03');

    const report = doc.Optimize();
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].bytesSaved).toBeGreaterThan(0);   // strictly smaller

    const after = parseSfnt(decodeStream(type0Program(Document.Open(doc.Save()))));
    expect(after.postNames()).toBeUndefined();
    expect(after.table('post')!.length).toBe(32);   // v3.0 header only
    expect(after.numGlyphs).toBe(200);              // GID numbering still intact
  });

  it('preserves extracted text exactly when post names are dropped', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>', { post: namedPost() }));
    const before = doc.Pages[0].GetText();
    doc.Optimize();
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(before);
  });

  it('keeps post names on a program a simple font dict also reaches', () => {
    const doc = Document.Open(buildSharedProgramPdf());
    doc.Optimize();
    // /F2 is the simple dict; it shares /F1's descriptor, so either path finds
    // the same program.
    const after = parseSfnt(decodeStream(embeddedProgram(Document.Open(doc.Save()), 'F2')));
    expect(after.postNames()![3]).toBe('g03');
  });
});
```

The shared-program test resolves through `/F2`, so `embeddedProgram` needs the same `key` parameter `type0Program` has. Change its signature from `function embeddedProgram(doc: Document): PdfStream {` to:

```ts
function embeddedProgram(doc: Document, key = 'F1'): PdfStream {
```

and its `fonts.get('F1')` to `fonts.get(key)`. The default keeps every existing caller working.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/optimize.test.ts`
Expected: FAIL. `drops post names from a Type0 program` fails at `expect(after.postNames()).toBeUndefined()` — the names are still there, because nothing sets `dropGlyphNames` yet. (`preserves extracted text` and `keeps post names on a program a simple font dict also reaches` may already pass — they assert the *current* behavior of not dropping. They are guards, and they must stay green through Step 5.)

- [ ] **Step 5: Implement the veto set**

In `src/optimize.ts`, add above `shrinkOne` (before line 110):

```ts
/** Font subtypes that never resolve a glyph by name: a Type0 goes code -> CID ->
 *  GID through `/CIDToGIDMap` or a CFF charset.
 *
 *  The CIDFont descendants are excluded for the same reason, and excluding them
 *  is load-bearing rather than tidy: a Type0's `/FontDescriptor` hangs off its
 *  descendant, not off the Type0 dict itself (see `fontProgram`, which reaches it
 *  via `descendantOf`). A descendant is a `/Type /Font` dict with
 *  `/Subtype /CIDFontType2` — "not Type0" — so a rule that excluded only `Type0`
 *  would veto every Type0 program through its own descendant and quietly reduce
 *  this whole pass to a no-op. A descendant is only ever reachable through its
 *  Type0 parent, which already stands in for it (glyphusage.ts:382-388 documents
 *  the same trap for the usage scan). */
const NAME_FREE_SUBTYPES: ReadonlySet<string> = new Set(['Type0', 'CIDFontType0', 'CIDFontType2']);

/**
 * Font programs that some font dict could resolve glyphs by name against, and
 * whose `post` names must therefore survive. Any font dict outside
 * NAME_FREE_SUBTYPES vetoes its program — including an unrecognized `/Subtype`,
 * which vetoes by default.
 *
 * Keyed on the program, not the dict: a face embedded once and referenced by both
 * a Type0 dict and a simple dict keeps its names. `doc.resolve` hands back the
 * same PdfStream instance for a given ref, so set membership is exact.
 *
 * The scan walks the whole object graph rather than reading `collectGlyphUsage`'s
 * UsageMap, which would answer this today — its safety net already sweeps in every
 * unreached font dict. That reuse is declined on purpose: it would make this
 * veto's correctness a downstream effect of a net written for another purpose,
 * which a later change could narrow with no signal here and a silent, visual
 * failure. Call once, before any shrink: shrinkOne replaces the program stream,
 * which would strand these identities.
 */
function nameResolvingPrograms(doc: Document): Set<PdfStream> {
  const veto = new Set<PdfStream>();
  for (const [, obj] of doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(doc, obj.get('Type')) !== 'Font') continue;
    const subtype = nameOf(doc, obj.get('Subtype'));
    if (subtype !== undefined && NAME_FREE_SUBTYPES.has(subtype)) continue;
    const fd = doc.resolve(obj.get('FontDescriptor'));
    if (!isDict(fd)) continue;
    for (const key of ['FontFile2', 'FontFile3'] as const) {
      const s = doc.resolve(fd.get(key));
      if (isStream(s)) veto.add(s);
    }
  }
  return veto;
}
```

Change `shrinkOne`'s signature (lines 111-113) from:

```ts
function shrinkOne(
  doc: Document, font: PdfDict, gids: Set<number>,
): { result: ShrinkResult; bytesSaved: number } | { reason: string } {
```

to:

```ts
function shrinkOne(
  doc: Document, font: PdfDict, gids: Set<number>, nameResolving: ReadonlySet<PdfStream>,
): { result: ShrinkResult; bytesSaved: number } | { reason: string } {
```

Inside it, after the `decodeStream` try/catch (after line 119), add:

```ts
  const dropGlyphNames = !nameResolving.has(prog.stream);
```

and pass it to both `shrinkGlyf` calls (lines 124 and 131):

```ts
      result = shrinkGlyf(parseSfnt(plain), gids, { dropGlyphNames });
```

```ts
        result = shrinkGlyf(f, gids, { dropGlyphNames });
```

(The `shrinkCff` call on line 127 is untouched: a CFF program has no `post`.)

In `optimizeFonts`, add the veto build as the first statement and thread it through (lines 154-162):

```ts
function optimizeFonts(doc: Document, report: OptimizeReport): void {
  // Before any shrink: shrinkOne swaps in a new program stream, so identities
  // collected afterwards would not match.
  const nameResolving = nameResolvingPrograms(doc);
  const usage: UsageMap = collectGlyphUsage(doc);
  for (const [font, u] of usage) {
    const baseFont = baseFontOf(doc, font);
    if (!u.complete) {
      report.skipped.push({ baseFont, reason: u.reason ?? 'usage could not be determined' });
      continue;
    }
    const out = shrinkOne(doc, font, u.gids, nameResolving);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/optimize.test.ts`
Expected: PASS — including `keeps the cmap and post tables the code->GID chain runs through` (line 105) **unmodified**. If that one fails, the downgrade is firing on a simple font and the veto is wrong; fix the veto, do not touch the test.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS, whole suite.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/optimize.ts test/optimize.test.ts test/helpers/build-optimize-pdf.ts
git commit -m "feat(gfs): drop post glyph names only for Type0-reachable programs

A program reachable from any simple font dict keeps its names: a nonsymbolic
simple TrueType resolves /Differences names outside the AGL through post. The
veto is keyed on the program, so a face shared by a Type0 and a simple dict is
protected, and it excludes CIDFont descendants — a Type0's descriptor lives on
the descendant, so vetoing those would veto every Type0 program.

Closes aspose-pdf-foss-for-ts-gfs"
```

---

### Task 3: Documentation and issue close-out

Two documented claims go stale the moment Task 2 lands. Both are located and quoted below — no searching required.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-document-optimize-design.md:95-96` and `:275-276`
- Modify: `README.md:903`

**Interfaces:**
- Consumes: nothing. Documentation only.
- Produces: nothing.

- [ ] **Step 1: Retire the `doo` spec's "kept as-is" decision**

`docs/superpowers/specs/2026-07-15-document-optimize-design.md:95-96` currently reads:

```markdown
- **`post` is kept as-is.** Downgrading to version 3 drops glyph names (~40KB on
  a large face). Deferred rather than risked; noted as a future win.
```

Replace with:

```markdown
- **`post` was kept as-is in `doo`.** Downgrading to version 3 drops glyph names
  (~40KB on a large face). Deferred rather than risked. Taken up by `gfs`, which
  drops them only for programs reachable exclusively from Type0 dicts — see
  `docs/superpowers/specs/2026-07-15-post-v3-downgrade-design.md`.
```

- [ ] **Step 2: Retire the same spec's future-work bullet**

Lines 275-276 currently read:

```markdown
- **`post` table downgrade** to version 3 for fonts where glyph names are
  provably unused.
```

Replace with:

```markdown
- ~~**`post` table downgrade** to version 3 for fonts where glyph names are
  provably unused.~~ Done — `gfs`.
```

- [ ] **Step 3: Extend the README's Optimize limitation**

`README.md:903` ends the shrinking sentence with:

```
Shrinking preserves GID numbering, `cmap`, `/Widths`/`/W`, and `CIDToGIDMap` — nothing is renumbered — so a font program is left alone when the rewrite would not be strictly smaller.
```

Insert one sentence immediately after it, in the same bullet:

```
A `post` v2.0 glyph-name table is rewritten to v3.0 (names dropped) only for programs reachable exclusively from Type0 dicts, which resolve code→CID→GID and never consult a name; a program any simple font dict can reach keeps its names, since a nonsymbolic simple TrueType resolves `/Differences` names outside the Adobe Glyph List through `post`.
```

**Do not otherwise edit `README.md:903`.** That bullet's headline still claims "Optimize subsets Type0/Identity-H fonts only" and that simple TrueType is skipped, which commit `88dd3a8` already falsified. That staleness belongs to `4by` (still in progress), not to this change — correcting it here would collide with `4by`'s own README edit.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-15-document-optimize-design.md
git commit -m "docs(gfs): Optimize drops provably-unused glyph names"
```

- [ ] **Step 4: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-gfs
```

- [ ] **Step 5: Push**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Acceptance Criteria (from the issue)

- [x] `post` 2.0 rewritten to 3.0 where glyph names are provably unused → Task 2, Type0-reachable programs only.
- [x] Fonts that can resolve by name keep `post` intact → Task 2's veto set; guarded by `optimize.test.ts:105` and the shared-program test.
- [x] `GetText()` byte-identical before/after → Task 2, Step 3, `preserves extracted text exactly when post names are dropped`.
- [x] Full suite green → Task 2, Step 7.
