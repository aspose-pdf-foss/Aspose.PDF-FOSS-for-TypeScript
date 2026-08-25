# page.AddTable rendering + public API — Design

**Issue:** `aspose-pdf-foss-for-ts-49l.4` (epic `-49l`, Table authoring & rendering)
**Date:** 2026-07-23
**Depends on:** `-49l.1` (core model + measurement) and `-49l.2` (column widths + colspan), both shipped.
**Blocks:** `-49l.3` (styles — layered onto this renderer next), `-49l.5` (overflow), `-49l.7` (image cells).
**Parity target:** Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go` (`page.AddTable`).

## Sequencing note

The epic originally listed 49l.3 (borders/styles) before 49l.4 (rendering). We
reordered: a style is only observable once there is a renderer to draw it, so
49l.4 lands the rendering substrate first and 49l.3 layers borders, fills, and
alignment onto both the model and this renderer. `bd` records `49l.4 blocks
49l.3`.

## Goal

Add the public **`page.AddTable`**: lay out a built table (from `createTable` +
49l.1/49l.2) at a page position and draw its cell text into the page's
`/Contents`. This is the first user-visible table feature.

Scope is deliberately a **text-only MVP**: it positions and draws each cell's
text at the model's measured geometry. Borders, background fills, and
horizontal/vertical alignment are 49l.3; multi-page overflow is 49l.5. This
keeps 49l.4 a clean, testable substrate the styling issue extends.

## Non-goals (owned by sibling issues)

- **No borders / fills / H-V alignment** — 49l.3. Cell text is drawn left/top.
- **No pagination.** A table taller than the page overflows the bottom edge;
  splitting across pages is 49l.5. `AddTable` returns `void`; a
  height/overflow-continuation return is introduced by 49l.5 when pagination
  needs it.
- **No image cells** — 49l.7.
- **No shaping in cell text.** Same limitation as 49l.1's `measure`: the model
  wraps with the plain (unshaped) driver, so a shaped embedded font could wrap
  differently than measured. MVP cells are Standard-14 or unshaped embedded
  fonts.

## Module & public API

New file **`src/tablerender.ts`** (kept separate from the model in
`tableauthor.ts`, mirroring how `stamp.ts` / `imageembed.ts` sit apart from the
builders they draw):

```ts
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points. Default 2 (matches measure()). */
  cellPadding?: number;
}

