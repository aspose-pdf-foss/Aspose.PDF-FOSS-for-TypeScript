# Cross-operator and Ligature-aware Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `replaceText` rewrite a match that starts or ends inside a multi-character glyph (a ligature) without deleting the glyph's other characters, and clean up the positioning a cross-operator match leaves behind.

**Architecture:** `replaceText` stops planning from `TextMatch.hits` (whole glyphs) and plans at the CHARACTER level over the page's assembled `text`/`refs`, then writes one byte-range edit per touched glyph. A TJ kern strictly inside a match is dropped under a guard, and a `Tj` the edits emptied is removed. A prerequisite fix makes `layoutLines` emit one `refs` entry per UTF-16 code unit, so `refs[i]` lines up with `text[i]` when the page holds an astral character.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-ligature-aware-replace-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Import specifiers carry `.js`.
- Throw `UnsupportedFeatureError` (from `src/errors.ts`) for an unencodable character; a refused call leaves the document byte-identical.
- Operators outside a match stay byte-identical; an untouched glyph is never re-encoded.
- Every user-visible change gets a `CHANGELOG.md` entry under `## [Unreleased]` in the SAME commit, bold lead-in, prose, issue id `(u3l5.1)` at the end.
- `npm run typecheck` and `npm test` must both be green before the issue closes.
- Bash heredocs strip backslashes on this machine: write test files containing `\` escapes with the Write/Edit tools, not heredocs. Prefer hex strings (`<C86E65>`) over octal escapes in fixture content streams.

## Deviation from the spec, recorded

The spec's design step 2 ("one pass over `refs` gives each glyph its contiguous character range in `text`") silently assumes `refs[i]` describes `text[i]`. It does not today: `layoutOneDirection` (`src/text.ts:281`) pushes one ref per CODE POINT while `text` and `findRanges` index by CODE UNIT, so every position after an astral character is shifted by one. That affects `Search`, `ReplaceText`, `SearchAnnotations` and `CompareText`, which all index through `buildMatch`. Task 1 fixes it first; it is a user-visible fix and gets its own CHANGELOG entry.

## Review Focus

1. **A cleared glyph in a font that cannot encode** — a match anchored in a simple font that runs into a Type0 font must still succeed: the Type0 glyphs only lose their bytes and must never be passed to `encode`. Test in Task 2.
2. **An astral character before a match** — `Search`/`ReplaceText` must hit the glyphs that drew the match, not their neighbours. Test in Task 1.
3. **A multi-character glyph whose tail layout trimmed** — a glyph whose text ends in whitespace at a line end has that whitespace trimmed from `text`; replacing its leading characters must keep the trimmed tail. Test in Task 2.
4. **A match made only of spaces layout inserted** — no glyph drew it, so nothing may be edited and the content stays byte-identical. Test in Task 2.
5. **Stream order differing from reading order inside a TJ** — a kern between two matched elements with an UNMATCHED string between them in stream order must be kept. Test in Task 3.

---

## File Structure

- `src/text.ts` — Task 1 only: `layoutOneDirection` pushes a ref per code unit.
- `src/textedit.ts` — Tasks 2-4: `pageText` split out of `searchText`; `replaceText` rewritten around a character plan; kern dropping; emptied-`Tj` removal.
- `test/helpers/build-text-pdf.ts` — Task 2: add `buildMixedType0Pdf`.
- `test/search-astral.test.ts` — Task 1 (new).
- `test/text-replace-ligature.test.ts` — Tasks 2-4 (new).
- `test/text-replace.test.ts`, `test/replace-api.test.ts` — must pass unedited.
- `CHANGELOG.md` — Tasks 1, 2, 3, 4.
- `README.md`, `CLAUDE.md` — Task 5.

---

### Task 1: `refs` aligned with `text` per UTF-16 code unit

**Files:**
- Modify: `src/text.ts:281` (inside `layoutOneDirection`) and the doc comment above `layoutLines` (`src/text.ts:172-176`)
- Test: `test/search-astral.test.ts` (create)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `layoutLines(runs)` returns `{ text, refs }` with `refs.length === text.length` — `refs[i]` is the glyph that drew code unit `text[i]`. Tasks 2-3 rely on this.

- [ ] **Step 1: Write the failing test**

Create `test/search-astral.test.ts` with the Write tool:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { layoutLines } from '../src/text.js';
import { buildToUnicodePdf } from './helpers/build-text-pdf.js';

// Code 0x41 draws U+1D400 MATHEMATICAL BOLD CAPITAL A, two UTF-16 code units.
const CMAP = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
  '7 beginbfchar <41> <D835DC00> <48> <0048> <61> <0061> <65> <0065> <6C> <006C> <6F> <006F> <20> <0020> endbfchar\n';
const astralDoc = () => Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <4148656C6C6F> Tj ET', CMAP));

describe('layoutLines refs are per UTF-16 code unit', () => {
  it('gives an astral character one ref per code unit', () => {
    const { text, refs } = layoutLines([
      { x: 0, endX: 5, y: 0, text: '\u{1D400}', size: 10, ref: 1 },
      { x: 5, endX: 10, y: 0, text: 'b', size: 10, ref: 2 },
    ]);
    expect(text).toBe('\u{1D400}b');
    expect(refs).toEqual([1, 1, 2]);
  });

  it('Search hits the glyphs that drew a match after an astral character', () => {
    const doc = astralDoc();
    expect(doc.Pages[0].GetText()).toBe('\u{1D400}Hello');
    const [m] = doc.Pages[0].Search('Hello');
    expect(m.text).toBe('Hello');
    expect(m.hits.map((h) => h.text).join('')).toBe('Hello');
  });

  it('ReplaceText rewrites the right glyphs after an astral character', () => {
    const doc = astralDoc();
    expect(doc.Pages[0].ReplaceText('Hello', 'Hallo')).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('\u{1D400}Hallo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search-astral.test.ts`
