import { describe, it, expect } from 'vitest';
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';

/** A cell with sensible defaults; `over` supplies the tagged-path extras. */
function cell(row: number, col: number, text: string, over: Partial<TableCell> = {}): TableCell {
  return { row, col, rowSpan: 1, colSpan: 1, quad: [0, 0, 1, 1], text, ...over };
}

/** A table from a dense grid of strings, with no header markings at all. */
function grid(rows: string[][], over: (r: number) => Partial<TableRow> = () => ({})): Table {
  const tableRows: TableRow[] = rows.map((cells, r) => ({
    cells: cells.map((t, c) => cell(r, c, t)),
    quad: [0, 0, 1, 1] as [number, number, number, number],
    ...over(r),
  }));
  return new Table([0, 0, 1, 1], rows.length, rows[0]?.length ?? 0, tableRows);
}

const lines = (t: Table) => t.toMarkdown().split('\n');

/** The same, with row 0 declared the header — so line 0 of the output is that
 *  row rather than the empty header a headerless table synthesizes. */
const headed = (rows: string[][]) =>
  grid(rows, (r) => (r === 0 ? { section: 'head' } : {}));

describe('Table.toMarkdown — cell escaping', () => {
  it('escapes inline markup so a cell reads back as its own text', () => {
    expect(lines(headed([['a*b*c', 'x'], ['q', 'r']]))[0]).toBe('| a\\*b\\*c | x |');
  });

  it('still escapes the cell separator', () => {
    expect(lines(headed([['a|b', 'x'], ['q', 'r']]))[0]).toBe('| a\\|b | x |');
  });

  it('leaves a decimal alone — no block can open inside a cell', () => {
    expect(lines(headed([['3.5', 'x'], ['q', 'r']]))[0]).toBe('| 3.5 | x |');
  });

  it('escapes a body cell too, not only the header', () => {
    expect(lines(headed([['h', 'x'], ['a_b_c', 'r']]))[2]).toBe('| a\\_b\\_c | r |');
  });
});

describe('Table.toMarkdown — the header row', () => {
  it('takes the rows marked as the head section', () => {
    const t = grid([['H1', 'H2'], ['a', 'b']], (r) => (r === 0 ? { section: 'head' } : {}));
    const md = lines(t);
    expect(md[0]).toBe('| H1 | H2 |');
    expect(md[1]).toBe('| --- | --- |');
    expect(md[2]).toBe('| a | b |');
  });

  it('takes row 0 when every one of its cells is a TH', () => {
    const t = grid([['H1', 'H2'], ['a', 'b']]);
    for (const c of t.rows[0].cells) c.isHeader = true;
    expect(lines(t)[0]).toBe('| H1 | H2 |');
    expect(lines(t)[2]).toBe('| a | b |');
  });

  // "No header information at all" is IGNORANCE, not evidence of absence. A
  // geometry-detected table sets neither isHeader nor section (both are tagged-
  // path only), so row 0 stays the header — the overwhelmingly common layout,
  // and what this method has always emitted. Same distinction parseSimpleWidths
  // draws between "the font says zero" and "the font says nothing".
  it('falls back to row 0 when the table carries no header information at all', () => {
    const md = lines(grid([['a', 'b'], ['c', 'd']]));
    expect(md[0]).toBe('| a | b |');
    expect(md[1]).toBe('| --- | --- |');
    expect(md[2]).toBe('| c | d |');
  });

  // But a table that DID report its sections and named none of them 'head' has
  // told us it has no header. GFM has no headerless table, so one is
  // synthesized rather than relabelling a row of data as a heading.
  it('synthesizes an empty header when the table reports sections but no head', () => {
    const md = lines(grid([['a', 'b'], ['c', 'd']], () => ({ section: 'body' })));
    expect(md[0]).toBe('|  |  |');
    expect(md[1]).toBe('| --- | --- |');
    expect(md[2]).toBe('| a | b |');
    expect(md[3]).toBe('| c | d |');
  });

  // The other way a table reports header information: TH cells. A tagged table
  // whose cells are all TD has said there is no header.
  it('synthesizes an empty header when some cell is a TH but row 0 is not', () => {
    const t = grid([['a', 'b'], ['c', 'd']]);
    t.rows[1].cells[0].isHeader = true;     // a row-scope header, not a column one
    expect(lines(t)[0]).toBe('|  |  |');
    expect(lines(t)[2]).toBe('| a | b |');
  });

  // GFM permits exactly one header row. The rest keep their content as body
  // rows rather than being merged into one, which would invent text.
  it('demotes the second head row to a body row', () => {
    const t = grid([['H1', 'H2'], ['S1', 'S2'], ['a', 'b']],
      (r) => (r < 2 ? { section: 'head' } : {}));
    const md = lines(t);
    expect(md[0]).toBe('| H1 | H2 |');
    expect(md[1]).toBe('| --- | --- |');
    expect(md[2]).toBe('| S1 | S2 |');
    expect(md[3]).toBe('| a | b |');
  });
});

describe('Table.toMarkdown — the constructs GFM cannot express', () => {
  it('returns an empty string for a table with no rows', () => {
    expect(new Table([0, 0, 1, 1], 0, 0, []).toMarkdown()).toBe('');
  });

  it('emits /Summary as a paragraph above the table', () => {
    const t = grid([['a', 'b']]);
    t.summary = 'Quarterly figures';
    const md = lines(t);
    expect(md[0]).toBe('Quarterly figures');
    expect(md[1]).toBe('');
    expect(md[2]).toBe('| a | b |');       // no header info, so row 0 heads it
    expect(md[3]).toBe('| --- | --- |');
  });

  it('escapes the summary too', () => {
    const t = grid([['a', 'b']]);
    t.summary = 'see *this*';
    expect(lines(t)[0]).toBe('see \\*this\\*');
  });

  it('keeps a newline in a cell as <br/>, as toHtml does', () => {
    expect(lines(headed([['one\ntwo', 'x'], ['q', 'r']]))[0]).toBe('| one<br/>two | x |');
  });

  // toHtml has emitted a break since it was written and nothing asserted it —
  // found because a mutation aimed at toMarkdown hit this line instead and the
  // suite stayed green. Pinned here, beside the rule it is the model for.
  it('toHtml keeps a newline as <br/> too', () => {
    expect(grid([['one\ntwo', 'x']]).toHtml()).toContain('<td>one<br/>two</td>');
  });

  // GFM cannot nest a table, so the inner one follows the outer rather than
  // vanishing — visible content beats a silently dropped subtree.
  it('emits a nested table after its parent instead of dropping it', () => {
    const outer = grid([['cellText', 'b'], ['c', 'd']]);
    outer.rows[0].cells[0].tables = [grid([['inner1', 'inner2']])];
    const md = outer.toMarkdown();
    expect(md).toContain('cellText');
    expect(md).toContain('| inner1 | inner2 |');
    // The nested table is a separate block, after the outer one.
    expect(md.indexOf('| inner1')).toBeGreaterThan(md.indexOf('| c | d |'));
  });
});
