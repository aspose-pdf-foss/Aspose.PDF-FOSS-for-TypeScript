import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { isListTable } from '../src/autotaglisttable.js';
import { buildTablePdf, hline, text, vline } from './helpers/build-table-pdf.js';

function rows(labels: string[], thirdColumn = false): string {
  return labels.map((label, i) => {
    const y = 230 - 14 * i;
    return text(20, y, label) + text(80, y, 'Item ' + (i + 1)) + (thirdColumn ? text(160, y, 'Pending') : '');
  }).join('');
}

describe('AutoTag lists detected as borderless tables', () => {
  it.each([['1.', '2.'], ['a.', 'b.']])('assigns separated labels %s and %s to list items', (a, b) => {
    const doc = Document.Open(buildTablePdf(rows([a, b])));
    expect(doc.Pages[0].GetTables()).toHaveLength(1);
    expect(doc.AutoTag()).toMatchObject({ lists: 1, tables: 0 });
    const [list] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(list.Type).toBe('L');
    expect(list.Children.map(li => li.Children.map(el => [el.Type, el.GetText()]))).toEqual([
      [['Lbl', a], ['LBody', 'Item 1']], [['Lbl', b], ['LBody', 'Item 2']],
    ]);
  });

  it.each([
    ['unpunctuated numbers', ['1', '2'], false],
    ['nonsequential identifiers', ['12.', '57.'], false],
    ['glossary terms', ['A. Term', 'B. Term'], false],
    ['three columns of data', ['1.', '2.'], true],
  ] as const)('preserves tables of %s', (_kind, labels, thirdColumn) => {
    const doc = Document.Open(buildTablePdf(rows([...labels], thirdColumn)));
    expect(doc.AutoTag()).toMatchObject({ lists: 0, tables: 1 });
    expect(Document.Open(doc.Save()).GetStructTree()!.Children[0].Type).toBe('Table');
  });

  it('keeps a ruled grid with numbered rows and honors disabled list inference', () => {
    const grid = [244, 228, 210].map(y => hline(15, 125, y)).join('') +
      [15, 60, 125].map(x => vline(x, 210, 244)).join('');
    const data = rows(['1.', '2.']);
    expect(Document.Open(buildTablePdf(grid + data)).AutoTag()).toMatchObject({ lists: 0, tables: 1 });
    expect(Document.Open(buildTablePdf(data)).AutoTag({ lists: false })).toMatchObject({ lists: 0, tables: 1 });
  });

  it('respects a producer-declared borderless table with numbered rows', () => {
    const doc = Document.New(), page = doc.AddPage().page;
    const table = doc.CreateStructTree().Append('Table');
    for (const [index, label] of ['1.', '2.'].entries()) {
      const row = table.Append('TR'), y = 230 - index * 14;
      page.AddText(label, 20, y, { tag: row.Append('TD') });
      page.AddText('Item ' + (index + 1), 80, y, { tag: row.Append('TD') });
    }
    const [tagged] = Document.Open(doc.Save()).Pages[0].GetTables();
    expect(tagged.rows.map(r => r.cells.map(c => c.text))).toEqual([['1.', 'Item 1'], ['2.', 'Item 2']]);
    expect(isListTable(tagged)).toBe(false);
  });
});
