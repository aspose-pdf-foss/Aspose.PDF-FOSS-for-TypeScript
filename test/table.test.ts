import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, extractFragments, type PathEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { buildCells, collectRules, extractTables } from '../src/table.js';
import { buildTablePdf, buildTwoPageTablePdf, hline, vline, text, rotate } from './helpers/build-table-pdf.js';

describe('visitContent path capture', () => {
  it('emits a stroked segment and a filled rectangle in page space', () => {
    // A horizontal stroked line, then a thin filled rect.
    const stream = '2 w 10 20 m 110 20 l S 50 50 40 3 re f';
    const doc = Document.Open(buildSimpleTextPdf(stream));
    const paths: PathEvent[] = [];
    visitContent(doc, doc.Pages[0], { path: (e) => paths.push(e) });

    expect(paths).toHaveLength(2);

    const [line, rect] = paths;
    expect(line.stroke).toBe(true);
    expect(line.fill).toBe(false);
    expect(line.lineWidth).toBeCloseTo(2, 5);
    expect(line.segments).toEqual([[10, 20, 110, 20]]);

    expect(rect.fill).toBe(true);
    expect(rect.stroke).toBe(false);
    // re emits 4 closed edges of [x,y,x+w,y+h] = [50,50,90,53]
    expect(rect.segments).toEqual([
      [50, 50, 90, 50],
      [90, 50, 90, 53],
      [90, 53, 50, 53],
      [50, 53, 50, 50],
    ]);
  });
});

describe('buildCells', () => {
  it('produces a simple grid when every interior separator is present', () => {
    // 2 cols x 2 rows, all separators present.
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];        // descending
    const vSep = [[true], [true]];    // per row: 1 interior boundary, present
    const hSep = [[true], [true]];    // per col: 1 interior boundary, present
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true);
    // top-left cell quad = x[0..10], y[10..20]
    const tl = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(tl.quad).toEqual([0, 10, 10, 20]);
  });

  it('merges across a missing interior vertical rule into a colSpan', () => {
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];
    const vSep = [[false], [true]];   // row 0 top: no divider -> colSpan 2; row 1: divided
    const hSep = [[true], [true]];
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    const wide = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(wide.colSpan).toBe(2);
    expect(wide.quad).toEqual([0, 10, 20, 20]);
    // row 1 still has two cells
    expect(cells.filter((c) => c.row === 1)).toHaveLength(2);
  });

  it('merges down a missing horizontal rule into a rowSpan', () => {
    const xcuts = [0, 10, 20];
    const ycuts = [20, 10, 0];
    const vSep = [[true], [true]];
    const hSep = [[false], [true]];   // col 0: rows 0-1 merged; col 1: divided
    const cells = buildCells(xcuts, ycuts, vSep, hSep);
    const tall = cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(tall.rowSpan).toBe(2);
    expect(tall.quad).toEqual([0, 0, 10, 20]);
  });
});

describe('collectRules', () => {
  it('classifies and clusters axis-aligned rules', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +   // two horizontals
      vline(50, 100, 200) + vline(150, 100, 200);   // two verticals
    const doc = Document.Open(buildTablePdf(stream));
    const { horiz, vert } = collectRules(doc, doc.Pages[0]);
    expect(horiz.map((r) => Math.round(r.pos)).sort((a, b) => a - b)).toEqual([100, 200]);
    expect(vert.map((r) => Math.round(r.pos)).sort((a, b) => a - b)).toEqual([50, 150]);
    // horizontal rule spans x 50..150
    expect(horiz[0].lo).toBeCloseTo(50, 1);
    expect(horiz[0].hi).toBeCloseTo(150, 1);
  });
});

describe('extractTables — ruled', () => {
  it('reconstructs a 2x2 ruled grid with cell text', () => {
    const stream =
      // grid lines
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      // cell text (baseline near the bottom of each band)
      text(55, 175, 'A') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(['A', 'B']);
    expect(t.rows[1].cells.map((c) => c.text)).toEqual(['C', 'D']);
  });
});

