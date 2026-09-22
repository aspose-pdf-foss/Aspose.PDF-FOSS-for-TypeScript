import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { decodePng } from './helpers/decode-png.js';
import { Document } from '../src/document.js';
import { isDict, isRef, isName, PdfDict } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

const RECT: [number, number, number, number] = [20, 120, 180, 170];

function acroOf(doc: Document): PdfDict {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) throw new Error('no /AcroForm');
  return acro;
}

/** Ink pixels (anything not near-white) in a page render. */
function ink(doc: Document): number {
  const png = decodePng(doc.Pages[0].ToImage());
  let n = 0;
  for (let i = 0; i < png.data.length; i += png.channels)
    if (png.data[i] < 200 || png.data[i + 1] < 200 || png.data[i + 2] < 200) n++;
  return n;
}

/** Save and reopen, so a sign lands on the INCREMENTAL path (unmodified base). */
const reopen = (doc: Document) => Document.Open(doc.Save());

describe('Form.AddSignatureField (puep.1)', () => {
  it('creates an unsigned /FT /Sig field that reads back as a signature', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const f = doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    expect(f.Type).toBe('signature');
    expect(f.Dict.has('V')).toBe(false);
    const ft = f.Dict.get('FT');
    expect(isName(ft) && ft.name).toBe('Sig');

    const back = reopen(doc);
    const g = back.Form.Get('Approver');
    expect(g?.Type).toBe('signature');
    expect(back.Signatures.map((s) => [s.name, s.isSigned])).toEqual([['Approver', false]]);
  });

  it('sets SignaturesExist while keeping the /SigFlags bits already there', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'A' });
    expect(acroOf(doc).get('SigFlags')).toBe(1);   // bit 2 (AppendOnly) belongs to signing

    const doc2 = Document.Open(buildClassicPdf(1));
    doc2.Form.AddTextField({ page: 1, rect: [20, 80, 180, 100], name: 't' });
    acroOf(doc2).set('SigFlags', 2);
    doc2.Form.AddSignatureField({ page: 1, rect: RECT, name: 'B' });
    expect(acroOf(doc2).get('SigFlags')).toBe(3);
  });

  it('Page.AddSignatureField binds the page', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const f = doc.Pages[0].AddSignatureField({ rect: RECT, name: 'P' });
    expect(f.FullName).toBe('P');
    expect(doc.Pages[0].Annotations.length).toBe(1);
  });

  it('creates a nested field under a dotted name, reported by its full name', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'sigs.manager' });
    const back = reopen(doc);
    expect(back.Signatures.map((s) => s.name)).toEqual(['sigs.manager']);
  });

  it('renders as a visible empty box by default', () => {
    const plain = Document.Open(buildClassicPdf(1));
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Box' });
    expect(ink(doc)).toBeGreaterThan(ink(plain) + 100);
  });

  it('honours an explicit null border (no default ink)', () => {
    const plain = Document.Open(buildClassicPdf(1));
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({
      page: 1, rect: RECT, name: 'Bare', borderColor: null, backgroundColor: null,
    });
    expect(ink(doc)).toBe(ink(plain));
  });

  it('leaves the document byte-identical when a call is rejected', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Dup' });
    const before = doc.Save();
    expect(() => doc.Form.AddSignatureField({ page: 9, rect: RECT, name: 'X' })).toThrow(RangeError);
    expect(() => doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Dup' })).toThrow();
    expect(doc.Save()).toEqual(before);
  });

  it('refuses to have its value set, since filling one is signing it', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const f = doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'S' });
    expect(() => { f.Value = 'x'; }).toThrow();
  });

  it('removes like any other field', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Gone' });
    expect(doc.Form.RemoveField('Gone')).toBe(true);
    const back = reopen(doc);
    expect(back.Form.Fields.length).toBe(0);
    expect(back.Pages[0].Annotations.length).toBe(0);
  });
});

