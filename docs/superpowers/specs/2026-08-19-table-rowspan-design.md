# Table rowSpan — model, measure, render, and tagged /RowSpan

Design for `aspose-pdf-foss-for-ts-lucg.1`, the first child of the
`Authoring breadth` epic (`lucg`). The authoring table has had `colSpan` since
it shipped; it has never had a vertical span. Go's table authoring does, and
the *extraction* half of this repo has read `rowSpan` all along — so the gap is
one-sided in a way that shows up the moment a document is round-tripped.

## Problem

`tableauthor.ts` models a cell as `(text, style, colSpan, header)`. A row is a
flat list of cells laid left to right by a cursor that only ever moves
horizontally:

```ts
let c = 0;                       // physical-column cursor
for (const cell of row.cells) {
  ...
  c += cell.colSpan;
}
```

That walk appears three times — `contentWidths` (`tableauthor.ts:564`),
`measure` (`tableauthor.ts:682`) and `placeRows` (`tablerender.ts:128`) — and
each copy assumes every column of every row is claimed by a cell listed in that
row. There is no way to express a cell that occupies the same columns in the
row beneath it.

The asymmetry runs the other way through the rest of the stack, which makes the
gap conspicuous rather than merely absent:

- **`structattr.ts` already encodes it.** `TableAttributes.rowSpan` exists with
  a `/RowSpan` field in `TABLE_FIELDS` (`structattr.ts:129`, `:137`). Nothing
  in `src/` ever writes it.
- **Extraction already reads it.** `tablegrid.ts` grows a `rowSpan` across
  missing horizontal separators, `tablestruct.ts` reads `/RowSpan` off a tagged
  cell, `tablemodel.ts` blanks the covered grid slots, and `docxtable.ts` emits
  `w:vMerge` from it.

So a PDF whose tagged table carries `/RowSpan` extracts correctly and cannot be
re-authored. `AutoTag` writes `ColSpan` and never `RowSpan` for the same
reason (`autotag.ts:64`) — it has no vertical span to report because the model
it reports through has none.

## Approach

**One occupancy grid, computed once, consumed everywhere.** A new pure leaf
module `tablespan.ts` turns a table's `{ rowSpan, colSpan }` shape into
absolute cell placements, a column count, and the set of row indices at which
the table may legally be cut. `TableBuilder` builds it through one private
`spanGrid()` and hands it to the renderer on `TableMetrics`; the three cursor
walks collapse into reads of that grid.

`spanGrid()` is called from `columnCount()`, `contentWidths` and `measure` —
`resolveColumnWidths` runs before `measure`, so the grid cannot be a
by-product of measuring. It is rebuilt on each call rather than cached: rows
and cells are mutable right up to draw time (`addRow`, `setMinHeight`,
`setImage`), and a cache would have to be invalidated from every one of them.
The walk is O(cells) over data already in memory, against a `measure` that
wraps every string in the table.

Three alternatives were considered:

- **Methods on `TableBuilder`** (`private spanGrid()`, `safeBreakBefore(i)`).
  Smallest diff, and `flowtable.ts` already imports `TableBuilder`. Rejected
  because the arithmetic would then be reachable only through a built table, so
  every clamp and every break-index fixture has to go through
  `addRow`/`addCell` — and `tableauthor.ts` is already 740 lines carrying the
  model, the cascade, auto-fit and measurement.
- **Inline the occupancy walk at each of the three call sites.** Cheapest diff
  and three definitions of "which column did this cell land in". This is the
  drift `layout.ts`, `choiceopt.ts` and `actions.ts` each record an invariant
  against; a disagreement between `measure` and `placeRows` about a cell's
  column is a table that measures one way and paints another.
- **Reuse `tablegrid.ts`.** It is already the pure grid leaf both *detectors*
  share. Rejected because it works the opposite direction — it infers spans
  from ruling-line gaps in a detected grid, taking `xcuts`/`vSep`/`consumed`
  and returning quads. Authoring starts from declared spans and needs no
  geometry at all. The two would share a name and no code.

