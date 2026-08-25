# Document.Reorder — Design

**Issue:** aspose-pdf-foss-for-ts-5zi
**Date:** 2026-06-05
**Status:** Approved

## Goal

Add an instance method `Reorder(order: number[])` to `Document` that rearranges
the document's pages. `order` is an array of **1-based page numbers** indexing
the *current* page set; after the call, new page `i` equals old page
`order[i-1]`.

The reorder takes effect **both** in memory (the `Document.Pages` array) and in
the bytes produced by `save()`.

## Semantics

- New page `i` = old page `order[i-1]`. Example: on a 3-page document,
  `Reorder([3, 1, 2])` puts the original third page first.
- **Repeats allowed:** `Reorder([1, 1, 2])` produces three pages — old page 1
  twice, then old page 2.
- **Omissions allowed:** `Reorder([3, 1])` on a 3-page document produces a
  two-page document (old page 3, old page 1). Page 2 is **dropped**, not
  appended.
- The resulting page count is exactly `order.length`.
- `order` indexes the page set as it is **at the time of the call** (a second
  `Reorder` operates on the result of the first).

## Validation

`Reorder` throws `RangeError` when:
- `order` is empty (a PDF must have at least one page), or
- any entry is not an integer, or
- any entry is outside `1..N`, where `N` is the current page count.

No silent clamping or coercion.

## Scope

In scope:
- `Document.Reorder(order: number[]): void`.
- In-memory rebuild of `Document.Pages` (correct `Page.Number` per slot).
- Persistence on `save()` by flattening the page tree via an incremental update,
  composed cleanly with any pending metadata edit.

Out of scope:
- Preserving a nested `/Pages` tree structure (we flatten — see below).
- Fixing annotation `/P` back-references on cloned (repeated) pages.
- Reorder when `/Pages` is a direct (inline) dict rather than an indirect
  reference — `save()` throws `UnsupportedFeatureError` in that case.

## API

In `src/document.ts`:

```ts
/** Rearrange pages: new page i = old page order[i-1] (1-based). Repeats and
 *  omissions allowed. Throws RangeError on empty/non-integer/out-of-range. */
Reorder(order: number[]): void
```

## In-memory effect

`Document.Pages` is rebuilt in place (the field is `readonly`, so its contents
are replaced, not the reference):

- For each entry `o` in `order`, create a fresh `Page(this, src.Dict, i + 1)`
  where `src = this.Pages[o - 1]`. The new `Page` shares the source page's
  materialized `Dict` but carries its new 1-based `Number`. A repeated page
  becomes distinct `Page` instances over the same `Dict`.
- A parallel `private pageObjNums: number[]` (one entry per `Pages` slot, the
  backing object number) is rebuilt the same way so `save()` knows which object
  each slot came from.
- A `private pageOrderChanged = true` flag is set.

## Persistence effect

On `save()`, when `pageOrderChanged` is set, the page tree is **flattened** to a
single level via the existing incremental-update path
(`appendIncremental`). Flattening (approach A from brainstorming) was chosen
over reordering `/Kids` in place because it handles arbitrary nested input
trees and page repeats uniformly.

Rewrite plan, all in one appended section:

1. **Page objects.** For each `Pages` slot, write the page dictionary as the
   materialized `Dict` (inheritable attributes — `Resources`, `MediaBox`,
   `CropBox`, `Rotate` — already folded in by `buildPages`), with:
   - `/Parent` set to the root `/Pages` reference, and
   - `/Type /Page` ensured (the page-tree walk admits leaves without an explicit
     `/Type`).

   The **first** use of an original page reuses its existing object number, so
   external references (outlines, named destinations, annotation `/P`) that
   point at it stay valid. A **repeated** use allocates a new object number
   (`++maxObjNum`) and writes a clone.

2. **Root `/Pages` node.** Rewritten (same object number) with `/Kids` set to the
   page references in new order and `/Count` set to `order.length`; all other
   entries preserved.

3. **Omitted pages.** Left untouched — their objects remain in the file but are
   unreferenced from the tree. Harmless.

`save()` is restructured to assemble a single `objects` map covering both
metadata and page-tree rewrites:

- Trigger condition becomes `infoState !== 'unchanged' || pageOrderChanged`.
- `/Info` handling preserves the existing `/Info` reference when metadata is
  unchanged (so a reorder-only save does not drop `/Info`), writes the working
  copy when modified, and omits `/Info` when cleared — same rules as today.
- `/Size` is `maxObjNum + 1`, accounting for any newly allocated clone object
  numbers.

## Plumbing changes

- `buildPages(doc)` returns `{ pages, pageObjNums, rootPagesNum }` instead of
  `Page[]`:
  - During the walk, capture each leaf's object number (the `num` of the ref
    that led to it; for the root, the `num` of `catalog.get('Pages')`).
  - `rootPagesNum` is the object number of `catalog.get('Pages')` when it is an
    indirect reference, otherwise `undefined`.
  - The `Document` constructor stores `Pages`, `pageObjNums`, and
    `rootPagesNum`. `buildPages` is only called from that constructor.

- `src/page.ts` and `src/split.ts` are unaffected (`Page`'s public shape is
  unchanged; object-number tracking lives in `Document`).

## Error handling

- Invalid `order` → `RangeError` (synchronous, before any mutation).
- `save()` after a reorder when `/Pages` is not an indirect reference →
  `UnsupportedFeatureError('cannot reorder: /Pages is not an indirect reference')`.

## Known limitations (accepted)

- A cloned (repeated) page shares its source's `/Annots`; an annotation's `/P`
  back-reference continues to point at the original page object only.
- Intermediate `/Pages` nodes from a nested input tree become orphaned objects
  in the saved file.

## Exports

`Document` is already exported from `src/index.ts`; `Reorder` is reached through
it. No export change.

## Testing (TDD, Vitest)

Add to `test/document.test.ts` (reuse `buildClassicPdf` / page-tree builders
already used by the document tests):

- **Validation:** empty `order`, a non-integer entry, `0`, and `N + 1` each
  throw `RangeError`; `Pages` is left unchanged after a throw.
- **In-memory reorder:** `Reorder([3, 1, 2])` leaves `Pages.length === 3` with
  `Page.Number` 1..3 and contents matching old pages 3, 1, 2.
- **In-memory drop:** `Reorder([3, 1])` yields `Pages.length === 2`.
- **In-memory duplicate:** `Reorder([1, 1, 2])` yields `Pages.length === 3` with
  the first two pages' contents equal.
- **Round-trip:** `Reorder([...])` → `save()` → `Document.Open(saved)` yields
  pages in the new order (compare `Page.Contents`); a duplicate produces the
  correct page count after reopen.
- **Reorder + metadata in one save:** `setMetadata` plus `Reorder`, then a single
  `save()`; reopened document reflects both.
