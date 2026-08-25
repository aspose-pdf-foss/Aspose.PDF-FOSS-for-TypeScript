/** The occupancy grid behind an authored table's spans: where each cell's
 *  top-left corner actually lands, how many physical columns the table has,
 *  where it may legally be cut, and how a spanning cell's height shortfall is
 *  settled.
 *
 *  Pure arithmetic — this module imports nothing and touches no PDF object, the
 *  split `floatstack.ts`, `booklet.ts` and `docinfer.ts` already make. That is
 *  what lets every clamp and every break index be driven from hand-built input
 *  rather than from a built PDF.
 *
 *  It is a module rather than methods on `TableBuilder` because the safe-break
 *  set has two consumers in two modules that must not import each other:
 *  `tablerender.ts` paginates against the anchor page's CropBox and
 *  `flowtable.ts` against a rect. Those pagination rules contradict each other
 *  and cannot be one function — but "where may this table be cut" is the same
 *  question for both.
 *
 *  Note the direction: `tablegrid.ts` is the pure grid leaf the two table
 *  *detectors* share, and it works the opposite way — it infers spans from gaps
 *  in ruling lines. Authoring starts from declared spans and needs no geometry
 *  at all. The two share a name and no code. @internal */

/** A cell's declared span, the only thing the grid needs from it. */
export interface SpanShape {
  rowSpan: number;
  colSpan: number;
}

/** Where one cell actually sits, after both clamps. */
export interface Placement {
  /** Absolute row index of the cell's top-left corner. */
  row: number;
  /** Absolute column index of that corner. */
  col: number;
  /** Span after both clamps — what measure, paint and /RowSpan all read. */
  rowSpan: number;
  colSpan: number;
}

export interface SpanGrid {
  /** `placements[row][i]` is parallel to `RowBuilder.cells[i]`. */
  placements: Placement[][];
  /** `max(col + colSpan)` over every placement; 0 for an empty table. */
  columnCount: number;
  /** Length `rowCount + 1`. `safeBreak[i]` is true iff the table may be cut
   *  immediately before row `i`. `safeBreak[0]` and `safeBreak[rowCount]` are
   *  true by construction — an empty slice and a whole table are both legal. */
  safeBreak: boolean[];
}

/** Place every cell of `rows` (each row's cells in order) onto an occupancy
 *  grid, clamping each `rowSpan` to the table end and to the repeating-header
 *  block. `repeatingRows` is the count set by `setRepeatingRowsCount`. */
export function buildSpanGrid(
  rows: readonly (readonly SpanShape[])[], repeatingRows: number,
): SpanGrid {
  const rowCount = rows.length;
  const header = Math.min(Math.max(repeatingRows, 0), rowCount);
  // Growable rather than a fixed grid, because the column count is an OUTPUT
  // of this walk rather than an input to it.
  const busy: boolean[][] = rows.map(() => []);
  const placements: Placement[][] = [];
  let columnCount = 0;

  for (let r = 0; r < rowCount; r++) {
    const out: Placement[] = [];
    let c = 0;
    for (const cell of rows[r]) {
      while (busy[r][c]) c++;
      // Clamp 1 — to the table's last row. Rows are appended after addCell, so
      // a caller cannot know the final row count when they set the span:
      // throwing would reject a table that is merely built in a different
      // order. This is what HTML does, for the same reason.
      let rowSpan = Math.min(cell.rowSpan, rowCount - r);
      // Clamp 2 — to the repeating-header block. `continuationFrom` reprints
      // rows [0, header) and then jumps to the body, so a span crossing that
      // seam would be painted across a discontinuity: right on page 1 and
      // wrong on every continuation.
      if (r < header) rowSpan = Math.min(rowSpan, header - r);
      const { colSpan } = cell;
      for (let dr = 0; dr < rowSpan; dr++)
        for (let dc = 0; dc < colSpan; dc++) busy[r + dr][c + dc] = true;
      out.push({ row: r, col: c, rowSpan, colSpan });
      columnCount = Math.max(columnCount, c + colSpan);
      c += colSpan;
    }
    placements.push(out);
  }

  const safeBreak = new Array<boolean>(rowCount + 1).fill(true);
  for (const row of placements)
    for (const p of row)
      for (let i = p.row + 1; i < p.row + p.rowSpan; i++) safeBreak[i] = false;

  return { placements, columnCount, safeBreak };
}

/** Settle every spanning cell's height shortfall against `rowHeights`, in
 *  place. Pass 1 (in `measure`) has already sized each row from its 1x1 cells
 *  and its `minHeight`; this is pass 2.
 *
 *  `needs[row][i]` is the natural required height of the cell at
 *  `grid.placements[row][i]` — wrapped text or image content plus vertical
 *  padding. Entries for 1x1 cells are read and ignored, so the caller can hand
 *  over the array it built anyway. */
export function applySpanDeficits(
  grid: SpanGrid, rowHeights: number[], needs: readonly (readonly number[])[],
): void {
  const spans: { p: Placement; need: number }[] = [];
  for (let r = 0; r < grid.placements.length; r++)
    for (let i = 0; i < grid.placements[r].length; i++) {
      const p = grid.placements[r][i];
      if (p.rowSpan > 1) spans.push({ p, need: needs[r][i] });
    }

  // Increasing last covered row, ties by increasing start row. The order is
  // NOT cosmetic: satisfying the earlier-ENDING span first means a longer one
  // overlapping it then measures against the already-enlarged rows and needs
  // less, or nothing. Reversed, the long span is satisfied first and the short
  // one then finds its own rows unchanged and adds a second shortfall for
  // height that is already there.
  spans.sort((a, b) =>
    (a.p.row + a.p.rowSpan) - (b.p.row + b.p.rowSpan) || a.p.row - b.p.row);

  for (const { p, need } of spans) {
    let have = 0;
    for (let r = p.row; r < p.row + p.rowSpan; r++) have += rowHeights[r];
    // ALL of the deficit goes to the last covered row, never spread across
    // them: a row must never grow because of a spanning cell that starts above
    // it, or a plain 1x1 cell ends up floated in a box taller than its own
    // content asked for. Even and CSS-proportional distribution both do that.
    if (need > have) rowHeights[p.row + p.rowSpan - 1] += need - have;
  }
}
