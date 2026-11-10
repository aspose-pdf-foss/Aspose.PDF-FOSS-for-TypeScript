# Font Substitution Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-document name -> name font substitution rules and a custom handler, consulted before the built-in substitution ladder when RENDERING a non-embedded font.

**Architecture:** A pure leaf `src/fontsubstrules.ts` owns the rule vocabulary and the name matching (sharing its family split with `embedfonts.ts`). `Document` stores rules, the handler and a per-font-dict handler memo. `raster.ts`'s `installedSubstitute` asks handler -> rules -> existing ladder. A handler error escapes every `catch` because `rethrowLimit` rethrows errors marked as the caller's.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-font-substitution-rules-design.md`

## Global Constraints

- Render-only: `Save()`, `EmbedFonts`, `ReplaceFont` and `ToSvg` must be byte-identical with and without rules/handler.
- Per document; no module-level registry.
- No rules and no handler => every render byte-identical to today (existing goldens green UNEDITED).
- `TypeError` for wrong-kind arguments; empty-after-trim rule strings are wrong kind.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- Every new public export gets a README API Reference row; `test/readme-api.test.ts` sets the counts.
- CHANGELOG `## [Unreleased]` `Added` entry, cite `(aspose-pdf-foss-for-ts-g0ky.6)`.

## Review Focus

1. A handler throwing inside a FORM XObject or an annotation appearance (deeper `catch` sites than `renderCanvas`) must still reach the caller — Task 1's marker and Task 3's test through an annotation appearance.
2. A rule registered AFTER a first render must take effect on the next render (memos cleared) — Task 3.
3. A handler returning a name that only resolves after a later `RegisterRenderFontFolder` must resolve then (raw answer memoized, not the face) — Task 3.
4. A handler throwing a non-Error value (`throw 'x'`) must still propagate as that value's wrapper, not be swallowed — Task 1.
5. A rule naming a substitute that exists ONLY in an authoring folder (`RegisterFontFolder`) is skipped, not used — Task 3.

---

### Task 1: Caller errors escape every catch

**Files:**
- Modify: `src/errors.ts` (beside `rethrowLimit`, line ~43)
- Test: `test/caller-error.test.ts`

