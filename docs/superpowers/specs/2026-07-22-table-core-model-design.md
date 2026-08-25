# Table core model + cell/row builders + measurement — Design

**Issue:** `aspose-pdf-foss-for-ts-49l.1` (epic `-49l`, Table authoring & rendering)
**Date:** 2026-07-22
**Parity target:** Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go`
(`pdf.NewTable` + row/cell builders).

## Goal

Provide the foundational, page-independent **table authoring model**: build a
table from rows and cells, and measure its natural laid-out height given
resolved column widths. This is the base the rest of the epic extends —
rendering (`-49l.4`), column-width resolution + colspan (`-49l.2`), borders /
backgrounds / styles (`-49l.3`), overflow (`-49l.5`), repeating headers
(`-49l.6`), image cells (`-49l.7`).

The library already exposes an unrelated `Table` (the **extraction** model from
`table.ts`), and `TableCell` / `TableRow` types from the same module. The
authoring types therefore use distinct names.

## Non-goals (owned by sibling issues)

- **No rendering.** The model never references a `Page`/`Document` or `/Contents`.
  Rendering is `-49l.4` (`page.AddTable`), which calls `measure()` and emits via
  `PageGraphics` + `AddTextBlock`.
- **No column-width resolution / colspan.** `measure()` receives already-resolved
  widths. The fluent `setColumnWidths()` and colspan cell→column mapping are
  `-49l.2`.
- **No borders / backgrounds / alignment / fluent margins.** That is `-49l.3`.
  `cellPadding` here is a plain numeric input with a default that `-49l.3`'s
  margin setter will feed.
- **No image cells.** That is `-49l.7`.

Interfaces are chosen so each sibling is **additive**: new setter methods on the
same classes and a richer cell→column mapping in `measure()`, not a rewrite.

## Module & public API

New file `src/tableauthor.ts` (kept clear of extraction `table.ts` /
`tablemodel.ts`). Public exports (added to `index.ts`):

- `createTable(opts?: TableDefaults): TableBuilder` — factory (mirrors Go
  `NewTable()`; matches this lib's free-function style: `makeQr`,
  `extractTables`).
- `class TableBuilder` — the table: ordered rows + table-level text defaults.
- `class RowBuilder` — one row: ordered cells.
- `class CellBuilder` — one cell: a text string + optional per-cell font
  overrides.
- `interface TableDefaults` — `{ font?, fontSize?, leading?, color? }`.
- `interface CellTextOptions` — `{ font?, fontSize?, leading?, color? }`
  (per-cell overrides; each falls back to the table default).
- `interface TableMetrics` — measurement result (below).

Method naming is **camelCase**, matching the existing `PageGraphics` builder
(`page.AddTable` at the facade layer stays PascalCase, added in `-49l.4`).

### Builder API (chainable)

```ts
const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
t.addRow(['Name', 'Qty', 'Price']);          // shorthand: string[] -> text cells
const r = t.addRow();                         // or build cell-by-cell
r.addCell('Widget', { font: 'Helvetica-Bold' });
r.addCell('3');
t.rows;   // readonly RowBuilder[]
r.cells;  // readonly CellBuilder[]
```

- `TableBuilder.addRow(cells?: string[]): RowBuilder` — appends a row; with a
  `string[]`, appends one text cell per entry. Returns the new row.
- `RowBuilder.addCell(text?: string, opts?: CellTextOptions): CellBuilder` —
  appends a cell (default text `''`). Returns the new cell.
- `TableBuilder.rows`, `RowBuilder.cells` — read-back accessors.
- Font handling reuses `AuthoringFont`, `validateFont`, and `driverFor` from
  `stamp.ts` (12 Latin Standard-14 faces or an `EmbeddedFont` handle). Invalid
  fonts throw `TypeError` at set time.

### Defaults

Resolved per cell as `cellOption ?? tableDefault ?? builtIn`, with built-ins:
`font = 'Helvetica'`, `fontSize = 12`, `leading = 1.2 * fontSize`, `color =
[0,0,0]`. `leading` defaults relative to the **resolved** font size.

## Measurement

Column-width *resolution* is `-49l.2`, so measurement takes resolved widths as
input:

```ts
t.measure(columnWidths: number[], opts?: { cellPadding?: number }): TableMetrics
```

```ts
interface TableMetrics {
  rowHeights: number[];      // per-row laid height, points
  totalHeight: number;       // sum of rowHeights
  cellLines: string[][][];   // cellLines[row][col] = wrapped lines of that cell
}
```

### Algorithm

For each cell in column `i` (this issue: cell `i` maps to column `i`; no spans):

1. `width = columnWidths[i] - 2 * cellPadding`.
2. Wrap the cell's text with the existing engine:
   `layoutText(text, driverFor(font), fontSize, width, Infinity, leading)`.
   Height is `Infinity` so no lines are dropped; take `result.lines`.
3. `lineCount = max(1, result.lines.length)` — an empty cell still occupies one
   line's height (so a blank cell does not collapse a row).
4. `cellHeight = lineCount * leading + 2 * cellPadding`.

Then `rowHeights[r] = max(cellHeight over the row's cells)`, and
`totalHeight = sum(rowHeights)`. An empty table yields
`{ rowHeights: [], totalHeight: 0, cellLines: [] }`.

`cellPadding` defaults to `2` (points) so geometry is already correct before
`-49l.3` wires the fluent margin setter, which will override this input.

**Validation.** `columnWidths.length` must be `>= ` the widest row's cell count;
each width must be a positive finite number; `cellPadding >= 0` finite. Violations
throw `TypeError`.

### Why measurement lives on the model

The renderer (`-49l.4`), overflow (`-49l.5`), and repeating-header (`-49l.6`)
paths all need the same laid geometry. Owning measurement on the model gives them
one source of truth; measuring inside the renderer instead would duplicate the
wrap logic across those paths. Chosen: model-owned measurement.

## Testing (TDD, vitest — `test/table-author.test.ts`)

Pure model; no page fixtures.

1. **Builder shape** — `createTable`; `addRow(['a','b'])` shorthand vs
   cell-by-cell; `rows` / `cells` read-back; per-cell font override falls back to
   table defaults; `validateFont` rejects an unknown font.
2. **Measurement, single line** — a cell whose text fits one line →
   `height ≈ leading + 2*padding`; row height = max across cells; total = sum.
3. **Measurement, wrapping** — text forced to wrap N lines at a narrow column
   width → `height ≈ N*leading + 2*padding`. Assert the expected line count from
   an **independent** width computation (`measureText`), not by re-running
   `layoutText` — so the test checks the wrap rather than tautologically
   mirroring it.
4. **Padding** — same table at padding `0` vs `P` differs by `2*P*rowCount`.
5. **Edge cases** — empty cell → one-line-min height; empty table →
   `totalHeight 0`; an explicit `\n` in a cell forces an extra line.

## Files touched

- **New:** `src/tableauthor.ts`, `test/table-author.test.ts`.
- **Edit:** `src/index.ts` (export `createTable`, `TableBuilder`, `RowBuilder`,
  `CellBuilder`, and the `TableDefaults` / `CellTextOptions` / `TableMetrics`
  types).
- **Edit:** `README.md` — note table authoring is in progress (or defer the
  user-facing entry to `-49l.4` when it renders). Decide at implementation time;
  prefer deferring the README feature entry until there is a render path.

## Quality gates

`npm run typecheck` and `npm test` green before closing the issue.
