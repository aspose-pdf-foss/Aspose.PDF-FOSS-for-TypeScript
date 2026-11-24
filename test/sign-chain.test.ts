import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { issueCert } from './helpers/build-signer.js';
import { Document } from '../src/document.js';

/** Sign a fresh document with `leaf`, embedding `chain` intermediates. */
async function signWithChain(leaf: { certificate: Uint8Array; privateKey: any }, chain: Uint8Array[]): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'chain' });
  await doc.Sign({ certificate: leaf.certificate, privateKey: leaf.privateKey, chain }, {});
  return doc.Save();
}

describe('Document.VerifySignatures — certificate chain (V2)', () => {
  it('reports trusted when the signer chains to a supplied anchor', async () => {
    const root = issueCert({ ca: true, commonName: 'Trusted Root' });
    const leaf = issueCert({ issuer: root, digitalSignature: true, commonName: 'Signer' });
    const bytes = await signWithChain(leaf, [root.certificate]);

    const reports = await Document.Open(bytes).VerifySignatures({ trustAnchors: [root.certificate] });
    expect(reports[0].signature).toBe('valid');
    expect(reports[0].chain).toBe('trusted');
  });

  it('skips a malformed DSS certificate before the usable intermediate', async () => {
    const root = issueCert({ type: 'ec', ca: true, commonName: 'Trusted Root' });
    const intermediate = issueCert({ type: 'ec', issuer: root, ca: true, commonName: 'Intermediate' });
    const leaf = issueCert({ type: 'ec', issuer: intermediate, digitalSignature: true, commonName: 'Signer' });
    const doc = Document.Open(await signWithChain(leaf, []));
    const opts = { trustAnchors: [root.certificate] };
    expect((await doc.VerifySignatures(opts))[0].chain).toBe('untrusted');

    const malformed = Uint8Array.of(0x30, 0x00); // Empty DER sequence, not a certificate.
    await doc.AddValidationData({ extraCerts: [malformed, intermediate.certificate] });

    expect((await Document.Open(doc.Save()).VerifySignatures(opts))[0]).toMatchObject({
      integrity: 'valid', signature: 'valid', chain: 'trusted', revocation: 'unchecked',
    });
  });

  it('reports untrusted against an unrelated anchor', async () => {
    const root = issueCert({ ca: true, commonName: 'Real Root' });
    const stranger = issueCert({ ca: true, commonName: 'Stranger Root' });
    const leaf = issueCert({ issuer: root, digitalSignature: true, commonName: 'Signer' });
    const bytes = await signWithChain(leaf, [root.certificate]);

    const reports = await Document.Open(bytes).VerifySignatures({ trustAnchors: [stranger.certificate] });
    expect(reports[0].chain).toBe('untrusted');
  });

  it('leaves the chain unchecked when no anchors are supplied', async () => {
    const root = issueCert({ ca: true, commonName: 'Root' });
    const leaf = issueCert({ issuer: root, digitalSignature: true, commonName: 'Signer' });
    const reports = await Document.Open(await signWithChain(leaf, [root.certificate])).VerifySignatures();
    expect(reports[0].chain).toBe('unchecked');
  });
});
