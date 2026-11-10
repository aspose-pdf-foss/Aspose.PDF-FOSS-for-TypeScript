import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildDecryptor } from '../src/crypto.js';
import { buildEncryptor } from '../src/encrypt.js';
import { PdfDict, PdfObject, isArray, isName, isStream, name } from '../src/types.js';

// hch6: qpdf 12.3.2's --cleartext-metadata writes /EncryptMetadata false and
// leaves the XMP plaintext with NO /Crypt marker. See
// test/fixtures/qpdf-xmp/PROVENANCE.md.
const dir = join(__dirname, 'fixtures', 'qpdf-xmp');
const TITLE = 'hch6 cleartext XMP';
const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

function catalogXmp(doc: Document) {
  const s = doc.resolve(doc.catalog().get('Metadata'));
  if (!isStream(s)) throw new Error('no /Metadata stream');
  return s;
}

describe('qpdf --cleartext-metadata: plaintext XMP with no /Crypt marker (hch6)', () => {
  for (const f of ['aes128', 'aes256', 'rc4']) {
    it(`opens ${f}.pdf with its XMP readable and its page still decrypted`, () => {
      const doc = Document.Open(readFileSync(join(dir, `${f}.pdf`)));
      expect(doc.recovery).toBeUndefined();
      expect(doc.GetXmp().title).toBe(TITLE);
      expect(doc.Pages[0].GetText()).toContain('hch6 body text');
    });
  }

  it('marks the XMP with an Identity /Crypt when the encryption is preserved on Save', () => {
    const saved = Document.Open(readFileSync(join(dir, 'aes128.pdf'))).Save();
    expect(latin1(saved)).toContain(TITLE);
    const back = Document.Open(saved);
    const filter = back.resolve(catalogXmp(back).dict.get('Filter'));
    const names = isArray(filter) ? filter : [filter];
    expect(names.some((x) => isName(x) && x.name === 'Crypt')).toBe(true);
    expect(back.GetXmp().title).toBe(TITLE);
  });
});

// The other half: before lj8t this library wrote the XMP ENCRYPTED under
// /EncryptMetadata false, with no marker. Those files must still open.
describe('an unmarked metadata stream is decided by its content (hch6)', () => {
  const id0 = new Uint8Array(16).fill(7);
  const xmp = new TextEncoder().encode(`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>`);
  const resolve = (o: PdfObject | undefined): PdfObject => o ?? null;

  function decrypt(algorithm: 'aes128' | 'aes256' | 'rc4', encryptMetadata: boolean, raw: Uint8Array, type = 'Metadata'): Uint8Array {
    const enc = buildEncryptor({ userPassword: 'u', algorithm, encryptMetadata }, id0);
    const dec = buildDecryptor(enc.encryptDict, id0, 'u', resolve);
    if (!dec) throw new Error('no decryptor');
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name(type)]]);
    const out = dec.decryptObject({ kind: 'stream', dict, raw }, 5, 0);
    if (!isStream(out)) throw new Error('not a stream');
    return out.raw;
  }

  for (const algorithm of ['aes128', 'aes256'] as const) {
    it(`keeps a plaintext packet plaintext under ${algorithm}`, () => {
      expect(latin1(decrypt(algorithm, false, xmp))).toBe(latin1(xmp));
    });
  }

  it('still decrypts a packet this library encrypted before lj8t', () => {
    for (const algorithm of ['aes128', 'aes256'] as const) {
      // encryptStreamRaw applies the cipher whatever the flag says -- the old
      // shape. An AES-256 file key is random, so writer and reader share a dict.
      const enc = buildEncryptor({ userPassword: 'u', algorithm, encryptMetadata: false }, id0);
      const encrypted = enc.encryptStreamRaw(xmp, 5, 0);
      expect(latin1(encrypted)).not.toContain('xpacket');
      const dec = buildDecryptor(enc.encryptDict, id0, 'u', resolve)!;
      const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')]]);
      const out = dec.decryptObject({ kind: 'stream', dict, raw: encrypted }, 5, 0);
      expect(isStream(out) && latin1(out.raw)).toBe(latin1(xmp));
    }
  });

  it('decrypts a plaintext-looking packet when /EncryptMetadata is true', () => {
    expect(() => decrypt('aes128', true, xmp)).toThrow();
  });

  it('applies only to /Type /Metadata', () => {
    expect(() => decrypt('aes128', false, xmp, 'XObject')).toThrow();
  });

  it('applies only from V 4, where /EncryptMetadata means anything', () => {
    // 'rc4' here is the V 2 handler, which has no crypt filters.
    expect(latin1(decrypt('rc4', false, xmp))).not.toBe(latin1(xmp));
  });

  it('does not take a packet behind leading text for plaintext', () => {
    const behind = new TextEncoder().encode(`junk${latin1(xmp)}`);
    expect(() => decrypt('aes128', false, behind)).toThrow();
  });
});
