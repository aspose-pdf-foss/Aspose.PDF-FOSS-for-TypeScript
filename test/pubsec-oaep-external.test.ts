import { constants, createPrivateKey, privateDecrypt, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  Document, InvalidPasswordError, PageFormat, UnsupportedFeatureError,
  type PubSecOaepKeyTransport, type AsyncPubSecOaepKeyTransport,
} from '../src/index.js';
import { der, OID, parse } from '../src/asn1.js';
import { openEnvelopedData, openEnvelopedDataAsync } from '../src/cms.js';

const readFixture = (path: string) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
const certificate = new X509Certificate(readFixture('pubsec-go/recipient-cert.pem'));
const privateKey = createPrivateKey(readFixture('pubsec-go/recipient-key.pem'));
const sha256Envelope = readFixture('pubsec-oaep/sha256.der');
const payload = Uint8Array.from({ length: 24 }, (_, index) => index + 1);

const unwrap: PubSecOaepKeyTransport['unwrapKey'] = (wrappedKey, _algorithm, { hash, label }) =>
  privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash, oaepLabel: label }, wrappedKey);
const transport = (unwrapKey: PubSecOaepKeyTransport['unwrapKey'] = unwrap): PubSecOaepKeyTransport =>
  ({ algorithm: 'rsa-oaep', unwrapKey });
const asyncTransport = (unwrapKey: AsyncPubSecOaepKeyTransport['unwrapKey']): AsyncPubSecOaepKeyTransport =>
  ({ algorithm: 'rsa-oaep', unwrapKey });

const hashId = (oid: string) => der.sequence(der.oid(oid), der.null_());
const sha1 = hashId('1.3.14.3.2.26');
const sha256 = hashId(OID.sha256);
const hashField = (id: Uint8Array) => der.explicit(0, id);
const maskField = (id: Uint8Array, oid: string = OID.mgf1) => der.explicit(1, der.sequence(der.oid(oid), id));
const labelField = (label: Uint8Array, oid: string = OID.pSpecified) =>
  der.explicit(2, der.sequence(der.oid(oid), der.octetString(label)));
const empty = new Uint8Array();

function withKeyAlgorithm(...params: Uint8Array[]): Uint8Array {
  const [contentType, inner] = parse(sha256Envelope).children;
  const [version, recipients, content] = inner.children[0].children;
  const [keyVersion, rid, , wrapped] = recipients.children[0].children;
  const alg = der.sequence(der.oid(OID.rsaesOaep), ...params);
  const recipient = der.sequence(keyVersion.raw, rid.raw, alg, wrapped.raw);
  return der.sequence(contentType.raw, der.explicit(0, der.sequence(version.raw, der.set(recipient), content.raw)));
}

