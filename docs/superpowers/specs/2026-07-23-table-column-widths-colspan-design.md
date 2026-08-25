# Column widths + colspan — Design

**Issue:** `aspose-pdf-foss-for-ts-49l.2` (epic `-49l`, Table authoring & rendering)
**Date:** 2026-07-23
**Depends on:** `-49l.1` (table core model + builders + measurement), shipped.
**Parity target:** Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go`
(`SetColumnWidths` + horizontal colspan).

## Goal

Extend the page-independent table authoring model (`src/tableauthor.ts`) with:

1. **Column-width specification** — `setColumnWidths` accepting fixed (absolute
   points) and proportional (fraction-of-leftover) columns.
2. **Column-width resolution** — turn those specs plus a total available width
   into concrete per-column point widths.
3. **Horizontal colspan** — a cell that spans two or more adjacent columns.

Everything is **additive** to the 49l.1 classes: new methods on the same
builders, a new `colSpan` on the cell, and a colspan-aware cell→column walk in
`measure()`. The 49l.1 `measure(columnWidths: number[], opts)` signature is
unchanged.

## Non-goals (owned by sibling issues)

- **No rendering.** The model never references a `Page`/`Document`. Rendering is
  `-49l.4`, which calls `resolveColumnWidths()` then `measure()`.
- **No inter-column borders / gaps.** A spanned cell's width is the plain sum of
  its covered columns. Borders, backgrounds, and inter-column spacing are
  `-49l.3`; when they land, a spanned width gains back the interior borders it
  bridges — an additive change to the span sum.
- **No rowspan.** Not part of the epic. Colspan is horizontal only.
- **No page-fit / overflow.** An all-fixed table may under- or over-run the total
  width; fitting to a page is `-49l.4`/`-49l.5`.

## Module & public API

All changes are in the existing `src/tableauthor.ts`. New public exports added
to `index.ts`:

- `type ColumnWidth = { fixed: number } | { fraction: number }` — a column spec.
- `interface CellOptions extends CellTextOptions { colSpan?: number }` — the
  `addCell` options, now carrying an optional span alongside the text style.

### Builder API

```ts
const t = createTable({ font: 'Helvetica', fontSize: 10 });
t.setColumnWidths([{ fixed: 120 }, { fraction: 2 }, { fraction: 1 }]); // chainable
const head = t.addRow();
head.addCell('Summary', { colSpan: 3, font: 'Helvetica-Bold' });      // spans all 3
t.addRow(['Name', 'Qty', 'Price']);