Expected: FAIL, all 3. The first case gets `[1, 2]`; the Search case's hits join to `ello` (every ref one glyph late, the last one an inserted `undefined`); the replace case does not produce `𝐀Hallo`.

- [ ] **Step 3: Write minimal implementation**

In `src/text.ts`, inside `layoutOneDirection`, replace

```ts
      for (const ch of r.text) { chars.push(ch); refs.push(r.ref); }
```

with

```ts
      // One ref per UTF-16 CODE UNIT, not per code point: `text` is indexed by
      // code unit (findRanges, buildMatch, compare.ts), so a per-code-point
      // ref list falls one behind after every astral character.
      for (const ch of r.text) {
        chars.push(ch);
        for (let u = 0; u < ch.length; u++) refs.push(r.ref);
      }
```

Then extend the doc comment directly above `export function layoutLines` with this paragraph (keep the existing text):

```ts
 *  **Invariant:** `refs.length === text.length` — `refs[i]` is the glyph that
 *  drew code unit `text[i]`, `undefined` for a space or line break inserted
 *  here. An astral character gets TWO entries. Every consumer indexes `text`
 *  by code unit, and one entry per code point put every later match on the
 *  wrong glyphs.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/search-astral.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the consumers' suites**

Run: `npx vitest run test/text-replace.test.ts test/replace-api.test.ts test/search-region.test.ts test/annot-search.test.ts test/compare-text.test.ts`
(If a file name does not exist, drop it; `ls test | grep -i "compare\|annot-search"` lists the right ones.)
Expected: PASS.

- [ ] **Step 6: Mutation check**

Revert the inner loop to `refs.push(r.ref)` once per code point, run `npx vitest run test/search-astral.test.ts`, confirm 3 FAIL, then restore. Record the count for Task 5.

- [ ] **Step 7: CHANGELOG**

Under `## [Unreleased]`, add a `### Fixed` section if none exists (after `### Added`), with:

```markdown
- **Search and replace hit the right glyphs after an emoji or other astral character.** The page text is indexed by UTF-16 code unit, but the list saying which glyph drew each character had one entry per code point, so every position after a character outside the Basic Multilingual Plane (an emoji, a mathematical alphanumeric) pointed at the next glyph. `Search` then reported the wrong glyphs and quads, `ReplaceText` rewrote the wrong bytes, and `SearchAnnotations` and `CompareText` placed their boxes one glyph late. Each code unit now has its own entry. (u3l5.1)
```

- [ ] **Step 8: Commit**

```bash
git add src/text.ts test/search-astral.test.ts CHANGELOG.md
git commit -m "fix(u3l5.1): layout refs per UTF-16 code unit"
```
(End the message with the `Co-Authored-By` trailer from the session instructions.)

---

### Task 2: Character-level replace plan

**Files:**
- Modify: `src/textedit.ts:64-87` (`searchText`) and `src/textedit.ts:141-215` (S2 section, `replaceText`)
- Modify: `test/helpers/build-text-pdf.ts` (add `buildMixedType0Pdf` after `buildType0Pdf`)
- Test: `test/text-replace-ligature.test.ts` (create)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1's `refs.length === text.length`.
- Produces (internal to `textedit.ts`, used by Tasks 3-4):
  - `function pageText(doc: Document, page: Page, opts: SearchOptions): { text: string; refs: (GlyphEvent | undefined)[] }`
  - `interface StreamEdits { addr: ContentAddr; perOp: Map<number, StrEdit[]> }` — Task 3 adds a `kerns` field.
  - `function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>): void` — the write phase, which Tasks 3-4 extend.
- Public API unchanged: `replaceText(doc, page, find, replacement, opts?): number`, `searchText`, `TextMatch`.

- [ ] **Step 1: Add the mixed-font builder**

In `test/helpers/build-text-pdf.ts`, after `buildType0Pdf`, add:

