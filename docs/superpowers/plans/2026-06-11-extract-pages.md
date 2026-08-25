# Document.ExtractPages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.ExtractPages(numbers: number[]): Document` — copy an arbitrary, caller-ordered subset of pages (repeats allowed) into one new self-contained Document.

**Architecture:** Reuse the existing private whole-document importer `importPages` (dedups shared objects, flattens inherited MediaBox/CropBox/Resources/Rotate, sanitizes annots) by widening it with an optional `pages: Page[] = other.Pages` parameter. `ExtractPages` validates Reorder-style, builds an empty document (`createEmptyDocument`), imports the selected leaves into it, and syncs Kids. No serializer changes.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest. Spec: `docs/superpowers/specs/2026-06-11-extract-pages-design.md`. Issue: `aspose-pdf-foss-for-ts-b2p`.

**Pre-verified:** `importPages` has exactly one caller (`InsertPages`, `src/document.ts`), and it is `private` — no test file calls it. The default parameter keeps every existing caller's behavior identical.

---

### Task 1: ExtractPages core — validation, ordering, repeats, round-trip

**Files:**
- Create: `test/extract-pages.test.ts`
- Modify: `src/document.ts` (widen `importPages` signature; add `ExtractPages` after `Split`)

- [ ] **Step 1: Write the failing tests**

Create `test/extract-pages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';

/** Decoded text of page `i` (0-based) of `doc`, for order assertions. */
const text = (doc: Document, i: number) =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('Document.ExtractPages — core', () => {
  it('extracts the given pages into a new document in the given order', () => {
    const src = Document.Open(buildClassicPdf(5));
    const out = src.ExtractPages([2, 3, 5]);
    expect(out.Pages.length).toBe(3);
    expect(text(out, 0)).toContain('Page 2');
    expect(text(out, 1)).toContain('Page 3');
    expect(text(out, 2)).toContain('Page 5');
  });

  it('extracts a single page', () => {
    const src = Document.Open(buildClassicPdf(4));
    const out = src.ExtractPages([4]);
    expect(out.Pages.length).toBe(1);
    expect(text(out, 0)).toContain('Page 4');
  });

  it('allows repeats, producing distinct page objects', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([2, 2]);
    expect(out.Pages.length).toBe(2);
    expect(text(out, 0)).toContain('Page 2');
    expect(text(out, 1)).toContain('Page 2');
    // Distinct objects: mutating one copy does not change the other.
    out.Pages[0].Dict.set('UserUnit', 2);
    expect(out.Pages[1].Dict.has('UserUnit')).toBe(false);
  });

  it('full-range extraction reproduces the whole document', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([1, 2, 3]);
    expect(out.Pages.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(text(out, i)).toContain(`Page ${i + 1}`);
  });

  it('throws RangeError on empty, out-of-range, and non-integer input', () => {
    const src = Document.Open(buildClassicPdf(5));
    for (const bad of [[], [0], [6], [1.5]] as number[][]) {
      expect(() => src.ExtractPages(bad)).toThrow(RangeError);
    }
    expect(src.Pages.length).toBe(5); // untouched after throws
  });

  it('does not mutate the source document', () => {
    const src = Document.Open(buildClassicPdf(3));
    const out = src.ExtractPages([1, 3]);
    expect(src.Pages.length).toBe(3);
    expect(text(src, 2)).toContain('Page 3');
    // Editing the extracted doc must not leak back into the source.
    out.Pages[0].Dict.set('UserUnit', 2);
    expect(src.Pages[0].Dict.has('UserUnit')).toBe(false);
  });

  it('round-trips through Save()/Open', () => {
    const src = Document.Open(buildClassicPdf(5));
    const reopened = Document.Open(src.ExtractPages([2, 5]).Save());
    expect(reopened.Pages.length).toBe(2);
    expect(new TextDecoder().decode(reopened.Pages[0].Contents)).toContain('Page 2');
    expect(new TextDecoder().decode(reopened.Pages[1].Contents)).toContain('Page 5');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/extract-pages.test.ts`
Expected: FAIL — every test errors with `src.ExtractPages is not a function`.

- [ ] **Step 3: Widen `importPages` with a `pages` subset parameter**

In `src/document.ts`, change the `importPages` signature and its leaf loop (only these two lines change; the doc comment gains the subset sentence):

```ts
  /** Whole-document import: deep-copy the given `pages` of `other` (default: all
   *  of them) into this.objects with fresh offset object numbers. Shared objects
   *  are copied once (one old->new map), inherited MediaBox/CropBox/Resources/Rotate
   *  are flattened onto each leaf, and /Annots are sanitized via defaultPrunePolicy.
   *  Each new leaf is re-parented to `rootNum`. Returns the new leaf object numbers
   *  in `pages` order. Does not mutate `other`. */
  private importPages(other: Document, rootNum: number, pages: Page[] = other.Pages): number[] {
```

and inside it, the leaf loop header:

```ts
    for (const page of pages) {
```

(was `for (const page of other.Pages) {`). Everything else in the method is unchanged.

- [ ] **Step 4: Add `ExtractPages` to `Document`**

In `src/document.ts`, directly after the `Split` method, add:

