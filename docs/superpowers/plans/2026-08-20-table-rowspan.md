# Table rowSpan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the authoring table a vertical span — `addCell(text, { rowSpan })` — that measures, paints, paginates atomically and reports `/RowSpan` in a tagged table.

**Architecture:** One pure leaf module `src/tablespan.ts` turns a table's `{ rowSpan, colSpan }` shape into absolute cell placements, a column count, the set of legal cut rows, and the two-pass height distribution. The three horizontal cursor walks that exist today (`contentWidths`, `measure`, `placeRows`) collapse into reads of that one grid, which `TableBuilder` builds through a private `spanGrid()` and hands to the renderer on `TableMetrics`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-19-table-rowspan-design.md` — read it before Task 1 and keep it open; this plan argues from it.

**Issue:** `aspose-pdf-foss-for-ts-lucg.1` (beads). Claim it with `bd update aspose-pdf-foss-for-ts-lucg.1 --claim` before Task 1.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { buildSpanGrid } from './tablespan.js'`.
- **`src/tablespan.ts` imports nothing.** It is a pure leaf, like `floatstack.ts`, `booklet.ts` and `docinfer.ts`. No `Document`, no `Page`, no PDF object module. This is what makes every clamp and break index testable from hand-built inputs.
- **`test/table-slice-identity.test.ts` must stay green and untouched.** It hashes emitted table bytes for a table using no `rowSpan`. It is a **fence, not a golden**: if it moves, the grid changed the placement of a cell that has no span, and that is the bug — do not re-record the hash.
- **Both clamps are silent and observable.** A `rowSpan` past the last row, or out of the repeating-header block, is clamped rather than thrown, and the clamped value is what `/RowSpan` states.
- **Run before closing:** `npm run typecheck` and `npm test`, both green.
- **Errors are `TypeError` for argument validation**, thrown before anything is constructed, so a rejected call leaves the builder untouched.
- **Commit style:** `feat(lucg.1): <subject>` / `docs(lucg.1): …`, ending with a `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/tablespan.ts` | **create** | Pure occupancy grid: placements, column count, safe-break set, span height distribution. |
| `test/tablespan.test.ts` | **create** | The whole of `tablespan.ts` from hand-built `SpanShape[][]`. No PDF anywhere. |
| `src/tableauthor.ts` | modify | `CellOptions.rowSpan`, `CellBuilder.rowSpan`, `validateRowSpan`, private `spanGrid()`, `columnCount`/`contentWidths`/`measure` reading the grid, `TableMetrics.grid`. |
| `src/tablerender.ts` | modify | `placeRows` reads placements; `paintRowSlice` takes the grid; `drawTable`'s pagination backs off to a safe break. |
| `src/flowtable.ts` | modify | `fit` backs off to a safe break; `metrics` carries the grid through to `paintRowSlice`. |
| `src/tabletag.ts` | modify | `TableTagger.cell` takes the effective span and writes `/RowSpan`. |
| `test/table-rowspan.test.ts` | **create** | End to end: measured heights, painted box, `page.AddTable` pagination, tagged `/RowSpan`. |
| `test/flow-table.test.ts` | modify | One case: a span forcing a column break, asserted by which row opens the second column. |
| `README.md` | modify | The `rowSpan` paragraph in the Tables section, plus the two API-table rows. |
| `CHANGELOG.md` | modify | One `### Added` entry under `## [Unreleased]`. |

---

## Task 1: The occupancy grid

**Files:**
- Create: `src/tablespan.ts`
- Test: `test/tablespan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface SpanShape { rowSpan: number; colSpan: number }
  export interface Placement { row: number; col: number; rowSpan: number; colSpan: number }
  export interface SpanGrid {
    placements: Placement[][];
    columnCount: number;
    safeBreak: boolean[];
  }
  export function buildSpanGrid(
    rows: readonly (readonly SpanShape[])[], repeatingRows: number,
  ): SpanGrid;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/tablespan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSpanGrid, type SpanShape } from '../src/tablespan.js';

/** A cell of `rowSpan` x `colSpan`. Both stated at every call site: a default
 *  would hide which of the two a case is actually about. */
const s = (rowSpan: number, colSpan: number): SpanShape => ({ rowSpan, colSpan });

describe('buildSpanGrid: the cursor', () => {
  it('skips columns claimed by a span from an earlier row', () => {
    // Row 1 lists ONE cell, and it must land in column 1 — column 0 is still
    // held by the 2-row cell above it.
    const g = buildSpanGrid([
      [s(2, 1), s(1, 1)],
      [s(1, 1)],
    ], 0);
    expect(g.placements[0][0]).toEqual({ row: 0, col: 0, rowSpan: 2, colSpan: 1 });
    expect(g.placements[0][1]).toEqual({ row: 0, col: 1, rowSpan: 1, colSpan: 1 });
    expect(g.placements[1][0]).toEqual({ row: 1, col: 1, rowSpan: 1, colSpan: 1 });
  });

  it('places a colSpan cell past the columns a rowSpan already claimed', () => {
    const g = buildSpanGrid([
      [s(2, 1), s(1, 2)],
      [s(1, 2)],
    ], 0);
    expect(g.placements[1][0]).toEqual({ row: 1, col: 1, rowSpan: 1, colSpan: 2 });
    expect(g.columnCount).toBe(3);
  });
});

describe('buildSpanGrid: columnCount', () => {
  it('counts a row whose columns are entirely inherited from above', () => {
    // Row 1 lists NO cells and still occupies the full width. The old
    // reduction over the widest row's total colSpan returns 0 for it.
    expect(buildSpanGrid([[s(2, 1), s(2, 1)], []], 0).columnCount).toBe(2);
  });

  it('is unchanged for a table with no rowSpan at all', () => {
    // The definition moves from "widest row's total colSpan" to
    // "max(col + colSpan)". For a spanless table the two agree by
    // construction, and resolveColumnWidths throws on a mismatch — so a
    // divergence would surface as a REJECTED table, not a misdrawn one.
    const g = buildSpanGrid([
      [s(1, 1), s(1, 3)],
      [s(1, 1), s(1, 1), s(1, 1), s(1, 1)],
    ], 0);
    expect(g.columnCount).toBe(4);
  });

  it('is 0 for an empty table', () => {
    expect(buildSpanGrid([], 0).columnCount).toBe(0);
  });
});

describe('buildSpanGrid: clamps', () => {
  it('clamps a span to the last row of the table', () => {
    const g = buildSpanGrid([[s(5, 1)], [s(1, 1)], [s(1, 1)], [s(1, 1)]], 0);
    expect(g.placements[0][0].rowSpan).toBe(4);
  });

  it('leaves an in-range span alone', () => {
    // Companion: without it, "clamp everything to 1" reads as correct.
    const g = buildSpanGrid([[s(3, 1)], [s(1, 1)], [s(1, 1)], [s(1, 1)]], 0);
    expect(g.placements[0][0].rowSpan).toBe(3);
  });

  it('clamps a header-row span to the repeating-header block', () => {
    // continuationFrom reprints rows [0, 2) and then jumps to the body, so a
    // span crossing that seam paints across a discontinuity.
    const g = buildSpanGrid([[s(3, 1)], [s(1, 1)], [s(1, 1)], [s(1, 1)]], 2);
    expect(g.placements[0][0].rowSpan).toBe(2);
  });

  it('leaves a body span of the same length alone', () => {
    const g = buildSpanGrid(
      [[s(1, 1)], [s(1, 1)], [s(3, 1)], [s(1, 1)], [s(1, 1)]], 2);
    expect(g.placements[2][0].rowSpan).toBe(3);
  });
});

describe('buildSpanGrid: safeBreak', () => {
  it('reports the whole cut set, not just one index', () => {
    // A 3-row span starting at row 1 covers rows 1, 2 and 3, so cutting
    // before row 2 or before row 3 slices it. Cutting before row 1 or after
    // row 3 does not.
    const g = buildSpanGrid([[s(1, 1)], [s(3, 1)], [s(1, 1)], [s(1, 1)]], 0);
    expect(g.safeBreak).toEqual([true, true, false, false, true]);
  });

  it('makes every index safe for a table with no rowSpan', () => {
    const g = buildSpanGrid([[s(1, 1)], [s(1, 1)], [s(1, 1)]], 0);
    expect(g.safeBreak).toEqual([true, true, true, true]);
  });

  it('keeps the row after a repeating-header block safe', () => {
    // The header clamp is what guarantees it: a header span cannot leave the
    // block, so a continuation's [header..body] jump never slices one.
    const g = buildSpanGrid([[s(4, 1)], [s(1, 1)], [s(1, 1)], [s(1, 1)]], 2);
    expect(g.safeBreak[2]).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tablespan.test.ts`

