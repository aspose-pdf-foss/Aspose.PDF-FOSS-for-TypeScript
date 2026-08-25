# Borders, margins, and cell/row/table styles — Design

**Issue:** `aspose-pdf-foss-for-ts-49l.3` (epic `-49l`, Table authoring & rendering)
**Date:** 2026-07-23
**Depends on:** `-49l.1` (core model), `-49l.2` (widths + colspan), `-49l.4` (`page.AddTable` renderer) — all shipped.
**Parity target:** Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go` (table `BorderInfo`, cell styles, backgrounds, alignment).

## Goal

Layer visual styling onto the table renderer: cell/table **borders**, **background
fills**, **horizontal & vertical text alignment**, and a **table → row → cell
style cascade**, with cell **padding** promoted from a `measure`/`AddTable`
parameter into the table style.

Additive to the shipped model (`tableauthor.ts`) and renderer (`tablerender.ts`);
49l.1/49l.2/49l.4 behavior is preserved.

## Decisions (from brainstorming)

- **Cascade levels:** table → row → cell. Each style field resolves
  `cell ?? row ?? table ?? built-in`.
- **Border model:** a uniform `BorderInfo` per level applies to all four sides of
  a cell (the grid); a separate table **outer border** frames the whole table.
  No per-side control.
- **Geometry:** borders are **zero-thickness** for layout (drawn on the cell
  boundary, they don't shrink content). Padding is a single **table-level** value
  (moved into the style; `cellPadding` param still honored for back-compat).

## Style model (`tableauthor.ts`, additive)

```ts
/** A cell/table border: stroke width (pt), RGB colour (0..1), optional dash. */
export interface BorderInfo {
  width: number;
  color: [number, number, number];
  dash?: number[];
}
```

Extend the existing cascadable option type (so `CellOptions` and the row-style
param inherit the new fields):

```ts
export interface CellTextOptions {
  font?: AuthoringFont;              // existing
  fontSize?: number;                 // existing
  leading?: number;                  // existing
  color?: [number, number, number];  // existing (text colour)
  align?: 'left' | 'center' | 'right';       // NEW horizontal alignment
  valign?: 'top' | 'center' | 'bottom';      // NEW vertical alignment
  border?: BorderInfo;                        // NEW all-4-sides cell border
  background?: [number, number, number];      // NEW cell background fill
}

// TableDefaults now extends the cascadable fields and adds table-only ones:
export interface TableDefaults extends CellTextOptions {
  padding?: number;         // NEW default cell padding (pt). Default 2.
  outerBorder?: BorderInfo; // NEW border around the whole table
}
```

`CellOptions` (`= CellTextOptions & { colSpan? }`) automatically gains the new
fields. The **row style** reuses `CellTextOptions`.

### Builders

- **`RowBuilder`** gains `readonly style: CellTextOptions` (default `{}`).
- **`addRow(cells?: string[], style?: CellTextOptions): RowBuilder`** — the
  optional 2nd arg sets the row style. Backward compatible (existing
  single-arg calls unchanged). The `string[]` shorthand cells inherit row+table
  styles via the cascade.
- **`addCell`** already takes `CellOptions`; the new fields flow through with no
  signature change. Validation extends `validateStyleOpts` to check `align`
  (`left|center|right`), `valign` (`top|center|bottom`), `border`
  (`width` positive finite, `color` a valid RGB, `dash?` non-negative finite
  numbers), and `background` (valid RGB); `TableDefaults` also validates
  `padding` (non-negative finite) and `outerBorder`.

## Resolved style & cascade

Extend `ResolvedStyle` and change `resolveCellStyle` to a three-level cascade:

```ts
export interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
  color: [number, number, number];
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'bottom';
  border?: BorderInfo;                    // undefined = no border
  background?: [number, number, number];  // undefined = no fill
}

