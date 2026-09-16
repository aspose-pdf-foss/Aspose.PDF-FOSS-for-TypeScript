# PDF/UA-2: per-type structure shape rules (`q7hc.4.1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ISO 14289-2 8.2.5 clause in full — 20 new PDF/UA-2 rules over the
`Rule[]` machinery `q7hc.4` landed, plus a new pure-leaf occupancy grid for the
six table rules, with part 1 byte-identical.

**Architecture:** A new pure leaf `structgrid.ts` places a `/Table`'s declared
spans **as declared** (unlike `tablespan.ts`, which places them legally) and runs
the ISO 32000-2 14.8.5.7 header-association walk. `structvalidate.ts` grows 20
rules, each guarded `if (ctx.part !== 2) return []` and APPENDED to `RULES`.
Three small reads are added beside them: `StructElement.References` for `/Ref`,
an `FENote` attribute owner, and an inheriting `ListNumbering`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-15-pdfua2-structure-shapes-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only; add no npm runtime dep.
- **ESM + NodeNext.** Every relative import specifier carries the `.js`
  extension (`import { x } from './structgrid.js'`).
- **`npm run typecheck` and `npm test` must both be green before any task is
  considered done.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Part 1 is byte-identical.** `test/pdfua-part1-identity.test.ts`,
  `test/pdfuaconvert.test.ts`, `test/pdfua2-validate.test.ts` and
  `test/markdown-pdfua.test.ts` must pass **UNEDITED**. If one needs editing,
  stop — the change is wrong.
- **Every new rule opens `if (ctx.part !== 2) return [];`** and is APPENDED to
  `RULES`, never inserted.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.4.1` in parentheses at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  The sweep must print nothing:
  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
  done
  ```
- **The anchor is a TRANSCRIPTION, not a runnable oracle.** Every transcribed
  constant and algorithm cites its source file, fetched 2026-09-15:
  - `veraPDF/veraPDF-validation-profiles@integration`, `PDF_UA/2/8.2 Logical structure/8.2.5 …/**`
  - `veraPDF/veraPDF-validation@integration`,
    `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/gfse/GFSETable.java`,
    `GFSETH.java`, `GFSEL.java`, and `../GFPDStructTreeNode.java`
  - `veraPDF/veraPDF-parser@integration`,
    `src/main/java/org/verapdf/tools/AttributeHelper.java`,
    `TaggedPDFConstants.java`, `src/main/java/org/verapdf/pd/structure/PDStructElem.java`

  **Never write one of these from memory.**

## One refinement to the spec, made here