Expected: FAIL — `Failed to resolve import "../src/tablespan.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/tablespan.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tablespan.test.ts`

Expected: PASS — 11 tests.

- [ ] **Step 5: Prove the clamps load-bearing**

A fixture passing on the first run is not evidence. Break each rule and confirm which case reddens.

1. Replace `Math.min(cell.rowSpan, rowCount - r)` with `cell.rowSpan`. Run the file: `clamps a span to the last row of the table` must FAIL, `leaves an in-range span alone` must PASS. Restore.
2. Delete the `if (r < header)` line. Run: `clamps a header-row span to the repeating-header block` and `keeps the row after a repeating-header block safe` must FAIL, `leaves a body span of the same length alone` must PASS. Restore.
3. Compute `columnCount` as the widest row's own `Σ colSpan` instead. Run: `counts a row whose columns are entirely inherited from above` must FAIL. Restore.

Expected: each mutation reddens its own case and leaves the others green.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/tablespan.ts test/tablespan.test.ts
git commit -m "feat(lucg.1): the pure occupancy grid behind table rowSpan

One walk turns a table's declared spans into absolute placements, a column
count and the set of rows it may be cut at. Both clamps are silent and both
are observable: a span past the last row and a header span leaving the
repeating block are clamped, and the clamped value is what every downstream
consumer reads.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Span height distribution

**Files:**
- Modify: `src/tablespan.ts` (append)
- Test: `test/tablespan.test.ts` (append)

**Interfaces:**
- Consumes: `SpanGrid`, `Placement` from Task 1.
- Produces:
  ```ts
  export function applySpanDeficits(
    grid: SpanGrid, rowHeights: number[], needs: readonly (readonly number[])[],
  ): void;
  ```
  Mutates `rowHeights` in place. `needs[row][i]` is the natural required height of the cell at `grid.placements[row][i]`.

- [ ] **Step 1: Write the failing test**

Append to `test/tablespan.test.ts` (extend the existing import at the top of the file to `import { buildSpanGrid, applySpanDeficits, type SpanShape } from '../src/tablespan.js';`):

```ts
describe('applySpanDeficits', () => {
  it('gives the whole shortfall to the LAST covered row', () => {
    // A 2-row cell needing 30 over rows that supply 10 + 10. Row 0 must be
    // left exactly as it was: a plain 1x1 cell is never floated in a box
    // taller than its own content asked for. Without that companion an even
    // distribution ([20, 20]) passes too.
    const g = buildSpanGrid([[s(2, 1), s(1, 1)], [s(1, 1)]], 0);
    const h = [10, 10];
    applySpanDeficits(g, h, [[30, 10], [10]]);
    expect(h).toEqual([10, 20]);
  });

  it('leaves the rows alone when the span already fits', () => {
    const g = buildSpanGrid([[s(2, 1), s(1, 1)], [s(1, 1)]], 0);
    const h = [10, 10];
    applySpanDeficits(g, h, [[15, 10], [10]]);
    expect(h).toEqual([10, 10]);
  });

  it('visits overlapping spans in order of last covered row', () => {
    // Two spans starting in row 0: a 3-row one listed FIRST, a 2-row one
    // listed second. Correct order satisfies the 2-row span first (it ends
    // sooner), after which the 3-row span measures against the enlarged rows
    // and needs nothing more.
    //
    //   in order : A(rows 0-1, needs 50) -> h = [10, 40, 10]
    //              B(rows 0-2, needs 60) -> has 60, adds 0
    //   reversed : B first -> h[2] += 30 -> [10, 10, 40]
    //              A then  -> h[1] += 30 -> [10, 40, 40]   (30pt over-allocated)
    //
    // Listing the LONG span first is what makes this case sharp: a build that
    // does not sort at all takes the listed order and lands on [10, 40, 40].
    const g = buildSpanGrid([[s(3, 1), s(2, 1)], [], []], 0);
    const h = [10, 10, 10];
    applySpanDeficits(g, h, [[60, 50], [], []]);
    expect(h).toEqual([10, 40, 10]);
  });

  it('ignores 1x1 cells entirely', () => {
    // Pass 1 has already sized the rows from these; pass 2 must not re-apply
    // them, which would double every row that holds a tall plain cell.
    const g = buildSpanGrid([[s(1, 1)], [s(1, 1)]], 0);
    const h = [10, 10];
    applySpanDeficits(g, h, [[99], [99]]);
    expect(h).toEqual([10, 10]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tablespan.test.ts`

Expected: FAIL — `applySpanDeficits` is not exported by `../src/tablespan.js`.

- [ ] **Step 3: Write the implementation**

Append to `src/tablespan.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tablespan.test.ts`

Expected: PASS — 15 tests.

- [ ] **Step 5: Prove the two load-bearing rules**

1. **Visit order.** Reverse the comparator (`(b.p.row + b.p.rowSpan) - (a.p.row + a.p.rowSpan)`). Run the file: `visits overlapping spans in order of last covered row` must FAIL with `[10, 40, 40]`, everything else green. Then *delete* the `sort` call entirely: the same single case must FAIL. Restore.
2. **Last-row deficit.** Spread the deficit evenly (`for (let r = p.row; r < p.row + p.rowSpan; r++) rowHeights[r] += (need - have) / p.rowSpan;`). Run: `gives the whole shortfall to the LAST covered row` must FAIL, `leaves the rows alone when the span already fits` must stay green. Restore.

Expected: each mutation reddens its own case only.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/tablespan.ts test/tablespan.test.ts
git commit -m "feat(lucg.1): span height distribution, last covered row wins

A spanning cell's shortfall goes entirely to the last row it covers, so no row
ever grows because of a span that starts above it. Spans are visited in order
of last covered row, which is what stops two overlapping spans from each
allocating the same height.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The model, and the grid inside `TableBuilder`

**Files:**
- Modify: `src/tableauthor.ts` (imports; `CellOptions`; `validateRowSpan`; `CellBuilder`; `RowBuilder.addCell`; `TableBuilder.spanGrid`; `columnCount`; `contentWidths`)
- Test: `test/table-rowspan.test.ts` (create)

**Interfaces:**
- Consumes: `buildSpanGrid`, `SpanGrid` from Task 1.
- Produces:
  - `CellOptions.rowSpan?: number`
  - `CellBuilder.rowSpan: number` (readonly, default 1), constructor signature `(text, options, colSpan = 1, rowSpan = 1, header?)`
  - `TableBuilder.spanGrid(): SpanGrid` (private — Task 4 calls it from `measure`)

- [ ] **Step 1: Write the failing test**