**Interfaces:**
- Produces: `markCallerError(e: unknown): unknown` — records `e` (an object) in a module `WeakSet` and returns it; a non-object is wrapped as `new Error(String(e), { cause: e })`, recorded, and returned. `rethrowLimit(e)` now ALSO throws `e` when it is recorded. Both internal (not exported from `index.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import { markCallerError, rethrowLimit } from '../src/errors.js';
it('rethrowLimit rethrows a marked caller error, and only a marked one', () => {
  const mine = new Error('mine');
  expect(() => rethrowLimit(markCallerError(mine))).toThrow(mine);
  expect(() => rethrowLimit(new Error('other'))).not.toThrow();
});
it('wraps a non-object throw so it can be marked', () => {
  const w = markCallerError('boom') as Error;
  expect(w).toBeInstanceOf(Error);
  expect(w.cause).toBe('boom');
  expect(() => rethrowLimit(w)).toThrow(w);
});
```

- [ ] **Step 2: Run** `npx vitest run test/caller-error.test.ts` — Expected: FAIL (`markCallerError` not exported).
- [ ] **Step 3: Implement** in `src/errors.ts`; extend `rethrowLimit` with the WeakSet check. Add a sentence to `rethrowLimit`'s doc comment: a marked caller error is not damage either.
- [ ] **Step 4: Run** the test and `npx vitest run test/limits-catch.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(g0ky.6): caller errors escape every catch through rethrowLimit`.

### Task 2: Rule vocabulary and shared name matching

**Files:**
- Create: `src/fontsubstrules.ts`
- Modify: `src/embedfonts.ts:78-90` (use the shared helpers), `src/fontsubst.ts:191-215` (extract rung 1)
- Test: `test/fontsubstrules.test.ts`

**Interfaces:**
- Produces (from `src/fontsubstrules.ts`, a pure leaf importing only `fontmatch.js`/`fontsource.js` types and `metrics.js`):
  - `interface FontSubstitutionRule { readonly original: string; readonly substitute: string }`
  - `interface FontSubstitutionRequest { name: string; bold: boolean; italic: boolean; characters: ReadonlySet<number> }`
  - `type FontSubstitutionHandler = (req: FontSubstitutionRequest) => string | Uint8Array | undefined`
  - `squashFontName(s: string): string` — `s.replace(/[\s-]/g, '').toLowerCase()` (moved verbatim from `embedfonts.ts`).
  - `fontFamilyKeys(baseFont: string): string[]` — `[...new Set([baseFont.split(',')[0], baseFont.split(/[,-]/)[0]].map(squashFontName))].filter((s) => s !== '')` (moved verbatim).
  - `ruleMatches(original: string, baseFont: string): boolean` — `squashFontName(original)` equals `squashFontName(baseFont)` or is in `fontFamilyKeys(baseFont)`. `baseFont` arrives subset-stripped.
  - `std14Substitute(name: string, style: { bold: boolean; italic: boolean }): StdFont | undefined` — `matchStd14(name)` when it returns a font whose name equals `name` exactly; else for the family words `Helvetica`, `Times`, `Courier` (case-insensitive) the member matching the style (`Helvetica-BoldOblique`, `Times-BoldItalic`, `Courier-Oblique`, …); else undefined.
- Produces (from `src/fontsubst.ts`): `resolveByName(faces: readonly FaceRecord[], name: string, style: FontStyle): FaceRecord | undefined` — rung 1 of `resolveSubstitute` extracted unchanged (PostScript name, then `matchChain` at 700/400 and italic); `resolveSubstitute` calls it.

- [ ] **Step 1: Write the failing tests**

```ts
it('matches the whole name and the family part, not a longer family', () => {
  expect(ruleMatches('Arial', 'Arial-BoldMT')).toBe(true);
  expect(ruleMatches('Arial', 'Arial,Bold')).toBe(true);
  expect(ruleMatches('arial bold mt', 'Arial-BoldMT')).toBe(true);
  expect(ruleMatches('Arial', 'ArialNarrow')).toBe(false);
  expect(ruleMatches('Arial-BoldMT', 'Arial-ItalicMT')).toBe(false);
});
it('picks the Standard-14 member for a family word and a style', () => {
  expect(std14Substitute('Times', { bold: true, italic: true })).toBe('Times-BoldItalic');
  expect(std14Substitute('helvetica', { bold: false, italic: true })).toBe('Helvetica-Oblique');
  expect(std14Substitute('Courier-Bold', { bold: false, italic: false })).toBe('Courier-Bold');
  expect(std14Substitute('Arial', { bold: false, italic: false })).toBeUndefined();
});
```

- [ ] **Step 2: Run** `npx vitest run test/fontsubstrules.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module; switch `embedfonts.ts` to `squashFontName`/`fontFamilyKeys`; extract `resolveByName`.
- [ ] **Step 4: Run** the new test plus the fences `npx vitest run test/fontsubstrules.test.ts test/embed-fonts*.test.ts test/fontsubst*.test.ts test/render-fonts.test.ts` — Expected: all PASS, fences unedited.
- [ ] **Step 5: Commit** `feat(g0ky.6): font substitution rule matching, shared with EmbedFonts`.

### Task 3: Document API and the render wiring

**Files:**
- Modify: `src/document.ts` (beside `AddRenderFont`, ~line 2399), `src/raster.ts:619-645` (`installedSubstitute`) and its caller ~line 727, `src/index.ts`
- Test: `test/font-substitution-rules.test.ts`

**Interfaces:**
- Consumes: Task 1's `markCallerError`; Task 2's types, `ruleMatches`, `std14Substitute`, `resolveByName`.
- Produces on `Document`:
  - `AddFontSubstitution(original: string, substitute: string): void`
  - `SetFontSubstitutionHandler(handler: FontSubstitutionHandler | undefined): void`
  - `get FontSubstitutions(): readonly FontSubstitutionRule[]` — a frozen copy, in order.
  - `ClearFontSubstitutions(): void` — rules only.
  - `@internal fontSubstitutionAnswer(fontDict: PdfDict, req: FontSubstitutionRequest): string | SfntFont | undefined` — asks the handler at most once per `fontDict` (memo `WeakMap<PdfDict, string | SfntFont | null>`, storing the RAW answer: the name, or the `parseSfnt(bytes, 0, this.loadLimits)` result, or `null`). Bytes that throw on parse => `null` (catch calls `rethrowLimit` first). A handler throw => `throw markCallerError(e)`. All three mutators clear the memo.
  - `@internal hasFontSubstitutions(): boolean` — rules non-empty or handler set.
- Produces in `raster.ts`: `installedSubstitute` returns `{ sfnt: SfntFont; family?: string }`. Order: handler answer (name -> `resolveByName` over `renderFontFaces()` at the font's style, else `std14Substitute` -> `getStd14Sfnt`; `SfntFont` -> used, `family` from `readFontNames(sfnt.raw)?.family`), then each rule with `ruleMatches(rule.original, baseFont)` resolving `rule.substitute` the same way, then the existing ladder. Early return becomes `faces.length === 0 && !doc.hasFontSubstitutions()`. A Standard-14 outcome sets `family: undefined` but the caller still sets `substituted = true` (so a Type0 font selects by Unicode, `lqcs.1`).
- Exported from `index.ts`: `FontSubstitutionRule`, `FontSubstitutionRequest`, `FontSubstitutionHandler` (types).

Fixtures: `buildSimpleTextPdf('BT /F1 24 Tf 20 100 Td (AB) Tj ET', { baseFont: 'Arial-BoldMT' })`; faces from `buildNamedFont` (`test/helpers/build-sfnt.ts`) in a temp folder; observe through `buildGlyphSource(doc, fontDictOf(doc))` (`.substituteFamily`, `.sfnt`, `.substituted`), and end to end through `page.ToImage()` compared with a render of the same text through the expected face.

- [ ] **Step 1: Write the failing tests** (`describe('font substitution rules (g0ky.6)')`), each a separate `it`:
  - rule by family part: rule `Arial -> Sub Sans`, registered `Sub Sans` and `Sub Sans Bold` (bold) => `substituteFamily` `'Sub Sans'` and the bold face chosen (`src.sfnt` is the bold face's).
  - `Arial` rule does not catch `/ArialNarrow` (ladder answer unchanged).
  - first resolvable rule wins; a first rule naming an unregistered face is skipped.
  - rule beats the ladder: a registered face whose PostScript name is `Arial-BoldMT` loses to the rule's `Sub Sans`.
  - rule to `Times` with NO render faces: `src.sfnt === getStd14Sfnt('Times-Bold')`, `src.substituted === true`, `substituteFamily` undefined.
  - substitute only in an authoring folder (`RegisterFontFolder`) is skipped.
  - handler before rules; handler `undefined` falls to rules; handler name unresolvable falls through; handler bytes (a `buildNamedFont` buffer) used, `substituteFamily` its family; unparseable bytes fall through.
  - handler sees `{ name: 'Arial-BoldMT', bold: true, italic: false }` and a `characters` set containing `0x41`.
  - handler asked once across two `ToImage()` calls; asked again after `AddFontSubstitution`.
  - handler name resolving only after a later `RegisterRenderFontFolder` resolves on the next render (no memo clear needed — raw answer memoized).
  - handler throwing: `expect(() => doc.Pages[0].ToImage()).toThrow(err)` with the SAME error object; and the same through an annotation appearance drawing the font (`AddFreeText` cannot name a non-embedded font, so hand-build a `/FreeText` whose `/AP /N` uses the non-embedded `/F1`).
  - Type0 non-embedded font (`buildType0Pdf`, `/BaseFont /Foo`) under rule `Foo -> Sub Sans` selects by Unicode: the gid drawn for CID 0x41 is `Sub Sans`'s gid for its Unicode, not `cmapLookup(0x41)`.
  - `ClearFontSubstitutions` restores the ladder's choice; `FontSubstitutions` returns a frozen copy (mutating it throws, a second call is a different array).
  - validation: `AddFontSubstitution('', 'x')`, `(' ', 'x')`, `(1 as never, 'x')` and `SetFontSubstitutionHandler(1 as never)` throw `TypeError`.
  - byte identity: `ToImage()` with an empty rule list equals no rules; `ToSvg()` and `Save()` equal with and without a matching rule; `EmbedFonts()` with rule `Foo -> Liberation Sans` (registered only as a render face) embeds nothing for `/Foo`.
- [ ] **Step 2: Run** `npx vitest run test/font-substitution-rules.test.ts` — Expected: FAIL (methods missing).
- [ ] **Step 3: Implement** the Document state/methods and the `installedSubstitute` order.
- [ ] **Step 4: Run** the new file plus `test/render-fonts.test.ts test/html-identity.test.ts test/docx-flow-identity.test.ts test/limits-catch.test.ts` — Expected: PASS.
- [ ] **Step 5: Mutation check** (restore after each; confirm each applied): skip the handler memo; clear nothing on `AddFontSubstitution`; ladder before rules; drop the family-part keys; omit `substituted = true` on a Standard-14 outcome; memoize the resolved face instead of the raw answer; swallow the handler error (drop `markCallerError`). Each must redden a case; record any that does not in the Task 4 CLAUDE.md note.
- [ ] **Step 6: Commit** `feat(g0ky.6): doc.AddFontSubstitution and SetFontSubstitutionHandler`.

### Task 4: Documentation and full gates

**Files:**
- Modify: `README.md` (Key Capabilities font-substitution sentence; API Reference rows for the four methods and three types), `CHANGELOG.md`, `CLAUDE.md` (new **fontsubstrules.ts** entry next to **fontsubst.ts**, plus the `markCallerError` rule under Conventions/Errors)

- [ ] **Step 1:** Write the README text: rules and handler affect rendering only (`ToImage`, `ToTiff`, raster HTML/DOCX backdrops, `MakeSearchable`, `CompareRendering`, `Sanitize`'s rasterization); `ToSvg` and saved files unaffected; `characters` is a sample of up to 256 code points; substitutes come from render faces and the bundled Standard-14 faces, not authoring folders; handler errors propagate.
- [ ] **Step 2:** CHANGELOG `Added` entry in the repo's style (bold lead-in, what/why), ending `(aspose-pdf-foss-for-ts-g0ky.6)`.
- [ ] **Step 3: Run** `npx vitest run test/readme-api.test.ts`, copy the counts it asks for, rerun — Expected: PASS.
- [ ] **Step 4: Run** `npm run typecheck` and `npm test` — Expected: no errors; all files pass.
- [ ] **Step 5: Commit** `docs(g0ky.6): font substitution rules`; close `aspose-pdf-foss-for-ts-g0ky.6`; `git pull --rebase && git push`.
