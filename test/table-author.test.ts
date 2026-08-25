import { describe, it, expect } from 'vitest';
import { createTable } from '../src/index.js';
import { measureText } from '../src/stamp.js';
import { resolveCellStyle } from '../src/tableauthor.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

describe('table authoring — builders', () => {
  it('builds rows from a string[] shorthand', () => {
    const t = createTable();
    const r = t.addRow(['Name', 'Qty']);
    expect(t.rows.length).toBe(1);
    expect(r.cells.map((c) => c.text)).toEqual(['Name', 'Qty']);
  });

  it('builds cells one at a time and reads them back', () => {
    const t = createTable();
    const r = t.addRow();
    r.addCell('Widget', { font: 'Helvetica-Bold' });
    r.addCell('3');
    expect(r.cells.map((c) => c.text)).toEqual(['Widget', '3']);
    expect(r.cells[0].options.font).toBe('Helvetica-Bold');
  });

  it('rejects an unknown font at set time', () => {
    const t = createTable();
    const r = t.addRow();
    expect(() => r.addCell('x', { font: 'Comic Sans' as any })).toThrow(TypeError);
    expect(() => createTable({ font: 'Nope' as any })).toThrow(TypeError);
  });

  it('rejects a non-positive fontSize', () => {
    expect(() => createTable({ fontSize: 0 })).toThrow(TypeError);
  });
});

describe('table authoring — measurement', () => {
  it('single-line cells: row height = leading + 2*padding', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Hi', 'Yo']);
    const m = t.measure([100, 100], { cellPadding: 3 });
    expect(m.rowHeights.length).toBe(1);
    expect(m.rowHeights[0]).toBeCloseTo(12 + 2 * 3, 6);
    expect(m.totalHeight).toBeCloseTo(18, 6);
    expect(m.cellLines[0][0]).toEqual(['Hi']);
  });

  it('row height is the tallest cell in the row', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const word = 'aaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    // A width that fits exactly two words plus their separating space, not three.
    const colWidth = 2 * w + sp + 0.5;
    const r = t.addRow();
    r.addCell('short');                                 // one line
    r.addCell(`${word} ${word} ${word} ${word}`);       // wraps to two lines
    const m = t.measure([colWidth, colWidth], { cellPadding: 0 });
    expect(m.cellLines[0][1].length).toBe(2);
    expect(m.rowHeights[0]).toBeCloseTo(2 * 12, 6);
  });

  it('padding adds 2*P per row', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['a']);
    t.addRow(['b']);
    const a = t.measure([100], { cellPadding: 0 });
    const b = t.measure([100], { cellPadding: 4 });
    expect(b.totalHeight - a.totalHeight).toBeCloseTo(2 * 4 * 2, 6);
  });

  it('empty cell keeps one line of height; empty table is zero', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['']);
    expect(t.measure([100], { cellPadding: 0 }).totalHeight).toBeCloseTo(12, 6);
    expect(createTable().measure([]).totalHeight).toBe(0);
  });

  it('an explicit newline forces a line break', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['a\nb']);
    const m = t.measure([200], { cellPadding: 0 });
    expect(m.cellLines[0][0]).toEqual(['a', 'b']);
    expect(m.rowHeights[0]).toBeCloseTo(2 * 12, 6);
  });

  it('rejects too-few columns and a width <= 2*padding', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    expect(() => t.measure([100])).toThrow(TypeError);
    expect(() => t.measure([5, 5], { cellPadding: 3 })).toThrow(TypeError);
  });
});

describe('table authoring — column widths & colspan (builders)', () => {
  it('setColumnWidths stores mixed fixed/fraction specs and is chainable', () => {
    const t = createTable();
    const ret = t.setColumnWidths([{ fixed: 120 }, { fraction: 2 }, { fraction: 1 }]);
    expect(ret).toBe(t);
  });

  it('rejects malformed column-width specs', () => {
    const t = createTable();
    expect(() => t.setColumnWidths([{ fixed: 0 }])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{ fraction: -1 }])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{ fixed: 1, fraction: 2 } as any])).toThrow(TypeError);
    expect(() => t.setColumnWidths([{} as any])).toThrow(TypeError);
  });

  it('addCell records colSpan and defaults it to 1', () => {
    const t = createTable();
    const r = t.addRow();
    const spanned = r.addCell('Summary', { colSpan: 3 });
    const plain = r.addCell('x');
    expect(spanned.colSpan).toBe(3);
    expect(plain.colSpan).toBe(1);
  });

  it('rejects a non-integer or < 1 colSpan', () => {
    const r = createTable().addRow();
    expect(() => r.addCell('x', { colSpan: 0 })).toThrow(TypeError);
    expect(() => r.addCell('x', { colSpan: 1.5 })).toThrow(TypeError);
  });
});

