import { describe, it, expect } from 'vitest';
import {
  buildStructGrid, headerConnectivity, defaultScope, type GridCell,
} from '../src/structgrid.js';

/** A plain data cell. */
const td = (rowSpan = 1, colSpan = 1): GridCell => ({ isHeader: false, rowSpan, colSpan });
/** A header cell; `scope` absent means the document stated none. */
const th = (o: Partial<GridCell> = {}): GridCell =>
  ({ isHeader: true, rowSpan: 1, colSpan: 1, ...o });

describe('buildStructGrid — placement', () => {
  it('places a plain 2x2 table with no irregularity', () => {
    const g = buildStructGrid([[td(), td()], [td(), td()]], []);
    expect(g.irregularity).toBeUndefined();
    expect(g.rowCount).toBe(2);
    expect(g.columnCount).toBe(2);
    expect(g.occupancy[1][1]).toEqual({ addr: { row: 1, index: 1 }, row: 1, col: 1 });
  });

  it('takes the column count from the FIRST row alone, not the widest', () => {
    // Row 0 declares two columns; row 1 declares three. veraPDF sizes the grid
    // from row 0 (`getNumberOfColumns(listTR.get(0))`), so row 1 is the
    // irregular one. A grid sized by the widest row accepts this table.
    const g = buildStructGrid([[td(), td()], [td(), td(), td()]], []);
    expect(g.columnCount).toBe(2);
    expect(g.irregularity).toEqual({ kind: 'row-columns', row: 1 });
  });

  it('counts rows through the first column spans, not by row count', () => {
    // getNumberOfRows adds the FIRST cell's rowSpan and skips that many rows,
    // so these two declared rows are two grid rows and the table is regular.
    const g = buildStructGrid([[td(2), td()], [td()]], []);
    expect(g.rowCount).toBe(2);
    expect(g.irregularity).toBeUndefined();
  });

  it('counts a span that OVERRUNS the declared rows', () => {
    // The case above cannot tell countRows from `rows.length` — both are 2.
    // Measured: that mutation stays GREEN against it. Here ONE declared row
    // whose first cell spans two makes the table two rows tall, so the second
    // row's missing cell is what reports.
    const g = buildStructGrid([[td(2), td()]], []);
    expect(g.rowCount).toBe(2);
    expect(g.irregularity).toEqual({ kind: 'row-columns', row: 1, span: 1 });
  });

  it('reports two cells occupying one slot as an intersection, naming both', () => {
    // The plan's first fixture for this could not reach the branch: placement
    // SKIPS an occupied slot (`while (busy) c++`), so a collision can only
    // happen where a cell's EXTENSION meets one already placed. Here (0,1)
    // spans down into row 1, and row 1's single cell spans two columns into it.
    const g = buildStructGrid([[td(), td(2)], [td(1, 2)]], []);
    expect(g.irregularity).toEqual({
      kind: 'intersection', a: { row: 1, index: 0 }, b: { row: 0, index: 1 },
    });
  });

  it('reports a row span that overhangs the table as column-rows', () => {
    // The overhang must NOT be in column 0: getNumberOfRows reads the first
    // cell of each row, so a long span there simply makes the table taller.
    // Column 1 spans three rows where the table has two.
    const g = buildStructGrid([[td(1), td(3)], [td(), td()]], []);
    expect(g.irregularity).toEqual({ kind: 'column-rows', column: 1 });
  });

  it('reports a row span that crosses a THead/TBody seam', () => {
    // Boundaries are recorded at the START and END of each grouping, so two
    // one-row groupings give [0, 1, 1, 2]. The rowSpan of 2 from row 0 crosses
    // the seam at 1. veraPDF gates this on isPDFUA2RelatedFlavour; for us the
    // whole rule is part 2 only, so it is unconditional here.
    const g = buildStructGrid([[td(2), td()], [td()]], [0, 1, 1, 2]);
    expect(g.irregularity).toEqual({ kind: 'column-rows', column: 0 });
  });

  it('is regular when that same span stays inside one grouping', () => {
    const g = buildStructGrid([[td(2), td()], [td()]], [0, 2]);
    expect(g.irregularity).toBeUndefined();
  });

  it('reports a short row with the count it did reach', () => {
    const g = buildStructGrid([[td(), td()], [td()]], []);
    expect(g.irregularity).toEqual({ kind: 'row-columns', row: 1, span: 1 });
  });

  it('reports a row with no cells at all as span 0', () => {
    const g = buildStructGrid([[td(), td()], []], []);
    expect(g.irregularity).toEqual({ kind: 'row-columns', row: 1, span: 0 });
  });

  it('treats an empty table as regular', () => {
    const g = buildStructGrid([], []);
    expect(g.irregularity).toBeUndefined();
    expect(g.rowCount).toBe(0);
    expect(g.columnCount).toBe(0);
  });

  it('records where a spanning cell landed, not only where it was declared', () => {
    // Every slot a cell covers points at the same PlacedCell, whose row/col is
    // the cell's ORIGIN — which is what the header walk tests to skip a slot a
    // cell merely spans over.
    const g = buildStructGrid([[td(2), td()], [td()]], []);
    const origin = { addr: { row: 0, index: 0 }, row: 0, col: 0 };
    expect(g.occupancy[0][0]).toEqual(origin);
    expect(g.occupancy[1][0]).toEqual(origin);
  });

  it('carries id, scope and headers through on the cells the caller passed', () => {
    const cells = [[th({ id: 'h1', scope: 'Column' })]];
    const g = buildStructGrid(cells, []);
    expect(g.irregularity).toBeUndefined();
    const p = g.occupancy[0][0];
    expect(p).not.toBeNull();
    expect(cells[p!.addr.row][p!.addr.index].id).toBe('h1');
    expect(cells[p!.addr.row][p!.addr.index].scope).toBe('Column');
  });
});

