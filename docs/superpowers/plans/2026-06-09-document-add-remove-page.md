# Document.AddPage / InsertPage / RemovePage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add page insertion (blank A4 or a deep copy of an existing page) and removal to `Document`, observable immediately in `Document.Pages` and persisted by `Save()`.

**Architecture:** All four methods mutate the live root `/Pages` node's `/Kids` and rebuild `Pages` / `pageObjNums` via the existing `buildPages` walk — the same in-memory pattern `Reorder` already uses. Copying reuses the tested `extractPage` extractor to produce a self-contained renumbered graph, then offsets its object numbers into this document's live map.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest. Spec: `docs/superpowers/specs/2026-06-09-document-add-remove-page-design.md`. Issue: `aspose-pdf-foss-for-ts-25c`.

**Commit hygiene:** This repo has untracked scratch dirs (`_my/`). Never `git add -A`. Stage only `src`, `test`, `docs`, `.beads`.

---

### Task 1: Shared plumbing — `requireIndirectPagesRoot` + `syncPages`, adopted by `Reorder`

Extract the root-node-write + rebuild tail that `Reorder` performs into reusable private helpers. No behavior change; existing `Reorder` tests are the regression guard.

**Files:**
- Modify: `src/document.ts` (add helpers; rewrite `Reorder` tail)
- Test: `test/document.test.ts` (existing `Reorder` suite — no new test, it guards this refactor)

- [ ] **Step 1: Run the existing Reorder tests to confirm a green baseline**

Run: `npx vitest run test/document.test.ts -t Reorder`
Expected: PASS (all `Document.Reorder` tests green).

- [ ] **Step 2: Add the two private helpers**

In `src/document.ts`, add these methods to the `Document` class (place them just above `getObject` near the end of the class):

```ts
  /** The root /Pages object number, or throw when /Pages is inline (not indirect). */
  private requireIndirectPagesRoot(): number {
    if (this.rootPagesNum === undefined)
      throw new UnsupportedFeatureError('cannot modify pages: /Pages is not an indirect reference');
    return this.rootPagesNum;
  }

  /** Refs for the current pages in order; throws if any page is an inline leaf. */
  private currentKids(): PdfObject[] {
    return this.pageObjNums.map((num) => {
      if (num === 0)
        throw new UnsupportedFeatureError('cannot modify pages: a page is not an indirect object');
      return ref(num);
    });
  }

  /** Write Kids/Count into the root /Pages node and rebuild Pages + pageObjNums. */
  private syncPages(kids: PdfObject[]): void {
    const rootNum = this.requireIndirectPagesRoot();
    const rootNode = this.objects.get(rootNum);
    const pagesNode: PdfDict = isDict(rootNode) ? rootNode : new Map<string, PdfObject>();
    pagesNode.set('Type', name('Pages'));
    pagesNode.set('Kids', kids);
    pagesNode.set('Count', kids.length);
    this.objects.set(rootNum, pagesNode);
    const tree = buildPages(this);
    this.Pages.length = 0;
    this.Pages.push(...tree.pages);
    this.pageObjNums = tree.pageObjNums;
  }
```

- [ ] **Step 3: Rewrite the tail of `Reorder` to use `syncPages`**

In `src/document.ts`, in the `Reorder` method, replace this block:

```ts
    const rootNode = this.objects.get(rootNum);
    const pagesNode: PdfDict = isDict(rootNode) ? rootNode : new Map<string, PdfObject>();
    pagesNode.set('Type', name('Pages'));
    pagesNode.set('Kids', kids);
    pagesNode.set('Count', order.length);
    this.objects.set(rootNum, pagesNode);

    this.pageObjNums = newNums;
    const tree = buildPages(this);
    this.Pages.length = 0;
    this.Pages.push(...tree.pages);
    this.pageObjNums = tree.pageObjNums;
```

with:

```ts
    void newNums; // (kept building newNums above for clarity; syncPages re-derives nums)
    this.syncPages(kids);
```

