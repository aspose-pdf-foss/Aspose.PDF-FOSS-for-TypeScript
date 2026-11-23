import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildPkcs12 } from './helpers/build-pkcs12.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildCrl, buildOcspResponse } from './helpers/build-revocation.js';
import { Document, type OpenOptions } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';
import { readDssCerts, readDssMaterial } from '../src/dss.js';
import { InvalidPasswordError, UnsupportedFeatureError } from '../src/errors.js';
import { PageFormat } from '../src/pageformat.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import { LoadLimits } from '../src/loadlimits.js';
import { serializeDocument } from '../src/serializer.js';

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

describe('protecting encrypted PDFs during signing', () => {
  it.each([
    ['Sign', 'aes128'], ['Certify', 'aes256'],
  ] as const)('%s refuses a rewrite after editing an unsigned %s PDF', async (method, algorithm) => {
    const password = 'fixture password';
    const base = Document.New(PageFormat.A4).Save({ encrypt: { algorithm, userPassword: password } });
    const doc = Document.Open(base, { password });
    doc.SetMetadata({ title: 'Edited title' });
    const before = structuredClone([...doc.objectEntries()]);

    const signing = doc[method](buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    await expect(signing).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(signing).rejects.toThrow(/save and reopen/i);
    expect(doc.Signatures).toHaveLength(0);
    expect([...doc.objectEntries()]).toEqual(before);
    const saved = doc.Save({ incremental: true });
    expect(saved.subarray(0, base.length)).toEqual(base);
    expect(() => Document.Open(saved)).toThrow(InvalidPasswordError);
    expect(Document.Open(saved, { password }).GetMetadata().title).toBe('Edited title');
  });

  it('refuses a rewrite after editing an unsigned certificate-encrypted PDF', async () => {
    const { certificate, privateKey } = buildSigner({ type: 'ec' });
    const options = { recipient: { certificate, privateKey } };
    const base = Document.New(PageFormat.A4).Save({ encrypt: { recipients: [{ certificate }] } });
    const doc = Document.Open(base, options);
    doc.Lang = 'en-US';
    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.Signatures).toHaveLength(0);
    const saved = doc.Save();
    expect(() => Document.Open(saved)).toThrow(InvalidPasswordError);
    expect(Document.Open(saved, options).Lang).toBe('en-US');
  });

  it.each(['Sign', 'Certify'] as const)('%s appends to an encrypted PDF after edits are saved and reopened', async (method) => {
    const options = { password: 'fixture password' };
    const base = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: options.password } });
    const prepared = Document.Open(base, options);
    prepared.SetMetadata({ title: 'Prepared' });
    prepared.Form.AddTextField({ name: 'field', page: 1, rect: [10, 10, 60, 20], value: 'current' });
    prepared.Form.AddBarcodeField({ name: 'barcode', page: 1, rect: [10, 30, 300, 120] });
    const saved = prepared.Save();
    const doc = Document.Open(saved, options);
    await doc[method](buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
    const signed = doc.Save();
    expect(signed.subarray(0, saved.length)).toEqual(saved);
    expect(() => Document.Open(signed)).toThrow(InvalidPasswordError);
    const reopened = Document.Open(signed, options);
    expect(reopened.GetMetadata().title).toBe('Prepared');
    expect(reopened.Form.Get('barcode')!.Value).toBe('current');
    expect(await reopened.VerifySignatures()).toMatchObject([{
      name: 'Approval', signature: 'valid', integrity: 'valid',
    }]);
  });

  it('checks for edits made while signing awaits credential resolution', async () => {
    const password = 'fixture password';
    const base = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: password } });
    const doc = Document.Open(base, { password });
    const signing = doc.Sign(buildSigner({ type: 'ec' }));
    doc.Lang = 'en-US';
    await expect(signing).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.Signatures).toHaveLength(0);
    expect(doc.Lang).toBe('en-US');
  });

  it('refuses before changing an encrypted PDF with an inline catalog', async () => {
    const password = 'fixture password';
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', R: 4, V: 4, length: 128, userPassword: password },
      { pageContents: ['BT ET'] },
    );
    const input = Buffer.from(bytes).toString('latin1')
      .replace('/Root 1 0 R /Encrypt', '/Root << /Type /Catalog /Pages 2 0 R >> /Encrypt');
    const doc = Document.Open(Buffer.from(input, 'latin1'), { password });
    expect(doc.recovery).toBeUndefined();
    const catalog = structuredClone(doc.catalog());
    const objects = structuredClone([...doc.objectEntries()]);

    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.catalog()).toEqual(catalog);
    expect([...doc.objectEntries()]).toEqual(objects);
  });

  it('retains protected signing rules after an edit to the live trailer', async () => {
    const password = 'fixture password';
    const bytes = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: password } });
    const doc = Document.Open(bytes, { password });
    doc.trailer.delete('Encrypt');
    doc.Lang = 'en-US';
    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.Signatures).toHaveLength(0);
  });

  it('refuses before refreshing a stale barcode in a protected input', async () => {
    const draft = Document.New(PageFormat.A4);
    draft.Form.AddTextField({ name: 'field', page: 1, rect: [10, 10, 60, 20], value: 'old' });
    draft.Form.AddBarcodeField({ name: 'barcode', page: 1, rect: [10, 30, 300, 120] });
    draft.Form.RefreshBarcodes();
    draft.Form.Get('field')!.Value = 'new';
    const entries = [...draft.objectEntries()];
    const [root] = entries.find(([, value]) => value === draft.catalog())!;
    const objects = new Map(entries.map(([r, value]) => [r.num, value]));
    const password = 'fixture password';
    // Write an input with a stale barcode, bypassing the Save hook that refreshes it.
    const base = serializeDocument(objects, new Map([['Root', root]]), { encrypt: { userPassword: password } });
    const doc = Document.Open(base, { password });
    expect(doc.Form.Get('barcode')!.Value).toBe('old');

    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.Form.Get('barcode')!.Value).toBe('old');
    expect(doc.Signatures).toHaveLength(0);
  });
});

