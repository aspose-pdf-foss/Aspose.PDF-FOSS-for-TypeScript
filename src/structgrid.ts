/** The occupancy grid behind a TAGGED table's declared spans — where each cell
 *  lands, whether the table is regular, and which header cells pertain to a
 *  given data cell (ISO 32000-2 14.8.5.7).
 *
 *  Transcribed from veraPDF/veraPDF-validation@integration
 *  `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/gfse/GFSETable.java`
 *  and `GFSETH.java`, fetched 2026-09-15. The published profiles state each
 *  table rule as a single predicate (`hasIntersection`, `unknownHeaders`, ...)
 *  and say nothing about how cells are placed, so the algorithm is here and the
 *  profile is only the trigger. A TRANSCRIPTION and not a runnable oracle:
 *  veraPDF is not installed, so the suite proves this agrees with our reading of
 *  that source and nothing about whether either matches ISO 14289-2.
 *
 *  **Invariant, and it is the whole reason this module exists: `tablespan.ts`
 *  provably cannot answer these rules.** `buildSpanGrid` does
 *  `while (busy[r][c]) c++` and clamps every `rowSpan` to the table end — it
 *  places cells where they FIT. 8.2.5.26-1 asks whether cells COLLIDE and
 *  8.2.5.26-2 whether a span OVERHANGS, and an authoring grid is constructed so
 *  that neither can ever happen. Reusing it would leave both rules permanently
 *  silent while looking correct. Authoring places declared spans LEGALLY;
 *  validation places them AS DECLARED and reports the collision.
 *
 *  **Note the third grid, and they are false friends:** `tablegrid.ts` infers
 *  spans from gaps in ruling lines (extraction), `tablespan.ts` places them
 *  legally (authoring), this places them faithfully (validation). Three
 *  directions, no shared code — the `mdscan.ts`/`htmltoken.ts` idiom.
 *
 *  **Invariant:** a pure LEAF importing NOTHING, so every rule is drivable from
 *  plain numbers with no PDF built — the split `tablespan.ts`, `floatstack.ts`,
 *  `linebox.ts` and `meshtri.ts` each already make. It never throws. @internal */

/** A table cell as the validator reads it off the structure tree. */
export interface GridCell {
  /** TH rather than TD. */
  isHeader: boolean;
  /** Table owner /RowSpan, defaulted to 1 by the caller. */
  rowSpan: number;
  /** Table owner /ColSpan, defaulted to 1 by the caller. */
  colSpan: number;
  /** The element's own /ID — what a TD's /Headers names. */
  id?: string;
  /** Table owner /Scope, RAW and unvalidated; absent means the document stated
   *  none, which is NOT the same as none applying (see `defaultScope`). */
  scope?: string;
  /** Table owner /Headers. */
  headers?: string[];
}

/** Where a cell was DECLARED: the row among `rows`, and its index within it.
 *  Never where it landed — that is `PlacedCell.row`/`.col` — so a caller can map
 *  straight back to the structure element it read. */
export interface CellAddr { row: number; index: number }

/** One slot's occupant: which cell, and where that cell's corner landed. */
export interface PlacedCell { addr: CellAddr; row: number; col: number }

export type TableIrregularity =
  /** Two cells occupy one slot. 8.2.5.26-1. */
  | { kind: 'intersection'; a: CellAddr; b: CellAddr }
  /** A row spans a different number of columns from row 0. `span` is the count
   *  it did reach when that is known (8.2.5.26-4) and absent when it is not
   *  (8.2.5.26-3) — which is exactly the profile's `wrongColumnSpan` split. */
  | { kind: 'row-columns'; row: number; span?: number }
  /** A column spans a different number of rows, or a span crosses a row
   *  grouping. 8.2.5.26-2. */
  | { kind: 'column-rows'; column: number };

export interface StructGrid {
  rowCount: number;
  columnCount: number;
  /** The FIRST irregularity found, in the anchor's own order; absent = regular.
   *  `checkRegular` returns on the first, so one table reports one finding. */
  irregularity?: TableIrregularity;
  occupancy: (PlacedCell | null)[][];
}

/** Place every cell of `rows` exactly where it is declared.
 *
 *  `groupBoundaries` holds the row index at the START and at the END of each
 *  THead/TBody/TFoot, in order — `getTR`'s `rowGroupingsIndexes`. A rowSpan
 *  crossing one of them is an irregularity. */