```ts
/** Page with a simple Helvetica `/F1` AND a Type0 Identity-H `/F2` carrying
 *  `cmap` as its `/ToUnicode`: one line may switch between a font that can
 *  re-encode text and one that cannot. */
export function buildMixedType0Pdf(stream: string, cmap: string): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    6: `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Foo /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 7 0 R >>`,
    7: contentObj(cmap),
    8: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Foo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>`,
  };
  return serialize(objects, 8);
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/text-replace-ligature.test.ts` with the Write tool:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { replaceText } from '../src/textedit.js';
import { parseContentStream } from '../src/content.js';
import { isString } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildToUnicodePdf, buildMixedType0Pdf, buildSimpleTextPdf } from './helpers/build-text-pdf.js';

// Code 0xC8 is ONE glyph drawing two characters, `fi` — the shape a real
// ligature takes. (A `/Differences` `/fi` fixture would not do: this library's
// glyph-name table has no `fi`, so it decodes to nothing.)
const LIG_CMAP = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
  '8 beginbfchar <C8> <00660069> <6E> <006E> <65> <0065> <6F> <006F> <78> <0078> <61> <0061> <62> <0062> <20> <0020> endbfchar\n';
export const ligDoc = (stream: string) => Document.Open(buildToUnicodePdf(stream, LIG_CMAP));
export const textOf = (doc: Document) => doc.Pages[0].GetText();
export const opsOf = (doc: Document) => parseContentStream(doc.Pages[0].Contents);
/** The bytes of every show string on the page, in stream order, as latin1. */
export const shown = (doc: Document): string[] => opsOf(doc).flatMap((op) => {
  const strs = op.operator === 'TJ' ? (op.operands[0] as unknown[]) : op.operands;
  return strs.filter(isString).map((s) => String.fromCharCode(...s.bytes));
});

describe('replaceText inside a ligature', () => {
  it('keeps the ligature characters before the match', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET');   // "fine"
    expect(textOf(doc)).toBe('fine');
    expect(replaceText(doc, doc.Pages[0], 'ine', 'one')).toBe(1);
    expect(textOf(doc)).toBe('fone');
  });

  it('keeps the ligature characters after the match', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET');
    expect(replaceText(doc, doc.Pages[0], 'f', 'x')).toBe(1);
    expect(textOf(doc)).toBe('xine');
  });

  it('keeps residue on both sides of a match spanning two ligatures', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <6FC8C878> Tj ET');   // "ofifix"
    expect(textOf(doc)).toBe('ofifix');
    expect(replaceText(doc, doc.Pages[0], 'ifi', 'eee')).toBe(1);
    expect(textOf(doc)).toBe('ofeeeix');
  });

  it('merges two matches inside one ligature into one edit', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET');
    expect(replaceText(doc, doc.Pages[0], /[fi]/, 'a')).toBe(2);
    expect(textOf(doc)).toBe('aane');
  });

  it('replaces a ligature covered exactly, leaving its neighbours byte-identical', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td <6FC878> Tj ET');     // "ofix"
    expect(replaceText(doc, doc.Pages[0], 'fi', 'ab')).toBe(1);
    expect(textOf(doc)).toBe('oabx');
    expect(shown(doc)).toEqual(['oabx']);
  });

  it('keeps a glyph tail that layout trimmed at the line end', () => {
    // 0xD0 draws "a " — its trailing space is trimmed from the line's text.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '2 beginbfchar <D0> <00610020> <62> <0062> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <62D0> Tj ET', cmap));
    expect(textOf(doc)).toBe('ba');
    expect(replaceText(doc, doc.Pages[0], 'a', 'b')).toBe(1);
    expect(shown(doc)).toEqual(['bb ']);
  });

  it('throws on an unencodable residue and leaves the document byte-identical', () => {
    // 0xC9 draws "ſt"; WinAnsi has no ſ (U+017F), so the residue cannot encode.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '1 beginbfchar <C9> <017F0074> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <C9> Tj ET', cmap));
    const before = doc.Save();
    expect(() => replaceText(doc, doc.Pages[0], 't', 'x')).toThrow(UnsupportedFeatureError);
    expect(() => replaceText(doc, doc.Pages[0], 't', 'x')).toThrow(/ſ/);
    expect(doc.Save()).toEqual(before);
  });

  it('never encodes a cleared glyph, so a match running into a Type0 font succeeds', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <006C> <0004> <006F> endbfchar\n';
    const doc = Document.Open(buildMixedType0Pdf(
      'BT /F1 12 Tf 20 250 Td (Hel) Tj /F2 12 Tf <00030004> Tj ET', cmap));
    expect(textOf(doc)).toBe('Hello');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(textOf(doc)).toBe('Bye');
  });

  it('puts the replacement on the first real glyph when a match starts on an inserted space', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td (ab) Tj 40 0 Td (ab) Tj ET');
    expect(replaceText(doc, doc.Pages[0], ' ab', 'X')).toBe(1);
    expect(shown(doc)).toEqual(['ab', 'X']);
  });

  it('edits nothing for a match made only of spaces layout inserted', () => {
    const doc = ligDoc('BT /F1 12 Tf 20 250 Td (ab) Tj 40 0 Td (ab) Tj ET');
    expect(textOf(doc)).toBe('ab ab');
    const before = doc.Pages[0].Contents;
    replaceText(doc, doc.Pages[0], ' ', 'X');
    expect(doc.Pages[0].Contents).toEqual(before);
  });
});
```

Note `/[fi]/` has no `g` flag on purpose: `findRanges` applies a RegExp globally regardless.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/text-replace-ligature.test.ts`
Expected: FAIL on the three residue cases (`one`, `xne`, `oeeex`), the two-matches case, the trimmed-tail case and the unencodable-residue case (no throw: the residue is deleted instead). The exact-cover, Type0, anchor and inserted-space cases may already pass; they are regression fences for the rewrite.

- [ ] **Step 4: Split `pageText` out of `searchText`**

In `src/textedit.ts`, replace the body of `searchText` (lines 64-87) with a call to a new `pageText`, placed directly above `searchText`:

```ts
/** The page's assembled text and, per UTF-16 code unit, the glyph that drew
 *  it (`undefined` for a space or line break layout inserted). The ONE layout
 *  `Search` and `ReplaceText` read, so the two cannot disagree about where a
 *  match is. */