describe('table authoring — column-width resolution', () => {
  it('splits total equally when all columns are fractions', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c', 'd']);
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }, { fraction: 1 }, { fraction: 1 }]);
    expect(t.resolveColumnWidths(400)).toEqual([100, 100, 100, 100]);
  });

  it('gives fixed columns their width and splits the remainder by fraction', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c']);
    t.setColumnWidths([{ fixed: 120 }, { fraction: 2 }, { fraction: 1 }]);
    const w = t.resolveColumnWidths(300);
    expect(w[0]).toBeCloseTo(120, 6);
    expect(w[1]).toBeCloseTo(120, 6); // (300-120)*2/3
    expect(w[2]).toBeCloseTo(60, 6);  // (300-120)*1/3
  });

  it('defaults to equal columns when setColumnWidths is never called', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    expect(t.resolveColumnWidths(200)).toEqual([100, 100]);
  });

  it('throws when the spec count does not match the column count', () => {
    const t = createTable();
    t.addRow(['a', 'b', 'c']);
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    expect(() => t.resolveColumnWidths(300)).toThrow(TypeError);
  });

  it('throws when fixed columns leave no room for the fractions', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    t.setColumnWidths([{ fixed: 200 }, { fraction: 1 }]);
    expect(() => t.resolveColumnWidths(200)).toThrow(TypeError);
  });

  it('rejects a non-positive totalWidth', () => {
    const t = createTable();
    t.addRow(['a']);
    expect(() => t.resolveColumnWidths(0)).toThrow(TypeError);
  });

  it('column count reflects colspan; an empty table resolves to []', () => {
    const t = createTable();
    t.addRow().addCell('Summary', { colSpan: 3 });
    t.addRow(['a', 'b', 'c']);
    expect(t.resolveColumnWidths(300)).toEqual([100, 100, 100]);
    expect(createTable().resolveColumnWidths(300)).toEqual([]);
  });
});

describe('table continuation', () => {
  it('continuationFrom keeps the original column count and specs', () => {
    const t = createTable();
    t.addRow().addCell('A', { colSpan: 2 });        // row 0 establishes 2 columns
    t.addRow(['x']);                                 // row 1 has a single (narrower) cell
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    expect(t.resolveColumnWidths(200)).toEqual([100, 100]);

    const cont = t.continuationFrom(1);              // rows [row 1] only
    expect(cont.rows.length).toBe(1);
    // Without the forced column count, cont would see 1 column and throw on the
    // 2-entry width spec; with it, widths match the original exactly.
    expect(cont.resolveColumnWidths(200)).toEqual([100, 100]);
  });

  it('continuationFrom shares table defaults', () => {
    const t = createTable({ fontSize: 9, background: [0, 0, 1] });
    t.addRow(['a']); t.addRow(['b']);
    const cont = t.continuationFrom(1);
    expect(cont.defaults.fontSize).toBe(9);
    expect(cont.defaults.background).toEqual([0, 0, 1]);
  });
});

describe('table authoring — colspan measurement', () => {
  it('resolve-then-measure: a colspan header shares the full width', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Header', { colSpan: 2 });
    t.addRow(['left', 'right']);
    const widths = t.resolveColumnWidths(300);
    const m = t.measure(widths, { cellPadding: 0 });
    expect(widths).toEqual([150, 150]);
    expect(m.cellLines[0].length).toBe(1); // header row: one spanning cell
    expect(m.cellLines[1].length).toBe(2); // body row: two cells
  });

  it('a spanning cell wraps to fewer lines than the same text in one column', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const word = 'aaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    // One column fits exactly two words + a space; two spanned columns fit all four.
    const colWidth = 2 * w + 1.5 * sp + 0.5;
    const text = `${word} ${word} ${word} ${word}`;
    t.addRow().addCell(text);                    // one column -> 2 lines
    t.addRow().addCell(text, { colSpan: 2 });    // spans both -> 1 line
    const m = t.measure([colWidth, colWidth], { cellPadding: 0 });
    expect(m.cellLines[0][0].length).toBe(2);
    expect(m.cellLines[1][0].length).toBe(1);
  });

  it("throws when a row's spans overrun the provided columns", () => {
    const t = createTable();
    t.addRow().addCell('a', { colSpan: 3 });
    expect(() => t.measure([100, 100])).toThrow(TypeError);
  });
});

