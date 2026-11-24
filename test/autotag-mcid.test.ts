import { describe, expect, it } from 'vitest';
import { parseContentStream } from '../src/content.js';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { isDict, isName, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildTablePdf, text } from './helpers/build-table-pdf.js';

function markedIds(doc: Document): number[] {
  const ids: number[] = [];
  visitContent(doc, doc.Pages[0], { marked: mark => ids.push(mark.mcid) });
  return ids;
}

describe('AutoTag on untagged page streams with orphan MCIDs', () => {
  it('assigns formerly marked text and new text distinct owners, preserving their painting bytes', () => {
    const show = '(Exi\\163ting) Tj';
    const content = '/Span << /MCID 0 /Lang (en) >> BDC BT /F1 10 Tf 20 200 Td\n' +
      '% preserve paint bytes\n' + show + ' ET EMC\n' + text(20, 150, 'New');
    const doc = Document.Open(buildTablePdf(content));
    doc.AutoTag();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.map(el => el.GetText())).toEqual(['Existing', 'New']);
    expect(markedIds(re)).toEqual([0, 1]);
    const bytes = Buffer.from(re.Pages[0].Contents).toString('latin1');
    expect(bytes).toContain('% preserve paint bytes');
    expect(bytes).toContain(show);
    const span = parseContentStream(re.Pages[0].Contents).find(op => isName(op.operands[0]) && op.operands[0].name === 'Span');
    expect(isDict(span?.operands[1]) && span.operands[1].has('Lang')).toBe(true);
  });

  it('copies named properties including indirect values and preserves the shared resource', () => {
    const doc = Document.Open(buildTablePdf('/Span /Shared BDC ' + text(20, 200, 'Existing') +
      ' EMC\n/Span /Shared DP\n' + text(20, 150, 'New')));
    const label = doc.allocObject(name('Indirect'));
    const shared: PdfDict = new Map<string, PdfObject>([['MCID', 0], ['ProducerKey', label]]);
    doc.Pages[0].Resources!.set('Properties', new Map([['Shared', doc.allocObject(shared)]]));
    doc.AutoTag();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.map(el => el.GetText())).toEqual(['Existing', 'New']);
    expect(markedIds(re)).toEqual([0, 1]);
    const props = re.resolve(re.Pages[0].Resources!.get('Properties')) as PdfDict;
    expect((re.resolve(props.get('Shared')) as PdfDict).get('MCID')).toBe(0);
    const marks = parseContentStream(re.Pages[0].Contents).filter(op => isName(op.operands[0]) && op.operands[0].name === 'Span');
    expect(marks).toHaveLength(2);
    for (const { operands } of marks) {
      const prop = operands[1];
      const dict = isName(prop) ? re.resolve(props.get(prop.name)) : prop;
      expect(isDict(dict) && !dict.has('MCID') && re.resolve(dict.get('ProducerKey'))).toEqual(name('Indirect'));
    }
  });

  it('preserves an existing tree owner when the catalog omits the marked flag', () => {
    const doc = Document.Open(buildTablePdf('/Span << /MCID 1 >> BDC ' + text(20, 200, 'Orphan') +
      ' EMC\n' + text(20, 150, 'Owned')));
    const root = doc.CreateStructTree();
    root.Append('H1').MarkContent(doc.Pages[0], [19, 140, 100, 164]);
    doc.catalog().delete('MarkInfo');
    doc.AutoTag();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.map(el => [el.Type, el.GetText()])).toEqual([['H1', 'Owned'], ['P', 'Orphan']]);
    expect(markedIds(re)).toEqual([1, 0]);
  });
});
