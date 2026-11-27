import { constants, createPrivateKey, privateDecrypt, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Document, InvalidPasswordError, LoadLimits, UnsupportedFeatureError, type OpenOptions } from '../src/index.js';
import { buildSigner } from './helpers/build-signer.js';
import { buildTimeStampToken } from '../src/rfc3161.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/pubsec-go/${name}`, import.meta.url));
const certificate = fixture('recipient-cert.pem').toString('ascii');
const privateKey = createPrivateKey(fixture('recipient-key.pem'));
const unwrap = (key: Uint8Array) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, key);
const transport = (unwrapKey: (key: Uint8Array, algorithm: string) => Promise<Uint8Array> = async (key) => unwrap(key)) =>
  ({ algorithm: 'rsa-pkcs1-v1_5' as const, unwrapKey });

describe('asynchronous PubSec key transport', () => {
  it.each(['aes128', 'aes256'])('awaits a matched provider for the Go %s fixture', async (profile) => {
    const input = fixture(`${profile}.pdf`);
    const unwrapKey = vi.fn(async (key: Uint8Array, algorithm: string) => {
      expect(algorithm).toBe('rsa-pkcs1-v1_5');
      await Promise.resolve();
      const cek = unwrap(key);
      key.fill(0);
      input.fill(0);
      return cek;
    });
    const doc = await Document.OpenAsync(input, { recipient: { certificate, keyTransportAsync: transport(unwrapKey) } });
    expect(doc.Pages[0].GetText()).toContain('Go PubSec');
    expect(unwrapKey).toHaveBeenCalledTimes(1);
  });

  it('keeps synchronous open available and refuses the async credential before invocation', async () => {
    const pdf = fixture('aes128.pdf');
    const unwrapKey = vi.fn(async (key: Uint8Array) => unwrap(key));
    const recipient = { certificate, keyTransportAsync: transport(unwrapKey) };
    expect(() => Document.Open(pdf, { recipient } as unknown as OpenOptions)).toThrow(UnsupportedFeatureError);
    expect(unwrapKey).not.toHaveBeenCalled();
    const local = await Document.OpenAsync(pdf, { recipient: { certificate, privateKey } });
    expect(local.Pages[0].GetText()).toContain('Go PubSec fixture text');
  });

  it('skips unaddressed credentials and reports failed and unusable unwraps uniformly', async () => {
    const pdf = fixture('aes128.pdf');
    const unwrapKey = vi.fn(async () => { throw new Error('provider details'); });
    const keyTransportAsync = transport(unwrapKey);
    const other = fixture('other-serial-cert.pem').toString('ascii');
    await expect(Document.OpenAsync(pdf, { recipient: { certificate: other, keyTransportAsync } }))
      .rejects.toBeInstanceOf(InvalidPasswordError);
    expect(unwrapKey).not.toHaveBeenCalled();
    await expect(Document.OpenAsync(pdf, { recipient: { certificate, keyTransportAsync } }))
      .rejects.toMatchObject({ name: 'InvalidPasswordError', message: 'PubSec: recipient key transport failed' });
    expect(unwrapKey).toHaveBeenCalledTimes(1);
    await expect(Document.OpenAsync(pdf, { recipient: { certificate, keyTransportAsync: transport(async () => new Uint8Array(15)) } }))
      .rejects.toMatchObject({ name: 'InvalidPasswordError', message: 'PubSec: recipient key transport failed' });
  });

  it('uses the retained provider for the encrypted incremental baseline', async () => {
    const pdf = fixture('aes256.pdf');
    const supplied = new X509Certificate(certificate).raw;
    const unwrapKey = vi.fn(async (key: Uint8Array) => unwrap(key));
    const keyTransportAsync = transport(unwrapKey);
    const doc = await Document.OpenAsync(pdf, { recipient: { certificate: supplied, keyTransportAsync } });
    supplied.fill(0);
    keyTransportAsync.unwrapKey = async () => { throw new Error('replacement provider'); };
    doc.SetMetadata({ title: 'Encrypted async append' });
    expect(() => doc.Save({ incremental: true })).toThrow(/SaveAsync/);
    expect(unwrapKey).toHaveBeenCalledTimes(1);

    const saved = await doc.SaveAsync({ incremental: true });
    expect(unwrapKey).toHaveBeenCalledTimes(2);
    expect(saved.subarray(0, pdf.length)).toEqual(Uint8Array.from(pdf));
    expect(Buffer.from(saved).includes('Encrypted async append')).toBe(false);
    expect(Document.Open(saved, { recipient: { certificate, privateKey } }).GetMetadata().title).toBe('Encrypted async append');
  });

  it('awaits authentication of the current and historical signed revisions', async () => {
    const pdf = fixture('aes128.pdf');
    const signer = buildSigner({ type: 'ec' });
    const local = Document.Open(pdf, { recipient: { certificate, privateKey } });
    await local.Certify(signer, { permissions: 'no-changes' });
    const signed = local.Save();
    const edited = Document.Open(signed, { recipient: { certificate, privateKey } });
    edited.Pages[0].AddSquare({ rect: [15, 95, 300, 145], fill: [0, 0, 1], width: 0 });
    const appended = edited.Save({ incremental: true });

    const unwrapKey = vi.fn(async (key: Uint8Array) => unwrap(key));
    const doc = await Document.OpenAsync(appended, { recipient: { certificate, keyTransportAsync: transport(unwrapKey) } });
    expect(() => doc.Save()).toThrow(/SaveAsync/);
    await expect(doc.SaveAsync({ encrypt: false })).rejects.toThrow(/incremental: false/);
    const saved = await doc.SaveAsync();
    expect(Buffer.from(saved).equals(appended)).toBe(true);
    const plain = await doc.SaveAsync({ encrypt: false, incremental: false });
    expect(Document.Open(plain).trailer.has('Encrypt')).toBe(false);
    unwrapKey.mockClear();
    const valid = { integrity: 'valid', signature: 'valid', coversWholeFile: false };
    expect(await doc.VerifySignatures({ shadowAnalysis: true })).toMatchObject([{
      ...valid, docMDP: 'violated', structureFindings: [], shadowAnalysis: { skippedPages: [] },
    }]);
    expect(unwrapKey.mock.calls.length).toBeGreaterThan(1);

    unwrapKey.mockReset().mockImplementationOnce(async (key) => unwrap(key)).mockRejectedValue(new Error('provider unavailable'));
    const [report] = await doc.VerifySignatures({ shadowAnalysis: true });
    expect(report).toMatchObject({ ...valid, docMDP: 'n/a' });
    expect(report.shadowAnalysis).toBeUndefined();
    expect(report.structureFindings).toContainEqual({ kind: 'signed-revision-unverified' });
  });

  it('checks the original file limit before reauthenticating pending signed bytes', async () => {
    const pdf = fixture('aes128.pdf');
    const unwrapKey = vi.fn(async (key: Uint8Array) => unwrap(key));
    const recipient = { certificate, keyTransportAsync: transport(unwrapKey) };
    await expect(Document.OpenAsync(pdf, { recipient, limits: LoadLimits.defaults.with({ maxFileBytes: pdf.length - 1 }) }))
      .rejects.toMatchObject({ name: 'ResourceLimitError', limit: 'maxFileBytes' });
    expect(unwrapKey).not.toHaveBeenCalled();
    const doc = await Document.OpenAsync(pdf, { recipient, limits: LoadLimits.defaults.with({ maxFileBytes: pdf.length }) });
    await doc.Sign(buildSigner({ type: 'ec' }));
    expect(unwrapKey).toHaveBeenCalledTimes(2);
    await expect(doc.VerifySignatures()).rejects.toMatchObject({ name: 'ResourceLimitError', limit: 'maxFileBytes' });
    expect(unwrapKey).toHaveBeenCalledTimes(2);
  });

  it('authenticates the base for DSS and timestamp appends and verifies the timestamp', async () => {
    const pdf = fixture('aes256.pdf');
    const unwrapKey = vi.fn(async (key: Uint8Array) => unwrap(key));
    const recipient = { certificate, keyTransportAsync: transport(unwrapKey) };
    const doc = await Document.OpenAsync(pdf, { recipient });
    const signer = buildSigner({ type: 'ec' });
    await doc.Sign(signer);
    const signed = doc.Save();
    await doc.AddValidationData();
    const withDss = doc.Save();
    await doc.AddDocumentTimestamp((request) => buildTimeStampToken(request, signer));
    const timestamped = doc.Save();

    expect(unwrapKey).toHaveBeenCalledTimes(4);
    expect(withDss.subarray(0, signed.length)).toEqual(signed);
    expect(timestamped.subarray(0, withDss.length)).toEqual(withDss);
    expect(await doc.VerifyDocumentTimestamps()).toMatchObject([{ timestamp: { valid: true } }]);
    expect(await doc.VerifySignatures()).toMatchObject([{ signature: 'valid', integrity: 'valid', padesLevel: 'B-LTA' }]);
  });

  it('refuses signing when the provider changes the live document during baseline authentication', async () => {
    let changeDocument: (() => void) | undefined;
    const recipient = { certificate, keyTransportAsync: transport(async (key) => {
      await Promise.resolve();
      changeDocument?.();
      return unwrap(key);
    }) };
    const doc = await Document.OpenAsync(fixture('aes128.pdf'), { recipient });
    changeDocument = () => doc.SetMetadata({ title: 'Edit during authentication' });
    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toThrow(/changed during authentication/);
    expect(doc.Signatures).toHaveLength(0);
    expect(doc.GetMetadata().title).toBe('Edit during authentication');
  });
});
