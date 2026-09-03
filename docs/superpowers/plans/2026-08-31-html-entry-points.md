# The three HTML entry points — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `flow.AddHtml`, `page.AddHtml` and `doc.AddHtml` over one implementation, making the whole `zch2` pipeline reachable from `src/index.ts` for the first time.

**Architecture:** Two new modules. `cssfont.ts` fills the `FamilyResolver` seam every module below has deferred here — registered families through `doc.LoadFontFamily`, then the Standard-14 generics — and `htmlflow.ts` holds `htmlElements`, the one implementation the three methods wrap, exactly as `mdflow.ts` does for Markdown. The three entry-point files gain one method each and nothing else.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-html-entry-points-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **This issue DOES ship public API** — unlike `zch2.2`, `zch2.3` and `zch2.4`. It earns `index.ts` exports, a `CHANGELOG.md` entry under `## [Unreleased]`, and README updates in **Features**, **API overview** and **Limitations**.
- **`HtmlOptions` is TAKEN** by `ToHtml` (the opposite direction) in `html.ts`. The new names are `HtmlFlowOptions`, `HtmlFlowResult`, `HtmlElements`, `AddHtmlResult` — all measured unused. Never add a second `HtmlOptions`.
- **`cssflow.ts` and the four `zch2.3` modules must stay free of `document.ts`.** Only `cssfont.ts` and `htmlflow.ts` may import it.
- **Nothing here throws on document content.** `parseHtml` never throws and neither does the cascade; only caller options raise `TypeError`.
- **Validate before allocating.** A rejected call must leave the document byte-identical — the rule every authoring entry point follows.
- **`1px = 0.75pt`** and that conversion lives in `cssflow.ts` alone. Nothing in this plan converts units.
- Run `npm run typecheck` and `npm test` before closing. Target one file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: Rename `htmlFlowElements` to `lowerHtml`

A mechanical rename, in its own commit so it does not pollute the feature diff. `cssflow.ts` exports `htmlFlowElements`; this issue's public entry is `htmlElements`. Two names one word apart, in modules called `cssflow.ts` and `htmlflow.ts`, and the compiler cannot catch a call to the wrong one — both take an HTML document and return flow elements. It shipped hours ago and `index.ts` never exported it, so the rename costs 9 call sites.

**Files:**
- Modify: `src/cssflow.ts`, `test/cssflow.test.ts`, `test/cssflow-blocks.test.ts`, `test/cssflow-report.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `lowerHtml(root: HtmlDocument, options: CssFlowOptions): CssFlowResult` — same signature, new name. `CssFlowOptions` and `CssFlowResult` keep their names.

- [ ] **Step 1: Confirm the call-site count before touching anything**

```bash
grep -rn "htmlFlowElements" src/ test/ | wc -l    # expect 9
grep -rn "htmlFlowElements" src/index.ts | wc -l  # expect 0 — never exported
```

- [ ] **Step 2: Rename across `src/` and `test/`**

```bash
grep -rl "htmlFlowElements" src/ test/ | xargs sed -i 's/htmlFlowElements/lowerHtml/g'
grep -rn "htmlFlowElements" src/ test/ | wc -l    # expect 0
```

- [ ] **Step 3: Update the doc comment on the function**

In `src/cssflow.ts`, the function's own doc comment reads `/** Lower a parsed HTML document to a flat list of Flow elements. */`. Extend it so the name is explained where a reader meets it:

```ts
/** Lower a parsed HTML document to a flat list of Flow elements.
 *
 *  Named `lowerHtml` rather than `htmlFlowElements` because `htmlflow.ts`
 *  exports the PUBLIC `htmlElements`, which wraps this one with a Document and
 *  a real font resolver. Two names one word apart, over the same argument and
 *  return types, is a call the compiler cannot correct. */
```

- [ ] **Step 4: Typecheck and run the three suites**

Run: `npm run typecheck && npx vitest run test/cssflow.test.ts test/cssflow-blocks.test.ts test/cssflow-report.test.ts`
Expected: typecheck clean, 48 tests pass (13 + 20 + 15).

- [ ] **Step 5: Update the `CLAUDE.md` reference**

`CLAUDE.md`'s `cssflow.ts` entry does not name the function, so nothing there needs changing — confirm with:

```bash
grep -n "htmlFlowElements" CLAUDE.md docs/superpowers/plans/2026-08-31-css-flow-lowering.md | head
```

Any hit in `CLAUDE.md` must be renamed. Hits in the `zch2.4` **plan** are left alone: a plan records what that task did at the time.

- [ ] **Step 6: Commit**

```bash
git add src/cssflow.ts test/cssflow.test.ts test/cssflow-blocks.test.ts test/cssflow-report.test.ts CLAUDE.md
git commit -m "refactor(zch2.5): rename cssflow's htmlFlowElements to lowerHtml

zch2.5's public entry is htmlElements. Two names one word apart, over the
same argument and return types, is a call the compiler cannot correct.
Nothing outside the repo can depend on it - index.ts never exported it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `cssfont.ts` — the FamilyResolver bridge

**Files:**
- Create: `src/cssfont.ts`
- Test: `test/cssfont.test.ts`

**Interfaces:**
- Consumes: `Document` (for `LoadFontFamily`), `FamilyResolver` from `./cssinline.js`, `resolveFamily` and `ResolvedFamily` from `./mdstyle.js`.
- Produces:
```ts
export function documentFamilyResolver(doc: Document): FamilyResolver;
```
`FamilyResolver` is `(families: string[]) => ResolvedFamily`, and `ResolvedFamily` is `{ regular, bold, italic, boldItalic }` of `AuthoringFont`.

- [ ] **Step 1: Write the failing tests**

Create `test/cssfont.test.ts`. The `folderWith` / `buildNamedFont` helpers are the ones `test/font-byname.test.ts` already uses.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { documentFamilyResolver } from '../src/cssfont.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-cssfont-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('the generic families', () => {
  it('maps serif to Times, sans-serif to Helvetica, monospace to Courier', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif']).regular).toBe('Times-Roman');
    expect(r(['sans-serif']).regular).toBe('Helvetica');
    expect(r(['monospace']).regular).toBe('Courier');
  });

  it('fills all four faces of the generic family', () => {
    const r = documentFamilyResolver(Document.New());
    // Emphasis is relative to the FAMILY, so a generic must resolve to four
    // faces rather than to one face repeated.
    expect(r(['serif'])).toEqual({
      regular: 'Times-Roman', bold: 'Times-Bold',
      italic: 'Times-Italic', boldItalic: 'Times-BoldItalic',
    });
  });

  it('is case-insensitive, as CSS keywords are', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['Monospace']).regular).toBe('Courier');
  });

  it('accepts the ui- and system-ui aliases', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['ui-serif']).regular).toBe('Times-Roman');
    expect(r(['ui-monospace']).regular).toBe('Courier');
    expect(r(['system-ui']).regular).toBe('Helvetica');
  });

  it('takes the FIRST generic in the list', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['monospace', 'serif']).regular).toBe('Courier');
  });
});