export function buildStructGrid(
  rows: readonly (readonly GridCell[])[],
  groupBoundaries: readonly number[],
): StructGrid {
  const rowCount = countRows(rows);
  if (rowCount === 0) return { rowCount: 0, columnCount: 0, occupancy: [] };
  const columnCount = (rows[0] ?? []).reduce((n, c) => n + c.colSpan, 0);

  // Allocated to the LONGER of the two, purely so a file we did not write
  // cannot index out of bounds. Every comparison below is against `rowCount`,
  // which is what the anchor compares against.
  const height = Math.max(rowCount, rows.length);
  const occupancy: (PlacedCell | null)[][] =
    Array.from({ length: height }, () => new Array<PlacedCell | null>(columnCount).fill(null));

  const done = (irregularity: TableIrregularity): StructGrid =>
    ({ rowCount, columnCount, irregularity, occupancy });

  for (let r = 0; r < rows.length; r++) {
    let c = 0;
    let sawCell = false;
    for (let index = 0; index < rows[r].length; index++) {
      const cell = rows[r][index];
      sawCell = true;
      while (c < columnCount && occupancy[r][c] !== null) c++;
      if (c + cell.colSpan > columnCount) return done({ kind: 'row-columns', row: r });
      if (r + cell.rowSpan > rowCount) return done({ kind: 'column-rows', column: c });
      for (const boundary of groupBoundaries) {
        if (r + cell.rowSpan > boundary && r < boundary)
          return done({ kind: 'column-rows', column: c });
      }
      const placed: PlacedCell = { addr: { row: r, index }, row: r, col: c };
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          const taken = occupancy[r + dr][c + dc];
          if (taken !== null)
            return done({ kind: 'intersection', a: placed.addr, b: taken.addr });
          occupancy[r + dr][c + dc] = placed;
        }
      }
      c += cell.colSpan;
    }
    if (!sawCell && columnCount > 0) return done({ kind: 'row-columns', row: r, span: 0 });
  }

  // Slots nothing reached: the row is SHORT rather than over-wide, and the
  // count it did reach is known — the 8.2.5.26-4 variant.
  for (let r = 0; r < rowCount; r++) {
    let empty = 0;
    for (let c = 0; c < columnCount; c++) if (occupancy[r][c] === null) empty++;
    if (empty !== 0) return done({ kind: 'row-columns', row: r, span: columnCount - empty });
  }

  return { rowCount, columnCount, occupancy };
}

/** `GFSETH.getDefaultScope`: an absent `/Scope` is filled in from POSITION, not
 *  treated as absent. Defaulting to absent makes the walk find nothing and
 *  reports every TD in every table with unscoped headers — which is most real
 *  tables. */
export function defaultScope(row: number, col: number): 'Both' | 'Column' | 'Row' {
  if (row === 0 && col === 0) return 'Both';
  if (row === 0) return 'Column';
  if (col === 0) return 'Row';
  return 'Both';
}

/** The first TD the table fails to connect to a header, or nothing.
 *
 *  `unknown` is what selects between the two rules this feeds — EMPTY means the
 *  cell named no headers and none could be derived (8.2.5.26-5), NON-EMPTY that
 *  it named ids no TH declares (8.2.5.26-6). That is the profile's own
 *  `unknownHeaders == ''` split, expressed as data rather than re-derived twice.
 *
 *  **Invariant:** it stops at the FIRST failing TD, which is what
 *  `GFSETable.hasHeaders` does. That is veraPDF's model-population artifact and
 *  not a stated rule of ISO 14289-2 — but our finding count is the only thing an
 *  unrunnable anchor can be compared on, and a differing count would be
 *  indistinguishable from a transcription bug. Widening it later is a decision,
 *  not a fix. */