function pageText(
  doc: Document, page: Page, opts: SearchOptions,
): { text: string; refs: (GlyphEvent | undefined)[] } {
  const runs: RefRun<GlyphEvent>[] = [];
  const region = opts.region;
  visitContent(doc, page, {
    glyph: (e) => {
      if (!e.text) return;
      if (region && !centroidIn(region, e.quad)) return;
      runs.push(runFromGlyph(e, e));
    },
  }, walkOpts(opts));
  return layoutLines(runs);
}
```

and `searchText` (keep its existing doc comment) becomes:

```ts
export function searchText(
  doc: Document, page: Page, find: string | RegExp, opts: SearchOptions = {},
): TextMatch[] {
  const { text, refs } = pageText(doc, page, opts);
  if (text.length === 0) return [];
  return findRanges(text, find).map(([start, end]) => buildMatch(text, refs, start, end));
}
```

- [ ] **Step 5: Rewrite `replaceText` around the character plan**

Replace everything from `const EMPTY = new Uint8Array(0);` through the end of `replaceText` (keep `spliceShowOp` and `spliceElement` as they are) with:

```ts
const EMPTY = new Uint8Array(0);

/** A byte-range edit on one show string: replace [start,end) with `insert`. */
interface StrEdit { elementIndex: number; start: number; end: number; insert: Uint8Array; }

/** Every edit planned for one content stream, keyed by operator index. */
interface StreamEdits { addr: ContentAddr; perOp: Map<number, StrEdit[]> }

function streamKey(addr: ContentAddr): string {
  return `${addr.path.join('\0')}${addr.streamIndex}`;
}

/** Replace every occurrence of `find` with `replacement`, written in place
 *  through the F1 op-list. No layout reflow: positioning operators are
 *  preserved, so a wider replacement may overlap and a narrower one may leave
 *  a gap. Returns the number of occurrences found.
 *
 *  **Invariant (u3l5.1):** the edit is planned per CHARACTER and written per
 *  GLYPH. A glyph may draw several characters — a ligature draws `fi` — so a
 *  glyph-level plan deletes the half of a ligature outside the match. Each
 *  touched glyph is rewritten as the characters no match covers, with each
 *  match's replacement emitted at that match's ANCHOR: the first position in
 *  it a real glyph drew. A match spanning several show strings therefore puts
 *  its whole replacement in the string where it starts, and the others only
 *  lose their matched glyphs. Several matches inside one glyph become ONE edit.
 *
 *  **Invariant:** everything is encoded before anything is edited, so a
 *  refused call leaves the document byte-identical. A replacement is encoded
 *  in its anchor glyph's font, residue in its own glyph's font, and a glyph
 *  left with no characters is never encoded at all — its font may be one that
 *  cannot encode (Type0). Throws {@link UnsupportedFeatureError} for a Type0
 *  anchor or any character the font cannot represent, residue included. */
export function replaceText(
  doc: Document, page: Page, find: string | RegExp, replacement: string,
  opts: SearchOptions = {},
): number {
  // An EDIT acts on what the file CONTAINS. Rewriting only the occurrences a
  // viewer is currently shown would leave the rest behind, so a caller's own
  // `includeHidden` cannot narrow this below true.
  const { text, refs } = pageText(doc, page, { ...opts, includeHidden: true });
  const ranges = text.length === 0 ? [] : findRanges(text, find);
  if (ranges.length === 0) return 0;

  // The character plan: which positions a match covers, and where each
  // match's replacement is emitted.
  const covered = new Uint8Array(text.length);
  const insertAt = new Map<number, string>();
  for (const [s, e] of ranges) {
    let anchor = s;
    while (anchor < e && refs[anchor] === undefined) anchor++;
    if (anchor === e) continue;   // only characters layout inserted: no ink to rewrite
    covered.fill(1, s, e);
    insertAt.set(anchor, replacement);
  }

  // Each glyph's contiguous span of positions in `text`.
  const spans = new Map<GlyphEvent, [number, number]>();
  refs.forEach((g, i) => {
    if (!g) return;
    const sp = spans.get(g);
    if (sp) sp[1] = i + 1; else spans.set(g, [i, i + 1]);
  });

  const streams = new Map<string, StreamEdits>();
  const editsFor = (addr: ContentAddr): StrEdit[] => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, perOp: new Map() }; streams.set(sk, s); }
    let edits = s.perOp.get(addr.opIndex);
    if (!edits) { edits = []; s.perOp.set(addr.opIndex, edits); }
    return edits;
  };

  for (const [g, [gs, ge]] of spans) {
    let touched = false;
    for (let p = gs; p < ge && !touched; p++) touched = covered[p] === 1;
    if (!touched) continue;
    let out = '';
    for (let p = gs; p < ge; p++) {
      const ins = insertAt.get(p);
      if (ins !== undefined) out += ins;
      if (!covered[p]) out += text[p];
    }
    // Layout trims whitespace at a line's end, so a glyph's span may be only a
    // PREFIX of its text; the trimmed tail is unmatched and is kept.
    out += g.text.slice(ge - gs);
    editsFor(g.addr).push({
      elementIndex: g.elementIndex, start: g.byteStart, end: g.byteStart + g.byteLen,
      insert: out === '' ? EMPTY : g.font.encode(out),
    });
  }

  applyEdits(doc, page, streams.values());
  return ranges.length;
}