export function resolveCellStyle(
  cell: CellBuilder, row: CellTextOptions, table: TableDefaults,
): ResolvedStyle;
```

Each field = `cell.options.X ?? row.X ?? table.X ?? builtin`. Built-ins:
`font 'Helvetica'`, `fontSize 12`, `leading 1.2*fontSize`, `color [0,0,0]`,
`align 'left'`, `valign 'top'`, `border`/`background` **undefined**.

The `measure()` call site changes from `resolveCellStyle(cell, this.defaults)` to
`resolveCellStyle(cell, row.style, this.defaults)` (it already iterates rows).
`measure` reads only `font/fontSize/leading` — alignment, border, and background
don't affect measured size.

## Geometry (measurement)

The only change: **padding source**. `measure(columnWidths, opts?)` and
`AddTable(..., opts)` resolve `padding = opts.cellPadding ?? table.defaults.padding
?? 2`. The `cellPadding` option keeps precedence so existing 49l.1/49l.2/49l.4
callers and tests are unchanged. Inner widths and row heights are otherwise
identical; borders add no layout thickness; alignment positions text within the
existing cell box.

## Rendering (`tablerender.ts`) — z-order fills → text → borders

`drawTable` computes each cell's rect and resolved style once into a `placed`
list (`{ x, bottom, w, h, text, style }`), reusing the existing colspan
cursor walk, then paints in three appended passes so paint order is correct:

1. **Backgrounds (bottom).** A `PageGraphics` batch: for each placed cell with a
   resolved `background`, `setFillColor` + `rect(x, bottom, w, h)` + `fill`.
   `apply()`. (Cells tile with no gaps, so per-cell fill of the cascaded colour
   reproduces row/table backgrounds.)
2. **Text (middle).** `stampTextBlock` per cell into
   `[x+padding, bottom+padding, w-2*padding, h-2*padding]`, now passing
   `align: style.align, valign: style.valign` (the engine already supports both).
3. **Borders (top).** A second `PageGraphics` batch: for each placed cell with a
   resolved `border`, `setLineWidth`/`setStrokeColor`/(`setDash` if `dash`) +
   `rect(x, bottom, w, h)` + `stroke`; then, if `table.defaults.outerBorder` is
   set, one stroked rect around the whole table `(x, tableBottom, width,
   Σ rowHeights)`. `apply()`.

`AddTableOptions.cellPadding` becomes optional (falls back to the style). No new
public `AddTable` parameters — styling rides on the table model.

## Non-goals

Per-side borders; per-cell padding; cell margins distinct from padding; rowspan;
pagination (49l.5). Adjacent cells' shared edges are stroked twice (identical
line) — accepted.

## Testing (TDD — `test/table-render.test.ts` + `test/table-author.test.ts`)

Load-bearing assertions via public extraction APIs. **`page.GetPaths()`** returns
`PagePath[]` with `fill`/`stroke` as `{ rgb, space }` where **`rgb` is 0..255**
(red = `[255,0,0]`), plus `bbox [x0,y0,x1,y1]`, `lineWidth`, and
`subpaths[].closed`. `page.GetTextFragments()` gives text positions.

Model tests (`table-author.test.ts`):
1. **Cascade.** `resolveCellStyle` with table/row/cell each setting a different
   `background`/`align` resolves `cell ?? row ?? table ?? builtin` correctly,
   including a cell that inherits from the row and a row that inherits from the
   table.
2. **Style validation.** Bad `align`, `valign`, `border.width <= 0`, malformed
   `border.color`/`background`, and negative `padding` each throw `TypeError`.

Render tests (`table-render.test.ts`), each on a blank page via `buildBlankPage`:
3. **Background fill.** A cell with `background: [1,0,0]` produces a filled path
   (`fill.space === 'DeviceRGB'`, `fill.rgb === [255,0,0]`) whose `bbox` matches
   the cell rect.
4. **Cascade fill colours.** Table `background` gray, one row `background` blue,
   one cell `background` red → three filled rects with the three expected
   `fill.rgb` triples (each `Math.round(c*255)`).
5. **Cell border (grid).** A table with a cell `border: { width: 0.75, color:
   [0,0,0] }` produces stroked closed rects with `lineWidth ≈ 0.75` and
   `stroke.rgb === [0,0,0]` at each cell's `bbox`.
6. **Outer border.** `outerBorder` produces one stroked rect whose `bbox` spans
   the whole table `(x .. x+width, tableBottom .. top)`.
7. **Horizontal alignment.** The same cell text with `align: 'left'` vs
   `'center'` vs `'right'` yields increasing `GetTextFragments` `quad[0]` (left <
   center < right), computed against the cell box independently.
8. **Padding from style.** A table with `padding: 10` shifts a left-aligned
   cell's text `quad[0]` right by ~8 pt relative to `padding: 2` (Δ ≈ 8).

## Files touched

- **Edit:** `src/tableauthor.ts` (`BorderInfo`; extend `CellTextOptions`/
  `TableDefaults`/`ResolvedStyle`; three-level `resolveCellStyle`; `RowBuilder.style`
  + `addRow` style arg; padding-from-style in `measure`; extended validation).
- **Edit:** `src/tablerender.ts` (three-pass fills/text/borders; `cellPadding`
  optional).
- **Edit:** `src/index.ts` (export `BorderInfo`).
- **Edit:** `README.md` — update the Tables section: note borders, fills, and
  alignment now work; remove them from the "in progress" list (pagination
  remains).

## Quality gates

`npm run typecheck` and `npm test` green before closing the issue.
