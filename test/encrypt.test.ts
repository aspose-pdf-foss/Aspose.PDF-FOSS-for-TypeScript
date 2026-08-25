import { describe, it, expect } from 'vitest';
import { buildEncryptor, permissionsToP } from '../src/encrypt.js';
import { buildDecryptor } from '../src/crypto.js';
import { isString, PdfObject } from '../src/types.js';

const id0 = new Uint8Array(16).fill(7);
const resolve = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);

function roundTripString(algorithm: 'aes256' | 'aes128' | 'rc4'): string {
  const e = buildEncryptor({ userPassword: 'pw', algorithm }, id0);
  const original = new TextEncoder().encode('hello secret');
  const enc = e.encryptObject({ kind: 'string', bytes: original }, 5, 0);
  const d = buildDecryptor(e.encryptDict, id0, 'pw', resolve)!;
  const back = d.decryptObject(enc, 5, 0);
  return isString(back) ? new TextDecoder().decode(back.bytes) : '<not a string>';
}

describe('buildEncryptor round-trip', () => {
  for (const algorithm of ['aes256', 'aes128', 'rc4'] as const) {
    it(`${algorithm}: encryptObject round-trips a string through buildDecryptor`, () => {
      expect(roundTripString(algorithm)).toBe('hello secret');
    });
  }
});

describe('buildEncryptor (AES-256)', () => {
  it('produces an AESV3 /Encrypt dict', () => {
    const e = buildEncryptor({ userPassword: 'pw', algorithm: 'aes256' }, id0);
    expect(e.encryptDict.get('V')).toBe(5);
    expect(e.encryptDict.get('R')).toBe(6);
  });
});

describe('permissionsToP', () => {
  it('defaults to all-allowed', () => {
    const p = permissionsToP();
    expect(p & 0x04).toBe(0x04); // printing
    expect(p & 0x800).toBe(0x800); // high-quality printing
  });
  it('clears only the disabled bit', () => {
    const p = permissionsToP({ copying: false });
    expect(p & 0x10).toBe(0);    // copying cleared
    expect(p & 0x04).toBe(0x04); // printing untouched
  });
});