The recommended shape mirrors what this repo already does for arithmetic that
is silently wrong when reversed: `floatstack.ts` (float band bookkeeping),
`booklet.ts` (sheet ordering and creep), `docinfer.ts` (untagged document
shape). All are pure, none touches a `Document`, and each is driven in its
tests from hand-built inputs rather than from a built PDF.

The decisive reason for a module rather than a method is that the safe-break
set has **two consumers in two modules that must not import each other**:
`tablerender.ts` paginates against the anchor page's CropBox and `flowtable.ts`
against a rect. Their pagination rules contradict each other and cannot be one
function — a constraint `flowtable.ts` already documents in its header — but
"where may this table be cut" is the same question for both.

## Scope

In scope:

- `CellOptions.rowSpan` and `CellBuilder.rowSpan`, validated as `colSpan` is.
- `src/tablespan.ts`: occupancy grid, placements, effective spans, column
  count, safe-break set.
- `measure`'s two-pass height distribution.
- `placeRows` reading placements; both pagination loops backing off to a safe
  break.
- `/RowSpan` on the authored `/TD`/`/TH`.
- README and CHANGELOG.

Out of scope, deliberately:

- **Markdown.** GFM declares no spans in either direction; `mdflow.ts` has
  nothing to map.
- **`AutoTag` emitting `/RowSpan`.** The detector's rowSpan inference is a
  separate question about the whitespace and ruled detectors, not about the
  authoring model. `autotag.ts` is untouched here.
- **`FlowTableOptions`.** No new option: a span is a property of a cell, not of
  a placement.

## Design

### 1. Model

```ts
export interface CellOptions extends CellTextOptions {
  colSpan?: number;
  /** Number of rows this cell spans. Integer >= 1. Default 1. */
  rowSpan?: number;
  header?: CellHeader;
}
```

`CellBuilder` gains a `readonly rowSpan: number = 1` beside `colSpan`.
`validateRowSpan` mirrors `validateColSpan` exactly — integer, >= 1, thrown
from `addCell` before the cell is constructed, so a rejected call leaves the
builder untouched.

**Rows below a span omit the covered cells.** The cursor skips them, as HTML
does. No placeholder vocabulary is invented, because any placeholder would be a
second way to say the same thing and the two would drift.

### 2. `tablespan.ts`

Pure. Imports nothing. Its input is the table's shape, not its cells:

```ts
export interface SpanShape { rowSpan: number; colSpan: number }

export interface Placement {
  /** Absolute row index of the cell's top-left corner. */
  row: number;
  /** Absolute column index of that corner. */
  col: number;
  /** Span after both clamps — what measure, paint and /RowSpan all use. */
  rowSpan: number;
  colSpan: number;
}

export interface SpanGrid {
  /** placements[row][cellIndexWithinRow] — parallel to `RowBuilder.cells`. */
  placements: Placement[][];
  /** max(col + colSpan) over every placement; 0 for an empty table. */
  columnCount: number;
  /** Length rowCount + 1. safeBreak[i] is true iff the table may be cut
   *  immediately before row i. */
  safeBreak: boolean[];
}

export function buildSpanGrid(rows: SpanShape[][], repeatingRows: number): SpanGrid;
```

**Cursor.** For each row in order, advance past columns already claimed by a
span from an earlier row, place the cell at the first free column, and claim
`rowSpan × colSpan` cells. Occupancy is a growable `boolean[][]` rather than a
fixed grid, because the column count is an *output* of this walk.

**`columnCount` is `max(col + colSpan)`, not the widest row's `Σ colSpan`.** A
row whose columns are all inherited from above lists no cells at all and still
occupies the full width. The existing reduction over `Σ colSpan` returns 0 for
such a row and would shrink the table.

**Two clamps**, both producing the effective `rowSpan` every downstream
consumer reads:

1. **To the table's last row.** `rowSpan` is clamped to `rowCount - row`.
   Rows are appended after `addCell`, so a caller cannot know the final row
   count when they set the span — throwing would reject a table that is merely
   built in a different order. This is what HTML does for the same reason.
2. **To the repeating-header block.** A cell in rows `[0, repeatingRows)` is
   clamped to end at `repeatingRows - 1`. `continuationFrom` reprints rows
   `[0, N)` and then jumps to the body, so a span crossing that seam would be
   painted across a discontinuity — right on page 1 and wrong on every
   continuation.

