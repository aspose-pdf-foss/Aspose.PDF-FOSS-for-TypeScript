import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

// `createTable(defaults)` takes only style defaults — column widths come from
// `setColumnWidths`, and `AddTable(table, x, top, { width })` anchors at a
// top-left point with a total width, NOT a rect.
describe('Table cell text decoration', () => {
  it('underlines a cell\'s text', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable();
    t.addRow().addCell('hi', { underline: true });
    page.AddTable(t, 50, 500, { width: 100 });
    expect(decoded(page)).toContain('re f');
  });

  it('keeps the cell background and the text background distinct', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable();
    t.addRow().addCell('hi', { background: [1, 0, 0], textBackground: [0, 0, 1] });
    page.AddTable(t, 50, 500, { width: 100 });
    const c = decoded(page);
    expect(c).toContain('1 0 0 rg');   // cell box fill
    expect(c).toContain('0 0 1 rg');   // text-tight fill
    // The cell fill is wider than the text fill.
    const fills = page.GetPaths().filter((p) => p.fill !== null);
    const widths = fills.map((p) => p.bbox[2] - p.bbox[0]).sort((a, b) => a - b);
    expect(widths.length).toBeGreaterThanOrEqual(2);
    expect(widths[0]).toBeLessThan(widths[widths.length - 1]);
  });

  it('cascades cell over row over table', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ underline: true });
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    const row = t.addRow();
    row.addCell('a');                        // inherits the table underline
    row.addCell('b', { underline: false });  // opts out
    page.AddTable(t, 50, 500, { width: 200 });
    expect((decoded(page).match(/re f/g) ?? []).length).toBe(1);
  });

  it('rejects a bad decoration with a labelled TypeError', () => {
    const t = createTable();
    expect(() => t.addRow().addCell('hi', { underline: { thickness: -1 } }))
      .toThrow(/underline\.thickness/);
  });
});