/** Write the planned edits through one `EditableContent` and commit it. */
function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>): void {
  const ec = new EditableContent(doc, page);
  let any = false;
  for (const { addr, perOp } of streams) {
    any = true;
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const out = ops.map((op, i) => { const e = perOp.get(i); return e ? spliceShowOp(op, e) : op; });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  if (any) ec.commit();
}
```

The `if (any)` guard skips a commit with nothing to write. It is defensive: `EditableContent.commit` may already be a no-op when no stream was set, in which case its mutation below stays green — record that rather than writing a test for it.

- [ ] **Step 6: Run the new and old tests**

Run: `npx vitest run test/text-replace-ligature.test.ts test/text-replace.test.ts test/replace-api.test.ts test/search-astral.test.ts test/search-region.test.ts`
Expected: PASS, with `test/text-replace.test.ts` and `test/replace-api.test.ts` UNEDITED. A failing case is fixed in `src/`, never by editing the test.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (The old `TextMatch`-based loop removed the only use of `buildMatch` inside `replaceText`; `buildMatch` stays exported for `annotsearch.ts`/`compare.ts`.)

- [ ] **Step 8: Mutation checks**

One at a time, each followed by `npx vitest run test/text-replace-ligature.test.ts` and a restore. Confirm each reddens and record the counts for Task 5:
1. Drop the residue: change `if (!covered[p]) out += text[p];` to `if (false) out += text[p];`.
2. Drop the trimmed tail: delete `out += g.text.slice(ge - gs);`.
3. Encode empties: change `insert: out === '' ? EMPTY : g.font.encode(out)` to `insert: g.font.encode(out)`.
4. Anchor on the match start: change `insertAt.set(anchor, replacement)` to `insertAt.set(s, replacement)`. Expect exactly the inserted-space anchor case to redden (the replacement is lost).
5. Remove the `if (any)` guard in `applyEdits`. May stay green (see Step 5); record either way.

- [ ] **Step 9: CHANGELOG**

Under `### Fixed`:

```markdown
- **Replacing part of a ligature keeps the rest of it.** A glyph can draw several characters — a `fi` ligature is one glyph whose text is two letters — and `ReplaceText` treated each glyph as all-or-nothing, so replacing `ine` in `fine` produced `one`, replacing `f` produced `xne`, and two matches inside one ligature both rewrote the same bytes. The replacement is now planned per character and written per glyph: a touched glyph becomes the characters no match covers, with each replacement where its match starts, re-encoded in that glyph's font. Glyphs no match touches keep their bytes exactly. A leftover character the font cannot encode is refused with `UnsupportedFeatureError` before anything changes, rather than silently dropped. A match consisting only of a space that layout inserted between two text runs no longer rewrites the content stream at all. (u3l5.1)
```

- [ ] **Step 10: Commit**

```bash
git add src/textedit.ts test/helpers/build-text-pdf.ts test/text-replace-ligature.test.ts CHANGELOG.md
git commit -m "fix(u3l5.1): ligature-aware replace plans per character"
```
(With the `Co-Authored-By` trailer.)

---

### Task 3: Drop a TJ kern strictly inside a match

**Files:**
- Modify: `src/textedit.ts` (`StreamEdits`, `replaceText`'s plan, `applyEdits`, `spliceShowOp`)
- Test: `test/text-replace-ligature.test.ts` (append a `describe`)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2's `StreamEdits`, `spans`, `streamKey`, `applyEdits`, `spliceShowOp(op, edits)`.
- Produces:
  - `interface KernSpan { lo: number; hi: number; matched: Map<number, number> }` — one match's first and last element index in one TJ, and per element the bytes of glyphs wholly inside that match.
  - `StreamEdits` gains `kerns: Map<number, KernSpan[]>`.
  - `spliceShowOp(op: ContentOp, edits: StrEdit[], kerns: KernSpan[]): ContentOp`
  - `function droppedKerns(arr: PdfObject[], spans: KernSpan[]): Set<number>`

- [ ] **Step 1: Write the failing tests**

Append to `test/text-replace-ligature.test.ts`:

```ts
/** Plain Helvetica WinAnsi: the kern and operator cases need no ligature. */
const plainDoc = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
/** The first TJ's array on the page. */
const tjArray = (doc: Document): unknown[] =>
  opsOf(doc).find((op) => op.operator === 'TJ')!.operands[0] as unknown[];
const numbersIn = (arr: unknown[]) => arr.filter((x) => typeof x === 'number');

describe('replaceText kerns inside a match', () => {
  it('drops a kern between two matched elements', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(Hel) -50 (lo)] TJ ET');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'World')).toBe(1);
    expect(textOf(doc)).toBe('World');
    expect(numbersIn(tjArray(doc))).toEqual([]);
  });

  it('keeps a kern after the match', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(Hello) -50 (X)] TJ ET');
    replaceText(doc, doc.Pages[0], 'Hello', 'Bye');
    expect(numbersIn(tjArray(doc))).toEqual([-50]);
  });

  it('keeps kerns when an unmatched string sits between matched ones in stream order', () => {
    // Helvetica 12pt: (lo) at 20..29.336; -2000 moves Z to 53.336..60.668;
    // 4889 moves (Hel) back to 2.0..20.0. Reading order is "Hel"+"lo", then Z.
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td [(lo) -2000 (Z) 4889 (Hel)] TJ ET');
    expect(textOf(doc)).toBe('Hello Z');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(numbersIn(tjArray(doc))).toEqual([-2000, 4889]);
    expect(textOf(doc)).toContain('Z');
  });
});
```

`plainDoc` is Helvetica WinAnsi with no `/Widths`, so advances come from the AFM tables the geometry below is computed from. If `textOf` of the third fixture is not `Hello Z`, the fixture geometry is off — fix the numbers, not the code.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/text-replace-ligature.test.ts -t "kerns inside"`
Expected: the first case FAILS (kern `-50` still present); the other two pass already (nothing drops kerns yet) and become fences.

- [ ] **Step 3: Implement**

In `src/textedit.ts`:

(a) Add the type and extend `StreamEdits`:

```ts
/** One match's reach into one TJ: its first and last string element, and per
 *  element the bytes of glyphs lying WHOLLY inside that match. */
interface KernSpan { lo: number; hi: number; matched: Map<number, number> }

/** Every edit planned for one content stream, keyed by operator index. */
interface StreamEdits { addr: ContentAddr; perOp: Map<number, StrEdit[]>; kerns: Map<number, KernSpan[]> }
```

(b) In `replaceText`, collect the anchored ranges, initialise `kerns` in `editsFor`'s stream creation, and record a `KernSpan` per match per op. Change the plan loop to:

```ts
  const anchored: [number, number][] = [];
  for (const [s, e] of ranges) {
    let anchor = s;
    while (anchor < e && refs[anchor] === undefined) anchor++;
    if (anchor === e) continue;   // only characters layout inserted: no ink to rewrite
    covered.fill(1, s, e);
    insertAt.set(anchor, replacement);
    anchored.push([s, e]);
  }
```

replace `editsFor` with a `streamFor` helper used by both edits and kerns:

```ts
  const streams = new Map<string, StreamEdits>();
  const streamFor = (addr: ContentAddr): StreamEdits => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, perOp: new Map(), kerns: new Map() }; streams.set(sk, s); }
    return s;
  };
  const editsFor = (addr: ContentAddr): StrEdit[] => {
    const { perOp } = streamFor(addr);
    let edits = perOp.get(addr.opIndex);
    if (!edits) { edits = []; perOp.set(addr.opIndex, edits); }
    return edits;
  };
