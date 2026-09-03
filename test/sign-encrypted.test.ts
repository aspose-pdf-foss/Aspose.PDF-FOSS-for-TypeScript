import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';

const signerOf = (t: TestSigner): { certificate: Uint8Array; privateKey: any } =>
  ({ certificate: t.certificate, privateKey: t.privateKey });

const encrypted = (): Uint8Array => buildEncryptedPdf(
  { cipher: 'rc4', R: 3, V: 2, length: 128 },
  { info: { Title: 'SecretTitle' }, pageContents: ['BT ET'] },
).bytes;

describe('signing an encrypted document', () => {
  it('produces a signature that verifies', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'ok', name: 'Alice' });
    const bytes = doc.Save();

    const sig = Document.Open(bytes).Signatures[0];
    const [, a, b, c] = sig.byteRange!;
    const covered = new Uint8Array(a + c);
    covered.set(bytes.subarray(0, a), 0);
    covered.set(bytes.subarray(b, b + c), a);
    const digest = new Uint8Array(createHash('sha256').update(covered).digest());
    const r = verifySignedData(sig.contents!.subarray(0, sig.cmsLength!), digest);
    expect(r.digestMatches).toBe(true);
    expect(r.signatureValid).toBe(true);
  });

  // The two mistakes are silent and OPPOSITE: encrypting /Contents breaks the
  // verification above, and failing to encrypt /Name leaks it here.
  it('does not leak the signer name in cleartext', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { name: 'PLAINTEXT_NAME' });
    const text = new TextDecoder('latin1').decode(doc.Save());
    expect(text).not.toContain('PLAINTEXT_NAME');
  });

  it('reads the name back after decrypting', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { name: 'Alice' });
    expect((Document.Open(doc.Save()).Signatures[0].valueDict.get('Name') as { bytes: Uint8Array }).bytes)
      .toEqual(new TextEncoder().encode('Alice'));
  });

  it('leaves the original encrypted content readable', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'ok' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('SecretTitle');
  });
});

// Re-encrypting a document that ALREADY carries a signature is the only path
// that reaches makeEncryptor with a signature dict -- signing itself builds
// that dict as raw text and bypasses it. Without the exemption there, /Contents
// is encrypted a second time on the rewrite and is silently destroyed.
describe('re-encrypting a document that already contains a signature', () => {
  it('leaves the existing /Contents untouched', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'ok' });
    const signed = doc.Save();

    const before = Document.Open(signed).Signatures[0].contents!;
    // A full rewrite, which preserves encryption and so runs every object --
    // the signature dict included -- through the encryptor.
    const rewritten = Document.Open(signed).Save();
    const after = Document.Open(rewritten).Signatures[0].contents!;

    expect(after).toEqual(before);
  });
});
