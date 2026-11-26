import { expect, it } from 'vitest';
import { Document } from '../src/index.js';
import { isRef, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';

const bytes = Uint8Array.of(65);
const af = (doc: Document) => doc.resolve(doc.catalog().get('AF')) as PdfObject[];

it('reads and edits catalog-only relationships without adding a name-tree entry', () => {
  const doc = Document.New();
  const page = doc.AddPage().page;
  page.AddFileAttachment({ bytes, name: 'data', relationship: 'Data', rect: [0, 0, 8, 8] });
  const reopened = Document.Open(doc.Save());
  expect(reopened.GetAttachments()).toEqual([]);
  const [file] = reopened.GetAssociatedFiles();
  expect(file.Dict).toBe(reopened.resolve(reopened.Pages[0].Annotations[0].Dict.get('FS')));
  expect(file.Relationship).toBe('Data');
  file.Relationship = 'Source';
  expect(Document.Open(reopened.Save()).GetAssociatedFiles()[0].Relationship).toBe('Source');
});

it('replaces and removes catalog associations by identity, preserving a live annotation', () => {
  const doc = Document.New();
  const page = doc.AddPage().page;
  const annot = page.AddFileAttachment({ bytes, name: 'same', rect: [0, 0, 8, 8],
    relationship: 'Supplement', addToCatalog: true });
  const keep = annot.Dict.get('FS')!;
  doc.AddAttachment('same', bytes, { relationship: 'Source' });
  doc.AddAttachment('same', bytes, { relationship: 'Data' });
  expect(af(doc)).toHaveLength(2);
  expect(doc.GetAttachments()[0].Relationship).toBe('Data');
  expect((doc.resolve(keep) as PdfDict).get('AFRelationship')).toEqual(name('Supplement'));
  expect(doc.RemoveAttachment('same')).toBe(true);
  expect(af(doc)).toEqual([keep]);
  const reopened = Document.Open(doc.Save());
  expect(af(reopened)).toEqual([reopened.Pages[0].Annotations[0].Dict.get('FS')]);
  reopened.Pages[0].RemoveAnnotation(reopened.Pages[0].Annotations[0]);
  expect(reopened.catalog().has('AF')).toBe(false);
  reopened.ConvertToPdfA('3b');
  expect(Document.Open(reopened.Save()).GetAssociatedFiles()).toEqual([]);
});

// Two different specifications use the same stream and filename. One lives
// directly inside a nested name tree, the other belongs to an annotation.
function imported(streamKeys: string, extra = '') {
  return Document.Open(buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Kids [4 0 R] >> >> >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /Annots [5 0 R] >>',
    '<< /Names [(key) << /Type /Filespec /F (a.txt) /Desc (original) /EF << /F 7 0 R >> >>] >>',
    '<< /Type /Annot /Subtype /FileAttachment /FS 6 0 R /Rect [0 0 8 8] >>',
    `<< /Type /Filespec /F (a.txt) /UF (a.txt) /EF << /F 7 0 R /UF 7 0 R >> ${extra} >>`,
    `<< /Type /EmbeddedFile /Length 1 ${streamKeys} >>\nstream\nA\nendstream`,
  ]));
}

it('repairs imported files once, retaining direct and indirect origins and metadata after Save/Open', () => {
  const doc = imported("/Params << /ModDate (D:20240229103000Z) /Size 1 >>", '/AFRelationship /Alternative');
  doc.ConvertToPdfA('3b');
  const reopened = Document.Open(doc.Save());
  const [file] = reopened.GetAttachments();
  expect(file.Relationship).toBe('Unspecified');
  expect(file.Description).toBe('original');
  expect(file.MimeType).toBe('application/octet-stream');
  expect(file.ModDate?.toISOString()).toBe('2024-02-29T10:30:00.000Z');
  expect(file.GetBytes()).toEqual(bytes);
  expect(file.Dict.get('UF')).toEqual(file.Dict.get('F'));
  const refs = af(reopened);
  expect(refs).toHaveLength(2);
  expect(refs.every(isRef)).toBe(true);
  expect(refs.map(ref => reopened.resolve(ref))).toContain(file.Dict);
  const annotRef = reopened.Pages[0].Annotations[0].Dict.get('FS');
  expect(refs).toContainEqual(annotRef);
  expect((reopened.resolve(annotRef) as PdfDict).get('AFRelationship')).toEqual(name('Alternative'));
  expect(reopened.ConvertToPdfA('3b').applied.filter(a => a.rule === 'EmbeddedFileSpec')).toEqual([]);
});

it('reports malformed supplied metadata once per stream and retains it for correction', () => {
  const doc = imported('/Subtype /oops /Params << /ModDate (D:20240231) /CreationDate 123 >>',
    '/AFRelationship (Data)');
  const findings = () => doc.ValidatePdfA('3b').Errors.filter(i => i.rule === 'EmbeddedFileSpec');
  for (const key of ['/ModDate', '/CreationDate', '/Subtype']) {
    expect(findings().filter(i => i.message.includes(key))).toHaveLength(1);
  }
  expect(doc.ConvertToPdfA('3b').unresolved.filter(i => i.rule === 'EmbeddedFileSpec')).toHaveLength(4);
  expect(findings().some(i => i.message.includes('/AFRelationship'))).toBe(true);
});

it('preserves object-level associations and custom names, and promotes a direct catalog file once', () => {
  const doc = imported('/Subtype /text#2Fplain', '/AFRelationship /ACME_Custom');
  const page = doc.Pages[0];
  const local = page.Annotations[0].Dict.get('FS')!;
  page.Dict.set('AF', [local]);
  const direct = doc.GetAttachments()[0].Dict;
  const catalogArray = doc.allocObject([direct, direct]);
  doc.catalog().set('AF', catalogArray);
  doc.ConvertToPdfA('3b');
  expect(doc.catalog().get('AF')).toEqual(catalogArray);
  expect(af(doc)).toHaveLength(1);
  expect(isRef(af(doc)[0])).toBe(true);
  expect(page.Dict.get('AF')).toEqual([local]);
  const reopened = Document.Open(doc.Save());
  expect(reopened.GetAssociatedFiles()[0].Dict).toBe(reopened.GetAttachments()[0].Dict);
  expect((reopened.resolve(reopened.Pages[0].Annotations[0].Dict.get('FS')) as PdfDict)
    .get('AFRelationship')).toEqual(name('ACME_Custom'));
});

it('honors preserve and never substitutes the conversion time for a missing source date', () => {
  const doc = imported('/Params << /Size 1 >>');
  expect(doc.ConvertToPdfA('3b', { preserve: ['embeddedFiles'] }).unresolved
    .some(i => i.message.includes('/AFRelationship'))).toBe(true);
  expect(doc.catalog().has('AF')).toBe(false);
  const remaining = doc.ConvertToPdfA('3b').unresolved.filter(i => i.rule === 'EmbeddedFileSpec');
  expect(remaining).toHaveLength(1);
  expect(remaining[0].message).toContain('/ModDate');
});