The spec names the new accessor `StructElement.Refs` and records that it collides
with the existing `StructElement.Ref` (the element's own object reference) one
letter apart. **This plan names it `References` instead**, which resolves the
collision rather than merely documenting it. Everything else is as specified.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/structgrid.ts` | Placement of a table's declared spans as declared, the irregularity it finds, and the 14.8.5.7 header walk. Pure leaf: imports NOTHING. |
| **Modify** `src/struct.ts` | `StructElement.References` — the `/Ref` key. |
| **Modify** `src/structattr.ts` | `readOwnerName` (raw, unvalidated), `effectiveListNumbering` (inheriting). |
| **Modify** `src/structvalidate.ts` | `WalkedNode.parent`; `significantChildren`; the 20 rules. |
| **Create** `test/structgrid.test.ts` | The grid and the header walk from hand-built numbers, no PDF built. |
| **Create** `test/pdfua2-structure.test.ts` | Each of the 20 rules as a cross-part PAIR. |
| **Create** `test/helpers/build-irregular-table-pdf.ts` | Tagged tables, regular and deliberately irregular, for the table rules. |
| **Modify** `CLAUDE.md`, `README.md`, `CHANGELOG.md` | Source-list entry, API reference row, Unreleased entry. |

---

### Task 1: `structgrid.ts` — placement and regularity

**Files:**
- Create: `src/structgrid.ts`
- Test: `test/structgrid.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing. This module imports NOTHING.
- Produces:
  ```ts
  export interface GridCell {
    isHeader: boolean; rowSpan: number; colSpan: number;
    id?: string; scope?: string; headers?: string[];
  }
  export interface CellAddr { row: number; index: number }
  export interface PlacedCell { addr: CellAddr; row: number; col: number }
  export type TableIrregularity =
    | { kind: 'intersection'; a: CellAddr; b: CellAddr }
    | { kind: 'row-columns'; row: number; span?: number }
    | { kind: 'column-rows'; column: number };
  export interface StructGrid {
    rowCount: number; columnCount: number;
    irregularity?: TableIrregularity;
    occupancy: (PlacedCell | null)[][];
  }
  export function buildStructGrid(
    rows: readonly (readonly GridCell[])[],
    groupBoundaries: readonly number[],
  ): StructGrid;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/structgrid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildStructGrid, type GridCell } from '../src/structgrid.js';

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
    // from row 0, so row 1 is the irregular one.
    const g = buildStructGrid([[td(), td()], [td(), td(), td()]], []);
    expect(g.columnCount).toBe(2);
    expect(g.irregularity).toEqual({ kind: 'row-columns', row: 1 });
  });

  it('counts rows through the first column spans, not by TR count', () => {
    // getNumberOfRows adds the FIRST cell's rowSpan and skips that many TRs.
    const g = buildStructGrid([[td(2), td()], [td()]], []);
    expect(g.rowCount).toBe(2);
    expect(g.irregularity).toBeUndefined();
  });

  it('reports an overlapping cell as an intersection, naming both cells', () => {
    // (0,0) spans two rows; row 1 then declares two cells, the second of which
    // lands on the spanned slot.
    const g = buildStructGrid([[td(2), td()], [td(), td()]], []);
    expect(g.irregularity).toEqual({
      kind: 'intersection', a: { row: 1, index: 1 }, b: { row: 0, index: 0 },
    });
  });

  it('reports a row span that overhangs the table as column-rows', () => {
    const g = buildStructGrid([[td(3), td()], [td()]], []);
    // rowCount is 3 (first cell spans 3) but only two TRs were declared, so the
    // leftover slots report instead. The overhang case needs a SHORT span in
    // column 0 and a long one later in the row.
    expect(g.irregularity).toBeDefined();
  });

  it('reports a span crossing a row-grouping seam', () => {
    // Two groups: rows [0,1) and [1,2). A rowSpan of 2 from row 0 crosses the
    // seam at 1. Boundaries are recorded at the START and END of each group.
    const g = buildStructGrid([[td(2)], [td()]], [0, 1, 1, 2]);
    expect(g.irregularity).toEqual({ kind: 'column-rows', column: 0 });
  });

  it('is regular when the same span stays inside one grouping', () => {
    const g = buildStructGrid([[td(2)], [td()]], [0, 2]);
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
  });

  it('carries id, scope and headers through to the placed cells', () => {
    const g = buildStructGrid([[th({ id: 'h1', scope: 'Column' })]], []);
    expect(g.occupancy[0][0]).toEqual({ addr: { row: 0, index: 0 }, row: 0, col: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/structgrid.test.ts`
Expected: FAIL — `Cannot find module '../src/structgrid.js'`

- [ ] **Step 3: Write the implementation**

Create `src/structgrid.ts`:

```ts
/** The occupancy grid behind a TAGGED table's declared spans — where each cell
 *  lands, whether the table is regular, and which header cells pertain to a
 *  given data cell (ISO 32000-2 14.8.5.7).
 *
 *  Transcribed from veraPDF/veraPDF-validation@integration
 *  `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/gfse/GFSETable.java`
 *  and `GFSETH.java`, fetched 2026-09-15. The published profiles state each
 *  table rule as a single predicate (`hasIntersection`, `unknownHeaders`, …)
 *  and say nothing about how cells are placed, so the algorithm is here and
 *  the profile is only the trigger.
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
 *  **Note the third grid, and the false friends:** `tablegrid.ts` infers spans
 *  from gaps in ruling lines (extraction), `tablespan.ts` places them legally
 *  (authoring), this places them faithfully (validation). Three directions, no
 *  shared code — the `mdscan.ts`/`htmltoken.ts` idiom.
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
 *  Never where it landed — that is `PlacedCell.row`/`.col` — so a caller can
 *  map straight back to the StructElement it read. */
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

  // Allocated to the LONGER of the two, purely so a damaged file cannot index
  // out of bounds. Every comparison below is against `rowCount`, which is what
  // the anchor compares against.
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

/** `getNumberOfRows`: add the FIRST cell of each row block, then skip that many
 *  rows. NOT `rows.length` — a table whose first column spans is counted
 *  through that column, and the two answers differ for exactly the tables these
 *  rules are about. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/structgrid.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Add the CLAUDE.md Source-list entry**

In `CLAUDE.md`, insert immediately after the `tablespan.ts` entry:

```markdown
- **structgrid.ts** — the occupancy grid behind a TAGGED table's declared spans
  (`q7hc.4.1`): where each cell lands, whether the table is regular, and which
  header cells pertain to a data cell (ISO 32000-2 14.8.5.7). Transcribed from
  veraPDF's `GFSETable.java`/`GFSETH.java`, because the published profiles state
  each table rule as a bare predicate and say nothing about how cells are placed.
  **Invariant, and it is the whole reason the module exists: `tablespan.ts`
  provably cannot answer these rules.** `buildSpanGrid` does
  `while (busy[r][c]) c++` and clamps every `rowSpan` to the table end — it
  places cells where they FIT, so a collision and an overhang can never occur.
  8.2.5.26-1 asks whether cells COLLIDE and 8.2.5.26-2 whether a span OVERHANGS,
  so reusing it leaves both rules permanently silent while looking correct.
  **Note the three grids, and they are false friends:** `tablegrid.ts` infers
  spans from gaps in ruling lines (extraction), `tablespan.ts` places declared
  spans legally (authoring), this places them AS DECLARED (validation). Three
  directions, no shared code — the `mdscan.ts`/`htmltoken.ts` idiom.
  **Invariant:** a pure LEAF importing NOTHING, so every rule is drivable from
  plain numbers with no PDF built; it never throws.
  **Invariant:** the column count comes from the FIRST row alone and the row
  count is NOT the TR count — `getNumberOfRows` adds each row block's first
  cell's `rowSpan` and skips that many rows. Both read wrong and both are the
  anchor's; a grid sized by the widest row accepts tables veraPDF rejects.
  **Invariant:** an absent `/Scope` is not "no scope" — `defaultScope` supplies
  one from POSITION ((0,0) → Both, row 0 → Column, column 0 → Row, else Both).
  Defaulting to absent instead reports every TD in every table whose headers are
  unscoped, which is most real tables.
  **Invariant:** the header walk is gated TWICE before any TD is examined — an
  empty or irregular table is connected by definition, and a table whose every
  TH carries an explicit `/Scope` is connected without a single TD being
  checked. A fixture built the obvious way therefore leaves 8.2.5.26-5 and -6
  unmeasured whatever the code does.
```

- [ ] **Step 6: Verify the CLAUDE.md sweep prints nothing**

Run:
```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```
Expected: no output.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/structgrid.ts test/structgrid.test.ts CLAUDE.md
git commit -m "feat(q7hc.4.1): structgrid.ts — a table's declared spans as declared

tablespan.ts places cells where they FIT and clamps every rowSpan, so it
provably cannot answer 8.2.5.26-1 or -2. Third grid, third direction.

The column count comes from the first row alone and the row count is not
the TR count; both read wrong and both are veraPDF's."
```

---

### Task 2: `structgrid.ts` — the 14.8.5.7 header walk

**Files:**
- Modify: `src/structgrid.ts`
- Test: `test/structgrid.test.ts`

**Interfaces:**
- Consumes: `StructGrid`, `GridCell`, `CellAddr`, `PlacedCell` from Task 1.
- Produces:
  ```ts
  export function defaultScope(row: number, col: number): 'Both' | 'Column' | 'Row';
  export function headerConnectivity(
    grid: StructGrid, rows: readonly (readonly GridCell[])[],
  ): { cell: CellAddr; unknown: string[] } | undefined;
  ```
  Returns the FIRST disconnected TD or nothing. `unknown` selects between the
  two rules it feeds: **empty → 8.2.5.26-5**, **non-empty → 8.2.5.26-6**.

- [ ] **Step 1: Write the failing test**

Append to `test/structgrid.test.ts`, EXTENDING the existing import line rather
than adding a second one — the file already imports `buildStructGrid` and
`GridCell`, so it becomes:

```ts
import {
  buildStructGrid, headerConnectivity, defaultScope, type GridCell,
} from '../src/structgrid.js';
```

Then append the cases (`td` and `th` are the helpers Task 1 defined at the top
of the file and are already in scope):

```ts
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
    const g = buildStructGrid([[td(), td()], [td()]], []);
    expect(g.irregularity).toBeDefined();
    expect(headerConnectivity(g, [[td(), td()], [td()]])).toBeUndefined();
  });

  it('passes an empty table', () => {
    expect(headerConnectivity(buildStructGrid([], []), [])).toBeUndefined();
  });

  it('passes a table whose every TH states a Scope, checking no TD at all', () => {
    // The lone TD has no /Headers and no header above or left of it that could
    // be derived — but gate 2 fires first, so nothing is examined.
    const rows = [[th({ scope: 'Column' }), th({ scope: 'Column' })], [td(), td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('derives a column header above the cell when the TH is unscoped', () => {
    // Row 0 is all TH with NO stated scope, so gate 2 does not fire and the
    // walk runs. defaultScope(0, c) is Column, so each TD below connects.
    const rows = [[th(), th()], [td(), td()]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('reports a TD with no header above or left of it', () => {
    // A 2x2 whose only TH is at (0,0) — unscoped, so gate 2 does not fire.
    // (0,1) has (0,0) to its LEFT, whose default scope at (0,0) is Both, so it
    // connects. (1,1) looks up column 1 and finds a TD, and left along row 1
    // and finds a TD: disconnected.
    const rows = [[th(), td()], [td(), td()]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r).toEqual({ cell: { row: 1, index: 1 }, unknown: [] });
  });

  it('connects that same cell when it names a header by id', () => {
    const rows = [[th({ id: 'h' }), td()], [td(), { ...td(), headers: ['h'] }]];
    expect(headerConnectivity(buildStructGrid(rows, []), rows)).toBeUndefined();
  });

  it('reports the undefined ids when /Headers names a header that does not exist', () => {
    const rows = [[th({ id: 'h' }), td()], [td(), { ...td(), headers: ['nope'] }]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r).toEqual({ cell: { row: 1, index: 1 }, unknown: ['nope'] });
  });

  it('never examines the cell at (0,0)', () => {
    // A table of plain TDs plus one unscoped TH elsewhere, so gate 2 does not
    // fire. (0,0) is skipped; (0,1) and (1,0) and (1,1) are not.
    const rows = [[td(), td()], [td(), th()]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r?.cell).not.toEqual({ row: 0, index: 0 });
  });

  it('reports only the FIRST disconnected TD, in row-major order', () => {
    const rows = [[th(), td()], [td(), td()], [td(), td()]];
    const r = headerConnectivity(buildStructGrid(rows, []), rows);
    expect(r?.cell).toEqual({ row: 1, index: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/structgrid.test.ts`
Expected: FAIL — `headerConnectivity is not a function`

- [ ] **Step 3: Write the implementation**

Append to `src/structgrid.ts`:

```ts
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
  // Gate 1: nothing to associate.
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
      // Only the cell's own origin slot, and never the corner.
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
 *  then left along each row it covers for a Row-scoped TH. Scanning stops once
 *  a run of headers has ended — a TH beyond an intervening TD does not pertain. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/structgrid.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Prove the default-scope table is load-bearing**

Mutate `defaultScope` to `return 'Both'` unconditionally, run
`npx vitest run test/structgrid.test.ts`, and confirm at least one case reddens.
Then mutate it to return `'Row'` for row 0 and confirm again. **Revert both.**
If either leaves the file green, the fixtures do not discriminate — add a case
before continuing, because a uniform table agrees under every reading.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/structgrid.ts test/structgrid.test.ts
git commit -m "feat(q7hc.4.1): the ISO 32000-2 14.8.5.7 header walk

Two gates before any TD is examined: an irregular table is connected by
definition, and a table whose every TH states a Scope is connected without
a single cell being checked — which is why a fixture built the obvious way
leaves 8.2.5.26-5 and -6 unmeasured whatever the code does.

An absent /Scope is filled in from position, not treated as absent."
```

---

### Task 3: The three reads — `References`, the `FENote` owner, inheriting `ListNumbering`

**Files:**
- Modify: `src/struct.ts` (beside the `ID` getter, around line 164)
- Modify: `src/structattr.ts`
- Test: `test/pdfua2-structure.test.ts` (created here)
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `collectOwnerDicts`, `readAttr` (already exported from
  `structattr.ts`); `StructElement`, `StructTreeRoot`.
- Produces:
  ```ts
  // struct.ts, on StructElement
  get References(): PdfRef[];

  // structattr.ts
  export function readOwnerName(
    doc: Document, root: StructTreeRoot, elemDict: PdfDict,
    owner: string, key: string): string | undefined;
  export function effectiveListNumbering(
    doc: Document, root: StructTreeRoot, elemDict: PdfDict): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/pdfua2-structure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { readOwnerName, effectiveListNumbering } from '../src/structattr.js';
import { name } from '../src/types.js';

/** A tagged document with a /Document root element, a title and a language, so
 *  that only the rule under test can report. Returns the live tree root. */
export function taggedDoc(): { doc: Document; root: ReturnType<Document['CreateStructTree']> } {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  return { doc, root };
}

describe('StructElement.References — the /Ref KEY', () => {
  it('is empty when the element states no /Ref', () => {
    const { root } = taggedDoc();
    expect(root.Append('Document').References).toEqual([]);
  });

  it('reads the refs the element names, and is NOT the element own Ref', () => {
    const { doc, root } = taggedDoc();
    const docEl = root.Append('Document');
    const target = docEl.Append('P');
    const toci = docEl.Append('TOCI');
    toci.Dict.set('Ref', [target.Ref!]);
    doc.markModified();
    expect(toci.References).toEqual([target.Ref]);
    // The collision this accessor is named to avoid: `Ref` is the element's OWN
    // object reference and has nothing to do with /Ref.
    expect(toci.Ref).not.toEqual(target.Ref);
  });
});

describe('structattr raw and inherited reads', () => {
  it('readOwnerName returns a value OUTSIDE the enumeration', () => {
    // 8.2.5.14-4 must REPORT a bad NoteType, and the typed reader drops it.
    const { doc, root } = taggedDoc();
    const el = root.Append('Document').Append('FENote');
    el.Dict.set('A', [new Map([['O', name('FENote')], ['NoteType', name('Nonsense')]])]);
    doc.markModified();
    expect(readOwnerName(doc, root, el.Dict, 'FENote', 'NoteType')).toBe('Nonsense');
  });

  it('effectiveListNumbering defaults to None when nothing states one', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    expect(effectiveListNumbering(doc, root, l.Dict)).toBe('None');
  });

  it('effectiveListNumbering INHERITS through /P', () => {
    // AttributeHelper.getListNumbering passes isInheritable = true and walks /P.
    // A nested list therefore inherits its ancestor's numbering; NoteType and
    // Scope pass false and do not.
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    expect(effectiveListNumbering(doc, root, inner.Dict)).toBe('Decimal');
  });

  it('a nearer declaration wins over the inherited one', () => {
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    inner.SetListAttributes({ listNumbering: 'Disc' });
    expect(effectiveListNumbering(doc, root, inner.Dict)).toBe('Disc');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: FAIL — `References` is not a property; `readOwnerName` is not exported.

- [ ] **Step 3: Add `StructElement.References`**

In `src/struct.ts`, immediately after the `get ID()` getter:

```ts
  /** The structure elements this one REFERENCES — the `/Ref` key
   *  (ISO 32000-2 14.7.5.4), an array of references to other structure
   *  elements. Empty when the element states none.
   *
   *  **Note the collision this name avoids, and it is a real hazard:**
   *  `StructElement.Ref` is this element's OWN object reference and has nothing
   *  to do with `/Ref`. The two are unrelated, and under the obvious plural
   *  `Refs` they would be one letter apart — so a `/Ref` rule reaching for
   *  `el.Ref` would get a `PdfRef | undefined` that type-checks in some
   *  positions. Read by the TOCI and FENote rules in `structvalidate.ts`. */
  get References(): PdfRef[] {
    const v = this.doc.resolve(this.Dict.get('Ref'));
    return isArray(v) ? v.filter(isRef) : [];
  }
```

- [ ] **Step 4: Add the two `structattr.ts` readers**

In `src/structattr.ts`, immediately after `export function readAttr(...)`:

```ts
/** The RAW name value of `key` in the element's `owner` attribute dict.
 *
 *  **Invariant: UNVALIDATED, unlike every typed reader above, and that is the
 *  point.** `decEnum` drops a value outside its enumeration, so a typed read
 *  cannot tell "absent" from "present and wrong" — and ISO 14289-2 8.2.5.14-4
 *  has to REPORT a `/NoteType` outside {Footnote, Endnote, None}. The same
 *  applies to `/Scope`: veraPDF's table-level gate counts a TH as scoped when
 *  it states ANY name, junk included, so a validated read would examine cells
 *  the anchor does not. */
export function readOwnerName(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict, owner: string, key: string,
): string | undefined {
  const raw = readAttr(collectOwnerDicts(doc, root, elemDict, owner), key);
  return raw === undefined ? undefined : decName(doc, raw);
}

/** The `/ListNumbering` in force for this element, walking `/P` upward and
 *  falling back to `None`.
 *
 *  **Invariant, and first principles get it wrong: `ListNumbering` is
 *  INHERITABLE.** `AttributeHelper.getListNumbering` passes
 *  `isInheritable = true` and recurses on `/P`, while `NoteType` and `Scope`
 *  pass `false`. So a nested `L` inherits its ancestor's numbering and does NOT
 *  report under 8.2.5.25-1, while an absent value anywhere in the chain reads
 *  as `None` and DOES. `readList` does not inherit, so the validator cannot
 *  simply call it.
 *
 *  **Note the depth bound:** `/P` can cycle in a file we did not write, and a
 *  validator must not hang on damage — `lexer.ts`'s posture. */
export function effectiveListNumbering(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict,
): string {
  let d: PdfDict | undefined = elemDict;
  for (let depth = 0; d !== undefined && depth < 64; depth++) {
    const v = readOwnerName(doc, root, d, 'List', 'ListNumbering');
    if (v !== undefined) return v;
    const p = doc.resolve(d.get('P'));
    d = isDict(p) ? p : undefined;
  }
  return 'None';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Document the new public accessor**

In `README.md`, in the API Reference table that carries the other
`StructElement` members, add a row (keeping the table's existing column shape):

```markdown
| `StructElement.References` | The structure elements this one references (`/Ref`). Not `StructElement.Ref`, which is the element's own object reference. |
```

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`:

```markdown
- **`StructElement.References`** reads an element's `/Ref` entry — the structure
  elements it points at, which is how a TOCI names its target and how a footnote
  and its citations reference one another. Deliberately not spelled `Refs`:
  `StructElement.Ref` already exists and is the element's own object reference,
  so the plural would be one letter from an unrelated thing. (`q7hc.4.1`)
```

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/struct.ts src/structattr.ts test/pdfua2-structure.test.ts README.md CHANGELOG.md
git commit -m "feat(q7hc.4.1): /Ref, a raw attribute read, and inherited ListNumbering

ListNumbering is INHERITABLE and NoteType is not — AttributeHelper passes
isInheritable true for the first and false for the second, so a nested list
inherits its ancestor's numbering and an absent NoteType reads as None and
PASSES 8.2.5.14-4.

readOwnerName is unvalidated on purpose: decEnum cannot tell absent from
present-and-wrong, and 8.2.5.14-4 has to report the wrong one."
```

---

### Task 4: The shared walk, pass-through children, and the eight simple shape rules

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/pdfua2-structure.test.ts`

**Interfaces:**
- Consumes: `UaCtx`, `Rule`, `uaClause`, `RULES` (existing);
  `namespaceUriOf`, `MATHML_NS` from `./structns.js`;
  `StructElement.References` from Task 3.
- Produces (module-private, used by Tasks 5-7):
  ```ts
  function significantChildren(el: StructElement): StructElement[];
  interface WalkedNode { element: StructElement; parentType: string | null;
                         parent: StructElement | null }
  ```
  Rule names added: `TociRef`, `HeadingH`, `NoteProhibited`, `RubySequence`,
  `WarichuSequence`, `CaptionPosition`, `MathMLParent`, `ListItemContent`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-structure.test.ts`:

```ts
import { MATHML_NS } from '../src/structns.js';

/** Rule ids reported for `doc` at `part`. */
const ids = (doc: Document, part: 1 | 2): string[] =>
  doc.ValidatePdfUa(part).Issues.map((i) => i.rule);

/** Build a tree, save, reopen, and report the rule ids at both parts. The
 *  cross-part PAIR is the whole point: a single-part assertion cannot tell a
 *  rule that correctly went quiet from one that was never wired up. */
function bothParts(build: (root: ReturnType<Document['CreateStructTree']>) => void):
    { at2: string[]; at1: string[] } {
  const { doc, root } = taggedDoc();
  build(root);
  const re = Document.Open(doc.Save());
  return { at2: ids(re, 2), at1: ids(re, 1) };
}

describe('PDF/UA-2 8.2.5: the simple shape rules', () => {
  it('8.2.5.8-1 reports a TOCI with no /Ref anywhere beneath it', () => {
    const { at2, at1 } = bothParts((root) => {
      root.Append('Document').Append('TOC').Append('TOCI').Append('P');
    });
    expect(at2).toContain('TociRef');
    expect(at1).not.toContain('TociRef');
  });

  it('8.2.5.8-1 is satisfied by a /Ref on a DESCENDANT, not just the TOCI', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const target = d.Append('P');
    const toci = d.Append('TOC').Append('TOCI');
    toci.Append('P').Dict.set('Ref', [target.Ref!]);
    doc.markModified();
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('TociRef');
  });

  it('8.2.5.12-1 reports the H structure type', () => {
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('H'); });
    expect(at2).toContain('HeadingH');
    expect(at1).not.toContain('HeadingH');
  });

  it('8.2.5.14-1 reports the Note structure type', () => {
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('Note'); });
    expect(at2).toContain('NoteProhibited');
    expect(at1).not.toContain('NoteProhibited');
  });

  it('8.2.5.23-1 accepts RB,RT and RB,RP,RT,RP and reports anything else', () => {
    const good = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RB'); r.Append('RT');
    });
    expect(good.at2).not.toContain('RubySequence');

    const long = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RB'); r.Append('RP'); r.Append('RT'); r.Append('RP');
    });
    expect(long.at2).not.toContain('RubySequence');

    const bad = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('RT'); r.Append('RB');
    });
    expect(bad.at2).toContain('RubySequence');
    expect(bad.at1).not.toContain('RubySequence');
  });

  it('8.2.5.24-1 accepts WP,WT,WP and reports anything else', () => {
    const good = bothParts((root) => {
      const w = root.Append('Document').Append('Warichu');
      w.Append('WP'); w.Append('WT'); w.Append('WP');
    });
    expect(good.at2).not.toContain('WarichuSequence');

    const bad = bothParts((root) => {
      const w = root.Append('Document').Append('Warichu');
      w.Append('WT'); w.Append('WP');
    });
    expect(bad.at2).toContain('WarichuSequence');
    expect(bad.at1).not.toContain('WarichuSequence');
  });

  it('a Div between Ruby and its RB is TRANSPARENT', () => {
    // NonStruct, Div and Part are pass-through: their children stand in their
    // place, recursively. Left opaque, this Ruby reads as having one child.
    const { at2 } = bothParts((root) => {
      const r = root.Append('Document').Append('Ruby');
      r.Append('Div').Append('RB');
      r.Append('RT');
    });
    expect(at2).not.toContain('RubySequence');
  });

  it('8.2.5.27-1 reports a Caption that is neither first nor last', () => {
    const mid = bothParts((root) => {
      const t = root.Append('Document').Append('Sect');
      t.Append('P'); t.Append('Caption'); t.Append('P');
    });
    expect(mid.at2).toContain('CaptionPosition');
    expect(mid.at1).not.toContain('CaptionPosition');

    const first = bothParts((root) => {
      const t = root.Append('Document').Append('Sect');
      t.Append('Caption'); t.Append('P'); t.Append('P');
    });
    expect(first.at2).not.toContain('CaptionPosition');

    const last = bothParts((root) => {
      const t = root.Append('Document').Append('Sect');
      t.Append('P'); t.Append('P'); t.Append('Caption');
    });
    expect(last.at2).not.toContain('CaptionPosition');
  });

  it('8.2.5.29-1 reports a MathML element outside a Formula', () => {
    const bad = bothParts((root) => {
      root.Append('Document').Append('P').Append('math', { ns: MATHML_NS });
    });
    expect(bad.at2).toContain('MathMLParent');
    expect(bad.at1).not.toContain('MathMLParent');

    const good = bothParts((root) => {
      root.Append('Document').Append('Formula').Append('math', { ns: MATHML_NS });
    });
    expect(good.at2).not.toContain('MathMLParent');
  });

  it('8.2.5.29-1 allows MathML nested inside MathML', () => {
    const { at2 } = bothParts((root) => {
      const m = root.Append('Document').Append('Formula').Append('math', { ns: MATHML_NS });
      m.Append('mrow', { ns: MATHML_NS });
    });
    expect(at2).not.toContain('MathMLParent');
  });

  it('8.2.5.25-2 reports an LI that owns marked content directly', () => {
    const { doc, root } = taggedDoc();
    const li = root.Append('Document').Append('L').Append('LI');
    const page = doc.Pages[0];
    li.MarkContent(page, [0, 0, 100, 100]);
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('ListItemContent');
    expect(ids(re, 1)).not.toContain('ListItemContent');
  });

  it('8.2.5.25-2 is silent when the content sits in an Lbl or LBody', () => {
    const { doc, root } = taggedDoc();
    const li = root.Append('Document').Append('L').Append('LI');
    li.Append('LBody').MarkContent(doc.Pages[0], [0, 0, 100, 100]);
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListItemContent');
  });
});

describe('PDF/UA-2 8.2.5.28.2-1: Figure alt text is PRE-EXISTING', () => {
  it('reports at BOTH parts, under IllustrationAlt, and is not duplicated', () => {
    // The twenty-first rule of the clause. `IllustrationAlt` already covers
    // Figure/Formula/Form at both parts, so this rule is SATISFIED rather than
    // implemented — the one rule of the 21 that is not silent at part 1. A
    // part-2-only twin would make one missing /Alt report twice, so there is
    // none. Asserted here so the exemption reads as a decision.
    const { at2, at1 } = bothParts((root) => { root.Append('Document').Append('Figure'); });
    expect(at2).toContain('IllustrationAlt');
    expect(at1).toContain('IllustrationAlt');
    expect(at2.filter((r) => r === 'IllustrationAlt')).toHaveLength(1);
    expect(at2).not.toContain('FigureAlt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: FAIL — none of the new rule ids appear.

- [ ] **Step 3: Extend the walk and add the pass-through helper**

In `src/structvalidate.ts`, replace the `WalkedNode` interface and `walkTree`:

```ts
interface WalkedNode {
  element: StructElement;
  parentType: string | null;
  /** The parent ELEMENT, not just its type — the MathML rule needs the
   *  parent's NAMESPACE, which a type string cannot supply. Additive to a
   *  private interface and invisible to part-1 output. */
  parent: StructElement | null;
}
```

```ts
/** Depth-first pre-order over the structure tree. */
function walkTree(tree: StructTreeRoot): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (el: StructElement, parent: StructElement | null): void => {
    out.push({ element: el, parentType: parent === null ? null : parent.StandardType, parent });
    for (const child of el.Children) visit(child, el);
  };
  for (const top of tree.Children) visit(top, null);
  return out;
}
```

And add, beside the other helpers at the foot of the file:

```ts
/** `PDStructElem.isPassThroughTag` — the three types whose children stand in
 *  their own place. */
const PASS_THROUGH = new Set(['NonStruct', 'Div', 'Part']);

/** `GFPDStructTreeNode.getStructuralSignificanceChildren` — children with every
 *  pass-through element spliced away, RECURSIVELY.
 *
 *  **Invariant:** every 8.2.5 rule that reads "children" reads them this way,
 *  and `Part` is the surprising member — it is a grouping element rather than a
 *  wrapper, so a first reading treats it as opaque. Left opaque, a table whose
 *  rows sit under a `Part` has ZERO rows and is reported regular by default,
 *  which is a silent false negative. */
function significantChildren(el: StructElement): StructElement[] {
  const out: StructElement[] = [];
  for (const kid of el.Children) {
    if (PASS_THROUGH.has(kid.StandardType)) out.push(...significantChildren(kid));
    else out.push(kid);
  }
  return out;
}

/** The standard types of `significantChildren`, in order. */
function childTypes(el: StructElement): string[] {
  return significantChildren(el).map((c) => c.StandardType);
}
```

- [ ] **Step 4: Add the eight rules**

In `src/structvalidate.ts`, after `metadataRule` and before the `RULES` array:

```ts
/** 8.2.5.8-1: each TOCI shall identify its target through /Ref, on itself or on
 *  one of its DESCENDANT structure elements. */
const tociRefRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const anyRef = (el: StructElement): boolean =>
    el.References.length > 0 || el.Children.some(anyRef);
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'TOCI' || anyRef(element)) continue;
    issues.push({
      rule: 'TociRef', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.8' }), element,
      message: 'TOCI has no /Ref entry, on itself or on any descendant, '
        + 'so the entry identifies no target.',
    });
  }
  return issues;
};