Both clamps are silent, and both are *observable*: the clamped value is what
`/RowSpan` states, so the tag never describes rows the block does not cover.

**`safeBreak[i]`** is true iff no placement satisfies `row < i < row + rowSpan`.
`safeBreak[0]` and `safeBreak[rowCount]` are true by construction — an empty
slice and a whole table are both legal cuts.

### 3. Measure

`measure` runs two passes over one grid.

**Pass 1 — natural heights.** Every cell's needed height is computed exactly as
today: wrapped text line bands (or `leading` for an empty cell), the image
content height, plus vertical padding. Only cells with an effective
`rowSpan === 1` set `rowHeights[r]`, which starts at `row.minHeight`.

**Pass 2 — deficit.** Spanning cells are visited **in increasing order of last
covered row** (`row + rowSpan - 1`, ties broken by increasing `row`). If a
cell needs more than `Σ rowHeights[row .. row + rowSpan)`, the whole shortfall
is added to `rowHeights[row + rowSpan - 1]`.

Two properties of that rule are load-bearing and neither is obvious:

- **All of the deficit goes to the last covered row**, not spread across them.
  A row therefore never grows because of a spanning cell that starts above it,
  so a plain 1×1 cell is never floated in a box taller than its own content
  asked for. The alternatives — even and CSS-proportional distribution — both
  make an unrelated earlier row grow.
- **The visit order is not cosmetic.** With two overlapping spans, satisfying
  the earlier-ending one first means the longer one then measures against the
  already-enlarged rows and needs less, or nothing. Reversing the order
  over-allocates: the long span is satisfied first, the short span then finds
  its own rows unchanged and adds a second shortfall for height that is
  already there.

`TableMetrics` gains the grid:

```ts
export interface TableMetrics {
  rowHeights: number[];
  totalHeight: number;
  cellLines: string[][][];
  /** @internal The occupancy grid this measurement was taken against. */
  grid: SpanGrid;
}
```

`rowHeights`, `totalHeight` and `cellLines` keep their existing shape and
meaning, so every current caller compiles and behaves unchanged. Both
pagination loops already call `measure`, so `safeBreak` arrives where it is
needed without a second computation and without a new parameter.

`contentWidths` (auto-fit) reads the grid for its cursor. Its existing rule is
unchanged: a cell contributes to a column's max/min content only when
`colSpan === 1`, because a spanning cell's width belongs to no single column.
`rowSpan` does not enter that rule — a tall cell is still exactly as wide as
the columns it covers.

`columnCount()` delegates to the grid, keeping `forcedColumnCount` ahead of it
for continuation tables.

### 4. Render

`placeRows` stops walking a cursor and reads `grid.placements[r]`:

```
x      = columnX[p.col]
w      = Σ widths[p.col .. p.col + p.colSpan)
h      = Σ rowHeights[p.row .. p.row + p.rowSpan)
bottom = rowTop(p.row) - h
```

`paintRowSlice` is handed non-contiguous `rowIndices` — a repeating-header
prefix followed by a body range. That is safe because both clamps and the
back-off below guarantee every spanned row is contiguous *within the slice*: a
header span cannot leave the header block, and a body slice is never cut inside
a span. So the accumulated `rowTop` walk still yields the right `bottom`, and
no cell is ever placed against a row that is not on the page.

A spanning cell's background, border and text box are its full span box. That
falls out of `Placed` carrying the computed `h`; the three paint passes need no
change at all.

### 5. Pagination

Both loops gain the same back-off, reading `safeBreak` from the metrics they
already hold.

**`tablerender.ts`** — when row `i` does not fit, cut at the largest `j <= i`
with `safeBreak[j]` and `j > sliceStartRow`, and recompute `usedHeight` as the
sum of `rowHeights[sliceStartRow .. j)` (plus `headerHeight` on a
continuation). When no such `j` exists — the span group starting at
`sliceStartRow` is by itself taller than the page — fall through to the
existing "draw it anyway" path, which is what a single oversized row does
today. No new error is introduced, and the failure mode for an over-tall group
is the one callers already know.

