# Document.Merge / Append / InsertPages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.Append(other)`, `Document.InsertPages(at, other)`, and static `Document.Merge(...docs)` that copy whole documents' pages into a target, with shared-object de-duplication and inherited-attribute flattening, persisting through `Save()`.

**Architecture:** A new private `importPages(other, rootNum)` does a single BFS over all of `other`'s page leaves into `this.objects` with fresh offset object numbers, sharing one old→new map so resources referenced by several pages are copied once. Each leaf is sanitized with the existing `defaultPrunePolicy`, has the four inheritable attributes (MediaBox/CropBox/Resources/Rotate) flattened onto it, and is re-parented flat under this document's root `/Pages` node. `Append`/`InsertPages` splice the new refs via the existing `currentKids()`/`syncPages()` helpers; `Merge` builds an empty document and `Append`s each input. Source documents are never mutated.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest. PDF object model in `src/types.ts`; extractor clone/rewrite helpers in `src/extractor.ts`.

**Spec:** `docs/superpowers/specs/2026-06-09-document-merge-design.md`

---

## File Structure

- `src/extractor.ts` — **modify**: export the existing private `cloneShallow` and `rewriteRefs` so `document.ts` can reuse them (DRY; they are the tested clone-and-rewrite primitives).
- `src/document.ts` — **modify**: add module-level `inheritedValue()`, private `importPages()`, private static `createEmptyDocument()`, and public `Append()` / `InsertPages()` / static `Merge()`.
- `test/helpers/build-pdf.ts` — **modify**: add `mediaBox` / `rotate` options to `buildClassicPdf` (exercise inheritance) and a new `buildSharedFontPdf()` (exercise shared-resource dedup).
- `test/merge.test.ts` — **create**: all tests for the three new methods (mirrors the existing standalone `test/split.test.ts`).

---

## Task 1: Test-helper extensions

**Files:**
- Modify: `test/helpers/build-pdf.ts:8-23` (buildClassicPdf signature + object 2)
- Create (new export in same file): `buildSharedFontPdf` in `test/helpers/build-pdf.ts`

- [ ] **Step 1: Add `mediaBox` / `rotate` options to `buildClassicPdf`**

Change the signature line and the object-2 line. Replace:

```ts
export function buildClassicPdf(pageCount: number, opts: { info?: Record<string, string> } = {}): Uint8Array {
```

with:

```ts
export function buildClassicPdf(
  pageCount: number,
  opts: { info?: Record<string, string>; mediaBox?: number[]; rotate?: number } = {},
): Uint8Array {
```

Replace:

```ts
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] /MediaBox [0 0 200 200] >>`;
```

with:

```ts
  const mb = opts.mediaBox ?? [0, 0, 200, 200];
  const rot = opts.rotate !== undefined ? ` /Rotate ${opts.rotate}` : '';
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] /MediaBox [${mb.join(' ')}]${rot} >>`;
```

(Pages still carry no own MediaBox/Rotate, so they inherit these from object 2 — exactly what the flatten tests need. Existing callers omit the new options and get the unchanged `[0 0 200 200]` default.)

- [ ] **Step 2: Add `buildSharedFontPdf` for the dedup test**

Append this exported function to `test/helpers/build-pdf.ts` (after `buildClassicPdf`):

```ts
/** Build a 2-page classic PDF whose two pages share ONE indirect Font object
 *  (object 7), so a correct importer copies that font exactly once.
 *  Layout: 1=Catalog 2=Pages 3=Page 4=Page 5=Contents 6=Contents 7=Font. */
export function buildSharedFontPdf(): Uint8Array {
  const sA = `BT /F1 24 Tf 20 100 Td (A) Tj ET`;
  const sB = `BT /F1 24 Tf 20 100 Td (B) Tj ET`;
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`;
  objects[5] = `<< /Length ${sA.length} >>\nstream\n${sA}\nendstream`;
  objects[6] = `<< /Length ${sB.length} >>\nstream\n${sB}\nendstream`;
  objects[7] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 7;

  let body = '%PDF-1.7\n%âãÏÓ\n';
  const enc = (s: string) => new TextEncoder().encode(s);
  const byteLen = (s: string) => enc(s).length;
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 3: Verify the existing suite still passes (no behavior change for current callers)**