describe('Sign({ fieldName }) fills an existing empty field (puep.1)', () => {
  async function signedOnce(doc: Document, opts = {}): Promise<Document> {
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'Approver', ...opts });
    return Document.Open(doc.Save());
  }

  it('fills the field on the full-rewrite path rather than adding a second', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    const out = await signedOnce(doc);
    expect(out.Form.Fields.length).toBe(1);
    expect(out.Signatures.map((s) => [s.name, s.isSigned])).toEqual([['Approver', true]]);
    expect(out.Pages[0].Annotations.length).toBe(1);
    const [r] = await out.VerifySignatures();
    expect(r.integrity).toBe('valid');
    expect(r.signature).toBe('valid');
    expect(acroOf(out).get('SigFlags')).toBe(3);
  });

  it('fills the field on the incremental path', async () => {
    const prepared = Document.Open(buildClassicPdf(1));
    prepared.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    const base = prepared.Save();
    const doc = Document.Open(base);
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'Approver' });
    const bytes = doc.Save();
    // Incremental: the prepared file survives as a byte-identical prefix.
    expect(bytes.subarray(0, base.length)).toEqual(base);
    const out = Document.Open(bytes);
    expect(out.Form.Fields.length).toBe(1);
    expect(out.Signatures.map((s) => s.isSigned)).toEqual([true]);
    const [r] = await out.VerifySignatures();
    expect(r.integrity).toBe('valid');
    expect(r.signature).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
  });

  it('fills a second prepared field after a first signature, keeping both valid', async () => {
    const prepared = Document.Open(buildClassicPdf(1));
    prepared.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Author' });
    prepared.Form.AddSignatureField({ page: 1, rect: [20, 20, 180, 70], name: 'Approver' });
    const first = Document.Open(prepared.Save());
    await first.Sign(signerOf(buildSigner()), { fieldName: 'Author' });
    const second = Document.Open(first.Save());
    await second.Sign(signerOf(buildSigner()), { fieldName: 'Approver' });
    const out = Document.Open(second.Save());
    expect(out.Form.Fields.length).toBe(2);
    const reports = await out.VerifySignatures();
    expect(reports.map((r) => [r.name, r.integrity, r.signature]))
      .toEqual([['Author', 'valid', 'valid'], ['Approver', 'valid', 'valid']]);
  });

  it('fills a nested field by its full name', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'sigs.Approver' });
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'sigs.Approver' });
    const out = Document.Open(doc.Save());
    expect(out.Form.Fields.length).toBe(1);
    expect(out.Signatures.map((s) => [s.name, s.isSigned])).toEqual([['sigs.Approver', true]]);
  });

  it('draws a visible appearance into the prepared widget', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    const empty = ink(doc);
    await doc.Sign(signerOf(buildSigner()), {
      fieldName: 'Approver', appearance: { page: 0, rect: RECT, text: 'Signed by the approver' },
    });
    const out = Document.Open(doc.Save());
    const w = out.Form.Get('Approver')!.Dict;
    const ap = out.resolve(w.get('AP'));
    expect(isDict(ap) && isRef(ap.get('N'))).toBe(true);
    // The signed appearance REPLACES the empty box (its border is gone, text is
    // drawn), so it differs from the box and still inks well past a bare page.
    const plain = ink(Document.Open(buildClassicPdf(1)));
    expect(ink(out)).not.toBe(empty);
    expect(ink(out)).toBeGreaterThan(plain + 100);
    expect(out.Pages[0].Annotations.length).toBe(1);
  });

  it('refuses an appearance placed somewhere other than the prepared widget', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    const before = doc.Save();
    await expect(doc.Sign(signerOf(buildSigner()), {
      fieldName: 'Approver', appearance: { page: 0, rect: [0, 0, 50, 50] },
    })).rejects.toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses a field that is already signed', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    const out = await signedOnce(doc);
    await expect(out.Sign(signerOf(buildSigner()), { fieldName: 'Approver' }))
      .rejects.toThrow(/already signed/);
  });

  it('refuses a name that belongs to a non-signature field', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddTextField({ page: 1, rect: RECT, name: 'Approver' });
    const before = doc.Save();
    await expect(doc.Sign(signerOf(buildSigner()), { fieldName: 'Approver' }))
      .rejects.toThrow(/not a signature field/);
    expect(doc.Save()).toEqual(before);
  });

  it('still creates a new field for a name that does not exist', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    await doc.Sign(signerOf(buildSigner()), { fieldName: 'Other' });
    const out = Document.Open(doc.Save());
    expect(out.Signatures.map((s) => [s.name, s.isSigned]))
      .toEqual([['Approver', false], ['Other', true]]);
  });

  it('Certify fills a prepared field too', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'Approver' });
    await doc.Certify(signerOf(buildSigner()), { fieldName: 'Approver' });
    const out = Document.Open(doc.Save());
    expect(out.Form.Fields.length).toBe(1);
    const [r] = await out.VerifySignatures();
    expect(r.signature).toBe('valid');
  });
});