Create `test/table-rowspan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';

describe('rowSpan validation', () => {
  it('rejects a non-integer, a zero and a negative span', () => {
    const row = createTable().addRow();
    expect(() => row.addCell('a', { rowSpan: 1.5 })).toThrow(TypeError);
    expect(() => row.addCell('a', { rowSpan: 0 })).toThrow(TypeError);
    expect(() => row.addCell('a', { rowSpan: -1 })).toThrow(TypeError);
    expect(() => row.addCell('a', { rowSpan: '2' as never })).toThrow(TypeError);
  });

  it('leaves the row untouched when it rejects', () => {
    // Validation runs before the cell is constructed, so a rejected call
    // leaves the builder byte-identical.
    const row = createTable().addRow();
    expect(() => row.addCell('a', { rowSpan: 0 })).toThrow();
    expect(row.cells).toHaveLength(0);
  });

  it('accepts an integer >= 1 and defaults to 1', () => {
    const row = createTable().addRow();
    expect(row.addCell('a').rowSpan).toBe(1);
    expect(row.addCell('b', { rowSpan: 3 }).rowSpan).toBe(3);
  });

  it('does not leak rowSpan into the cell style', () => {
    // rowSpan is destructured out of the options before validateStyleOpts,
    // exactly as colSpan and header are.
    const row = createTable().addRow();
    const c = row.addCell('a', { rowSpan: 2, colSpan: 2 });
    expect(c.options).toEqual({});
  });
});

describe('column count with a rowSpan', () => {
  it('counts a row whose columns are all inherited from above', () => {
    // Row 1 lists no cells of its own and still occupies both columns. The
    // old widest-row reduction returns 0 for it, which would shrink the table
    // and make resolveColumnWidths reject a valid setColumnWidths.
    const t = createTable({ padding: 0 });
    const r0 = t.addRow();
    r0.addCell('a', { rowSpan: 2 });
    r0.addCell('b', { rowSpan: 2 });
    t.addRow();
    expect(t.resolveColumnWidths(100)).toEqual([50, 50]);
  });

  it('leaves a spanless table column count unchanged', () => {
    const t = createTable({ padding: 0 });
    t.addRow(['a', 'b', 'c']);
    t.addRow(['d']);
    expect(t.resolveColumnWidths(300)).toEqual([100, 100, 100]);
  });
});

describe('autoFitColumns with a rowSpan', () => {
  it('measures a 1x1 cell into the column the grid put it in', () => {
    // Row 1's only cell sits in column 1, not column 0: column 0 is held by
    // the span above it. A cursor that does not know about the span would
    // charge 'wwwwwwwwww' to column 0 and size the table backwards.
    const t = createTable({ font: 'Helvetica', fontSize: 10, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('i', { rowSpan: 2 });
    r0.addCell('i');
    t.addRow().addCell('wwwwwwwwww');
    t.autoFitColumns();
    const [w0, w1] = t.resolveColumnWidths(200);
    expect(w1).toBeGreaterThan(w0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/table-rowspan.test.ts`

Expected: FAIL — `rowSpan` is not a known property of `CellOptions`, and `addCell('a', { rowSpan: 0 })` does not throw.

- [ ] **Step 3: Add the model**

In `src/tableauthor.ts`, add the import beside the existing ones:

```ts
import { buildSpanGrid, applySpanDeficits, type SpanGrid } from './tablespan.js';
```

`applySpanDeficits` is unused until Task 4. If the lint setup rejects an unused import, add only `buildSpanGrid` and `SpanGrid` now and extend the line in Task 4.

Add `rowSpan` to `CellOptions`, right after `colSpan`:

```ts
export interface CellOptions extends CellTextOptions {
  /** Number of columns this cell spans. Integer >= 1. Default 1. */
  colSpan?: number;
  /** Number of rows this cell spans. Integer >= 1. Default 1. Rows below a
   *  spanning cell OMIT the covered cells, as HTML does — there is no
   *  placeholder vocabulary, because a placeholder would be a second way to
   *  say the same thing and the two would drift.
   *
   *  Clamped, silently, to the table's last row and (for a cell in the
   *  repeating-header rows) to the end of the header block. Rows are appended
   *  after `addCell`, so a caller cannot know the final row count when they
   *  set the span; the clamped value is what a tagged table's /RowSpan
   *  states. */
  rowSpan?: number;
  /** Emit this cell as a /TH rather than a /TD when the table is drawn with
   *  `{ tagged: true }`. Default: cells in the repeating-header rows are column
   *  headers, every other cell is a /TD. Ignored when the table is drawn
   *  untagged. */
  header?: CellHeader;
}
```

Add the validator beside `validateColSpan`:

```ts
function validateRowSpan(n: number): void {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new TypeError('rowSpan must be an integer >= 1');
}
```

Give `CellBuilder` the field, beside `colSpan`:

```ts
  constructor(
    public text: string | TextRun[],
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
    readonly rowSpan: number = 1,
    readonly header?: CellHeader,
  ) {}
```

And update `RowBuilder.addCell`, its sole construction site:

```ts
  addCell(text: string | TextRun[] = '', opts: CellOptions = {}): CellBuilder {
    const { colSpan = 1, rowSpan = 1, header, ...style } = opts;
    validateColSpan(colSpan);
    validateRowSpan(rowSpan);
    validateHeader(header);
    validateStyleOpts(style);
    const c = new CellBuilder(text, style, colSpan, rowSpan, header);
    this.cells.push(c);
    return c;
  }
```

- [ ] **Step 4: Route `columnCount` and `contentWidths` through the grid**

In `TableBuilder`, add the private builder above `contentWidths`:

```ts
  /** @internal The occupancy grid for the rows as they stand.
   *
   *  Rebuilt on each call rather than cached: rows and cells are mutable right
   *  up to draw time (`addRow`, `setMinHeight`, `setImage`), and a cache would
   *  have to be invalidated from every one of them. The walk is O(cells) over
   *  data already in memory, against a `measure` that wraps every string in
   *  the table.
   *
   *  It cannot be a by-product of measuring: `resolveColumnWidths` runs first
   *  and needs the column count. */
  private spanGrid(): SpanGrid {
    return buildSpanGrid(
      this.rows.map((r) => r.cells.map((c) => ({ rowSpan: c.rowSpan, colSpan: c.colSpan }))),
      Math.min(this._repeatingRows, this.rows.length));
  }
```

Replace `columnCount`:

```ts
  /** @internal Physical column count: forced (continuation tables) or
   *  `max(col + colSpan)` over the grid.
   *
   *  Not the widest row's total colSpan: a row whose columns are all inherited
   *  from a span above lists no cells at all, and that reduction returns 0 for
   *  it — shrinking the table, and making `resolveColumnWidths` reject a valid
   *  `setColumnWidths`. For a table with no rowSpan the two agree by
   *  construction. */
  private columnCount(): number {
    if (this.forcedColumnCount !== undefined) return this.forcedColumnCount;
    return this.spanGrid().columnCount;
  }
```

Replace `contentWidths`'s cursor with grid reads:

```ts
  private contentWidths(tablePadding?: number): { max: number[]; min: number[] } {
    const n = this.columnCount();
    const max = new Array<number>(n).fill(0);
    const min = new Array<number>(n).fill(0);
    const { placements } = this.spanGrid();
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const p = placements[r][i];
        // A spanning cell contributes to no single column: attributing its
        // width to one of the columns it covers would be arbitrary, which is
        // the choice CSS auto-layout makes for the same reason. rowSpan does
        // not enter this rule at all — a tall cell is still exactly as wide as
        // the columns it covers.
        if (p.colSpan === 1 && p.col < n) {
          const st = resolveCellStyle(cell, row.style, this.defaults, tablePadding);
          const pad = st.padding.left + st.padding.right;
          const { longestLine, longestWord } = cellExtents(cell.text, st);
          max[p.col] = Math.max(max[p.col], longestLine + pad);
          min[p.col] = Math.max(min[p.col], longestWord + pad);
        }
      }
    }
    return { max, min };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/table-rowspan.test.ts test/table-autofit.test.ts test/table-author.test.ts`

Expected: PASS.

- [ ] **Step 6: Check the byte-identity fence**

Run: `npx vitest run test/table-slice-identity.test.ts`

Expected: PASS with the hash `be2bd211ea459e23` unchanged. **If it fails, stop.** The grid changed the placement of a cell that has no span; find out why rather than re-recording the hash.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/tableauthor.ts test/table-rowspan.test.ts
git commit -m "feat(lucg.1): CellOptions.rowSpan, and one grid inside TableBuilder

The column count moves from the widest row's total colSpan to the grid's
max(col + colSpan), which is the same number for every table that declares no
rowSpan and the right one for a row whose columns are all inherited from
above. contentWidths reads the grid rather than walking its own cursor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Two-pass measurement

**Files:**
- Modify: `src/tableauthor.ts` (`TableMetrics`, `measure`)
- Test: `test/table-rowspan.test.ts` (append)

