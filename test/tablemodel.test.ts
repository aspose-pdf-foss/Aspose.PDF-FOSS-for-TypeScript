import { describe, it, expect } from 'vitest';
import { Table } from '../src/index.js';
import type { Rect, TableRow } from '../src/index.js';

const rows = (cells: TableRow['cells'], quad: Rect): TableRow[] => [{ cells, quad }];

describe('Table.toHtml nesting', () => {
  it('nests a child table inside the parent cell, after its text', () => {
    const q: Rect = [0, 0, 10, 10];
    const child = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'inner' }], q));
    const parent = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'outer', tables: [child] }], q));
    expect(parent.toHtml()).toMatch(/<td>outer<table>[\s\S]*inner[\s\S]*<\/table><\/td>/);
  });

  it('is byte-identical to the pre-nesting output for a cell with no nested tables', () => {
    const q: Rect = [0, 0, 10, 10];
    const t = new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'x' }], q));
    expect(t.toHtml()).toBe('<table>\n  <tr>\n    <td>x</td>\n  </tr>\n</table>');
  });
});

describe('Table.toHtml scope mapping', () => {
  const one = (cell: Partial<TableRow['cells'][number]>): Table => {
    const q: Rect = [0, 0, 10, 10];
    return new Table(q, 1, 1, rows(
      [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: q, text: 'x', isHeader: true, ...cell }], q));
  };

  it('maps PDF /Scope Column to HTML scope="col"', () => {
    expect(one({ scope: 'Column' }).toHtml()).toContain('scope="col"');
  });

  it('maps PDF /Scope Row to HTML scope="row"', () => {
    expect(one({ scope: 'Row' }).toHtml()).toContain('scope="row"');
  });

  it('omits scope for PDF /Scope Both (no HTML equivalent)', () => {
    expect(one({ scope: 'Both' }).toHtml()).not.toContain('scope=');
  });

  it('escapes a double quote in /ID so it cannot break out of the attribute', () => {
    const html = one({ id: 'a"b' }).toHtml();
    expect(html).toContain('id="a&quot;b"');
    expect(html).not.toContain('id="a"b"');
  });

  it('escapes a double quote in /Headers', () => {
    const html = one({ headers: ['a"b'] }).toHtml();
    expect(html).toContain('headers="a&quot;b"');
  });
});

describe('Table.pageSpans', () => {
  it('carries optional pageSpans for a stitched table', () => {
    const t = new Table([0, 0, 10, 10], 1, 1, [], undefined,
      [{ page: 0, quad: [0, 0, 10, 10] }, { page: 1, quad: [0, 0, 10, 8] }]);
    expect(t.pageSpans).toHaveLength(2);
    expect(t.pageSpans![1].page).toBe(1);
    const plain = new Table([0, 0, 10, 10], 1, 1, []);
    expect(plain.pageSpans).toBeUndefined();
  });
});
