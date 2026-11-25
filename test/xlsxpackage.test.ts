import { describe, expect, it } from 'vitest';
import { writeXlsx, type XlsxMerge, type XlsxSheet } from '../src/xlsxpackage.js';
import { parseXml } from '../src/xml.js';
import { buildXlsxSheets } from './helpers/build-xlsx-sheets.js';
import { entry, unzip } from './helpers/unzip.js';

function contents(sheets: XlsxSheet[] = buildXlsxSheets()) {
  const entries = unzip(writeXlsx(sheets));
  return (path: string) => parseXml(entry(entries, path)!.bytes, undefined, { qnames: true, normalize: true });
}

const worksheet = 'xl/worksheets/sheet1.xml';

describe('SpreadsheetML package', () => {
  it('declares the workbook and both sheets and links them in the supplied order', () => {
    const part = contents();
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
    expect(part('[Content_Types].xml').children.filter(c => c.name === 'Override')
      .map(c => [c.attrs.get('PartName'), c.attrs.get('ContentType')]).sort()).toEqual([
        ['/xl/workbook.xml', mime + 'sheet.main+xml'],
        ['/xl/worksheets/sheet1.xml', mime + 'worksheet+xml'],
        ['/xl/worksheets/sheet2.xml', mime + 'worksheet+xml'],
      ]);
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const root = part('_rels/.rels').children[0].attrs;
    expect([root.get('Type'), root.get('Target')]).toEqual([rel + '/officeDocument', 'xl/workbook.xml']);
    const links = part('xl/_rels/workbook.xml.rels').children;
    const workbook = part('xl/workbook.xml');
    expect(workbook.attrs.get('xmlns:r')).toBe(rel);
    expect(workbook.children[0].children.map(({ attrs }) => {
      const target = links.find(l => l.attrs.get('Id') === attrs.get('r:id'))!.attrs;
      return [attrs.get('name'), attrs.get('sheetId'), target.get('Type'), target.get('Target')];
    })).toEqual([
      ['Sales & "tax"', '1', rel + '/worksheet', 'worksheets/sheet1.xml'],
      ['第二', '2', rel + '/worksheet', 'worksheets/sheet2.xml'],
    ]);
    expect(part('xl/worksheets/sheet2.xml').children[0].children[0].children
      .map(c => c.children[0].text)).toEqual(['0', '-7']);
  });

  it('preserves literal strings, numeric and boolean values and blank positions', () => {
    const sheet = contents()(worksheet);
    const row = sheet.children[0].children[0];
    expect(row.children.map(c => {
      const value = c.children[0];
      return [c.attrs.get('r'), c.attrs.get('t') ?? 'n', value.name, value.children[0]?.text ?? value.text];
    })).toEqual([
      ['A1', 'inlineStr', 'is', '00123'], ['B1', 'inlineStr', 'is', '=1+2'],
      ['C1', 'n', 'v', '12.5'], ['D1', 'b', 'v', '1'], ['E1', 'b', 'v', '0'],
      ['G1', 'inlineStr', 'is', ' <A&B> 🐝 '], ['H1', 'inlineStr', 'is', ''],
    ]);
    expect(row.children[5].children[0].children[0].attrs.get('xml:space')).toBe('preserve');
  });

  it('writes merges after sheet data and keeps the anchor at its original address', () => {
    const [data, merges] = contents()(worksheet).children;
    expect(data.children.at(-1)!.children[0].attrs.get('r')).toBe('Z3');
    expect([merges.name, merges.attrs.get('count'), merges.children[0].attrs.get('ref')])
      .toEqual(['mergeCells', '1', 'Z3:AB4']);
    expect(contents([{ name: 'Empty', rows: [] }])(worksheet).children.map(c => c.name)).toEqual(['sheetData']);
  });

  it('protects literal Xstring escape patterns and encodes XML controls', () => {
    const sheet = contents([{ name: 'Text', rows: [['_x000D_\r\n\t\u0002😀']] }])(worksheet);
    expect(sheet.children[0].children[0].children[0].children[0].children[0].text)
      .toBe('_x005F_x000D__x000D_\n\t_x0002_😀');
  });

  it('rejects missing, ambiguous and invalid worksheet names', () => {
    expect(() => writeXlsx([])).toThrow(/sheet/i);
    for (const name of ['', 'a'.repeat(32), 'a/b', 'a:b', "'edge", "end'", 'History']) {
      expect(() => writeXlsx([{ name, rows: [] }])).toThrow(/name/i);
    }
    expect(() => writeXlsx(['Sales', 'sales'].map(name => ({ name, rows: [] })))).toThrow(/name/i);
  });

  it('refuses non-finite values and oversized rows, columns and text', () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(() => writeXlsx([{ name: 'Test', rows: [[n]] }])).toThrow(/finite/i);
    }
    expect(() => writeXlsx([{ name: 'Test', rows: [Array(16385)] }])).toThrow(/column/i);
    expect(() => writeXlsx([{ name: 'Test', rows: Array(1048577) }])).toThrow(/row/i);
    expect(() => writeXlsx([{ name: 'Test', rows: [['x'.repeat(32768)]] }])).toThrow(/text/i);
  });

  it('validates merge geometry and refuses to hide populated cells', () => {
    const merge: XlsxMerge = { row: 0, column: 0, rowSpan: 2, columnSpan: 2 };
    const write = (merges: XlsxMerge[], rows: XlsxSheet['rows'] = []) =>
      writeXlsx([{ name: 'Test', rows, merges }]);
    for (const patch of [{ row: -1 }, { rowSpan: 0 }, { column: 1.5 }, { column: 16383 }, { row: 1048575 }]) {
      expect(() => write([{ ...merge, ...patch }])).toThrow(/merge/i);
    }
    expect(() => write([{ ...merge, row: 1, column: 1 }, merge])).toThrow(/overlap/i);
    expect(() => write([merge], [[], [0]])).toThrow(/merge/i);
    expect(() => write([merge], [[null, false]])).toThrow(/merge/i);
    expect(() => write([merge, { ...merge, row: 2 }], [['A'], [], ['B']])).not.toThrow();
  });
});
