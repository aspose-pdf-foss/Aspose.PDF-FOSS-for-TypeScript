import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildPkcs12 } from './helpers/build-pkcs12.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';
import { PageFormat } from '../src/pageformat.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import { LoadLimits } from '../src/loadlimits.js';

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

describe('verifying an encrypted document', () => {
  it.each(['aes128', 'aes256'] as const)('verifies pending and reopened %s signed bytes', async (algorithm) => {
    const password = 'fixture password';
    const base = Document.New(PageFormat.A4).Save({ encrypt: { algorithm, userPassword: password } });
    let suppliedPassword = password;
    const options = new class {
      get password() { return suppliedPassword; }
    }();
    const doc = Document.Open(base, options);
    await doc.Sign(buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    const bytes = doc.Save();
    const snapshot = bytes.slice();
    expect(bytes.subarray(0, base.length)).toEqual(base);

    const reopened = Document.Open(bytes, { password });
    const { contents, byteRange } = reopened.Signatures[0];
    suppliedPassword = '';
    expect(inspect(doc).includes(password)).toBe(false);
    const verdict = {
      name: 'Approval', signature: 'valid', integrity: 'valid',
      coversWholeFile: true, structureFindings: [],
    };
    expect(await doc.VerifySignatures()).toMatchObject([verdict]);
    expect(await reopened.VerifySignatures()).toMatchObject([verdict]);
    expect(doc.Save()).toEqual(snapshot);
    expect(Document.Open(bytes, { password }).Signatures[0]).toMatchObject({ contents, byteRange });
  });

  it.each(['rsa', 'ec'] as const)('verifies using the opened %s recipient credential', async (type) => {
    const { certificate, privateKey } = buildSigner({ type });
    const options = { recipient: { certificate, privateKey } };
    const base = Document.New(PageFormat.A4).Save({ encrypt: { recipients: [{ certificate }] } });
    const doc = Document.Open(base, options);
    await doc.Sign(buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    const bytes = doc.Save();
    const verdict = { name: 'Approval', signature: 'valid', integrity: 'valid', structureFindings: [] };
    const reopened = Document.Open(bytes, options);
    certificate.fill(0);
    expect(await doc.VerifySignatures()).toMatchObject([verdict]);
    expect(await reopened.VerifySignatures()).toMatchObject([verdict]);
  });

  it('retains the authenticated key after the caller clears a PKCS#12 bundle', async () => {
    const passphrase = 'fixture bundle passphrase';
    const { certificate, p12 } = buildPkcs12({ passphrase });
    const base = Document.New(PageFormat.A4).Save({ encrypt: { recipients: [{ certificate }] } });
    const doc = Document.Open(base, { recipient: { pkcs12: p12, passphrase } });
    p12.fill(0);
    await doc.Sign(buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    expect(inspect(doc).includes(passphrase)).toBe(false);
    expect(await doc.VerifySignatures()).toMatchObject([{
      name: 'Approval', signature: 'valid', integrity: 'valid', structureFindings: [],
    }]);
  });

  it('reopens the encrypted signed revision for structure, permissions, and appearance analysis', async () => {
    const options = { password: 'fixture password' };
    const original = Document.New(PageFormat.A4);
    original.Pages[0].Graphics().setFillColor([1, 0, 0]).drawRect(30, 30, 80, 80).fill().apply();
    const base = original.Save({ encrypt: { algorithm: 'aes128', userPassword: options.password } });
    const doc = Document.Open(base, options);
    await doc.Certify(buildSigner({ type: 'ec' }), { fieldName: 'Approval', permissions: 'no-changes' });
    const signed = doc.Save();

    const edit = Document.Open(signed, options);
    edit.Pages[0].AddSquare({ rect: [25, 25, 120, 120], fill: [0, 0, 1], width: 0 });
    const bytes = edit.Save({ incremental: true });
    expect(bytes.subarray(0, signed.length)).toEqual(signed);

    const reports = await Document.Open(bytes, options).VerifySignatures({ shadowAnalysis: true });
    expect(reports).toMatchObject([{
      name: 'Approval', signature: 'valid', integrity: 'valid',
      coversWholeFile: false, docMDP: 'violated', structureFindings: [],
      unsignedContent: { pages: [1] },
      shadowAnalysis: { findings: [{ page: 1, kind: 'hide-and-replace', overlay: true }], skippedPages: [] },
    }]);
  });

  it('verifies an encrypted document timestamp before and after a later revision', async () => {
    const options = { password: 'fixture password' };
    const base = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: options.password } });
    const doc = Document.Open(base, options);
    const tsa = buildSigner({ type: 'ec' });
    await doc.AddDocumentTimestamp((request) => buildTimeStampToken(request, tsa), { fieldName: 'Proof' });
    const timestamped = doc.Save();

    const verdict = {
      name: 'Proof', timestamp: { valid: true, imprintMatches: true, tokenSignatureValid: true },
      structureFindings: [],
    };
    expect(await doc.VerifyDocumentTimestamps()).toMatchObject([{ ...verdict, coversWholeFile: true }]);
    const edit = Document.Open(timestamped, options);
    edit.SetMetadata({ title: 'Reviewed' });
    const bytes = edit.Save({ incremental: true });
    expect(bytes.subarray(0, timestamped.length)).toEqual(timestamped);
    expect(await Document.Open(bytes, options).VerifyDocumentTimestamps())
      .toMatchObject([{ ...verdict, coversWholeFile: false }]);
  });

  it('enforces the original file-size limit when reopening pending encrypted bytes', async () => {
    const password = 'fixture password';
    const base = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: password } });
    const limits = LoadLimits.defaults.with({ maxFileBytes: base.length });
    const doc = Document.Open(base, { password, limits });
    await doc.Sign(buildSigner({ type: 'ec' }));

    await expect(doc.VerifySignatures()).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxFileBytes',
    });
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
