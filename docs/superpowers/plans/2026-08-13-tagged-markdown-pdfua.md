# Tagged Markdown for PDF/UA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tagged Markdown document pass `ValidatePdfUa`, by fixing the two structure defects that keep it from doing so and adding the two options that spare the caller three undocumented calls.

**Architecture:** Two independent halves. The structure half fixes `flowblock.ts`: a code block currently paints untagged text into a tagged page (a defect since `gl6o.3.2`) and a block quote's contents tag as bare `/P`. The options half adds `FlowOptions.lang` (written to the flow's own `/Sect`, never the catalog) and a `title` option on `Document.AddMarkdown`, plus a `Document.DisplayDocTitle` accessor that gives that catalog flag one writer instead of two.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies (`node:` built-ins only).

**Spec:** `docs/superpowers/specs/2026-08-13-tagged-markdown-pdfua-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **`npm run typecheck && npm test` must be green before every commit.**
- **Untagged output must not change, in any respect.** Every new structure element is created only when `ctx.structParent` is present. Where a task claims this, it is asserted.
- **Option validation throws `TypeError` before anything is allocated.** Nothing in the Markdown stack throws on document *content*.
- **A struct tree is cyclic** (kids link back to parents). Never `JSON.stringify` it in a test — walk it.
- **`ValidationReport` exposes `Issues` (capital I), `Errors`, `Warnings`, `Passed`.** `UntaggedContent` is a **warning**, so it appears in `Issues` and not in `Errors`.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

## Shared test helper

Tasks 1-3 and 5-7 all walk the structure tree. Each test file defines this locally rather than importing a shared fixture — the suite's existing style, and three lines is cheaper than a helper module:

```ts
const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};
```

---

## Phase 1 — the structure defects (Tasks 1-3)

### Task 1: A code block tags its own text

`CodeBlockElement.place` calls `flowTextBlock(ctx.doc, ctx.page, this.text, rect, this.opts)` and `this.opts` never carries a `tag`, so the text is painted into a tagged page as neither tagged nor artifacted. This has been shipping since `gl6o.3.2`.

**Files:**
- Modify: `src/flowblock.ts` (`CodeBlockElement`, ~lines 211-258)
- Test: `test/flow-tagging.test.ts` (create)

**Interfaces:**
- Produces: `CodeBlockElement` gains a seventh constructor parameter `private code?: StructElement` — the `/Code` element, carried into the continuation. Module-private; Task 2 adds a different parameter to a different class.

- [ ] **Step 1: Write the failing test**

Create `test/flow-tagging.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';

/** Every element of `type` in the tree. The tree is cyclic (kids link back to
 *  parents), so it must be walked rather than serialized. */
const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

const untagged = (doc: Document): number =>
  doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent').length;