describe('extractTables — multiple ruled tables per page', () => {
  it('returns two vertically-stacked 2x2 grids as distinct tables', () => {
    // Two grids sharing column x-positions (50/90/130) but separated by a gap
    // in y (120..200). clusterRules must NOT union the disjoint column spans.
    const top =
      hline(50, 130, 280) + hline(50, 130, 240) + hline(50, 130, 200) +
      vline(50, 200, 280) + vline(90, 200, 280) + vline(130, 200, 280) +
      text(55, 255, 'A1') + text(95, 255, 'A2') +
      text(55, 215, 'A3') + text(95, 215, 'A4');
    const bottom =
      hline(50, 130, 120) + hline(50, 130, 80) + hline(50, 130, 40) +
      vline(50, 40, 120) + vline(90, 40, 120) + vline(130, 40, 120) +
      text(55, 95, 'B1') + text(95, 95, 'B2') +
      text(55, 55, 'B3') + text(95, 55, 'B4');
    const doc = Document.Open(buildTablePdf(top + bottom));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Top table first (reading order, top→bottom).
    expect(tables[0].rowCount).toBe(2);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['A1', 'A2']);
    expect(tables[0].rows[1].cells.map((c) => c.text)).toEqual(['A3', 'A4']);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['B1', 'B2']);
    expect(tables[1].rows[1].cells.map((c) => c.text)).toEqual(['B3', 'B4']);
  });

  it('composes with nesting: two top-level tables, one containing a nested grid', () => {
    // Top: a plain 2x2 grid. Bottom: a 2x2 grid whose bottom-right cell holds an
    // inset 2x2 grid (drawn with a gap). Both must surface as top-level tables,
    // and the bottom one must keep its nested table attached.
    const topGrid =
      hline(40, 120, 280) + hline(40, 120, 250) + hline(40, 120, 220) +
      vline(40, 220, 280) + vline(80, 220, 280) + vline(120, 220, 280) +
      text(55, 255, 'T1') + text(95, 255, 'T2') +
      text(55, 225, 'T3') + text(95, 225, 'T4');
    const bottomGrid =
      hline(40, 200, 180) + hline(40, 200, 110) + hline(40, 200, 40) +
      vline(40, 40, 180) + vline(120, 40, 180) + vline(200, 40, 180) +
      hline(140, 190, 100) + hline(140, 190, 75) + hline(140, 190, 50) +
      vline(140, 50, 100) + vline(165, 50, 100) + vline(190, 50, 100) +
      text(60, 140, 'A') + text(140, 140, 'B') + text(60, 70, 'C') +
      text(145, 82, 'w') + text(170, 82, 'x') + text(145, 57, 'y') + text(170, 57, 'z');
    const doc = Document.Open(buildTablePdf(topGrid + bottomGrid));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Top table first.
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['T1', 'T2']);
    // Bottom table carries the nested grid in its bottom-right cell.
    const bottom = tables[1];
    const container = bottom.rows[1].cells.find((c) => c.col === 1)!;
    expect(container.text).toBe('');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    expect(nested.rows.flatMap((r) => r.cells.map((c) => c.text)).sort())
      .toEqual(['w', 'x', 'y', 'z']);
  });

  it('returns two side-by-side 2x2 grids as distinct tables', () => {
    // Left grid x 30..110, right grid x 170..250; same y band, gap in x.
    const left =
      hline(30, 110, 250) + hline(30, 110, 210) + hline(30, 110, 170) +
      vline(30, 170, 250) + vline(70, 170, 250) + vline(110, 170, 250) +
      text(35, 225, 'L1') + text(75, 225, 'L2') +
      text(35, 185, 'L3') + text(75, 185, 'L4');
    const right =
      hline(170, 250, 250) + hline(170, 250, 210) + hline(170, 250, 170) +
      vline(170, 170, 250) + vline(210, 170, 250) + vline(250, 170, 250) +
      text(175, 225, 'R1') + text(215, 225, 'R2') +
      text(175, 185, 'R3') + text(215, 185, 'R4');
    const doc = Document.Open(buildTablePdf(left + right));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    const texts = tables.map((t) => t.rows[0].cells.map((c) => c.text).join(''));
    expect(texts.sort()).toEqual(['L1L2', 'R1R2']);
  });
});

