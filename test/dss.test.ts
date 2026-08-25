import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildOcspResponse, buildCrl } from './helpers/build-revocation.js';
import { Document } from '../src/document.js';
import { readDssMaterial, vriKey } from '../src/dss.js';
import { isDict, isArray, PdfDict } from '../src/types.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Sign a fresh single-page document with `s`; return the saved bytes. */
async function signed(s: TestSigner): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'ltv' });
  await doc.Sign(signerOf(s), {});
  return doc.Save();
}

describe('Document.AddValidationData (/DSS, PAdES-B-LT)', () => {
  it('embeds a /DSS with certs + OCSP and preserves the signed prefix', async () => {
    const s = buildSigner({ type: 'rsa' });
    const base = await signed(s);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });

    const doc = Document.Open(base);
    await doc.AddValidationData({ getOCSP: () => ocsp });
    const ltv = doc.Save();

    // Incremental append: the signed revision is preserved byte-for-byte.
    expect(ltv.subarray(0, base.length)).toEqual(base);

    const re = Document.Open(ltv);
    const dss = re.resolve(re.catalog().get('DSS')) as PdfDict;
    expect(isDict(dss)).toBe(true);
    expect(isArray(re.resolve(dss.get('Certs')))).toBe(true);
    expect(isArray(re.resolve(dss.get('OCSPs')))).toBe(true);
    expect(isDict(re.resolve(dss.get('VRI')))).toBe(true);
  });

  it('reads the embedded material back keyed by the VRI / field name', async () => {
    const s = buildSigner();
    const base = await signed(s);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const doc = Document.Open(base);
    await doc.AddValidationData({ getOCSP: () => ocsp });

    const re = Document.Open(doc.Save());
    const sig = re.Signatures[0];
    // The /VRI is keyed by the uppercase SHA-1 of the signature /Contents.
    const dss = re.resolve(re.catalog().get('DSS')) as PdfDict;
    const vri = re.resolve(dss.get('VRI')) as PdfDict;
    expect(vri.has(vriKey(sig.contents!))).toBe(true);

    const material = readDssMaterial(re);
    expect(material.get(sig.name)?.ocsp).toEqual(ocsp);
  });

  it('lets VerifySignatures check revocation offline from /DSS (no callbacks)', async () => {
    const s = buildSigner();
    const base = await signed(s);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const doc = Document.Open(base);
    await doc.AddValidationData({ getOCSP: () => ocsp });

    const reports = await Document.Open(doc.Save()).VerifySignatures();
    expect(reports[0].integrity).toBe('valid');
    expect(reports[0].signature).toBe('valid');
    expect(reports[0].revocation).toBe('good'); // resolved from embedded /DSS
  });

  it('embeds a CRL and reports revoked offline', async () => {
    const s = buildSigner();
    const base = await signed(s);
    const crl = buildCrl({ issuer: s, revokedSerials: [0x0123456789n] });
    const doc = Document.Open(base);
    await doc.AddValidationData({ getCRL: () => crl });

    const reports = await Document.Open(doc.Save()).VerifySignatures();
    expect(reports[0].revocation).toBe('revoked');
  });

  it('throws when the document has no signatures', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.AddValidationData({})).rejects.toThrow();
  });
});
