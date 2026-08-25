# Document.AddPage / InsertPage / RemovePage — Design

**Issue:** aspose-pdf-foss-for-ts-25c
**Date:** 2026-06-09
**Status:** Approved

## Goal

Add page **insertion** and **removal** to `Document`, mirroring the live
in-memory object model. Like `Reorder`, every operation mutates the live
`/Pages` node and rebuilds the `Pages` / `pageObjNums` arrays, so the change is
observable immediately *and* persists through `Save()`.

Three public methods on `Document`:

```ts
AddPage(source?: Page): { page: Page; number: number }
InsertPage(at: number, source?: Page): { page: Page; number: number }
RemovePage(target: number | Page): void
```

## Semantics

### AddPage / InsertPage

- `InsertPage(at, source?)` inserts a page so it becomes **1-based page `at`**,
  shifting the page currently at `at` and everything after it down by one.
- `AddPage(source?)` is exactly `InsertPage(this.Pages.length + 1, source?)` —
  append to the end.
- Both return `{ page, number }` where `page` is the freshly rebuilt `Page`
  handle (live dict from this document) and `number` is its 1-based position
  (`page.Number`). `number` equals `at` for `InsertPage`, and
  `this.Pages.length` (after the insert) for `AddPage`.
- **No `source`** → a blank page is created:
  `<< /Type /Page /Parent <root> /MediaBox [0 0 595 842] /Resources << >> >>`.
  A4 size, empty resources, **no `/Contents`** (renders blank).
- **With `source`** (a `Page` from this or another `Document`) → the source
  page's object graph is **deep-copied** into this document with fresh object
  numbers, then inserted. The source document is **not** mutated. The copy is
  self-contained: a later edit to either document does not affect the other.

### RemovePage

- `RemovePage(n: number)` removes 1-based page `n`.
- `RemovePage(page: Page)` removes the page whose live `Dict` is identical
  (`===`) to a page currently in `this.Pages`.
- The removed page's object stays in the live map but becomes unreferenced from
  the page tree; it is swept at `Save()` (mark-sweep from `/Root`) — identical to
  how `Reorder` drops omitted pages today.
- Removing is allowed down to and including the last page: a 1-page document may
  become a 0-page document (consistent with `Document.Open(buildClassicPdf(0))`
  being a valid empty document). No minimum-page-count rule.

## Validation

- `InsertPage(at, …)`: `RangeError` when `at` is not an integer or is outside
  `1 .. this.Pages.length + 1`.
- `AddPage`: never range-throws (computed `at` is always valid).
- `RemovePage(n)`: `RangeError` when `n` is not an integer or is outside
  `1 .. this.Pages.length`.
- `RemovePage(page)`: `RangeError` (or `Error`) when `page.Dict` is not found in
  `this.Pages` (page does not belong to this document).
- `source` for Add/Insert that is not a `Page` over a dict → `Error`.

All validation runs **before** any mutation; a throw leaves the document
unchanged.

## Structural precondition

All three methods require the root `/Pages` to be an **indirect reference**
(`rootPagesNum !== undefined`) — the same guard `Reorder` enforces. Otherwise:
`UnsupportedFeatureError('cannot modify pages: /Pages is not an indirect reference')`.
Thrown before any mutation.

## Scope

In scope:
- `Document.AddPage`, `Document.InsertPage`, `Document.RemovePage`.
- Blank-page creation (A4).
- Cross-document and same-document page copy via the existing extractor.
- In-memory rebuild of `Pages` / `pageObjNums`; persistence through `Save()`.
- A small shared-plumbing refactor (below) that `Reorder` also adopts.

Out of scope:
- Preserving a nested `/Pages` subtree (we keep the existing flat single-level
  `/Pages` model — inserted/removed pages live directly under the root node).
- Fixing annotation `/P` back-references beyond what `defaultPrunePolicy` already
  does on copy.
- Page size/box setters on inserted pages (tracked separately by issue 31b).
- Operating when `/Pages` is a direct (inline) dict.

## API

In `src/document.ts`:

```ts
/** Append a page (blank, or a deep copy of `source`); returns the new Page and
 *  its 1-based number. */
AddPage(source?: Page): { page: Page; number: number }

/** Insert a page so it becomes 1-based page `at` (1..Pages.length+1), blank or a
 *  deep copy of `source`. Throws RangeError out of range. */
InsertPage(at: number, source?: Page): { page: Page; number: number }

/** Remove a page by 1-based number or by Page handle. Throws RangeError when the
 *  page is absent or the number is out of range. */
RemovePage(target: number | Page): void
```

## Shared plumbing (refactor)

The tail of `Reorder` (lines ~121–132 today) — write `/Type`, `/Kids`, `/Count`
into the root node, then `buildPages` and replace `Pages` / `pageObjNums` in
place — is extracted into two private helpers reused by all four methods:

```ts
/** The root /Pages object number, or throw if /Pages is inline. */
private requireIndirectPagesRoot(): number

/** Write Kids/Count into the root node and rebuild Pages + pageObjNums. */
private syncPages(kids: PdfObject[]): void
```

`syncPages` sets `Type=/Pages`, `Kids=kids`, `Count=kids.length` on the root
node, calls `buildPages(this)`, and refreshes `this.Pages` (in place) and
`this.pageObjNums`. `Reorder` is updated to call these two helpers; its observable
behavior is unchanged (existing `Reorder` tests are the regression guard).

## In-memory effect

`InsertPage(at, source?)`:

1. `const rootNum = this.requireIndirectPagesRoot();`
2. Validate `at` (integer, `1 .. Pages.length + 1`).
3. Allocate the new page object:
   - **Blank:** `newNum = this.maxObjNum() + 1`; build the A4 page dict with
     `/Parent = ref(rootNum)`; `this.objects.set(newNum, pageDict)`.
   - **Copy:** see "Copying a page" below; yields `newNum` of the imported page
     object, with its `/Parent` set to `ref(rootNum)`.
4. Build the new `Kids` array: take the current root node's `Kids` (the live
   `this.pageObjNums` mapped to refs is equivalent), splice `ref(newNum)` in at
   index `at - 1`.
5. `this.syncPages(kids)`.
6. Return `{ page: this.Pages[at - 1], number: at }`.

`AddPage(source?)` → `return this.InsertPage(this.Pages.length + 1, source);`

`RemovePage(target)`:

1. `this.requireIndirectPagesRoot();`
2. Resolve `target` to a 1-based index `n`:
   - number → validate integer in `1 .. Pages.length`.
   - `Page` → find `i` with `this.Pages[i].Dict === target.Dict`; `n = i + 1`;
     throw if not found.
3. Build `Kids` from current `pageObjNums` refs with index `n - 1` removed.
4. `this.syncPages(kids)`.

Building `Kids` from `pageObjNums`: each entry maps to `ref(num)`. (Every page
backed by an indirect object — guaranteed here because `requireIndirectPagesRoot`
plus the insert path only ever add indirect pages; a pre-existing inline leaf
under an indirect root would have `objNum === 0`. Guard: if any retained
`pageObjNums` entry is `0`, throw `UnsupportedFeatureError` — same stance as
`Reorder`.)

## Copying a page (Add/Insert with `source`)

Approach **A** (chosen): reuse the tested extractor.

```ts
private importPage(srcDoc: Document, srcPage: PdfDict, rootNum: number): number
```

1. `const { objects: sub, pageNum } = extractPage(srcDoc, srcPage, defaultPrunePolicy());`
   - `sub` is a self-contained graph numbered `1..k`, all internal refs already
     rewritten to those numbers, `/Parent` dropped, `/Annots` sanitized (cross-doc
     GoTo/Dest/`P` stripped). `pageNum === 1`.
2. `const offset = this.maxObjNum();`
3. For each `[n, obj] of sub`: offset every `PdfRef` inside `obj` by `+offset`
   (a local `offsetRefs(obj, offset)` traversal mirroring the structure of
   `rewriteRefs`), then `this.objects.set(n + offset, obj)`.
4. `const newNum = pageNum + offset;` set `/Parent = ref(rootNum)` and ensure
   `/Type = /Page` on `this.objects.get(newNum)`.