Note: `Reorder` keeps its own guard (`if (this.rootPagesNum === undefined) throw ... 'cannot reorder: ...'`) and its `const rootNum = this.rootPagesNum;` line — `rootNum` is still used earlier in the method (setting each page's `/Parent`). Only the tail changes.

- [ ] **Step 4: Remove the now-dead `newNums` plumbing (cleanup)**

The `void newNums;` line is a smell. Instead, delete the `newNums` array entirely. In `Reorder`, remove the declaration `const newNums: number[] = [];` and the line `newNums.push(num);` inside the loop, and delete the `void newNums;` line added in Step 3 so the tail is just:

```ts
    this.syncPages(kids);
```

(`syncPages` calls `buildPages`, which re-derives `pageObjNums` from the live tree, so `newNums` was redundant.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the full document test file**

Run: `npx vitest run test/document.test.ts`
Expected: PASS (Reorder + all other Document tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/document.ts
git commit -m "refactor: extract syncPages/requireIndirectPagesRoot from Reorder

Issue: aspose-pdf-foss-for-ts-25c"
```

---

### Task 2: `Page.Document` internal accessor

`Document.importPage` needs the source page's owning document to traverse its object graph. `Page` holds it privately; expose a getter.

**Files:**
- Modify: `src/page.ts` (add getter)
- Test: `test/page.test.ts` (one assertion)

- [ ] **Step 1: Write the failing test**

Add to `test/page.test.ts` (inside the existing top-level `describe`, or a new `describe('Page.Document', ...)`):

```ts
  it('exposes its owning Document', () => {
    const doc = Document.Open(buildClassicPdf(1));
    expect(doc.Pages[0].Document).toBe(doc);
  });
```

If `test/page.test.ts` does not already import them, ensure these imports exist at the top:

```ts
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/page.test.ts -t "owning Document"`
Expected: FAIL (`Property 'Document' does not exist on type 'Page'` at typecheck / `undefined` at runtime).

- [ ] **Step 3: Add the getter**

In `src/page.ts`, add to the `Page` class (just after the constructor, before `inherited`):

```ts
  /** @internal The owning document (used for cross-document page copy). */
  get Document(): Document {
    return this.doc;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/page.test.ts -t "owning Document"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "feat: expose Page.Document accessor for cross-doc copy

Issue: aspose-pdf-foss-for-ts-25c"
```

---

### Task 3: Blank-page `InsertPage` + `AddPage`

Insert a blank A4 page at a 1-based position; `AddPage` appends. Returns `{ page, number }`.

**Files:**
- Modify: `src/document.ts` (add `isArray` to imports; `createBlankPage`, `InsertPage`, `AddPage`)
- Test: `test/document.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing tests**

Add to `test/document.test.ts`:

```ts
describe('Document.AddPage / InsertPage (blank)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('AddPage appends a blank A4 page and returns its number', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const { page, number } = doc.AddPage();
    expect(number).toBe(3);
    expect(doc.Pages.length).toBe(3);
    expect(page.Number).toBe(3);
    expect(page.MediaBox).toEqual([0, 0, 595, 842]);
    expect(page.Contents.length).toBe(0); // blank: no /Contents
  });

  it('InsertPage at 1 shifts existing pages down', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const { number } = doc.InsertPage(1);
    expect(number).toBe(1);
    expect(doc.Pages.length).toBe(4);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 595, 842]); // the new blank page
    expect(text(doc, 1)).toContain('Page 1'); // old page 1 is now page 2
    expect(text(doc, 3)).toContain('Page 3'); // old page 3 is now page 4
  });

  it('InsertPage in the middle places the new page at that slot', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.InsertPage(2);
    expect(doc.Pages.length).toBe(4);
    expect(text(doc, 0)).toContain('Page 1');
    expect(doc.Pages[1].Contents.length).toBe(0); // inserted blank at slot 2
    expect(text(doc, 2)).toContain('Page 2'); // old page 2 shifted to 3
  });

  it('InsertPage at length+1 appends (same as AddPage)', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const { number } = doc.InsertPage(3);
    expect(number).toBe(3);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages[2].Contents.length).toBe(0);
  });

  it('InsertPage throws RangeError out of range and leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(2));
    expect(() => doc.InsertPage(0)).toThrow(RangeError);
    expect(() => doc.InsertPage(4)).toThrow(RangeError);   // length+2
    expect(() => doc.InsertPage(1.5)).toThrow(RangeError);
    expect(doc.Pages.length).toBe(2);
  });

  it('round-trips an added blank A4 page through Save/Open', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.AddPage();
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(2);
    expect(re.Pages[1].MediaBox).toEqual([0, 0, 595, 842]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/document.test.ts -t "AddPage / InsertPage (blank)"`
Expected: FAIL (`doc.AddPage is not a function` / typecheck error).

- [ ] **Step 3: Add `isArray` to the types import**

In `src/document.ts`, update the `./types.js` import line:

```ts
import { PdfObject, PdfDict, isRef, isDict, isStream, isName, isArray, ref, name } from './types.js';
```

- [ ] **Step 4: Implement `createBlankPage`, `InsertPage`, `AddPage`**

In `src/document.ts`, add to the `Document` class (place after `syncPages`):

```ts
  /** Create a blank A4 page object parented to rootNum; return its object number. */
  private createBlankPage(rootNum: number): number {
    const num = this.maxObjNum() + 1;
    const page: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Page')],
      ['Parent', ref(rootNum)],
      ['MediaBox', [0, 0, 595, 842]],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    this.objects.set(num, page);
    return num;
  }

  /** Insert a page so it becomes 1-based page `at` (1..Pages.length+1): a blank A4
   *  page, or a deep copy of `source` (from this or another Document). Returns the
   *  new live Page and its number. Throws RangeError when `at` is out of range. */
  InsertPage(at: number, source?: Page): { page: Page; number: number } {
    const rootNum = this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    if (!Number.isInteger(at) || at < 1 || at > n + 1)
      throw new RangeError(`InsertPage: position ${at} out of range 1..${n + 1}`);
    const kids = this.currentKids();
    const newNum = source === undefined
      ? this.createBlankPage(rootNum)
      : this.importPage(source.Document, source.Dict, rootNum);
    kids.splice(at - 1, 0, ref(newNum));
    this.syncPages(kids);
    return { page: this.Pages[at - 1], number: at };
  }

  /** Append a page (blank A4, or a deep copy of `source`); returns the new Page
   *  and its 1-based number. */
  AddPage(source?: Page): { page: Page; number: number } {
    return this.InsertPage(this.Pages.length + 1, source);
  }
```

Note: `currentKids()` is called before allocating the new object so that a malformed (inline-leaf) page set throws before any mutation. `importPage` is implemented in Task 4; for this task only the `source === undefined` branch is exercised, but reference it now so the signature is in place. If the build complains that `importPage` is missing, add the stub now and flesh it out in Task 4:

```ts
  // Implemented in Task 4.
  private importPage(_srcDoc: Document, _srcPage: PdfDict, _rootNum: number): number {
    throw new Error('importPage not yet implemented');
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/document.test.ts -t "AddPage / InsertPage (blank)"`
Expected: PASS (all 6 blank-page tests green).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: Document.AddPage/InsertPage for blank A4 pages

Issue: aspose-pdf-foss-for-ts-25c"
```

---

### Task 4: Page-copy path — `importPage` + `offsetRefs`

Deep-copy an existing page's object graph into this document and wire it for Add/Insert with a `source`.

**Files:**
- Modify: `src/document.ts` (module-level `offsetRefs`; replace `importPage` stub)
- Test: `test/document.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing tests**

Add to `test/document.test.ts`:

```ts
describe('Document.AddPage / InsertPage (copy)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('copies a page from another document without mutating the source', () => {
    const src = Document.Open(buildClassicPdf(3)); // pages: "Page 1".."Page 3"
    const dst = Document.Open(buildClassicPdf(2)); // pages: "Page 1","Page 2"
    const { number } = dst.AddPage(src.Pages[2]);  // copy source "Page 3"
    expect(number).toBe(3);
    expect(dst.Pages.length).toBe(3);
    expect(text(dst, 2)).toContain('Page 3');      // copied content present
    // Source document untouched.
    expect(src.Pages.length).toBe(3);
    expect(text(src, 2)).toContain('Page 3');
  });

  it('InsertPage with a source places the copy at the requested slot', () => {
    const src = Document.Open(buildClassicPdf(3));
    const dst = Document.Open(buildClassicPdf(2));
    dst.InsertPage(1, src.Pages[2]); // copy "Page 3" at slot 1
    expect(dst.Pages.length).toBe(3);
    expect(text(dst, 0)).toContain('Page 3');
    expect(text(dst, 1)).toContain('Page 1');
  });

  it('same-document copy duplicates content into a distinct object', () => {
    const doc = Document.Open(buildClassicPdf(2));
    doc.AddPage(doc.Pages[0]); // duplicate page 1
    expect(doc.Pages.length).toBe(3);
    expect(text(doc, 2)).toContain('Page 1');
    // Distinct live object: editing the copy does not touch the original.
    doc.Pages[2].Rotate = 90;
    expect(doc.Pages[0].Rotate).toBe(0);
  });

  it('round-trips a cross-document copy through Save/Open', () => {
    const src = Document.Open(buildClassicPdf(3));
    const dst = Document.Open(buildClassicPdf(1));
    dst.AddPage(src.Pages[2]);
    const re = Document.Open(dst.Save());
    expect(re.Pages.length).toBe(2);
    expect(new TextDecoder().decode(re.Pages[1].Contents)).toContain('Page 3');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/document.test.ts -t "AddPage / InsertPage (copy)"`
Expected: FAIL (`importPage not yet implemented`).

- [ ] **Step 3: Add the module-level `offsetRefs` helper**

In `src/document.ts`, add this function at module scope (e.g. just below `assembleSinglePageDoc`, before `export class Document`):

```ts
/** Add `offset` to every PdfRef nested in container `o` (mutates `o` in place). */
function offsetRefs(o: PdfObject, offset: number): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (isRef(v)) o[i] = ref(v.num + offset, v.gen);
      else offsetRefs(v, offset);
    }
  } else if (isDict(o)) {
    for (const [k, v] of o) {
      if (isRef(v)) o.set(k, ref(v.num + offset, v.gen));
      else offsetRefs(v, offset);
    }
  } else if (isStream(o)) {
    for (const [k, v] of o.dict) {
      if (isRef(v)) o.dict.set(k, ref(v.num + offset, v.gen));
      else offsetRefs(v, offset);
    }
  }
}
```

- [ ] **Step 4: Replace the `importPage` stub with the real implementation**

In `src/document.ts`, replace the `importPage` stub from Task 3 with:

```ts
  /** Deep-copy `srcPage` (from `srcDoc`) into this document with fresh object
   *  numbers; return the new page object's number, parented to `rootNum`. */
  private importPage(srcDoc: Document, srcPage: PdfDict, rootNum: number): number {
    if (!isDict(srcPage)) throw new Error('AddPage/InsertPage: source is not a page dict');
    // extractPage yields a self-contained graph numbered 1..k with /Parent
    // dropped and annotations sanitized; offset those numbers past our max.
    const { objects: sub, pageNum } = extractPage(srcDoc, srcPage, defaultPrunePolicy());
    const offset = this.maxObjNum();
    for (const [num, obj] of sub) {
      offsetRefs(obj, offset);
      this.objects.set(num + offset, obj);
    }
    const newNum = pageNum + offset;
    const page = this.objects.get(newNum);
    if (isDict(page)) {
      page.set('Parent', ref(rootNum));
      if (!page.has('Type')) page.set('Type', name('Page'));
    }
    return newNum;
  }
```

`extractPage` and `defaultPrunePolicy` are already imported at the top of `src/document.ts` (line 10).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/document.test.ts -t "AddPage / InsertPage (copy)"`
Expected: PASS (all 4 copy tests green).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: copy an existing page into a Document via AddPage/InsertPage

Issue: aspose-pdf-foss-for-ts-25c"
```

---

### Task 5: `RemovePage`

Remove a page by 1-based number or by `Page` handle.

**Files:**
- Modify: `src/document.ts` (`RemovePage`)
- Test: `test/document.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing tests**

Add to `test/document.test.ts`:

```ts
describe('Document.RemovePage', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('removes a page by 1-based number and renumbers the rest', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(2);
    expect(doc.Pages.length).toBe(2);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2]);
    expect(text(doc, 0)).toContain('Page 1');
    expect(text(doc, 1)).toContain('Page 3');
  });

  it('removes a page by Page handle', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(doc.Pages[0]);
    expect(doc.Pages.length).toBe(2);
    expect(text(doc, 0)).toContain('Page 2');
  });

  it('can remove down to zero pages', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.RemovePage(1);
    expect(doc.Pages.length).toBe(0);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(0);
  });

  it('throws RangeError on invalid number or foreign page; leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const foreign = Document.Open(buildClassicPdf(1)).Pages[0];
    expect(() => doc.RemovePage(0)).toThrow(RangeError);
    expect(() => doc.RemovePage(3)).toThrow(RangeError);
    expect(() => doc.RemovePage(1.5)).toThrow(RangeError);
    expect(() => doc.RemovePage(foreign)).toThrow(RangeError);
    expect(doc.Pages.length).toBe(2);
  });

  it('round-trips a removal through Save/Open', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 1');
    expect(text(re, 1)).toContain('Page 3');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/document.test.ts -t RemovePage`
Expected: FAIL (`doc.RemovePage is not a function`).

- [ ] **Step 3: Implement `RemovePage`**

In `src/document.ts`, add to the `Document` class (after `AddPage`):

```ts
  /** Remove a page by 1-based number or by Page handle. Throws RangeError when
   *  the number is out of range or the page does not belong to this document. */
  RemovePage(target: number | Page): void {
    this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    let index: number;
    if (typeof target === 'number') {
      if (!Number.isInteger(target) || target < 1 || target > n)
        throw new RangeError(`RemovePage: page number ${target} out of range 1..${n}`);
      index = target - 1;
    } else {
      index = this.Pages.findIndex((p) => p.Dict === target.Dict);
      if (index === -1) throw new RangeError('RemovePage: page does not belong to this document');
    }
    const kids = this.currentKids();
    kids.splice(index, 1);
    this.syncPages(kids);
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/document.test.ts -t RemovePage`
Expected: PASS (all 5 RemovePage tests green).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: Document.RemovePage by number or Page handle

Issue: aspose-pdf-foss-for-ts-25c"
```

---

### Task 6: Composition test + full verification

Confirm the new operations compose with each other and with `Reorder`, then run the whole suite.

**Files:**
- Test: `test/document.test.ts` (one composition test)

- [ ] **Step 1: Write the composition test**

Add to `test/document.test.ts`:

```ts
describe('Document page ops compose', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('AddPage + RemovePage + Reorder compose in one session and persist', () => {
    const doc = Document.Open(buildClassicPdf(3)); // Page 1,2,3
    doc.AddPage();          // -> 1,2,3,blank (4 pages)
    doc.RemovePage(2);      // -> 1,3,blank (3 pages)
    doc.Reorder([3, 1, 2]); // -> blank,1,3
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages[0].Contents.length).toBe(0); // blank first
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 3');
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(3);
    expect(re.Pages[0].Contents.length).toBe(0);
    expect(new TextDecoder().decode(re.Pages[2].Contents)).toContain('Page 3');
  });
});
```

- [ ] **Step 2: Run the composition test**

Run: `npx vitest run test/document.test.ts -t "compose"`
Expected: PASS.

- [ ] **Step 3: Run the FULL test suite**

Run: `npx vitest run`
Expected: PASS — all prior tests (95+) plus the new AddPage/InsertPage/RemovePage/compose tests green.

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck` then `npm run build`
Expected: no errors from either.

- [ ] **Step 5: Commit**

```bash
git add test/document.test.ts
git commit -m "test: AddPage/RemovePage/Reorder composition + round-trip

Issue: aspose-pdf-foss-for-ts-25c"
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-25c --reason="AddPage/InsertPage/RemovePage implemented with tests"
git add .beads
git commit -m "chore: sync beads issues export"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Self-Review Notes

- **Spec coverage:** AddPage/InsertPage/RemovePage signatures (Tasks 3–5), `{page, number}` return (Task 3), blank A4 (Task 3), copy via `extractPage`+offset (Task 4), number-or-Page removal incl. down-to-zero (Task 5), `requireIndirectPagesRoot`/`syncPages`/`currentKids` plumbing with `Reorder` adopting it (Task 1), `Page.Document` accessor (Task 2), persistence via existing `Save()` (round-trip tests in Tasks 3–6), validation-before-mutation (RangeError tests in Tasks 3 & 5). All spec sections map to a task.
- **Type consistency:** `syncPages(kids: PdfObject[])`, `currentKids(): PdfObject[]`, `importPage(srcDoc, srcPage, rootNum): number`, `createBlankPage(rootNum): number`, `InsertPage(at, source?): {page, number}` used identically across tasks. `Page.Document` getter name matches its use in `InsertPage` (`source.Document`).
- **Known accepted limitation (from spec):** copied pages lose same-doc GoTo/`Dest`/`/P`/`/B`/`/StructParents` (consequence of `defaultPrunePolicy`); not a plan gap.