Run: `npm test`
Expected: PASS — same test count as before this task (the default-arg `buildClassicPdf` output is byte-identical, e.g. `Document.Pages` test still sees `MediaBox [0,0,200,200]`).

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-pdf.ts
git commit -m "test: buildClassicPdf mediaBox/rotate opts + buildSharedFontPdf helper"
```

---

## Task 2: Export clone/rewrite primitives from the extractor

**Files:**
- Modify: `src/extractor.ts:77` (cloneShallow), `src/extractor.ts:85` (rewriteRefs)

- [ ] **Step 1: Add `export` to the two helpers**

In `src/extractor.ts`, change:

```ts
function cloneShallow(o: PdfObject): PdfObject {
```

to:

```ts
export function cloneShallow(o: PdfObject): PdfObject {
```

and change:

```ts
/** Replace every PdfRef inside container `o` with policy-mapped refs (mutates o). */
function rewriteRefs(o: PdfObject, map: (r: PdfRef) => PdfRef): void {
```

to:

```ts
/** Replace every PdfRef inside container `o` with policy-mapped refs (mutates o). */
export function rewriteRefs(o: PdfObject, map: (r: PdfRef) => PdfRef): void {
```

(No other changes — `passthrough` stays private; both helpers keep their current behavior, which the existing extractor/split tests already cover.)

- [ ] **Step 2: Verify nothing broke**

Run: `npm run typecheck && npm test`
Expected: PASS (pure visibility change; no callers changed yet).

- [ ] **Step 3: Commit**

```bash
git add src/extractor.ts
git commit -m "refactor: export cloneShallow/rewriteRefs for reuse by document merge"
```

---

## Task 3: `importPages` + `Append`

**Files:**
- Modify: `src/document.ts` (imports near line 5/10; add module-level `inheritedValue` near the other module-level helper `offsetRefs` ~line 44; add `importPages` and `Append` methods inside the `Document` class)
- Create: `test/merge.test.ts`

- [ ] **Step 1: Write the failing tests for `Append`**

Create `test/merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildSharedFontPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { isDict, isRef } from '../src/types.js';

/** Decoded text of page `i` (0-based) of `doc`, for order assertions. */
const text = (doc: Document, i: number) =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('Document.Append', () => {
  it('appends every page of other in order and returns their 1-based numbers', () => {
    const target = Document.Open(buildClassicPdf(2));
    const other = Document.Open(buildClassicPdf(3));
    const nums = target.Append(other);
    expect(target.Pages.length).toBe(5);
    expect(nums).toEqual([3, 4, 5]);
    expect(text(target, 2)).toContain('Page 1'); // other's page 1
    expect(text(target, 4)).toContain('Page 3'); // other's page 3
  });

  it('does not mutate the source document', () => {
    const target = Document.Open(buildClassicPdf(1));
    const other = Document.Open(buildClassicPdf(2));
    target.Append(other);
    expect(other.Pages.length).toBe(2);
    expect(text(other, 0)).toContain('Page 1');
  });

  it('is a no-op for a zero-page source', () => {
    const target = Document.Open(buildClassicPdf(2));
    const nums = target.Append(Document.Open(buildClassicPdf(0)));
    expect(nums).toEqual([]);
    expect(target.Pages.length).toBe(2);
  });

  it('round-trips merged pages through Save()/Open', () => {
    const target = Document.Open(buildClassicPdf(2));
    target.Append(Document.Open(buildClassicPdf(2)));
    const reopened = Document.Open(target.Save());
    expect(reopened.Pages.length).toBe(4);
    expect(new TextDecoder().decode(reopened.Pages[3].Contents)).toContain('Page 2');
  });

  it('flattens inherited MediaBox onto merged pages', () => {
    const target = Document.Open(buildClassicPdf(1)); // root MediaBox [0 0 200 200]
    const other = Document.Open(buildClassicPdf(1, { mediaBox: [0, 0, 300, 400] }));
    target.Append(other);
    // The merged page must keep other's size, not inherit target's root or default Letter.
    expect(target.Pages[1].MediaBox).toEqual([0, 0, 300, 400]);
    const reopened = Document.Open(target.Save());
    expect(reopened.Pages[1].MediaBox).toEqual([0, 0, 300, 400]);
  });

  it('flattens inherited Rotate onto merged pages', () => {
    const target = Document.Open(buildClassicPdf(1)); // no Rotate -> 0
    const other = Document.Open(buildClassicPdf(1, { rotate: 90 }));
    target.Append(other);
    expect(target.Pages[0].Rotate).toBe(0);
    expect(target.Pages[1].Rotate).toBe(90);
  });

  it('copies a resource shared across the source pages exactly once', () => {
    const target = Document.Open(buildClassicPdf(1));
    target.Append(Document.Open(buildSharedFontPdf()));
    const f1Num = (i: number) => {
      const res = target.resolve(target.Pages[i].Dict.get('Resources'));
      const font = isDict(res) ? target.resolve(res.get('Font')) : null;
      const f1 = isDict(font) ? font.get('F1') : null;
      if (!isRef(f1)) throw new Error('F1 not a ref');
      return f1.num;
    };
    // Both merged pages (now pages 2 and 3) must reference the SAME font object.
    expect(f1Num(1)).toBe(f1Num(2));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/merge.test.ts`
Expected: FAIL — `target.Append is not a function`.

- [ ] **Step 3: Add imports to `src/document.ts`**

In the `./types.js` import (line 5), add `PdfRef`:

```ts
import { PdfObject, PdfDict, PdfRef, isRef, isDict, isStream, isName, isArray, ref, name } from './types.js';
```

In the `./extractor.js` import (line 10), add the two newly exported helpers:

```ts
import { extractPage, defaultPrunePolicy, PrunePolicy, cloneShallow, rewriteRefs } from './extractor.js';
```

- [ ] **Step 4: Add the module-level `inheritedValue` helper**

In `src/document.ts`, just below the `offsetRefs` function (after line 63), add:

```ts
/** First ancestor value of `key` up `src`'s /Parent chain in `doc` (raw, not
 *  resolved); null if none. Cycle-guarded. Does not read `src` itself. */
function inheritedValue(doc: Document, src: PdfDict, key: string): PdfObject {
  let node: PdfObject = doc.resolve(src.get('Parent'));
  const seen = new Set<PdfDict>();
  while (isDict(node)) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node.has(key)) return node.get(key)!;
    node = doc.resolve(node.get('Parent'));
  }
  return null;
}
```

- [ ] **Step 5: Add `importPages` and `Append` to the `Document` class**

Insert these methods inside the `Document` class (e.g. just before `RemovePage`):

```ts
/** Whole-document import: deep-copy every page of `other` into this.objects with
 *  fresh offset object numbers. Shared objects are copied once (one old->new map),
 *  inherited MediaBox/CropBox/Resources/Rotate are flattened onto each leaf, and
 *  /Annots are sanitized via defaultPrunePolicy. Each new leaf is re-parented to
 *  `rootNum`. Returns the new leaf object numbers in `other`'s page order.
 *  Does not mutate `other`. */
private importPages(other: Document, rootNum: number): number[] {
  const policy = defaultPrunePolicy();
  const inheritable = ['MediaBox', 'CropBox', 'Resources', 'Rotate'];
  let next = this.maxObjNum();
  const map = new Map<number, number>(); // other old-num -> this new-num (dedup)
  const queue: PdfObject[] = [];

  // Clone an other-object on first sight, renumber, install, enqueue for rewrite.
  const remap = (r: PdfRef): PdfRef => {
    let nn = map.get(r.num);
    if (nn === undefined) {
      nn = ++next;
      map.set(r.num, nn);
      const cloned = cloneShallow(other.getObject(r.num));
      this.objects.set(nn, cloned);
      queue.push(cloned);
    }
    return ref(nn);
  };

  // Prepare each leaf: flatten inheritance (from the live source chain), drop
  // page keys, sanitize annots. Install with a fresh number; defer /Parent until
  // after the rewrite so rootNum (a THIS-document ref) is never remapped.
  const leafNums: number[] = [];
  for (const page of other.Pages) {
    const src = page.Dict;
    const leaf: PdfDict = new Map(src);
    for (const key of inheritable) {
      if (!leaf.has(key)) {
        const v = inheritedValue(other, src, key);
        if (v !== null) leaf.set(key, v);
      }
    }
    for (const k of policy.dropPageKeys) leaf.delete(k);
    if (leaf.has('Annots')) {
      const annots = other.resolve(leaf.get('Annots'));
      leaf.set('Annots', isArray(annots) ? policy.sanitizeAnnots(other, annots) : []);
    }
    const leafNum = ++next;
    this.objects.set(leafNum, leaf);
    queue.push(leaf);
    leafNums.push(leafNum);
  }

  while (queue.length) rewriteRefs(queue.shift()!, remap);

  for (const num of leafNums) {
    const leaf = this.objects.get(num);
    if (isDict(leaf)) {
      leaf.set('Parent', ref(rootNum));
      if (!leaf.has('Type')) leaf.set('Type', name('Page'));
    }
  }
  return leafNums;
}

/** Append every page of `other` to the end of this document. Returns the new
 *  pages' 1-based numbers. `other` is not modified; a 0-page `other` is a no-op
 *  returning []. */
Append(other: Document): number[] {
  return this.InsertPages(this.Pages.length + 1, other);
}
```

(`Append` delegates to `InsertPages`, added in Task 4. To run Task 3's tests before Task 4 exists, temporarily inline the body — see Step 6 — or implement Task 4 first. The recommended order is to add `InsertPages` now alongside `Append`; if doing strict task isolation, use the temporary body below and replace it in Task 4.)

- [ ] **Step 6: Provide `InsertPages` so `Append` resolves**

Add `InsertPages` now (it is finalized and tested in Task 4):

```ts
/** Insert every page of `other` so the first becomes 1-based page `at`
 *  (1..Pages.length+1), shifting existing pages down. Returns the new pages'
 *  1-based numbers in `other`'s order. Throws RangeError when `at` is out of
 *  range. `other` is not modified. */
InsertPages(at: number, other: Document): number[] {
  const rootNum = this.requireIndirectPagesRoot();
  const n = this.Pages.length;
  if (!Number.isInteger(at) || at < 1 || at > n + 1)
    throw new RangeError(`InsertPages: position ${at} out of range 1..${n + 1}`);
  const newNums = this.importPages(other, rootNum);
  if (newNums.length === 0) return [];
  const kids = this.currentKids();
  kids.splice(at - 1, 0, ...newNums.map((num) => ref(num)));
  this.syncPages(kids);
  return newNums.map((_, i) => at + i);
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/merge.test.ts`
Expected: PASS — all `Document.Append` tests green.

- [ ] **Step 8: Commit**

```bash
git add src/document.ts test/merge.test.ts
git commit -m "feat: Document.Append + InsertPages (whole-doc import, flatten, dedup)"
```

---

## Task 4: `InsertPages` validation + positioning tests

**Files:**
- Modify: `test/merge.test.ts` (add a describe block)
- (`InsertPages` itself was added in Task 3 Step 6 — this task locks its behavior with tests.)

- [ ] **Step 1: Write the failing/▢ tests for `InsertPages`**

Append to `test/merge.test.ts`:

```ts
describe('Document.InsertPages', () => {
  it('prepends source pages at position 1, shifting originals down', () => {
    const target = Document.Open(buildClassicPdf(2)); // "Page 1","Page 2"
    const other = Document.Open(buildClassicPdf(1));  // "Page 1"
    const nums = target.InsertPages(1, other);
    expect(nums).toEqual([1]);
    expect(target.Pages.length).toBe(3);
    expect(new TextDecoder().decode(target.Pages[0].Contents)).toContain('Page 1'); // inserted
    expect(new TextDecoder().decode(target.Pages[2].Contents)).toContain('Page 2'); // shifted
  });

  it('splices source pages in the middle with contiguous numbers', () => {
    const target = Document.Open(buildClassicPdf(3));
    const nums = target.InsertPages(2, Document.Open(buildClassicPdf(2)));
    expect(nums).toEqual([2, 3]);
    expect(target.Pages.length).toBe(5);
  });

  it('at = Pages.length + 1 behaves like Append', () => {
    const target = Document.Open(buildClassicPdf(2));
    const nums = target.InsertPages(3, Document.Open(buildClassicPdf(1)));
    expect(nums).toEqual([3]);
    expect(target.Pages.length).toBe(3);
  });

  it('throws RangeError out of range / non-integer and leaves both docs unchanged', () => {
    const target = Document.Open(buildClassicPdf(2));
    const other = Document.Open(buildClassicPdf(1));
    for (const bad of [0, 4, 1.5]) {
      expect(() => target.InsertPages(bad, other)).toThrow(RangeError);
    }
    expect(target.Pages.length).toBe(2);
    expect(other.Pages.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/merge.test.ts`
Expected: PASS (implementation already present from Task 3 Step 6).

> Note: the out-of-range test asserts both docs are unchanged. Validation runs before `importPages`, so no objects are imported on a throw — verify `target.Pages.length` stays 2.

- [ ] **Step 3: Commit**

```bash
git add test/merge.test.ts
git commit -m "test: Document.InsertPages positioning and validation"
```

---

## Task 5: static `Merge` + `createEmptyDocument`

**Files:**
- Modify: `src/document.ts` (add `createEmptyDocument` private static and `Merge` static)
- Modify: `test/merge.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing tests for `Merge`**

Append to `test/merge.test.ts`:

```ts
describe('Document.Merge', () => {
  it('builds a new document with all pages of all inputs in order', () => {
    const a = Document.Open(buildClassicPdf(1)); // "Page 1"
    const b = Document.Open(buildClassicPdf(2)); // "Page 1","Page 2"
    const merged = Document.Merge(a, b);
    expect(merged.Pages.length).toBe(3);
    expect(new TextDecoder().decode(merged.Pages[0].Contents)).toContain('Page 1');
    expect(new TextDecoder().decode(merged.Pages[2].Contents)).toContain('Page 2');
  });

  it('leaves every input document unmodified', () => {
    const a = Document.Open(buildClassicPdf(1));
    const b = Document.Open(buildClassicPdf(1));
    Document.Merge(a, b);
    expect(a.Pages.length).toBe(1);
    expect(b.Pages.length).toBe(1);
  });

  it('returns a valid empty document for no inputs or only-empty inputs', () => {
    expect(Document.Merge().Pages.length).toBe(0);
    expect(Document.Merge(Document.Open(buildClassicPdf(0))).Pages.length).toBe(0);
  });

  it('round-trips a merge result through Save()/Open', () => {
    const merged = Document.Merge(
      Document.Open(buildClassicPdf(1)),
      Document.Open(buildClassicPdf(1)),
    );
    const reopened = Document.Open(merged.Save());
    expect(reopened.Pages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/merge.test.ts`
Expected: FAIL — `Document.Merge is not a function`.

- [ ] **Step 3: Add `createEmptyDocument` and `Merge` to `src/document.ts`**

Add a private static helper near `fromObjects` (after line 88):

```ts
/** Build an empty document: a /Catalog (obj 1) plus an empty indirect /Pages
 *  root (obj 2). Used by Merge as the accumulator. */
private static createEmptyDocument(): Document {
  const objects = new Map<number, PdfObject>();
  const pagesRoot: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')],
    ['Kids', []],
    ['Count', 0],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')],
    ['Pages', ref(2)],
  ]);
  objects.set(1, catalog);
  objects.set(2, pagesRoot);
  return Document.fromObjects(objects, 1);
}
```

Add the public static `Merge` (e.g. just after `Append`):

```ts
/** Build a new document from copies of all `docs`, in order. Every input is left
 *  unmodified. Equivalent to an empty doc with each input Append-ed. */
static Merge(...docs: Document[]): Document {
  const out = Document.createEmptyDocument();
  for (const d of docs) out.Append(d);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/merge.test.ts`
Expected: PASS — all `Document.Merge` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/merge.test.ts
git commit -m "feat: static Document.Merge + createEmptyDocument accumulator"
```

---

## Task 6: Same-document append, composition, and full regression

**Files:**
- Modify: `test/merge.test.ts` (add a describe block)

- [ ] **Step 1: Write the composition/regression tests**

Append to `test/merge.test.ts`:

```ts
import { isName } from '../src/types.js'; // add to the existing import line if not present

describe('Document merge — composition', () => {
  it('doc.Append(doc) doubles pages with distinct copied objects', () => {
    const doc = Document.Open(buildClassicPdf(2));
    doc.Append(doc);
    expect(doc.Pages.length).toBe(4);
    // The copy is a distinct object: mutating it does not change the original.
    doc.Pages[2].Dict.set('UserUnit', 2);
    expect(doc.Pages[0].Dict.has('UserUnit')).toBe(false);
  });

  it('Merge then Reorder then RemovePage compose correctly', () => {
    const merged = Document.Merge(
      Document.Open(buildClassicPdf(2)), // pages "Page 1","Page 2"
      Document.Open(buildClassicPdf(1)), // page  "Page 1"
    );
    expect(merged.Pages.length).toBe(3);
    merged.Reorder([3, 1, 2]);
    expect(new TextDecoder().decode(merged.Pages[0].Contents)).toContain('Page 1'); // old page 3
    merged.RemovePage(1);
    expect(merged.Pages.length).toBe(2);
    const reopened = Document.Open(merged.Save());
    expect(reopened.Pages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the merge file**

Run: `npx vitest run test/merge.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full suite + typecheck (regression guard)**

Run: `npm run typecheck && npm test`
Expected: PASS — all prior tests (Reorder, InsertPage, RemovePage, split, extractor, serializer, …) remain green; new merge tests included.

- [ ] **Step 4: Commit**

```bash
git add test/merge.test.ts
git commit -m "test: same-doc append + Merge/Reorder/RemovePage composition"
```

---

## Task 7: Close out the issue

- [ ] **Step 1: Mark the beads issue done**

Run:
```bash
bd close aspose-pdf-foss-for-ts-8ol --reason="Append/InsertPages/Merge shipped with whole-doc import, inheritance flatten, shared-object dedup; merge.test.ts green; full suite passing"
```

- [ ] **Step 2: Sync the beads export and push**

Run:
```bash
git add .beads/issues.jsonl
git commit -m "chore: sync beads issues export (close 8ol)"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Self-Review

**Spec coverage:**
- `Append` / `InsertPages` / static `Merge` API → Tasks 3, 4, 5. ✓
- Whole-document import with shared-object dedup → `importPages` (Task 3) + dedup test (Task 3 Step 1, `buildSharedFontPdf`). ✓
- Inheritance flattening (MediaBox/CropBox/Resources/Rotate) → `importPages` `inheritable` loop (Task 3); tested via MediaBox + Rotate (Task 3). CropBox/Resources use the identical loop body — MediaBox/Rotate are representative; noted, not a gap. ✓
- Flat re-parent model → `/Parent = ref(rootNum)`, splice via `currentKids`/`syncPages`; composition with Reorder/RemovePage proven in Task 6. ✓
- `other` not mutated → "source unchanged" tests (Tasks 3, 5); copies are distinct (Task 6). ✓
- 0-page `other` no-op; `Merge()`/empty inputs → Tasks 3, 5. ✓
- Validation before mutation (`InsertPages` range; `requireIndirectPagesRoot`) → Task 4; range check precedes `importPages`. ✓
- Persistence via `Save()` round-trips → Tasks 3, 5, 6. ✓
- Annotation sanitization via `defaultPrunePolicy` → reused in `importPages` (Task 3). (No annotated-PDF test added; behavior is delegated to the already-tested `defaultPrunePolicy`/extractor path. Acceptable.) ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The Task 3 Step 5/6 note explicitly resolves the `Append`→`InsertPages` ordering by adding both together. ✓

**Type consistency:** `importPages(other: Document, rootNum: number): number[]`, `Append(other): number[]`, `InsertPages(at, other): number[]`, `Merge(...docs): Document`, `createEmptyDocument(): Document`, `inheritedValue(doc, src, key): PdfObject` — names/signatures consistent across all tasks and the spec. `PdfRef`, `cloneShallow`, `rewriteRefs` imports added in Task 3 Step 3 match the exports added in Task 2. ✓
