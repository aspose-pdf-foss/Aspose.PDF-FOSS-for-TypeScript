import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { extractTaggedTables } from '../src/tablestruct.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';   // existing geometry fixture
import { buildNestedTablePdf } from './helpers/build-nested-table-pdf.js';

describe('tagged table extraction', () => {
  it('fixture opens as a tagged document with a Table element', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    expect(doc.IsTagged).toBe(true);
    const root = doc.GetStructTree()!;
    expect(root).toBeTruthy();
    const table = root.Children[0];
    expect(table.StandardType).toBe('Table');
  });
});

describe('extractTaggedTables', () => {
  const open = () => {
    const doc = Document.Open(buildTaggedTablePdf());
    return { doc, page: doc.Pages[0] };
  };

  it('reconstructs a 3×4 grid with the right cell text', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    expect(t).toBeTruthy();
    expect(t.rowCount).toBe(4);
    expect(t.colCount).toBe(3);
    const at = (r: number, c: number) =>
      t.rows[r].cells.find((x) => x.row === r && x.col === c)?.text;
    expect(at(0, 0)).toBe('Name');
    expect(at(1, 0)).toBe('Alice');
    expect(at(1, 2)).toBe('NYC');
    expect(at(2, 0)).toBe('Bob');
    expect(at(3, 1)).toBe('40');
    expect(at(3, 2)).toBe('SF');
  });

  it('reads colSpan and rowSpan from TableAttributes', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    const info = t.rows[0].cells.find((c) => c.text === 'Info')!;
    expect(info.colSpan).toBe(2);
    expect(info.col).toBe(1);
    const bob = t.rows[2].cells.find((c) => c.text === 'Bob')!;
    expect(bob.rowSpan).toBe(2);
    expect(bob.col).toBe(0);
    // Row 3's first data cell lands in column 1 because Bob occupies column 0.
    const forty = t.rows[3].cells.find((c) => c.text === '40')!;
    expect(forty.col).toBe(1);
  });

  it('tags sections, headers, scope, id and header associations', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    expect(t.rows[0].section).toBe('head');
    expect(t.rows[1].section).toBe('body');
    const name = t.rows[0].cells.find((c) => c.text === 'Name')!;
    expect(name.isHeader).toBe(true);
    expect(name.scope).toBe('Column');
    expect(name.id).toBe('h1');
    const alice = t.rows[1].cells.find((c) => c.text === 'Alice')!;
    expect(alice.isHeader).toBeFalsy();
    expect(alice.headers).toEqual(['h1']);
    expect(t.summary).toBe('Employee directory');
  });

  it('takes a cell quad from /BBox when present, else glyph union', () => {
    const { doc, page } = open();
    const [t] = extractTaggedTables(doc, page);
    const nyc = t.rows[1].cells.find((c) => c.text === 'NYC')!;
    expect(nyc.quad).toEqual([250, 312, 285, 328]);   // from /BBox
    const alice = t.rows[1].cells.find((c) => c.text === 'Alice')!;
    expect(alice.quad[0]).toBeCloseTo(50, 0);          // from glyph union
    expect(alice.quad[2]).toBeGreaterThan(alice.quad[0]);
  });
});

describe('GetTables dispatcher + serialization', () => {
  it('Page.GetTables auto-uses the structure tree for a tagged table', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const t = doc.Pages[0].GetTables();
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells[0].isHeader).toBe(true);   // proves the tagged path ran
    expect(t[0].summary).toBe('Employee directory');
  });

  it("structure:'off' forces the geometry path (no tagged semantics)", () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const t = doc.Pages[0].GetTables({ structure: 'off' });
    // Geometry path never sets isHeader/summary; the tagged fixture has no
    // ruling lines, so geometry falls to whitespace detection or returns [].
    for (const tbl of t) {
      expect(tbl.summary).toBeUndefined();
      for (const row of tbl.rows) for (const cell of row.cells) expect(cell.isHeader).toBeUndefined();
    }
  });

  it('toHtml emits sections, <th scope>, headers and <caption>', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const html = doc.Pages[0].GetTables()[0].toHtml();
    expect(html).toContain('<caption>Employee directory</caption>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th scope="col" id="h1">Name</th>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('headers="h1"');
  });

  it('a non-tagged page still uses geometry (regression)', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 175, 'A') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(stream));
    const t = doc.Pages[0].GetTables();
    expect(t.length).toBeGreaterThan(0);
    // Geometry path: no tagged fields.
    expect(t[0].summary).toBeUndefined();
    expect(t[0].rows[0].cells[0].isHeader).toBeUndefined();
  });
});

describe('nested tagged tables', () => {
  it('fixture opens tagged with an outer Table element', () => {
    const doc = Document.Open(buildNestedTablePdf());
    expect(doc.IsTagged).toBe(true);
    const outer = doc.GetStructTree()!.Children[0];
    expect(outer.StandardType).toBe('Table');
  });

  const openNested = () => {
    const doc = Document.Open(buildNestedTablePdf());
    return { doc, page: doc.Pages[0] };
  };

  it('returns only the outer table at top level', () => {
    const { doc, page } = openNested();
    const tables = extractTaggedTables(doc, page);
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(2);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rows[0].cells.find((c) => c.col === 0)!.text).toBe('A');
    expect(tables[0].rows[1].cells.find((c) => c.col === 0)!.text).toBe('C');
  });

  it('attaches the nested table to its parent cell and strips its text', () => {
    const { doc, page } = openNested();
    const outer = extractTaggedTables(doc, page)[0];
    const container = outer.rows[1].cells.find((c) => c.col === 1)!;
    expect(container.text).toBe('');            // D/E/F/G pruned
    expect(container.text).not.toContain('D');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const at = (r: number, c: number) => nested.rows[r].cells.find((x) => x.col === c)?.text;
    expect(at(0, 0)).toBe('D');
    expect(at(0, 1)).toBe('E');
    expect(at(1, 1)).toBe('F');
  });

  it('recurses to a second level of nesting', () => {
    const { doc, page } = openNested();
    const nested = extractTaggedTables(doc, page)[0]
      .rows[1].cells.find((c) => c.col === 1)!.tables![0];
    const deepContainer = nested.rows[1].cells.find((c) => c.col === 0)!;
    expect(deepContainer.text).toBe('');
    expect(deepContainer.tables).toHaveLength(1);
    const deep = deepContainer.tables![0];
    expect(deep.rowCount).toBe(1);
    expect(deep.colCount).toBe(1);
    expect(deep.rows[0].cells[0].text).toBe('G');
  });

  it('Page.GetTables + toHtml nests the child <table> inside the parent cell', () => {
    const doc = Document.Open(buildNestedTablePdf());
    const html = doc.Pages[0].GetTables()[0].toHtml();
    expect(html).toMatch(/<td[^>]*>[\s\S]*<table>[\s\S]*<\/table>[\s\S]*<\/td>/);
    expect(html).toContain('>D</td>');   // a nested leaf cell renders
  });
});