export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): void;
```

- **`Page.AddTable(table, x, top, opts)`** — PascalCase facade (matches
  `AddText`/`AddImage`/`AddBarcode`), delegates to `drawTable`. Returns `void`.
- `(x, top)` is the table's **top-left corner** in PDF user space. The table
  extends right by `width` and downward (rows stack toward smaller `y`).
- `index.ts` exports the `AddTableOptions` type.

### One additive change to `tableauthor.ts`

The renderer needs each cell's fully-resolved text style — including `color`,
which the model's `ResolvedStyle` currently omits (measurement ignores color).
Extend it and export the cascade so the renderer reuses the exact
`cellOption ?? tableDefault ?? builtin` resolution instead of duplicating it:

```ts
// tableauthor.ts — ResolvedStyle gains `color`; resolveStyle is renamed/exported:
export interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
  color: [number, number, number];
}
export function resolveCellStyle(cell: CellBuilder, d: TableDefaults): ResolvedStyle;
```

Built-in `color` default is `[0, 0, 0]` (matches the spec's stated defaults). The
existing `measure()` call site keeps working (it just ignores the new field).

## Layout & drawing algorithm

`drawTable(doc, page, table, x, top, opts)`:

1. `widths = table.resolveColumnWidths(opts.width)`;
   `padding = opts.cellPadding ?? 2`;
   `{ rowHeights } = table.measure(widths, { cellPadding: padding })`.
   If `widths.length === 0` (empty table) → return (no-op).
2. Column left edges by prefix sum: `columnX[c] = x + Σ widths[0..c)`.
3. Row top edges by prefix sum: `rowTop[0] = top`,
   `rowTop[r] = top − Σ rowHeights[0..r)`.
4. For each row `r`, walk its cells with a physical-column cursor `c`
   (identical to `measure`'s walk):
   - `span = cell.colSpan`; `cellX = columnX[c]`;
     `cellW = Σ widths[c .. c+span)`.
   - `st = resolveCellStyle(cell, table.defaults)`.
   - Draw with the existing block-text engine `stampTextBlock` (the same
     free-function layer `stampText`/`addImage` live at; `page.AddTextBlock`
     wraps it), which is why `drawTable` takes `doc`:
     ```ts
     stampTextBlock(doc, page, cell.text,
       [cellX + padding, rowTop[r] − rowHeights[r] + padding,
        cellW − 2*padding, rowHeights[r] − 2*padding],
       { font: st.font, fontSize: st.fontSize, leading: st.leading,
         color: st.color, align: 'left', valign: 'top' });
     ```
   - `c += span`.

Because the `stampTextBlock` box width equals the inner width `measure` wrapped
to (`cellW − 2*padding`) and the font/size/leading match, the wrap is identical
and every line fits the box height (`rowHeights[r] − 2*padding ≥ that cell's
lineCount*leading`) — no clipping. `stampTextBlock` handles font registration and
`/Contents` splicing internally, so `drawTable` adds no extra plumbing.

## Testing (TDD, vitest — `test/table-render.test.ts`)

A `test/helpers` fixture builder plus **coordinate text extraction**
(`Page.GetTextFragments()` → `TextFragment.quad = [x0,y0,x1,y1]`, x0 = text
left, y0 = baseline, y1 = baseline+size) for load-bearing position assertions.

- **New helper** `test/helpers/build-blank-page.ts`: assembles a single blank
  letter-size page (`MediaBox [0 0 612 792]`, empty `/Contents`, no fonts) as raw
  classic-xref bytes — same pattern as `build-stamp-target.ts`. Returns
  `Uint8Array` for `Document.Open`.

Tests:

1. **Grid placement.** A 2×2 table drawn at `(72, 720)` with `width: 400`,
   equal columns. Extract fragments; assert each cell's text `x0` lies in its
   column band `[columnX[c], columnX[c]+widths[c]]` and its `y0` (baseline) lies
   within its row band `[rowTop[r]−rowHeights[r], rowTop[r]]`. Compute the
   expected bands independently from `resolveColumnWidths` / `measure` (not from
   the fragments), so the test checks placement rather than mirroring it.
2. **Colspan.** A header cell with `colSpan: 2` over a two-column body: the
   header text starts near the table's left edge (`x0 ≈ x + padding`) and its
   available width is the full table width, while the body cells sit in their own
   column bands.
3. **Row stacking + variable height.** A table whose first-row cell wraps to two
   lines places row 1 lower (smaller `y`) than the same table with single-line
   first row — i.e. the taller measured row pushes the next row down. Assert the
   row-1 baseline `y` differs by ~one `leading`.
4. **Empty table is a no-op.** `createTable()` (no rows) drawn on a blank page
   leaves `GetTextFragments()` empty and does not throw.

## Files touched

- **New:** `src/tablerender.ts`, `test/table-render.test.ts`,
  `test/helpers/build-blank-page.ts`.
- **Edit:** `src/tableauthor.ts` (extend `ResolvedStyle` with `color`; export
  `resolveCellStyle`).
- **Edit:** `src/page.ts` (add `AddTable`).
- **Edit:** `src/index.ts` (export `AddTableOptions`).
- **Edit:** `README.md` — **now add** the user-facing table-authoring feature
  entry (deferred through 49l.1–49l.3): a Quick-start snippet
  (`createTable` → `page.AddTable`) and a note in Features that borders/styles
  and pagination are in progress.

## Quality gates

`npm run typecheck` and `npm test` green before closing the issue.