describe('saving sealed signed bytes', () => {
  it('refuses encryption added after signing and retains the signed bytes', async () => {
    const doc = Document.New(PageFormat.A4);
    await doc.Sign(buildSigner({ type: 'ec' }));
    const before = doc.Save().slice();
    const options = { encrypt: { userPassword: 'fixture password' } };
    expect(() => doc.Save(options)).toThrow(UnsupportedFeatureError);
    await expect(doc.SaveAsync(options)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses removing or replacing encryption on sealed protected bytes', async () => {
    const password = 'fixture password';
    const base = Document.New(PageFormat.A4).Save({ encrypt: { userPassword: password } });
    const doc = Document.Open(base, { password });
    await doc.Sign(buildSigner({ type: 'ec' }));
    const before = doc.Save().slice();
    expect(() => doc.Save({ encrypt: false })).toThrow(UnsupportedFeatureError);
    expect(() => doc.Save({ encrypt: { userPassword: 'different password' } })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
    expect(() => Document.Open(before)).toThrow(InvalidPasswordError);
    expect(await Document.Open(before, { password }).VerifySignatures()).toMatchObject([{
      signature: 'valid', integrity: 'valid',
    }]);
  });
});

describe('signature authoring follow-ups on an encrypted document', () => {
  async function signProtected(mode: 'aes128' | 'aes256' | 'rsa' | 'ec') {
    const draft = Document.New(PageFormat.A4);
    draft.Lang = 'en-US';
    let encrypted: Uint8Array;
    let options: OpenOptions;
    if (mode === 'aes128' || mode === 'aes256') {
      const password = 'fixture password';
      options = { password };
      encrypted = draft.Save({ encrypt: { algorithm: mode, userPassword: password } });
    } else {
      const { certificate, privateKey } = buildSigner({ type: mode });
      options = { recipient: { certificate, privateKey } };
      encrypted = draft.Save({ encrypt: { recipients: [{ certificate }] } });
    }
    const doc = Document.Open(encrypted, options);
    const signer = buildSigner({ type: 'ec' });
    await doc.Sign(signer, { fieldName: 'Approval' });
    return { doc, signer, signed: doc.Save(), options };
  }

  it.each([
    ['aes128', false], ['aes256', true], ['rsa', false], ['ec', true],
  ] as const)('appends encrypted DSS data with %s protection (reopened: %s)', async (mode, reopen) => {
    const { doc, signer, signed, options } = await signProtected(mode);
    const target = reopen ? Document.Open(signed, options) : doc;
    const prefix = signed.slice();
    const cert = signer.certificate;
    const ocsp = buildOcspResponse({ responder: signer, cert, issuer: cert, status: 'good' });
    const crl = buildCrl({ issuer: signer, revokedSerials: [] });
    await target.AddValidationData({ getOCSP: async () => ocsp, getCRL: () => crl });
    const bytes = target.Save();
    expect(bytes.length).toBeGreaterThan(prefix.length);
    expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
    const appended = Buffer.from(bytes.subarray(prefix.length));
    for (const blob of [cert, ocsp, crl]) expect(appended.includes(Buffer.from(blob))).toBe(false);
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);

    const reopened = Document.Open(bytes, options);
    expect(readDssCerts(reopened)).toEqual([cert]);
    expect(readDssMaterial(reopened).get('Approval')).toEqual({ ocsp, crl });
    expect(await reopened.VerifySignatures()).toMatchObject([{
      name: 'Approval', integrity: 'valid', signature: 'valid', revocation: 'good',
      coversWholeFile: false, structureFindings: [],
    }]);
  });

  it('preserves catalog strings through repeated encrypted DSS appends', async () => {
    const { doc, signer, signed, options } = await signProtected('aes128');
    await doc.AddValidationData();
    const first = doc.Save();
    expect(first.subarray(0, signed.length)).toEqual(signed);
    expect(doc.Lang).toBe('en-US');

    const crl = buildCrl({ issuer: signer, revokedSerials: [] });
    await doc.AddValidationData({ getCRL: () => crl });
    const second = doc.Save();
    expect(second.subarray(0, first.length)).toEqual(first);
    const reopened = Document.Open(second, options);
    expect(reopened.Lang).toBe('en-US');
    expect(readDssMaterial(reopened).get('Approval')?.crl).toEqual(crl);
  });

  it.each(['aes128', 'rsa'] as const)('refuses certification after signing with %s protection', async (mode) => {
    const { doc, signer, signed, options } = await signProtected(mode);
    const prefix = signed.slice();
    for (const target of [doc, Document.Open(signed, options)]) {
      const certify = target.Certify(signer);
      await expect(certify).rejects.toBeInstanceOf(UnsupportedFeatureError);
      await expect(certify).rejects.toThrow('certification must be the first signature');
    }
    expect(doc.Save()).toEqual(prefix);
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