describe('the fallback rule', () => {
  it('falls back to sans-serif for a named family that resolves to nothing', () => {
    // font-family: Garamond alone admits no principled answer; a name-to-class
    // table can never be complete, so the rule is stated rather than guessed.
    const r = documentFamilyResolver(Document.New());
    expect(r(['Garamond']).regular).toBe('Helvetica');
  });

  it('uses the list\'s own generic rather than the default when there is one', () => {
    // The distinguishing case: the default is Helvetica, so a list ending in
    // `serif` must give Times or the fallback is swallowing the generic.
    const r = documentFamilyResolver(Document.New());
    expect(r(['Garamond', 'serif']).regular).toBe('Times-Roman');
  });

  it('falls back for an empty list', () => {
    expect(documentFamilyResolver(Document.New())([]).regular).toBe('Helvetica');
  });
});

describe('registered families', () => {
  it('prefers a registered family over the generic', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Alpha Sans', 'serif']);
    // An EmbeddedFont, not the string 'Times-Roman'.
    expect(typeof fam.regular).not.toBe('string');
  });

  it('walks the family CHAIN, taking the first that resolves', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Missing Face', 'Alpha Sans', 'serif']);
    expect(typeof fam.regular).not.toBe('string');
  });

  it('fills an unstated slot from regular rather than leaving it undefined', () => {
    // LoadFontFamily leaves a slot undefined when no face plays that role;
    // mdstyle.resolveFamily is the ONE owner of the fill rule, so a one-face
    // family still comes back with four faces.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Solo Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Solo Sans']);
    expect(fam.bold).toBe(fam.regular);
    expect(fam.boldItalic).toBe(fam.regular);
  });

  it('falls through to the generic when no named family resolves', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) }));
    expect(documentFamilyResolver(doc)(['Beta Serif', 'monospace']).regular).toBe('Courier');
  });
});

