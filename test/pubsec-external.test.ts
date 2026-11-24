import { describe, expect, it } from 'vitest';
import { constants, createPrivateKey, privateDecrypt, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Document, InvalidPasswordError, LoadLimits, PageFormat, PdfParseError, UnsupportedFeatureError,
  type PubSecKeyTransport,
} from '../src/index.js';
import { der, parse } from '../src/asn1.js';
import { buildEnvelopedData, openEnvelopedData } from '../src/cms.js';
import { buildSigner } from './helpers/build-signer.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubsec-go/${name}`, import.meta.url));
const pdf = fixture('aes128.pdf');
const pdf256 = fixture('aes256.pdf');
const certificate = fixture('recipient-cert.pem').toString('ascii');
const privateKey = createPrivateKey(fixture('recipient-key.pem'));
const algorithm = 'rsa-pkcs1-v1_5';
const unwrap = (key: Uint8Array) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, key);
const provider = (unwrapKey: PubSecKeyTransport['unwrapKey'] = unwrap): PubSecKeyTransport =>
  ({ algorithm, unwrapKey });

// Replace a same-length DER fragment in the last /Recipients envelope, leaving
// the PDF offsets and the first (unrelated) envelope intact.
function withEnvelopeChange(before: string, after: string, source = pdf): Uint8Array {
  const bytes = source.toString('latin1');
  // Go emits a literal PDF string and escapes the CR in the RSA OID.
  const escapedDer = (hex: string) => Buffer.from(hex, 'hex').toString('latin1').replaceAll('\r', '\\r');
  const from = escapedDer(before);
  const to = escapedDer(after);
  const at = bytes.lastIndexOf(from);
  expect(at).toBeGreaterThan(0);
  expect(to).toHaveLength(from.length);
  return Buffer.from(bytes.slice(0, at) + to + bytes.slice(at + from.length), 'latin1');
}

describe('Go-produced AES-256 PubSec', () => {
  it.each([
    ['a local private key', { privateKey }],
    ['an external key provider', { keyTransport: provider() }],
  ] as const)('opens with %s and recovers the addressed recipient permissions', (_, credential) => {
    const doc = Document.Open(pdf256, { recipient: { certificate, ...credential } });
    expect(doc.Pages[0].GetText()).toContain('Go PubSec AES-256 fixture text');
    expect(doc.Permissions).toMatchObject({ printing: true, copying: false });
  });

  it('refuses an unknown CMS cipher even with a local private key', () => {
    const altered = withEnvelopeChange('060960864801650304012a0410', '06096086480165030401160410', pdf256);
    expect(() => Document.Open(altered, { recipient: { certificate, privateKey } }))
      .toThrow(UnsupportedFeatureError);
  });

  it('rejects a local key whose unwrapped size disagrees with the CMS cipher', () => {
    const altered = withEnvelopeChange('060960864801650304012a0410', '06096086480165030401020410', pdf256);
    expect(() => Document.Open(altered, { recipient: { certificate, privateKey } }))
      .toThrow(InvalidPasswordError);
  });

  it('requires a 32-byte key from the provider for AES-256-CBC', () => {
    const keyTransport = provider((key) => unwrap(key).subarray(0, 16));
    expect(() => Document.Open(pdf256, { recipient: { certificate, keyTransport } }))
      .toThrow(InvalidPasswordError);
  });
});

