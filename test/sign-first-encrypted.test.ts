import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Document, InvalidPasswordError, PageFormat, UnsupportedFeatureError, type SignOptions,
} from '../src/index.js';
import { buildSigner } from './helpers/build-signer.js';
import { isDict } from '../src/types.js';

const userPassword = 'fixture first-write user';
const ownerPassword = 'fixture first-write owner';
const encrypt = { userPassword, ownerPassword, permissions: { copying: false } };
const signingOptions = { encrypt, fieldName: 'Approval' };
const rect = [20, 20, 185, 75] as const;
const signatureVerdict = { name: 'Approval', signature: 'valid', integrity: 'valid', structureFindings: [] };
const fontBytes = readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url));

function authored(): Document {
  const doc = Document.New(PageFormat.A4);
  doc.SetMetadata({ title: 'Confidential draft title' });
  doc.Pages[0].AddText('Confidential draft body', 50, 700, { font: doc.AddFont(fontBytes) });
  doc.Form.AddSignatureField({ name: 'Approval', page: 1, rect: [...rect] });
  return doc;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pauseSigning(doc: Document, opts: SignOptions) {
  const signer = buildSigner({ type: 'ec' });
  const reachedProvider = deferred();
  const releaseProvider = deferred();
  const signing = doc.Sign({
    certificates: [Buffer.from(signer.certificate)],
    async sign(data) {
      reachedProvider.resolve();
      await releaseProvider.promise;
      return cryptoSign('sha256', data, signer.privateKey);
    },
  }, opts);
  return { signer, signing, reachedProvider, releaseProvider };
}

describe('first-write encrypted signing', () => {
  it.each([
    ['Sign', undefined], ['Certify', 'aes128'], ['Sign', 'rc4'],
  ] as const)('%s writes an encrypted base and signature revision with %s', async (method, algorithm) => {
    const doc = authored();
    const id = [
      { kind: 'string' as const, bytes: Uint8Array.of(0x11, 0x22) },
      { kind: 'string' as const, bytes: Uint8Array.of(0x33, 0x44) },
    ];
    doc.trailer.set('ID', id);
    await doc[method](buildSigner({ type: 'ec' }), {
      ...signingOptions, encrypt: { ...encrypt, algorithm }, name: 'Confidential signer name',
      appearance: { page: 0, rect: [...rect], text: 'Private signature appearance' },
    });

    expect(doc.Signatures).toMatchObject([{ name: 'Approval', isSigned: true }]);
    expect(await doc.VerifySignatures()).toMatchObject([{ ...signatureVerdict, coversWholeFile: true }]);
    const bytes = doc.Save();
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);
    expect(() => Document.Open(bytes, { password: 'incorrect' })).toThrow(InvalidPasswordError);
    const reopened = Document.Open(bytes, { password: userPassword });
    expect(Document.Open(bytes, { password: ownerPassword }).GetMetadata().title)
      .toBe('Confidential draft title');
    expect(reopened.Permissions?.copying).toBe(false);
    expect(reopened.Revisions).toHaveLength(2);

    const [baseRevision] = reopened.Revisions;
    const base = Document.Open(bytes.subarray(0, baseRevision.length), { password: userPassword });
    expect(base.Revisions).toHaveLength(1);
    expect(base.Signatures).toMatchObject([{ name: 'Approval', isSigned: false }]);
    expect(base.Pages[0].GetText()).toContain('Confidential draft body');
    expect(base.ID).toEqual({ original: '1122', modified: '3344' });
    expect(reopened.ID).toEqual(base.ID);
    expect(reopened.trailer.get('Encrypt')).toEqual(base.trailer.get('Encrypt'));
    const encryption = reopened.resolve(reopened.trailer.get('Encrypt'));
    expect(isDict(encryption) && encryption.get('R')).toBe(algorithm === 'aes128' ? 4 : algorithm === 'rc4' ? 3 : 6);
    expect(reopened.Pages[0].Annotations).toHaveLength(1);
    const [start, left, right, tail] = reopened.Signatures[0].byteRange!;
    expect(start).toBe(0);
    expect(left).toBeGreaterThan(baseRevision.length);
    expect(right + tail).toBe(bytes.length);
    expect(bytes[left - 1]).toBe(0x3c); // '<' and '>' are covered.
    expect(bytes[right]).toBe(0x3e);
    expect(right - left).toBe(2 * 8192);
    expect(await reopened.VerifySignatures()).toMatchObject([{
      ...signatureVerdict, coversWholeFile: true, ...(method === 'Certify' ? { docMDP: 'ok' } : {}),
    }]);

    const text = Buffer.from(bytes).toString('latin1').toLowerCase();
    for (const secret of ['Confidential draft title', 'Confidential signer name', 'Private signature appearance']) {
      expect(text).not.toContain(secret.toLowerCase());
      expect(text).not.toContain(Buffer.from(secret).toString('hex'));
    }
  });

  it('preserves the signed prefix and encryption after save, reopen, and append', async () => {
    const doc = authored();
    await doc.Sign(buildSigner({ type: 'ec' }), signingOptions);
    const bytes = doc.Save();
    const reopened = Document.Open(bytes, { password: ownerPassword });
    reopened.SetMetadata({ title: 'Later encrypted edit' });
    const updated = reopened.Save({ incremental: true });
    expect(updated.subarray(0, bytes.length)).toEqual(bytes);
    expect(() => Document.Open(updated)).toThrow(InvalidPasswordError);
    const result = Document.Open(updated, { password: userPassword });
    expect(result.GetMetadata().title).toBe('Later encrypted edit');
    expect(await result.VerifySignatures()).toMatchObject([{ ...signatureVerdict, coversWholeFile: false }]);
  });

  it.each(['provider rejects', 'CMS exceeds reservation'] as const)('can retry when the %s', async (failure) => {
    const doc = authored();
    doc.Form.AddTextField({ name: 'Input', page: 1, rect: [20, 100, 200, 125], value: 'Barcode value' });
    doc.Form.AddBarcodeField({ name: 'Barcode', page: 1, rect: [20, 130, 280, 215] });
    const original = structuredClone({ objects: [...doc.objectEntries()], trailer: doc.trailer });
    const signer = buildSigner({ type: 'ec' });
    const refused = failure === 'provider rejects'
      ? doc.Sign({
        certificates: [Buffer.from(signer.certificate)],
        sign() { throw new Error('provider unavailable'); },
      }, signingOptions)
      : doc.Sign(signer, { ...signingOptions, placeholderBytes: 1 });
    await expect(refused).rejects.toThrow(failure === 'provider rejects' ? /provider unavailable/ : /signature too large/);
    expect([...doc.objectEntries()]).toEqual(original.objects);
    expect(doc.trailer).toEqual(original.trailer);
    expect(doc.Signatures).toMatchObject([{ name: 'Approval', isSigned: false }]);
    expect(await doc.VerifySignatures()).toEqual([]);
    expect(doc.Permissions).toBeUndefined();

    await doc.Sign(signer, signingOptions);
    const reopened = Document.Open(doc.Save(), { password: userPassword });
    expect(reopened.Form.Get('Barcode')?.Value).toBe('Barcode value');
    expect(await reopened.VerifySignatures()).toMatchObject([signatureVerdict]);
  });

  it.each(['tracked edit', 'direct dictionary edit'] as const)('refuses to commit after a %s during signing', async (change) => {
    const doc = authored();
    const { signer, signing, reachedProvider, releaseProvider } = pauseSigning(doc, signingOptions);
    await reachedProvider.promise;
    if (change === 'tracked edit') doc.Lang = 'en-GB';
    else doc.catalog().set('Lang', { kind: 'string', bytes: new TextEncoder().encode('en-GB') });
    releaseProvider.resolve();
    await expect(signing).rejects.toThrow(UnsupportedFeatureError);
    expect(doc.Signatures).toMatchObject([{ name: 'Approval', isSigned: false }]);
    expect(doc.Lang).toBe('en-GB');

    await doc.Sign(signer, signingOptions);
    expect(Document.Open(doc.Save(), { password: userPassword }).Lang).toBe('en-GB');
  });

  it('preserves a version-only PDF 2.0 migration made during signing', async () => {
    const doc = Document.New(PageFormat.A4);
    const { signer, signing, reachedProvider, releaseProvider } = pauseSigning(doc, {
      ...signingOptions, encrypt: { ...encrypt, algorithm: 'aes128' },
    });
    await reachedProvider.promise;
    doc.ConvertToPdf20();
    releaseProvider.resolve();
    await expect(signing).rejects.toThrow(UnsupportedFeatureError);
    expect(doc.Version).toBe('2.0');
    expect(doc.Signatures).toEqual([]);

    await doc.Sign(signer, signingOptions);
    expect(Document.Open(doc.Save(), { password: userPassword }).Version).toBe('2.0');
  });

  it('refuses a second encryption request on opened or already sealed bytes', async () => {
    const draft = authored();
    const signer = buildSigner({ type: 'ec' });
    const plain = Document.Open(draft.Save());
    await expect(plain.Sign(signer, signingOptions)).rejects.toThrow(UnsupportedFeatureError);
    await draft.Sign(signer, signingOptions);
    const signed = draft.Save().slice();
    await expect(draft.Sign(signer, signingOptions)).rejects.toThrow(UnsupportedFeatureError);
    expect(draft.Save()).toEqual(signed);
  });

  it('refuses certificate encryption in first-write signing', async () => {
    const doc = authored();
    const signer = buildSigner({ type: 'ec' });
    const options = { encrypt: { recipients: [{ certificate: signer.certificate }] } } as unknown as SignOptions;
    await expect(doc.Sign(signer, options)).rejects.toThrow(UnsupportedFeatureError);
    expect(doc.Signatures).toMatchObject([{ name: 'Approval', isSigned: false }]);
  });

  it('honors encryption options exposed through prototype getters', async () => {
    const doc = authored();
    const options = new class {
      get userPassword() { return userPassword; }
      get ownerPassword() { return ownerPassword; }
      get algorithm() { return 'aes128' as const; }
    }();
    await doc.Sign(buildSigner({ type: 'ec' }), { encrypt: options });
    const bytes = doc.Save();
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);
    const reopened = Document.Open(bytes, { password: userPassword });
    const encryption = reopened.resolve(reopened.trailer.get('Encrypt'));
    expect(isDict(encryption) && encryption.get('R')).toBe(4);
    expect(Document.Open(bytes, { password: ownerPassword }).GetMetadata().title).toBe('Confidential draft title');
  });

  it('leaves the authoring graph retryable when the encrypted base exceeds the load limit', async () => {
    const doc = authored();
    const limits = doc.loadLimits;
    doc.loadLimits = limits.with({ maxFileBytes: 50 });
    const signer = buildSigner({ type: 'ec' });
    await expect(doc.Sign(signer, signingOptions)).rejects.toMatchObject({ name: 'ResourceLimitError', limit: 'maxFileBytes' });
    expect(doc.Signatures).toMatchObject([{ name: 'Approval', isSigned: false }]);
    doc.loadLimits = limits;
    await doc.Sign(signer, signingOptions);
    expect(Document.Open(doc.Save(), { password: userPassword }).GetMetadata().title).toBe('Confidential draft title');
  });
});