describe('a tagged code block', () => {
  it('leaves no untagged content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddCodeBlock('const x = 1;\nconst y = 2;');
    flow.Render();
    expect(untagged(doc)).toBe(0);
  });

  it('emits /P > /Code', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddCodeBlock('const x = 1;');
    flow.Render();
    const codes = collect(doc, 'Code');
    expect(codes.length).toBe(1);
    // /Code is inline level (32000-1 14.8.4.3); its parent must be block level.
    expect(codes[0].Parent?.Type).toBe('P');
  });

  it('emits ONE /Code for a code block split across a column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, tagged: true });
    // Far more lines than one column can hold.
    flow.AddCodeBlock(Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n'));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(collect(doc, 'Code').length).toBe(1);
  });

  it('creates no structure at all for an untagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock('const x = 1;');
    flow.Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: the first three FAIL — `untagged(doc)` is 1, and no `/Code` exists. The fourth PASSES already.

- [ ] **Step 3: Import `StructElement` into `src/flowblock.ts`**

Add beside the existing imports:

```ts
import type { StructElement } from './struct.js';
```

- [ ] **Step 4: Carry the element on `CodeBlockElement`**

Add a seventh constructor parameter (note: NOT `readonly` — `place` assigns to it):

```ts
class CodeBlockElement implements FlowElement {
  constructor(
    /** Already through {@link preformat}. */
    private readonly text: string,
    private readonly opts: TextBlockOptions,
    private readonly padding: number,
    private readonly background: [number, number, number] | undefined,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
    /** The /Code this block's text tags into, created on first draw and carried
     *  into the continuation so a split code block is ONE element. */
    private code?: StructElement,
  ) {}
```

- [ ] **Step 5: Create it and tag the text**

In `place`, replace the `flowTextBlock` call and the `remainder` construction:

```ts
    // Created on the first draw, never at construction: a code block that draws
    // nothing must leave no orphan element behind — the rule TextElement and
    // TableTagger both follow. /P is block level and /Code is inline level
    // (32000-1 14.8.4.3), so a bare /Code here would put an ILSE where a BLSE
    // belongs — which this repo's own validator has no rule to catch.
    if (this.code === undefined && ctx.structParent !== undefined)
      this.code = ctx.structParent.Append('P').Append('Code');
    const opts = this.code ? { ...this.opts, tag: this.code } : this.opts;
    const { remainder } = flowTextBlock(ctx.doc, ctx.page, this.text, rect, opts);
    return {
      usedHeight: used,
      remainder: remainder === null ? null
        : new CodeBlockElement(remainder, this.opts, this.padding, this.background,
          0, this.spaceAfter, undefined, this.code),
      drew: true,
    };
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/flowblock.ts test/flow-tagging.test.ts
git commit -m "$(cat <<'EOF'
fix(flow): a code block tags its own text

CodeBlockElement drew through flowTextBlock with options that never carried a
tag, so in a tagged flow its text was neither tagged nor artifacted — shipping
since gl6o.3.2 and invisible because UntaggedContent is a per-page warning that
names no element.

/P wrapping /Code because /Code is inline level (32000-1 14.8.4.3) and a code
block is not. Our own validator has no block/inline nesting rule, so a bare
/Code would have passed it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: A block quote emits `/BlockQuote`

`quote()` lowers to N `QuotedElement` decorators, each passing `ctx.structParent` straight through, so quoted paragraphs land as bare `/P` siblings of unquoted ones.

**Files:**
- Modify: `src/flowblock.ts` (`QuotedElement` ~lines 315-382, `quote` ~lines 386-419)
- Test: `test/flow-tagging.test.ts` (append)

**Interfaces:**
- Consumes: `StructElement` import (Task 1).
- Produces: `interface QuoteStruct { elem?: StructElement }`, module-private to `flowblock.ts`; `QuotedElement` gains an eighth constructor parameter `private readonly st: QuoteStruct`.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-tagging.test.ts`:

Hoist these two imports to the top of the file beside the existing ones:

```ts
import { paragraph } from '../src/flow.js';
import { quote } from '../src/flowblock.js';
```

then append:

```ts
describe('a tagged block quote', () => {
  it('wraps its contents in one /BlockQuote', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote([...paragraph('first'), ...paragraph('second'), ...paragraph('third')]);
    flow.Render();
    const bq = collect(doc, 'BlockQuote');
    // ONE element shared by all three children, not one each.
    expect(bq.length).toBe(1);
    expect(bq[0].Children.map((c) => c.Type)).toEqual(['P', 'P', 'P']);
  });

  it('puts a nested quote inside the outer one', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote([...paragraph('outer'), ...quote(paragraph('inner'))]);
    flow.Render();
    const bq = collect(doc, 'BlockQuote');
    expect(bq.length).toBe(2);
    // The inner one is a descendant of the outer, not a sibling.
    expect(bq.some((e) => e.Parent?.Type === 'BlockQuote')).toBe(true);
  });

  it('emits ONE /BlockQuote for a quote split across a column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, tagged: true });
    const long = Array.from({ length: 40 },
      (_, i) => paragraph(`quoted paragraph number ${i} with enough words to occupy a line`));
    flow.AddQuote(long.flat());
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(collect(doc, 'BlockQuote').length).toBe(1);
  });

  it('leaves no untagged content', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddQuote(paragraph('quoted'));
    flow.Render();
    expect(untagged(doc)).toBe(0);
  });

  it('creates no structure at all for an untagged flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddQuote(paragraph('quoted'));
    flow.Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: the three `/BlockQuote` assertions FAIL (zero elements exist). The two "no untagged content" / "untagged flow" cases PASS already — quoted paragraphs are tagged, just not grouped.

- [ ] **Step 3: Add the shared holder to `src/flowblock.ts`**

Immediately above `class QuotedElement`:

```ts
/** The /BlockQuote a quote's children share.
 *
 *  **Invariant:** this is per-QUOTE state, not per-element. `quote()` lowers to
 *  one QuotedElement per child block, and whichever draws FIRST creates the
 *  element while every other sibling must find it — give each its own and a
 *  three-paragraph quote becomes three /BlockQuotes. The same holder rides into
 *  a continuation, so a quote split across a column stays one element. This is
 *  the pattern gl6o.3.2 used for a list item's marker and gl6o.3.3 for a split
 *  table's TableTagger. @internal */
interface QuoteStruct { elem?: StructElement }
```

- [ ] **Step 4: Thread it through `QuotedElement`**

Add the parameter (last, after `clear`):

```ts
    readonly clear?: FlowClear,
    /** Shared with every sibling of this quote; see {@link QuoteStruct}. */
    private readonly st: QuoteStruct = {},
  ) {}
