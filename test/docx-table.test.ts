import { describe, it, expect } from 'vitest';
import { docxTable } from '../src/docxtable.js';
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';
import { parseXml } from '../src/xml.js';

const ctx = { paragraph: (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>` };

const cell = (row: number, col: number, text: string, over: Partial<TableCell> = {}): TableCell =>
  ({ row, col, rowSpan: 1, colSpan: 1, quad: [col * 100, 0, (col + 1) * 100, 20], text, ...over });

const row = (cells: TableCell[]): TableRow => ({ cells, quad: [0, 0, 200, 20] });

const table = (rows: TableRow[], cols: number) =>
  new Table([0, 0, cols * 100, rows.length * 20], rows.length, cols, rows);

const parses = (xml: string) =>
  expect(() => parseXml(new TextEncoder().encode(
    `<w:body xmlns:w="http://x">${xml}</w:body>`))).not.toThrow();

describe('docxTable', () => {
  it('emits a grid column per column, in twips', () => {
    const xml = docxTable(table([row([cell(0, 0, 'a'), cell(0, 1, 'b')])], 2), ctx);
    expect(xml.match(/<w:gridCol /g)?.length).toBe(2);
    expect(xml).toContain('w:w="2000"');    // 100pt * 20 twips
    parses(xml);
  });

  // An empty w:tc is invalid WordprocessingML and Word refuses the document --
  // an empty PARAGRAPH is how the format spells an empty cell.
  it('gives every cell at least one paragraph', () => {
    const xml = docxTable(table([row([cell(0, 0, ''), cell(0, 1, 'b')])], 2), ctx);
    expect(xml).not.toMatch(/<w:tc><w:tcPr>.*?<\/w:tcPr><\/w:tc>/);
    expect(xml.match(/<w:p>/g)?.length).toBe(2);
  });

  it('maps colSpan to gridSpan', () => {
    const xml = docxTable(table([row([cell(0, 0, 'wide', { colSpan: 2 })])], 2), ctx);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
  });

  it('maps rowSpan to a vMerge restart and a continuation', () => {
    const xml = docxTable(table([
      row([cell(0, 0, 'tall', { rowSpan: 2 }), cell(0, 1, 'x')]),
      row([cell(1, 1, 'y')]),
    ], 2), ctx);
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge/>');
  });

  it('repeats a header row across pages', () => {
    const xml = docxTable(table([
      row([cell(0, 0, 'H', { isHeader: true })]),
      row([cell(1, 0, 'd')]),
    ], 1), ctx);
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml.match(/<w:tblHeader\/>/g)?.length).toBe(1);   // the data row is not one
  });

  // WordprocessingML nests directly, unlike GFM -- which is why
  // Table.toMarkdown has to follow a nested table with its parent and this
  // module does not.
  it('nests a table inside its parent cell', () => {
    const inner = table([row([cell(0, 0, 'inner')])], 1);
    const xml = docxTable(table([row([cell(0, 0, 'outer', { tables: [inner] })])], 1), ctx);
    const cellStart = xml.indexOf('<w:tc>');
    const cellEnd = xml.indexOf('</w:tc>', cellStart);
    expect(xml.slice(cellStart, cellEnd)).toContain('inner');
  });

  it('returns nothing for a table with no rows', () => {
    expect(docxTable(table([], 0), ctx)).toBe('');
  });
});

describe('docxTable borders', () => {
  const bordered = (over: Partial<TableCell> = {}): TableCell => cell(0, 0, 'x', {
    borders: {
      top: { width: 1, color: [51, 51, 51] },
      bottom: { width: 0.5 },
      // left and right measured absent
    },
    ...over,
  });

  it('emits a per-cell tcBorders when the cell was recovered', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).toContain('<w:top w:val="single" w:sz="8" w:color="333333"/>');
    expect(xml).toContain('<w:bottom w:val="single" w:sz="4" w:color="auto"/>');
  });

  // Measured absent draws nothing -- distinct from not recovered, which falls
  // back to the frame.
  it('emits none for an edge measured absent', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).toContain('<w:left w:val="none"/>');
    expect(xml).toContain('<w:right w:val="none"/>');
  });

  // Two sources for one edge leaves Word's specificity rules to decide, which
  // is what makes "why is this border here" unanswerable.
  it('omits the table-level frame once any cell is recovered', () => {
    const xml = docxTable(table([row([bordered()])], 1), ctx);
    expect(xml).not.toContain('<w:tblBorders>');
  });

  // The byte-identical fallback: an unrecovered table is exactly what shipped.
  it('keeps the uniform frame when nothing was recovered', () => {
    const xml = docxTable(table([row([cell(0, 0, 'x')])], 1), ctx);
    expect(xml).toContain('<w:tblBorders>');
    expect(xml).not.toContain('<w:tcBorders>');
  });

  it('emits shading as w:shd', () => {
    const xml = docxTable(table([row([bordered({ shading: [238, 238, 238] })])], 1), ctx);
    expect(xml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>');
  });

  // w:tcPr's children are schema-ORDERED. Wrong order is a file Word refuses.
  it('orders tcPr children tcW, gridSpan, vMerge, tcBorders, shd', () => {
    const xml = docxTable(table([row([bordered({ shading: [1, 2, 3] })])], 1), ctx);
    const at = (tag: string) => xml.indexOf(tag);
    expect(at('<w:tcW')).toBeLessThan(at('<w:tcBorders>'));
    expect(at('<w:tcBorders>')).toBeLessThan(at('<w:shd'));
  });

  // sz is in EIGHTHS of a point, and Word's range is 2..96.
  // Present-but-EMPTY is meaningful: recovered, and this cell has no drawn
  // edge. It must draw nothing rather than fall back to the table frame.
  //
  // Note this pins the CONSUMER half of that rule only. The producer half --
  // decorateInk assigning `borders` unconditionally -- is NOT pinned: every
  // cell of a detected ruled table has edges by construction, so a mutation
  // making the assignment conditional leaves the suite green. Measured, not
  // assumed; do not read this case as covering it.
  it('treats a present-but-empty borders as recovered', () => {
    const xml = docxTable(table([row([cell(0, 0, 'x', { borders: {} })])], 1), ctx);
    expect(xml).not.toContain('<w:tblBorders>');
    expect(xml).toContain('<w:top w:val="none"/>');
  });

  it("clamps the border size to Word's range", () => {
    const thin = cell(0, 0, 'x', { borders: { top: { width: 0.05 } } });
    const fat = cell(0, 1, 'y', { borders: { top: { width: 40 } } });
    const xml = docxTable(table([row([thin, fat])], 2), ctx);
    expect(xml).toContain('w:sz="2"');
    expect(xml).toContain('w:sz="96"');
  });
});
