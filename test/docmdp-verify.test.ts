import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { appendIncrementalUpdate } from '../src/incremental.js';
import {
  PdfDict, PdfObject, PdfRef, isArray, name, ref,
} from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

type Perm = 'no-changes' | 'form-fill' | 'form-fill-and-annotate';

/** Certify a fresh 1-page document at `perm` and return the saved (whole-file) bytes. */
async function certified(perm: Perm): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'doc' }); // force a full rewrite so the cert covers the whole file
  await doc.Certify(signerOf(buildSigner({ type: 'rsa', commonName: 'Author' })), { permissions: perm });
  return doc.Save();
}

/** Append an approval signature (incremental) onto already-certified bytes. */
async function approvalSign(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = Document.Open(bytes);
  await doc.Sign(signerOf(buildSigner({ type: 'ec', commonName: 'Approver' })), { reason: 'approved' });
  return doc.Save();
}

/** The verification report for the certification signature (the one that does not
 *  cover the whole file once something has been appended after it). */
function certReport(reports: Awaited<ReturnType<Document['VerifySignatures']>>) {
  return reports.find((r) => !r.coversWholeFile) ?? reports[0];
}

/** Locate page 0's object number and dict via the public catalog/resolve API. */
function page0(doc: Document): { num: number; dict: PdfDict } {
  const pages = doc.resolve(doc.catalog().get('Pages')) as PdfDict;
  const kids = doc.resolve(pages.get('Kids')) as PdfObject[];
  const pageRef = kids[0] as PdfRef;
  return { num: pageRef.num, dict: doc.getObject(pageRef.num) as PdfDict };
}

describe('Document.VerifySignatures (V4: /DocMDP enforcement)', () => {
  it('reports n/a for a plain (non-certified) signature', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'doc' });
    await doc.Sign(signerOf(buildSigner()), {});
    const reports = await Document.Open(doc.Save()).VerifySignatures();
    expect(reports[0].docMDP).toBe('n/a');
  });

  it('reports ok for a certification that covers the whole file (no later changes)', async () => {
    const reports = await Document.Open(await certified('no-changes')).VerifySignatures();
    expect(reports.length).toBe(1);
    expect(reports[0].docMDP).toBe('ok');
  });

  it('permits an approval signature under form-fill (P=2): cert ok, approval n/a', async () => {
    const bytes = await approvalSign(await certified('form-fill'));
    const reports = await Document.Open(bytes).VerifySignatures();
    expect(reports.length).toBe(2);
    expect(certReport(reports).docMDP).toBe('ok');
    expect(reports.find((r) => r.coversWholeFile)!.docMDP).toBe('n/a');
  });

  it('flags an approval signature under no-changes (P=1) as violated', async () => {
    const bytes = await approvalSign(await certified('no-changes'));
    const reports = await Document.Open(bytes).VerifySignatures();
    expect(certReport(reports).docMDP).toBe('violated');
  });

  it('flags a disallowed catalog change as violated at every level', async () => {
    for (const perm of ['form-fill', 'form-fill-and-annotate'] as const) {
      const base = await certified(perm);
      const src = Document.Open(base);
      const rootNum = (src.trailer.get('Root') as PdfRef).num;
      const cat = new Map(src.catalog()) as PdfDict;
      cat.set('Lang', { kind: 'string', bytes: new TextEncoder().encode('en-US') });
      const modified = appendIncrementalUpdate(base, { objects: new Map([[rootNum, cat]]) });
      const reports = await Document.Open(modified).VerifySignatures();
      expect(certReport(reports).docMDP).toBe('violated');
    }
  });

  it('treats an added annotation as a violation at P=2 but permitted at P=3', async () => {
    const cases: Array<[Perm, 'ok' | 'violated']> = [
      ['form-fill', 'violated'],
      ['form-fill-and-annotate', 'ok'],
    ];
    for (const [perm, expected] of cases) {
      const base = await certified(perm);
      const src = Document.Open(base);
      const { num: pageNum, dict: pageDict } = page0(src);
      const annotNum = src.trailer.get('Size') as number;
      const annot: PdfDict = new Map<string, PdfObject>([
        ['Type', name('Annot')],
        ['Subtype', name('Text')],
        ['Rect', [10, 10, 30, 30]],
        ['Contents', { kind: 'string', bytes: new TextEncoder().encode('note') }],
      ]);
      const newPage = new Map(pageDict) as PdfDict;
      const annots = src.resolve(newPage.get('Annots'));
      newPage.set('Annots', isArray(annots) ? [...annots, ref(annotNum)] : [ref(annotNum)]);
      const objects = new Map<number, PdfObject>([[pageNum, newPage], [annotNum, annot]]);
      const modified = appendIncrementalUpdate(base, { objects });
      const reports = await Document.Open(modified).VerifySignatures();
      expect(certReport(reports).docMDP).toBe(expected);
    }
  });
});