describe('external PubSec RSA key transport', () => {
  it('opens a Go-produced AES-128 PDF and keeps recipient bytes intact if the provider mutates its input', () => {
    const wrappedKeys: Uint8Array[] = [];
    const keyTransport = provider((wrappedKey, requestedAlgorithm) => {
      expect(requestedAlgorithm).toBe(algorithm);
      wrappedKeys.push(wrappedKey);
      const cek = unwrap(wrappedKey);
      wrappedKey.fill(0);
      return cek;
    });
    const doc = Document.Open(pdf, { recipient: { certificate, keyTransport } });
    expect(doc.Pages[0].GetText()).toContain('Go PubSec fixture text');
    expect(wrappedKeys).toHaveLength(1);
    expect(Document.Open(pdf, { recipient: { certificate, privateKey } }).Pages[0].GetText())
      .toContain('Go PubSec fixture text');
  });

  it.each([
    ['same serial with a different issuer', () => buildSigner({ commonName: 'Unrelated issuer', serial: 11n }).certificate],
    ['same issuer with a different serial', () => fixture('other-serial-cert.pem')],
  ] as const)('skips the provider for %s', (_, otherCertificate) => {
    let calls = 0;
    const keyTransport = provider((key) => { calls++; return unwrap(key); });
    expect(() => Document.Open(pdf, { recipient: { certificate: otherCertificate(), keyTransport } }))
      .toThrow(InvalidPasswordError);
    expect(calls).toBe(0);
  });

  it('rejects a provider without explicit PKCS#1 v1.5 capability', () => {
    const keyTransport = { unwrapKey: unwrap } as unknown as PubSecKeyTransport;
    expect(() => Document.Open(pdf, { recipient: { certificate, keyTransport } }))
      .toThrow(UnsupportedFeatureError);
  });

  it.each([
    ['unknown key transport OID', '06092a864886f70d0101010500', '06092a864886f70d01017f0500'],
    ['OAEP OID', '06092a864886f70d0101010500', '06092a864886f70d0101070500'],
    ['invalid RSA parameters', '06092a864886f70d0101010500', '06092a864886f70d0101010400'],
    ['unsupported CMS cipher', '06096086480165030401020410', '06096086480165030401160410'],
    ['invalid CMS IV type', '06096086480165030401020410', '06096086480165030401020310'],
  ])('rejects %s before invoking the provider', (_, before, after) => {
    let calls = 0;
    const keyTransport = provider((key) => { calls++; return unwrap(key); });
    const altered = withEnvelopeChange(before, after);
    expect(() => Document.Open(altered, { recipient: { certificate, keyTransport } }))
      .toThrow(UnsupportedFeatureError);
    expect(calls).toBe(0);
  });

  it('preserves local RSA OAEP support while refusing that envelope with an external provider', () => {
    const bytes = Document.New(PageFormat.A4).Save({
      encrypt: { recipients: [{ certificate }], keyWrap: 'oaep' },
    });
    expect(Document.Open(bytes, { recipient: { certificate, privateKey } }).Pages).toHaveLength(1);
    expect(() => Document.Open(bytes, { recipient: { certificate, keyTransport: provider() } }))
      .toThrow(UnsupportedFeatureError);
  });

  it.each([
    ['wrapped RSA key', 255, 32, 16, PdfParseError],
    ['encrypted CMS payload', 256, 16, 16, PdfParseError],
    ['CMS IV', 256, 32, 15, UnsupportedFeatureError],
  ] as const)('refuses a short %s without calling the provider', (_, wrappedLength, encryptedLength, ivLength, error) => {
    const certDer = new X509Certificate(certificate).raw;
    const [contentType, inner] = parse(buildEnvelopedData([certDer], new Uint8Array(24))).children;
    const [version, recipients, eci] = inner.children[0].children;
    const [keyVersion, rid, alg, wrapped] = recipients.children[0].children;
    const [dataType, cipher, encrypted] = eci.children;
    const shortRecipient = der.sequence(
      keyVersion.raw, rid.raw, alg.raw, der.octetString(wrapped.content.subarray(0, wrappedLength)),
    );
    const encryptedPayload = der.octetString(encrypted.content.subarray(0, encryptedLength));
    encryptedPayload[0] = 0x80;
    const [cipherOid, iv] = cipher.children;
    const cipherWithIv = der.sequence(cipherOid.raw, der.octetString(iv.content.subarray(0, ivLength)));
    const envelope = der.sequence(contentType.raw, der.explicit(0, der.sequence(
      version.raw, der.set(shortRecipient), der.sequence(dataType.raw, cipherWithIv, encryptedPayload),
    )));
    let calls = 0;
    const keyTransport = provider((key) => { calls++; return unwrap(key); });
    expect(() => openEnvelopedData(envelope, keyTransport, certDer)).toThrow(error);
    expect(calls).toBe(0);
  });

  it.each([
    ['short key', () => new Uint8Array(15)],
    ['long key', () => new Uint8Array(17)],
    ['wrong 16-byte key', () => new Uint8Array(16)],
    ['non-byte result', () => new Array(16).fill(0) as unknown as Uint8Array],
    ['provider failure', () => { throw new Error('provider details'); }],
  ] as const)('reports a credential failure for a %s', (_, unwrapKey) => {
    expect(() => Document.Open(pdf, { recipient: { certificate, keyTransport: provider(unwrapKey) } }))
      .toThrow(InvalidPasswordError);
  });

  it('refuses a rejected Promise from a misconfigured provider without an unhandled rejection', () => {
    const unwrapKey = (() => Promise.reject(new Error('asynchronous provider failure'))) as unknown as
      PubSecKeyTransport['unwrapKey'];
    expect(() => Document.Open(pdf, { recipient: { certificate, keyTransport: provider(unwrapKey) } }))
      .toThrow(InvalidPasswordError);
  });

  it('stops after the first addressed envelope when the provider fails', () => {
    const bytes = Document.New(PageFormat.A4).Save({
      encrypt: {
        recipients: [{ certificate, permissions: { copying: false } },
          { certificate, permissions: { copying: true } }],
      },
    });
    let calls = 0;
    const keyTransport = provider((key) => {
      if (++calls === 1) throw new Error('provider unavailable');
      return unwrap(key);
    });
    expect(() => Document.Open(bytes, { recipient: { certificate, keyTransport } }))
      .toThrow(InvalidPasswordError);
    expect(calls).toBe(1);
  });

  it('retains the provider and certificate for encrypted incremental saves', () => {
    const supplied = new X509Certificate(certificate).raw;
    const options = { recipient: { certificate: supplied, keyTransport: provider() } };
    const doc = Document.Open(pdf, options);
    supplied.fill(0);
    options.recipient.keyTransport.unwrapKey = () => { throw new Error('replacement provider'); };
    doc.SetMetadata({ title: 'Incremental recipient title' });
    const saved = doc.Save({ incremental: true });
    expect(saved.subarray(0, pdf.length)).toEqual(Uint8Array.from(pdf));
    expect(Buffer.from(saved).includes('Incremental recipient title')).toBe(false);
    expect(Document.Open(saved, { recipient: { certificate, keyTransport: provider() } }).GetMetadata().title)
      .toBe('Incremental recipient title');
  });

  it('verifies a signed revision and compares its appearance after an encrypted append', async () => {
    const options = { recipient: { certificate, keyTransport: provider() } };
    const doc = Document.Open(pdf, options);
    await doc.Certify(buildSigner({ type: 'ec' }), { fieldName: 'Approval', permissions: 'no-changes' });
    const signed = doc.Save();
    const edit = Document.Open(signed, options);
    edit.Pages[0].AddSquare({ rect: [15, 95, 300, 145], fill: [0, 0, 1], width: 0 });
    const appended = edit.Save({ incremental: true });
    expect(appended.subarray(0, signed.length)).toEqual(signed);

    let calls = 0;
    let failHistoricalOpen = false;
    const keyTransport = provider((key) => {
      calls++;
      if (failHistoricalOpen && calls > 1) throw new Error('provider unavailable during history check');
      return unwrap(key);
    });
    const reopened = Document.Open(appended, { recipient: { certificate, keyTransport } });
    const valid = { name: 'Approval', integrity: 'valid', signature: 'valid', coversWholeFile: false };
    expect(await reopened.VerifySignatures({ shadowAnalysis: true })).toMatchObject([{
      ...valid, docMDP: 'violated', structureFindings: [], shadowAnalysis: { skippedPages: [] },
    }]);
    calls = 0;
    failHistoricalOpen = true;
    const [report] = await reopened.VerifySignatures({ shadowAnalysis: true });
    expect(calls).toBeGreaterThan(1);
    expect(report).toMatchObject(valid);
    expect(report.shadowAnalysis).toBeUndefined();
  });

  it('keeps the original load limits for verification of pending signed bytes', async () => {
    const doc = Document.Open(pdf, {
      recipient: { certificate, keyTransport: provider() },
      limits: LoadLimits.defaults.with({ maxFileBytes: pdf.length }),
    });
    await doc.Sign(buildSigner({ type: 'ec' }));
    await expect(doc.VerifySignatures()).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxFileBytes',
    });
  });
});