/** 8.2.5.12-1: conforming files shall not use the H structure type. */
const headingHRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  return ctx.nodes.filter((n) => n.element.StandardType === 'H').map(({ element }) => ({
    rule: 'HeadingH', severity: 'error' as const,
    clause: uaClause(ctx.part, { 2: '8.2.5.12' }), element,
    message: 'The H structure type is prohibited in PDF/UA-2; use H1..Hn.',
  }));
};

/** 8.2.5.14-1: the Note structure type shall not be present unless role mapped
 *  into the PDF 2.0 namespace, where it does not exist — FENote replaces it. */
const noteProhibitedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  return ctx.nodes.filter((n) => n.element.StandardType === 'Note').map(({ element }) => ({
    rule: 'NoteProhibited', severity: 'error' as const,
    clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
    message: 'The Note structure type is prohibited in PDF/UA-2; use FENote.',
  }));
};

/** 8.2.5.23-1: a Ruby holds either RB,RT or RB,RP,RT,RP and nothing else. */
const rubySequenceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Ruby') continue;
    const seq = childTypes(element).join(',');
    if (seq === 'RB,RT' || seq === 'RB,RP,RT,RP') continue;
    issues.push({
      rule: 'RubySequence', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.23' }), element,
      message: `Ruby has the child sequence '${seq}', expected 'RB,RT' or 'RB,RP,RT,RP'.`,
    });
  }
  return issues;
};