```

and substitute the parent in `place`:

```ts
  place(ctx: PlaceContext): PlaceResult {
    // Created on the first sibling that draws, so a quote that draws nothing
    // leaves no orphan element.
    if (this.st.elem === undefined && ctx.structParent !== undefined)
      this.st.elem = ctx.structParent.Append('BlockQuote');
    const res = this.inner.place({
      ...ctx,
      structParent: this.st.elem ?? ctx.structParent,
      x: ctx.x + this.indent,
      width: ctx.width - this.indent,
    });
    if (res.drew && this.bar) this.paintBar(ctx, res.usedHeight, res.remainder !== null);
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new QuotedElement(res.remainder, this.indent, this.bar, this.continues,
          this.barExtend, 0, this.spaceAfter, undefined, this.st),
      // A continuation carries no `clear`: the quote already cleared once.
    };
  }
```

- [ ] **Step 5: Share one holder across the siblings in `quote()`**

In `quote`, immediately before the `return blocks.map(...)`:

```ts
  // One holder for the whole quote — see QuoteStruct.
  const st: QuoteStruct = {};
```

and pass it as the last argument of each `new QuotedElement(...)`:

```ts
    return new QuotedElement(
      inner, indent, bar, !last, extend,
      i === 0 ? spaceBefore + (inner.spaceBefore ?? 0) : (inner.spaceBefore ?? 0),
      last ? spaceAfter + (inner.spaceAfter ?? 0) : (inner.spaceAfter ?? 0),
      i === 0 ? clear : undefined,
      st,
    );
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Confirm the shared holder is load-bearing**

Temporarily change `quote()` to give each sibling its own holder — replace the
single `const st: QuoteStruct = {};` with a fresh `{}` inline at each
`new QuotedElement(..., {})`. Re-run. Expected: "wraps its contents in one
/BlockQuote" goes red with 3 elements. Restore.

- [ ] **Step 8: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/flowblock.ts test/flow-tagging.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): a block quote emits /BlockQuote

Quoted paragraphs tagged as bare /P siblings of unquoted ones, so the quotation
was invisible to assistive technology. The element is per-QUOTE state shared by
every child and carried into a continuation: per-element state yields one
/BlockQuote per paragraph, and dropping it on a split yields one per column.
Both are asserted, and the sharing was confirmed to go red without the holder.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The per-construct tagging sweep

The sweep that turned a vague "PDF/UA conformance" issue into three concrete defects becomes a permanent fence. Asserting structure types alone would NOT have caught Task 1's defect — a missing element and an artifacted one look identical in a type list — so it asserts untagged content too.

**Files:**
- Test: `test/flow-tagging.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1-2.

- [ ] **Step 1: Write the test**

Append to `test/flow-tagging.test.ts`:

```ts
/** Every Markdown construct, its expected structure types, in document order.
 *
 *  This table is the fence. It was written by MEASURING what each construct
 *  emits, which is how gl6o.4's defects were found at all: a code block emitted
 *  nothing and tripped UntaggedContent, and a quote emitted a bare /P. Asserting
 *  types alone would have missed the first — an element that was never created
 *  and one that was correctly artifacted look identical in a type list — so the
 *  untagged count is asserted for every case. */
