import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Sign a fresh document (full rewrite) and return the saved bytes. */
async function signedBytes(type: 'rsa' | 'ec' | 'ed25519' = 'rsa'): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'doc' }); // force full rewrite
  await doc.Sign(signerOf(buildSigner({ type, commonName: 'Acme Signer' })), { reason: 'ok' });
  return doc.Save();
}

describe('Document.VerifySignatures (V1: integrity + crypto + coverage)', () => {
  it('reports a freshly-signed document as valid and whole-file', async () => {
    const bytes = await signedBytes('rsa');
    const reports = await Document.Open(bytes).VerifySignatures();
    expect(reports.length).toBe(1);
    const r = reports[0];
    expect(r.integrity).toBe('valid');
    expect(r.signature).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
    expect(r.modifications).toEqual([]);
    expect(r.chain).toBe('unchecked');
    expect(r.revocation).toBe('unchecked');
    expect(r.docMDP).toBe('n/a');
    expect(r.signerCert?.subject).toContain('Acme Signer');
  });

  it('verifies ECDSA and Ed25519 signatures too', async () => {
    for (const type of ['ec', 'ed25519'] as const) {
      const reports = await Document.Open(await signedBytes(type)).VerifySignatures();
      expect(reports[0].integrity).toBe('valid');
      expect(reports[0].signature).toBe('valid');
    }
  });

  it('flags tampered content: digest fails but the CMS signature still verifies', async () => {
    const bytes = await signedBytes('rsa');
    const sig = Document.Open(bytes).Signatures[0];
    const [, a] = sig.byteRange!;
    bytes[Math.floor(a / 2)] ^= 0xff; // flip a byte inside the first signed range

    const r = (await Document.Open(bytes).VerifySignatures())[0];
    expect(r.integrity).toBe('tampered');
    expect(r.signature).toBe('valid'); // signed attributes are intact
  });

  it('verifies an incrementally-signed document and preserves whole-file coverage', async () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base); // unmodified -> incremental append
    await doc.Sign(signerOf(buildSigner()), {});
    const bytes = doc.Save();
    expect(bytes.subarray(0, base.length)).toEqual(base);

    const r = (await Document.Open(bytes).VerifySignatures())[0];
    expect(r.integrity).toBe('valid');
    expect(r.coversWholeFile).toBe(true);
    expect(r.modifications).toEqual([]);
  });

  it('reports post-signing changes for an earlier signature in a doubly-signed file', async () => {
    // First signature (incremental append).
    const first = Document.Open(buildClassicPdf(1));
    await first.Sign(signerOf(buildSigner({ commonName: 'First' })), {});
    const once = first.Save();

    // Second signature: open the signed file (has a prior sig) -> incremental append.
    const second = Document.Open(once);
    await second.Sign(signerOf(buildSigner({ commonName: 'Second' })), {});
    const twice = second.Save();

    const reports = await Document.Open(twice).VerifySignatures();
    expect(reports.length).toBe(2);
    const earliest = reports.reduce((m, r) => (r.coversWholeFile ? m : r));
    const latest = reports.find((r) => r.coversWholeFile)!;

    // Both signatures verify cryptographically.
    for (const r of reports) {
      expect(r.integrity).toBe('valid');
      expect(r.signature).toBe('valid');
    }
    // The earlier signature does NOT cover the appended second revision, and the
    // change report lists the objects added after it.
    expect(earliest.coversWholeFile).toBe(false);
    expect(earliest.modifications.length).toBeGreaterThan(0);
    expect(latest.coversWholeFile).toBe(true);
  });
});
