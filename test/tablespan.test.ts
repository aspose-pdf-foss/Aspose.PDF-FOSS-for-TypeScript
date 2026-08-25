import { describe, it, expect } from 'vitest';
import { buildSpanGrid, applySpanDeficits, type SpanShape } from '../src/tablespan.js';

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
    // Row 1 lists NO cells and still occupies the full width.
    //
    // Measured, and worth keeping straight: this case does NOT distinguish
    // the two definitions, because the count is a max over rows and row 0
    // already supplies 2. Mutating the implementation back to the widest
    // row's own Σ colSpan leaves it green. It is retained as a statement that
    // an empty row is legal at all; the case below is what pins the change.
    expect(buildSpanGrid([[s(2, 1), s(2, 1)], []], 0).columnCount).toBe(2);
  });

  it('counts a row pushed right past every row\'s own colSpan sum', () => {
    // THE case the definition change is about. Row 1's 2-column cell cannot
    // start at column 0 — the span above holds it — so it occupies columns
    // 1 and 2 and the table is 3 wide. The widest row's own Σ colSpan is 2,
    // which would shrink the table and make resolveColumnWidths reject a
    // valid three-entry setColumnWidths.
    const g = buildSpanGrid([[s(2, 1)], [s(1, 2)]], 0);
    expect(g.placements[1][0]).toEqual({ row: 1, col: 1, rowSpan: 1, colSpan: 2 });
    expect(g.columnCount).toBe(3);
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
