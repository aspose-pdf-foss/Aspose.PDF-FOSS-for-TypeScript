# Table: Repeating header rows on continuation (49l.6)

**Issue:** aspose-pdf-foss-for-ts-49l.6 (epic 49l — Table authoring & rendering)
**Depends on:** 49l.5 (multi-page overflow / auto-pagination), shipped.
**Date:** 2026-07-23

## Goal

`SetRepeatingRowsCount(N)`: repeat the first N rows of a built table at the top
of every *continuation* page. Parity with Aspose's `Table.RepeatingRowsCount`
and the Go feature showcase. On page 1 the header rows appear naturally (they are
rows `0..N-1`); on every subsequent page they are reprinted at the top, inside
that page's block (one outer border per page).

## API

One chainable method on `TableBuilder`, mirroring `setColumnWidths`:

```ts
table.setRepeatingRowsCount(n: number): this
```

- `n` is a non-negative integer; default `0` (no repeat). Validated in the setter
  as a non-negative integer.
- Like `setColumnWidths`, the relationship of `n` to the actual row count is
  resolved at **draw time** (rows may be added after the setter runs). The
  effective header count is `N = min(n, rowCount)`.
- Stored as a private `_repeatingRows` field with an internal getter
  (`get repeatingRowCount(): number`) consumed by the renderer.

## Semantics

- Rows `[0, N)` are the header.
- Page 1: unchanged — the header rows are ordinary leading rows.
- Every continuation page: header rows `[0, N)` are reprinted at the top and
  share the same page-block (a single outer border) with that page's body rows.

## `continuationFrom` — manual-mode remainder (headers embedded)

Manual mode (`autoPaginate: false`) returns a re-drawable `remainder`
(`continuationFrom(startRow)`). The chosen behavior embeds the header into the
remainder so re-drawing it anywhere reprints the header and further splits keep
composing:

- When `N > 0`, `continuationFrom(startRow)` returns a table whose rows are
  `headers[0, N)` ++ `rows[max(startRow, N)..end)`, and it carries
  `_repeatingRows = N` forward.
- Because the continuation's own first N rows *are* the headers, re-drawing it
  reprints the header naturally, and a further split via `continuationFrom` again
  prepends them — fully composable across repeated manual re-draws.
- `max(startRow, N)` avoids duplicating header rows in the body when page 1 could
  not fit all N header rows (pathological tall-header case): the undrawn header
  rows are still shown, but only once, via the header prefix.
- `forcedColumnCount` and `columnSpecs` are already carried forward, so per-column
  widths stay identical across pages.

## `drawTable` — auto-mode loop

- **Generalize placement to a row-index list.** `placeRows` / the per-page paint
  helper take an explicit ordered list of row indices instead of a contiguous
  `[start, end)` range. This lets a continuation page paint `[0..N)` ++
  `[bodyStart..i)` as one block with a single outer border rectangle.
- **Page 1:** unchanged — iterate all rows from 0; the header rows are ordinary
  rows and receive no special treatment.
- **Each appended page:** seed `usedHeight = Σ rowHeights[0..N)` (the header cost)
  and prepend the header indices when painting the page. On a continuation page
  `bodyStart = max(i, N)` where `i` is the row that spilled.
- **Progress guarantee:** the existing rule "the first row placed on a page is
  drawn even if it overflows the bottom line" (`rowsOnThisPage > 0` guard) then
  applies to the first *body* row. At least one body row is placed per
  continuation page, so page-appending always terminates — no infinite loop even
  if header + one body row exceed a page.

## Edge cases

- `N = 0` → today's behavior exactly (regression-tested).
- `N >= rowCount` → clamp to `rowCount`; the body range is empty; the table draws
  once with no continuation.
- Header rows may carry `colSpan`, per-cell/row styles, and backgrounds; they flow
  through the same place/paint path as any row.
- Column widths stay identical across pages (already handled by
  `continuationFrom` carrying `forcedColumnCount` + `columnSpecs`).

## Tests (vitest, programmatic fixtures)

- **Auto, N=1 and N=2:** tall content over a short page appends pages; assert the
  header text recurs exactly once per page via per-page `GetText`
  (occurrence count == page count).
- **Manual:** draw once, assert `remainder.rows[0]` is the header row; re-draw the
  remainder on a fresh page and assert the header is reprinted; assert a further
  split still prepends the header.
- **Outer border per page** includes the header block.
- **colSpan header row** renders across the spanned columns on every page.
- **N = 0 regression:** identical output to no call.
- **Validation:** `setRepeatingRowsCount` rejects negatives, non-integers, and
  non-finite values.

## Docs

Add `setRepeatingRowsCount` to the table section of `README.md`.
