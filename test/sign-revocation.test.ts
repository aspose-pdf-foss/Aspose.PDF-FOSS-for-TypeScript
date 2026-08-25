import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildOcspResponse, buildCrl } from './helpers/build-revocation.js';
import { Document } from '../src/document.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Sign a fresh document with `s` and return the saved bytes. */
async function signWith(s: TestSigner): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'rev' });
  await doc.Sign(signerOf(s), {});
  return doc.Save();
}

describe('Document.VerifySignatures — revocation (V3)', () => {
  it('reports good from an OCSP callback', async () => {
    const s = buildSigner({ type: 'rsa' });
    const bytes = await signWith(s);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });

    const reports = await Document.Open(bytes).VerifySignatures({ getOCSP: () => ocsp });
    expect(reports[0].signature).toBe('valid');
    expect(reports[0].revocation).toBe('good');
  });

  it('reports revoked from an OCSP callback', async () => {
    const s = buildSigner();
    const bytes = await signWith(s);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'revoked' });
    const reports = await Document.Open(bytes).VerifySignatures({ getOCSP: () => ocsp });
    expect(reports[0].revocation).toBe('revoked');
  });

  it('reports revoked from a CRL callback', async () => {
    const s = buildSigner();
    const bytes = await signWith(s);
    const crl = buildCrl({ issuer: s, revokedSerials: [0x0123456789n] });
    const reports = await Document.Open(bytes).VerifySignatures({ getCRL: () => crl });
    expect(reports[0].revocation).toBe('revoked');
  });

  it('leaves revocation unchecked when no source is supplied', async () => {
    const s = buildSigner();
    const reports = await Document.Open(await signWith(s)).VerifySignatures();
    expect(reports[0].revocation).toBe('unchecked');
  });

  it('reports good from offline material keyed by field name', async () => {
    const s = buildSigner();
    const bytes = await signWith(s);
    const name = Document.Open(bytes).Signatures[0].name;
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });

    const reports = await Document.Open(bytes).VerifySignatures({ offline: new Map([[name, { ocsp }]]) });
    expect(reports[0].revocation).toBe('good');
  });
});
