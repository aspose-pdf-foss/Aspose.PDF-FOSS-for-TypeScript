import { describe, it, expect } from 'vitest';
import { Table } from '../src/tablemodel.js';
import type { TableRow, TableCell } from '../src/tablemodel.js';
import { stitchTables } from '../src/tablestitch.js';

/** Build a Table from a grid of row-major text with uniform 20-wide columns and
 *  10-tall rows, top row starting at y=top. Column boundaries are shared by
 *  construction so same-shape tables get matching signatures. */
function grid(texts: string[][], top = 100): Table {
  const cols = texts[0].length;
  const rows: TableRow[] = texts.map((line, r) => {
    const yTop = top - r * 10, yBot = yTop - 10;
    const cells: TableCell[] = line.map((text, c) => ({
      row: r, col: c, rowSpan: 1, colSpan: 1,
      quad: [c * 20, yBot, c * 20 + 20, yTop], text,
    }));
    return { cells, quad: [0, yBot, cols * 20, yTop] };
  });
  const yBot = top - texts.length * 10;
  return new Table([0, yBot, cols * 20, top], texts.length, cols, rows);
}

describe('stitchTables', () => {
  it('stitches a two-page continuation into one table with pageSpans', () => {
    const p0 = grid([['A', 'B'], ['1', '2']]);
    const p1 = grid([['3', '4'], ['5', '6']]);
    const out = stitchTables([[p0], [p1]]);
    expect(out).toHaveLength(1);
    expect(out[0].rowCount).toBe(4);
    expect(out[0].rows.map((r) => r.cells.map((c) => c.text).join(''))).toEqual(['AB', '12', '34', '56']);
    expect(out[0].rows.map((r) => r.cells[0].row)).toEqual([0, 1, 2, 3]);
    expect(out[0].pageSpans).toHaveLength(2);
    expect(out[0].pageSpans!.map((s) => s.page)).toEqual([0, 1]);
  });

  it('does not stitch when column counts differ', () => {
    const out = stitchTables([[grid([['A', 'B']])], [grid([['X', 'Y', 'Z']])]]);
    expect(out).toHaveLength(2);
    expect(out[0].pageSpans).toBeUndefined();
  });

  it('does not stitch when columns are misaligned beyond tolerance', () => {
    const a = grid([['A', 'B']]);
    const b = grid([['X', 'Y']]);
    // shift every boundary of b right by 20 pt
    for (const row of b.rows) for (const c of row.cells) { c.quad = [c.quad[0] + 20, c.quad[1], c.quad[2] + 20, c.quad[3]]; }
    const out = stitchTables([[a], [b]]);
    expect(out).toHaveLength(2);
  });

  it('extends a chain across three pages', () => {
    const out = stitchTables([[grid([['A', 'B']])], [grid([['1', '2']])], [grid([['3', '4']])]]);
    expect(out).toHaveLength(1);
    expect(out[0].pageSpans).toHaveLength(3);
    expect(out[0].rowCount).toBe(3);
  });

  it('breaks a chain across a gap page with no table', () => {
    const out = stitchTables([[grid([['A', 'B']])], [], [grid([['1', '2']])]]);
    expect(out).toHaveLength(2);
    expect(out.every((t) => t.pageSpans === undefined)).toBe(true);
  });

  it('passes tables through unchanged when stitch is false', () => {
    const p0 = grid([['A', 'B']]), p1 = grid([['1', '2']]);
    const out = stitchTables([[p0], [p1]], { stitch: false });
    expect(out).toEqual([p0, p1]);
  });

  it('drops a repeated header row on the follower', () => {
    const p0 = grid([['H1', 'H2'], ['a', 'b']]);
    const p1 = grid([['H1', 'H2'], ['c', 'd']]);   // header repeats on page 2
    const out = stitchTables([[p0], [p1]]);
    expect(out).toHaveLength(1);
    expect(out[0].rowCount).toBe(3);
    expect(out[0].rows.map((r) => r.cells.map((c) => c.text).join(''))).toEqual(['H1H2', 'ab', 'cd']);
    expect(out[0].rows.map((r) => r.cells[0].row)).toEqual([0, 1, 2]);
  });

  it('keeps the follower first row when it only partially matches the header', () => {
    const p0 = grid([['H1', 'H2'], ['a', 'b']]);
    const p1 = grid([['H1', 'X'], ['c', 'd']]);
    const out = stitchTables([[p0], [p1]]);
    expect(out[0].rowCount).toBe(4);
  });
});
