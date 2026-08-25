import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import { Document } from '../src/document.js';
import type { CmsSigner } from '../src/cms.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** A timestamp provider backed by an in-process test TSA. */
function testTsa(t: TestSigner): (req: Uint8Array) => Promise<Uint8Array> {
  const signer: CmsSigner = { certificate: t.certificate, privateKey: t.privateKey };
  return (req) => buildTimeStampToken(req, signer);
}

describe('Document.Sign — RFC 3161 timestamp (PAdES-B-T)', () => {
  it('embeds a timestamp token and reports it on verification', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'TS' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), {
      reason: 'timestamped',
      timestamp: testTsa(buildSigner({ type: 'rsa', commonName: 'Test TSA' })),
      placeholderBytes: 16384, // token + TSA cert needs more than the 8 KiB default
    });
    const bytes = doc.Save();

    const reports = await Document.Open(bytes).VerifySignatures();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.integrity).toBe('valid');
    expect(r.signature).toBe('valid');
    expect(r.timestamp).toBeDefined();
    expect(r.timestamp!.valid).toBe(true);
    expect(r.timestamp!.imprintMatches).toBe(true);
    expect(r.timestamp!.tokenSignatureValid).toBe(true);
    expect(r.timestamp!.time).toBeInstanceOf(Date);
  });

  it('leaves the timestamp report undefined for an un-timestamped signature', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'plain' });
    await doc.Sign(signerOf(buildSigner()), { reason: 'no ts' });
    const reports = await Document.Open(doc.Save()).VerifySignatures();
    expect(reports[0].signature).toBe('valid');
    expect(reports[0].timestamp).toBeUndefined();
  });

  it('binds the timestamp to this signature (tampering the body breaks both)', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'tamper' });
    await doc.Sign(signerOf(buildSigner()), {
      timestamp: testTsa(buildSigner({ commonName: 'Test TSA' })),
      placeholderBytes: 16384,
    });
    const bytes = doc.Save();
    const sig = Document.Open(bytes).Signatures[0];
    bytes[Math.floor(sig.byteRange![1] / 2)] ^= 0xff; // corrupt the signed range

    const r = (await Document.Open(bytes).VerifySignatures())[0];
    expect(r.integrity).toBe('tampered');
    // The timestamp token itself is intact (it signs the signature value, which
    // is unchanged), so its own verdict stays valid — integrity is what flips.
    expect(r.timestamp?.tokenSignatureValid).toBe(true);
  });
});
