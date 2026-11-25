import { describe, expect, it } from 'vitest';
import { Document, type XlsxSkipped, type OperationProgress } from '../src/index.js';
import { parseXml } from '../src/xml.js';
import { buildNestedTablePdf } from './helpers/build-nested-table-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildNestedHeaderPdf, buildXlsxTablePdf } from './helpers/build-xlsx-table-pdf.js';
import { buildTablePdf, buildTwoPageTablePdf, hline, text, vline } from './helpers/build-table-pdf.js';
import { entry, unzip } from './helpers/unzip.js';

function read(bytes: Uint8Array) {
  const entries = unzip(bytes);
  const part = (path: string) => parseXml(entry(entries, path)!.bytes);
  const names = part('xl/workbook.xml').children[0].children.map(s => s.attrs.get('name'));
  function sheet(number: number) {
    const [data, merges] = part('xl/worksheets/sheet' + number + '.xml').children;
    const cells = Object.fromEntries(data.children.flatMap(row => row.children.map(c => {
      expect(c.attrs.get('t')).toBe('inlineStr');
      return [c.attrs.get('r'), c.children[0].children[0].text];
    })));
    return { cells, merges: merges?.children.map(m => m.attrs.get('ref')) ?? [] };
  }
  return { names, sheet };
}

describe('PDF table workbook export', () => {
  it('exports tagged spans and reports PDF-only metadata at its source', () => {
    const skipped: XlsxSkipped[] = [];
    const book = read(Document.Open(buildTaggedTablePdf()).ToXlsx({ onSkipped: s => skipped.push(s) }));
    expect(book.sheet(1).merges).toEqual(['B1:C1', 'A3:A4']);
    expect(book.sheet(1).cells).toMatchObject({ B1: 'Info', A3: 'Bob', B4: '40' });
    expect(skipped).toContainEqual(expect.objectContaining({ kind: 'summary', pageNumber: 1, tableNumber: 1 }));
    expect(skipped).toContainEqual(expect.objectContaining({ kind: 'header-metadata', row: 2, column: 1 }));
  });

  it('places nested sheets in depth-first order and records each immediate parent cell', () => {
    const book = read(Document.Open(buildNestedTablePdf()).ToXlsx());
    expect(book.names).toEqual(['T1', 'T2 (T1!B2)', 'T3 (T2!A2)']);
    expect(book.sheet(1).cells).toMatchObject({ A1: 'A', B1: 'B', A2: 'C' });
    expect(book.sheet(2).cells).toMatchObject({ A1: 'D', B1: 'E', B2: 'F' });
    expect(book.sheet(3).cells).toEqual({ A1: 'G' });
  });

  it('stitches on real page boundaries, preserving source text and reporting the repeated row', () => {
    const doc = Document.Open(buildXlsxTablePdf());
    const skipped: XlsxSkipped[] = [];
    const book = read(doc.ToXlsx({ pages: [2, 1, 2], onSkipped: s => skipped.push(s) }));
    expect(book.names).toEqual(['T1']);
    expect(book.sheet(1)).toEqual({ cells: {
      A1: 'Register', A2: '00123', B2: '=1+2', A3: '00456', B3: 'Final',
    }, merges: ['A1:B1'] });
    expect(skipped).toContainEqual(expect.objectContaining({
      kind: 'repeated-header', pageNumber: 2, tableNumber: 1, row: 1,
    }));
    const split = read(doc.ToXlsx({ stitch: false, tables: [2] }));
    expect(split.names).toHaveLength(1);
    expect(split.sheet(1).cells).toMatchObject({ A1: 'Register', A2: '00456' });
  });

  it('retains a repeated header with a nested table and records its destination cell after stitching', () => {
    const skipped: XlsxSkipped[] = [];
    const book = read(Document.Open(buildNestedHeaderPdf()).ToXlsx({ onSkipped: s => skipped.push(s) }));
    expect(book.names).toEqual(['T1', 'T2 (T1!B1)', 'T3 (T1!B3)']);
    expect(book.sheet(1).cells).toMatchObject({ A1: 'Header', A3: 'Header' });
    expect(book.sheet(2).cells.A1).toBe('P1');
    expect(book.sheet(3).cells.A1).toBe('P2');
    expect(skipped.some(s => s.kind === 'repeated-header')).toBe(false);
    expect(skipped).toContainEqual(expect.objectContaining({
      kind: 'cell-style', pageNumber: 2, tableNumber: 1, row: 1, column: 1, sheetName: 'T1',
    }));
  });

  it('keeps a repeated row that anchors a vertical merge on the continuation', () => {
    const grid = hline(50, 250, 250) + hline(150, 250, 150) + hline(50, 250, 50)
      + vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250)
      + text(70, 200, 'Group') + text(170, 200, 'Header');
    const doc = Document.Open(buildTwoPageTablePdf(grid + text(170, 100, 'One'), grid + text(170, 100, 'Two')));
    expect(read(doc.ToXlsx()).sheet(1)).toEqual({
      cells: { A1: 'Group', B1: 'Header', B2: 'One', A3: 'Group', B3: 'Header', B4: 'Two' },
      merges: ['A1:A2', 'A3:A4'],
    });
  });

  it('never stitches across an unselected intervening page', () => {
    const source = Document.Open(buildXlsxTablePdf());
    const doc = Document.Merge(source, Document.Open(buildXlsxTablePdf()));
    const book = read(doc.ToXlsx({ pages: '1,3' }));
    expect(book.names).toEqual(['T1', 'T2']);
    expect(book.sheet(2).cells.A2).toBe('00123');
  });

  it('returns a blank worksheet and a diagnostic for empty results', () => {
    const doc = Document.Open(buildTablePdf(''));
    const skipped: XlsxSkipped[] = [];
    const book = read(doc.ToXlsx({ onSkipped: s => skipped.push(s) }));
    expect(book.names).toEqual(['Tables']);
    expect(book.sheet(1).cells).toEqual({});
    expect(skipped.map(s => s.kind)).toEqual(['no-tables']);
    expect(read(Document.Open(buildXlsxTablePdf()).ToXlsx({ tables: [] })).names).toEqual(['Tables']);
    expect(() => doc.ToXlsx({ pages: [2] })).toThrow(RangeError);
    expect(() => doc.ToXlsx({ tables: [1] })).toThrow(RangeError);
  });

  it('runs identical steps and honors cancellation in both public entry points', async () => {
    const doc = Document.Open(buildXlsxTablePdf());
    const progress: OperationProgress[] = [], asyncProgress: OperationProgress[] = [];
    const syncSkipped: XlsxSkipped[] = [], asyncSkipped: XlsxSkipped[] = [];
    const sync = doc.ToXlsx({ onProgress: p => progress.push(p), onSkipped: s => syncSkipped.push(s) });
    expect(await doc.ToXlsxAsync({ onProgress: p => asyncProgress.push(p), onSkipped: s => asyncSkipped.push(s) })).toEqual(sync);
    expect(asyncProgress).toEqual(progress);
    expect(asyncSkipped).toEqual(syncSkipped);
    expect(progress.filter(p => p.phase === 'pages').map(p => p.pageNumber)).toEqual([1, 2]);
    for (const async of [false, true]) {
      const controller = new AbortController();
      const reason = new Error('cancel export');
      const opts = { signal: controller.signal, onProgress: () => controller.abort(reason) };
      if (async) await expect(doc.ToXlsxAsync(opts)).rejects.toBe(reason);
      else expect(() => doc.ToXlsx(opts)).toThrow(reason);
    }
  });
});