**`flowtable.ts`** — `fit` computes the leading row count as it does now, then
backs off while `rows > 0 && !safeBreak[rows]`. Reaching 0 returns the existing
"not one row fits, retry in the next column" result, and the engine's existing
"does not fit in an empty column" error covers a group taller than a whole
column. That is exactly the atomic-element rule `flowtable.ts` already
documents for an oversized image.

`continuationFrom(startRow)` needs no change. `startRow` is now always a safe
break, so no span is ever sliced; the continuation's grid is rebuilt from the
sliced rows, and a body span that was clamped by the table end stays clamped
to the same absolute row.

### 6. Tagged output

`TableTagger.cell` takes the effective `rowSpan` alongside the cell and writes
it into the attributes it already builds:

```ts
if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
if (rowSpan > 1) attrs.rowSpan = rowSpan;
```

Written only when there is something to say, on the existing rule — `readTable`
defaults an absent `RowSpan` to 1, so an `/A` on every plain cell would be pure
bloat. `structattr.ts` already encodes the field; no change there.

The span passed is the **clamped** one, taken from the placement rather than
from `CellBuilder.rowSpan`, so the structure tree cannot claim rows the table
does not have. This is the one place where the two values differ observably,
and it is the reason the clamp happens in the grid rather than at paint time.

Nothing on the extraction side changes: `tablestruct.ts`, `tablegrid.ts`,
`tablemodel.ts`, `docxtable.ts` and `autotag.ts` already read `rowSpan`.

## Testing

`test/tablespan.test.ts` — the whole module from hand-built `SpanShape[][]`,
with no PDF anywhere:

- the cursor skipping columns claimed from above, including a row that lists
  fewer cells than the table has columns;
- `columnCount` for a row whose columns are entirely inherited (the case the
  `Σ colSpan` reduction returns 0 for);
- both clamps, each with a companion asserting an unclamped span is left alone;
- the `safeBreak` set, asserted as a whole array rather than at one index;
- the deficit distribution, including **two overlapping spans** — the case that
  goes red when the visit order is reversed, which a single span cannot detect.

`test/table-rowspan.test.ts` — end to end:

- measured `rowHeights` for a span needing more than its rows provide, with the
  neighbouring 1×1 row asserted *unchanged* (without that companion, an even
  distribution passes too);
- the painted box geometry of a spanning cell;
- pagination asserting **which row starts page 2**, not merely that two pages
  exist — a "two pages were produced" assertion is satisfied with the back-off
  removed;
- `/RowSpan` on the tagged cell, and the clamped value on an overrunning span.

`test/flow-table.test.ts` — a span forcing a column break, asserted the same
way: which row opened the second column.

`test/table-slice-identity.test.ts` must stay green **untouched**. It hashes
emitted table bytes and is a fence, not a golden: any table using no `rowSpan`
must emit identical bytes. If it moves, the grid changed the placement of a
cell that has no span, and that is the bug — not the hash.

Every assertion is mutation-checked before the issue closes, per the repo rule
that a fixture passing on the first run is not evidence. The back-off, the
visit order and the last-row deficit are the three that a plausible-looking
wrong implementation still satisfies, so each is broken deliberately and
confirmed to turn its own case red and leave the others green.

## Risks

- **The byte-identity fence is the whole safety net for existing tables.**
  Replacing three cursor walks with grid reads is a refactor of the most
  load-bearing arithmetic in the authoring table. If `table-slice-identity`
  moves, stop and find out why.
- **`columnCount` changes definition.** It is currently the widest row's
  `Σ colSpan` and becomes `max(col + colSpan)`. For any table with no
  `rowSpan` the two are identical by construction — but `resolveColumnWidths`
  validates `setColumnWidths` against it and throws on a mismatch, so a
  divergence surfaces as a rejected table rather than a misdrawn one. Worth an
  explicit test that a spanless table's count is unchanged.
- **The two clamps are silent.** A caller who writes `rowSpan: 5` on a
  four-row table gets 2 with no diagnostic. That is the chosen behaviour and it
  matches HTML, but it means a typo in a span is invisible. The mitigation is
  that `/RowSpan` reports the clamped value, so a tagged document is at least
  self-consistent.