describe('memoization', () => {
  it('returns the SAME resolved family for a repeated list', () => {
    // buildBoxes asks once per element, so a document of 500 paragraphs asks
    // 500 times for the same list.
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif'])).toBe(r(['serif']));
  });

  it('does not confuse two different lists', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif']).regular).toBe('Times-Roman');
    expect(r(['monospace']).regular).toBe('Courier');
    expect(r(['serif']).regular).toBe('Times-Roman');
  });

  it('hands one document the same resolver twice', () => {
    // Repeated AddHtml on one document must share a warm memo.
    const doc = Document.New();
    expect(documentFamilyResolver(doc)).toBe(documentFamilyResolver(doc));
  });

  it('gives two documents different resolvers', () => {
    // A resolver closes over its document's registered folders, so sharing one
    // across documents would leak one document's fonts into another.
    expect(documentFamilyResolver(Document.New()))
      .not.toBe(documentFamilyResolver(Document.New()));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cssfont.test.ts`
Expected: FAIL — `Failed to load url ../src/cssfont.js`.

- [ ] **Step 3: Write `src/cssfont.ts`**

```ts
/** The CSS `font-family` list to the four faces TextRun.font needs.
 *
 *  This is the seam every module below deferred to zch2.5. cssbox.ts,
 *  cssinline.ts, cssresolve.ts and cssflow.ts all take `resolveFamily` as an
 *  ARGUMENT and each records the same reason: ComputedStyle.fontFamily is a
 *  list of NAMES and TextRun.font is an AuthoringFont, and bridging them needs
 *  Document.LoadFontByName, which a pure leaf may not import. This module is
 *  where that import is finally allowed.
 *
 *  Invariant: LoadFontFamily is REUSED rather than reimplemented, and it fits
 *  exactly. It already takes a string[] and walks the family chain, and it
 *  already returns { regular, bold?, italic?, boldItalic? } — structurally
 *  identical to MarkdownFontFamily, which is no coincidence: its own
 *  documentation says the result is ready to hand to
 *  AddMarkdown({ style: { font } }). Feeding it to mdstyle.resolveFamily keeps
 *  ONE owner for the rule that an unstated face falls back to `regular`.
 *
 *  Invariant: the resolver is memoized per DOCUMENT, and its answers memoized
 *  per family list. buildBoxes asks once per element, so a document of 500
 *  paragraphs asks 500 times for the same list. Per document rather than
 *  globally because a resolver closes over that document's registered folders
 *  — sharing one would leak one document's fonts into another.
 *
 *  Note: a plain <p> renders in TIMES, not Helvetica. The UA sheet declares
 *  `html { font-family: serif }` (cssua.ts) and font-family inherits, so
 *  `serif` is what an unstyled document computes. Browser-correct, and it will
 *  read as a regression to anyone comparing against zch2.4's tests, which all
 *  used a stub resolver returning Helvetica for every list.
 *
 *  Note: an unresolvable named family in a list with NO generic falls back to
 *  sans-serif. `font-family: Garamond` alone admits no principled answer, and
 *  the alternative is a name-to-class lookup table that can never be complete
 *  — the shape rebuild.ts already rejects for identifying /Info. Stated rather
 *  than guessed at, and asserted directly so it stays a decision. */

import type { Document } from './document.js';
import type { FamilyResolver } from './cssinline.js';
import type { ResolvedFamily } from './mdstyle.js';
import { resolveFamily } from './mdstyle.js';

/** CSS generic family keywords, to the Standard-14 face that stands in.
 *
 *  `cursive` and `fantasy` are deliberately absent: neither has a Standard-14
 *  analogue, and mapping one would be a guess dressed as a rule. They fall to
 *  the default with every other unmatched name. */
const GENERIC: Record<string, string> = {
  serif: 'Times-Roman',
  'ui-serif': 'Times-Roman',
  'sans-serif': 'Helvetica',
  'ui-sans-serif': 'Helvetica',
  'system-ui': 'Helvetica',
  monospace: 'Courier',
  'ui-monospace': 'Courier',
};

/** Where an unresolvable list with no generic lands. See the note above. */
const DEFAULT_FACE = 'Helvetica';

/** One resolver per document, so repeated AddHtml calls share a warm memo. */
const byDocument = new WeakMap<Document, FamilyResolver>();

function resolveList(doc: Document, families: string[]): ResolvedFamily {
  const named: string[] = [];
  let generic: string | undefined;
  for (const f of families) {
    const g = GENERIC[f.toLowerCase()];
    // The FIRST generic wins, and a generic is never offered to
    // LoadFontFamily — no installed family is called "serif".
    if (g !== undefined) { generic ??= g; continue; }
    named.push(f);
  }
  if (named.length > 0) {
    const fam = doc.LoadFontFamily(named);
    if (fam !== undefined) return resolveFamily(fam);
  }
  return resolveFamily(generic ?? DEFAULT_FACE);
}

/** The default font bridge for `doc`: registered families first, then the
 *  Standard-14 generics. Memoized per document and per family list. */
export function documentFamilyResolver(doc: Document): FamilyResolver {
  const already = byDocument.get(doc);
  if (already !== undefined) return already;
  const memo = new Map<string, ResolvedFamily>();
  const resolver: FamilyResolver = (families: string[]): ResolvedFamily => {
    // NUL joins rather than a space, and that is not pedantry: under a
    // space ['Alpha', 'Sans'] and ['Alpha Sans'] key IDENTICALLY - a
    // two-family chain and one two-word family, which resolve differently.
    const key = families.join('\u0000');
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const out = resolveList(doc, families);
    memo.set(key, out);
    return out;
  };
  byDocument.set(doc, resolver);
  return resolver;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cssfont.test.ts`
Expected: PASS, 14 cases.

If "prefers a registered family over the generic" fails, check `buildNamedFont`'s default family name — `test/font-byname.test.ts` passes `{ family: 'Alpha Sans' }` explicitly and so must this.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cssfont.ts test/cssfont.test.ts
git commit -m "feat(zch2.5): the CSS font-family bridge

Fills the FamilyResolver seam cssbox, cssinline, cssresolve and cssflow all
deferred here. LoadFontFamily already walks a family chain and returns the
four slots structurally identical to MarkdownFontFamily - its own docs say
the result is ready for AddMarkdown - so it feeds mdstyle.resolveFamily and
one owner keeps the fill-unstated-faces rule.

Memoized per document and per family list: buildBoxes asks once per element.
Per document rather than globally, because a resolver closes over that
document's registered folders.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `htmlflow.ts` — the one implementation

**Files:**
- Create: `src/htmlflow.ts`
- Test: `test/htmlflow.test.ts`

**Interfaces:**
- Consumes: `lowerHtml` from `./cssflow.js` (Task 1), `documentFamilyResolver` from `./cssfont.js` (Task 2), `parseHtml` from `./htmltree.js`.
- Produces:
```ts
export interface HtmlFlowOptions { resolveFamily?: FamilyResolver }
export interface HtmlFlowResult { skipped: string[]; unsupported: UnsupportedDeclaration[] }
export interface HtmlElements extends HtmlFlowResult { elements: FlowElement[] }
export interface AddHtmlResult extends HtmlFlowResult { usedHeight: number; remainder: FlowElement[] }
export function htmlElements(
  doc: Document, src: string | HtmlDocument, width: number,
  options?: HtmlFlowOptions,
): HtmlElements;
export function documentTitle(root: HtmlDocument): string | undefined;
```

- [ ] **Step 1: Write the failing tests**

Create `test/htmlflow.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseHtml } from '../src/htmltree.js';
import { htmlElements, documentTitle } from '../src/htmlflow.js';
import { placeElements } from '../src/flowplace.js';

/** Place mapped elements into a rect and hand back the page. */
function render(src: string, width = 400) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements, skipped, unsupported } = htmlElements(doc, src, width);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return { page, skipped, unsupported };
}

describe('htmlElements', () => {
  it('maps a string source', () => {
    expect(render('<p>hello world</p>').page.GetText()).toContain('hello world');
  });

  it('accepts an already-parsed HtmlDocument', () => {
    const doc = Document.New();
    const root = parseHtml('<!doctype html><p>parsed once</p>');
    const { elements } = htmlElements(doc, root, 400);
    expect(elements.length).toBeGreaterThan(0);
  });

  it('reports skipped and unsupported through unchanged', () => {
    const { skipped, unsupported } = render(
      '<p style="grid-template-columns:1fr">a</p><table><tr><td>x</td></tr></table>');
    expect(skipped).toContain('table');
    expect(unsupported.some((u) => u.property === 'grid-template-columns')).toBe(true);
  });

  it('uses the DEFAULT resolver, so an unstyled paragraph is TIMES', () => {
    // The UA sheet declares html { font-family: serif } and font-family
    // inherits. zch2.4's tests all stubbed Helvetica, so this reads as a
    // regression against them and is browser-correct.
    const { page } = render('<p>x</p>');
    const [frag] = page.GetTextFragments();
    expect(frag.font).toContain('Times');
  });

  it('honours an explicit font-family over the UA default', () => {
    const { page } = render('<p style="font-family:monospace">x</p>');
    const [frag] = page.GetTextFragments();
    expect(frag.font).toContain('Courier');
  });

  it('lets the caller override the resolver entirely', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(doc, '<p>x</p>', 400, {
      resolveFamily: () => ({
        regular: 'Courier', bold: 'Courier-Bold',
        italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique',
      }),
    });
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    expect(page.GetTextFragments()[0].font).toContain('Courier');
  });

  it('resolves boxes against the width it is GIVEN', () => {
    // The width reaches resolveBoxes at build time, so a narrow width must
    // wrap text a wide one does not.
    const long = '<p>' + 'word '.repeat(40) + '</p>';
    const wide = render(long, 500).page.GetTextFragments().length;
    const narrow = render(long, 120).page.GetTextFragments().length;
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('documentTitle', () => {
  it('reads the title element', () => {
    expect(documentTitle(parseHtml('<!doctype html><title>Report</title><p>x</p>')))
      .toBe('Report');
  });

  it('trims surrounding whitespace', () => {
    expect(documentTitle(parseHtml('<!doctype html><title>  Spaced  </title>')))
      .toBe('Spaced');
  });

  it('is undefined when there is no title', () => {
    expect(documentTitle(parseHtml('<!doctype html><p>x</p>'))).toBeUndefined();
  });

  it('is undefined for an EMPTY title rather than the empty string', () => {
    // SetMetadata({ title: '' }) would write an empty /Info /Title, which is
    // worse than leaving the document's own alone.
    expect(documentTitle(parseHtml('<!doctype html><title></title>'))).toBeUndefined();
    expect(documentTitle(parseHtml('<!doctype html><title>   </title>'))).toBeUndefined();
  });

  it('reads a title the parser moved into head', () => {
    // The tree builder puts <title> in <head> however the source spells it.
    expect(documentTitle(parseHtml('<!doctype html><html><head><title>In Head</title>'
      + '</head><body><p>x</p></body></html>'))).toBe('In Head');
  });

  it('does not mistake a body heading for a title', () => {
    expect(documentTitle(parseHtml('<!doctype html><body><h1>Not A Title</h1></body>')))
      .toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: FAIL — `Failed to load url ../src/htmlflow.js`.

- [ ] **Step 3: Write `src/htmlflow.ts`**

```ts
/** The three HTML entry points' one implementation.
 *
 *  This module owns the WIRING and nothing else: it parses when given a
 *  string, supplies a font resolver, and hands the width down. Flow's column
 *  engine and flowplace.ts's rect placer both take the FlowElement[] it
 *  returns, which is what makes three entry points cost one implementation —
 *  mdflow.ts's shape for mdflow.ts's reason.
 *
 *  Invariant: it takes a Document and a WIDTH where markdownElements takes
 *  neither, and both are forced. Fonts come from doc.LoadFontFamily; and
 *  zch2.4 resolves boxes at BUILD time, because three call sites read
 *  spaceBefore before place() ever runs (flowplace.ts:63, flow.ts:1298, and
 *  flow.ts:1330's keep-with-next lookahead), so a gap computed later can never
 *  reach the engine. A Markdown element carries no resolved geometry and is
 *  width-independent until it places.
 *
 *  Invariant: the width is POSITIONAL rather than an option, so that no caller
 *  of the three entry points passes one at all — flow supplies its
 *  columnWidth, page supplies rect[2], and doc builds a Flow and delegates. A
 *  width in the shared options bag could be passed twice and disagree.
 *
 *  Invariant: the option bag is HtmlFlowOptions, NOT HtmlOptions — html.ts
 *  already exports that for ToHtml, the opposite direction. mdexport.ts
 *  records the same hazard for MarkdownExportOptions against MarkdownOptions,
 *  and notes the collision is a compile error only because both are exported
 *  from index.ts.
 *
 *  Invariant: THE CALLER MUST PLACE WITH `paragraphSpacing: 0`. zch2.4 puts
 *  the whole collapsed margin in spaceBefore, and flow.ts ADDS
 *  `spaceAfter + paragraphSpacing + spaceBefore`. Measured: both
 *  normalizeFlowOptions and page.AddMarkdown's own option already default it
 *  to 0, so the contract holds for every caller who says nothing. */

import type { Document } from './document.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import type { FamilyResolver } from './cssinline.js';
import type { FlowElement } from './flowelement.js';
import { parseHtml } from './htmltree.js';
import { lowerHtml } from './cssflow.js';
import { documentFamilyResolver } from './cssfont.js';

/** Options shared by the three `AddHtml` entry points. */
export interface HtmlFlowOptions {
  /** Override the font bridge. Default: the document's registered families
   *  first, then the Standard-14 generics — see cssfont.ts. */
  resolveFamily?: FamilyResolver;
}

/** What every HTML entry point reports. */
export interface HtmlFlowResult {
  /** Every construct that did not render, in document order: `'table'`,
   *  `'image:<src>'`, `'float:left'`, `'float:right'`. Without this a caller
   *  cannot tell a dropped table from an empty document. */
  skipped: string[];
  /** Declarations the cascade could not use, for a caller reporting what it
   *  could not render. */
  unsupported: UnsupportedDeclaration[];
}

/** What {@link htmlElements} produced. */
export interface HtmlElements extends HtmlFlowResult {
  /** Ready for a Flow or for `placeElements` — place with
   *  `paragraphSpacing: 0`. */
  elements: FlowElement[];
}

/** What {@link Page.AddHtml} reports. */
export interface AddHtmlResult extends HtmlFlowResult {
  /** Vertical space consumed, from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, ready to pass to `placeElements` — `[]` when
   *  everything fit. */
  remainder: FlowElement[];
}

/** Map an HTML document to flow elements against a containing width in POINTS. */
export function htmlElements(
  doc: Document,
  src: string | HtmlDocument,
  width: number,
  options: HtmlFlowOptions = {},
): HtmlElements {
  const root = typeof src === 'string' ? parseHtml(src) : src;
  return lowerHtml(root, {
    width,
    resolveFamily: options.resolveFamily ?? documentFamilyResolver(doc),
  });
}

/** The first HTML child element of `nodes` with this tag name. */
function child(nodes: HtmlNode[], name: string): HtmlElement | undefined {
  for (const n of nodes)
    if (n.kind === 'element' && n.ns === 'html' && n.name === name) return n;
  return undefined;
}

/** The document's `<title>` text, or undefined when it has none or it is
 *  blank.
 *
 *  Blank rather than `''` on purpose: `SetMetadata({ title: '' })` would write
 *  an empty `/Info /Title`, which is worse than leaving the document's own
 *  title alone. `<title>` is RCDATA, so its children are text nodes. */
export function documentTitle(root: HtmlDocument): string | undefined {
  const html = child(root.children, 'html');
  const head = html === undefined ? undefined : child(html.children, 'head');
  const title = head === undefined ? undefined : child(head.children, 'title');
  if (title === undefined) return undefined;
  let text = '';
  for (const n of title.children) if (n.kind === 'text') text += n.data;
  text = text.trim();
  return text === '' ? undefined : text;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: PASS, 13 cases.

If the Times case fails, print `page.GetTextFragments()[0].font` — a `'Helvetica'` there means the default resolver was not reached, and a missing font name means the fragment index is wrong.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/htmlflow.ts test/htmlflow.test.ts
git commit -m "feat(zch2.5): htmlElements, the one implementation behind the three methods

Takes a Document and a width where markdownElements takes neither, and both
are forced: fonts come from LoadFontFamily, and zch2.4 resolves boxes at
build time because three call sites read spaceBefore before place() runs. The
width is positional so no entry-point caller passes one and none can pass a
wrong one.

documentTitle reads <title> for doc.AddHtml, returning undefined for a blank
one - SetMetadata({ title: '' }) would write an empty /Info /Title, which is
worse than leaving the document's own alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: the three entry points

**Files:**
- Modify: `src/flow.ts` (add `AddHtml` after `AddMarkdown`, ~line 1154)
- Modify: `src/page.ts` (add `AddHtml` after `AddMarkdown`, ~line 573)
- Modify: `src/document.ts` (add `AddHtml` after `AddMarkdown`, ~line 2336)
- Test: `test/html-render.test.ts`

**Interfaces:**
- Consumes: `htmlElements`, `documentTitle`, `HtmlFlowOptions`, `HtmlFlowResult`, `AddHtmlResult` from `./htmlflow.js` (Task 3).
- Produces: the three methods, signatures as in the code below.

- [ ] **Step 1: Write the failing tests**

Create `test/html-render.test.ts`. The equivalence case is modelled directly on `test/markdown-render.test.ts`'s "the three entry points agree".

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseHtml } from '../src/htmltree.js';

const SRC = `<!doctype html>
<title>Doc Title</title>
<h1>Heading</h1>
<p>A paragraph of body text.</p>
<ul><li>alpha</li><li>bravo</li></ul>
<h2>Second</h2>
<p>More body text here.</p>`;

const textOf = (page: { GetText(): string }) => page.GetText().replace(/\s+/g, ' ').trim();

describe('the three entry points agree', () => {
  it('produce the same text for the same source', () => {
    const viaFlow = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddHtml(SRC);
      return textOf(flow.Render()[0]);
    })();
    const viaDocument = (() => {
      const doc = Document.New();
      return textOf(doc.AddHtml(SRC, { format: PageFormat.A4 }).pages[0]);
    })();
    const viaPage = (() => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      // The same content box a default A4 flow uses: 72pt margins.
      page.AddHtml(SRC, [72, 72, 595.28 - 144, 841.89 - 144]);
      return textOf(page);
    })();
    expect(viaDocument).toBe(viaFlow);
    expect(viaPage).toBe(viaFlow);
  });
});

describe('flow.AddHtml', () => {
  it('returns a report rather than `this`', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddHtml('<p>a</p><table><tr><td>x</td></tr></table>');
    expect(res.skipped).toContain('table');
    expect(Array.isArray(res.unsupported)).toBe(true);
  });

  it('uses the flow\'s COLUMN width, not the page width', () => {
    // A two-column flow must wrap where a one-column flow does not.
    const long = '<p>' + 'word '.repeat(60) + '</p>';
    const count = (columns: number): number => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4, columns });
      flow.AddHtml(long);
      return flow.Render()[0].GetTextFragments().length;
    };
    expect(count(2)).toBeGreaterThan(count(1));
  });

  it('mixes with hand-built flow content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('before');
    flow.AddHtml('<p>middle</p>');
    flow.AddParagraph('after');
    const t = textOf(flow.Render()[0]);
    expect(t.indexOf('before')).toBeLessThan(t.indexOf('middle'));
    expect(t.indexOf('middle')).toBeLessThan(t.indexOf('after'));
  });
});

describe('page.AddHtml', () => {
  it('reports usedHeight and an empty remainder when everything fits', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddHtml('<p>short</p>', [72, 72, 400, 600]);
    expect(res.usedHeight).toBeGreaterThan(0);
    expect(res.remainder).toEqual([]);
  });

  it('hands back a remainder that did not fit', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const long = '<p>' + 'word '.repeat(400) + '</p>';
    const res = page.AddHtml(long, [72, 72, 400, 60]);
    expect(res.remainder.length).toBeGreaterThan(0);
  });

  it('uses rect[2] as the width, not rect[3]', () => {
    // A wide-and-short rect and a narrow-and-tall one must wrap differently.
    const long = '<p>' + 'word '.repeat(40) + '</p>';
    const frags = (w: number, h: number): number => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      page.AddHtml(long, [40, 40, w, h]);
      return page.GetTextFragments().length;
    };
    expect(frags(120, 600)).toBeGreaterThan(frags(450, 600));
  });

  it('preserves existing page content', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('already here', 72, 780, { fontSize: 10 });
    page.AddHtml('<p>added</p>', [72, 72, 400, 600]);
    const t = textOf(page);
    expect(t).toContain('already here');
    expect(t).toContain('added');
  });
});

describe('doc.AddHtml and the title', () => {
  it('uses the document\'s <title> when no explicit title is given', () => {
    const doc = Document.New();
    doc.AddHtml(SRC, { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBe('Doc Title');
    // A title without the flag satisfies neither PDF/UA nor the caller.
    expect(doc.DisplayDocTitle).toBe(true);
  });

  it('lets an EXPLICIT title win over <title>', () => {
    const doc = Document.New();
    doc.AddHtml(SRC, { format: PageFormat.A4, title: 'Chosen' });
    expect(doc.GetMetadata().title).toBe('Chosen');
  });

  it('leaves the title alone when the source has none', () => {
    const doc = Document.New();
    doc.SetMetadata({ title: 'Existing' });
    doc.AddHtml('<p>no title here</p>', { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBe('Existing');
  });

  it('does NOT apply the title default on the other two entry points', () => {
    // Flow.AddHtml and Page.AddHtml append to a document whose title is
    // someone else's business - doc.AddMarkdown's own stated rule.
    const viaFlow = Document.New();
    viaFlow.NewFlow({ format: PageFormat.A4 }).AddHtml(SRC);
    expect(viaFlow.GetMetadata().title).toBeUndefined();

    const viaPage = Document.New();
    viaPage.AddPage(PageFormat.A4).page.AddHtml(SRC, [72, 72, 400, 600]);
    expect(viaPage.GetMetadata().title).toBeUndefined();
  });

  it('rejects an empty explicit title before allocating anything', () => {
    const doc = Document.New();
    const before = doc.Pages.length;
    expect(() => doc.AddHtml('<p>a</p>', { title: '' })).toThrow(TypeError);
    expect(doc.Pages.length).toBe(before);
  });

  it('returns the pages it created plus the report', () => {
    const doc = Document.New();
    const res = doc.AddHtml('<p>a</p><table><tr><td>x</td></tr></table>',
      { format: PageFormat.A4 });
    expect(res.pages.length).toBeGreaterThan(0);
    expect(res.skipped).toContain('table');
  });

  it('parses the source ONCE when given a string', () => {
    // doc.AddHtml parses, reads the title, and hands the tree to flow.AddHtml.
    // Passing a pre-parsed document must behave identically.
    const a = Document.New();
    a.AddHtml(SRC, { format: PageFormat.A4 });
    const b = Document.New();
    b.AddHtml(parseHtml(SRC), { format: PageFormat.A4 });
    expect(textOf(b.Pages[0])).toBe(textOf(a.Pages[0]));
    expect(b.GetMetadata().title).toBe('Doc Title');
  });
});

describe('body margins are honoured', () => {
  it('insets content by the UA sheet\'s body margin', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddHtml('<p style="margin:0">x</p>', [72, 72, 400, 600]);
    // body { margin: 8px } = 6pt.
    expect(page.GetTextFragments()[0].quad[0]).toBeCloseTo(72 + 6, 3);
  });

  it('lets an author remove it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddHtml('<style>body{margin:0}</style><p style="margin:0">x</p>',
      [72, 72, 400, 600]);
    expect(page.GetTextFragments()[0].quad[0]).toBeCloseTo(72, 3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/html-render.test.ts`
Expected: FAIL — `flow.AddHtml is not a function`.

- [ ] **Step 3: Add `Flow.AddHtml` to `src/flow.ts`**

Add the import beside the existing `mdflow.js` one:

```ts
import {
  htmlElements, type HtmlFlowOptions, type HtmlFlowResult,
} from './htmlflow.js';
import type { HtmlDocument } from './htmldom.js';
```

And the method immediately after `AddMarkdown`:

```ts
  /** Append an HTML document: it is parsed (HTML5), styled through the CSS
   *  cascade, laid out as boxes and lowered onto flow elements, so the result
   *  paginates, tags and mixes with hand-built content like any other flow.
   *
   *  Resolved against this flow's COLUMN width, which is why a two-column flow
   *  wraps where a one-column flow does not: an HTML box resolves against a
   *  containing width when it is built, not when it places.
   *
   *  Unlike the other `Add*` methods this returns a report rather than `this`:
   *  `skipped` names every construct that did not render (a table, an image, a
   *  float), and without it a caller cannot tell a dropped table from an empty
   *  document. */
  AddHtml(src: string | HtmlDocument, options: HtmlFlowOptions = {}): HtmlFlowResult {
    const { elements, skipped, unsupported } =
      htmlElements(this.doc, src, this.geometry.columnWidth, options);
    this.items.push(...elements);
    return { skipped, unsupported };
  }
```

- [ ] **Step 4: Add `Page.AddHtml` to `src/page.ts`**

Add the import beside the existing `mdflow.js` one:

```ts
import {
  htmlElements, type AddHtmlResult, type HtmlFlowOptions,
} from './htmlflow.js';
import type { HtmlDocument } from './htmldom.js';
```

And the method immediately after `AddMarkdown`:

```ts
  /** Lay an HTML document into the rectangle [x, y, w, h] (PDF user space,
   *  `y` the bottom edge) on this page. Existing content is preserved.
   *
   *  Returns `usedHeight`, the `skipped` and `unsupported` reports, and a
   *  `remainder` of the elements that did not fit — pass it to `placeElements`
   *  to continue into another rect or another page. For a document that should
   *  paginate itself, use `Document.AddHtml` or a `Flow`.
   *
   *  `rect[2]` is the containing width the CSS boxes resolve against. */
  AddHtml(
    src: string | HtmlDocument,
    rect: [number, number, number, number],
    options: HtmlFlowOptions & {
      /** Gap between consecutive blocks, on top of the CSS margins. Default 0,
       *  and leaving it there is what lets a collapsed margin reproduce
       *  exactly — flow.ts ADDS this between every pair. */
      paragraphSpacing?: number;
      /** Grouping element the content tags under. Omit for untagged output. */
      structParent?: StructElement;
    } = {},
  ): AddHtmlResult {
    const { elements, skipped, unsupported } =
      htmlElements(this.doc, src, rect[2], options);
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped, unsupported };
  }
```

- [ ] **Step 5: Add `Document.AddHtml` to `src/document.ts`**

Add the imports:

```ts
import { documentTitle, type HtmlFlowOptions } from './htmlflow.js';
import { parseHtml } from './htmltree.js';
import type { HtmlDocument } from './htmldom.js';
import type { UnsupportedDeclaration } from './cssprop.js';
```

And the method immediately after `AddMarkdown`:

```ts
  /** Render a whole HTML document, appending freshly sized pages to the end of
   *  this document. The one-call form of `NewFlow` + `AddHtml` + `Render`;
   *  `options` carries both the HTML options (`resolveFamily`) and the flow's
   *  page geometry (`format`, `columns`, `margin*`, `tagged`, `lang`).
   *
   *  The document's own `<title>` becomes the PDF title when no explicit
   *  `title` is given — an explicit one always wins. Unlike Markdown, which
   *  has no title construct, an HTML document STATES its title, so carrying it
   *  into `/Info /Title`, XMP `dc:title` and
   *  `/ViewerPreferences /DisplayDocTitle` reads the document rather than
   *  inventing a fact. All three are written together: a title without the
   *  flag satisfies neither PDF/UA nor the caller's intent.
   *
   *  That applies here and on neither of the other two entry points, which
   *  append to a document whose title is someone else's business. */
  AddHtml(
    src: string | HtmlDocument,
    options: HtmlFlowOptions & FlowOptions & {
      /** Document title. Non-empty. Default: the source's `<title>`, else the
       *  document's title is untouched. */
      title?: string;
    } = {},
  ): { pages: Page[]; skipped: string[]; unsupported: UnsupportedDeclaration[] } {
    // Validated before anything is allocated, so a rejected call leaves the
    // document byte-identical — the rule every authoring entry point follows.
    const explicit = options.title;
    if (explicit !== undefined && (typeof explicit !== 'string' || explicit === ''))
      throw new TypeError('title must be a non-empty string');
    // Parsed ONCE: the title is read from the tree the flow then lowers.
    const root = typeof src === 'string' ? parseHtml(src) : src;
    const flow = new Flow(this, options);
    const { skipped, unsupported } = flow.AddHtml(root, options);
    const pages = flow.Render();
    const title = explicit ?? documentTitle(root);
    if (title !== undefined) {
      this.SetMetadata({ title });   // mirrors to XMP dc:title on its own
      this.DisplayDocTitle = true;
    }
    return { pages, skipped, unsupported };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/html-render.test.ts`
Expected: PASS, 17 cases.

If "the three entry points agree" fails, print all three strings — a difference at the very start usually means the page rect does not match the flow's content box (72pt margins on A4: `[72, 72, 595.28 - 144, 841.89 - 144]`).

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`
Expected: both green. Nothing existing should move — the three files gain a method and change no other behaviour.

- [ ] **Step 8: Commit**

```bash
git add src/flow.ts src/page.ts src/document.ts test/html-render.test.ts
git commit -m "feat(zch2.5): flow.AddHtml, page.AddHtml, doc.AddHtml

Three entry points over one implementation, the shape AddMarkdown has, and
asserted the way the issue asks: one source through all three, comparing
extracted text. Each supplies its own width - the flow its columnWidth, the
page rect[2], the document by building a Flow - so no caller passes one.

doc.AddHtml uses the source's <title> when no explicit title is given, which
doc.AddMarkdown cannot do because Markdown has no title construct. It applies
there and on neither of the other two, which append to a document whose title
is someone else's business.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: public surface, docs, mutation sweep, close

**Files:**
- Modify: `src/index.ts`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- Test: `test/html-render.test.ts` (add the `public surface` case)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no new code.

- [ ] **Step 1: Export from `src/index.ts`**

After the `// --- Markdown rendering (gl6o.3.2) ---` block, add:

```ts
// --- HTML rendering (zch2.5) ---
export { htmlElements } from './htmlflow.js';
export type {
  HtmlFlowOptions, HtmlFlowResult, HtmlElements, AddHtmlResult,
} from './htmlflow.js';
```

`parseHtml` is already exported. `lowerHtml`, `documentFamilyResolver` and `documentTitle` stay internal — `htmlElements` is the whole public route, as `markdownElements` is for Markdown.

- [ ] **Step 2: Add the public-surface test**

Append to `test/html-render.test.ts`, modelled on `test/markdown-render.test.ts`'s own `public surface` case:

```ts
describe('public surface', () => {
  it('exports the HTML entry point from the package root', async () => {
    const api = await import('../src/index.js');
    expect(typeof (api as Record<string, unknown>).htmlElements).toBe('function');
    expect(typeof (api as Record<string, unknown>).parseHtml).toBe('function');
  });

  it('does NOT export the internals', async () => {
    // lowerHtml, documentFamilyResolver and documentTitle are wiring. Keeping
    // them internal is a decision, so the suite enforces it - the rule
    // test/html-public-api.test.ts already applies to parseHtmlFragment.
    const api = await import('../src/index.js') as Record<string, unknown>;
    for (const name of ['lowerHtml', 'documentFamilyResolver', 'documentTitle'])
      expect(api[name]).toBeUndefined();
  });
});
```

Run: `npx vitest run test/html-render.test.ts`
Expected: PASS, 19 cases.

- [ ] **Step 3: Run the mutation sweep**

For each: apply to `src/`, run the four suites, record which cases redden, then **revert**. A mutation that reddens NOTHING goes into `CLAUDE.md` as an uncovered rule.

```bash
npx vitest run test/cssfont.test.ts test/htmlflow.test.ts test/html-render.test.ts test/cssflow.test.ts
```

| # | Mutation | Expected to redden |
|---|---|---|
| 1 | `GENERIC.serif = 'Helvetica'` | `cssfont` "maps serif to Times…", `htmlflow` "an unstyled paragraph is TIMES" |
| 2 | In `resolveList`, skip the `LoadFontFamily` branch entirely | `cssfont` "prefers a registered family over the generic" |
| 3 | Drop the memo (`resolveList` on every call) | a COST rule — record as uncovered if nothing reddens |
| 4 | In `page.AddHtml`, pass `rect[3]` instead of `rect[2]` | `html-render` "uses rect[2] as the width, not rect[3]" |
| 5 | In `flow.AddHtml`, pass `this.geometry.columnHeight` | `html-render` "uses the flow's COLUMN width" |
| 6 | In `doc.AddHtml`, drop `?? documentTitle(root)` | `html-render` "uses the document's `<title>`"; the explicit-title case stays green |
| 7 | In `doc.AddHtml`, swap to `documentTitle(root) ?? explicit` | `html-render` "lets an EXPLICIT title win" |
| 8 | Apply the title default in `flow.AddHtml` too | `html-render` "does NOT apply the title default on the other two" |
| 9 | In `cssflow.frameOf`, zero `marginLeft`/`marginRight` | `html-render` "insets content by the UA sheet's body margin" |
| 10 | `DEFAULT_FACE = 'Times-Roman'` | `cssfont` "falls back to sans-serif for a named family that resolves to nothing" |
| 11 | In `documentTitle`, return `text` without the blank check | `htmlflow` "is undefined for an EMPTY title" |
| 12 | Make `documentFamilyResolver` build a fresh resolver each call (drop the WeakMap) | `cssfont` "hands one document the same resolver twice" |

- [ ] **Step 4: Record the sweep in this plan**

Append a `## Mutation results` section naming, per mutation, the cases that reddened — or **"reddened nothing"** where that is the truth.

- [ ] **Step 5: Add the `CHANGELOG.md` entry**

Under `## [Unreleased]`, in the `### Added` group (create it if the newest group is not `Added`), newest first:

```markdown
- **HTML to PDF** — render an HTML document into a flow, into a rect on a page,
  or a whole document in one call: `flow.AddHtml`, `page.AddHtml`,
  `doc.AddHtml`. The source is parsed by the HTML5 tree constructor, styled
  through the CSS cascade (a UA sheet transcribed from HTML §15, author
  `<style>` and `style=`, 43 longhands, selectors including `:has()`), laid out
  as a CSS box tree with margin collapsing and used widths, and lowered onto
  the same flow elements Markdown uses — so it paginates, tags, floats and
  mixes with hand-built content with no new engine. Block backgrounds, all four
  borders and padding are painted; a box split across a column keeps its side
  borders and draws its top and bottom once. Headings become `/H1`..`/H6` under
  a tagged flow and are eligible for keep-with-next; a run of `display:
  list-item` siblings becomes one list, so ordinals run continuously and `/L` >
  `/LI` > `/LBody` follows. `font-family` resolves against the document's
  registered font folders first and falls back to the Standard-14 generics, so
  it works with no setup and improves with `RegisterFontFolder`. `doc.AddHtml`
  takes the source's own `<title>` as the PDF title unless given one. Tables,
  images and float *placement* do not render yet and name themselves in
  `skipped` rather than vanishing. (zch2.5)
```

- [ ] **Step 6: Update `README.md`**

Three edits.

**Features** — insert a bullet immediately after the `**Markdown to PDF**` bullet (line ~25):

```markdown
- **HTML to PDF** — render an HTML document into a flow, into a rect on a page, or a whole document in one call: `flow.AddHtml`, `page.AddHtml`, `doc.AddHtml`. The source is parsed by a full HTML5 tree constructor and styled through a CSS cascade (a UA sheet transcribed from HTML §15, author `<style>` elements and `style=` attributes, 43 longhands, selectors up to `:has()`), then laid out as a CSS box tree — block and inline formatting contexts, anonymous boxes, used widths per CSS 2.1 §10.3.3, and full margin collapsing — and lowered onto the same flow elements Markdown uses, so it paginates, tags and mixes with hand-built content with no second layout engine. Block backgrounds, borders and padding are painted, and a box split across a column keeps its side borders while drawing its top and bottom exactly once. Headings become `/H1`..`/H6` under a tagged flow and take part in keep-with-next; a run of `display: list-item` siblings becomes one list, so ordinals run continuously and `/L` > `/LI` > `/LBody` follows. `font-family` resolves against the document's registered font folders first (`RegisterFontFolder`) and falls back to the Standard-14 generics — `serif` → Times, `sans-serif` → Helvetica, `monospace` → Courier — so it renders with no setup at all. `doc.AddHtml` adopts the source's `<title>` as the PDF title unless you give one.
```

**API overview** — insert a row immediately after the `flow.AddMarkdown` row (line ~2248):

```markdown
| `flow.AddHtml(src, opts?)` / `page.AddHtml(src, rect, opts?)` / `doc.AddHtml(src, opts?)` | Render an HTML document — see [HTML](#html-to-pdf) |
```

**Limitations** — add a bullet at the end of the list:

```markdown
- **HTML rendering is a documented subset** — the parser and cascade are conformance-tested (7,032 tokenizer cases, 1,830 tree-construction cases, 149 CSS syntax cases, plus browser-generated selector, cascade and box goldens), but the *renderer* does not yet draw everything they can describe. Tables, images and float **placement** are not rendered: each names itself in the `skipped` report and still contributes its text, so a caller can tell a dropped table from an empty document. A floated box is laid out in normal flow. Also absent: `calc()`, `var()` and custom properties, `:lang()`/`:dir()`, `@media` feature queries (types are honoured, features are reported), absolute and relative positioning, `inline-block`, `vertical-align` and inline padding, and `vw`/`vh` units. `line-height`, `text-align`, `text-decoration`, colours, backgrounds, borders, padding, margins with collapsing, lists and headings all render.
```

- [ ] **Step 7: Add both modules to `CLAUDE.md`'s Source list**

Insert immediately after the `cssflow.ts`/`cssframe.ts` entry:

```markdown
- **htmlflow.ts**, **cssfont.ts** — the three HTML entry points (`zch2.5`) and
  the font bridge under them. `htmlflow.ts` is `htmlElements`, the one
  implementation `flow.AddHtml`, `page.AddHtml` and `doc.AddHtml` all wrap —
  `mdflow.ts`'s shape for `mdflow.ts`'s reason. `cssfont.ts` is the
  `FamilyResolver` every module below deferred here, and it is the ONLY module
  in the CSS stack allowed to import `document.js`.
  **Invariant:** `htmlElements` takes a `Document` and a WIDTH where
  `markdownElements` takes neither, and both are forced. Fonts come from
  `LoadFontFamily`; and `zch2.4` resolves boxes at BUILD time, so the width
  must be known then. A Markdown element carries no resolved geometry and is
  width-independent until it places.
  **Invariant:** the width is POSITIONAL, not an option, so no caller of the
  three entry points passes one — the flow supplies `columnWidth`, the page
  `rect[2]`, the document by building a `Flow`. A width in the shared options
  bag could be passed twice and disagree.
  **Invariant:** the option bag is `HtmlFlowOptions`, NOT `HtmlOptions` —
  `html.ts` already exports that for `ToHtml`, the opposite direction. The
  collision `mdexport.ts` records for `MarkdownExportOptions`, and it is a
  compile error only because both are exported from `index.ts`.
  **Invariant:** `LoadFontFamily` is REUSED rather than reimplemented, and it
  fits exactly: it already walks a family chain and returns
  `{ regular, bold?, italic?, boldItalic? }`, structurally identical to
  `MarkdownFontFamily` — no coincidence, since its own docs say the result is
  ready for `AddMarkdown({ style: { font } })`. Feeding it to
  `mdstyle.resolveFamily` keeps ONE owner for "an unstated face falls back to
  regular".
  **Invariant:** a generic keyword is NEVER offered to `LoadFontFamily` — no
  installed family is called `serif` — and the FIRST generic in the list wins.
  **Note, and it will read as a regression:** a plain `<p>` renders in TIMES,
  not Helvetica. The UA sheet declares `html { font-family: serif }` and
  `font-family` inherits, so `serif` is what an unstyled document computes.
  Browser-correct; every `zch2.4` test stubbed Helvetica for every list and so
  cannot see it.
  **Note:** an unresolvable named family in a list with NO generic falls back
  to sans-serif. `font-family: Garamond` alone admits no principled answer, and
  a name-to-class table can never be complete — the shape `rebuild.ts` already
  rejects for identifying `/Info`. Asserted directly so it stays a decision.
  **Invariant:** the resolver is memoized per DOCUMENT (a `WeakMap`) and its
  answers per family list. `buildBoxes` asks once per element. Per document
  rather than globally because a resolver closes over that document's
  registered folders, so sharing one would leak one document's fonts into
  another.
  **Invariant:** the `<title>` default is `doc.AddHtml`'s ALONE.
  `Flow.AddHtml` and `Page.AddHtml` append to a document whose title is someone
  else's business — `doc.AddMarkdown`'s own stated rule, and why it is the only
  one of the three that accepts `title`. An explicit option always wins, and a
  BLANK `<title>` yields undefined rather than `''`: `SetMetadata({ title: '' })`
  would write an empty `/Info /Title`, worse than leaving the document's own
  alone.
  **Invariant:** `doc.AddHtml` parses ONCE and hands the tree to
  `flow.AddHtml`, which is what `src: string | HtmlDocument` is for. It reads
  the title from the same tree the flow lowers.
  **Invariant:** THE CALLER MUST PLACE WITH `paragraphSpacing: 0`. Measured:
  both `normalizeFlowOptions` and `page.AddMarkdown`'s own option already
  default it to 0, so the contract holds for everyone who says nothing; a
  caller who sets it gets it added between every HTML element too, which is
  their statement and is documented rather than overridden.
  **Note on the oracle:** the equivalence test compares EXTRACTED TEXT, not
  geometry. It proves the three share a mapper; it says nothing about whether
  the mapping is right, which is `zch2.4`'s question and is held there by
  hand-built cases with no oracle at all.
```

- [ ] **Step 8: Verify the module sweep and the final gates**

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `cssfont.ts` and `htmlflow.ts` do not appear. Five names predate this work (`colorkey.ts`, `errors.ts`, `formremove.ts`, `htmlforms.ts`, `tabletag.ts`) and are each named in a neighbour's prose; leave them.

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts README.md CHANGELOG.md CLAUDE.md test/html-render.test.ts docs/superpowers/plans/2026-08-31-html-entry-points.md
git commit -m "docs(zch2.5): public exports, README, CHANGELOG and the invariants

First public API in the zch2 epic, so unlike zch2.2-zch2.4 it earns a
CHANGELOG entry and README updates. htmlElements is the whole public route;
lowerHtml, documentFamilyResolver and documentTitle stay internal and the
suite asserts their absence by name.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zch2.5 --reason "Shipped src/htmlflow.ts and src/cssfont.ts plus flow.AddHtml, page.AddHtml and doc.AddHtml. The zch2 pipeline is reachable from index.ts for the first time.

Asserted the way the issue asks: one source through all three entry points, comparing extracted text - test/markdown-render.test.ts's shape.

cssfont.ts fills the FamilyResolver seam cssbox, cssinline, cssresolve and cssflow all deferred here. LoadFontFamily is reused rather than reimplemented and fits exactly: it already walks a family chain and returns the four slots structurally identical to MarkdownFontFamily, since its own docs say the result is ready for AddMarkdown. Feeding it mdstyle.resolveFamily keeps one owner for the fill-unstated-faces rule.

Two consequences named rather than discovered: a plain <p> renders in TIMES, because the UA sheet declares html { font-family: serif } and zch2.4's tests all stubbed Helvetica; and an unresolvable named family with no generic falls back to sans-serif, since a name-to-class table can never be complete.

doc.AddHtml adopts the source's <title> when given no explicit title - which doc.AddMarkdown cannot do, Markdown having no title construct - and it applies there and on neither of the other two, which append to a document whose title is someone else's business.

Renamed cssflow's htmlFlowElements to lowerHtml: a public htmlElements beside it would be one word apart with no compiler check between them.

[N] of 12 mutations reddened something; the sweep is in the plan and any uncovered rule in CLAUDE.md.

First public API in the epic, so it carries a CHANGELOG entry and README Features/API/Limitations updates - the README states plainly that tables, images and float placement do not render and name themselves in skipped. Unblocks zch2.6 and zch2.7."

git add .beads && git commit -q -m "chore(beads): close zch2.5" && git pull --rebase && git push
```

---

## Mutation results

All twelve reddened something, over the four suites together (64 cases).

| # | Mutation | Reddened |
|---|---|---|
| 1 | `GENERIC.serif = 'Helvetica'` | **5** — three `cssfont` cases plus the Times-by-default case |
| 2 | Skip the `LoadFontFamily` branch | **4** — all three registered-family cases plus the NUL-key case |
| 3 | Drop the answer memo | **1** — "returns the SAME resolved family". NOT the pure cost rule predicted |
| 4 | `page.AddHtml` passes `rect[3]` | **1** — after the fixture was rewritten; see below |
| 5 | `flow.AddHtml` passes `columnHeight` | **1** — after the fixture was rewritten; see below |
| 6 | Drop the `<title>` default | **2** — the title case and the parse-once case |
| 7 | `<title>` beats an explicit title | **1** — the precedence case alone |
| 8 | Apply the title default in `flow.AddHtml` too | **1** — "does NOT apply the title default on the other two" |
| 9 | Zero the root box's margins | **4** — both body-margin cases and both percentage cases |
| 10 | `DEFAULT_FACE = 'Times-Roman'` | **3** — both fallback cases and the NUL-key case |
| 11 | `documentTitle` without the blank check | **1** — the empty-title case |
| 12 | Fresh resolver per call (no `WeakMap`) | **1** — "hands one document the same resolver twice" |

**Mutations 4 and 5 reddened NOTHING on their first run, and the fixtures
were wrong rather than the rules.** Both measured **text wrapping**, which
cannot see the build width at all: `BoxElement` derives its inner width from
the **placement** context, deliberately, so that a caller handing a different
width degrades instead of overflowing. What the build width actually decides
is percentage resolution — so both fixtures were rewritten around a
`margin-left: 25%`, which is resolved at build time and lands in the frame as
an absolute point value. Both then reddened exactly one case.

That is worth keeping in mind beyond these two mutations: **any HTML test
that measures wrapping is measuring the placement width**, and will stay green
under a wrong build width.

**Mutation 3 was predicted as a pure cost rule and is not.** The memo is
observable through identity — `r(['serif'])` returns the same object twice —
so dropping it reddens a case rather than merely costing time. Better than
predicted; no uncovered rule to record.

**Two defects found during implementation**, both fixed:

1. `cssfont.ts`'s `GENERIC` table was typed `Record<string, string>`, which
   `resolveFamily` (taking `MarkdownFontSpec`) rejects. Caught by
   `npm run typecheck` — but only on a second look, because piping it through
   `tail` takes `tail`'s exit code and hid the failure behind a green pipeline.
2. `test/htmlflow.test.ts` asserted on `TextFragment.font`, which does not
   exist; the field is `fontName`. The test was wrong, not the code.

## Self-review notes

**Spec coverage.** Every section maps to a task: the rename → Task 1; the font bridge, the generic table, the fallback rule and the memo → Task 2; the `htmlElements` signature, the naming rule and `<title>` extraction → Task 3; the three signatures, the equivalence test and the `<title>` precedence → Task 4; body margins → Task 4's own describe block; the public surface, CHANGELOG, README and the mutation list → Task 5. The spec's 10 named mutations are all present in Task 5's table, renumbered against the code, plus two the plan added (11: the blank-`<title>` check; 12: the per-document WeakMap).

**Interface consistency.** `documentFamilyResolver(doc)`, `htmlElements(doc, src, width, options?)`, `documentTitle(root)`, `lowerHtml`, `HtmlFlowOptions`, `HtmlFlowResult`, `HtmlElements`, `AddHtmlResult` are spelled identically in Tasks 1–5 and in the spec.

**One assumption verified, one left standing.** `GetMetadata()` (`document.ts:958`) and the `DisplayDocTitle` getter/setter pair (`document.ts:1171`/`1176`) both exist as Task 4's title cases assume — checked, not recalled. Still unverified: that case's premise that a two-column A4 flow wraps a 60-word paragraph into more fragments than a one-column one. If the counts tie, lengthen the paragraph rather than loosening the assertion — a `toBeGreaterThanOrEqual` there would pass with the width bug present, which is the whole thing it exists to catch.

**One defect found and fixed in this document.** The memo-key line contained a **literal NUL byte** rather than the escape `'\u0000'`, which made the plan a binary file to `grep` and would have been silently mangled by anyone copying the block out. The comment beside it was also weaker than the rule deserved: a space joiner is not merely inelegant, it makes `['Alpha', 'Sans']` and `['Alpha Sans']` collide — a two-family chain against one two-word family, which resolve differently.