describe('table authoring — resolveCellStyle cascade', () => {
  it('resolves cell ?? row ?? table ?? built-in for every field', () => {
    const t = createTable({ font: 'Times-Roman', fontSize: 10, color: [0, 0, 1], align: 'center' });
    const r = t.addRow(['a'], { align: 'right', background: [0, 1, 0] });
    const cellInheritsRow = r.cells[0];                          // align<-row, bg<-row, font<-table
    const b = r.addCell('b', { color: [1, 0, 0], leading: 20, valign: 'bottom' });
    const pad2 = { top: 2, right: 2, bottom: 2, left: 2 };
    expect(resolveCellStyle(cellInheritsRow, r.style, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 1.2 * 10, color: [0, 0, 1],
      align: 'right', valign: 'top', border: undefined, background: [0, 1, 0],
      padding: pad2,
    });
    expect(resolveCellStyle(b, r.style, t.defaults)).toEqual({
      font: 'Times-Roman', fontSize: 10, leading: 20, color: [1, 0, 0],
      align: 'right', valign: 'bottom', border: undefined, background: [0, 1, 0],
      padding: pad2,
    });
  });

  it('falls back to built-ins when nothing is set', () => {
    const t = createTable();
    const c = t.addRow().addCell('x');
    expect(resolveCellStyle(c, t.rows[0].style, t.defaults)).toEqual({
      font: 'Helvetica', fontSize: 12, leading: 1.2 * 12, color: [0, 0, 0],
      align: 'left', valign: 'top', border: undefined, background: undefined,
      padding: { top: 2, right: 2, bottom: 2, left: 2 },
    });
  });

  it('validates the new style fields', () => {
    expect(() => createTable({ align: 'middle' as any })).toThrow(TypeError);
    expect(() => createTable({ valign: 'centre' as any })).toThrow(TypeError);
    expect(() => createTable({ border: { width: 0, color: [0, 0, 0] } })).toThrow(TypeError);
    expect(() => createTable({ border: { width: 1, color: [2, 0, 0] } })).toThrow(TypeError);
    expect(() => createTable({ background: [0, 0, 2] as any })).toThrow(TypeError);
    expect(() => createTable({ padding: -1 })).toThrow(TypeError);
    expect(() => createTable().addRow(['a'], { align: 'x' as any })).toThrow(TypeError);
  });
});

