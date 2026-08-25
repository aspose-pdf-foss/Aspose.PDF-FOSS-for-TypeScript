import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import type { TextRun } from '../src/textdecor.js';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('autoFitColumns', () => {
  it('splits proportionally to content, not equally', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['Qty', 'Description']);
    t.addRow(['12', 'A reasonably long product description that needs room']);
    t.autoFitColumns();
    const [qty, desc] = t.resolveColumnWidths(451);
    expect(desc).toBeGreaterThan(qty * 5);
    expect(sum([qty, desc])).toBeCloseTo(451, 6);
  });

  it('gives every column at least its natural width when they all fit', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['ab', 'cd']);          // both tiny against a 400pt budget
    t.autoFitColumns();
    const w = t.resolveColumnWidths(400);
    // Nothing wraps: each column is far wider than its content needs.
    expect(Math.min(...w)).toBeGreaterThan(20);
    expect(sum(w)).toBeCloseTo(400, 6);
  });

  it('shrinks columns together when the content cannot fit', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    // Short WORDS, long lines: max-content far exceeds the budget while
    // min-content sits well inside it, which is the regime this covers. Using
    // space-free strings instead would push min-content past the budget and
    // land in the equal-shares fallback, testing the wrong branch.
    t.addRow(['aa bb cc', `${'dd '.repeat(40)}`]);
    t.autoFitColumns();
    const [a, b] = t.resolveColumnWidths(120);
    // Both are squeezed below their natural width; neither collapses, and the
    // wider content keeps the larger share.
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(400);        // well under its ~400pt natural width
    expect(sum([a, b])).toBeCloseTo(120, 6);
  });

  it('raises a squeezed column to its longest word', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    // One column holds a single long unbreakable word; the other holds a very
    // long sentence, so pure proportionality would starve the first.
    t.addRow(['Supercalifragilistic', `${'word '.repeat(120)}`]);
    t.autoFitColumns();
    const [word, sentence] = t.resolveColumnWidths(300);
    // 'Supercalifragilistic' at 10pt Helvetica is ~95pt; proportionality alone
    // would give this column under 10pt.
    expect(word).toBeGreaterThan(80);
    expect(sentence).toBeGreaterThan(0);
    expect(sum([word, sentence])).toBeCloseTo(300, 6);
  });

  it('falls back to equal shares when the floors cannot be met', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['Supercalifragilisticexpialidocious', 'Antidisestablishmentarianism']);
    t.autoFitColumns();
    // Far too narrow for either longest word.
    const w = t.resolveColumnWidths(40);
    expect(w[0]).toBeCloseTo(20, 6);
    expect(w[1]).toBeCloseTo(20, 6);
  });

  it('lets an explicit setColumnWidths win', () => {
    const t = createTable({ fontSize: 10 });
    t.addRow(['Qty', 'Description']);
    t.autoFitColumns();
    t.setColumnWidths([{ fixed: 100 }, { fraction: 1 }]);
    expect(t.resolveColumnWidths(400)).toEqual([100, 300]);
  });

  it('ignores a spanning cell when sizing columns', () => {
    const withSpan = createTable({ fontSize: 10, padding: 2 });
    withSpan.addRow().addCell('a very wide spanning banner across both', { colSpan: 2 });
    withSpan.addRow(['Qty', 'Description text here']);
    withSpan.autoFitColumns();

    const withoutSpan = createTable({ fontSize: 10, padding: 2 });
    withoutSpan.addRow(['Qty', 'Description text here']);
    withoutSpan.autoFitColumns();

    // The banner belongs to no single column, so it must not move either one.
    expect(withSpan.resolveColumnWidths(400))
      .toEqual(withoutSpan.resolveColumnWidths(400));
  });

  it("measures a run cell at each run's own font", () => {
    // 'llll', not 'MMMM': Helvetica and Helvetica-Bold give 'M' the SAME
    // advance (833/1000 in both), as they do for 'I' and the digits, so a
    // fixture built on those characters cannot tell the two faces apart and
    // passes whatever the code does. 'l' is 222 regular against 278 bold.
    const plain = createTable({ fontSize: 10, padding: 2 });
    plain.addRow(['llll', 'x']);
    plain.autoFitColumns();

    const bold = createTable({ fontSize: 10, padding: 2 });
    // addCell returns the CellBuilder, not the row, so it does not chain.
    const row = bold.addRow();
    row.addCell([{ text: 'llll', font: 'Helvetica-Bold' }] as TextRun[]);
    row.addCell('x');
    bold.autoFitColumns();

    // The bold column claims more of the same budget. Measuring the joined
    // string at the block font would make these two identical.
    expect(bold.resolveColumnWidths(400)[0])
      .toBeGreaterThan(plain.resolveColumnWidths(400)[0]);
  });

  it('sizes a multi-line cell to its longest line, not the whole string', () => {
    const oneLine = createTable({ fontSize: 10, padding: 2 });
    oneLine.addRow(['alpha beta', 'x']);
    oneLine.autoFitColumns();

    const twoLines = createTable({ fontSize: 10, padding: 2 });
    twoLines.addRow(['alpha beta\nalpha beta', 'x']);
    twoLines.autoFitColumns();

    // Measuring across the newline would demand roughly double the width.
    expect(twoLines.resolveColumnWidths(400)[0])
      .toBeCloseTo(oneLine.resolveColumnWidths(400)[0], 6);
  });
});
