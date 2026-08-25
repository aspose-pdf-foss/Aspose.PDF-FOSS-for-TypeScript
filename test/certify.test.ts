import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';
import { isDict, isName, PdfDict, PdfObject } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Recompute the /ByteRange digest and verify the embedded CMS against it. */
function verifyFirstSignature(bytes: Uint8Array): { digestMatches: boolean; signatureValid: boolean } {
  const sig = Document.Open(bytes).Signatures[0];
  const [, a, b, c] = sig.byteRange!;
  const covered = new Uint8Array(a + c);
  covered.set(bytes.subarray(0, a), 0);
  covered.set(bytes.subarray(b, b + c), a);
  const digest = new Uint8Array(createHash('sha256').update(covered).digest());
  return verifySignedData(sig.contents!.subarray(0, sig.cmsLength!), digest);
}

/** The /DocMDP transform params dict reached via catalog /Perms /DocMDP. */
function docMdpParams(doc: Document): PdfDict {
  const perms = doc.resolve(doc.catalog().get('Perms')) as PdfDict;
  expect(isDict(perms)).toBe(true);
  const sig = doc.resolve(perms.get('DocMDP')) as PdfDict;
  expect((sig.get('Type') as { name: string }).name).toBe('Sig');
  const refs = doc.resolve(sig.get('Reference')) as PdfObject[];
  const sigRef = doc.resolve(refs[0]) as PdfDict;
  expect((sigRef.get('TransformMethod') as { name: string }).name).toBe('DocMDP');
  return doc.resolve(sigRef.get('TransformParams')) as PdfDict;
}

describe('Document.Certify (/DocMDP certification signature)', () => {
  it('adds a /DocMDP reference + catalog /Perms and still verifies', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Certify(signerOf(buildSigner({ type: 'rsa' })), { permissions: 'form-fill', reason: 'I certify' });
    const bytes = doc.Save();

    const reopened = Document.Open(bytes);
    const params = docMdpParams(reopened);
    expect(Number(params.get('P'))).toBe(2);
    expect(isName(params.get('V')!)).toBe(true);
    // The /Perms /DocMDP target is exactly the first signature's value dict.
    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
  });

  it('maps each permission level to its /P value', async () => {
    const cases: Array<['no-changes' | 'form-fill' | 'form-fill-and-annotate', number]> = [
      ['no-changes', 1], ['form-fill', 2], ['form-fill-and-annotate', 3],
    ];
    for (const [perm, p] of cases) {
      const doc = Document.Open(buildClassicPdf(1));
      await doc.Certify(signerOf(buildSigner()), { permissions: perm });
      const params = docMdpParams(Document.Open(doc.Save()));
      expect(Number(params.get('P'))).toBe(p);
    }
  });

  it('defaults to no-changes (P=1) when no permission is given', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Certify(signerOf(buildSigner()), {});
    expect(Number(docMdpParams(Document.Open(doc.Save())).get('P'))).toBe(1);
  });

  it('rejects certifying a document that already has a signature', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), {});
    doc.Save();
    await expect(doc.Certify(signerOf(buildSigner()), {})).rejects.toThrow();
  });

  it('rejects certifying twice', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Certify(signerOf(buildSigner()), {});
    doc.Save();
    await expect(doc.Certify(signerOf(buildSigner()), {})).rejects.toThrow();
  });

  it('allows an approval signature after certification (incremental append)', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Certify(signerOf(buildSigner({ type: 'rsa' })), { permissions: 'form-fill' });
    const certified = doc.Save();

    const doc2 = Document.Open(certified);
    await doc2.Sign(signerOf(buildSigner({ type: 'ec' })), { reason: 'approved' });
    const bytes = doc2.Save();

    // Certified revision preserved verbatim as a prefix; two signatures present.
    expect(bytes.subarray(0, certified.length)).toEqual(certified);
    const reopened = Document.Open(bytes);
    expect(reopened.Signatures.filter((s) => s.isSigned).length).toBe(2);
    // The catalog still certifies via /Perms /DocMDP.
    expect(Number(docMdpParams(reopened).get('P'))).toBe(2);
  });
});
