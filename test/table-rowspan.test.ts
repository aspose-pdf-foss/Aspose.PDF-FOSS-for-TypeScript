import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

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
    const t = createTable({ padding: 0 });
    const r0 = t.addRow();
    r0.addCell('a', { rowSpan: 2 });
    r0.addCell('b', { rowSpan: 2 });
    t.addRow();
    expect(t.resolveColumnWidths(100)).toEqual([50, 50]);
  });

  it('counts a row pushed right by an inherited span', () => {
    // Row 1's 2-column cell cannot start at column 0, so the table is 3 wide
    // where the widest row's own colSpan sum says 2. This is the case the
    // columnCount definition change is actually about — an all-inherited row
    // does not distinguish the two, since the count is a max over rows.
    const t = createTable({ padding: 0 });
    t.addRow().addCell('a', { rowSpan: 2 });
    t.addRow().addCell('b', { colSpan: 2 });
    expect(t.resolveColumnWidths(300)).toEqual([100, 100, 100]);
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
    // Each continuation page carries the anchor's top inset forward, so it
    // gets the same 125pt: 9 rows, then 10, then the last one.
    expect(res.pages).toHaveLength(3);
    expect(res.pages[0].GetText()).toMatch(/\br8\b/);
    expect(res.pages[0].GetText()).not.toMatch(/\br9\b/);
    expect(res.pages[1].GetText()).toMatch(/\br9\b/);
  });
});

describe('tagged output', () => {
  const build = (rowSpan: number) => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 0 });
    const r0 = t.addRow();
    r0.addCell('tall', { rowSpan });
    r0.addCell('a');
    t.addRow().addCell('b');
    return t;
  };

  it('writes /RowSpan end to end', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddTable(build(2), 20, 700, { width: 200, tagged: true });
    const tr0 = res.struct!.Children[0];
    expect(tr0.Children[0].TableAttributes!.rowSpan).toBe(2);
    expect(tr0.Children[1].Dict.has('A')).toBe(false);
  });

  it('states the CLAMPED span, never the requested one', () => {
    // rowSpan 9 on a 2-row table clamps to 2, so the structure tree cannot
    // claim rows the table does not have.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddTable(build(9), 20, 700, { width: 200, tagged: true });
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