```ts
  /** Copy the given 1-based pages into a new self-contained Document, in the
   *  order given (repeats allowed, like Reorder). Shared resources are copied
   *  once; inherited page attributes are flattened onto each page. Throws
   *  RangeError on an empty array or any non-integer/out-of-range entry. This
   *  document is not modified. */
  ExtractPages(numbers: number[]): Document {
    const n = this.Pages.length;
    if (numbers.length === 0) throw new RangeError('ExtractPages: numbers must not be empty');
    for (const o of numbers)
      if (!Number.isInteger(o) || o < 1 || o > n)
        throw new RangeError(`ExtractPages: page number ${o} out of range 1..${n}`);
    const out = Document.createEmptyDocument();
    const selected = numbers.map((num) => this.Pages[num - 1]);
    const newNums = out.importPages(this, out.requireIndirectPagesRoot(), selected);
    out.syncPages(newNums.map((num) => ref(num)));
    return out;
  }
```

Notes for the implementer:
- `createEmptyDocument`, `importPages`, `requireIndirectPagesRoot`, and `syncPages` are all `private` members of `Document`; calling them on `out` from inside the class is legal TypeScript (same-class private access — `Merge` already does this via `out.Append`).
- `ref` and `name` are already imported at the top of `document.ts`.
- The source document needs no `requireIndirectPagesRoot` guard: only its page leaves are read.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run test/extract-pages.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Run the full suite + typecheck (regression on the importPages widening)**

Run: `npm test`
Expected: all tests pass (175 = 168 existing + 7 new), including `test/merge.test.ts` which exercises the widened `importPages` through its default.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/extract-pages.test.ts
git commit -m "feat: Document.ExtractPages(numbers[]) — subset extraction into one Document (b2p)"
```

---

### Task 2: Reuse-benefit tests — shared-resource dedup and inheritance flattening

These verify the design claims that motivated reusing `importPages` over the per-page `extractPage` loop. They are expected to pass immediately; if one fails, the implementation (not the test) is wrong — stop and fix.

**Files:**
- Modify: `test/extract-pages.test.ts` (append a second `describe` block)

- [ ] **Step 1: Append the tests**

Append to `test/extract-pages.test.ts` (also extend the imports at the top of the file: add `buildSharedFontPdf` to the `./helpers/build-pdf.js` import and add `import { isDict, isRef } from '../src/types.js';`):

```ts
describe('Document.ExtractPages — importPages reuse benefits', () => {
  it('copies a resource shared across selected pages exactly once', () => {
    // buildSharedFontPdf: 2 pages sharing ONE indirect font object (/F1 -> 7 0 R).
    const src = Document.Open(buildSharedFontPdf());
    const out = src.ExtractPages([1, 2]);
    const f1Num = (i: number) => {
      const res = out.resolve(out.Pages[i].Dict.get('Resources'));
      const font = isDict(res) ? out.resolve(res.get('Font')) : null;
      const f1 = isDict(font) ? font.get('F1') : null;
      if (!isRef(f1)) throw new Error('F1 not a ref');
      return f1.num;
    };
    expect(f1Num(0)).toBe(f1Num(1)); // same object: copied once, not per page
  });

  it('flattens MediaBox inherited from the source /Pages root onto extracted pages', () => {
    // buildClassicPdf puts MediaBox on the /Pages ROOT; leaves inherit it.
    const src = Document.Open(buildClassicPdf(2, { mediaBox: [0, 0, 300, 400] }));
    const out = src.ExtractPages([2]);
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 300, 400]);
    const reopened = Document.Open(out.Save());
    expect(reopened.Pages[0].MediaBox).toEqual([0, 0, 300, 400]);
  });

  it('flattens Rotate inherited from the source /Pages root onto extracted pages', () => {
    const src = Document.Open(buildClassicPdf(1, { rotate: 90 }));
    const out = src.ExtractPages([1]);
    expect(out.Pages[0].Rotate).toBe(90);
  });
});
```

- [ ] **Step 2: Run the file**

Run: `npx vitest run test/extract-pages.test.ts`
Expected: PASS — 10 tests. (If any of these 3 fail, debug the implementation; do not weaken the test.)

- [ ] **Step 3: Commit**

```bash
git add test/extract-pages.test.ts
git commit -m "test: ExtractPages shared-resource dedup + inheritance flattening (b2p)"
```

---

### Task 3: Finalize — full gates, close issue, push

**Files:** none (verification + bookkeeping only)

- [ ] **Step 1: Full quality gates**

Run: `npm test`
Expected: 178 tests pass (168 existing + 10 new), 0 failures.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-b2p --reason="ExtractPages(numbers[]) shipped: importPages widened with page subset; 10 new tests green"
```

- [ ] **Step 3: Commit bookkeeping and push**

Scope adds to code/docs/tracker directories only — do NOT use `git add -A` (the workspace contains untracked scratch dirs `_extra/`, `_my/` that must stay out of history):

```bash
git add src test docs .beads
git commit -m "chore: close b2p (ExtractPages shipped)"
git pull --rebase
git push
git status
```

Expected: `git status` shows "up to date with 'origin/main'", working tree clean (scratch dirs may remain untracked — that is fine).