describe('external PubSec RSAES-OAEP key transport', () => {
  it.each(['sha1', 'sha256'] as const)('opens an OpenSSL envelope with %s OAEP parameters', (hash) => {
    const envelope = readFixture(`pubsec-oaep/${hash}.der`);
    const unwrapKey = vi.fn<PubSecOaepKeyTransport['unwrapKey']>((key, algorithm, parameters) => {
      const cek = unwrap(key, algorithm, parameters);
      key.fill(0);
      return cek;
    });
    const copy = Uint8Array.from(envelope);
    expect(openEnvelopedData(envelope, transport(unwrapKey), certificate.raw)).toEqual(payload);
    expect(unwrapKey.mock.calls).toEqual([[expect.any(Uint8Array), 'rsa-oaep', {
      hash, mgf1Hash: hash, label: empty,
    }]]);
    expect(Uint8Array.from(envelope)).toEqual(copy);
  });

  it('accepts an explicit empty pSpecified label with an async provider', async () => {
    const envelope = withKeyAlgorithm(der.sequence(hashField(sha256), maskField(sha256), labelField(empty)));
    const unwrapKey = vi.fn<AsyncPubSecOaepKeyTransport['unwrapKey']>(async (...args) => unwrap(...args));
    expect(await openEnvelopedDataAsync(envelope, asyncTransport(unwrapKey), certificate.raw)).toEqual(payload);
    expect(unwrapKey.mock.calls).toEqual([[expect.any(Uint8Array), 'rsa-oaep', {
      hash: 'sha256', mgf1Hash: 'sha256', label: empty,
    }]]);
  });

  it.each([
    ['absent OAEP parameters', []],
    ['NULL OAEP parameters', [der.null_()]],
    ['unsupported hash', [der.sequence(hashField(hashId(OID.sha384)), maskField(hashId(OID.sha384)))]],
    ['invalid hash parameters', [der.sequence(hashField(der.sequence(der.oid(OID.sha256), der.octetString(empty))), maskField(sha256))]],
    ['default MGF1 with an explicit SHA-256 hash', [der.sequence(hashField(sha256))]],
    ['different OAEP and MGF1 hashes', [der.sequence(hashField(sha256), maskField(sha1))]],
    ['unknown mask algorithm', [der.sequence(hashField(sha256), maskField(sha256, OID.rsaEncryption))]],
    ['nonempty label', [der.sequence(hashField(sha256), maskField(sha256), labelField(Uint8Array.of(1)))]],
    ['unknown label source', [der.sequence(hashField(sha256), maskField(sha256), labelField(empty, OID.rsaEncryption))]],
    ['duplicate fields', [der.sequence(hashField(sha256), hashField(sha256), maskField(sha256))]],
    ['out-of-order fields', [der.sequence(maskField(sha256), hashField(sha256))]],
    ['unknown field', [der.sequence(hashField(sha256), maskField(sha256), der.explicit(3, der.null_()))]],
  ] as const)('refuses %s before calling either provider', async (_, params) => {
    const envelope = withKeyAlgorithm(...params);
    const unwrapSync = vi.fn(unwrap);
    const unwrapAsync = vi.fn(async (...args: Parameters<typeof unwrap>) => unwrap(...args));
    expect(() => openEnvelopedData(envelope, transport(unwrapSync), certificate.raw)).toThrow(UnsupportedFeatureError);
    await expect(openEnvelopedDataAsync(envelope, asyncTransport(unwrapAsync), certificate.raw)).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(unwrapSync).not.toHaveBeenCalled();
    expect(unwrapAsync).not.toHaveBeenCalled();
  });

  it('requires the provider capability to match the addressed transport', () => {
    const unwrapKey = vi.fn(unwrap);
    const other = readFixture('pubsec-go/other-serial-cert.pem');
    expect(openEnvelopedData(sha256Envelope, transport(unwrapKey), new X509Certificate(other).raw)).toBeUndefined();
    const bytes = Document.New(PageFormat.A4).Save({ encrypt: { recipients: [{ certificate: certificate.raw }] } });
    expect(() => Document.Open(bytes, { recipient: { certificate: certificate.raw, keyTransport: transport(unwrapKey) } }))
      .toThrow(UnsupportedFeatureError);
    expect(unwrapKey).not.toHaveBeenCalled();
  });

  it('reauthenticates an async incremental save with the validated OAEP parameters', async () => {
    const initial = Document.New(PageFormat.A4);
    initial.SetMetadata({ title: 'OAEP protected title' });
    const bytes = initial.Save({ encrypt: { recipients: [{ certificate: certificate.raw }], keyWrap: 'oaep' } });
    const local = Document.Open(bytes, { recipient: { certificate: certificate.raw, keyTransport: transport() } });
    expect(local.GetMetadata().title).toBe('OAEP protected title');

    const unwrapKey = vi.fn(async (...args: Parameters<typeof unwrap>) => unwrap(...args));
    const recipient = { certificate: certificate.raw, keyTransportAsync: asyncTransport(unwrapKey) };
    const doc = await Document.OpenAsync(bytes, { recipient });
    doc.SetMetadata({ title: 'OAEP appended title' });
    const saved = await doc.SaveAsync({ incremental: true });
    expect(saved.subarray(0, bytes.length)).toEqual(bytes);
    expect(Buffer.from(saved).includes('OAEP appended title')).toBe(false);
    expect(unwrapKey).toHaveBeenCalledTimes(2);
    expect((await Document.OpenAsync(saved, { recipient })).GetMetadata().title).toBe('OAEP appended title');
  });

  it('reports an invalid returned content key as a credential failure', () => {
    expect(() => openEnvelopedData(sha256Envelope, transport(() => new Uint8Array(15)), certificate.raw))
      .toThrow(InvalidPasswordError);
  });
});
