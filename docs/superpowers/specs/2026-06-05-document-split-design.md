# Document.Split — Design

**Issue:** aspose-pdf-foss-for-ts-k0c
**Date:** 2026-06-05
**Status:** Approved

## Goal

Remove the `Page.Save` method and replace the free `splitPdf` function with an
instance method `Document.Split(options?): Document[]`. `Split` returns one
*new* single-page `Document` per page of the source document; callers serialize
each with `Document.save()` (e.g. `doc.Split().map((d) => d.save())`).

## Motivation

`Page.Save` produced single-page PDF bytes directly via `writeSinglePagePdf`,
bypassing `Document`. The desired model is that a page becomes a real
`Document`, and serialization always goes through `Document.save()`. This
requires `Document` to support serializing a freshly built (non-file-backed)
document, which it cannot do today — `save()` only appends incremental updates
to an opened file's bytes.

## Architecture: "built" documents

A `Document` is currently always backed by file bytes (`buf` + `entries` +
`trailer`), and `save()` performs an incremental append. This design adds a
second construction mode: a **built document**, constructed from an in-memory
object set plus a root object number, with no backing file.

- New private factory `Document.fromObjects(objects, rootNum): Document` builds
  one with empty `buf`/`entries` and a synthesized `trailer` of
  `<< /Root rootNum 0 R >>`.
- `getObject(num)` returns from the built object set when the document is in
  built mode; otherwise it uses the existing parse path. This makes
  `catalog()`, `resolve()`, and the constructor's `buildPages(this)` work
  unchanged for built documents.
- `save()` gains an early branch: a built document serializes from scratch via
  `writePdf(objects, rootNum)`; a file-backed document keeps today's
  incremental behavior.

Built documents start clean and have no `/Info`; `save()` for a built document
does not consult the metadata/page-order edit state (that path is not part of
split-and-save).

## API

In `src/document.ts`:

```ts
export interface SplitOptions {
  /** Pruning policy applied while extracting each page's object graph. */
  prunePolicy?: PrunePolicy;
}

/** Split into one new single-page Document per page, in page order. */
Split(options?: SplitOptions): Document[]
```

Implementation:

```ts
Split(options: SplitOptions = {}): Document[] {
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  return this.Pages.map((page) => {
    const { objects, pageNum } = extractPage(this, page.Dict, policy);
    const { objects: full, rootNum } = assembleSinglePageDoc(objects, pageNum);
    return Document.fromObjects(full, rootNum);
  });
}
```

- `assembleSinglePageDoc(objects, pageObjNum)` is the object-assembly half of
  today's `writeSinglePagePdf`: append a `/Pages` node and a `/Catalog`, and set
  the page's `/Parent` to the new `/Pages` node. It returns
  `{ objects, rootNum }` where `rootNum` is the catalog object number. Lives as
  a private helper in `document.ts`.
- A zero-page document yields `[]` (`this.Pages` is empty).
- The `prunePolicy` knob is preserved (relocated from the deleted `split.ts`).

## writer.ts

`writeSinglePagePdf(objects, pageObjNum)` is replaced by
`writePdf(objects, rootNum)`: a pure serializer of a complete object set —
write objects `1..max(keys)`, a classic `xref` table, and
`trailer << /Size N /Root rootNum 0 R >>`. It no longer synthesizes a
`/Pages`/`/Catalog` or mutates `/Parent`; that responsibility moves to
`assembleSinglePageDoc`.

## Removals and moves

- `src/page.ts`: delete the `Save` method and the `PageSaveOptions` interface,
  plus the now-unused imports (`extractPage`, `defaultPrunePolicy`,
  `writeSinglePagePdf`, `PrunePolicy`, `PageSaveOptions`).
- `src/split.ts`: deleted (both `splitPdf` and the old `SplitOptions`).
- `src/index.ts`: drop the `splitPdf` value export, the `SplitOptions` export
  from `split.js`, and the `PageSaveOptions` export; add
  `export type { SplitOptions } from './document.js'`. Keep `splitPdfFile`.
- `src/node.ts`: reimplement `splitPdfFile` as
  `Document.Open(input).Split(options).map((d) => d.save())`, writing each
  result to `page-N.pdf`. Update imports to take `Document` and the relocated
  `SplitOptions` (drop the `./split.js` import).

## Error handling

No new error paths. `extractPage` and parsing reuse existing behavior; a
zero-page document is a valid empty result.

## Testing (TDD, Vitest)

- **`test/split.test.ts`** (rewritten): `Document.Open(pdf).Split()` returns N
  Documents; each `.Pages.length === 1`; `d.save()` round-trips (reopen yields
  one page with content preserved, e.g. output 2 contains "Page 2"); a
  zero-page document yields `[]`; an xref-stream input splits to one page.
- **`test/page.test.ts`**: remove the `Page.Save`, `Page.Save via index`
  describe blocks and the unused imports (`defaultPrunePolicy`, the
  `api.PageSaveOptions` usage); keep the `Page` view tests and the
  `index exports` re-export check.
- **`test/writer.test.ts`**: update to `writePdf` given a complete object set
  (catalog + pages + page + contents); assert the bytes reparse to one page
  whose page object has `/Type /Page`.
- **`test/node-metadata.test.ts`**, **`document*.test.ts`**, **`metadata.test.ts`**:
  unaffected. `splitPdfFile` continues to pass through the new path (its node
  test, if present, still holds).

## Exports summary

Removed from public API: `splitPdf`, `PageSaveOptions`, `Page.prototype.Save`,
and the `split.js`-sourced `SplitOptions`. Added: `Document.prototype.Split` and
`SplitOptions` (from `document.js`). This is a breaking API change.
