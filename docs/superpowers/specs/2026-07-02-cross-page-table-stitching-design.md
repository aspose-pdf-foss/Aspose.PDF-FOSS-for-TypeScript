# Cross-page table stitching — design

Issue: `aspose-pdf-foss-for-ts-7ac` (follow-up to `7y8`). Table extraction is
per-page today: `page.GetTables()` returns `Table[]` whose `quad`s are
page-space. A logical table broken by a page break is returned as two unrelated
tables. This adds a document-level pass that stitches a table's continuation on
the next page back into one logical `Table`.

## Goals

- Detect that a table on page N+1 is a continuation of one on page N and merge
  them into a single `Table` with the rows concatenated.
- Handle repeated header rows (drop the duplicate on the follower).
- Handle chains longer than two pages.
- Keep the per-page `page.GetTables()` API and behavior unchanged.

## Non-goals

- Borderless-table continuation beyond what per-page extraction already finds.
- Reflow / merge of spanning cells across the page seam.
- Continuations whose column count changes across the break.
- Rotated / skewed tables (tracked separately: `5ct`).

## API surface

Two entry points (a pure engine plus an ergonomic wrapper), matching the
codebase's "pure function + facade method" pattern.

### Pure core — `src/tablestitch.ts`

```ts
export interface TableStitchOptions { stitch?: boolean; } // default true
export function stitchTables(perPage: Table[][], options?: TableStitchOptions): Table[];
```

- `perPage[i]` is the `Table[]` for page `i` (as produced by `extractTables`).
- Pure: no I/O, no throws.
- `stitch === false` returns the flat concatenation `perPage.flat()` unchanged.

### Wrapper — `Document.GetTables`

```ts
GetTables(options?: TableExtractOptions & TableStitchOptions): Table[] {
  return stitchTables(this.Pages.map((p) => p.GetTables(options)), options);
}
```

`page.GetTables()` is untouched.

## Model change

Add an optional field to `Table` (constructor optional param, mirroring
`summary`):

```ts
/** For a stitched table: the contributing page rectangles, in page order.
 *  Absent for a single-page (non-stitched) table. */
pageSpans?: { page: number; quad: Rect }[];
```

- `Table.quad` remains the **leader** (first-page) table's quad.
- Cell `quad`s remain page-space (unchanged, page-local).
- A single-page table has `pageSpans === undefined`, preserving current output.

## Algorithm

Walk pages in order maintaining a set of **open chains**. A chain is an ordered
list of `{ page, table }`; its **tail** is the most recently appended table.

For page `N` (N ≥ 1), process that page's tables in reading order (top→bottom):

1. For each table `T` on page `N`, find the first still-open chain whose tail
   has a **matching signature** with `T` (below) and is anchored on page `N-1`.
   If found, append `T` (after header-drop) and mark the chain's anchor page
   `= N`. Otherwise `T` starts a new chain.
2. After the page, any chain whose anchor page is still `N-1` **closes** (it did
   not extend to `N`, so a gap page or absent continuation breaks it).

At the end, every chain (open or closed) is emitted.

### Signature match

Two tables have matching signatures when:

- `colCount` is equal, AND
- their column x-cut positions align pairwise within `STITCH_TOL` (a few points;
  pages are assumed the same width so column x is comparable across pages).

Column x-cuts are the sorted unique vertical-boundary positions already implied
by each table's cell `quad`s (leftmost cell edges per column plus the right
edge). `STITCH_TOL` is a small absolute tolerance (initial value ~3 pt; tune
against fixtures).

### Repeated-header drop

When appending a follower `T` to a chain, compare `T`'s row 0 to the chain's
row 0 (the header). If, for every column, the trimmed cell text is equal, drop
`T`'s row 0 before appending. A partial match leaves row 0 as data.

### Emit

For a chain of length 1: emit the single table unchanged (no `pageSpans`).

For a chain of length ≥ 2, build one `Table`:

- `rows`: concatenation of every member's rows (after header-drop), with each
  cell's `row` index renumbered contiguously from 0 and `TableRow`/cell `quad`s
  left page-local.
- `rowCount`: total emitted rows; `colCount`: unchanged (equal across members).
- `quad`: the leader's quad.
- `pageSpans`: `[{ page, quad }]` for every contributing member, in page order.

Output order: chains in leader first-appearance order (page, then top→bottom
within the leader's page). Deterministic.

## Edge cases

- Empty input, or all single-page tables → flat list unchanged, no `pageSpans`.
- Page with no tables → contributes nothing; open chains anchored on the prior
  page close (gap breaks a chain).
- `colCount` mismatch or misaligned columns → no stitch; both tables kept.
- Ambiguous pairing (two open chains share a signature, or a page has two
  matching tables): first-match in reading order wins. Rare; documented.
- A non-tail table on an earlier page being the true continuation is not
  handled (only chain tails extend). Rare; documented limitation.

## Testing

`test/table-stitch.test.ts` — pure engine, constructing `Table[][]` directly
(no PDF needed):

- two-page continuation, aligned columns, no header → one table, rows
  concatenated, `pageSpans.length === 2`.
- repeated-header drop → follower row 0 removed; row indices contiguous.
- three-page chain → `pageSpans.length === 3`.
- `colCount` mismatch → not stitched (2 tables out).
- misaligned columns (beyond `STITCH_TOL`) → not stitched.
- gap page (no table between) breaks the chain → two separate tables.
- `stitch: false` → flat pass-through.

`test/table.test.ts` (or a new integration test) — end-to-end via
`Document.GetTables()` with a real 2-page PDF fixture (extend
`build-table-pdf.ts` to emit two pages) proving stitching through the wrapper.

Regression: existing `page.GetTables()` behavior unchanged; single-page tables
keep `pageSpans === undefined`.

## Files touched

- `src/tablemodel.ts` — add `pageSpans?` to `Table`.
- `src/tablestitch.ts` — new: `stitchTables` + signature/header/emit helpers.
- `src/document.ts` — add `Document.GetTables`.
- `src/index.ts` — export `stitchTables`, `TableStitchOptions`.
- `test/table-stitch.test.ts` — new engine tests.
- `test/helpers/build-table-pdf.ts` — 2-page fixture helper for the integration test.
- `README.md` — document `Document.GetTables` and stitching in the tables section
  and limitations.