export function headerConnectivity(
  grid: StructGrid, rows: readonly (readonly GridCell[])[],
): { cell: CellAddr; unknown: string[] } | undefined {
  // Gate 1: nothing to associate. An irregular table is connected by
  // definition, which is also why the table rules never report both.
  if (grid.rowCount === 0 || grid.irregularity !== undefined) return undefined;

  const cellAt = (r: number, c: number): GridCell | undefined => {
    const p = grid.occupancy[r]?.[c];
    return p === undefined || p === null ? undefined : rows[p.addr.row]?.[p.addr.index];
  };

  // Gate 2: collect the declared ids, and find out whether EVERY TH states a
  // scope. If they all do, the table is connected and no TD is examined.
  const ids = new Set<string>();
  let everyHeaderScoped = true;
  for (let r = 0; r < grid.rowCount; r++) {
    for (let c = 0; c < grid.columnCount; c++) {
      const cell = cellAt(r, c);
      if (cell === undefined || !cell.isHeader) continue;
      if (cell.id !== undefined && cell.id !== '') ids.add(cell.id);
      if (cell.scope === undefined) everyHeaderScoped = false;
    }
  }
  if (everyHeaderScoped) return undefined;

  const scoped = (r: number, c: number, want: 'Row' | 'Column'): boolean => {
    const cell = cellAt(r, c);
    if (cell === undefined || !cell.isHeader) return false;
    const s = cell.scope ?? defaultScope(r, c);
    return s === 'Both' || s === want;
  };
  const isHeader = (r: number, c: number): boolean => cellAt(r, c)?.isHeader === true;

  for (let r = 0; r < grid.rowCount; r++) {
    for (let c = 0; c < grid.columnCount; c++) {
      const p = grid.occupancy[r][c];
      if (p === null) continue;
      const cell = rows[p.addr.row]?.[p.addr.index];
      if (cell === undefined || cell.isHeader) continue;
      // Only the cell's own ORIGIN slot, and never the corner.
      //
      // **Note, measured, and the origin half covers NOTHING — it is a
      // redundant defence.** `derivable` reads `p.row`/`p.col`, which are the
      // ORIGIN whichever slot we are standing on, and the answer returned is
      // `p.addr`, also origin-independent — so examining a cell at a slot it
      // merely spans over provably gives the identical result. Deleting this
      // line reddens not one case. It is kept as the honest transcription of
      // `rowNumber != cell.getRowNumber()`, and because it saves re-walking a
      // wide cell once per covered slot. The CORNER half IS load-bearing.
      if (p.row !== r || p.col !== c) continue;
      if (r === 0 && c === 0) continue;

      const named = cell.headers ?? [];
      const byId = named.length > 0 && named.every((h) => ids.has(h));
      if (byId || derivable(p, cell, scoped, isHeader)) continue;
      return { cell: p.addr, unknown: named.filter((h) => !ids.has(h)) };
    }
  }
  return undefined;
}

/** The 14.8.5.7 walk: up each column the cell covers for a Column-scoped TH,
 *  then left along each row it covers for a Row-scoped TH. Scanning stops once a
 *  run of headers has ended — a TH beyond an intervening TD does not pertain. */
function derivable(
  p: PlacedCell, cell: GridCell,
  scoped: (r: number, c: number, want: 'Row' | 'Column') => boolean,
  isHeader: (r: number, c: number) => boolean,
): boolean {
  const endRow = p.row + cell.rowSpan;
  const endCol = p.col + cell.colSpan;
  if (p.row > 0) {
    for (let c = p.col; c < endCol; c++) {
      let headerFound = false;
      for (let r = p.row - 1; r >= 0; r--) {
        if (scoped(r, c, 'Column')) return true;
        if (isHeader(r, c)) headerFound = true;
        else if (headerFound) break;
      }
    }
  }
  if (p.col > 0) {
    for (let r = p.row; r < endRow; r++) {
      let headerFound = false;
      for (let c = p.col - 1; c >= 0; c--) {
        if (scoped(r, c, 'Row')) return true;
        if (isHeader(r, c)) headerFound = true;
        else if (headerFound) break;
      }
    }
  }
  return false;
}

/** `getNumberOfRows`: add the FIRST cell of each row block, then skip that many
 *  rows. NOT `rows.length` — a table whose first column spans is counted through
 *  that column, and the two answers differ for exactly the tables these rules
 *  are about. */
function countRows(rows: readonly (readonly GridCell[])[]): number {
  let n = 0;
  for (let r = 0; r < rows.length; r++) {
    const first = rows[r][0];
    if (first === undefined) continue;
    n += first.rowSpan;
    if (first.rowSpan > 1) r += first.rowSpan - 1;
  }
  return n;
}
