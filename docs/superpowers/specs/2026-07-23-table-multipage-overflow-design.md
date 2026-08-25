# Multi-page overflow / auto-pagination — Design

**Issue:** `aspose-pdf-foss-for-ts-49l.5` (epic `-49l`, Table authoring & rendering)
**Date:** 2026-07-23
**Depends on:** `-49l.4` (page.AddTable rendering + public API), `-49l.3` (styles/borders), both shipped.
**Blocks:** `-49l.6` (repeating header rows on continuation).
**Parity target:** Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go` (`SetOverflowMargins` semantics).

## Goal

When a built table is taller than the space available on a page, continue it onto
following pages. Today `page.AddTable` draws every row top-down from `top` and a
table taller than the page silently overflows the bottom edge (49l.4 non-goal).
This issue adds pagination in two modes selected by a flag:

- **Manual (default):** draw the rows that fit above a bottom line, then return a
  continuation `TableBuilder` (the undrawn rows) the caller can re-draw wherever
  it likes (a new page, another column). Mirrors the overflow-remainder idiom of
  `AddTextBlock`/`layout.ts`.
- **Auto (`autoPaginate: true`):** own page creation — append blank pages sized to
  match the anchor page and keep drawing until the table is exhausted.

## Non-goals (owned by sibling issues)

- **Repeating header rows on continuation pages** — `-49l.6`. This issue draws
  only the rows that overflow; it does not re-emit any header row on new pages.
- **Splitting a single row across a page boundary.** Rows are atomic (decision
  below). A row that will not fit moves whole to the next page.
- **Image cells** — `-49l.7`.
- **New-page furniture** (running headers/footers, page numbers). Auto-appended
  pages are blank except for the table continuation.

## Decisions (from brainstorming)

1. **API shape — both via a flag.** Default returns a remainder (caller-driven);
   `autoPaginate: true` makes `AddTable` own page creation. One return type serves
   both (below).
2. **Atomic rows.** A row is never split across a page boundary. If it will not
   fit above the bottom line it moves whole to the next page. A single row taller
   than a full empty page is **drawn anyway** (and overflows) so pagination always
   makes progress and can never infinite-loop.
3. **Overflow margins via `topMargin` / `bottomMargin`.** The stop line and the
   continuation start line are derived from the page's CropBox and these margins
   (below), matching `SetOverflowMargins` semantics.

## Public API

`tablerender.ts` — `AddTableOptions` gains three optional fields and both
`drawTable` and `Page.AddTable` change their return type from `void` to
`AddTableResult` (a backward-compatible widening — existing callers that ignore
the return value keep working):

```ts
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points. Overrides the table style's `padding`
   *  (default 2). */
  cellPadding?: number;
  /** Append pages (sized to the anchor page) and draw the whole table.
   *  Default false: draw what fits and return the rest as `remainder`. */
  autoPaginate?: boolean;
  /** Stop line, in points above the page's CropBox bottom edge. The table is
   *  drawn only while a row fits above `CropBox.y0 + bottomMargin`.
   *  Non-negative. Default 0 (fill down to the CropBox bottom edge). */
  bottomMargin?: number;
  /** Continuation start, in points below the appended page's CropBox top edge:
   *  each new page starts at `CropBox.y1 - topMargin`. Non-negative.
   *  Default = the anchor page's top inset (`anchor.CropBox.y1 - top`), so equal
   *  sized pages align. Only consulted in auto mode. */
  topMargin?: number;
}

export interface AddTableResult {
  /** Pages the table was drawn onto, in order. Always includes the anchor page.
   *  Length > 1 only in auto mode. */
  pages: Page[];
  /** The y of the bottom edge of the last drawn row on the last page (equals
   *  `top` when nothing was drawn). Useful for placing content below the table. */
  endY: number;
  /** The rows that did not fit, as a re-drawable TableBuilder. Set only in
   *  manual mode when the table overflowed; undefined when everything was drawn
   *  (always undefined in auto mode). Re-draw via `page.AddTable(remainder, …)`. */
  remainder?: TableBuilder;
}
```

- `(x, top)` remains the table's top-left corner in PDF user space (unchanged).
- `index.ts` additionally exports `AddTableResult`.

## Geometry

For a page `p`, let `cb = p.CropBox` (which falls back to MediaBox). Then:

- **Bottom line** on every page: `bottomLine(p) = cb.y0 + bottomMargin`.
- **Continuation start** on an appended page: `contTop(p) = cb.y1 - topMargin`.
- **First page** uses the caller's `top` and `bottomLine(anchor)`.

`topMargin` defaults to `anchor.CropBox.y1 - top` (the anchor's own top inset), so
when appended pages are the same size as the anchor, every continuation row band
lines up with the first page.

Appended pages are created with `doc.AddPage()` and then have their `MediaBox` set
to a **copy of the anchor page's MediaBox**, because `AddPage` otherwise yields a
blank A4 (`595×842`) page that would mismatch a Letter anchor and make the margins
inconsistent. (CropBox is left to inherit from MediaBox, matching `AddPage`.)

## Algorithm (shared core)

Measure once: widths and per-row heights are page-independent because every page
uses the same `width`.

```
widths = table.resolveColumnWidths(opts.width)
if widths.length === 0: return { pages: [anchor], endY: top, remainder: undefined }  // empty table
padding = opts.cellPadding ?? table.defaults.padding ?? 2
{ rowHeights } = table.measure(widths, { cellPadding: padding })
columnX = prefix sums of widths, based at x