```

and after the glyph loop, before `applyEdits`:

```ts
  // **Invariant (u3l5.1):** a TJ kern is dropped only when it lies between ONE
  // match's first and last string elements in that TJ AND every string element
  // between them is wholly matched by that match. Reading order comes from
  // layout, which sorts by position, so it can differ from stream order — and
  // a kern that positions text OUTSIDE the match must survive.
  for (const [s, e] of anchored) {
    const perOp = new Map<string, { addr: ContentAddr; span: KernSpan }>();
    for (let p = s; p < e; p++) {
      const g = refs[p];
      if (!g) continue;
      const [gs, ge] = spans.get(g)!;
      if (p !== Math.max(gs, s)) continue;   // count each glyph once
      const key = `${streamKey(g.addr)}|${g.addr.opIndex}`;
      let o = perOp.get(key);
      if (!o) { o = { addr: g.addr, span: { lo: g.elementIndex, hi: g.elementIndex, matched: new Map() } }; perOp.set(key, o); }
      const { span } = o;
      span.lo = Math.min(span.lo, g.elementIndex);
      span.hi = Math.max(span.hi, g.elementIndex);
      if (gs >= s && ge <= e) span.matched.set(g.elementIndex, (span.matched.get(g.elementIndex) ?? 0) + g.byteLen);
    }
    for (const { addr, span } of perOp.values()) {
      if (span.hi - span.lo < 2) continue;   // adjacent elements: nothing between them
      const { kerns } = streamFor(addr);
      const list = kerns.get(addr.opIndex);
      if (list) list.push(span); else kerns.set(addr.opIndex, [span]);
    }
  }
