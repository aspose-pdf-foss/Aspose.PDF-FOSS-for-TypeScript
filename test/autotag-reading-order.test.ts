import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildTwoPageTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

describe('AutoTag semantic reading order', () => {
  it('keeps a word together when adjacent text objects draw its two halves', () => {
    const doc = Document.Open(buildMultiStreamPage([text(20, 150, 'Aut') + text(35.5, 150, 'oTag')]));
    expect(doc.Pages[0].GetText()).toBe('AutoTag');
    doc.AutoTag();
    expect(Document.Open(doc.Save()).GetStructTree()!.GetText()).toBe('AutoTag');
  });
  it('keeps a note beside a table even when it shares a baseline with a table row', () => {
    const grid = hline(25, 155, 145) + hline(25, 155, 120) + hline(25, 155, 95)
      + vline(25, 95, 145) + vline(90, 95, 145) + vline(155, 95, 145)
      + text(30, 130, 'Item') + text(95, 130, 'Count') + text(30, 105, 'Pens') + text(95, 105, 'Two');
    const doc = Document.Open(buildMultiStreamPage([grid + text(175, 130, 'Outside note')]));
    doc.AutoTag();
    const [table, note] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(table.GetText()).toBe('Item\nCount\nPens\nTwo');
    expect(note?.GetText()).toBe('Outside note');
  });
  it('leaves confirmed watermark text out of a link label', () => {
    const pageText = text(30, 170, 'DRAFT') + text(30, 150, 'Read more');
    const doc = Document.Open(buildTwoPageTablePdf(pageText, pageText));
    doc.Pages[0].AddLink({ rect: [20, 145, 120, 187], action: { type: 'uri', uri: 'https://example.org/' } });
    doc.AutoTag({ watermark: s => s === 'DRAFT' });
    const [paragraph] = Document.Open(doc.Save()).GetStructTree()!.Children;
    expect(paragraph.Children[0].Alt).toBe('Read more');
  });
  it('reads the lines of a paragraph in layout order when the lower stream paints first', () => {
    const doc = Document.Open(buildMultiStreamPage([text(30, 175, 'Second line'), text(30, 187, 'First line')]));
    doc.AutoTag();
    expect(Document.Open(doc.Save()).GetStructTree()!.GetText()).toBe('First line\nSecond line');
  });
  it('interleaves lines from separate streams without moving their paint operators', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 10 Tf 30 187 Td (First line) Tj 0 -24 Td (Third line) Tj ET',
      text(30, 175, 'Second line'),
    ]));
    doc.AutoTag();
    expect(Document.Open(doc.Save()).GetStructTree()!.GetText()).toBe('First line\nSecond line\nThird line');
  });
  it('keeps the heading, list with a link, table and closing prose in page order after reopening', () => {
    const grid = hline(25, 155, 145) + hline(25, 155, 120) + hline(25, 155, 95)
      + vline(25, 95, 145) + vline(90, 95, 145) + vline(155, 95, 145)
      + text(30, 130, 'Item') + text(95, 130, 'Count') + text(30, 105, 'Pens') + text(95, 105, 'Two');
    const doc = Document.Open(buildTwoPageTablePdf(
      grid + text(25, 40, 'Closing prose.') + text(25, 250, 'Chapter one')
      + text(25, 210, '1. Alpha') + text(25, 197, '2. Bravo') + text(25, 8, 'Page 1'),
      text(25, 250, 'Appendix') + text(25, 8, 'Page 2')));
    doc.SetOutlines([{ Title: 'Chapter one', Dest: { page: 1 }, Children: [{ Title: 'Appendix', Dest: { page: 2 } }] }]);
    doc.Pages[0].AddLink({ rect: [37, 196, 80, 209], action: { type: 'uri', uri: 'https://example.org/' } });
    const originals = doc.Pages.map(p => ({ text: p.GetText(), image: p.ToImage({ scale: 0.4 }) }));
    const report = doc.AutoTag({ headingStrategy: 'outline', furniture: true });
    const reopened = Document.Open(doc.Save()), tree = reopened.GetStructTree()!;
    expect(tree.Children.map(e => e.Type)).toEqual(['H1', 'L', 'Table', 'P', 'H2']);
    expect(report).toMatchObject({ headings: 2, lists: 1, tables: 1, paragraphs: 1, artifacts: 2, annotations: 1 });
    expect(tree.Children[1].Children[1].Children.find(e => e.Type === 'LBody')?.Children.map(e => e.Type)).toEqual(['Link']);
    expect(tree.GetText()).not.toContain('Page ');
    expect(reopened.Pages.map(p => ({ text: p.GetText(), image: p.ToImage({ scale: 0.4 }) }))).toEqual(originals);
  });
});