describe('defaultScope — an absent /Scope is not "no scope"', () => {
  it('is Both at the corner, Column along row 0, Row down column 0, else Both', () => {
    expect(defaultScope(0, 0)).toBe('Both');
    expect(defaultScope(0, 3)).toBe('Column');
    expect(defaultScope(2, 0)).toBe('Row');
    expect(defaultScope(2, 3)).toBe('Both');
  });
});

describe('headerConnectivity', () => {
  it('passes an irregular table without examining a cell', () => {
    // Gate 1. The fixture must be able to FAIL the walk or it measures
    // nothing: an all-TD table leaves `everyHeaderScoped` true and GATE 2
    // returns first, so removing gate 1 stays green against it — measured.
    // This one has an UNSCOPED TH (defeating gate 2), three columns, a short
    // second row (irregular), and a TD at (1,1) with no header above or left.
    const rows = [[th(), td(), td()], [td(), td()]];
    const g = buildStructGrid(rows, []);
    expect(g.irregularity).toBeDefined();
    expect(headerConnectivity(g, rows)).toBeUndefined();
    // Proof the fixture discriminates: with the table taken as regular, that
    // same cell IS reported.
    expect(headerConnectivity({ ...g, irregularity: undefined }, rows))
      .toEqual({ cell: { row: 1, index: 1 }, unknown: [] });
  });

  it('passes an empty table', () => {
    expect(headerConnectivity(buildStructGrid([], []), [])).toBeUndefined();
  });

  it('passes a table whose every TH states a Scope, checking no TD at all', () => {
    // Gate 2. Nothing below is examined, so a fixture built this way leaves
    // 8.2.5.26-5 and -6 unmeasured whatever the code does.
    const rows = [[th({ scope: 'Column' }), th({ scope: 'Column' })], [td(), td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('derives a column header above the cell when the TH is unscoped', () => {
    // Row 0 is all TH with NO stated scope, so gate 2 does not fire and the
    // walk runs. defaultScope fills in Both at (0,0) and Column at (0,1).
    const rows = [[th(), th()], [td(), td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('reports a TD with no header above or left of it', () => {
    // The only TH is at (0,0), unscoped, so gate 2 does not fire. (1,1) looks
    // up column 1 and finds a TD, then left along row 1 and finds a TD.
    const rows = [[th(), td()], [td(), td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows))
      .toEqual({ cell: { row: 1, index: 1 }, unknown: [] });
  });

  it('connects that same cell when it names a header by id', () => {
    const rows = [[th({ id: 'h' }), td()], [td(), { ...td(), headers: ['h'] }]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('reports the undefined ids when /Headers names a header that does not exist', () => {
    const rows = [[th({ id: 'h' }), td()], [td(), { ...td(), headers: ['nope'] }]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows))
      .toEqual({ cell: { row: 1, index: 1 }, unknown: ['nope'] });
  });

  it('never examines the cell at (0,0)', () => {
    // Plain TDs plus one unscoped TH at (1,1), so gate 2 does not fire. (0,0)
    // is skipped outright; the first report is (0,1).
    const rows = [[td(), td()], [td(), th()]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r?.cell).toEqual({ row: 0, index: 1 });
  });

  it('reports only the FIRST disconnected TD, in row-major order', () => {
    // veraPDF's hasHeaders returns on the first failure, so a table with many
    // disconnected cells reports one. Mirrored deliberately: our finding count
    // is the only thing an unrunnable anchor can be compared on.
    const rows = [[th(), td()], [td(), td()], [td(), td()]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r?.cell).toEqual({ row: 1, index: 1 });
  });

  it('connects through a slot a header merely SPANS over', () => {
    // The TH at (0,0) spans down into (1,0). The TD at (1,1) finds it by
    // looking left, and `defaultScope(1, 0)` — column 0, so Row — is what makes
    // it pertain. Reaching a header through a spanned-over slot is the whole
    // reason `cellAt` reads the occupancy grid rather than the declared rows.
    const rows = [[th({ rowSpan: 2 }), td()], [td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('a cell examined at a spanned slot would answer identically', () => {
    // Recorded because the origin-slot check in `headerConnectivity` covers
    // NOTHING: `derivable` reads the cell's ORIGIN whichever slot it is reached
    // from, and the reported address is the origin too. Measured — deleting
    // that check reddens not one case. This asserts the property the check is
    // redundant WITH, so the reasoning is pinned even though the line is not.
    const rows = [[th({ scope: 'Column' }), th()], [td(1, 2)]];
    const g = buildStructGrid(rows, []);
    const wide = g.occupancy[1][0];
    expect(wide).not.toBeNull();
    // One cell, reached at two different slots, both naming the same origin.
    expect(g.occupancy[1][1]).toEqual(wide);
    expect(wide!.row).toBe(1);
    expect(wide!.col).toBe(0);
  });
});