```

A glyph is counted once, at its first position inside the match (`Math.max(gs, s)`: a ligature that starts before the match is first seen at `s`).

(c) `applyEdits` applies kerns too:

```ts
function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>): void {
  const ec = new EditableContent(doc, page);
  let any = false;
  for (const { addr, perOp, kerns } of streams) {
    any = true;
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const out = ops.map((op, i) => {
      const e = perOp.get(i), k = kerns.get(i);
      return e || k ? spliceShowOp(op, e ?? [], k ?? []) : op;
    });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  if (any) ec.commit();
}
```

(d) `spliceShowOp` gains `kerns` and the TJ case drops them:

```ts
/** Apply byte-range edits to a show op's string operand(s), keeping operator and
 *  (for `"`) the spacing operands intact. In a `TJ`, a numeric kern is kept
 *  unless `kerns` places it strictly inside a match. */
function spliceShowOp(op: ContentOp, edits: StrEdit[], kerns: KernSpan[]): ContentOp {
  switch (op.operator) {
    case 'Tj': return { operator: 'Tj', operands: [spliceElement(op.operands[0], edits, 0)] };
    case "'": return { operator: "'", operands: [spliceElement(op.operands[0], edits, 0)] };
    case '"': return { operator: '"', operands: [op.operands[0], op.operands[1], spliceElement(op.operands[2], edits, 0)] };
    case 'TJ': {
      const arr = op.operands[0];
      if (!isArray(arr)) return op;
      const drop = droppedKerns(arr, kerns);
      const out: PdfObject[] = [];
      arr.forEach((el, idx) => {
        if (drop.has(idx)) return;
        out.push(isString(el) ? spliceElement(el, edits, idx) : el);
      });
      return { operator: 'TJ', operands: [out] };
    }
    default: return op;
  }
}

/** The numeric elements of a TJ array lying strictly inside one match whose
 *  every string element in between is wholly matched (see `replaceText`). */
function droppedKerns(arr: PdfObject[], spans: KernSpan[]): Set<number> {
  const drop = new Set<number>();
  for (const { lo, hi, matched } of spans) {
    let whole = true;
    for (let j = lo + 1; j < hi && whole; j++) {
      const el = arr[j];
      if (isString(el) && el.bytes.length > 0 && matched.get(j) !== el.bytes.length) whole = false;
    }
    if (!whole) continue;
    for (let j = lo + 1; j < hi; j++) if (!isString(arr[j])) drop.add(j);
  }
  return drop;
}
```

Note the `lo`/`hi` bounds use `hi - lo < 2` to skip: with the first test's `[(Hel) -50 (lo)]`, `lo = 0`, `hi = 2`, and element 1 is the kern.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/text-replace-ligature.test.ts test/text-replace.test.ts test/replace-api.test.ts`
Expected: PASS. `test/text-replace.test.ts`'s "spans two TJ array elements" case must still pass unedited (it now also drops its `-50`; it asserts only text).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Mutation checks**

Each followed by `npx vitest run test/text-replace-ligature.test.ts -t "kerns inside"` and a restore; record counts:
1. Remove the guard: make `droppedKerns` skip the `whole` loop (always drop).  Expect the stream-order case to redden.
2. Never drop: `return new Set()` at the top of `droppedKerns`. Expect the first case to redden.
3. Count glyphs not wholly inside the match as matched: drop the `gs >= s && ge <= e` condition. Expect nothing to redden on these fixtures (every glyph in them is single-character); record it as covered only by reasoning — do NOT write a test that merely exercises the mutation.

- [ ] **Step 7: CHANGELOG**

Under `### Changed`:

```markdown
- **`ReplaceText` drops the kerning between glyphs it replaced.** When a match spans several elements of one `TJ` array, a kerning number between two of those elements adjusted the spacing of glyphs that no longer exist, and it stayed behind after the replacement: `[(Hel) -50 (lo)] TJ` became `[(World) -50 ()] TJ`. Such a number is now removed. It is removed only when every string between the match's first and last element is wholly part of the match, because layout orders text by position and a `TJ` can draw it out of order — a kerning number that positions text outside the match is always kept. Kerns before and after a match, and every line and text-matrix operator, are untouched. (u3l5.1)
```

- [ ] **Step 8: Commit**

```bash
git add src/textedit.ts test/text-replace-ligature.test.ts CHANGELOG.md
git commit -m "feat(u3l5.1): drop a TJ kern strictly inside a replaced match"
```
(With the `Co-Authored-By` trailer.)

---

### Task 4: Remove a `Tj` the edits emptied

**Files:**
- Modify: `src/textedit.ts` (`applyEdits`, new `emptiedTj`)
- Test: `test/text-replace-ligature.test.ts` (append a `describe`)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 3's `applyEdits`, `spliceShowOp(op, edits, kerns)`.
- Produces: `function emptiedTj(before: ContentOp, after: ContentOp): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/text-replace-ligature.test.ts`:

```ts
describe('replaceText removes an emptied Tj', () => {
  it('removes a Tj whose whole string was cleared', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td (Hel) Tj (lo) Tj ET');
    expect(replaceText(doc, doc.Pages[0], 'Hello', 'Bye')).toBe(1);
    expect(opsOf(doc).filter((op) => op.operator === 'Tj')).toHaveLength(1);
    expect(textOf(doc)).toBe('Bye');
  });

  it('removes an emptied Tj even when it held the anchor', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td (Hello) Tj ET');
    replaceText(doc, doc.Pages[0], 'Hello', '');
    expect(opsOf(doc).map((op) => op.operator)).toEqual(['BT', 'Tf', 'Td', 'ET']);
  });

  it('keeps an emptied TJ and an emptied quote operator, which still move the pen', () => {
    const doc = plainDoc("BT /F1 12 Tf 14 TL 20 250 Td [(Hel) -50 (lo)] TJ (ab) ' ET");
    replaceText(doc, doc.Pages[0], 'Hello', '');
    replaceText(doc, doc.Pages[0], 'ab', '');
    const ops = opsOf(doc).map((op) => op.operator);
    expect(ops).toContain('TJ');
    expect(ops).toContain("'");
  });

  it('leaves a Tj that was already empty alone', () => {
    const doc = plainDoc('BT /F1 12 Tf 20 250 Td () Tj (Hello) Tj ET');
    replaceText(doc, doc.Pages[0], 'Hello', 'Bye');
    expect(opsOf(doc).filter((op) => op.operator === 'Tj')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/text-replace-ligature.test.ts -t "emptied Tj"`
Expected: the first two cases FAIL (an empty `() Tj` remains); the last two pass and are fences.

- [ ] **Step 3: Implement**

In `applyEdits`, build the op list with a loop that skips an emptied `Tj`:

```ts
    const out: ContentOp[] = [];
    ops.forEach((op, i) => {
      const e = perOp.get(i), k = kerns.get(i);
      if (!e && !k) { out.push(op); return; }
      const next = spliceShowOp(op, e ?? [], k ?? []);
      if (!emptiedTj(op, next)) out.push(next);
    });
```

and add below `applyEdits`:

```ts
/** True when the edits emptied a `Tj` that drew something. Such a `Tj` draws
 *  nothing and moves the pen by nothing, so it is removed — every planned op
 *  index was taken from the ORIGINAL list, and the removal happens while that
 *  list is copied, so no index is invalidated. A `TJ` is kept even when every
 *  string empties, since its kerns still move the pen, and `'`/`"` are kept
 *  because they move to the next line. A `Tj` that was already empty is not
 *  ours to remove. */
function emptiedTj(before: ContentOp, after: ContentOp): boolean {
  if (before.operator !== 'Tj') return false;
  const b = before.operands[0], a = after.operands[0];
  return isString(b) && b.bytes.length > 0 && isString(a) && a.bytes.length === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/text-replace-ligature.test.ts test/text-replace.test.ts test/replace-api.test.ts test/search-astral.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation checks**

Each followed by `npx vitest run test/text-replace-ligature.test.ts -t "emptied Tj"` and a restore; record counts:
1. Remove every emptied show op: drop the `before.operator !== 'Tj'` test. Expect the TJ/quote case to redden.
2. Drop `b.bytes.length > 0`. Expect GREEN: a `Tj` with no bytes has no glyphs, so no edit can reach it and `emptiedTj` is never asked about it. The guard is held by construction; record it as such, and do not cite the already-empty case as covering it (that case is a fence for the op-list copy).
3. Never remove: `return false` at the top. Expect the first two cases to redden.

- [ ] **Step 6: CHANGELOG**

Under `### Changed`:

```markdown
- **`ReplaceText` removes a `Tj` it emptied.** When a match spans several show operators, the replacement goes into the operator where the match starts and the others only lose their matched text; one that lost everything used to stay behind as `() Tj`. A `Tj` emptied this way draws nothing and moves nothing, so it is now removed. A `TJ` is kept even when emptied, since its kerning numbers still move the pen, and so are `'` and `"`, which move to the next line. A `Tj` that was already empty before the replace is left alone. (u3l5.1)
```

- [ ] **Step 7: Commit**

```bash
git add src/textedit.ts test/text-replace-ligature.test.ts CHANGELOG.md
git commit -m "feat(u3l5.1): remove a Tj the replacement emptied"
```
(With the `Co-Authored-By` trailer.)

---

### Task 5: Documentation, full verification, close

**Files:**
- Modify: `README.md:187` (Text replace bullet) and `README.md:3835` (API row) if their wording needs it
- Modify: `CLAUDE.md` (the `**textedit.ts**` paragraph under `text.ts`)

- [ ] **Step 1: README**

In the **Text replace** bullet (`README.md:187`), after "...edits the content stream directly.", insert:

```markdown
A match may start or end inside a glyph that draws several characters — a `fi` ligature — and only the matched characters change: the rest of that glyph is re-encoded beside the replacement. A match spanning several show operators puts its replacement where it starts; the others lose only the matched text, with a `Tj` left empty removed and the kerning between replaced glyphs dropped.
```

Leave the API row unchanged unless it now contradicts the bullet.

- [ ] **Step 2: CLAUDE.md**

In the `**textedit.ts** — string/`RegExp` search ... same-font, no-reflow `ReplaceText`` paragraph, append (fill the measured counts from Tasks 1-4's mutation steps in place of `N`, and keep the notes for any mutation that stayed green):

```markdown
  **Invariant (`u3l5.1`):** `ReplaceText` plans per CHARACTER and writes per
  GLYPH. A glyph may draw several characters, so a glyph-level plan deleted
  the half of a ligature outside the match (`ine` in `fine` gave `one`). A
  touched glyph becomes the characters no match covers, each match's
  replacement emitted at its ANCHOR — the first position a real glyph drew,
  never a space layout inserted. Several matches in one glyph are one edit.
  **Invariant:** everything encodes before anything is edited, and a glyph
  left with no characters is NEVER encoded — its font may be Type0, which
  cannot encode, and a match merely running into it must not throw.
  **Invariant (`u3l5.1`, `text.ts`):** `layoutLines`' `refs` has one entry
  per UTF-16 CODE UNIT; it had one per code point, so every position after an
  astral character named the next glyph — in `Search`, `ReplaceText`,
  `SearchAnnotations` and `CompareText` alike.
  **Invariant:** a TJ kern is dropped only between ONE match's first and last
  elements AND when every string between them is wholly matched. Layout sorts
  by position, so stream order can differ from reading order, and the guard is
  what keeps a kern positioning unmatched text.
  **Note, measured:** N of M mutations redden. [List each green one with why.]
```

- [ ] **Step 3: Full verification**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all files pass. If a timing-sensitive test flakes, check for orphaned vitest workers left by a hung mutation (kill by StartTime) before re-running.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(u3l5.1): ligature-aware replace"
```
(With the `Co-Authored-By` trailer.)

- [ ] **Step 5: Close and push**

```bash
bd close u3l5.1
git pull --rebase
git push
git status
```
Expected: `git status` reports up to date with origin.