**Interfaces:**
- Consumes: `TableBuilder.spanGrid()` (Task 3), `applySpanDeficits` (Task 2).
- Produces: `TableMetrics.grid: SpanGrid` — Tasks 5, 6 and 7 read it. `rowHeights`, `totalHeight` and `cellLines` keep their existing shape and meaning, so every current caller compiles and behaves unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/table-rowspan.test.ts`:

```ts
describe('measure with a rowSpan', () => {
  const TALL = 'one two three four five six seven eight nine ten';

  /** The natural height of TALL in a 40pt column, measured rather than
   *  assumed — the wrapped line count is a property of Helvetica's metrics,
   *  not something a test should hard-code. */
  const soloHeight = (): number => {
    const solo = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    solo.addRow([TALL]);
    return solo.measure([40]).rowHeights[0];
  };

  const spanned = () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell(TALL, { rowSpan: 2 });
    r0.addCell('a');
    t.addRow().addCell('b');
    return t;
  };

  it('needs more than its two rows supply (fixture sanity)', () => {
    // Without this the deficit branch is never reached and the case below
    // passes for the wrong reason.
    expect(soloHeight()).toBeGreaterThan(24);
  });

  it('grows only the LAST covered row', () => {
    const { rowHeights } = spanned().measure([40, 60]);
    // Row 0 is exactly one line, unchanged by the tall cell that starts in it.
    // Without this companion an even distribution passes too.
    expect(rowHeights[0]).toBeCloseTo(12, 6);
    expect(rowHeights[0] + rowHeights[1]).toBeCloseTo(soloHeight(), 6);
  });

  it('leaves totalHeight the sum of rowHeights', () => {
    const m = spanned().measure([40, 60]);
    expect(m.totalHeight).toBeCloseTo(m.rowHeights[0] + m.rowHeights[1], 6);
  });

  it('carries the grid the measurement was taken against', () => {
    const m = spanned().measure([40, 60]);
    expect(m.grid.placements[1][0]).toEqual({ row: 1, col: 1, rowSpan: 1, colSpan: 1 });
    expect(m.grid.safeBreak).toEqual([true, false, true]);
  });

  it('wraps a spanning cell to the columns it covers, not to one', () => {
    // A 2x2 cell measures against 40 + 60 = 100pt, so it wraps to fewer lines
    // than the same text in a 40pt column.
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    t.addRow().addCell(TALL, { rowSpan: 2, colSpan: 2 });
    t.addRow();
    const { rowHeights } = t.measure([40, 60]);
    expect(rowHeights[0] + rowHeights[1]).toBeLessThan(soloHeight());
  });

  it('still floors a row at its minHeight', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('x', { rowSpan: 2 });
    r0.addCell('a');
    t.addRow(undefined, { minHeight: 50 }).addCell('b');
    const { rowHeights } = t.measure([40, 60]);
    expect(rowHeights[1]).toBeCloseTo(50, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/table-rowspan.test.ts`

Expected: FAIL — `m.grid` does not exist on `TableMetrics`, and `grows only the LAST covered row` fails because the tall cell currently sizes row 0.

- [ ] **Step 3: Add `grid` to `TableMetrics`**

```ts
/** Measurement result for a table at given resolved column widths. */
export interface TableMetrics {
  /** Per-row laid height in points. */
  rowHeights: number[];
  /** Sum of `rowHeights`. */
  totalHeight: number;
  /** `cellLines[row][col]` = the wrapped line texts of that cell. */
  cellLines: string[][][];
  /** @internal The occupancy grid this measurement was taken against. Both
   *  pagination loops already call `measure`, so the safe-break set arrives
   *  where it is needed without a second computation and without a new
   *  parameter. */
  grid: SpanGrid;
}
```

- [ ] **Step 4: Rewrite `measure`'s body**

Replace everything from `const rowHeights: number[] = [];` down to the `return`, keeping the validation above it untouched:

```ts
    const grid = this.spanGrid();
    const rowHeights: number[] = [];
    const cellLines: string[][][] = [];
    // Pass 1's per-cell natural heights, parallel to the placements, for the
    // pass-2 deficit walk.
    const needs: number[][] = [];

    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const rowCellLines: string[][] = [];
      const rowNeeds: number[] = [];
      let rowHeight = row.minHeight;
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const p = grid.placements[r][i];
        if (p.col + p.colSpan > columnWidths.length)
          throw new TypeError(`a row's spans overrun the ${columnWidths.length} provided columns`);
        let outerWidth = 0;
        for (let k = 0; k < p.colSpan; k++) outerWidth += columnWidths[p.col + k];
        const st = resolveCellStyle(cell, row.style, this.defaults, override);
        const innerWidth = outerWidth - st.padding.left - st.padding.right;
        if (innerWidth <= 0)
          throw new TypeError("each cell span width must exceed the cell's horizontal padding");
        // A run cell validates before it measures, so a malformed run is
        // rejected while the table is still untouched rather than at draw time,
        // where resolveRuns would catch it after the caller had committed.
        if (isTextRunList(cell.text)) {
          for (let j = 0; j < cell.text.length; j++) {
            const run = cell.text[j];
            if (typeof run?.text !== 'string')
              throw new TypeError(`cell run ${j}: text must be a string`);
            if (run.link !== undefined && (typeof run.link !== 'string' || run.link === ''))
              throw new TypeError(`cell run ${j}: link must be a non-empty string`);
          }
        }
        // Runs measure through layoutRuns, the SAME engine layoutText wraps, so
        // a cell's computed height cannot disagree with what the renderer draws.
        const res = isTextRunList(cell.text)
          ? layoutRuns(
            cell.text.map((run) => ({
              text: run.text,
              driver: measuringDriverFor(run.font ?? st.font),
              fontSize: run.fontSize ?? st.fontSize,
            })),
            innerWidth, Infinity, st.leading, st.fontSize)
          : layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        // Sum the line bands rather than lineCount * leading: a cell run larger
        // than the cell's font size claims a taller band, and a row sized on the
        // flat product would let its glyphs spill out of the row.
        const textHeight = res.lines.length === 0
          ? st.leading                       // an empty cell still occupies a line
          : res.lines.reduce((n, l) => n + l.height, 0);
        const imageHeight = cell.image
          ? (cell.image.opts.height ?? cell.image.height * innerWidth / cell.image.width)
          : 0;
        const need = Math.max(textHeight, imageHeight) + st.padding.top + st.padding.bottom;
        // Only a 1x1 cell sizes its row here. A spanning cell's shortfall is
        // settled in pass 2, against the rows it actually covers — sizing its
        // top row by its whole height is what makes the row above a tall span
        // grow for no reason of its own.
        if (p.rowSpan === 1) rowHeight = Math.max(rowHeight, need);
        rowNeeds.push(need);
        rowCellLines.push(res.lines.map((l) => l.text));
      }
      rowHeights.push(rowHeight);
      cellLines.push(rowCellLines);
      needs.push(rowNeeds);
    }

    // Pass 2.
    applySpanDeficits(grid, rowHeights, needs);
    return { rowHeights, totalHeight: rowHeights.reduce((a, b) => a + b, 0), cellLines, grid };
```

Note the renamed loop variables (`i`, `j`, `run`): the old body used `i` for the run index, which now names the cell index.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/table-rowspan.test.ts test/table-author.test.ts test/table-render.test.ts test/table-cell-runs.test.ts`

Expected: PASS.

- [ ] **Step 6: Check the fence and the wider table suite**

```bash
npx vitest run test/table-slice-identity.test.ts
npx vitest run test/table-borders.test.ts test/table-decoration.test.ts test/table-nested.test.ts test/table-authoring-tagged.test.ts test/flow-table.test.ts test/markdown-tables.test.ts
```

Expected: PASS, hash unchanged.

- [ ] **Step 7: Prove the pass-1 guard load-bearing**

Remove the `if (p.rowSpan === 1)` guard so every cell sizes its row. Run `npx vitest run test/table-rowspan.test.ts`: `grows only the LAST covered row` must FAIL (row 0 takes the tall cell's whole height). Restore.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/tableauthor.ts test/table-rowspan.test.ts
git commit -m "feat(lucg.1): two-pass measurement for a spanning cell

Pass 1 sizes each row from its 1x1 cells alone; pass 2 gives every spanning
cell's shortfall to the last row it covers. TableMetrics carries the grid the
measurement was taken against, so both pagination loops get the safe-break set
from a call they already make.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Painting the span box

**Files:**
- Modify: `src/tablerender.ts` (`placeRows`, `paintRowSlice`, `drawTable`'s `measure` destructure and `paintRows` closure)
- Modify: `src/flowtable.ts` (`metrics` returns the grid; `place` forwards it)
- Test: `test/table-rowspan.test.ts` (append)

**Interfaces:**
- Consumes: `TableMetrics.grid` (Task 4).
- Produces: `paintRowSlice(doc, page, table, rowIndices, rowHeights, grid, columnX, widths, sliceTop, x, tablePadding, outerBorder, tagged, tagger)` — the `grid: SpanGrid` parameter is **inserted after `rowHeights`**, it being the other half of the same measurement. Task 7 calls this from `flowtable.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/table-rowspan.test.ts`, adding these imports at the top of the file:

```ts
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
```

```ts
describe('painting a spanning cell', () => {
  it('fills the full span box, not one row', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('S', { rowSpan: 2, background: [1, 0, 0] });
    r0.addCell('a');
    t.addRow().addCell('b');
    const { rowHeights } = t.measure([50, 50]);
    page.AddTable(t, 20, 700, { width: 100 });

    // GetPaths reports colour components in 0..255, not 0..1.
    const red = page.GetPaths().filter(
      (p) => p.fill !== null && p.fill.rgb[0] === 255 && p.fill.rgb[1] === 0 && p.fill.rgb[2] === 0);
    expect(red).toHaveLength(1);
    const [x0, y0, x1, y1] = red[0].bbox;
    expect(x0).toBeCloseTo(20, 4);
    expect(x1).toBeCloseTo(70, 4);
    // Top at the table top, bottom at the SECOND row's bottom edge.
    expect(y1).toBeCloseTo(700, 4);
    expect(y1 - y0).toBeCloseTo(rowHeights[0] + rowHeights[1], 4);
  });

  it('spans columns and rows together', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    t.addRow().addCell('S', { rowSpan: 2, colSpan: 2, background: [1, 0, 0] });
    t.addRow();
    const { rowHeights } = t.measure([50, 50]);
    page.AddTable(t, 20, 700, { width: 100 });
    const red = page.GetPaths().filter(
      (p) => p.fill !== null && p.fill.rgb[0] === 255 && p.fill.rgb[1] === 0)[0];
    expect(red.bbox[2] - red.bbox[0]).toBeCloseTo(100, 4);
    expect(red.bbox[3] - red.bbox[1]).toBeCloseTo(rowHeights[0] + rowHeights[1], 4);
  });

  it('puts a cell below a span in the right column', () => {
    // Row 1's only cell must be drawn at x = 70, not x = 20.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('S', { rowSpan: 2 });
    r0.addCell('a');
    t.addRow().addCell('b', { background: [0, 0, 1] });
    page.AddTable(t, 20, 700, { width: 100 });
    const blue = page.GetPaths().filter(
      (p) => p.fill !== null && p.fill.rgb[2] === 255 && p.fill.rgb[0] === 0)[0];
    expect(blue.bbox[0]).toBeCloseTo(70, 4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/table-rowspan.test.ts`

Expected: FAIL — the red fill is one row tall, and the blue cell is drawn at x = 20.

- [ ] **Step 3: Rewrite `placeRows`**

In `src/tablerender.ts`, add the type import:

```ts
import type { SpanGrid } from './tablespan.js';
```

Replace `placeRows`:

```ts
/** Place the cells of the rows named by `rowIndices` (in the given order) with
 *  the first row's top at `top`, stacking downward. `columnX` are prefix-sum
 *  column left edges; `grid` says which column each cell landed in and how far
 *  down it reaches, so this walk and `measure`'s cannot disagree.
 *
 *  `rowIndices` may be non-contiguous — a repeating-header prefix followed by a
 *  body range. That is safe because both of the grid's clamps and the
 *  pagination back-off guarantee every spanned row is contiguous WITHIN the
 *  slice: a header span cannot leave the header block, and a body slice is
 *  never cut inside a span. So the accumulated `rowTop` walk still yields the
 *  right `bottom`, and no cell is ever placed against a row that is not on the
 *  page. */
function placeRows(
  table: TableBuilder, rowIndices: number[],
  rowHeights: number[], grid: SpanGrid, columnX: number[], widths: number[], top: number,
  tablePadding?: number, tagger?: TableTagger,
): Placed[] {
  const placed: Placed[] = [];
  let rowTop = top;
  for (const r of rowIndices) {
    const rowBottom = rowTop - rowHeights[r];
    tagger?.beginRow();
    const row = table.rows[r];
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i];
      const p = grid.placements[r][i];
      let cellW = 0;
      for (let k = 0; k < p.colSpan; k++) cellW += widths[p.col + k];
      // A spanning cell's background, border and text box are its FULL span
      // box: the three paint passes read `h` and need no change at all.
      let cellH = 0;
      for (let k = 0; k < p.rowSpan; k++) cellH += rowHeights[p.row + k];
      const struct = tagger?.cell(cell, r, table.repeatingRowCount);
      // Appended here, not in the image pass: paintPlaced draws every image
      // before any text, so allocating the /Figure at cell-creation time is what
      // keeps a cell's /K in reading order — [Figure, textMcid].
      const figure = struct !== undefined && cell.image !== undefined && !cell.image.opts.artifact
        ? tagger!.figure(struct, cell.image.opts.alt)
        : undefined;
      placed.push({
        x: columnX[p.col], bottom: rowTop - cellH, w: cellW, h: cellH,
        text: cell.text,
        style: resolveCellStyle(cell, row.style, table.defaults, tablePadding),
        image: cell.image, struct, figure,
      });
    }
    rowTop = rowBottom;
  }
  return placed;
}
```

`tagger.cell` keeps its three existing arguments here; Task 8 adds `p.rowSpan` as a fourth once `TableTagger.cell` accepts one.

- [ ] **Step 4: Thread the grid through `paintRowSlice` and `drawTable`**

`paintRowSlice`:

```ts
export function paintRowSlice(
  doc: Document, page: Page, table: TableBuilder,
  rowIndices: number[], rowHeights: number[], grid: SpanGrid,
  columnX: number[], widths: number[],
  sliceTop: number, x: number, tablePadding: number | undefined,
  outerBorder: BorderInfo | undefined, tagged: boolean, tagger?: TableTagger,
): void {
  if (rowIndices.length === 0) return;
  let h = 0;
  for (const r of rowIndices) h += rowHeights[r];
  const tableWidth = columnX[widths.length] - x;
  const placed = placeRows(
    table, rowIndices, rowHeights, grid, columnX, widths, sliceTop, tablePadding, tagger);
  paintPlaced(doc, page, placed, outerBorder,
    { x, bottom: sliceTop - h, w: tableWidth, h }, tagged);
}
```

In `drawTable`, take the grid from the measurement and pass it on:

```ts
  const { rowHeights, grid } = table.measure(widths, { cellPadding: padding });
```

```ts
    paintRowSlice(doc, pg, table, rowIndices, rowHeights, grid, columnX, widths,
      sliceTop, x, padding, ob, tagged, tagging.tagger);
```

- [ ] **Step 5: Update `flowtable.ts`'s call site**

In `src/flowtable.ts`, add the type import, carry the grid through `metrics`, and pass it to `paintRowSlice`:

```ts
import type { SpanGrid } from './tablespan.js';
```

```ts
  /** Column widths, per-row heights and the grid they were measured against,
   *  for a column of `width` points. */
  private metrics(width: number): { widths: number[]; rowHeights: number[]; grid: SpanGrid } {
    const widths = this.t.resolveColumnWidths(
      this.o.width ?? width, { cellPadding: this.o.cellPadding });
    // An empty table returns before anything reads the grid.
    if (widths.length === 0)
      return { widths, rowHeights: [], grid: { placements: [], columnCount: 0, safeBreak: [true] } };
    const m = this.t.measure(widths, { cellPadding: this.o.cellPadding });
    return { widths, rowHeights: m.rowHeights, grid: m.grid };
  }
```

In `place`, destructure `grid` and pass it:

```ts
    const { widths, rowHeights, grid } = this.metrics(ctx.width);
```

```ts
    paintRowSlice(
      ctx.doc, ctx.page, this.t, indices, rowHeights, grid, columnX, widths,
      ctx.top, ctx.x, this.o.cellPadding,
      this.t.defaults.outerBorder as BorderInfo | undefined,
      ctx.structParent !== undefined, this.tagger);
```

`TableElement.measure` still destructures `{ rowHeights }` only — Task 7 changes it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/table-rowspan.test.ts test/table-render.test.ts test/table-borders.test.ts test/table-decoration.test.ts test/flow-table.test.ts`

Expected: PASS.

- [ ] **Step 7: Check the fence**

Run: `npx vitest run test/table-slice-identity.test.ts`

Expected: PASS, hash `be2bd211ea459e23` unchanged.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/tablerender.ts src/flowtable.ts test/table-rowspan.test.ts
git commit -m "feat(lucg.1): paint a spanning cell over its full span box

placeRows stops walking its own colspan cursor and reads the grid the
measurement was taken against, so the two can no longer disagree about which
column a cell landed in. A cell's box is the sum of the columns and the rows
it covers; the three paint passes needed no change at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: `page.AddTable` pagination backs off

**Files:**
- Modify: `src/tablerender.ts` (`drawTable`'s row loop)
- Test: `test/table-rowspan.test.ts` (append)

**Interfaces:**
- Consumes: `grid.safeBreak` (Task 4), already in scope in `drawTable` from Task 5.
- Produces: no new API. `AddTableResult.remainder` now always starts at a safe break, so `continuationFrom` needs no change.

- [ ] **Step 1: Write the failing test**

Append to `test/table-rowspan.test.ts`:

```ts
describe('page.AddTable pagination with a rowSpan', () => {
  /** 20 rows of exactly 12pt (leading 12, no padding, one line each). Column 0
   *  always carries the label `r{i}`; column 1 carries a filler, except at row
   *  9 where it spans down into row 10 — so row 10 lists only its label. */
  const build = () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    for (let i = 0; i < 20; i++) {
      const row = t.addRow();
      row.addCell(`r${i}`);
      if (i === 9) row.addCell('joined', { rowSpan: 2 });
      else if (i !== 10) row.addCell('x');
    }
    return t;
  };

  it('lays every row out at 12pt (fixture sanity)', () => {
    // The pagination arithmetic below is exact and depends on this.
    const { rowHeights } = build().measure([100, 100]);
    expect(rowHeights).toHaveLength(20);
    for (const h of rowHeights) expect(h).toBeCloseTo(12, 6);
  });

  it('cuts before the span group, not inside it', () => {
    // top 700, bottomMargin 575 => 125pt available => rows 0..9 fit (120) and
    // row 10 does not (132). The natural cut is at index 10, which is INSIDE
    // the group that starts at row 9, so it backs off to 9.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = build();
    const res = page.AddTable(t, 20, 700, { width: 200, bottomMargin: 575 });
    expect(res.remainder).toBeDefined();
    // The continuation holds the SAME RowBuilder references, so this is the
    // sharpest available statement of WHICH row starts page 2. Asserting only
    // that a remainder exists is satisfied with the back-off removed.
    expect(res.remainder!.rows[0]).toBe(t.rows[9]);
    // usedHeight is recomputed for the shorter slice: 9 rows, not 10.
    expect(res.endY).toBeCloseTo(700 - 9 * 12, 4);
  });

  it('cuts at the natural row when that row is already a safe break', () => {
    // Companion: the back-off must not fire when it is not needed, or every
    // paginated table loses a row per page.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    for (let i = 0; i < 20; i++) t.addRow([`r${i}`, 'x']);
    const res = page.AddTable(t, 20, 700, { width: 200, bottomMargin: 575 });
    expect(res.remainder!.rows[0]).toBe(t.rows[10]);
    expect(res.endY).toBeCloseTo(700 - 10 * 12, 4);
  });

  it('draws an over-tall span group anyway rather than throwing', () => {
    // A group by itself taller than the page has no safe cut to back off to.
    // It falls through to the existing "draw it anyway" path, which is what a
    // single oversized row does today — no new error is introduced.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow(undefined, { minHeight: 200 });
    r0.addCell('a');
    r0.addCell('joined', { rowSpan: 2 });
    t.addRow(undefined, { minHeight: 200 }).addCell('b');
    t.addRow(['c', 'd']);
    const res = page.AddTable(t, 20, 300, { width: 200 });
    // The whole group was drawn, overflowing; the cut is after it.
    expect(res.remainder!.rows[0]).toBe(t.rows[2]);
  });

  it('auto-paginates onto a second page at the safe break', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = build();
    const res = page.AddTable(t, 20, 700, {
      width: 200, bottomMargin: 575, autoPaginate: true,
    });
    expect(res.pages).toHaveLength(2);
    expect(res.pages[0].GetText()).toMatch(/\br8\b/);
    expect(res.pages[0].GetText()).not.toMatch(/\br9\b/);
    expect(res.pages[1].GetText()).toMatch(/\br9\b/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/table-rowspan.test.ts`

Expected: FAIL — `cuts before the span group, not inside it` reports `t.rows[10]`, and page 1 carries `r9`.

- [ ] **Step 3: Add the back-off**

In `drawTable`, replace the body of the `if (!fits && rowsOnThisPage > 0)` branch:

```ts
    if (!fits && rowsOnThisPage > 0) {
      // A rowSpan group is atomic across a break: back off to the largest cut
      // at or before `i` that slices no span. `safeBreak[headerCount]` is
      // always true — a header span is clamped to the header block — so the
      // body's own start is reachable.
      let cut = i;
      while (cut > sliceStartRow && !grid.safeBreak[cut]) cut--;
      if (cut === sliceStartRow) {
        // The span group starting here is by itself taller than the page.
        // Fall through to the existing "draw it anyway" path, which is what a
        // single oversized row does today: no new error, and the failure mode
        // for an over-tall group is the one callers already know.
        usedHeight += h;
        rowsOnThisPage++;
        continue;
      }
      let used = onContinuation ? headerHeight : 0;
      for (let r = sliceStartRow; r < cut; r++) used += rowHeights[r];
      usedHeight = used;
      const body = rangeIndices(sliceStartRow, cut);
      paintRows(currentPage, onContinuation ? [...headerIndices, ...body] : body, sliceTop);
      if (!autoPaginate)
        return {
          pages, endY: sliceTop - usedHeight, remainder: table.continuationFrom(cut),
          struct: tagging.tagger?.table,
        };
      // Append a page sized to the anchor and continue from its top.
      currentPage = doc.AddPage().page;
      currentPage.MediaBox = [...anchorMediaBox];
      pages.push(currentPage);
      cb = currentPage.CropBox;
      bottomLine = cb[1] + bottomMargin;
      sliceTop = cb[3] - topMargin;
      sliceStartRow = Math.max(cut, headerCount);   // body never re-lists a header row
      onContinuation = true;
      usedHeight = headerHeight;                    // header consumes space up top
      rowsOnThisPage = 0;
      i = sliceStartRow - 1;                        // retry the first body row on the new page
      continue;
    }
```

Everything else in the loop is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-rowspan.test.ts test/table-render.test.ts`

Expected: PASS.

- [ ] **Step 5: Prove the back-off load-bearing**

Replace `while (cut > sliceStartRow && !grid.safeBreak[cut]) cut--;` with nothing. Run `npx vitest run test/table-rowspan.test.ts`:

- `cuts before the span group, not inside it` must FAIL
- `auto-paginates onto a second page at the safe break` must FAIL
- `cuts at the natural row when that row is already a safe break` must stay GREEN — that is what proves the back-off does not fire when it should not

Restore.

- [ ] **Step 6: Run the wider suite plus the fence**

```bash
npx vitest run test/table-slice-identity.test.ts
npx vitest run test/table-render.test.ts test/table-author.test.ts test/table-borders.test.ts test/table-tagged.test.ts test/table-authoring-tagged.test.ts test/flow-table.test.ts test/toc.test.ts
```

Expected: PASS, hash unchanged.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/tablerender.ts test/table-rowspan.test.ts
git commit -m "feat(lucg.1): page.AddTable cuts before a span group, never inside it

When the row that does not fit sits inside a rowSpan group, the cut backs off
to the largest safe break above it and usedHeight is recomputed for the
shorter slice. A group by itself taller than the page has no safe cut and
falls through to the existing draw-it-anyway path, which is what an oversized
single row already does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: `flow.AddTable` pagination backs off

**Files:**
- Modify: `src/flowtable.ts` (`fit`, `measure`, `place`)
- Test: `test/flow-table.test.ts` (append)

**Interfaces:**
- Consumes: `TableMetrics.grid` (Task 4), already carried by `metrics` from Task 5.
- Produces: no new API. `FlowTableOptions` gains nothing — a span is a property of a cell, not of a placement.

- [ ] **Step 1: Write the failing test**

Append to `test/flow-table.test.ts`. The file already imports `Document`, `PageFormat` and `createTable` — check before adding a duplicate import.

```ts
describe('Flow.AddTable with a rowSpan', () => {
  /** 60 rows of exactly 12pt. Column 0 always carries the label `r{i}`, so a
   *  row is findable in the rendered text whether or not its column-1 cell is
   *  inherited from the span above. */
  const rowsWithSpan = (spanAt?: number) => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const covered = spanAt === undefined ? -1 : spanAt + 1;
    for (let i = 0; i < 60; i++) {
      const row = t.addRow();
      row.addCell(`r${i}`);
      if (i === spanAt) row.addCell('joined', { rowSpan: 2 });
      else if (i !== covered) row.addCell('x');
    }
    return t;
  };

  /** Render one table into a single-column flow on a 400x500 page with 50pt
   *  margins — a 400pt tall column. */
  const render = (t: ReturnType<typeof rowsWithSpan>) => {
    const doc = Document.New();
    const flow = doc.NewFlow({
      format: PageFormat.custom(400, 500),
      marginLeft: 50, marginRight: 50, marginTop: 50, marginBottom: 50,
    });
    flow.AddTable(t);
    return flow.Render();
  };

  /** The index of the first row NOT on page 1. */
  const firstOverflowRow = (pages: ReturnType<typeof render>): number => {
    const text = pages[0].GetText();
    for (let i = 0; i < 60; i++)
      if (!new RegExp(`\\br${i}\\b`).test(text)) return i;
    return 60;
  };

  it('splits a spanless table at some row (calibration)', () => {
    const k = firstOverflowRow(render(rowsWithSpan()));
    expect(k).toBeGreaterThan(1);
    expect(k).toBeLessThan(60);
  });

  it('does not cut a rowSpan group across a column break', () => {
    // Put the span across (k-1, k): the natural cut at k is then unsafe, and
    // the element must back off to k-1. Row heights are identical between the
    // two tables, so k is the same for both.
    const k = firstOverflowRow(render(rowsWithSpan()));
    const pages = render(rowsWithSpan(k - 1));
    // Asserting merely that two pages exist is satisfied with the back-off
    // removed: assert WHICH row opened the second page.
    expect(firstOverflowRow(pages)).toBe(k - 1);
    expect(pages[1].GetText()).toMatch(new RegExp(`\\br${k - 1}\\b`));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flow-table.test.ts`

Expected: FAIL — `does not cut a rowSpan group across a column break` reports `k`, not `k - 1`.

- [ ] **Step 3: Add the back-off to `fit`**

In `src/flowtable.ts`:

```ts
  /** How many leading rows fit in `availHeight`, and their height. */
  private fit(
    rowHeights: number[], availHeight: number, safeBreak: boolean[],
  ): { rows: number; height: number } {
    let rows = 0;
    let height = 0;
    for (const h of rowHeights) {
      if (height + h > availHeight + EPS) break;
      height += h;
      rows++;
    }
    // A rowSpan group is atomic: back off to a legal cut. Reaching 0 returns
    // the existing "not one row fits, retry in the next column" result, and the
    // engine's "does not fit in an empty column" error then covers a group
    // taller than a whole column — exactly the atomic-element rule an oversized
    // image already meets.
    while (rows > 0 && !safeBreak[rows]) {
      rows--;
      height -= rowHeights[rows];
    }
    return { rows, height };
  }
```

Update both callers:

```ts
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { rowHeights, grid } = this.metrics(ctx.width);
    const { rows, height } = this.fit(rowHeights, ctx.availHeight, grid.safeBreak);
    return { usedHeight: height, fits: rows === this.t.rows.length && rows > 0 };
  }
```

and, in `place`:

```ts
    const { rows, height } = this.fit(rowHeights, ctx.availHeight, grid.safeBreak);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow-table.test.ts test/table-rowspan.test.ts`

Expected: PASS.

- [ ] **Step 5: Prove the back-off load-bearing**

Delete the `while (rows > 0 && !safeBreak[rows])` loop. Run `npx vitest run test/flow-table.test.ts`: `does not cut a rowSpan group across a column break` must FAIL, and every pre-existing case in the file — including `splits across pages and repeats the header` and `splits across columns` — must stay GREEN. Restore.

- [ ] **Step 6: Run the flow suite plus the fence**

```bash
npx vitest run test/table-slice-identity.test.ts
npx vitest run test/flow-table.test.ts test/flow.test.ts test/markdown-flow.test.ts test/markdown-tables.test.ts test/flow-tagging.test.ts
```

Expected: PASS, hash unchanged.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/flowtable.ts test/flow-table.test.ts
git commit -m "feat(lucg.1): a flow table's column break lands on a safe cut

fit backs off while the leading row count would slice a rowSpan group.
Reaching zero is the existing 'not one row fits, retry in the next column'
result, so a group taller than a whole column reaches the engine's own
does-not-fit error rather than a new one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `/RowSpan` on the authored cell

**Files:**
- Modify: `src/tabletag.ts` (`TableTagger.cell`)
- Modify: `src/tablerender.ts` (`placeRows` passes `p.rowSpan`)
- Test: `test/table-authoring-tagged.test.ts` (append), `test/table-rowspan.test.ts` (append)

**Interfaces:**
- Consumes: `Placement.rowSpan` (Task 1), reaching `placeRows` from Task 5.
- Produces: `TableTagger.cell(cell, rowIndex, repeatingRows, rowSpan = 1)`. The default keeps every existing direct call compiling.

- [ ] **Step 1: Write the failing test**

Append to `test/table-authoring-tagged.test.ts`, inside the existing `describe('TableTagger', …)` block:

```ts
  it('writes RowSpan only for a spanning cell', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('tall', { rowSpan: 2 });
    row.addCell('plain');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const tall = tagger.cell(row.cells[0], 0, 0, 2);
    const plain = tagger.cell(row.cells[1], 0, 0, 1);
    expect(tall.TableAttributes!.rowSpan).toBe(2);
    // readTable defaults an absent RowSpan to 1, so assert on the raw dict:
    // a plain cell must carry no /A at all.
    expect(plain.Dict.has('A')).toBe(false);
  });

  it('states the span it is GIVEN, not the one the cell declared', () => {
    // The clamped value arrives from the placement. This is the one place the
    // two differ observably, and it is why the clamp lives in the grid rather
    // than at paint time.
    const d = doc();
    const row = createTable().addRow();
    row.addCell('tall', { rowSpan: 9 });
    const tagger = new TableTagger(d);
    tagger.beginRow();
    expect(tagger.cell(row.cells[0], 0, 0, 2).TableAttributes!.rowSpan).toBe(2);
  });
```

Append to `test/table-rowspan.test.ts`:

```ts
describe('tagged output', () => {
  it('writes /RowSpan end to end', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('tall', { rowSpan: 2 });
    r0.addCell('a');
    t.addRow().addCell('b');
    const res = page.AddTable(t, 20, 700, { width: 200, tagged: true });
    const tr0 = res.struct!.Children[0];
    expect(tr0.Children[0].TableAttributes!.rowSpan).toBe(2);
    expect(tr0.Children[1].Dict.has('A')).toBe(false);
  });

  it('states the CLAMPED span, never the requested one', () => {
    // rowSpan 9 on a 2-row table clamps to 2, so the structure tree cannot
    // claim rows the table does not have.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('tall', { rowSpan: 9 });
    r0.addCell('a');
    t.addRow().addCell('b');
    const res = page.AddTable(t, 20, 700, { width: 200, tagged: true });
    expect(res.struct!.Children[0].Children[0].TableAttributes!.rowSpan).toBe(2);
  });

  it('states the header-clamped span for a repeating-header cell', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('H', { rowSpan: 4 });
    r0.addCell('h1');
    t.addRow().addCell('h2');
    t.addRow(['a', 'b']);
    t.addRow(['c', 'd']);
    t.setRepeatingRowsCount(2);
    const res = page.AddTable(t, 20, 700, { width: 200, tagged: true });
    expect(res.struct!.Children[0].Children[0].TableAttributes!.rowSpan).toBe(2);
  });

  it('carries both spans on one cell', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    t.addRow().addCell('big', { rowSpan: 2, colSpan: 2 });
    t.addRow();
    const res = page.AddTable(t, 20, 700, { width: 200, tagged: true });
    const attrs = res.struct!.Children[0].Children[0].TableAttributes!;
    expect(attrs.rowSpan).toBe(2);
    expect(attrs.colSpan).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-authoring-tagged.test.ts test/table-rowspan.test.ts`

Expected: FAIL — `cell` takes 3 arguments, and `TableAttributes.rowSpan` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/tabletag.ts`, replace `TableTagger.cell`:

```ts
  /** Append this cell's /TD or /TH to the open /TR and return it.
   *
   *  `rowSpan` is the EFFECTIVE span from the occupancy grid, not
   *  `CellBuilder.rowSpan`: both of the grid's clamps are silent, and this is
   *  the one place the two values differ observably — which is why the clamp
   *  happens in the grid rather than at paint time. A tagged document is then
   *  at least self-consistent: the tag never describes rows the block does not
   *  cover. */
  cell(
    cell: CellBuilder, rowIndex: number, repeatingRows: number, rowSpan = 1,
  ): StructElement {
    if (this.row === undefined) throw new Error('cell before beginRow');
    const scope = headerScope(cell, rowIndex, repeatingRows);
    const elem = this.row.Append(scope === undefined ? 'TD' : 'TH');
    // Written only when there is something to say: readTable defaults an absent
    // ColSpan and RowSpan to 1, so an /A on every plain cell would be pure bloat.
    const attrs: { colSpan?: number; rowSpan?: number; scope?: 'Row' | 'Column' } = {};
    if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
    if (rowSpan > 1) attrs.rowSpan = rowSpan;
    if (scope !== undefined) attrs.scope = scope;
    if (attrs.colSpan !== undefined || attrs.rowSpan !== undefined || attrs.scope !== undefined)
      elem.SetTableAttributes(attrs);
    return elem;
  }
```

In `src/tablerender.ts`'s `placeRows`, pass the placement's span:

```ts
      const struct = tagger?.cell(cell, r, table.repeatingRowCount, p.rowSpan);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/table-authoring-tagged.test.ts test/table-rowspan.test.ts test/table-tagged.test.ts`

Expected: PASS.

- [ ] **Step 5: Prove the clamp reaches the tag**

Change `placeRows` to pass `cell.rowSpan` instead of `p.rowSpan`. Run `npx vitest run test/table-rowspan.test.ts`: `states the CLAMPED span, never the requested one` and `states the header-clamped span for a repeating-header cell` must FAIL, while `writes /RowSpan end to end` stays GREEN. Restore.

- [ ] **Step 6: Check the fence, typecheck and commit**

```bash
npx vitest run test/table-slice-identity.test.ts
npm run typecheck
git add src/tabletag.ts src/tablerender.ts test/table-authoring-tagged.test.ts test/table-rowspan.test.ts
git commit -m "feat(lucg.1): /RowSpan on the authored /TD and /TH

The span written is the one from the placement, so a clamped cell's tag never
claims rows the table does not have. structattr.ts already encoded the field
and extraction already read it; nothing in src/ had ever written it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Documentation, and the full verification pass

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Document `rowSpan` in the Tables section**

In `README.md`'s `### Tables` intro, change

```
fixed points or fractions of the available width, and cells can span columns.
```

to

```
fixed points or fractions of the available width, and cells can span columns and
rows.
```

Then add this after the first Tables code block, the one ending `doc.Pages[0].AddTable(table, 72, 720, { width: 400 }); // top-left at (72, 720)`:

````markdown
A cell spans columns with `colSpan` and rows with `rowSpan`. **Rows below a
spanning cell omit the covered cells** — the cursor skips them, as HTML does,
and there is no placeholder vocabulary:

```ts
const t = createTable({ border: { width: 0.5, color: [0, 0, 0] } });
const r0 = t.addRow();
r0.addCell('Region', { rowSpan: 2 });     // occupies column 0 of rows 0 and 1
r0.addCell('Q1');
t.addRow().addCell('Q2');                 // ONE cell: column 0 is already taken
```

A spanning cell's background, border and text box are its full span box, and it
is measured against every column and row it covers. When it needs more height
than those rows supply, the whole shortfall goes to the **last** row it covers,
so a plain cell is never floated in a box taller than its own content asked for.

A `rowSpan` group is **atomic across a page or column break**: `page.AddTable`
and `flow.AddTable` both back off to the last row at which no span is sliced. A
group by itself taller than the page draws anyway and overflows, exactly as a
single oversized row does.

`rowSpan` is clamped, silently, to two things: the table's last row (rows are
appended after `addCell`, so a caller cannot know the final count when they set
the span), and — for a cell in the repeating-header rows — the end of the header
block (a continuation reprints the header and then jumps to the body, so a span
crossing that seam would paint across a discontinuity). In a tagged table the
`/RowSpan` attribute states the **clamped** value, so the structure tree never
claims rows the table does not have.
````

- [ ] **Step 2: Update the Features bullet and the API table row**

In the Features list, change the Table authoring bullet's `builds rows/cells with fixed/fractional column widths and colspan` to `builds rows/cells with fixed/fractional column widths, colspan and rowspan`.

In the API overview table, on the line beginning `| \`page.AddTable(table, x, top, opts)\` |`, change `embed a cell image with \`cell.setImage(bytes, opts?)\`` to `span cells with \`{ colSpan }\` / \`{ rowSpan }\` (a rowSpan group is never cut across a page); embed a cell image with \`cell.setImage(bytes, opts?)\``.

- [ ] **Step 3: Add the CHANGELOG entry**

Add as the **first** bullet under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **Authored tables span rows** — `addCell(text, { rowSpan })` beside the `colSpan` the table has had since it shipped, closing a gap that ran one way through the whole stack: `structattr.ts` already encoded `/RowSpan`, and `tablegrid.ts`, `tablestruct.ts`, `tablemodel.ts` and `docxtable.ts` already read it, so a tagged PDF carrying a vertical span extracted correctly and could not be re-authored. Rows below a spanning cell omit the covered cells, as HTML does. What made this one piece of work rather than three is that the horizontal cursor walk existed in **three copies** — `contentWidths`, `measure` and `placeRows` — each with its own idea of which column a cell landed in; they are now reads of one pure occupancy grid (`tablespan.ts`), which is also exactly what a disagreement between measuring and painting would have looked like. Four decisions here are ones a plausible-looking wrong implementation still satisfies, so each is fenced by a case that reddens alone. A spanning cell's height shortfall goes entirely to the **last** row it covers, never spread across them, or a plain cell ends up floated in a box taller than its own content asked for. Overlapping spans are visited in order of **last covered row**, because satisfying the earlier-ending one first lets the longer one measure against the already-enlarged rows — reversed, the two each allocate the same height. A `rowSpan` group is **atomic** across a page or column break: both pagination loops back off to the last cut that slices no span, and a group taller than the page falls through to the same draw-it-anyway path an oversized row already takes, introducing no new error. And both clamps — to the table's last row, and to the repeating-header block a continuation reprints — are silent but *observable*, because `/RowSpan` states the clamped value rather than the requested one. `AutoTag` still writes no `RowSpan`: inferring one from geometry is a question about the detectors, not about the authoring model. (`lucg.1`)
```

- [ ] **Step 4: Run the full suite and the typecheck**

```bash
npm run typecheck
npm test
```

Expected: both green. In particular `test/table-slice-identity.test.ts` still reports `be2bd211ea459e23`.

- [ ] **Step 5: Re-run the three fenced files together**

Each risky rule was broken deliberately in its own task (Task 2 Step 5, Task 6 Step 5, Task 7 Step 5). Confirm they pass in one process:

```bash
npx vitest run test/tablespan.test.ts test/table-rowspan.test.ts test/flow-table.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(lucg.1): table rowSpan in the README and the changelog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-lucg.1
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the executor

**Recorded as deliberately unpinned.** `applySpanDeficits`'s tie-break (equal last covered row, then increasing start row) is deterministic ordering only — it is not independently observable. Two spans ending on the same row settle to the same heights in either order, because whichever runs first absorbs the shortfall into the row they share. Do not write a test for it, and do not read the green suite as covering it.

**Out of scope, per the spec.** Markdown (`mdflow.ts`) maps nothing — GFM declares no spans in either direction. `AutoTag` still writes no `/RowSpan`: the detectors' rowSpan inference is a separate question, and `autotag.ts` is untouched here. `FlowTableOptions` gains no option — a span is a property of a cell, not of a placement.

**If `test/table-slice-identity.test.ts` moves, stop.** It is the whole safety net for the three-cursor-walks-to-one-grid refactor. Find out which cell changed placement; do not re-record the hash.