describe('TableBuilder.setRepeatingRowsCount', () => {
  it('defaults to 0 and stores a non-negative integer, chainable', () => {
    const t = createTable();
    expect(t.repeatingRowCount).toBe(0);
    expect(t.setRepeatingRowsCount(2)).toBe(t);   // chainable
    expect(t.repeatingRowCount).toBe(2);
    expect(t.setRepeatingRowsCount(0).repeatingRowCount).toBe(0);
  });

  it('rejects negatives, non-integers, and non-finite counts', () => {
    const t = createTable();
    expect(() => t.setRepeatingRowsCount(-1)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(1.5)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(Infinity)).toThrow(TypeError);
    expect(() => t.setRepeatingRowsCount(NaN)).toThrow(TypeError);
    // @ts-expect-error runtime guard for non-number
    expect(() => t.setRepeatingRowsCount('2')).toThrow(TypeError);
  });

  it('continuationFrom prepends the header rows and carries the count', () => {
    const t = createTable();
    for (let i = 0; i < 6; i++) t.addRow([`r${i}`]);   // rows r0..r5
    t.setRepeatingRowsCount(1);                          // header = r0
    const cont = t.continuationFrom(3);                  // leftover from r3
    // header r0 prepended, then r3,r4,r5
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r3', 'r4', 'r5']);
    expect(cont.repeatingRowCount).toBe(1);
    // A further split still prepends the header (composability).
    const cont2 = cont.continuationFrom(2);              // header r0 + leftover from index 2 (r4)
    expect(cont2.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r4', 'r5']);
  });

  it('continuationFrom with count 0 is unchanged (raw leftover, no header)', () => {
    const t = createTable();
    for (let i = 0; i < 4; i++) t.addRow([`r${i}`]);
    const cont = t.continuationFrom(2);
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r2', 'r3']);
    expect(cont.repeatingRowCount).toBe(0);
  });

  it('continuationFrom does not duplicate header rows when startRow is within the header', () => {
    const t = createTable();
    for (let i = 0; i < 5; i++) t.addRow([`r${i}`]);
    t.setRepeatingRowsCount(2);                          // header = r0,r1
    const cont = t.continuationFrom(1);                  // startRow inside header
    // body starts at max(1, 2) = 2 -> header r0,r1 then r2,r3,r4 (no repeated r1)
    expect(cont.rows.map((r) => r.cells[0].text)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});

describe('CellBuilder.setImage', () => {
  const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);   // 2x1 RGB

  it('caches the built image and its intrinsic pixel size; chainable', () => {
    const cell = createTable().addRow().addCell('');
    expect(cell.setImage(png2x1())).toBe(cell);            // chainable
    expect(cell.image).toBeDefined();
    expect(cell.image!.width).toBe(2);
    expect(cell.image!.height).toBe(1);
    expect(cell.image!.opts).toEqual({});
  });

  it('keeps the cell text alongside the image', () => {
    const cell = createTable().addRow().addCell('caption');
    cell.setImage(png2x1(), { align: 'center', valign: 'bottom', height: 20, opacity: 0.5 });
    expect(cell.text).toBe('caption');
    expect(cell.image!.opts.height).toBe(20);
    expect(cell.image!.opts.align).toBe('center');
  });

  it('throws on invalid options and bad image bytes', () => {
    const cell = () => createTable().addRow().addCell('');
    expect(() => cell().setImage(png2x1(), { height: 0 })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { height: -5 })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { align: 'middle' as any })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { valign: 'centre' as any })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { opacity: 2 })).toThrow(TypeError);
    expect(() => cell().setImage(new Uint8Array([1, 2, 3]))).toThrow();   // unrecognized image
  });

  it('an image drives the row height by aspect-fit to the inner width', () => {
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1());     // 2x1 image (aspect 2:1)
    const pad = 2, colW = 100;                     // innerWidth = 96 -> imageH = 48
    const { rowHeights } = t.measure([colW], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(48 + 2 * pad, 5);
  });

  it('an explicit image height overrides the aspect-fit height', () => {
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1(), { height: 30 });
    const pad = 2;
    const { rowHeights } = t.measure([100], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(30 + 2 * pad, 5);
  });

  it('a tall image beats the text line height for the row', () => {
    const t = createTable({ fontSize: 10, leading: 12 });
    // Two cells in one row: a text cell and a tall image cell.
    const row = t.addRow();
    row.addCell('hi');
    row.addCell('').setImage(png2x1());            // innerWidth 96 -> imageH 48
    const pad = 2;
    const { rowHeights } = t.measure([100, 100], { cellPadding: pad });
    expect(rowHeights[0]).toBeCloseTo(48 + 2 * pad, 5);   // image dominates
  });
});

describe('cell header marking', () => {
  it('records the header kind on the cell', () => {
    const t = createTable();
    const row = t.addRow();
    expect(row.addCell('plain').header).toBeUndefined();
    expect(row.addCell('h', { header: true }).header).toBe(true);
    expect(row.addCell('c', { header: 'column' }).header).toBe('column');
    expect(row.addCell('r', { header: 'row' }).header).toBe('row');
    expect(row.addCell('opt-out', { header: false }).header).toBe(false);
  });

  it('rejects a header that is not a boolean or a scope name', () => {
    const row = createTable().addRow();
    expect(() => row.addCell('x', { header: 'both' as never })).toThrow(TypeError);
    expect(() => row.addCell('x', { header: 1 as never })).toThrow(TypeError);
  });

  it('does not leak header into the cell style', () => {
    // addCell spreads its options into the style object; `header` must be
    // destructured out or validateStyleOpts sees a key it does not know.
    const cell = createTable().addRow().addCell('x', { header: 'row', fontSize: 9 });
    expect('header' in cell.options).toBe(false);
    expect(cell.options.fontSize).toBe(9);
  });

  it('carries the header kind into a continuation table', () => {
    const t = createTable();
    t.addRow().addCell('H', { header: true });
    t.addRow().addCell('body');
    const cont = t.continuationFrom(0);
    expect(cont.rows[0].cells[0].header).toBe(true);
  });
});