5. Return `newNum`.

`srcDoc` is `source`'s owning document. `Page` does not currently expose its
`doc`; add a package-internal accessor so `Document` can read it:
- Add `/** @internal */ get document(): Document { return this.doc; }` to `Page`,
  **or** read it via an existing path. Chosen: add a minimal internal getter on
  `Page` (`get Document(): Document`). Same-document copy passes `this`.

`offsetRefs` is a small private function in `document.ts` (the extractor's
`rewriteRefs`/`passthrough` are not exported; duplicating ~15 lines here is
cheaper than widening the extractor's API and keeps the offset concern local).

## Persistence effect

No new persistence code. `syncPages` mutates the live `/Pages` node and the
imported objects live in `this.objects`, so `Save()` (`serializeDocument`,
mark-sweep from `/Root`, renumber `1..N`) picks up inserted pages and drops
removed ones automatically. A removed page's old object is unreachable and
omitted; an imported page's offset numbers are renumbered to a dense range.

## Error handling

- Out-of-range / non-integer `at` or `n` → `RangeError` (before mutation).
- `RemovePage(page)` with a foreign page → `RangeError`.
- `source` not a `Page` over a dict → `Error`.
- `/Pages` inline → `UnsupportedFeatureError` (before mutation).

## Known limitations (accepted)

- Copy uses `defaultPrunePolicy`: a copied page loses same-document GoTo
  destinations, `/Dest`, annotation `/P`, and `/B` / `/StructParents` — the
  page renders but cross-references into the source document's structure are not
  carried over.
- Nested `/Pages` subtrees are not synthesized; inserted pages attach directly to
  the root node (consistent with the current flat model).

## Exports

`Document` is already exported from `src/index.ts`; the new methods are reached
through it. `Page` gains an internal `Document` getter (already exported). No new
top-level export.

## Testing (TDD, Vitest)

Add to `test/document.test.ts` (reuse `buildClassicPdf`):

**AddPage (blank):**
- `AddPage()` on a 2-page doc → returns `{ number: 3 }`, `Pages.length === 3`,
  `Pages[2].MediaBox` is `[0, 0, 595, 842]`, `Pages[2].Contents.length === 0`.
- Round-trip: after `AddPage()` → `Save()` → `Open`, page count is 3 and the new
  page is A4.

**InsertPage (blank):**
- `InsertPage(1)` on a 3-page doc → new page is page 1; old pages shift to 2..4;
  `Pages.length === 4`; `number === 1`.
- `InsertPage(2)` inserts in the middle; old page 2 becomes page 3.
- `InsertPage(Pages.length + 1)` equals `AddPage` (appends).
- Validation: `InsertPage(0)`, `InsertPage(N + 2)`, `InsertPage(1.5)` throw
  `RangeError`; document unchanged.

**Copy (Add/Insert with source):**
- Copy a page from **another** document: `AddPage(other.Pages[0])` →
  `Pages.length` grows by 1; the new page's `Contents` matches the source's; the
  **source document is unchanged** (`other.Pages.length` and contents intact).
- Same-document copy: `AddPage(doc.Pages[0])` duplicates page 1's content; the
  copy is a distinct object (mutating the copy's dict does not affect the
  original).
- Round-trip a cross-document copy through `Save()` → `Open`: copied page's
  content survives.

**RemovePage:**
- `RemovePage(2)` on a 3-page doc → `Pages.length === 2`, remaining contents are
  old pages 1 and 3, renumbered 1..2.
- `RemovePage(doc.Pages[0])` removes page 1 by handle.
- Remove down to 0 pages: `RemovePage(1)` on a 1-page doc → `Pages.length === 0`;
  `Save()` → `Open` yields a 0-page document.
- Validation: `RemovePage(0)`, `RemovePage(N + 1)`, `RemovePage(1.5)`, and
  `RemovePage(foreignPage)` throw; document unchanged.
- Round-trip: `RemovePage(2)` → `Save()` → `Open` drops the page's object.

**Combined / regression:**
- `AddPage` then `RemovePage` then `Reorder` compose correctly in one session.
- Existing `Reorder` tests remain green after the `syncPages` refactor.
