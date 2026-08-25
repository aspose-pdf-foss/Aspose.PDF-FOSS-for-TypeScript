import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

/** Outer 2×2 grid (x50..250 split 150, y50..250 split 150). Bottom-right cell
 *  [150,50,250,150] contains an inset 2×2 grid (x170..230 split 200,
 *  y70..130 split 100) drawn with a gap. */
const insetStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  hline(170, 230, 130) + hline(170, 230, 100) + hline(170, 230, 70) +
  vline(170, 70, 130) + vline(200, 70, 130) + vline(230, 70, 130) +
  text(70, 200, 'A') + text(170, 200, 'B') + text(70, 100, 'C') +
  text(175, 110, 'w') + text(205, 110, 'x') + text(175, 80, 'y') + text(205, 80, 'z');

describe('geometry nested tables — inset', () => {
  const outer = () => Document.Open(buildTablePdf(insetStream)).Pages[0].GetTables()[0];

  it('keeps a clean 2×2 outer grid', () => {
    const t = outer();
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    expect(t.rows[0].cells.find((c) => c.col === 0)!.text).toBe('A');
    expect(t.rows[0].cells.find((c) => c.col === 1)!.text).toBe('B');
    expect(t.rows[1].cells.find((c) => c.col === 0)!.text).toBe('C');
  });

  it('attaches the inset grid to its container cell and strips its text', () => {
    const t = outer();
    const container = t.rows[1].cells.find((c) => c.col === 1)!;   // bottom-right
    expect(container.text).toBe('');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const at = (r: number, c: number) => nested.rows[r].cells.find((x) => x.col === c)?.text;
    expect(at(0, 0)).toBe('w');
    expect(at(0, 1)).toBe('x');
    expect(at(1, 0)).toBe('y');
    expect(at(1, 1)).toBe('z');
  });
});

/** Outer 2×2 grid; bottom-right cell [150,50,250,150] holds a 2×2 table whose
 *  outer border IS the parent cell border, with interior split at x200/y100. */
const sharedStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  vline(200, 50, 150) + hline(150, 250, 100) +
  text(70, 200, 'A') + text(170, 200, 'B') + text(70, 100, 'C') +
  text(160, 120, 'p') + text(210, 120, 'q') + text(160, 70, 'r') + text(210, 70, 's');

describe('geometry nested tables — shared border', () => {
  const outer = () => Document.Open(buildTablePdf(sharedStream)).Pages[0].GetTables()[0];

  it('keeps a 2×2 outer grid and detects the shared-border nested table', () => {
    const t = outer();
    expect(t.rowCount).toBe(2);
    expect(t.colCount).toBe(2);
    const container = t.rows[1].cells.find((c) => c.col === 1)!;
    expect(container.text).toBe('');
    expect(container.tables).toHaveLength(1);
    const nested = container.tables![0];
    expect(nested.rowCount).toBe(2);
    expect(nested.colCount).toBe(2);
    const texts = nested.rows.flatMap((row) => row.cells.map((c) => c.text)).sort();
    expect(texts).toEqual(['p', 'q', 'r', 's']);
  });
});

/** Outer 2×2; bottom-right holds an inset 2×2 (level 1); that table's
 *  bottom-right cell [200,70,230,100] holds a further inset 2×2 (level 2). */
const deepStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250) +
  hline(170, 230, 130) + hline(170, 230, 100) + hline(170, 230, 70) +
  vline(170, 70, 130) + vline(200, 70, 130) + vline(230, 70, 130) +
  hline(205, 225, 97) + hline(205, 225, 85) + hline(205, 225, 73) +
  vline(205, 73, 97) + vline(215, 73, 97) + vline(225, 73, 97) +
  text(175, 110, 'w') + text(205, 110, 'x') + text(175, 80, 'y') +
  text(206, 88, '1', 6) + text(216, 88, '2', 6) + text(206, 75, '3', 6) + text(216, 75, '4', 6);

describe('geometry nested tables — deep nesting', () => {
  it('recurses to a second nesting level', () => {
    const t = Document.Open(buildTablePdf(deepStream)).Pages[0].GetTables()[0];
    const l1 = t.rows[1].cells.find((c) => c.col === 1)!.tables![0];   // level 1
    expect(l1.rowCount).toBe(2);
    expect(l1.colCount).toBe(2);
    const l1BR = l1.rows[1].cells.find((c) => c.col === 1)!;           // level-1 bottom-right
    expect(l1BR.tables).toHaveLength(1);
    const l2 = l1BR.tables![0];                                        // level 2
    expect(l2.rowCount).toBe(2);
    expect(l2.colCount).toBe(2);
    const texts = l2.rows.flatMap((row) => row.cells.map((c) => c.text)).sort();
    expect(texts).toEqual(['1', '2', '3', '4']);
  });
});

/** A table with a merged (spanning) header: the middle vertical divider exists
 *  only in the body row (y50..150), so the header spans two columns. There is
 *  NO nested table — the lone confined divider must not be misdetected. */
const spanStream =
  hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50) +
  vline(50, 50, 250) + vline(250, 50, 250) + vline(150, 50, 150) +
  text(120, 200, 'Header') + text(70, 100, 'a') + text(170, 100, 'b');

describe('geometry nested tables — spanning-cell control', () => {
  it('treats a lone partial divider as a spanning cell, not a nested table', () => {
    const tables = Document.Open(buildTablePdf(spanStream)).Pages[0].GetTables();
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.colCount).toBe(2);
    const header = t.rows[0].cells.find((c) => c.text === 'Header')!;
    expect(header.colSpan).toBe(2);
    // No cell anywhere gained a nested table.
    for (const row of t.rows) for (const c of row.cells) expect(c.tables).toBeUndefined();
  });
});

describe('geometry nested tables — serialization', () => {
  it('toHtml nests the child <table> inside the parent cell', () => {
    const html = Document.Open(buildTablePdf(insetStream)).Pages[0].GetTables()[0].toHtml();
    expect(html).toMatch(/<td[^>]*>[\s\S]*<table>[\s\S]*<\/table>[\s\S]*<\/td>/);
    expect(html).toContain('>w</td>');   // a nested leaf cell renders
  });
});