describe('extractTables — whitespace', () => {
  it('detects a borderless 2-column, 3-row table from aligned text', () => {
    // No rules. Two columns at x=50 and x=160; three rows at y=200,180,160.
    const rows = [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']];
    let stream = '';
    rows.forEach((r, i) => {
      const y = 200 - i * 20;
      stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    expect(tables[0].rows[2].cells.map((c) => c.text)).toEqual(['Bob', '25']);
  });
});

describe('extractTables — whitespace segmentation', () => {
  it('detects two vertically stacked borderless tables as separate tables', () => {
    // Table A rows y=300,280,260; Table B rows y=200,180,160. Cols at x=50,160.
    let stream = '';
    [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']].forEach((r, i) => {
      const y = 300 - i * 20; stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    [['Item', 'Qty'], ['Pen', '5'], ['Ink', '2']].forEach((r, i) => {
      const y = 200 - i * 20; stream += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Reading order: top table first.
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['Item', 'Qty']);
    expect(tables[1].rowCount).toBe(3);
  });

  it('detects two side-by-side borderless tables as separate tables', () => {
    // Left cols x=50,110; Right cols x=300,360. Rows y=200,180,160.
    const left = [['Item', 'Qty'], ['Pen', '5'], ['Ink', '2']];
    const right = [['Name', 'Age'], ['Al', '30'], ['Bo', '25']];
    let stream = '';
    for (let i = 0; i < 3; i++) {
      const y = 200 - i * 20;
      stream += text(50, y, left[i][0]) + text(110, y, left[i][1]);
      stream += text(300, y, right[i][0]) + text(360, y, right[i][1]);
    }
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    tables.forEach((t) => { expect(t.colCount).toBe(2); expect(t.rowCount).toBe(3); });
    // Reading order: left table first.
    expect(tables[0].quad[0]).toBeLessThan(tables[1].quad[0]);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Item', 'Qty']);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('keeps a single borderless table with a moderate internal gap as one table', () => {
    // Row pitch 20 normally; last row pitch 26 (still below the separator threshold).
    const rows = [['Name', 'Age'], ['Alice', '30'], ['Bob', '25'], ['Eve', '40']];
    const ys = [200, 180, 160, 134];
    let stream = '';
    rows.forEach((r, i) => { stream += text(50, ys[i], r[0]) + text(160, ys[i], r[1]); });
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(4);
  });

  it('does not treat ordinary prose as a table', () => {
    let stream = '';
    ['The quick brown', 'fox jumps over', 'the lazy dog'].forEach((s, i) => {
      stream += text(50, 200 - i * 20, s);
    });
    const doc = Document.Open(buildTablePdf(stream));
    expect(extractTables(doc, doc.Pages[0])).toHaveLength(0);
  });

  it('returns a ruled table and a borderless table on the same page', () => {
    // Ruled 2-row/2-col table high on the page (y 220..300).
    const ruled =
      hline(50, 150, 300) + hline(50, 150, 260) + hline(50, 150, 220) +
      vline(50, 220, 300) + vline(100, 220, 300) + vline(150, 220, 300) +
      text(55, 280, 'X') + text(105, 280, 'Y') +
      text(55, 240, 'p') + text(105, 240, 'q');
    // Borderless table well below it (y 160..200).
    let ws = '';
    [['Name', 'Age'], ['Al', '1'], ['Bo', '2']].forEach((r, i) => {
      const y = 200 - i * 20; ws += text(50, y, r[0]) + text(160, y, r[1]);
    });
    const doc = Document.Open(buildTablePdf(ruled + ws));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(2);
    // Ruled table (top) first, then borderless.
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
    expect(tables[1].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('does not add spurious borderless tables from a ruled table plus prose', () => {
    const ruled =
      hline(50, 150, 300) + hline(50, 150, 260) + hline(50, 150, 220) +
      vline(50, 220, 300) + vline(100, 220, 300) + vline(150, 220, 300) +
      text(55, 280, 'X') + text(105, 280, 'Y') +
      text(55, 240, 'p') + text(105, 240, 'q');
    const prose =
      text(50, 200, 'A paragraph of running text') +
      text(50, 180, 'that should not be a table') +
      text(50, 160, 'on this page at all.');
    const doc = Document.Open(buildTablePdf(ruled + prose));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
  });
});

describe('extractTables — rotated', () => {
  // A small upright 2×2 ruled table (cols x=0,50,100; rows y=0,40,80).
  const ruledInner =
    hline(0, 100, 80) + hline(0, 100, 40) + hline(0, 100, 0) +
    vline(0, 0, 80) + vline(50, 0, 80) + vline(100, 0, 80) +
    text(5, 60, 'X') + text(55, 60, 'Y') +
    text(5, 20, 'p') + text(55, 20, 'q');
  // A small upright borderless 2-col/3-row table (cols x=0,60; rows y=40,25,10).
  const wsRows = [['Name', 'Age'], ['Al', '1'], ['Bo', '2']];
  let wsInner = '';
  wsRows.forEach((r, i) => { const y = 40 - i * 15; wsInner += text(0, y, r[0]) + text(60, y, r[1]); });

  it('extracts a ruled table rotated 90°', () => {
    const doc = Document.Open(buildTablePdf(rotate(90, 100, 100, ruledInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo(Math.PI / 2, 2);
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text))).toEqual([['X', 'Y'], ['p', 'q']]);
  });

  it('extracts a ruled table skewed ~5°', () => {
    const doc = Document.Open(buildTablePdf(rotate(5, 30, 30, ruledInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo((5 * Math.PI) / 180, 2);
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text))).toEqual([['X', 'Y'], ['p', 'q']]);
  });

  it('extracts a borderless table rotated 90°', () => {
    const doc = Document.Open(buildTablePdf(rotate(90, 80, 100, wsInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo(Math.PI / 2, 2);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('extracts a borderless table skewed ~10°', () => {
    const doc = Document.Open(buildTablePdf(rotate(10, 40, 40, wsInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo((10 * Math.PI) / 180, 2);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('leaves an axis-aligned table with angle 0', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'X') + text(105, 150, 'Y');
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables[0].angle).toBe(0);
  });
});

describe('extractFragments — orientation', () => {
  it('reports the baseline angle of rotated text', () => {
    const stream = rotate(30, 60, 60, text(0, 0, 'Hi'));
    const doc = Document.Open(buildTablePdf(stream));
    const frags = extractFragments(doc, doc.Pages[0]);
    expect(frags.length).toBeGreaterThanOrEqual(1);
    expect(frags[0].angle).toBeCloseTo((30 * Math.PI) / 180, 2);
  });

  it('leaves horizontal text without an angle (byte-identical fragments)', () => {
    const doc = Document.Open(buildTablePdf(text(50, 200, 'Hi')));
    expect(extractFragments(doc, doc.Pages[0])[0].angle).toBeUndefined();
  });
});

describe('Table serialization', () => {
  it('emits HTML with escaped text and a Markdown pipe table', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 175, 'a&b') + text(105, 175, 'B') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(stream));
    const table = extractTables(doc, doc.Pages[0])[0];

    const html = table.toHtml();
    expect(html).toContain('<table>');
    // Matched on the cell's CONTENT, not on `<td>` verbatim: this table is
    // geometry-detected, so its cells now carry recovered border styles. This
    // case is about escaping, and must not accidentally pin the absence of
    // attributes as well.
    expect(html).toContain('>a&amp;b</td>');

    const md = table.toMarkdown().split('\n');
    // '&' is escaped in a cell as it is in body text: unescaped it can open an
    // entity reference, so a cell reading 'a&amp;b' would not survive a round
    // trip. This table is geometry-detected and reports no header information,
    // so row 0 stays the header (see Table.headerRowIndices).
    expect(md[0]).toBe('| a\\&b | B |');
    expect(md[1]).toBe('| --- | --- |');
    expect(md[2]).toBe('| C | D |');
  });
});

describe('Document.GetTables — cross-page stitching', () => {
  it('stitches a ruled table continued on the next page', () => {
    // Same 2-column grid geometry on both pages (columns at x=50/100/150).
    const page0 =
      hline(50, 150, 250) + hline(50, 150, 210) + hline(50, 150, 170) +
      vline(50, 170, 250) + vline(100, 170, 250) + vline(150, 170, 250) +
      text(55, 235, 'Name') + text(105, 235, 'Qty') +
      text(55, 195, 'Apple') + text(105, 195, '3');
    const page1 =
      hline(50, 150, 250) + hline(50, 150, 210) + hline(50, 150, 170) +
      vline(50, 170, 250) + vline(100, 170, 250) + vline(150, 170, 250) +
      text(55, 235, 'Name') + text(105, 235, 'Qty') +   // repeated header
      text(55, 195, 'Pear') + text(105, 195, '5');
    const doc = Document.Open(buildTwoPageTablePdf(page0, page1));
    const tables = doc.GetTables();
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(3);   // header + 2 data rows
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text).join('|')))
      .toEqual(['Name|Qty', 'Apple|3', 'Pear|5']);
    expect(tables[0].pageSpans).toHaveLength(2);
    // opt-out yields the two per-page tables
    expect(doc.GetTables({ stitch: false })).toHaveLength(2);
  });
});

describe('Page.GetTables', () => {
  it('exposes tables via the Page facade', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'X') + text(105, 150, 'Y');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables();
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells.map((c) => c.text)).toEqual(['X', 'Y']);
  });

  it('merges a cell across a missing interior vertical rule (colSpan)', () => {
    // Top row: no vertical divider between the two columns -> colSpan 2.
    const stream =
      hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(150, 100, 200) + vline(100, 100, 150) +  // middle rule only in bottom band
      text(70, 175, 'Header') +
      text(55, 125, 'C') + text(105, 125, 'D');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables()[0];
    const top = t.rows[0].cells[0];
    expect(top.colSpan).toBe(2);
    expect(top.text).toBe('Header');
    expect(t.toHtml()).toContain('colspan="2"');
  });

  it('restricts extraction to a region', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'A') + text(105, 150, 'B') +
      text(55, 40, 'footer prose outside the table');
    const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables({ region: [40, 90, 160, 210] });
    expect(t).toHaveLength(1);
    expect(t[0].rows[0].cells.map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('returns [] for ordinary paragraph text', () => {
    const stream =
      text(50, 200, 'This is a single line of running prose.') +
      text(50, 185, 'Another sentence continues the paragraph.');
    expect(Document.Open(buildTablePdf(stream)).Pages[0].GetTables()).toEqual([]);
  });

  // A 1x1 grid has no interior rule: it is page furniture (a card, a callout,
  // a frame), and calling it a table filled the HTML export with empty tables
  // and AutoTag's tree with one-cell Table subtrees.
  describe('a plain ruled box is not a table', () => {
    const box = (x0: number, x1: number, y0: number, y1: number) =>
      hline(x0, x1, y0) + hline(x0, x1, y1) + vline(x0, y0, y1) + vline(x1, y0, y1);

    it('rejects an empty ruled rectangle', () => {
      expect(Document.Open(buildTablePdf(box(50, 250, 100, 200))).Pages[0].GetTables()).toEqual([]);
    });

    it('rejects a ruled rectangle that holds text (a card)', () => {
      const stream = box(50, 250, 100, 200) + text(60, 150, 'Card heading');
      expect(Document.Open(buildTablePdf(stream)).Pages[0].GetTables()).toEqual([]);
    });

    it('keeps a box with one interior rule — that is a 2x1 table', () => {
      const stream = box(50, 250, 100, 200) + hline(50, 250, 150)
        + text(60, 170, 'A') + text(60, 120, 'B');
      const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables();
      expect(t).toHaveLength(1);
      expect([t[0].rowCount, t[0].colCount]).toEqual([2, 1]);
    });

    it('keeps a real grid beside a box, and reports only the grid', () => {
      const stream = box(20, 120, 220, 280)               // furniture, no interior rule
        + hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
        + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
        + text(55, 175, 'A') + text(105, 175, 'B')
        + text(55, 125, 'C') + text(105, 125, 'D');
      const t = Document.Open(buildTablePdf(stream)).Pages[0].GetTables();
      expect(t).toHaveLength(1);
      expect([t[0].rowCount, t[0].colCount]).toEqual([2, 2]);
    });
  });
});
