# Document.Merge / Append / InsertPages — Design

**Issue:** aspose-pdf-foss-for-ts-8ol
**Date:** 2026-06-09
**Status:** Approved

## Goal

Add document **concatenation** to `Document`: append all pages of one document
into another, insert them at a position, or build a fresh document from several.
Like `Reorder` and `InsertPage`, every operation mutates the live `/Pages` node
and rebuilds the `Pages` / `pageObjNums` arrays, so the change is observable
immediately *and* persists through `Save()`. This is the natural completion of
the `AddPage(source)` / `InsertPage(at, source)` family — those copy one page;
these copy a whole document.

Three public surfaces on `Document`:

```ts
Append(other: Document): number[]
InsertPages(at: number, other: Document): number[]
static Merge(...docs: Document[]): Document
```

## Semantics

### Append / InsertPages

- `InsertPages(at, other)` copies every page of `other` into this document so the
  first copied page becomes **1-based page `at`** (`1 .. Pages.length + 1`),
  shifting the page currently at `at` and everything after it down. Copied pages
  keep `other`'s page order.
- `Append(other)` is exactly `InsertPages(this.Pages.length + 1, other)` — append
  to the end.
- Both return `number[]`: the 1-based positions of the newly inserted pages (in
  `other`'s order). For `Append`, these are contiguous at the tail.
- `other` is **not** mutated. The copy is self-contained: a later edit to either
  document does not affect the other.
- A 0-page `other` makes `Append` / `InsertPages` a **no-op** returning `[]`.

### Merge

- `Merge(...docs)` builds and returns a **new** `Document` containing copies of
  all pages of every input, in argument order. Every input is left unmodified.
- Equivalent to creating an empty document and `Append`-ing each input in turn.
- `Merge()` with no arguments (or only empty docs) returns a valid 0-page
  document.

## Copy strategy — whole-document import

Unlike the per-page `extractPage` path used by `AddPage(source)`, the copy here
is a **single whole-document import** with shared-object de-duplication:

- **BFS from all of `other`'s page leaves at once**, sharing one
  `newNumByOld` map. A font / image / resource referenced by several of `other`'s
  pages is therefore copied **once**, not once per page. This is the primary
  reason for whole-doc import over a per-page loop.
- `/Parent` is a **cut edge** — never traversed (pages are re-parented flat to
  this document's root, below).
- Reads `other` only; never mutates it. Same-class `private` access lets the
  importer read `other.objects` / `other.Pages` directly.

### Inheritance flattening

Re-parenting a leaf flat under this document's root would drop any attribute the
leaf **inherited** from one of `other`'s intermediate `/Pages` nodes. Before
cutting `/Parent`, for each leaf and each of the four spec-defined inheritable
page attributes — **`MediaBox`, `CropBox`, `Resources`, `Rotate`** — if the leaf
copy lacks the key, walk `other`'s `/Parent` chain (via `other.resolve`,
cycle-guarded) and copy the first value found onto the leaf copy. The leaf is
then self-contained and re-parenting is lossless. (Fixes for real-world PDFs that
set `MediaBox` once on the `/Pages` root.)

### Annotation / key sanitization

Reuse `defaultPrunePolicy()` — identical semantics to today's copy path:

- Drop page keys `/Parent`, `/B`, `/StructParents`.
- Sanitize `/Annots`: strip `/P` back-references, same-document GoTo actions, and
  `/Dest`. Keep URI / GoToR.

This is the accepted limitation carried over from the existing copy path.

## Flat page-tree model

`buildPages` recurses arbitrary nested `/Pages` trees, so grafting `other`'s
`/Pages` subtree as a single child node is *possible* and would preserve
inheritance for free. We **do not** do this: `Reorder`, `InsertPage`,
`RemovePage`, and `currentKids` all assume a **flat single-level** page tree
(the root node's `Kids` is exactly the page list). Introducing a nested subtree
would make those mutators flatten it on the next call and silently lose the
inherited attributes. Keeping merged pages flat (re-parented directly under the
root, with inheritance pre-flattened onto each leaf) keeps `Merge` composing
cleanly with every existing page mutator.

## API

In `src/document.ts`:

```ts
/** Append every page of `other` to the end of this document. Returns the new
 *  pages' 1-based numbers (contiguous at the tail). `other` is not modified;
 *  a 0-page `other` is a no-op returning []. */
Append(other: Document): number[]

/** Insert every page of `other` so the first lands at 1-based page `at`
 *  (1..Pages.length+1), shifting existing pages down. Returns the new pages'
 *  1-based numbers in `other`'s order. Throws RangeError when `at` is out of
 *  range. `other` is not modified. */
InsertPages(at: number, other: Document): number[]

/** Build a new document from copies of all `docs`, in order. Every input is left
 *  unmodified. Equivalent to an empty doc with each input Append-ed. */
static Merge(...docs: Document[]): Document
```

## Internal helpers (new, private)

```ts
/** Whole-document import: deep-copy every page of `other` (shared objects
 *  deduped, inheritance flattened, annots sanitized) into this.objects with
 *  fresh offset object numbers, each leaf parented to `rootNum`. Returns the new
 *  leaf object numbers in `other`'s page order. Does not mutate `other`. */
private importPages(other: Document, rootNum: number): number[]

/** Build an empty document: a catalog + an empty indirect /Pages root. Used by
 *  Merge as the accumulator. */
private static createEmptyDocument(): Document
```

`importPages` BFS mirrors `extractPage`'s clone-and-rewrite (`cloneShallow`,
`rewriteRefs`) but (a) seeds the queue with **all** leaves up front against one
shared `newNumByOld` map, (b) flattens inheritance onto each leaf before
enqueuing, and (c) emits numbers offset by `this.maxObjNum()` rather than `1..k`.
The offset traversal reuses the existing module-level `offsetRefs` or folds the
offset into the rewrite map. `createEmptyDocument` builds
`{1: catalog → Pages ref(2), 2: << /Type /Pages /Kids [] /Count 0 >>}` and calls
`Document.fromObjects(objects, 1)`.

## In-memory effect

`InsertPages(at, other)`:

1. `const rootNum = this.requireIndirectPagesRoot();`
2. Validate `at` (integer, `1 .. Pages.length + 1`) — `RangeError` before any
   mutation.
3. `const newNums = this.importPages(other, rootNum);` (installs copied objects;
   `[]` when `other` has no pages).
4. `const kids = this.currentKids();` splice `newNums.map(ref)` in at index
   `at - 1`.
5. `this.syncPages(kids);`
6. Return the new pages' 1-based numbers: `[at, at+1, …, at + newNums.length - 1]`.

`Append(other)` → `return this.InsertPages(this.Pages.length + 1, other);`

`Merge(...docs)`:

1. `const out = Document.createEmptyDocument();`
2. `for (const d of docs) out.Append(d);`
3. `return out;`

## Validation & preconditions

- `Append` / `InsertPages` require this document's root `/Pages` to be an
  **indirect reference** (`requireIndirectPagesRoot`, same guard as `Reorder` /
  `InsertPage`). Otherwise `UnsupportedFeatureError('cannot modify pages: /Pages
  is not an indirect reference')`, thrown before any mutation.
- `InsertPages`: `RangeError` when `at` is not an integer or is outside
  `1 .. Pages.length + 1`. Thrown before any mutation.
- `other` has **no** structural precondition — only its leaves are read. A
  0-page `other` is a no-op.
- `Merge`'s target is freshly built and always satisfies the precondition.

All validation runs **before** any mutation; a throw leaves both documents
unchanged.

## Persistence effect

No new serializer code. `syncPages` mutates the live `/Pages` root node and the
imported objects live in `this.objects`, so `Save()` (`serializeDocument`,
mark-sweep from `/Root`, renumber `1..N`) picks up inserted pages and drops any
transient duplication automatically. Offset import numbers are renumbered to a
dense range.

## Scope

In scope:
- `Document.Append`, `Document.InsertPages`, `Document.Merge`.
- Whole-document import with shared-object de-duplication.
- Inheritance flattening of `MediaBox` / `CropBox` / `Resources` / `Rotate`.
- Cross-document and same-document (`doc.Append(doc)`) merge.
- In-memory rebuild of `Pages` / `pageObjNums`; persistence through `Save()`.

Out of scope:
- Nested `/Pages` subtree grafting (kept flat — see "Flat page-tree model").
- Preserving cross-page GoTo / `/Dest` links inside `other` (pruned by
  `defaultPrunePolicy`).
- Merging document-level structures: outlines, AcroForm fields, `/Names`,
  page labels, `/StructTreeRoot`, metadata. Only pages are merged.
- Operating when this document's `/Pages` is a direct (inline) dict.

## Known limitations (accepted)

- Same as the existing copy path: a copied page loses same-document GoTo
  destinations, `/Dest`, annotation `/P`, and `/B` / `/StructParents`.
- Only pages cross over — document-level metadata, bookmarks, and form fields of
  `other` are not merged.
- Flat model: merged pages attach directly to the root `/Pages` node.

## Exports

`Document` is already exported from `src/index.ts`; the new methods and the
static `Merge` are reached through it. No new top-level export.

## Testing (TDD, Vitest)

Add to `test/document.test.ts` (reuse `buildClassicPdf`):

**Append:**
- `Append(other)` on a 2-page doc with a 3-page `other` → `Pages.length === 5`;
  return value `[3, 4, 5]`; pages 3–5 match `other`'s pages 1–3 (by `Contents`).
- **Source unchanged:** `other.Pages.length` and contents intact after `Append`.
- `Append` of a 0-page document → no-op, returns `[]`, `Pages.length` unchanged.
- Round-trip: `Append` → `Save()` → `Open` preserves the merged page count and
  contents.

**InsertPages:**
- `InsertPages(1, other)` prepends `other`'s pages; originals shift down.
- `InsertPages(2, other)` splices in the middle; return numbers are contiguous
  starting at 2.
- `InsertPages(Pages.length + 1, other)` equals `Append`.
- Validation: `InsertPages(0, …)`, `InsertPages(N + 2, …)`, `InsertPages(1.5, …)`
  throw `RangeError`; both documents unchanged.

**Merge:**
- `Merge(a, b, c)` → page count equals the sum; order is a-then-b-then-c by
  `Contents`; `a`, `b`, `c` all unmodified.
- `Merge()` and `Merge(emptyDoc)` → valid 0-page document.
- Round-trip a `Merge` result through `Save()` → `Open`.

**Shared-resource dedup:**
- An `other` whose two pages share one font/XObject (same ref) → after
  `Append` + `Save()` + `Open`, exactly **one** copy of that resource object
  exists (assert via object count or a serialized-bytes probe).

**Inheritance flatten:**
- An `other` that sets `MediaBox` on its `/Pages` **root** (pages inherit it) →
  after `Append`, the merged pages report that `MediaBox` (not the US-Letter
  default). Same check for `Rotate`.

**Same-document & composition:**
- `doc.Append(doc)` doubles the page count; copies are distinct objects
  (mutating a copy does not affect the original).
- `Merge` then `Reorder` / `RemovePage` compose correctly in one session.
- Existing `Reorder` / `InsertPage` / `RemovePage` tests remain green.
