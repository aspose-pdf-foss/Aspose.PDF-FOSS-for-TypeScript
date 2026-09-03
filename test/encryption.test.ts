import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { inflateStream } from '../src/flate.js';
import { buildEncryptedPdf, buildEncryptedPdfWithObjStm } from './helpers/encrypt-pdf.js';
import { isStream } from '../src/types.js';
import { InvalidPasswordError } from '../src/errors.js';

const dec = new TextDecoder();

describe('Open: RC4 (V2/R3) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128 },
      { info: { Title: 'Hello RC4', Author: 'Oleg' }, pageContents: ['BT (Page one) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    const md = doc.GetMetadata();
    expect(md.title).toBe('Hello RC4');
    expect(md.author).toBe('Oleg');

    const page = doc.Pages[0];
    const contents = doc.resolve(page.Dict.get('Contents'));
    expect(isStream(contents)).toBe(true);
    if (isStream(contents)) {
      expect(dec.decode(inflateStream(contents))).toBe('BT (Page one) Tj ET');
    }
  });
});

describe('Open: AES-128 (V4/R4) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', V: 4, R: 4, length: 128 },
      { info: { Title: 'Hello AES128' }, pageContents: ['BT (AES page) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('Hello AES128');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (AES page) Tj ET');
    else throw new Error('contents not a stream');
  });
});

describe('Open: AES-256 (V5/R6) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes256', V: 5, R: 6, length: 256 },
      { info: { Title: 'Hello AES256' }, pageContents: ['BT (AES256 page) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('Hello AES256');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (AES256 page) Tj ET');
    else throw new Error('contents not a stream');
  });
});

describe('Open: encrypted document with an object stream', () => {
  it('decrypts the ObjStm container once; contained Info is correct', () => {
    const { bytes } = buildEncryptedPdfWithObjStm(
      { cipher: 'aes128', V: 4, R: 4, length: 128 },
      { info: { Title: 'In ObjStm' }, pageContents: ['BT (objstm) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('In ObjStm');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (objstm) Tj ET');
    else throw new Error('contents not a stream');
  });
});

describe('Open: password handling', () => {
  it('opens with the correct non-empty user password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128, userPassword: 'swordfish' },
      { info: { Title: 'Guarded' }, pageContents: ['BT (pw) Tj ET'] },
    );
    const doc = Document.Open(bytes, { password: 'swordfish' });
    expect(doc.GetMetadata().title).toBe('Guarded');
  });

  it('throws InvalidPasswordError on a wrong password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128, userPassword: 'swordfish' },
      { info: { Title: 'Guarded' }, pageContents: ['BT (pw) Tj ET'] },
    );
    expect(() => Document.Open(bytes, { password: 'wrong' })).toThrow(InvalidPasswordError);
  });

  it('throws on a password-protected file opened with no password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes256', V: 5, R: 6, length: 256, userPassword: 'hunter2' },
      { info: { Title: 'R6 guarded' }, pageContents: ['BT (r6) Tj ET'] },
    );
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);
  });

  it('decrypts with EncryptMetadata false (AES-128)', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', V: 4, R: 4, length: 128, encryptMetadata: false },
      { info: { Title: 'NoMetaEnc' }, pageContents: ['BT (nme) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('NoMetaEnc');
  });
});

// This described the OLD behaviour, in which Save() silently decrypted an
// opened encrypted document. It is inverted rather than deleted, because the
// content half is still exactly what must survive -- what changed is that the
// output stays encrypted unless the caller says otherwise (0cr3).
describe('Save: round-trips an opened encrypted PDF', () => {
  const roundTrip = (): Uint8Array => buildEncryptedPdf(
    { cipher: 'aes128', V: 4, R: 4, length: 128 },
    { info: { Title: 'RoundTrip' }, pageContents: ['BT (rt) Tj ET'] },
  ).bytes;

  const expectContent = (re: Document): void => {
    expect(re.GetMetadata().title).toBe('RoundTrip');
    const contents = re.resolve(re.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (rt) Tj ET');
    else throw new Error('contents not a stream');
  };

  it('keeps /Encrypt and the content by default', () => {
    const out = Document.Open(roundTrip()).Save();
    expect(Buffer.from(out).toString('latin1')).toContain('/Encrypt');
    expectContent(Document.Open(out));
  });

  it('drops /Encrypt and re-opens without a password when asked', () => {
    const out = Document.Open(roundTrip()).Save({ encrypt: false });
    expect(Buffer.from(out).toString('latin1')).not.toContain('/Encrypt');
    expectContent(Document.Open(out));
  });
});