const CONSTRUCTS: [name: string, src: string, types: string[]][] = [
  ['heading', '# Title', ['Sect', 'H1']],
  ['paragraph', 'just a paragraph', ['Sect', 'P']],
  ['bullet list', '- a\n- b',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['ordered list', '1. a\n2. b',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['task list', '- [x] done\n- [ ] todo',
    ['Sect', 'L', 'LI', 'Lbl', 'LBody', 'LI', 'Lbl', 'LBody']],
  ['block quote', '> quoted text', ['Sect', 'BlockQuote', 'P']],
  ['code block', '```\ncode line\n```', ['Sect', 'P', 'Code']],
  // A thematic break is decoration and is correctly artifacted, so it
  // contributes no element — only the paragraphs either side of it.
  ['thematic break', 'before\n\n---\n\nafter', ['Sect', 'P', 'P']],
  ['table', '| a | b |\n| - | - |\n| 1 | 2 |',
    ['Sect', 'Table', 'TR', 'TH', 'TH', 'TR', 'TD', 'TD']],
  ['link', 'see [docs](https://example.com)', ['Sect', 'P', 'Link']],
];

describe('every Markdown construct tags itself', () => {
  for (const [name, src, expected] of CONSTRUCTS) {
    it(`${name}: emits ${expected.join(' > ')} and nothing untagged`, () => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
      flow.AddMarkdown(src, { gfm: true });
      flow.Render();

      const types: string[] = [];
      const walk = (e: StructElement): void => {
        types.push(e.Type);
        for (const k of e.Children) walk(k);
      };
      for (const k of doc.GetStructTree()!.Children) walk(k);

      expect(types).toEqual(expected);
      expect(untagged(doc)).toBe(0);
    });
  }
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: PASS (19 tests). If a `types` array does not match, the *measured*
value is the truth about current behaviour — check whether the difference is a
defect (fix the code) or an expectation error (fix the table). Do not adjust the
table merely to make it green.

- [ ] **Step 3: Confirm the sweep catches Task 1's defect**

Temporarily revert Task 1's change — in `CodeBlockElement.place`, replace
`flowTextBlock(ctx.doc, ctx.page, this.text, rect, opts)` with
`flowTextBlock(ctx.doc, ctx.page, this.text, rect, this.opts)`. Re-run.
Expected: the `code block` case goes red on BOTH assertions. Restore.

- [ ] **Step 4: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add test/flow-tagging.test.ts
git commit -m "$(cat <<'EOF'
test(flow): sweep every Markdown construct's tagging

The measurement that found gl6o.4's two defects, made permanent. It asserts the
untagged count alongside the structure types because types alone cannot
distinguish an element that was never created from one correctly artifacted —
which is exactly how the code-block defect survived two issues.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — the options (Tasks 4-6)

### Task 4: `Document.DisplayDocTitle`

**Files:**
- Modify: `src/document.ts` (beside `Document.Lang`, ~line 1044)
- Modify: `src/pdfuaconvert.ts` (`displayDocTitlePass`, ~lines 58-66)
- Test: `test/document-viewerprefs.test.ts` (create)

**Interfaces:**
- Produces: `Document.DisplayDocTitle: boolean` (get/set). Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `test/document-viewerprefs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { PdfDict, PdfObject } from '../src/types.js';

describe('Document.DisplayDocTitle', () => {
  it('is false on a fresh document', () => {
    expect(Document.New().DisplayDocTitle).toBe(false);
  });

  it('round-trips through a save and reopen', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.DisplayDocTitle = true;
    expect(doc.DisplayDocTitle).toBe(true);
    expect(Document.Open(doc.Save()).DisplayDocTitle).toBe(true);
  });

  it('can be turned back off', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.DisplayDocTitle = true;
    doc.DisplayDocTitle = false;
    expect(Document.Open(doc.Save()).DisplayDocTitle).toBe(false);
  });

  it('preserves other ViewerPreferences entries', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    // A pre-existing dict must be EXTENDED, not replaced — the setter creates
    // one only when there is none.
    const vp: PdfDict = new Map<string, PdfObject>([['FitWindow', true]]);
    doc.catalog().set('ViewerPreferences', vp);
    doc.DisplayDocTitle = true;
    const re = Document.Open(doc.Save());
    const back = re.resolve(re.catalog().get('ViewerPreferences')) as PdfDict;
    expect(back.get('FitWindow')).toBe(true);
    expect(back.get('DisplayDocTitle')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/document-viewerprefs.test.ts`
Expected: FAIL — `DisplayDocTitle` is not a property.

- [ ] **Step 3: Add the accessor to `src/document.ts`**

Immediately after the `Lang` setter:

```ts
  /** Catalog /ViewerPreferences /DisplayDocTitle: whether a viewer shows the
   *  document's title rather than its file name. PDF/UA requires it true, and a
   *  /Info /Title without it satisfies neither — which is why the two are set
   *  together wherever this library sets either. */
  get DisplayDocTitle(): boolean {
    const vp = this.resolve(this.catalog().get('ViewerPreferences'));
    return isDict(vp) && this.resolve(vp.get('DisplayDocTitle')) === true;
  }

  set DisplayDocTitle(v: boolean) {
    let vp = this.resolve(this.catalog().get('ViewerPreferences'));
    if (!isDict(vp)) {
      vp = new Map<string, PdfObject>();
      this.catalog().set('ViewerPreferences', vp);
    }
    (vp as PdfDict).set('DisplayDocTitle', v);
    this.markModified();
  }
```

`isDict`, `PdfObject` and `PdfDict` are already imported at `src/document.ts:9`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/document-viewerprefs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite the conversion pass over it**

In `src/pdfuaconvert.ts` replace `displayDocTitlePass` entirely:

```ts
/** Set catalog /ViewerPreferences /DisplayDocTitle true. One writer for the
 *  flag, shared with Document.AddMarkdown's `title` option. */
const displayDocTitlePass: Pass = (ctx) => {
  if (ctx.doc.DisplayDocTitle) return [];
  ctx.doc.DisplayDocTitle = true;
  return [{ rule: 'DisplayDocTitle', action: 'Set /ViewerPreferences /DisplayDocTitle true.' }];
};
```

The already-true early return is preserved: the pass reports whether it changed
anything, and returning an action for a no-op would overstate what conversion did.

- [ ] **Step 6: Run the conversion suite**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/document.ts src/pdfuaconvert.ts test/document-viewerprefs.test.ts
git commit -m "$(cat <<'EOF'
feat(document): a DisplayDocTitle accessor

Beside Document.Lang, and pdfuaconvert's inline pass rewritten over it, so the
catalog flag has one writer rather than two — Task 6's `title` option is the
second caller.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `FlowOptions.lang`

**Files:**
- Modify: `src/flow.ts` (`FlowOptions` ~line 44, `Flow` constructor ~line 1040, `Render` ~line 1183)
- Test: `test/flow-tagging.test.ts` (append)

**Interfaces:**
- Produces: `FlowOptions.lang?: string`. Reaches `Document.AddMarkdown` unchanged, since that already takes `MarkdownFlowOptions & FlowOptions`.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-tagging.test.ts`:

```ts
describe('FlowOptions.lang', () => {
  const naturalLanguageErrors = (doc: Document): number =>
    doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'NaturalLanguage').length;

  it('clears every NaturalLanguage error', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'en-US' });
    flow.AddMarkdown('# T\n\npara\n\n- a\n- b');
    flow.Render();
    expect(naturalLanguageErrors(doc)).toBe(0);
  });

  it('writes the flow /Sect, not the catalog', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'fr-FR' });
    flow.AddMarkdown('bonjour');
    flow.Render();
    expect(collect(doc, 'Sect')[0].Lang).toBe('fr-FR');
    // The document's own language is untouched: a flow appended to an existing
    // document must not relabel it.
    expect(doc.Lang).toBeUndefined();
  });

  it('lets two flows carry different languages in one document', () => {
    const doc = Document.New();
    doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'en-US' })
      .AddMarkdown('english').Render();
    doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: 'fr-FR' })
      .AddMarkdown('francais').Render();
    expect(collect(doc, 'Sect').map((s) => s.Lang).sort()).toEqual(['en-US', 'fr-FR']);
    expect(naturalLanguageErrors(doc)).toBe(0);
  });

  it('rejects lang without tagged', () => {
    const doc = Document.New();
    // An untagged flow has no /Sect to carry it, so the option would silently do
    // nothing — the exact failure this issue exists to close.
    expect(() => doc.NewFlow({ format: PageFormat.A4, lang: 'en-US' })).toThrow(TypeError);
  });

  it('rejects an empty lang', () => {
    const doc = Document.New();
    expect(() => doc.NewFlow({ format: PageFormat.A4, tagged: true, lang: '' }))
      .toThrow(TypeError);
  });

  it('leaves a flow with no lang exactly as before', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddMarkdown('para');
    flow.Render();
    expect(collect(doc, 'Sect')[0].Lang).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: FAIL — `lang` is not a `FlowOptions` property (a type error at
compile, and the rejection cases do not throw).

- [ ] **Step 3: Add the option to `FlowOptions` in `src/flow.ts`**

Inside the `FlowOptions` interface, after `tagged`:

```ts
  /** Natural language of this flow's content, as a BCP 47 tag (e.g. 'en-US'),
   *  written to the `/Sect` the flow creates. Requires `tagged: true`.
   *
   *  It goes on the flow's own element rather than the document catalog so two
   *  flows in different languages can share one document, and so appending a
   *  flow to an existing document cannot relabel that document's language.
   *  `StructElement.EffectiveLang` walks ancestors before falling back to
   *  `Document.Lang`, so this satisfies PDF/UA's natural-language requirement
   *  for exactly the content this flow adds. */
  lang?: string;
```

- [ ] **Step 4: Validate it in the `Flow` constructor**

`normalizeFlowOptions` returns `Geometry`, which carries page and column
measurements only and never sees `tagged` — so the cross-check belongs in the
constructor, where both values are in hand. Add a field and the check after
`this.tagged` is assigned:

```ts
  private readonly lang?: string;
```

```ts
    this.tagged = options?.tagged ?? false;
    if (options?.lang !== undefined) {
      if (typeof options.lang !== 'string' || options.lang === '')
        throw new TypeError('lang must be a non-empty string');
      if (!this.tagged)
        throw new TypeError('lang requires tagged: true — an untagged flow has no /Sect to carry it');
    }
    this.lang = options?.lang;
```

- [ ] **Step 5: Apply it at the `/Sect`**

In `Render`, immediately after `structParent` is built:

```ts
    const structParent = this.tagged
      ? this.doc.CreateStructTree().Append('Sect')
      : undefined;
    if (structParent !== undefined && this.lang !== undefined) structParent.Lang = this.lang;
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/flow-tagging.test.ts`
Expected: PASS (25 tests).

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/flow.ts test/flow-tagging.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): a lang option, written to the flow's own /Sect

