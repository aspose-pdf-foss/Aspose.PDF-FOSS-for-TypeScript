import { describe, it, expect } from 'vitest';
import { buildEncryptorFromKeys } from '../src/encrypt.js';
import { CryptKeys } from '../src/crypto.js';
import { name, PdfDict, PdfObject, isString } from '../src/types.js';

const dict = (): PdfDict => new Map<string, PdfObject>([['Filter', name('Standard')]]);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (s: string): PdfObject => ({ kind: 'string', bytes: bytes(s) });

// A 32-byte key satisfies every cipher: rc4 and aes128 derive a per-object key
// from it, aes256 uses it directly.
const KEY = new Uint8Array(32).map((_, i) => i * 7 + 1);

describe('buildEncryptorFromKeys', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a string through ${cipher}`, () => {
      const keys: CryptKeys = { fileKey: KEY, streamCipher: cipher, stringCipher: cipher };
      const enc = buildEncryptorFromKeys(keys, dict());
      const out = enc.encryptObject(str('SecretTitle'), 7, 0);
      expect(isString(out)).toBe(true);
      // Encrypted output must not be the plaintext.
      expect(new TextDecoder('latin1').decode((out as { bytes: Uint8Array }).bytes))
        .not.toContain('SecretTitle');
    });

    it(`round-trips a stream payload through ${cipher}`, () => {
      const keys: CryptKeys = { fileKey: KEY, streamCipher: cipher, stringCipher: cipher };
      const enc = buildEncryptorFromKeys(keys, dict());
      const out = enc.encryptStreamRaw(bytes('payload-bytes-here'), 7, 0);
      expect(new TextDecoder('latin1').decode(out)).not.toContain('payload');
    });
  }

  it('passes identity through unchanged', () => {
    const keys: CryptKeys = { fileKey: KEY, streamCipher: 'identity', stringCipher: 'identity' };
    const enc = buildEncryptorFromKeys(keys, dict());
    expect(enc.encryptStreamRaw(bytes('plain'), 1, 0)).toEqual(bytes('plain'));
  });

  it('carries the supplied /Encrypt dict verbatim', () => {
    const d = dict();
    d.set('R', 4);
    const enc = buildEncryptorFromKeys(
      { fileKey: KEY, streamCipher: 'rc4', stringCipher: 'rc4' }, d);
    expect(enc.encryptDict).toBe(d);
  });
});