page = anchor; pages = [anchor]
currentTop = top
bottomLine = page.CropBox.y0 + bottomMargin
pageStartRow = 0            // first row index drawn on the current page
rowsOnThisPage = 0
i = 0
while i < rows.length:
  h = rowHeights[i]
  fits = currentTop - h >= bottomLine
  if not fits and rowsOnThisPage > 0:
    // page break — atomic row moves whole to the next page
    if autoPaginate:
      paintPage(page, rows[pageStartRow..i), ...)     // flush the current page
      page = appendPageLike(anchor); pages.push(page)
      currentTop = page.CropBox.y1 - topMargin
      bottomLine = page.CropBox.y0 + bottomMargin
      pageStartRow = i; rowsOnThisPage = 0
      continue                                         // retry row i on the new page
    else:
      paintPage(page, rows[pageStartRow..i), ...)      // flush what fit
      return { pages, endY: currentTop, remainder: table.continuationFrom(i) }
  // draw row i on this page (oversized first row falls through here and overflows)
  currentTop -= h
  rowsOnThisPage += 1
  i += 1
paintPage(page, rows[pageStartRow..rows.length), ...)  // flush the last page
return { pages, endY: currentTop, remainder: undefined }
```

`paintPage(page, rowSlice, …)` reproduces 49l.4/49l.3's three-pass paint over just
that page's rows, at that page's row-top positions:

1. **Backgrounds** (a single `PageGraphics`), then
2. **Cell text** via `stampTextBlock` (aligned per resolved style), then
3. **Cell borders + the outer border** (a single `PageGraphics`).

The **outer border is drawn per page**, wrapping that page's drawn block
(`from the page's first row top down to its last row bottom`), not one rectangle
spanning all pages. This is the correct visual for a paginated table and keeps
each page self-contained.

To avoid duplicating the existing placement/paint logic, refactor the body of the
current `drawTable` into two reusable helpers:

- `placeRows(table, rows, rowHeights, rowTops, columnX, widths)` → `Placed[]`
  (x / bottom / w / h / text / resolved style; the colspan cursor walk from
  49l.4).
- `paintPlaced(doc, page, placed, padding, outerBorder?, blockRect?)` → the three
  paint passes plus the optional outer-border rectangle.

The single-page `drawTable` becomes: measure → one `paintPlaced` over all rows.
The paginating path calls the same helpers per page.

## `tableauthor.ts` change

Add an internal continuation constructor so a remainder is a first-class,
re-drawable `TableBuilder` whose column resolution is identical to the original:

```ts
class TableBuilder {
  /** @internal Fixed column count for continuation builders; when set,
   *  overrides the rows-derived count so resolveColumnWidths matches the
   *  original table even if the leftover rows are narrower. */
  private forcedColumnCount?: number;

  /** @internal Build a continuation table of rows [startRow..end): shares
   *  `defaults` and the normalized column specs, carries the original column
   *  count, and holds the same RowBuilder references (never mutated). */
  continuationFrom(startRow: number): TableBuilder;
}
```

`columnCount()` returns `forcedColumnCount ?? <rows-derived count>`. Because the
continuation carries the original `columnSpecs` and column count, calling
`page.AddTable(remainder, x, top, { width, … })` re-runs `resolveColumnWidths(width)`
to the **same** per-column widths as the first page.

## Testing (TDD, vitest — extend `test/table-render.test.ts`)

Uses the existing `build-blank-page.ts` helper plus coordinate text extraction
(`Page.GetTextFragments()`), and adds a Letter/short-page variant as needed. All
expected bands are computed independently from `resolveColumnWidths`/`measure`, not
mirrored from the fragments.

1. **Manual remainder + redraw.** A table taller than the space above
   `bottomMargin` returns a `remainder`; every drawn fragment's baseline is
   `≥ bottomLine`; redrawing the remainder on a fresh page continues from the next
   row and eventually returns no remainder. The union of drawn rows across the two
   calls equals all rows exactly once.
2. **Auto append.** Same tall table with `autoPaginate: true`: `doc.Pages.length`
   grows by the expected count, `result.pages.length` matches, `remainder` is
   undefined, every page has fragments, and `endY` equals the last row's bottom.
3. **Atomic row.** A row positioned to straddle the bottom line is moved whole to
   the next page — all of that row's cell fragments share one page, and the prior
   page's last row bottom is `≥ bottomLine`.
4. **Oversized-row guarantee.** A single row taller than a full empty page is drawn
   (its fragments present) and pagination terminates with a finite, bounded page
   count (no infinite loop).
5. **Continuation page size.** With a Letter anchor (`612×792`), an appended page's
   `MediaBox` equals the anchor's `612×792` (not the `595×842` `AddPage` default).
6. **Column widths stable.** The per-column x-bands on page 2 equal those on page 1.
7. **Empty table.** `createTable()` (no rows) → `{ pages: [anchor], endY: top }`,
   no remainder, no fragments, does not throw, appends no pages.

## Files touched

- **New:** `docs/superpowers/specs/2026-07-23-table-multipage-overflow-design.md`
  (this file), `docs/superpowers/plans/2026-07-23-table-multipage-overflow.md`.
- **Edit:** `src/tablerender.ts` — new options + result type; refactor into
  `placeRows`/`paintPlaced`; add the paginating core.
- **Edit:** `src/tableauthor.ts` — `forcedColumnCount` + `continuationFrom`.
- **Edit:** `src/page.ts` — `AddTable` return type → `AddTableResult`; doc comment.
- **Edit:** `src/index.ts` — export `AddTableResult`.
- **Edit:** `test/table-render.test.ts` — the seven cases above.
- **Edit:** `README.md` — pagination (manual remainder + `autoPaginate`) in the
  table-authoring section; drop the "pagination in progress" caveat.

## Quality gates

`npm run typecheck` and `npm test` green before closing the issue.