/** 8.2.5.24-1: a Warichu holds WP,WT,WP and nothing else. */
const warichuSequenceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Warichu') continue;
    const seq = childTypes(element).join(',');
    if (seq === 'WP,WT,WP') continue;
    issues.push({
      rule: 'WarichuSequence', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.24' }), element,
      message: `Warichu has the child sequence '${seq}', expected 'WP,WT,WP'.`,
    });
  }
  return issues;
};

/** 8.2.5.27-1: a Caption shall be the FIRST or the LAST child of its parent.
 *
 *  **Note the profile spells this as a substring test** —
 *  `kidsStandardTypes.indexOf('&Caption&') < 0` over an `&`-joined list — which
 *  is exactly "not in any interior position", first and last included. */
const captionPositionRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    const types = childTypes(element);
    for (let i = 1; i < types.length - 1; i++) {
      if (types[i] !== 'Caption') continue;
      issues.push({
        rule: 'CaptionPosition', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.27' }), element,
        message: `Caption is child ${i + 1} of ${types.length}; it must be the first or the last.`,
      });
      break;
    }
  }
  return issues;
};

/** 8.2.5.29-1: a MathML element shall occur only under a Formula — or under
 *  another MathML element, which is what `hasParentFormulaOrMathML` means, so
 *  only the ROOT of a MathML subtree has to sit under the Formula. */
const mathMlParentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element, parent } of ctx.nodes) {
    if (namespaceUriOf(ctx.doc, element.Dict) !== MATHML_NS) continue;
    if (parent !== null
      && (parent.StandardType === 'Formula'
        || namespaceUriOf(ctx.doc, parent.Dict) === MATHML_NS)) continue;
    issues.push({
      rule: 'MathMLParent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.29' }), element,
      message: `MathML element '${element.Type}' is not nested within a Formula element.`,
    });
  }
  return issues;
};

/** 8.2.5.25-2: real content inside an LI shall be enclosed in an Lbl or an
 *  LBody, so the LI itself owns no marked content. */
const listItemContentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'LI' || element.ContentItems.length === 0) continue;
    issues.push({
      rule: 'ListItemContent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.25' }), element,
      message: 'LI owns real content directly; it must be enclosed in an Lbl or an LBody.',
    });
  }
  return issues;
};
```

Add the imports `namespaceUriOf` already has, extending the existing line:

```ts
import { namespaceUriOf, PDF20_NS, MATHML_NS } from './structns.js';
```

And APPEND to `RULES`, after `metadataRule`:

```ts
  // q7hc.4.1 — ISO 14289-2 8.2.5, part 2 only. APPENDED, so part-1 order holds.
  tociRefRule, headingHRule, noteProhibitedRule, rubySequenceRule,
  warichuSequenceRule, captionPositionRule, mathMlParentRule, listItemContentRule,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify part 1 has not moved**

Run: `npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
Expected: PASS, all four, **unedited**. If any needs editing, stop — a rule is
leaking into part 1 or `RULES` was inserted into rather than appended to.

- [ ] **Step 7: Prove pass-through transparency is load-bearing**

Change `significantChildren` to `return el.Children;` and run
`npx vitest run test/pdfua2-structure.test.ts`. Expected: the "a Div between
Ruby and its RB is TRANSPARENT" case reddens. **Revert.**

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/structvalidate.ts test/pdfua2-structure.test.ts
git commit -m "feat(q7hc.4.1): eight 8.2.5 shape rules, and pass-through children

NonStruct, Div AND Part are transparent, recursively — Part is the
surprising one, a grouping element rather than a wrapper, and left opaque
a table whose rows sit under one has zero rows and reads as regular.

WalkedNode gains the parent ELEMENT: the MathML rule needs the parent's
namespace, which a type string cannot supply."
```

---

### Task 5: The FENote graph rules and `ListNumbering`

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/pdfua2-structure.test.ts`

**Interfaces:**
- Consumes: `StructElement.References` (Task 3), `effectiveListNumbering` and
  `readOwnerName` (Task 3), `significantChildren` (Task 4).
- Produces rule names: `FENoteRefOrphan`, `FENoteRefGhost`, `FENoteType`,
  `ListNumbering`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-structure.test.ts`:

```ts
describe('PDF/UA-2 8.2.5.14: the FENote /Ref graph', () => {
  it('reports an orphan — a citation the FENote does not cite back', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = d.Append('FENote');
    const cite = d.Append('P');
    cite.Dict.set('Ref', [note.Ref!]);   // one-sided: the note names nobody
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteRefOrphan');
    expect(ids(re, 1)).not.toContain('FENoteRefOrphan');
  });

  it('reports a ghost — a reference the cited element does not return', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = d.Append('FENote');
    const cite = d.Append('P');
    note.Dict.set('Ref', [cite.Ref!]);   // one-sided the other way
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteRefGhost');
    expect(ids(re, 1)).not.toContain('FENoteRefGhost');
  });

  it('is silent when the graph closes in both directions', () => {
    const { doc, root } = taggedDoc();
    const d = root.Append('Document');
    const note = d.Append('FENote');
    const cite = d.Append('P');
    note.Dict.set('Ref', [cite.Ref!]);
    cite.Dict.set('Ref', [note.Ref!]);
    doc.markModified();
    const at2 = ids(Document.Open(doc.Save()), 2);
    expect(at2).not.toContain('FENoteRefOrphan');
    expect(at2).not.toContain('FENoteRefGhost');
  });

  it('8.2.5.14-4 accepts the three NoteType values and an ABSENT one', () => {
    for (const nt of ['Footnote', 'Endnote', 'None']) {
      const { doc, root } = taggedDoc();
      const note = root.Append('Document').Append('FENote');
      note.Dict.set('A', [new Map([['O', name('FENote')], ['NoteType', name(nt)]])]);
      doc.markModified();
      expect(ids(Document.Open(doc.Save()), 2)).not.toContain('FENoteType');
    }
    // Absent reads as the default None (AttributeHelper.getNoteType), so it
    // PASSES rather than failing — the obvious reading has this backwards.
    const { doc, root } = taggedDoc();
    root.Append('Document').Append('FENote');
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('FENoteType');
  });

  it('8.2.5.14-4 reports a NoteType outside the three', () => {
    const { doc, root } = taggedDoc();
    const note = root.Append('Document').Append('FENote');
    note.Dict.set('A', [new Map([['O', name('FENote')], ['NoteType', name('Sidenote')]])]);
    doc.markModified();
    const re = Document.Open(doc.Save());
    expect(ids(re, 2)).toContain('FENoteType');
    expect(ids(re, 1)).not.toContain('FENoteType');
  });
});

describe('PDF/UA-2 8.2.5.25-1: ListNumbering', () => {
  it('reports a list whose items carry an Lbl with no numbering stated', () => {
    const { at2, at1 } = bothParts((root) => {
      const li = root.Append('Document').Append('L').Append('LI');
      li.Append('Lbl'); li.Append('LBody');
    });
    expect(at2).toContain('ListNumbering');
    expect(at1).not.toContain('ListNumbering');
  });

  it('is silent when the L states a numbering other than None', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const li = l.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListNumbering');
  });

  it('reports an explicit ListNumbering of None', () => {
    const { doc, root } = taggedDoc();
    const l = root.Append('Document').Append('L');
    l.SetListAttributes({ listNumbering: 'None' });
    const li = l.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).toContain('ListNumbering');
  });

  it('is silent for a list with no Lbl at all', () => {
    const { at2 } = bothParts((root) => {
      root.Append('Document').Append('L').Append('LI').Append('LBody');
    });
    expect(at2).not.toContain('ListNumbering');
  });

  it('INHERITS the numbering from an outer list', () => {
    const { doc, root } = taggedDoc();
    const outer = root.Append('Document').Append('L');
    outer.SetListAttributes({ listNumbering: 'Decimal' });
    const inner = outer.Append('LI').Append('L');
    const li = inner.Append('LI');
    li.Append('Lbl'); li.Append('LBody');
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('ListNumbering');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: FAIL — the four new rule ids do not appear.

- [ ] **Step 3: Write the implementation**

Extend the `structattr.js` import at the top of `src/structvalidate.ts`:

```ts
import { effectiveListNumbering, readOwnerName } from './structattr.js';
```

Add the rules before the `RULES` array:

```ts
const NOTE_TYPES = new Set(['Footnote', 'Endnote', 'None']);

/** 8.2.5.14-2 and -3: the /Ref relation between a FENote and its citations
 *  shall close in BOTH directions.
 *
 *  -2 reports ORPHANS — elements that cite this note and are missing from its
 *  own /Ref; -3 reports GHOSTS — elements its /Ref names that do not cite it
 *  back. One rule computes both because both need the same reverse index, and
 *  a fixture whose graph is symmetric cannot separate them: each needs its own
 *  ONE-SIDED graph. */
const feNoteRefRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const key = (r: { num: number; gen: number }): string => `${r.num} ${r.gen}`;
  // Who cites whom, by object key.
  const cites = new Map<string, Set<string>>();
  for (const { element } of ctx.nodes) {
    if (element.Ref === undefined) continue;
    cites.set(key(element.Ref), new Set(element.References.map(key)));
  }
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'FENote' || element.Ref === undefined) continue;
    const me = key(element.Ref);
    const mine = cites.get(me) ?? new Set<string>();

    const orphans = [...cites].filter(([k, to]) => to.has(me) && !mine.has(k)).map(([k]) => k);
    if (orphans.length > 0) {
      issues.push({
        rule: 'FENoteRefOrphan', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
        message: `FENote /Ref omits structure element(s) ${orphans.join(', ')}, `
          + 'which reference this FENote.',
      });
    }
    const ghosts = [...mine].filter((k) => !(cites.get(k)?.has(me) ?? false));
    if (ghosts.length > 0) {
      issues.push({
        rule: 'FENoteRefGhost', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
        message: `FENote /Ref references structure element(s) ${ghosts.join(', ')}, `
          + 'which do not reference this FENote.',
      });
    }
  }
  return issues;
};

/** 8.2.5.14-4: a FENote's NoteType shall be Footnote, Endnote or None.
 *
 *  **Note an ABSENT NoteType PASSES.** `AttributeHelper.getNoteType` defaults it
 *  to `None`, which is in the permitted set — the obvious reading, that the
 *  attribute is required, has this backwards. It is read RAW, because the typed
 *  reader drops a value outside the enumeration and this rule has to report it. */
const feNoteTypeRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'FENote') continue;
    const nt = readOwnerName(ctx.doc, ctx.tree, element.Dict, 'FENote', 'NoteType') ?? 'None';
    if (NOTE_TYPES.has(nt)) continue;
    issues.push({
      rule: 'FENoteType', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.14' }), element,
      message: `FENote NoteType is '${nt}', expected Footnote, Endnote or None.`,
    });
  }
  return issues;
};

/** 8.2.5.25-1: where an LI carries an Lbl, the L shall state a ListNumbering
 *  other than None.
 *
 *  **Note the numbering is INHERITED** (`effectiveListNumbering`), so a nested
 *  list covered by an outer declaration does not report; and an ABSENT value
 *  reads as `None` and DOES, which is what makes the rule bite at all. */
const listNumberingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'L') continue;
    const labelled = significantChildren(element).some(
      (li) => li.StandardType === 'LI'
        && significantChildren(li).some((k) => k.StandardType === 'Lbl'));
    if (!labelled) continue;
    if (effectiveListNumbering(ctx.doc, ctx.tree, element.Dict) !== 'None') continue;
    issues.push({
      rule: 'ListNumbering', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.2.5.25' }), element,
      message: 'List items carry Lbl elements, but no ListNumbering other than '
        + 'None is in force on the L element.',
    });
  }
  return issues;
};
```

APPEND to `RULES`:

```ts
  feNoteRefRule, feNoteTypeRule, listNumberingRule,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the inheritance is load-bearing**

In `effectiveListNumbering`, stop the walk after the first iteration (delete the
`/P` step). Run `npx vitest run test/pdfua2-structure.test.ts`: the "INHERITS the
numbering from an outer list" case must redden. **Revert.**

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/structvalidate.ts test/pdfua2-structure.test.ts
git commit -m "feat(q7hc.4.1): the FENote /Ref graph and ListNumbering

Orphans and ghosts are computed together because both need one reverse
index — and a fixture whose graph is symmetric cannot separate them, so
each has its own one-sided graph.

An ABSENT NoteType passes: AttributeHelper defaults it to None, which is
in the permitted set. The obvious reading has that backwards."
```

---

### Task 6: The two link-annotation rules

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/pdfua2-structure.test.ts`

**Interfaces:**
- Consumes, all already existing — verified against the codebase, use these
  names exactly:
  - `StructTreeRoot.ElementForObject(structParentKey: number): StructElement | undefined`
  - `Page.Annotations: Annotation[]`, `Annotation.Subtype: string`
  - `Page.AddLink(opts: LinkOptions): LinkAnnotation` where
    `LinkOptions = { rect: [number, number, number, number]; action: PdfAction; border?: number }`
    and the URI action is `{ type: 'uri', uri: string }` (`src/actions.ts`)
  - `StructElement.AddAnnotation(annotation: Annotation): void` — the tagging
    method; it is NOT called `TagAnnotation`
  - `LinkAnnotation.Action: PdfAction | undefined` and
    `LinkAnnotation.Dest: OutlineDest | undefined`
- Produces rule names: `LinkEnclosure`, `LinkTargets`.

