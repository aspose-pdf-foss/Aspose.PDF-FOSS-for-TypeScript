import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, issueCert, TestSigner } from './helpers/build-signer.js';
import { buildOcspResponse, buildCrl } from './helpers/build-revocation.js';
import { Document } from '../src/document.js';
import { isArray, isDict, isStream, name } from '../src/types.js';

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

  it.each(['anchors', 'DSS'])('uses a verified issuer from %s when CMS omits it', async (source) => {
    const issuer = issueCert({ type: 'ec', ca: true, commonName: 'Test CA' });
    const s = issueCert({ type: 'ec', issuer, commonName: 'Test signer', digitalSignature: true });
    let doc = Document.Open(await signWith(s));
    if (source === 'DSS') {
      await doc.AddValidationData({ extraCerts: [issuer.certificate] });
      doc = Document.Open(doc.Save());
    }
    const reports = await doc.VerifySignatures({
      trustAnchors: source === 'anchors' ? [issuer.certificate] : undefined,
      getOCSP: (target, foundIssuer) => {
        expect(target).toEqual(s.certificate);
        expect(foundIssuer).toEqual(issuer.certificate);
        return undefined;
      },
    });
    expect(reports[0]).toMatchObject({ integrity: 'valid', signature: 'valid',
      chain: source === 'anchors' ? 'trusted' : 'unchecked', revocation: 'unchecked' });
  });

  it('keeps stale callback, offline, and DSS evidence inconclusive without changing other verdicts', async () => {
    const s = buildSigner({ type: 'ec' });
    const doc = Document.Open(await signWith(s));
    const { name } = doc.Signatures[0];
    const at = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const opts = { at, trustAnchors: [s.certificate] };
    const verdict = { integrity: 'valid', signature: 'valid', chain: 'trusted', revocation: 'unknown' };

    expect((await doc.VerifySignatures({ ...opts, getOCSP: () => ocsp }))[0]).toMatchObject(verdict);
    expect((await doc.VerifySignatures({ ...opts, offline: new Map([[name, { ocsp }]]) }))[0]).toMatchObject(verdict);
    await doc.AddValidationData({ getOCSP: () => ocsp });
    expect((await Document.Open(doc.Save()).VerifySignatures(opts))[0]).toMatchObject(verdict);
  });

  it('keeps a damaged DSS evidence stream inconclusive without changing other verdicts', async () => {
    const s = buildSigner({ type: 'ec' });
    const doc = Document.Open(await signWith(s));
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    await doc.AddValidationData({ getOCSP: () => ocsp });
    const ltv = Document.Open(doc.Save());
    const dss = ltv.resolve(ltv.catalog().get('DSS'));
    if (!isDict(dss)) throw new Error('missing DSS fixture');
    const refs = ltv.resolve(dss.get('OCSPs'));
    if (!isArray(refs)) throw new Error('missing OCSP fixture');
    const response = ltv.resolve(refs[0]);
    if (!isStream(response)) throw new Error('missing OCSP stream');
    response.dict.set('Filter', name('FlateDecode'));

    const reopened = Document.Open(ltv.Save({ incremental: true }));
    expect((await reopened.VerifySignatures({ trustAnchors: [s.certificate] }))[0]).toMatchObject({
      integrity: 'valid', signature: 'valid', chain: 'trusted', revocation: 'unknown',
    });
  });
});