describe('cell image accessibility options', () => {
  const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);

  it('keeps alt and artifact on the cell image', () => {
    const withAlt = createTable().addRow().addCell().setImage(png2x1(), { alt: 'a chart' });
    expect(withAlt.image!.opts.alt).toBe('a chart');
    const decorative = createTable().addRow().addCell().setImage(png2x1(), { artifact: true });
    expect(decorative.image!.opts.artifact).toBe(true);
  });

  it('rejects a non-string alt, a non-boolean artifact, and the two combined', () => {
    const cell = () => createTable().addRow().addCell();
    expect(() => cell().setImage(png2x1(), { alt: 7 as never })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { artifact: 'yes' as never })).toThrow(TypeError);
    expect(() => cell().setImage(png2x1(), { alt: 'x', artifact: true })).toThrow(TypeError);
  });
});

describe('padding in the style cascade', () => {
  const t10 = () => createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });

  it('a row padding overrides the table padding in measure()', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 2 });
    t.addRow(['a']);
    t.addRow(['b'], { padding: 10 });
    const m = t.measure([200]);
    expect(m.rowHeights[0]).toBeCloseTo(12 + 2 * 2, 6);
    expect(m.rowHeights[1]).toBeCloseTo(12 + 2 * 10, 6);
  });

  it('a cell padding overrides the row padding, and the row is the tallest cell', () => {
    const t = t10();
    const r = t.addRow(undefined, { padding: 6 });
    r.addCell('a');
    r.addCell('b', { padding: 14 });
    const m = t.measure([200, 200]);
    expect(m.rowHeights[0]).toBeCloseTo(12 + 2 * 14, 6);   // the roomier cell wins
  });

  it('a per-side padding sizes height by top+bottom and width by left+right', () => {
    const t = t10();
    t.addRow(['a'], { padding: { top: 10, bottom: 4, left: 3, right: 3 } });
    expect(t.measure([200]).rowHeights[0]).toBeCloseTo(12 + 10 + 4, 6);
    // Width: the text box is 200 - (3 + 3). Two words that fit in 194 but not 100.
    const word = 'aaaaaaaaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    const t2 = t10();
    t2.addRow([`${word} ${word}`], { padding: { left: 3, right: 3 } });
    const outer = 2 * w + sp + 6 + 0.5;                    // exactly fits with 3+3 padding
    expect(t2.measure([outer]).cellLines[0][0].length).toBe(1);
    expect(t2.measure([outer - 1]).cellLines[0][0].length).toBe(2);
  });

  it('an unspecified side falls through to the next cascade level, not to zero', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 6 });
    t.addRow(['a'], { padding: { top: 10 } });             // bottom/left/right stay 6
    expect(t.measure([200]).rowHeights[0]).toBeCloseTo(12 + 10 + 6, 6);
  });

  it('measure({ cellPadding }) stands in for the table level and loses to a row', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 2 });
    t.addRow(['a']);
    t.addRow(['b'], { padding: 10 });
    const m = t.measure([200], { cellPadding: 8 });
    expect(m.rowHeights[0]).toBeCloseTo(12 + 2 * 8, 6);    // table padding replaced
    expect(m.rowHeights[1]).toBeCloseTo(12 + 2 * 10, 6);   // row padding still wins
  });

  it('rejects a negative, non-finite, misspelt or non-numeric padding', () => {
    expect(() => createTable({ padding: -1 })).toThrow(/padding/);
    expect(() => createTable({ padding: Infinity })).toThrow(/padding/);
    expect(() => createTable().addRow(['a'], { padding: { topp: 4 } as never })).toThrow(/padding/);
    expect(() => createTable().addRow(['a'], { padding: { top: '4' } as never })).toThrow(/padding/);
    expect(() => createTable().addRow().addCell('a', { padding: -1 })).toThrow(/padding/);
  });
});