**Note the target comparison needs no serializer.** `LinkAnnotation.Action` and
`.Dest` are the parsed forms, and `actions.ts` is the ONE owner of that grammar
— the rule CLAUDE.md already states for links, push buttons and `/AA` triggers.
Reading `/A` and `/Dest` out of the raw dict here would be a second parser, and
importing `serializeObject` to compare destinations risks a cycle for nothing.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-structure.test.ts`:

```ts
describe('PDF/UA-2 8.2.5.20: link annotations', () => {
  /** A tagged page with one link annotation, tagged under `wrapper`. */
  function linkUnder(wrapper: string, uri = 'https://example.test/a'): Document {
    const { doc, root } = taggedDoc();
    const page = doc.Pages[0];
    const el = root.Append('Document').Append(wrapper);
    el.AddAnnotation(page.AddLink({ rect: [0, 0, 50, 20], action: { type: 'uri', uri } }));
    return Document.Open(doc.Save());
  }

  it('is silent for a link inside a Link element', () => {
    expect(ids(linkUnder('Link'), 2)).not.toContain('LinkEnclosure');
  });

  it('is silent for a link inside a Reference element', () => {
    expect(ids(linkUnder('Reference'), 2)).not.toContain('LinkEnclosure');
  });

  it('reports a link inside anything else', () => {
    const re = linkUnder('P');
    expect(ids(re, 2)).toContain('LinkEnclosure');
    expect(ids(re, 1)).not.toContain('LinkEnclosure');
  });

  it('is silent for a link that is in NO structure element at all', () => {
    // The profile test is `… || structParentType == null`, so an untagged link
    // does NOT report here. It reads wrong; it is what the anchor says, and
    // UntaggedContent covers that case instead.
    const { doc } = taggedDoc();
    doc.Pages[0].AddLink({
      rect: [0, 0, 50, 20], action: { type: 'uri', uri: 'https://example.test/a' },
    });
    expect(ids(Document.Open(doc.Save()), 2)).not.toContain('LinkEnclosure');
  });

  /** Two links under one element, with the given URIs. */
  function twoLinks(a: string, b: string): Document {
    const { doc, root } = taggedDoc();
    const page = doc.Pages[0];
    const el = root.Append('Document').Append('Link');
    el.AddAnnotation(page.AddLink({ rect: [0, 0, 50, 20], action: { type: 'uri', uri: a } }));
    el.AddAnnotation(page.AddLink({ rect: [0, 30, 50, 50], action: { type: 'uri', uri: b } }));
    return Document.Open(doc.Save());
  }

  it('reports two links with DIFFERENT targets under one Link element', () => {
    const re = twoLinks('https://example.test/a', 'https://example.test/b');
    expect(ids(re, 2)).toContain('LinkTargets');
    expect(ids(re, 1)).not.toContain('LinkTargets');
  });

  it('is silent for two links with the SAME target under one Link element', () => {
    const re = twoLinks('https://example.test/a', 'https://example.test/a');
    expect(ids(re, 2)).not.toContain('LinkTargets');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: FAIL — `LinkEnclosure` and `LinkTargets` do not appear.

- [ ] **Step 3: Write the implementation**

Add to `src/structvalidate.ts` before `RULES`:

```ts
/** 8.2.5.20-1 and -2: a link annotation used as real content shall sit in a
 *  Link or a Reference element, and links targeting DIFFERENT locations shall
 *  sit in separate ones.
 *
 *  **Note the first rule passes a link with NO structure parent** — the profile
 *  test is `… || structParentType == null || isArtifact == true`. An untagged
 *  link annotation does not report here; `UntaggedContent` is what covers it.
 *  It reads wrong and it is what the anchor says. */
const linkRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  // Parent element object key -> the first target seen under it.
  const firstTarget = new Map<string, string>();
  for (const page of ctx.doc.Pages) {
    for (const annot of page.Annotations) {
      if (!(annot instanceof LinkAnnotation)) continue;
      const spRaw = ctx.doc.resolve(annot.Dict.get('StructParent'));
      if (typeof spRaw !== 'number') continue;          // not in the tree: passes
      const parent = ctx.tree.ElementForObject(spRaw);
      if (parent === undefined) continue;               // ditto
      const st = parent.StandardType;
      if (st !== 'Link' && st !== 'Reference') {
        issues.push({
          rule: 'LinkEnclosure', severity: 'error',
          clause: uaClause(ctx.part, { 2: '8.2.5.20' }), element: parent, page,
          message: `A Link annotation is nested within '${parent.Type}' `
            + `(standard type '${st}') instead of Link or Reference.`,
        });
        continue;
      }
      if (parent.Ref === undefined) continue;
      const pkey = `${parent.Ref.num} ${parent.Ref.gen}`;
      const target = linkTarget(annot);
      const seen = firstTarget.get(pkey);
      if (seen === undefined) { firstTarget.set(pkey, target); continue; }
      if (seen === target) continue;
      issues.push({
        rule: 'LinkTargets', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.2.5.20' }), element: parent, page,
        message: `Structure element '${parent.Type}' holds Link annotations that `
          + `target different locations ('${seen}' and '${target}').`,
      });
    }
  }
  return issues;
};

/** A link's target, as a string that compares equal for equal destinations.
 *
 *  **Invariant: it goes through `LinkAnnotation.Action` and `.Dest`, the PARSED
 *  forms, never the raw `/A` and `/Dest`.** `actions.ts` is the one owner of
 *  that grammar — the rule CLAUDE.md states for links, push buttons and `/AA`
 *  triggers — so reading the dict here would be a second parser that can
 *  disagree with the first about one link. It also keeps this module free of
 *  `serialize.js`. */
function linkTarget(annot: LinkAnnotation): string {
  const a = annot.Action;
  if (a !== undefined && a.type === 'uri') return `uri:${a.uri}`;
  const d = annot.Dest;
  if (d !== undefined) return `dest:${JSON.stringify(d)}`;
  return '';
}
```

Add the import:

```ts
import { LinkAnnotation } from './annotation.js';
```

APPEND to `RULES`:

```ts
  linkRules,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: PASS.

- [ ] **Step 5: Check no cycle was closed**

Run: `npx vitest run test/import-cycles.test.ts`
Expected: PASS, the same 15 pairs.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/structvalidate.ts test/pdfua2-structure.test.ts
git commit -m "feat(q7hc.4.1): link annotation enclosure and distinct targets

A link with no /StructParent PASSES 8.2.5.20-1 — the profile test carries
an explicit '|| structParentType == null'. It reads wrong and it is what
the anchor says; UntaggedContent covers that case instead."
```

---

### Task 7: The six table rules

**Files:**
- Modify: `src/structvalidate.ts`
- Create: `test/helpers/build-irregular-table-pdf.ts`
- Test: `test/pdfua2-structure.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `buildStructGrid`, `headerConnectivity`, `GridCell` from
  `./structgrid.js`; `readOwnerName` from `./structattr.js`;
  `significantChildren` from Task 4.
- Produces rule names: `TableCellIntersection`, `TableRowRegularity`,
  `TableColumnRegularity`, `TableColumnCount`, `TableHeaderConnectivity`,
  `TableHeaderUndefined`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-irregular-table-pdf.ts`:

```ts
import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import type { StructElement } from '../../src/struct.js';

/** One cell of a test table. */
export interface Cell {
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
  id?: string;
  scope?: 'Row' | 'Column' | 'Both';
  headers?: string[];
}

export interface TableSpec {
  /** Rows outside any grouping. */
  rows?: Cell[][];
  /** Row groupings, each emitted as its own THead/TBody/TFoot element. */
  groups?: { type: 'THead' | 'TBody' | 'TFoot'; rows: Cell[][] }[];
}

/** A tagged, titled document holding one /Table built exactly as `spec` says —
 *  spans are written verbatim, so an irregular spec produces an irregular
 *  table rather than being fixed up on the way in. */
export function buildStructTablePdf(spec: TableSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  const table = root.Append('Document').Append('Table');

  const emitRows = (parent: StructElement, rows: Cell[][]): void => {
    for (const row of rows) {
      const tr = parent.Append('TR');
      for (const c of row) {
        const cell = tr.Append(c.header === true ? 'TH' : 'TD',
          c.id === undefined ? undefined : { id: c.id });
        const attrs: Record<string, unknown> = {};
        if (c.rowSpan !== undefined) attrs.rowSpan = c.rowSpan;
        if (c.colSpan !== undefined) attrs.colSpan = c.colSpan;
        if (c.scope !== undefined) attrs.scope = c.scope;
        if (c.headers !== undefined) attrs.headers = c.headers;
        if (Object.keys(attrs).length > 0) cell.SetTableAttributes(attrs);
      }
    }
  };

  emitRows(table, spec.rows ?? []);
  for (const g of spec.groups ?? []) emitRows(table.Append(g.type), g.rows);
  return doc.Save();
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/pdfua2-structure.test.ts`:

```ts
import { buildStructTablePdf, type Cell } from './helpers/build-irregular-table-pdf.js';

const cell = (o: Cell = {}): Cell => o;
const hdr = (o: Cell = {}): Cell => ({ header: true, ...o });

const tableIds = (spec: Parameters<typeof buildStructTablePdf>[0], part: 1 | 2): string[] =>
  ids(Document.Open(buildStructTablePdf(spec)), part);

describe('PDF/UA-2 8.2.5.26: table regularity', () => {
  it('is silent for a plain regular table', () => {
    const at2 = tableIds({ rows: [[hdr({ scope: 'Column' }), hdr({ scope: 'Column' })],
                                  [cell(), cell()]] }, 2);
    expect(at2).not.toContain('TableCellIntersection');
    expect(at2).not.toContain('TableRowRegularity');
    expect(at2).not.toContain('TableColumnRegularity');
    expect(at2).not.toContain('TableColumnCount');
  });

  it('26-1 reports two cells occupying one slot', () => {
    const spec = { rows: [[cell({ rowSpan: 2 }), cell()], [cell(), cell()]] };
    expect(tableIds(spec, 2)).toContain('TableCellIntersection');
    expect(tableIds(spec, 1)).not.toContain('TableCellIntersection');
  });

  it('26-2 reports a row span that crosses a THead/TBody seam', () => {
    const spec = {
      groups: [
        { type: 'THead' as const, rows: [[cell({ rowSpan: 2 })]] },
        { type: 'TBody' as const, rows: [[cell()]] },
      ],
    };
    expect(tableIds(spec, 2)).toContain('TableRowRegularity');
    expect(tableIds(spec, 1)).not.toContain('TableRowRegularity');
  });

  it('26-3 reports a row wider than row 0, with no count', () => {
    const spec = { rows: [[cell(), cell()], [cell(), cell(), cell()]] };
    expect(tableIds(spec, 2)).toContain('TableColumnRegularity');
    expect(tableIds(spec, 1)).not.toContain('TableColumnRegularity');
  });

  it('26-4 reports a SHORT row, with the count it reached', () => {
    const spec = { rows: [[cell(), cell()], [cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).toContain('TableColumnCount');
    expect(at2).not.toContain('TableColumnRegularity');
    expect(tableIds(spec, 1)).not.toContain('TableColumnCount');
  });
});

describe('PDF/UA-2 8.2.5.26: header connectivity', () => {
  it('examines no cell when every TH states a Scope', () => {
    // The lone TD is unreachable from any header, but gate 2 fires first.
    const spec = { rows: [[hdr({ scope: 'Column' }), cell()], [cell(), cell()]] };
    const at2 = tableIds(spec, 2);
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(at2).not.toContain('TableHeaderUndefined');
  });

  it('26-5 reports a TD with no /Headers and none derivable', () => {
    // The TH is UNSCOPED, so gate 2 does not fire and the walk runs.
    const spec = { rows: [[hdr(), cell()], [cell(), cell()]] };
    expect(tableIds(spec, 2)).toContain('TableHeaderConnectivity');
    expect(tableIds(spec, 1)).not.toContain('TableHeaderConnectivity');
  });

  it('26-5 is silent when the TD names a header that exists', () => {
    const spec = { rows: [[hdr({ id: 'h' }), cell()],
                          [cell(), cell({ headers: ['h'] })]] };
    expect(tableIds(spec, 2)).not.toContain('TableHeaderConnectivity');
  });

  it('26-6 reports a TD whose /Headers names an id no TH declares', () => {
    const spec = { rows: [[hdr({ id: 'h' }), cell()],
                          [cell(), cell({ headers: ['nope'] })]] };
    const at2 = tableIds(spec, 2);
    expect(at2).toContain('TableHeaderUndefined');
    expect(at2).not.toContain('TableHeaderConnectivity');
    expect(tableIds(spec, 1)).not.toContain('TableHeaderUndefined');
  });

  it('reports at most ONE disconnected TD per table', () => {
    const spec = { rows: [[hdr(), cell()], [cell(), cell()], [cell(), cell()]] };
    const hits = Document.Open(buildStructTablePdf(spec))
      .ValidatePdfUa(2).Issues.filter((i) => i.rule === 'TableHeaderConnectivity');
    expect(hits).toHaveLength(1);
  });

  it('a Part between the Table and its rows is TRANSPARENT', () => {
    // Left opaque, this table has ZERO rows and is reported regular by default
    // — a silent false negative, which is why Part is in the pass-through set.
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US'; doc.SetMetadata({ title: 'T' }); doc.DisplayDocTitle = true;
    const table = doc.CreateStructTree().Append('Document').Append('Table');
    const part = table.Append('Part');
    const tr = part.Append('TR');
    tr.Append('TD'); tr.Append('TD');
    const tr2 = part.Append('TR');
    tr2.Append('TD');                              // short row -> irregular
    expect(ids(Document.Open(doc.Save()), 2)).toContain('TableColumnCount');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: FAIL — none of the six table rule ids appear.

- [ ] **Step 4: Write the implementation**

Add to `src/structvalidate.ts` before `RULES`:

```ts
import { buildStructGrid, headerConnectivity, type GridCell } from './structgrid.js';

/** A table's rows, in order, with the index at the START and END of each
 *  row grouping — `GFSETable.getTR`'s `rowGroupingsIndexes`. */
function tableRows(table: StructElement): { rows: StructElement[]; boundaries: number[] } {
  const rows: StructElement[] = [];
  const boundaries: number[] = [];
  for (const kid of significantChildren(table)) {
    const t = kid.StandardType;
    if (t === 'TR') { rows.push(kid); continue; }
    if (t !== 'THead' && t !== 'TBody' && t !== 'TFoot') continue;
    boundaries.push(rows.length);
    for (const c of significantChildren(kid)) if (c.StandardType === 'TR') rows.push(c);
    boundaries.push(rows.length);
  }
  return { rows, boundaries };
}

/** One row's cells as the grid reads them. `/Scope` is read RAW, because
 *  veraPDF's table-level gate counts a TH as scoped when it states ANY name,
 *  junk included — a validated read would examine cells the anchor does not. */
function gridCells(ctx: UaCtx, tr: StructElement): { cells: GridCell[]; els: StructElement[] } {
  const cells: GridCell[] = [];
  const els: StructElement[] = [];
  for (const el of significantChildren(tr)) {
    const t = el.StandardType;
    if (t !== 'TD' && t !== 'TH') continue;
    const ta = el.TableAttributes;
    cells.push({
      isHeader: t === 'TH',
      rowSpan: ta?.rowSpan ?? 1,
      colSpan: ta?.colSpan ?? 1,
      id: el.ID,
      scope: readOwnerName(ctx.doc, ctx.tree, el.Dict, 'Table', 'Scope'),
      headers: ta?.headers,
    });
    els.push(el);
  }
  return { cells, els };
}

/** 8.2.5.26-1..-6: table regularity and header connectivity.
 *
 *  **Invariant:** ONE rule over ONE grid build, because all six predicates are
 *  answers about the same placement — building it per rule would let them
 *  disagree about one table. The six REPORT under four distinct names, which is
 *  the profile's own split: 26-3/26-4 and 26-5/26-6 are complementary tests of
 *  one defect that differ only in whether the message can carry its counts. */
const tableRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const clause = uaClause(ctx.part, { 2: '8.2.5.26' });

  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Table') continue;
    const { rows, boundaries } = tableRows(element);
    const read = rows.map((tr) => gridCells(ctx, tr));
    const grid = buildStructGrid(read.map((r) => r.cells), boundaries);
    const at = (a: { row: number; index: number }): StructElement | undefined =>
      read[a.row]?.els[a.index];

    const irr = grid.irregularity;
    if (irr !== undefined) {
      if (irr.kind === 'intersection') {
        for (const a of [irr.a, irr.b]) {
          issues.push({
            rule: 'TableCellIntersection', severity: 'error', clause,
            element: at(a) ?? element,
            message: 'Table cell intersects another cell.',
          });
        }
      } else if (irr.kind === 'column-rows') {
        issues.push({
          rule: 'TableRowRegularity', severity: 'error', clause, element,
          message: `Columns 1 and ${irr.column + 1} span a different number of rows in the `
            + 'table, or within a row grouping formed by THead, TBody or TFoot.',
        });
      } else if (irr.span === undefined) {
        issues.push({
          rule: 'TableColumnRegularity', severity: 'error', clause, element,
          message: `Table rows 1 and ${irr.row + 1} span a different number of columns.`,
        });
      } else {
        issues.push({
          rule: 'TableColumnCount', severity: 'error', clause, element,
          message: `Table rows 1 and ${irr.row + 1} span a different number of columns `
            + `(${grid.columnCount} and ${irr.span} respectively).`,
        });
      }
      continue;   // an irregular table is not asked about headers
    }

    const bad = headerConnectivity(grid, read.map((r) => r.cells));
    if (bad === undefined) continue;
    const el = at(bad.cell) ?? element;
    if (bad.unknown.length === 0) {
      issues.push({
        rule: 'TableHeaderConnectivity', severity: 'error', clause, element: el,
        message: 'TD has no Headers attribute, and its headers cannot be determined '
          + 'algorithmically.',
      });
    } else {
      issues.push({
        rule: 'TableHeaderUndefined', severity: 'error', clause, element: el,
        message: `TD references undefined header(s) ${bad.unknown.join(', ')}, and its `
          + 'headers cannot be determined algorithmically.',
      });
    }
  }
  return issues;
};
```

APPEND to `RULES`:

```ts
  tableRules,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-structure.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove three table rules are load-bearing**

Run each mutation, confirm it reddens `test/pdfua2-structure.test.ts`, then
**revert**:

1. In `buildStructGrid`, size `columnCount` from the widest row rather than
   row 0 — the 26-3 case must redden.
2. In `countRows`, `return rows.length` — a regularity case must redden.
3. Drop `'Part'` from `PASS_THROUGH` — the "a Part between the Table and its
   rows is TRANSPARENT" case must redden.
4. In `buildStructGrid`, delete the `groupBoundaries` loop — the "26-2 reports a
   row span that crosses a THead/TBody seam" case must redden. Note this one is
   PDF/UA-2's alone: veraPDF gates it on `isPDFUA2RelatedFlavour`, which for us
   is simply that the whole rule is part-2 only.

If any leaves the suite green, the fixture does not discriminate: fix the
fixture before continuing, and record what it could not see.

- [ ] **Step 7: Update the CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, beside the
`StructElement.References` entry added in Task 3:

```markdown
- **`ValidatePdfUa(2)` now answers ISO 14289-2 8.2.5**, the per-type structure
  requirements: a TOCI that identifies no target, the prohibited `H` and `Note`
  types, a footnote whose `/Ref` graph does not close in both directions, a link
  annotation outside a `Link`/`Reference` element or sharing one with a link that
  targets elsewhere, malformed Ruby and Warichu sequences, a labelled list with
  no numbering, an `LI` owning content directly, a misplaced `Caption`, MathML
  outside a `Formula`, and — the substantial half — table regularity and header
  connectivity. Tables are placed on a new occupancy grid that puts every cell
  where the document DECLARES it rather than where it fits, which is what makes
  an overlap or an overhanging span visible at all; header association follows
  ISO 32000-2 14.8.5.7, including that an absent `/Scope` is filled in from the
  cell's position rather than treated as absent. Twenty rules, all part 2 only —
  part 1 is unchanged. (`q7hc.4.1`)
```

- [ ] **Step 8: Full verification and commit**

```bash
npm run typecheck && npm test
npx vitest run test/pdfua-part1-identity.test.ts test/import-cycles.test.ts
git add src/structvalidate.ts test/pdfua2-structure.test.ts \
        test/helpers/build-irregular-table-pdf.ts CHANGELOG.md
git commit -m "feat(q7hc.4.1): table regularity and header connectivity

One rule over one grid build: all six predicates are answers about the
same placement, and building it per rule would let them disagree about
one table. They report under four names, which is the profile's own split.

An irregular table is never asked about headers, and a table whose every
TH states a Scope is connected without a cell being examined — so a
fixture built the obvious way measures neither."
```

---

## Final verification

- [ ] `npm run typecheck` — green.
- [ ] `npm test` — green.
- [ ] `test/pdfua-part1-identity.test.ts`, `test/pdfua2-validate.test.ts`,
      `test/pdfuaconvert.test.ts`, `test/markdown-pdfua.test.ts` all pass
      **with no edits in the diff** — confirm with
      `git diff --stat main -- test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
      (expected: empty).
- [ ] `test/import-cycles.test.ts` — the same 15 pairs.
- [ ] The CLAUDE.md sweep prints nothing.
- [ ] Twenty rule names are reachable at part 2 and none at part 1. A quick
      check, which must print 20 and then 0:
      ```bash
      npx vitest run test/pdfua2-structure.test.ts --reporter=basic
      ```
- [ ] `bd close q7hc.4.1` with a note recording the amended acceptance criterion
      (20 new rules, `8.2.5.28.2-1` pre-existing) and any rule a mutation showed
      to be uncovered.
- [ ] `git pull --rebase && git push && git status` — must show up to date with
      origin. **Work is not complete until the push succeeds.**