const widths = t.resolveColumnWidths(500);  // e.g. [120, 253.33, 126.66]
const m = t.measure(widths, { cellPadding: 3 });
```

- **`CellBuilder`** gains `readonly colSpan: number` (default 1). Text style stays
  in `options: CellTextOptions` — the 49l.1 read-back (`cell.options.font`) is
  unchanged. `addCell(text?, opts?: CellOptions)` splits `colSpan` off `opts`,
  validates it's an integer `>= 1` (else `TypeError`), and stores the remaining
  style fields as `options`.
- **`TableBuilder.setColumnWidths(widths: ColumnWidth[]): this`** — validates each
  entry (exactly one of `fixed`/`fraction` present, positive finite; else
  `TypeError`), stores them, returns `this` for chaining. It does **not** check
  the count against the table's columns, because rows may be added after the
  widths are set; that check happens at resolve time.
- **`TableBuilder.resolveColumnWidths(totalWidth: number): number[]`** — the pure
  resolver (below). Its output is exactly what `measure()` already consumes.

## Column-width resolution

`resolveColumnWidths(total)`:

1. Validate `total` is a positive finite number (else `TypeError`).
2. `n` = **column count** = the max over rows of `Σ cell.colSpan`. If `n === 0`
   (empty table) → return `[]`.
3. `specs` = the stored widths, or — if `setColumnWidths` was never called —
   `n` copies of `{ fraction: 1 }` (equal columns).
4. If `specs.length !== n` → `TypeError` (declared widths don't match the
   table's column count).
5. `remaining = total − Σ (fixed widths)`; `fracSum = Σ (fraction shares)`.
6. If `fracSum > 0` and `remaining <= 0` → `TypeError` (over-constrained: fixed
   columns leave no room for the proportional ones).
7. Each column resolves to: `fixed` → its value; `fraction` →
   `remaining * (frac / fracSum)`.

Notes:

- **All-fixed tables** (`fracSum === 0`) are allowed to under- or over-run
  `total`. Fixed means fixed; page-fit is a later issue's concern. No stretching
  or shrinking is applied.
- Fraction distribution is exact float division (points are floats); no integer
  rounding.

## Colspan in `measure()`

The 49l.1 loop mapped `cells[i] → column i`. It becomes a running
physical-column cursor `c`:

For each cell in a row (in order):

1. `span = cell.colSpan`.
2. If `c + span > columnWidths.length` → `TypeError` (the row's spans overrun the
   provided columns).
3. `outerWidth = Σ columnWidths[c .. c + span)`.
4. `innerWidth = outerWidth − 2 * cellPadding` (plain sum — inter-column borders
   are `-49l.3`).
5. Wrap the cell's text into `innerWidth` with the existing measuring driver
   exactly as in 49l.1; contribute `max(1, lineCount) * leading + 2*padding` to
   the row height.
6. `c += span`.

`columnWidths.length` must be `>=` the widest row's total span (= the column
count from resolution). `rowHeights`, `totalHeight`, and `cellLines` keep their
49l.1 shapes. `cellLines` stays indexed by **cell position** within the row (not
physical column); the renderer (`-49l.4`) maps a cell to its starting physical
column via the same span walk.

## Validation summary (all `TypeError`)

- `setColumnWidths`: each entry must have exactly one of `fixed`/`fraction`,
  positive finite.
- `addCell` `colSpan`: integer `>= 1`.
- `resolveColumnWidths`: `total` positive finite; `specs.length === columnCount`;
  not over-constrained (fraction columns with `remaining <= 0`).
- `measure`: unchanged 49l.1 checks, plus a row whose cumulative span exceeds
  `columnWidths.length`.

## Testing (TDD, vitest — extend `test/table-author.test.ts`)

Pure model; no page fixtures.

1. **`setColumnWidths` validation** — a mixed `[{fixed},{fraction},{fraction}]`
   stores cleanly; reject `{fixed:0}`, `{fraction:-1}`, both keys at once, and
   neither key.
2. **Resolution** — all-`{fraction:1}` splits `total` equally; `fixed + fraction`
   gives `fixed` its exact width and splits the remainder by share; **unset**
   widths default to equal columns; `specs.length !== columnCount` throws;
   over-constrained (fixed sum ≥ total with a fraction present) throws; empty
   table → `[]`.
3. **Colspan** — `addCell` rejects a non-integer / `< 1` `colSpan`; the column
   count reflects spans (a 3-span header over three 1-cells → 3 columns); a
   spanning cell wraps to **fewer** lines than the same text confined to one
   column, asserted against an **independent** `measureText` width (not by
   re-running `layoutText`); a row whose spans overrun the provided columns
   throws in `measure`.
4. **Integration** — `resolveColumnWidths(total)` then `measure(widths)` on a
   table with a colspan header row and proportional body columns.

## Files touched

- **Edit:** `src/tableauthor.ts` (types, `setColumnWidths`, `resolveColumnWidths`,
  `colSpan` on `CellBuilder`/`addCell`, colspan walk in `measure`).
- **Edit:** `src/index.ts` (export `ColumnWidth`, `CellOptions` types).
- **Edit:** `test/table-author.test.ts` (new `describe` blocks).
- **README:** still deferred to `-49l.4`, when a render path exists.

## Quality gates

`npm run typecheck` and `npm test` green before closing the issue.