describe('border sides', () => {
  const withSides = (sides: unknown) =>
    () => createTable({ border: { width: 1, color: [0, 0, 0], sides: sides as never } });

  it('accepts the three shapes', () => {
    expect(withSides('all')).not.toThrow();
    expect(withSides('none')).not.toThrow();
    expect(withSides({ top: true, bottom: false })).not.toThrow();
    expect(withSides(undefined)).not.toThrow();
  });

  it('rejects an unknown keyword, a non-boolean flag, and a misspelt edge', () => {
    // A misspelt edge is the failure worth catching: it would silently resolve
    // to "no edges" and paint nothing at all.
    expect(withSides('outer')).toThrow(/border.sides/);
    expect(withSides({ top: 'yes' })).toThrow(/border.sides/);
    expect(withSides({ botton: true })).toThrow(/border.sides/);
    expect(withSides(7)).toThrow(/border.sides/);
  });
});

describe('row minHeight', () => {
  it('raises a short row to minHeight', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['banner'], { minHeight: 54 });
    const m = t.measure([200], { cellPadding: 3 });
    expect(m.rowHeights[0]).toBeCloseTo(54, 6);
    expect(m.totalHeight).toBeCloseTo(54, 6);
  });

  it('content taller than minHeight still wins', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const word = 'aaaa';
    const w = measureText(word, 10, 'Helvetica');
    const sp = measureText(' ', 10, 'Helvetica');
    const colWidth = 2 * w + sp + 0.5;                       // fits two words per line
    t.addRow([`${word} ${word} ${word} ${word}`], { minHeight: 15 });
    const m = t.measure([colWidth], { cellPadding: 0 });
    expect(m.cellLines[0][0].length).toBe(2);
    expect(m.rowHeights[0]).toBeCloseTo(2 * 12, 6);          // 24 > minHeight 15
  });

  it('is kept out of the style cascade and carried by continuationFrom', () => {
    const t = createTable();
    t.addRow(['a']);
    t.addRow(['b'], { minHeight: 40, align: 'center' });
    expect(t.rows[1].minHeight).toBe(40);
    expect((t.rows[1].style as Record<string, unknown>).minHeight).toBeUndefined();
    expect(t.rows[1].style.align).toBe('center');
    expect(t.continuationFrom(1).rows[0].minHeight).toBe(40);
  });

  it('rejects a negative or non-finite minHeight', () => {
    expect(() => createTable().addRow(['a'], { minHeight: -1 })).toThrow(TypeError);
    expect(() => createTable().addRow(['a'], { minHeight: Infinity })).toThrow(TypeError);
    expect(() => createTable().addRow(['a'], { minHeight: 'tall' as never })).toThrow(TypeError);
  });

  it('setMinHeight sets the floor on a row built cell by cell, chainably', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const r = t.addRow();
    expect(r.setMinHeight(50)).toBe(r);
    r.addCell('x');
    expect(t.measure([200], { cellPadding: 2 }).rowHeights[0]).toBeCloseTo(50, 6);
  });

  it('setMinHeight overrides the addRow option, and 0 restores content-derived height', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const r = t.addRow(['x'], { minHeight: 30 });
    r.setMinHeight(60);
    expect(t.measure([200], { cellPadding: 2 }).rowHeights[0]).toBeCloseTo(60, 6);
    r.setMinHeight(0);
    expect(t.measure([200], { cellPadding: 2 }).rowHeights[0]).toBeCloseTo(12 + 2 * 2, 6);
  });

  it('setMinHeight rejects a negative or non-finite height', () => {
    // Matched on message, not just TypeError: a missing method throws a
    // TypeError too, so `toThrow(TypeError)` alone would pass vacuously.
    const row = () => createTable().addRow(['a']);
    expect(() => row().setMinHeight(-1)).toThrow(/minHeight must be a non-negative/);
    expect(() => row().setMinHeight(NaN)).toThrow(/minHeight must be a non-negative/);
    expect(() => row().setMinHeight('tall' as never)).toThrow(/minHeight must be a non-negative/);
  });
});