EffectiveLang walks ancestors before falling back to Document.Lang, so a /Sect
/Lang satisfies PDF/UA for exactly the content the flow added — and two flows in
different languages can share one document without fighting over the catalog.

lang without tagged throws rather than being ignored: an untagged flow has no
/Sect, so the option would silently do nothing, which is the failure mode this
issue exists to close.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `title` on `Document.AddMarkdown`

**Files:**
- Modify: `src/document.ts` (`AddMarkdown`, ~lines 1958-1964)
- Test: `test/markdown-render.test.ts` (append)

**Interfaces:**
- Consumes: `Document.DisplayDocTitle` (Task 4).
- Produces: `Document.AddMarkdown(src, options?: MarkdownFlowOptions & FlowOptions & { title?: string })`.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-render.test.ts`:

```ts
describe('Document.AddMarkdown title', () => {
  it('sets /Info, XMP dc:title and DisplayDocTitle together', () => {
    const doc = Document.New();
    doc.AddMarkdown('# T\n\nbody', { format: PageFormat.A4, title: 'Quarterly Report' });
    expect(doc.GetMetadata().title).toBe('Quarterly Report');
    expect(doc.GetXmp().title).toBe('Quarterly Report');
    // A title without DisplayDocTitle satisfies neither PDF/UA nor the caller's
    // intent, so the two are set together or not at all.
    expect(doc.DisplayDocTitle).toBe(true);
  });

  it('touches neither when no title is given', () => {
    const doc = Document.New();
    doc.AddMarkdown('body', { format: PageFormat.A4 });
    expect(doc.GetMetadata().title).toBeUndefined();
    expect(doc.DisplayDocTitle).toBe(false);
  });

  it('rejects an empty title', () => {
    const doc = Document.New();
    expect(() => doc.AddMarkdown('body', { format: PageFormat.A4, title: '' }))
      .toThrow(TypeError);
  });

  it('rejects a non-string title before rendering anything', () => {
    const doc = Document.New();
    expect(() => doc.AddMarkdown('body', {
      format: PageFormat.A4, title: 7 as unknown as string,
    })).toThrow(TypeError);
    // Nothing was allocated: no page was appended.
    expect(doc.Pages.length).toBe(0);
  });
});
```

Both accessors are verified against `src/document.ts`: `GetMetadata(): Metadata`
and `GetXmp(): XmpMetadata`, neither nullable, both carrying an optional
`title`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: FAIL — `title` is not accepted and nothing is set.

- [ ] **Step 3: Add the option in `src/document.ts`**

Replace `AddMarkdown` entirely:

```ts
  /** Render a whole Markdown document, appending freshly sized pages to the end
   *  of this document. The one-call form of `NewFlow` + `AddMarkdown` +
   *  `Render`; `options` carries both the Markdown options (`gfm`, `style`,
   *  `resolveImage`) and the flow's page geometry (`format`, `columns`,
   *  `margin*`, `tagged`, `lang`).
   *
   *  `title` is accepted here and on neither of the other two entry points:
   *  this is the one that authors a whole document, while `Flow.AddMarkdown`
   *  and `Page.AddMarkdown` append to a document whose title is someone else's
   *  business. It writes `/Info /Title`, XMP `dc:title` and
   *  `/ViewerPreferences /DisplayDocTitle` together — a title without the flag
   *  satisfies neither PDF/UA nor the caller's intent. */
  AddMarkdown(
    src: string | MdDocument,
    options: MarkdownFlowOptions & FlowOptions & {
      /** Document title. Non-empty. Default: the document's title is untouched. */
      title?: string;
    } = {},
  ): { pages: Page[]; skipped: string[] } {
    // Validated before anything is allocated, so a rejected call leaves the
    // document byte-identical — the rule every authoring entry point follows.
    const title = options.title;
    if (title !== undefined && (typeof title !== 'string' || title === ''))
      throw new TypeError('title must be a non-empty string');
    const flow = new Flow(this, options);
    const { skipped } = flow.AddMarkdown(src, options);
    const pages = flow.Render();
    if (title !== undefined) {
      this.SetMetadata({ title });   // mirrors to XMP dc:title on its own
      this.DisplayDocTitle = true;
    }
    return { pages, skipped };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/document.ts test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): a title option on Document.AddMarkdown

