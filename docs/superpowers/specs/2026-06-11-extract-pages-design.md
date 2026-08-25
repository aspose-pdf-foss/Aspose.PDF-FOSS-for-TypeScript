# Document.ExtractPages — Design

**Issue:** aspose-pdf-foss-for-ts-b2p
**Date:** 2026-06-11
**Status:** Approved

## Goal

`Split()` is all-or-nothing: one new single-page `Document` per page. Add a way
to extract an **arbitrary subset** of pages, in a caller-chosen order, into one
new multi-page `Document`:

```ts
ExtractPages(numbers: number[]): Document
```

`ExtractPages([2, 3, 5])` on a 5-page document returns a new 3-page document
whose pages are copies of source pages 2, 3 and 5 — in that order. The source
document is never mutated.

## Semantics

- `numbers` are **1-based** page numbers into `this.Pages`, and output order is
  exactly the order given (like `Reorder`'s `order` argument).
- **Repeats are allowed** and produce duplicate pages in the output
  (`ExtractPages([2, 2])` → a 2-page doc, both copies of page 2). Mirrors
  `Reorder`'s contract.
- **Empty array throws** `RangeError('ExtractPages: numbers must not be empty')`.
  Mirrors `Reorder`.
- Each entry must be an integer in `1 .. Pages.length`; otherwise
  `RangeError('ExtractPages: page number <n> out of range 1..<N>')`. All
  validation runs **before** any copying — a throw allocates nothing.
- The result is **self-contained**: later edits to either document do not affect
  the other. Round-trips through `Save()` → `Open()`.

## Copy strategy — reuse `importPages` with a page subset

The issue sketch suggested looping `extractPage()` and assembling a multi-page
`/Pages` node. We do **not** do that: per-page extraction duplicates shared
resources (one font copy per page) and does not flatten inherited page
attributes — `Split` carries both limitations today.

Instead, generalize the existing whole-document importer:

```ts
// before
private importPages(other: Document, rootNum: number): number[]
// after — defaults preserve every existing caller's behavior
private importPages(other: Document, rootNum: number, pages: Page[] = other.Pages): number[]
```

The leaf loop iterates `pages` instead of `other.Pages`; nothing else changes.
This buys, for free:

- **Shared-object de-duplication** — one `newNumByOld` map across all selected
  pages, so a font/XObject shared by pages 2 and 3 is copied once.
- **Inheritance flattening** — `MediaBox` / `CropBox` / `Resources` / `Rotate`
  inherited from `other`'s intermediate `/Pages` nodes are copied onto each
  leaf before `/Parent` is cut (something `Split`'s `extractPage` path loses).
- **Annotation sanitization** via `defaultPrunePolicy()` (drop `/Parent`, `/B`,
  `/StructParents`; strip annot `/P`, same-doc GoTo, `/Dest`).
- **Repeats** work naturally: each leaf is a fresh `new Map(src)` clone with its
  own object number, while the shared subtree behind it is deduped.

## In-memory effect

`ExtractPages(numbers)`:

1. Validate `numbers` (non-empty; every entry an integer in `1..N`) —
   `RangeError` before any work.
2. `const out = Document.createEmptyDocument();` (catalog obj 1, empty indirect
   `/Pages` root obj 2 — same accumulator `Merge` uses).
3. `const selected = numbers.map((n) => this.Pages[n - 1]);`
4. `const newNums = out.importPages(this, /* rootNum */ 2, selected);`
5. `out.syncPages(newNums.map((num) => ref(num)));`
6. `return out;`

The source document has **no structural precondition** — only its page leaves
are read (`importPages` reads via `Page.Dict`, never the source `/Pages` node),
so a source with an inline `/Pages` dict still extracts fine. The target is
freshly built and always satisfies `requireIndirectPagesRoot`.

## Persistence effect

No serializer changes. The returned document's `Save()` mark-sweeps from
`/Root`, renumbers `1..N`, and emits a classic xref — identical to every other
assembled document (`Split`, `Merge`).

## API

In `src/document.ts`:

```ts
/** Copy the given 1-based pages into a new self-contained Document, in the
 *  order given (repeats allowed, like Reorder). Shared resources are copied
 *  once; inherited page attributes are flattened onto each page. Throws
 *  RangeError on an empty array or any non-integer/out-of-range entry. This
 *  document is not modified. */
ExtractPages(numbers: number[]): Document
```

`Document` is already exported from `src/index.ts`; no new top-level export.

## Scope

In scope:
- `Document.ExtractPages(numbers: number[]): Document`.
- Widening `importPages` with an optional `pages` subset parameter (private;
  all callers are inside `document.ts`).

Out of scope (YAGNI):
- Range options on `Split` — `ExtractPages` covers the use case; `Split`'s
  contract is unchanged.
- A `node.ts` file-path convenience wrapper.
- Carrying over document-level structures (outlines, AcroForm, `/Names`,
  metadata) — same accepted limitation as `Split` / `Merge`.

## Known limitations (accepted)

Same as every existing copy path: extracted pages lose same-document GoTo
destinations, `/Dest`, annotation `/P`, and `/B` / `/StructParents`.

## Testing (TDD, Vitest)

New `test/extract-pages.test.ts` (reuse `buildClassicPdf` helper):

- **Order:** `ExtractPages([2, 3, 5])` on a 5-page doc → 3 pages whose
  `Contents` match source pages 2, 3, 5 in that order.
- **Single page:** `ExtractPages([4])` → 1-page doc matching source page 4.
- **Repeats:** `ExtractPages([2, 2])` → 2 pages, both matching source page 2,
  backed by distinct objects (mutating one copy does not affect the other).
- **Full-range identity:** `ExtractPages([1..N])` → page count and contents
  equal to the source.
- **Validation:** `[]`, `[0]`, `[N + 1]`, `[1.5]` each throw `RangeError`;
  source unchanged after the throw.
- **Source untouched:** after a successful extract, source `Pages.length` and
  contents are intact; editing the extracted doc does not affect the source.
- **Round-trip:** `ExtractPages(...).Save()` → `Open()` re-reads the right
  page count and contents.
- **Shared-resource dedup:** two selected pages sharing one font ref → exactly
  one copy of that resource in the saved output.
- **Inheritance flatten:** source with `MediaBox` on the `/Pages` root →
  extracted pages report that `MediaBox`.
- **Regression:** existing `Merge` / `Append` / `InsertPages` tests stay green
  (they exercise the widened `importPages` default).
