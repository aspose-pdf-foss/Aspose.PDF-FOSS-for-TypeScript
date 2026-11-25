import { describe, expect, it } from 'vitest';
import { Document, type XlsxSkipped } from '../src/index.js';
import { parseXml } from '../src/xml.js';
import { buildXlsxPageDoc, buildXlsxGoTable } from './helpers/build-xlsx-page-pdf.js';
import { buildTablePdf, text } from './helpers/build-table-pdf.js';
import { buildPngGray } from './helpers/build-embed-images.js';
import { entry, unzip, textOf } from './helpers/unzip.js';

describe('full-page XLSX export (cfgh.3)', () => {
  it('places the Go report fixture in an editable grid and keeps its amount literal', async () => {
    const doc = buildXlsxPageDoc();
    const bytes = doc.ToXlsx({ mode: 'pages' });
    expect(await doc.ToXlsxAsync({ mode: 'pages' })).toEqual(bytes);
    const zip = unzip(bytes);
    expect(textOf(zip, 'xl/workbook.xml')).toMatch(/name="Page 1".*name="Page 2"/s);
    const sheet = parseXml(entry(zip, 'xl/worksheets/sheet1.xml')!.bytes);
    expect(sheet.children.find(n => n.name === 'cols')!.children.length).toBeGreaterThan(1);
    const rows = sheet.children.find(n => n.name === 'sheetData')!.children.filter(r => r.children.length);
    expect(rows.map(r => r.children.map(c => c.children[0].children[0].text)))
      .toEqual([['Report Title'], ['Revenue', '1200']]);
    expect(rows[1].children[1].attrs.get('t')).toBe('inlineStr');
    expect(Number(rows[1].attrs.get('ht'))).toBeGreaterThan(0);
    expect(textOf(zip, 'xl/worksheets/sheet2.xml')).toContain('Second page');
    // Independent of the package's rId numbering, the media target resolves from each drawing.
    expect(zip.filter(e => e.path.startsWith('xl/media/'))).toHaveLength(1);
    for (const n of [1, 2]) {
      expect(textOf(zip, 'xl/worksheets/_rels/sheet' + n + '.xml.rels')).toContain('../drawings/drawing' + n + '.xml');
      expect(textOf(zip, 'xl/drawings/_rels/drawing' + n + '.xml.rels')).toContain('../media/image1.png');
      const drawing = textOf(zip, 'xl/drawings/drawing' + n + '.xml');
      expect(drawing).toContain('x="762000" y="2844800"'); // (60, 842-600-18) points
      expect(drawing).toContain('cx="457200" cy="228600"');
    }
  });

  it('uses source page names for selections and exports selected blank pages', () => {
    const doc = buildXlsxPageDoc();
    doc.AddPage();
    const zip = unzip(doc.ToXlsx({ mode: 'pages', pages: [3, 2, 2] }));
    const names = parseXml(entry(zip, 'xl/workbook.xml')!.bytes).children[0].children.map(s => s.attrs.get('name'));
    expect(names).toEqual(['Page 2', 'Page 3']);
    expect(textOf(zip, 'xl/worksheets/sheet2.xml')).not.toContain('<c ');
    expect(textOf(unzip(doc.ToXlsx({ mode: 'pages', pages: [] })), 'xl/workbook.xml')).toContain('name="Pages"');
  });

  it('honors asset limits without losing text and reports the source page', () => {
    for (const limits of [{ maxImagePixels: 1 }, { maxImageBytes: 1 }]) {
      const skipped: XlsxSkipped[] = [];
      const zip = unzip(buildXlsxPageDoc().ToXlsx({ mode: 'pages', ...limits, onSkipped: s => skipped.push(s) }));
      expect(zip.some(e => e.path.startsWith('xl/media/'))).toBe(false);
      expect(skipped.map(s => [s.kind, s.pageNumber])).toEqual([['image-limit', 1], ['image-limit', 2]]);
      expect(textOf(zip, 'xl/worksheets/sheet1.xml')).toContain('Report Title');
    }
    expect(() => buildXlsxPageDoc().ToXlsx({ mode: 'pages', maxImageBytes: -1 })).toThrow(RangeError);
  });

  it('keeps only text in the displayed crop and preserves literal ids and formulas', () => {
    const doc = Document.Open(buildTablePdf(text(1, 5, 'outside') + text(50, 100, '00123') + text(150, 100, '=1+2')));
    doc.Pages[0].CropBox = [30, 60, 240, 200];
    doc.Pages[0].Rotate = 90;
    const xml = textOf(unzip(doc.ToXlsx({ mode: 'pages' })), 'xl/worksheets/sheet1.xml');
    expect(xml).not.toContain('outside');
    expect(xml).toContain('00123');
    expect(xml).toContain('=1+2');
    expect(xml).not.toContain('<f>');
  });

  it('keeps a mixed-size phrase on one baseline and splits the wide gap', () => {
    const doc = Document.Open(buildTablePdf(text(40, 180, 'Net', 16) + text(68, 180, 'sales', 12) + text(180, 180, '1200', 12)));
    const zip = unzip(doc.ToXlsx({ mode: 'pages' }));
    const sheet = parseXml(entry(zip, 'xl/worksheets/sheet1.xml')!.bytes);
    const data = sheet.children.find(n => n.name === 'sheetData')!;
    expect(data.children.filter(r => r.children.length).map(r => r.children.map(c => c.children[0].children[0].text)))
      .toEqual([['Net sales', '1200']]);
  });

  it('embeds an inline RGB picture and uses one media budget across all sheets', () => {
    const doc = Document.Open(buildTablePdf('q 18 0 0 12 10 20 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID abc EI Q'));
    expect(unzip(doc.ToXlsx({ mode: 'pages' })).some(e => e.path === 'xl/media/image1.png')).toBe(true);
    const repeated = buildXlsxPageDoc();
    const media = entry(unzip(repeated.ToXlsx({ mode: 'pages' })), 'xl/media/image1.png')!;
    repeated.Pages[1].AddImage(buildPngGray(), [150, 400, 20, 20]);
    const skipped: XlsxSkipped[] = [];
    const zip = unzip(repeated.ToXlsx({ mode: 'pages', maxImageBytes: media.bytes.length, onSkipped: s => skipped.push(s) }));
    expect(skipped.map(s => [s.kind, s.pageNumber])).toEqual([['image-limit', 2]]);
    expect(zip.filter(e => e.path.startsWith('xl/media/'))).toHaveLength(1);
    expect(entry(zip, 'xl/drawings/drawing2.xml')).toBeDefined();
  });

  it('rotates picture geometry with the displayed page and honors async cancellation', async () => {
    const doc = buildXlsxPageDoc();
    doc.Pages[0].Rotate = 90;
    const zip = unzip(doc.ToXlsx({ mode: 'pages', pages: [1] }));
    const xml = textOf(zip, 'xl/drawings/drawing1.xml');
    expect(xml).toContain('rot="5400000"');
    expect(xml).toContain(`x="${591 * 12700}" y="${69 * 12700}"`);
    const controller = new AbortController();
    const reason = new Error('cancel pages');
    await expect(doc.ToXlsxAsync({ mode: 'pages', signal: controller.signal,
      onProgress: () => controller.abort(reason) })).rejects.toBe(reason);
  });

  it('matches the Go table fixture values and merge under the existing literal-text policy', () => {
    const doc = buildXlsxGoTable();
    expect(doc.ToXlsx({ mode: 'tables' })).toEqual(doc.ToXlsx());
    const xml = textOf(unzip(doc.ToXlsx()), 'xl/worksheets/sheet1.xml');
    for (const value of ['Item', 'Apples', '3', '€4.50', '€9.75']) expect(xml).toContain('>' + value + '</t>');
    expect(xml).toContain('ref="A4:B4"');
  });
});
