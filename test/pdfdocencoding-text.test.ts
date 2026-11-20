import { describe, expect, it } from 'vitest';
import { Document, FileAttachmentAnnotation, LinkAnnotation } from '../src/index.js';
import { readFdf } from '../src/fdf.js';
import { isArray, isDict, type PdfObject } from '../src/types.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';

// Text strings, opaque keys and ASCII fields intentionally share some high
// bytes. Spell them in PDF syntax so the writer cannot mask a reader bug.
function bytes(): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> /Outlines 5 0 R /StructTreeRoot 15 0 R ' +
      '/PageLabels << /Nums [0 << /S /D /P <A02D> >>] >> ' +
      '/Collection << /Type /Collection /D <84A0> /Schema << /label << /Subtype /S /N <84A0> >> >> >> ' +
      '/Names << /Dests << /Kids [12 0 R] >> ' +
      '/JavaScript << /Names [<84> << /S /JavaScript /JS 13 0 R >>] >> >> >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [4 0 R 6 0 R 9 0 R 10 0 R 14 0 R 17 0 R] >>',
    '<< /Type /Annot /Subtype /Widget /FT /Tx /T <4184> /V <93A0> /Rect [10 10 100 30] >>',
    '<< /Type /Outlines /Count 1 /First 7 0 R /Last 7 0 R >>',
    '<< /Type /Annot /Subtype /Text /Rect [0 0 20 20] /Contents <188084A0> /NM <4184> >>',
    '<< /Parent 5 0 R /Title <4184A0> /Dest <84A0> >>',
    '<< /Title <6184A0> /Creator <FEFF008400A0> /ModDate <84A0> >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 0 20 20] /A << /S /URI /URI <2F84A0> >> >>',
    '<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 20 20] /FS ' +
      '<< /Type /Filespec /F <4284A0> /Desc <84A0> /EF << /F 11 0 R >> >> >>',
    '<< /Type /EmbeddedFile /Length 9 /Filter /ASCIIHexDecode >>\nstream\n84A0FEFF>\nendstream',
    '<< /Limits [<84A0> <84A0>] /Names [<84A0> [3 0 R /Fit]] >>',
    '<< /Length 11 /Filter /ASCIIHexDecode >>\nstream\n2784A0273B>\nendstream',
    '<< /Type /Annot /Subtype /Link /Rect [20 0 40 20] /A << /S /GoTo /D <84A0> >> >>',
    '<< /Type /StructTreeRoot /K [16 0 R] >>',
    '<< /Type /StructElem /S /TD /P 15 0 R /ID <84A0> /Alt <84A0> /A << /O /Table /Headers [<84A0>] >> >>',
    '<< /Type /Annot /Subtype /FileAttachment /Rect [30 0 50 20] /FS ' +
      '<< /Type /Filespec /F (old.bin) /UF <4184A0> /EF << /F 11 0 R >> >> >>',
  ], { info: 8 });
}

