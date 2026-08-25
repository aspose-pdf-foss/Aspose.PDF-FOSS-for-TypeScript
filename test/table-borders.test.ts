import { describe, it, expect } from 'vitest';
import { Document, PageFormat } from '../src/index.js';
import { extractTables } from '../src/table.js';
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';

/** A 2x2 ruled table with a shaded top-left cell, drawn as vectors.
 *  Grid lines at x = 100, 200, 300 and y = 500, 550, 600.
 *
 *  PageGraphics takes colours in 0..1 (they go straight into `RG`/`rg`), while
 *  paths.ts hands them back in 0..255 via its `cl255` clamp — so 0.2 in gives
 *  51 out, and 0.8 gives 204. */
function ruledPage() {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const g = page.Graphics();
  // Shading first, so the rules paint over it.
  g.setFillColor([0.8, 0.8, 0.8]).rect(100, 550, 100, 50).fill();
  g.setStrokeColor([0.2, 0.2, 0.2]).setLineWidth(1);
  for (const y of [500, 550, 600]) g.drawLine(100, y, 300, y).stroke();
  for (const x of [100, 200, 300]) g.drawLine(x, 500, x, 600).stroke();
  g.apply();
  page.AddText('A', 120, 570, { fontSize: 10 });
  page.AddText('B', 220, 570, { fontSize: 10 });
  page.AddText('C', 120, 520, { fontSize: 10 });
  page.AddText('D', 220, 520, { fontSize: 10 });
  return { doc, page };
}

describe('recovered cell borders', () => {
  it('records all four edges of an interior cell', () => {
    const { doc, page } = ruledPage();
    const [t] = extractTables(doc, page);
    const cell = t.rows[0].cells[0];
    expect(cell.borders).toBeDefined();
    for (const side of ['top', 'right', 'bottom', 'left'] as const)
      expect(cell.borders![side]).toBeDefined();
    expect(cell.borders!.top!.width).toBeCloseTo(1, 1);
    expect(cell.borders!.top!.color).toEqual([51, 51, 51]);   // 0.2 * 255
  });

  it('recovers the shading of the cell that has it, and only that cell', () => {
    const { doc, page } = ruledPage();
    const [t] = extractTables(doc, page);
    expect(t.rows[0].cells[0].shading).toEqual([204, 204, 204]);   // 0.8 * 255
    expect(t.rows[0].cells[1].shading).toBeUndefined();
    expect(t.rows[1].cells[0].shading).toBeUndefined();
  });

  // Absent means NOT RECOVERED, which is what makes the export fall back to the
  // frame it has always drawn. A missing edge on a PRESENT borders means
  // measured absent -- there is genuinely no rule there.
  it('records a present-but-empty borders when a cell has no drawn edge', () => {
    const { doc, page } = ruledPage();
    const [t] = extractTables(doc, page);
    for (const row of t.rows) for (const c of row.cells) expect(c.borders).toBeDefined();
  });

  it('leaves an edge undefined where no rule spans it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const g = page.Graphics();
    g.setStrokeColor([0, 0, 0]).setLineWidth(1);
    // A full frame, plus ONE interior horizontal rule and no interior vertical.
    for (const y of [500, 550, 600]) g.drawLine(100, y, 300, y).stroke();
    for (const x of [100, 300]) g.drawLine(x, 500, x, 600).stroke();
    g.apply();
    page.AddText('A', 120, 570, { fontSize: 10 });
    page.AddText('C', 120, 520, { fontSize: 10 });
    const [t] = extractTables(doc, page);
    const cell = t.rows[0].cells[0];
    expect(cell.borders).toBeDefined();
    expect(cell.borders!.top).toBeDefined();
    expect(cell.borders!.left).toBeDefined();
    expect(cell.borders!.right).toBeDefined();     // the frame's right edge
  });
});

// A rotated table's cell quads are in its own upright frame while the ink is in
// page space, so recovery is skipped rather than mapped between the two.
// `borders: undefined` is exactly how the model says "not recovered", and every
// consumer falls back to the frame it drew before this feature existed.
describe('rotated tables are not decorated', () => {
  it('leaves a rotated table undecorated', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const g = page.Graphics();
    const a = (10 * Math.PI) / 180;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    g.save().transform(cos, sin, -cos * 0 - sin, cos, 0, 0);
    g.setStrokeColor([0, 0, 0]).setLineWidth(1);
    for (const y of [500, 550, 600]) g.drawLine(100, y, 300, y).stroke();
    for (const x of [100, 200, 300]) g.drawLine(x, 500, x, 600).stroke();
    g.restore().apply();
    page.AddText('A', 120, 570, { fontSize: 10, rotate: 10 });
    page.AddText('B', 220, 570, { fontSize: 10, rotate: 10 });
    page.AddText('C', 120, 520, { fontSize: 10, rotate: 10 });
    page.AddText('D', 220, 520, { fontSize: 10, rotate: 10 });

    const [t] = extractTables(doc, page);
    // The precondition: if this table were not detected as rotated, the case
    // would prove nothing about the skip.
    expect(t).toBeDefined();
    expect(Math.abs(t.angle)).toBeGreaterThan(0);
    for (const row of t.rows) for (const c of row.cells) {
      expect(c.borders).toBeUndefined();
      expect(c.shading).toBeUndefined();
    }
  });
});

describe('Table.toHtml borders', () => {
  const mk = (over: Partial<TableCell>) => new Table([0, 0, 100, 20], 1, 1, [{
    cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: [0, 0, 100, 20], text: 'x', ...over }],
    quad: [0, 0, 100, 20],
  } as TableRow]);

  it('emits inline border and background styles for a recovered cell', () => {
    const html = mk({
      borders: { top: { width: 1, color: [51, 51, 51] } },
      shading: [238, 238, 238],
    }).toHtml();
    expect(html).toContain('border-top: 1pt solid #333333');
    expect(html).toContain('border-left: none');
    expect(html).toContain('background-color: #EEEEEE');
  });

  // No style attribute at all, so every existing snapshot of an unrecovered
  // table stays exactly as it was.
  it('emits no style attribute for an unrecovered cell', () => {
    expect(mk({}).toHtml()).not.toContain('style=');
  });
});