Writes /Info /Title, XMP dc:title and DisplayDocTitle together: a title without
the flag satisfies neither PDF/UA nor the caller's intent. On this entry point
only — it is the one that authors a whole document, while the flow and page
forms append to a document whose title is someone else's business.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — the goal, stated once (Task 7)

### Task 7: End-to-end PDF/UA pass, and documentation

**Files:**
- Test: `test/markdown-pdfua.test.ts` (create)
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: every task above.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-pdfua.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** Every construct the renderer supports, in one document. */
const SRC = [
  '# Title',
  '',
  'A paragraph with **bold**, *italic* and `code`, plus a [link](https://example.com).',
  '',
  '- first item',
  '- second item',
  '',
  '1. ordered',
  '2. items',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '> a block quote',
  '',
  '```',
  'code line',
  '```',
  '',
  '---',
  '',
  '| Name | Qty |',
  '| :--- | --: |',
  '| apples | 12 |',
].join('\n');

describe('a tagged Markdown document passes PDF/UA', () => {
  it('passes with lang and title supplied', () => {
    const doc = Document.New();
    doc.AddMarkdown(SRC, {
      format: PageFormat.A4, tagged: true, gfm: true,
      lang: 'en-US', title: 'Everything',
    });
    const report = doc.ValidatePdfUa();
    // Name what failed rather than just asserting a boolean.
    expect(report.Errors.map((e) => e.rule)).toEqual([]);
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent')).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('still passes after a save and reopen', () => {
    const doc = Document.New();
    doc.AddMarkdown(SRC, {
      format: PageFormat.A4, tagged: true, gfm: true,
      lang: 'en-US', title: 'Everything',
    });
    expect(Document.Open(doc.Save()).ValidatePdfUa().Passed).toBe(true);
  });

  it('reports what is missing when lang and title are omitted', () => {
    // The library never fabricates accessibility metadata; the caller supplies
    // it, and the validator says so plainly when they do not.
    const doc = Document.New();
    doc.AddMarkdown(SRC, { format: PageFormat.A4, tagged: true, gfm: true });
    const rules = new Set(doc.ValidatePdfUa().Errors.map((e) => e.rule));
    expect(rules).toContain('NaturalLanguage');
    expect(rules).toContain('DocumentTitle');
  });

  it('page.AddMarkdown is conformant under a caller-supplied structParent', () => {
    // page.AddMarkdown has no `lang` option by design: the caller owns the
    // element, and setting its Lang is the one-liner that replaces the option.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const sect = doc.CreateStructTree().Append('Sect');
    sect.Lang = 'en-US';
    page.AddMarkdown(SRC, [72, 72, 451, 698], { gfm: true, structParent: sect });
    doc.SetMetadata({ title: 'Everything' });
    doc.DisplayDocTitle = true;
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/markdown-pdfua.test.ts`
Expected: PASS (4 tests). If the fourth fails because the source overflows the
rect and the remainder is dropped, shorten `SRC` for that case only — a dropped
remainder is not a conformance defect, and the other three cases already cover
the whole source.

- [ ] **Step 3: Update `README.md`**

In the **Markdown** section of the API overview, after the "Into a rect"
example, add:

````markdown
For a PDF/UA-conformant document, supply the two things the library will never
invent — the content's language and the document's title:

```ts
const doc = Document.New();
doc.AddMarkdown(source, {
  format: PageFormat.A4, gfm: true,
  tagged: true,
  lang:  'en-US',              // -> /Lang on the flow's /Sect
  title: 'Quarterly Report',   // -> /Info, XMP dc:title, DisplayDocTitle
});
doc.ValidatePdfUa().Passed;    // true
```

`lang` goes on the flow's own `/Sect`, not the catalog, so two flows in
different languages can share one document and appending a flow never relabels
the document it joins. It requires `tagged: true` and throws otherwise, since an
untagged flow has no element to carry it. `page.AddMarkdown` takes no `lang`:
it already accepts a `structParent` you own, and `element.Lang = 'en-US'` is the
equivalent.
````

Add these rows to the Markdown member table:

```
| `lang` (flow option) | Natural language of the flow's content, written to its `/Sect`. Requires `tagged: true` |
| `title` (doc option) | Document title: `/Info /Title`, XMP `dc:title` and `/ViewerPreferences /DisplayDocTitle` |
| `doc.DisplayDocTitle` | Whether a viewer shows the title rather than the file name. Required true by PDF/UA |
```

In **Features**, extend the "Markdown to PDF" bullet's tagging sentence to end:

```
Supply `lang` and `title` and the result passes `ValidatePdfUa` outright.
```

- [ ] **Step 4: Update `CLAUDE.md`**

Append to the `runlink.ts`/`flowtable.ts` entry's invariant list:

```markdown
  **Invariant:** a tagged flow element tags its own ink or artifacts it — there
  is no third option. A code block did neither from `gl6o.3.2` to `gl6o.4` and
  no test noticed: `UntaggedContent` is a per-page WARNING that names no
  element, and the only Markdown fixture reaching the validator had no code
  block in it. `test/flow-tagging.test.ts` sweeps every construct and asserts
  the untagged count beside the structure types, because a type list cannot
  distinguish an element that was never created from one correctly artifacted.
  **Invariant:** a quote's `/BlockQuote` is per-QUOTE state shared by its
  siblings, and it survives a split. Per-element state yields one element per
  paragraph; dropping it on a split yields one per column. Same holder pattern
  as a list item's marker and a paginated table's `TableTagger`.
  **Invariant:** `/Code` is inline level and `/BlockQuote` is grouping level
  (32000-1 §14.8.4.3 and §14.8.4.1), so a code block is `/P` > `/Code`.
  `structvalidate.ts` has no block/inline nesting rule, so a bare `/Code` passes
  our own report — do not cite it as evidence here.
  **Invariant:** `FlowOptions.lang` writes the flow's `/Sect`, never the
  catalog. `EffectiveLang` walks ancestors before falling back to
  `Document.Lang`, so the `/Sect` is enough — and a flow appended to an existing
  document must not relabel that document. It requires `tagged: true` and throws
  otherwise, because an untagged flow has no `/Sect` and the option would
  silently do nothing.
```

- [ ] **Step 5: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add test/markdown-pdfua.test.ts README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
test(markdown): a tagged Markdown document passes PDF/UA

The issue's goal as one assertion, false today for four distinct reasons. The
companion case asserts that omitting lang and title still REPORTS them: the
library never fabricates accessibility metadata.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing the issue

- [ ] **Run the whole gate one more time**

```bash
npm run typecheck
npm test
npm run build
```

All three must be green. `test/rich-runs-identity.test.ts` and
`test/table-slice-identity.test.ts` are the byte-identity fences inherited from
`gl6o.3.1`/`gl6o.3.3`; neither should move, because every element this work adds
is created only when `ctx.structParent` is present.

- [ ] **Close the subsumed issue and this one**

`xsmk` ("Markdown: emit /Code and /BlockQuote structure types") is delivered by
Tasks 1-2 and must not be left open:

```bash
bd close aspose-pdf-foss-for-ts-xsmk
bd close aspose-pdf-foss-for-ts-gl6o.4
```

- [ ] **Close the epic if it is done**

`gl6o.4` is the last child of `gl6o` ((EPIC) Markdown to PDF authoring); `gl6o.1`,
`gl6o.2` and `gl6o.3` are already closed. Verify with `bd show gl6o` and close it
if all four children are closed.

- [ ] **Push**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```