describe('PDFDocEncoding text strings', () => {
  it.each(['original', 'saved again'])('reads PDFDocEncoding display text (%s)', (mode) => {
    const original = Document.Open(bytes());
    const doc = mode === 'original' ? original : Document.Open(original.Save());
    expect(doc.GetMetadata()).toMatchObject({ title: 'a—€', creator: '\u0084\u00a0' });
    expect(doc.GetOutlines()[0].Title).toBe('A—€');
    expect(doc.PageLabelFor(0)).toBe('€-1');
    expect(doc.Form.Get('A—')?.Value).toBe('ﬁ€');
    const note = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Text');
    expect(note?.Name).toBe('A—');
    expect(note?.Contents).toBe('˘•—€');
    const files = doc.Pages[0].Annotations.filter((a) => a instanceof FileAttachmentAnnotation);
    expect(files[0].Description).toBe('—€');
    expect(files[1].FileName).toBe('A—€');
    expect(doc.GetCollection()?.fields[0].displayName).toBe('—€');
    expect(doc.GetJavaScripts()).toEqual([{ name: '\u0084', script: "'—€';" }]);
  });

  it('keeps named destination keys, URI strings, legacy file names and binary file data', () => {
    const doc = Document.Open(Document.Open(bytes()).Save());
    const key = '\u0084\u00a0';
    expect(doc.GetOutlines()[0].Dest).toEqual({ name: key });
    expect(doc.GetCollection()?.initialFile).toBe(key);
    expect(doc.GetNamedDestinations()).toEqual([{ name: key, dest: { page: 1, view: { type: 'Fit' } } }]);
    expect(doc.GetMetadata().modDate).toBe(key);
    const links = doc.Pages[0].Annotations.filter((a) => a instanceof LinkAnnotation);
    const file = doc.Pages[0].Annotations.find((a) => a instanceof FileAttachmentAnnotation);
    expect(links.map((link) => link.Action)).toEqual([
      { type: 'uri', uri: '/' + key },
      { type: 'goto', page: 1, view: { type: 'Fit' } },
    ]);
    expect(file?.FileName).toBe('B' + key);
    expect(file?.GetBytes()).toEqual(new Uint8Array([0x84, 0xa0, 0xfe, 0xff]));
  });

  it('interprets structure text and byte-string IDs according to their field types', () => {
    const doc = Document.Open(bytes());
    const root = doc.GetStructTree()!;
    const cell = root.Children[0];
    expect(cell.Alt).toBe('—€');
    expect(cell.ID).toBe('\u0084\u00a0');
    expect(cell.TableAttributes?.headers).toEqual(['\u0084\u00a0']);
    const id = 'header\u0018';
    const rawId = { kind: 'string', bytes: new TextEncoder().encode(id) };
    const header = root.Append('TH', { id });
    expect(header.Dict.get('ID')).toEqual(rawId);
    cell.ID = id;
    cell.SetTableAttributes({ headers: [id] });
    expect(cell.Dict.get('ID')).toEqual(rawId);
    const attrs = doc.resolve(cell.Dict.get('A'));
    const table = isArray(attrs) ? doc.resolve(attrs[0]) : attrs;
    if (!isDict(table)) throw new Error('missing table attributes');
    expect(table.get('Headers')).toEqual([rawId]);
    const reopened = Document.Open(doc.Save()).GetStructTree()!;
    expect(reopened.Children[0].TableAttributes?.headers).toEqual([id]);
  });

  it('keeps a legacy file name when PDF/A conversion adds its Unicode entry', () => {
    const doc = Document.New();
    doc.AddPage();
    const attachment = doc.AddAttachment('legacy.bin', new Uint8Array([1, 2, 3]));
    attachment.Dict.set('F', { kind: 'string', bytes: new Uint8Array([0x42, 0x84, 0xa0]) });
    attachment.Dict.delete('UF');
    expect(attachment.Name).toBe('B\u0084\u00a0');
    doc.ConvertToPdfA('4f');
    const reopened = Document.Open(doc.Save()).GetAttachments()[0];
    expect(reopened.Dict.has('UF')).toBe(true);
    expect(reopened.Name).toBe('B\u0084\u00a0');
    expect(reopened.GetBytes()).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('compares PDF/A configuration names as text across encodings', () => {
    const doc = Document.New();
    doc.AddPage();
    const config = (bytes: number[]) => new Map<string, PdfObject>([
      ['Name', { kind: 'string', bytes: new Uint8Array(bytes) }],
    ]);
    doc.catalog().set('OCProperties', new Map<string, PdfObject>([
      ['OCGs', []],
      ['D', config([0x84, 0xa0])],
      ['Configs', [config([0xfe, 0xff, 0x20, 0x14, 0x20, 0xac])]],
    ]));
    const issue = doc.ValidatePdfA('4').Errors.find((issue) => issue.rule === 'OcConfig');
    expect(issue).toMatchObject({ message: expect.stringContaining('—€') });
  });

  it('reads a UTF-16BE PDF/X output condition identifier', () => {
    const doc = Document.Open(buildPdfxPdf({ registeredNameOnly: true, conditionName: 'FOGRA39' }));
    const intents = doc.resolve(doc.catalog().get('OutputIntents'));
    if (!isArray(intents)) throw new Error('missing output intents');
    const intent = doc.resolve(intents[0]);
    if (!isDict(intent)) throw new Error('missing output intent');
    intent.set('OutputConditionIdentifier', {
      kind: 'string',
      bytes: new Uint8Array([0xfe, 0xff, 0, 0x46, 0, 0x4f, 0, 0x47, 0, 0x52, 0, 0x41, 0, 0x33, 0, 0x39]),
    });
    expect(doc.ValidatePdfX('4').Errors.map((issue) => issue.rule)).not.toContain('OutputIntent');
  });

  it.each(['', '/Encoding /PDFDocEncoding'])('reads FDF fields with the default encoding %s', (encoding) => {
    const data = readFdf(fdf(encoding));
    expect(data.fields).toMatchObject([{ name: 'A—', values: ['ﬁ€', 'Ω'] }]);
    expect(data.file).toBe('B\u0084\u00a0');
    expect(data.id).toEqual(['84a0', 'feff']);
  });

  it('retains the existing FDF fallback when a different byte encoding is declared', () => {
    const data = readFdf(fdf('/Encoding /BigFive'));
    expect(data.fields).toMatchObject([{ name: 'A\u0084', values: ['\u0093\u00a0', 'Ω'] }]);
  });
});

function fdf(encoding: string): Uint8Array {
  return new TextEncoder().encode(
    `%FDF-1.2\n1 0 obj\n<< /FDF << ${encoding} /F <4284A0> /ID [<84A0> <FEFF>] ` +
    '/Fields [<< /T <4184> /V [<93A0> <FEFF03A9>] >>] >> >>\nendobj\n' +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
}
