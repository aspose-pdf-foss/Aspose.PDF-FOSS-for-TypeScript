# Multiple borderless/whitespace tables per page

Issue: `aspose-pdf-foss-for-ts-ajj` (follow-up to `fwc`, which shipped multiple
**ruled** tables per page via connected stroke-component partitioning).

## Problem

The whitespace/borderless path in `src/table.ts` (`detectWhitespaceTable`)
detects at most **one** table per page:

- `extractTables` runs it only as a fallback, gated by `if (out.length === 0)`
  (i.e. only when the ruled path found nothing).
- It builds a single column/row model from **all** page fragments.

Consequences:

- **Side-by-side** borderless tables merge into one wide table: the between-tables
  gap is treated as just another column boundary by `columnCuts`.
- **Stacked** borderless tables with differing column structures break
  `columnCuts` (it only accepts a gap that is uncovered across *all* lines) or get
  concatenated into one table when they share column x-positions.
- A page can never yield **ruled AND borderless** tables, because the whitespace
  path is skipped whenever any ruled table exists.

The `Table[]` return type already supports multiple tables, so this is purely an
internal detection change.

## Approach

Recursive **XY-cut** segmentation with validation, composed with the existing
ruled path. Chosen over a single-level split (won't handle arbitrary nesting such
as two stacked tables beside one tall table) and over proximity/union-find
clustering (harder to tune, risks merging close tables or fragmenting sparse
ones).

### Composition in `extractTables`

1. Ruled path unchanged (tagged path also unchanged).
2. After ruled tables are built, compute the union set of ruled-table bboxes.
   Filter fragments to those **not** inside any ruled bbox.
3. Run `segmentBlocks` on the remaining fragments; append its tables to `out`.
4. **Remove the `if (out.length === 0)` gate** so ruled and borderless tables
   compose on the same page.
5. Move the reading-order sort (top→bottom, then left→right) to after all tables
   (ruled + borderless) are appended.

Regression safety:

- A page with one borderless table and no oversized internal gap segments into a
  single block → identical to today.
- A ruled page whose leftover fragments are prose is rejected by the existing
  prose guard (`colFill`) and the `>= 2` column/row requirement.

### Core: `segmentBlocks(frags): Table[]`

A pure function, internal to `table.ts`.

```
segmentBlocks(frags):
  if frags.length < 2: return []
  band = largest full-span whitespace band exceeding its magnitude threshold
         - horizontal band (spans full x-extent, no fragment inside) → separates STACKED
         - vertical band   (spans full y-extent, no fragment inside) → separates SIDE-BY-SIDE
         - choose the larger qualifying band
  if band exists:
    split frags into A, B at the band midline
    left  = segmentBlocks(A)
    right = segmentBlocks(B)
    if left.length + right.length >= 2:      # split genuinely produced multiple tables
      return [...left, ...right]
    # otherwise the split did not help; fall through to whole-block detection
  t = detectWhitespaceTable(frags)
  return t ? [t] : []
```

### Two guards, working together

Neither guard alone is sufficient; combined they prevent both over-splitting a
genuine table and manufacturing tables from prose.

1. **Magnitude threshold** (proposes candidate bands): prevents splitting a single
   table on ordinary row/column spacing.
   - Vertical (stacked) separator band must exceed ~2–2.5× the median baseline
     gap of the block. A lone blank separator row (~2× normal gap) must **not**
     trigger a split — thresholds tuned against fixtures.
   - Horizontal (side-by-side) separator band must exceed a multiple of the median
     font size / typical column gap.
   - Exact constants are tunable and validated against the fixtures below.
2. **Split validation** (`left.length + right.length >= 2`): prevents turning
   prose or a single sparse column into spurious tables — a split is only accepted
   when it yields at least two valid multi-column/row tables. `detectWhitespaceTable`
   already enforces `>= 2` columns, `>= 2` rows, and the prose guard.

## API / data flow

No public API change. `extractTables`, `Document.GetTables`, and `Page.GetTables`
keep their signatures and `Table[]` return. Cross-page stitching (`7ac`) continues
to operate on whatever per-page `Table[]` this produces. All new logic is internal
to `src/table.ts`.

## Testing

New fixtures/tests in `test/table.test.ts`, reusing the `buildTablePdf` +
`text` / `hline` / `vline` helpers:

- **Stacked**: two borderless tables separated by a vertical whitespace band →
  two distinct `Table` entries with correct rows/columns.
- **Side-by-side**: two borderless tables separated by a horizontal whitespace
  band → two distinct tables.
- **Mixed**: one ruled table + one borderless table on the same page → two tables
  (verifies the dropped `out.length === 0` gate and bbox-based fragment exclusion).
- **Regression — single table unchanged**: the existing single borderless table
  test still returns exactly one table.
- **Regression — modest internal gap**: a single borderless table with a moderate
  internal row/column gap stays one table (magnitude threshold not exceeded).
- **Regression — prose page**: a page of ordinary prose returns zero tables.

Quality gates: `npm run typecheck` and `npm test` must both be green before close.
