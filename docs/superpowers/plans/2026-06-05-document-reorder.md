# Document.Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.Reorder(order: number[])` that rearranges pages (new page i = old page order[i-1]; repeats and omissions allowed), taking effect both in the in-memory `Pages` array and in `save()` output.

**Architecture:** `buildPages` is extended to also capture each leaf page's object number and the root `/Pages` object number. `Reorder` validates the 1-based `order`, rebuilds `Pages` (fresh `Page` per slot) plus a parallel `pageObjNums` array, and sets a `pageOrderChanged` flag. `save()` is restructured to emit one incremental-update section covering both metadata and — when the flag is set — a flattened page tree: each slot's materialized dict is rewritten with `/Parent` → root, repeats are cloned into fresh objects, and the root `/Pages` node gets new `/Kids` + `/Count`.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-document-reorder-design.md`

## File Structure

- **Modify `src/pagetree.ts`** — `buildPages` returns `{ pages, pageObjNums, rootPagesNum }`; the walk threads each node's object number through and records it per leaf.
- **Modify `src/document.ts`** — store the new tree fields in the constructor; add the `Reorder` method; restructure `save()` to compose metadata + page-tree rewrites.
- **Modify `test/document.test.ts`** — add `Document.Reorder` describe blocks (validation, in-memory, round-trip, metadata-combined).

---

### Task 1: In-memory `Reorder` + object-number plumbing

**Files:**
- Modify: `src/pagetree.ts`
- Modify: `src/document.ts`
- Test: `test/document.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/document.test.ts` (the file already imports `describe, it, expect, afterAll` from vitest, `buildClassicPdf` from the helper, `Document`, and `isDict, isName` from types — no import changes needed for this task):

```ts
describe('Document.Reorder (in-memory)', () => {
  // Decoded content text of a page, e.g. "...(Page 3) Tj..." for assertions.
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('rearranges pages and renumbers them', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1, 2]);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(text(doc, 0)).toContain('Page 3');
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 2');
  });

  it('drops pages omitted from order (no append)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1]);
    expect(doc.Pages.length).toBe(2);
    expect(text(doc, 0)).toContain('Page 3');
    expect(text(doc, 1)).toContain('Page 1');
  });

  it('duplicates repeated pages', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([1, 1, 2]);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(text(doc, 0)).toContain('Page 1');
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 2');
  });

  it('throws RangeError on invalid order and leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(3));
    expect(() => doc.Reorder([])).toThrow(RangeError);
    expect(() => doc.Reorder([1, 1.5])).toThrow(RangeError);
    expect(() => doc.Reorder([0, 1, 2])).toThrow(RangeError);
    expect(() => doc.Reorder([1, 2, 4])).toThrow(RangeError);
    expect(doc.Pages.length).toBe(3); // untouched after the throws
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- document.test`
Expected: FAIL — `doc.Reorder is not a function`.

- [ ] **Step 3a: Extend `buildPages` to capture object numbers**

In `src/pagetree.ts`, replace the imports line:

```ts
import { PdfDict, PdfObject, isDict, isArray, isName } from './types.js';
```

with (adds `isRef`):

```ts
import { PdfDict, PdfObject, isDict, isArray, isName, isRef } from './types.js';
```

Replace the entire `buildPages` function and the `walk` function. The current code is:

```ts
/** Walk the page tree and return one Page per leaf, in document order. */
export function buildPages(doc: Document): Page[] {
  const catalog = doc.catalog();
  const pagesRoot = doc.resolve(catalog.get('Pages'));
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const dicts: PdfDict[] = [];
  walk(doc, pagesRoot, {}, new Set(), dicts);
  return dicts.map((dict, i) => new Page(doc, dict, i + 1));
}

function walk(
  doc: Document, node: PdfDict,
  inherited: Partial<Record<string, PdfObject>>,
  seen: Set<PdfDict>, out: PdfDict[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const merged = { ...inherited };
  for (const key of INHERITABLE) if (node.has(key)) merged[key] = node.get(key)!;

  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push(materialize(node, merged));
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, merged, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type but no kids: treat as page.
  out.push(materialize(node, merged));
}
```

Replace both with:

```ts
/** Page tree resolved to a flat list, with the object numbers needed to rewrite it. */
export interface PageTree {
  /** One Page per leaf, in document order. */
  pages: Page[];
  /** Object number backing each page (parallel to `pages`); 0 if the leaf is inline. */
  pageObjNums: number[];
  /** Object number of the root /Pages node, or undefined when /Pages is inline. */
  rootPagesNum: number | undefined;
}

/** Walk the page tree and return one Page per leaf, in document order. */
export function buildPages(doc: Document): PageTree {
  const catalog = doc.catalog();
  const pagesRef = catalog.get('Pages');
  const pagesRoot = doc.resolve(pagesRef);
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const rootPagesNum = isRef(pagesRef) ? pagesRef.num : undefined;
  const leaves: { dict: PdfDict; objNum: number }[] = [];
  walk(doc, pagesRoot, rootPagesNum, {}, new Set(), leaves);
  return {
    pages: leaves.map((leaf, i) => new Page(doc, leaf.dict, i + 1)),
    pageObjNums: leaves.map((leaf) => leaf.objNum),
    rootPagesNum,
  };
}

function walk(
  doc: Document, node: PdfDict, objNum: number | undefined,
  inherited: Partial<Record<string, PdfObject>>,
  seen: Set<PdfDict>, out: { dict: PdfDict; objNum: number }[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const merged = { ...inherited };
  for (const key of INHERITABLE) if (node.has(key)) merged[key] = node.get(key)!;

  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push({ dict: materialize(node, merged), objNum: objNum ?? 0 });
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const childNum = isRef(kid) ? kid.num : undefined;
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, childNum, merged, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type but no kids: treat as page.
  out.push({ dict: materialize(node, merged), objNum: objNum ?? 0 });
}
```

- [ ] **Step 3b: Store tree fields and add `Reorder` in `src/document.ts`**

Replace the imports line:

```ts
import { PdfObject, PdfDict, isRef, isDict, isStream } from './types.js';
```

with (adds the `ref` and `name` constructors):

```ts
import { PdfObject, PdfDict, isRef, isDict, isStream, ref, name } from './types.js';
```

Replace the `buildPages` import line:

```ts
import { buildPages } from './pagetree.js';
```

with:

```ts
import { buildPages, PageTree } from './pagetree.js';
```

Replace the field declarations and constructor. The current code is:

```ts
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;
  /** One Page per page, in document order. Populated by Open(). */
  readonly Pages: Page[];

  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {
    this.Pages = buildPages(this);
  }
```

Replace with:

```ts
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;
  /** One Page per page, in document order. Populated by Open(). */
  readonly Pages: Page[];
  /** Object number backing each Pages slot (parallel to Pages). */
  private pageObjNums: number[];
  /** Object number of the root /Pages node, or undefined when /Pages is inline. */
  private readonly rootPagesNum: number | undefined;
  /** Set by Reorder(); triggers a page-tree rewrite in save(). */
  private pageOrderChanged = false;

  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {
    const tree: PageTree = buildPages(this);
    this.Pages = tree.pages;
    this.pageObjNums = tree.pageObjNums;
    this.rootPagesNum = tree.rootPagesNum;
  }
```

Add the `Reorder` method immediately after the constructor's closing brace (before `static Open`):

```ts
  /** Rearrange pages: new page i = old page order[i-1] (1-based). Repeats and
   *  omissions are allowed (omitted pages are dropped, not appended). Throws
   *  RangeError on empty, non-integer, or out-of-range input. Takes effect in
   *  Pages immediately and in save() output. */
  Reorder(order: number[]): void {
    const n = this.Pages.length;
    if (order.length === 0) throw new RangeError('Reorder: order must not be empty');
    for (const o of order)
      if (!Number.isInteger(o) || o < 1 || o > n)
        throw new RangeError(`Reorder: page number ${o} out of range 1..${n}`);

    const srcPages = this.Pages.slice();
    const srcNums = this.pageObjNums.slice();
    const newPages = order.map((o, i) => new Page(this, srcPages[o - 1].Dict, i + 1));
    this.pageObjNums = order.map((o) => srcNums[o - 1]);
    this.Pages.length = 0;
    this.Pages.push(...newPages);
    this.pageOrderChanged = true;
  }
```

Note: `Page` is currently imported as a type only (`import type { Page } from './page.js';`). Change that line to a value import so `new Page(...)` works:

```ts
import { Page } from './page.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- document.test`
Expected: PASS — all four new in-memory cases plus the existing `Document` / `Document.Pages` / `Document.OpenFile` cases.

- [ ] **Step 5: Commit**

```bash
git add src/pagetree.ts src/document.ts test/document.test.ts
git commit -m "feat: add in-memory Document.Reorder + page-tree object-number plumbing"
```

---

### Task 2: Persist `Reorder` on `save()`

**Files:**
- Modify: `src/document.ts`
- Test: `test/document.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/document.test.ts`:

```ts
describe('Document.Reorder (persisted on save)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('round-trips a reorder through save/Open', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1, 2]);
    const re = Document.Open(doc.save());
    expect(re.Pages.length).toBe(3);
    expect(text(re, 0)).toContain('Page 3');
    expect(text(re, 1)).toContain('Page 1');
    expect(text(re, 2)).toContain('Page 2');
  });

  it('round-trips a drop', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1]);
    const re = Document.Open(doc.save());
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 3');
    expect(text(re, 1)).toContain('Page 1');
  });

  it('round-trips a duplicate (page cloned into its own object)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([1, 1, 2]);
    const re = Document.Open(doc.save());
    expect(re.Pages.length).toBe(3);
    expect(text(re, 0)).toContain('Page 1');
    expect(text(re, 1)).toContain('Page 1');
    expect(text(re, 2)).toContain('Page 2');
  });

  it('persists a metadata edit and a reorder in one save', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.setMetadata({ title: 'Reordered' });
    doc.Reorder([2, 1]);
    const re = Document.Open(doc.save());
    expect(re.getMetadata().title).toBe('Reordered');
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 2');
    expect(text(re, 1)).toContain('Page 1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- document.test`
Expected: FAIL — `save()` returns the original bytes unchanged (it currently triggers only on metadata changes), so the reopened document keeps the original page order: `text(re, 0)` is `Page 1`, not `Page 3`.

- [ ] **Step 3: Restructure `save()` to compose metadata + page-tree rewrites**

In `src/document.ts`, replace the entire current `save()` method:

```ts
  /** Serialize the document, applying pending metadata edits via an incremental update. */
  save(): Uint8Array {
    if (this.infoState === 'unchanged') return this.buf;

    const root = this.trailer.get('Root');
    if (!isRef(root)) throw new PdfParseError('cannot save: /Root is not an indirect reference');
    const id = this.trailer.get('ID');

    let maxObjNum = 0;
    for (const n of this.entries.keys()) if (n > maxObjNum) maxObjNum = n;

    if (this.infoState === 'cleared') {
      return appendIncremental(this.buf, { objects: new Map(), root, info: null, size: maxObjNum + 1, id });
    }

    const existingInfo = this.trailer.get('Info');
    let infoNum: number;
    if (isRef(existingInfo)) {
      infoNum = existingInfo.num;
    } else {
      infoNum = maxObjNum + 1;
      maxObjNum = infoNum;
    }
    const objects = new Map<number, PdfObject>([[infoNum, this.infoWork ?? new Map<string, PdfObject>()]]);
    return appendIncremental(this.buf, { objects, root, info: infoNum, size: maxObjNum + 1, id });
  }
```

with:

```ts
  /** Serialize the document, applying pending metadata and page-order edits via an incremental update. */
  save(): Uint8Array {
    if (this.infoState === 'unchanged' && !this.pageOrderChanged) return this.buf;

    const root = this.trailer.get('Root');
    if (!isRef(root)) throw new PdfParseError('cannot save: /Root is not an indirect reference');
    const id = this.trailer.get('ID');

    let maxObjNum = 0;
    for (const n of this.entries.keys()) if (n > maxObjNum) maxObjNum = n;

    const objects = new Map<number, PdfObject>();

    // Metadata: decide the /Info reference for the new trailer.
    let info: number | null;
    if (this.infoState === 'cleared') {
      info = null;
    } else if (this.infoState === 'modified') {
      const existingInfo = this.trailer.get('Info');
      const infoNum = isRef(existingInfo) ? existingInfo.num : ++maxObjNum;
      objects.set(infoNum, this.infoWork ?? new Map<string, PdfObject>());
      info = infoNum;
    } else {
      // unchanged: preserve any existing /Info reference so a reorder-only save keeps it.
      const existingInfo = this.trailer.get('Info');
      info = isRef(existingInfo) ? existingInfo.num : null;
    }

    // Page order: flatten the page tree into the root /Pages node.
    if (this.pageOrderChanged) {
      if (this.rootPagesNum === undefined)
        throw new UnsupportedFeatureError('cannot reorder: /Pages is not an indirect reference');
      const rootNum = this.rootPagesNum;
      const kids: PdfObject[] = [];
      const used = new Set<number>();
      for (let i = 0; i < this.Pages.length; i++) {
        let num = this.pageObjNums[i];
        if (used.has(num)) num = ++maxObjNum; // repeated page: clone into a fresh object
        used.add(num);
        const pageDict = new Map(this.Pages[i].Dict);
        pageDict.set('Parent', ref(rootNum));
        if (!pageDict.has('Type')) pageDict.set('Type', name('Page'));
        objects.set(num, pageDict);
        kids.push(ref(num));
      }
      const rootNode = this.resolve(ref(rootNum));
      const newRoot = isDict(rootNode) ? new Map(rootNode) : new Map<string, PdfObject>();
      newRoot.set('Type', name('Pages'));
      newRoot.set('Kids', kids);
      newRoot.set('Count', this.Pages.length);
      objects.set(rootNum, newRoot);
    }

    return appendIncremental(this.buf, { objects, root, info, size: maxObjNum + 1, id });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- document.test`
Expected: PASS — all four persisted cases, plus the in-memory cases from Task 1 and the pre-existing document/metadata cases (the restructured `save()` preserves the original metadata behavior).

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: persist Document.Reorder by flattening the page tree on save"
```

---

### Task 3: Full verification + close issue

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors, exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every suite passes (no regressions in `incremental`, `metadata`, `split`, `pagetree`, `page`, etc. — note `buildPages`' return type changed, so confirm nothing else imported it).

- [ ] **Step 3: Close the beads issue and commit any tracker state**

Scope the commit to code/doc/tracker dirs — do NOT `git add -A` (it would sweep the `_my/` scratch dirs into history).

```bash
bd close aspose-pdf-foss-for-ts-5zi --reason="Added Document.Reorder: in-memory Pages rebuild + persisted page-tree flatten on save; typecheck + full suite green"
git add .beads
git commit -m "chore: beads close Reorder issue"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Semantics (new i = old order[i-1], repeats, omissions, count = order.length) — Task 1 Step 3b `Reorder`; round-trip Task 2 Step 1.
  - Validation (empty / non-integer / out-of-range → RangeError, no mutation before validation) — Task 1 Step 3b + the throw test in Step 1.
  - In-memory rebuild (`Pages` + `Number` + parallel `pageObjNums`, `pageOrderChanged` flag) — Task 1 Step 3b.
  - Persistence by flattening (page objects with folded attrs + `/Parent` → root, `/Type /Page` ensured, first-use reuses obj num, repeat clones, root `/Kids` + `/Count`) — Task 2 Step 3.
  - Composed with metadata; trigger `infoState !== 'unchanged' || pageOrderChanged`; preserve existing `/Info` when unchanged — Task 2 Step 3 + the combined test.
  - `UnsupportedFeatureError` when `/Pages` is not an indirect ref — Task 2 Step 3 guard.
  - Plumbing: `buildPages` returns `{ pages, pageObjNums, rootPagesNum }`, captures leaf obj nums + root num — Task 1 Step 3a.
  - No export change (Document already exported) — correctly omitted.
- **Type/name consistency:** `Reorder(order: number[]): void`; `PageTree { pages; pageObjNums; rootPagesNum }`; `pageObjNums`/`rootPagesNum`/`pageOrderChanged` fields used identically in Tasks 1 and 2; `ref()`/`name()` from `types.ts`; `Page` switched from type-only to value import for `new Page(...)`.
- **No placeholders:** every code step shows full code; every run step states the expected result.
- **Known limitations** (cloned-page `/Annots` `/P` back-ref; orphaned intermediate `/Pages` nodes) are accepted in the spec and intentionally not addressed by any task.