const hasCli = (program: string, version: string) =>
  spawnSync(program, [version], { stdio: 'ignore' }).status === 0;

it.runIf(hasCli('qpdf', '--version') && hasCli('openssl', 'version'))(
  'independent qpdf and OpenSSL tools validate encryption, xrefs and detached CMS',
  async () => {
    const doc = authored();
    await doc.Certify(buildSigner({ type: 'ec' }), {
      ...signingOptions, encrypt: { ...encrypt, algorithm: 'aes128' },
    });
    const bytes = doc.Save();
    const dir = mkdtempSync(join(tmpdir(), 'first-encrypted-sign-'));
    try {
      const file = join(dir, 'signed.pdf');
      writeFileSync(file, bytes);
      const qpdf = (password: string) => spawnSync('qpdf', [`--password=${password}`, '--check', file], { encoding: 'utf8' });
      expect(qpdf('incorrect').status).not.toBe(0);
      for (const password of [userPassword, ownerPassword]) {
        const result = qpdf(password);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('AESv2');
      }

      const { byteRange, contents, cmsLength } = Document.Open(bytes, { password: userPassword }).Signatures[0];
      const [, left, right, tail] = byteRange!;
      const dataFile = join(dir, 'ranges.bin');
      const cmsFile = join(dir, 'signature.der');
      const covered = Buffer.concat([bytes.subarray(0, left), bytes.subarray(right, right + tail)]);
      writeFileSync(dataFile, covered);
      writeFileSync(cmsFile, contents!.subarray(0, cmsLength));
      const verified = execFileSync('openssl', [
        'cms', '-verify', '-binary', '-inform', 'DER', '-in', cmsFile, '-content', dataFile, '-noverify',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      expect(verified).toEqual(covered);
    } finally {
      for (const file of ['signed.pdf', 'signature.der', 'ranges.bin']) rmSync(join(dir, file), { force: true });
      rmdirSync(dir);
    }
  },
);
