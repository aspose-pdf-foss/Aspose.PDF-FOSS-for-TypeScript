import { describe, it, expect } from 'vitest';
import { rc4, aesCbcDecrypt, aesCbc128Encrypt } from '../src/crypto.js';
import { PASSWORD_PADDING, padPassword, fileKeyR234, objectKeyV4, hash2B } from '../src/crypto.js';
import { createCipheriv, createHash } from 'node:crypto';

const md5node = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const ascii = (s: string) => new TextEncoder().encode(s);

describe('rc4', () => {
  // Classic published RC4 test vectors.
  it('Key/Plaintext', () => {
    expect(rc4(ascii('Key'), ascii('Plaintext'))).toEqual(hex('bbf316e8d940af0ad3'));
  });
  it('Wiki/pedia', () => {
    expect(rc4(ascii('Wiki'), ascii('pedia'))).toEqual(hex('1021bf0420'));
  });
  it('Secret/Attack at dawn', () => {
    expect(rc4(ascii('Secret'), ascii('Attack at dawn'))).toEqual(hex('45a01f645fc35b383552544b9bf5'));
  });
  it('is symmetric (decrypt undoes encrypt)', () => {
    const key = ascii('Key');
    const ct = rc4(key, ascii('Plaintext'));
    expect(new TextDecoder().decode(rc4(key, ct))).toBe('Plaintext');
  });
});

describe('aesCbcDecrypt', () => {
  it('round-trips AES-128 with PKCS#7 padding, IV prefixed', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const iv = hex('0f0e0d0c0b0a09080706050403020100');
    const plain = ascii('hello pdf encryption!'); // 21 bytes -> padded
    const c = createCipheriv('aes-128-cbc', key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    const data = new Uint8Array([...iv, ...body]); // PDF prepends IV
    expect(aesCbcDecrypt(key, data)).toEqual(plain);
  });

  it('round-trips AES-256', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const iv = hex('00000000000000000000000000000000');
    const plain = ascii('thirty-two bytes? no, just text.');
    const c = createCipheriv('aes-256-cbc', key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    expect(aesCbcDecrypt(key, new Uint8Array([...iv, ...body]))).toEqual(plain);
  });

  it('returns empty for sub-block data', () => {
    expect(aesCbcDecrypt(hex('00112233445566778899aabbccddeeff'), hex('0011'))).toEqual(new Uint8Array(0));
  });
});

describe('aesCbc128Encrypt (no padding)', () => {
  it('matches Node createCipheriv with autoPadding off', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const iv = hex('0f0e0d0c0b0a09080706050403020100');
    const plain = hex('00000000000000000000000000000000'); // exactly one block
    const c = createCipheriv('aes-128-cbc', key, iv); c.setAutoPadding(false);
    const exp = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    expect(aesCbc128Encrypt(key, iv, plain)).toEqual(exp);
  });
});

describe('key derivation', () => {
  it('padding string is the spec 32-byte constant', () => {
    expect(PASSWORD_PADDING.length).toBe(32);
    expect(Buffer.from(PASSWORD_PADDING).toString('hex')).toBe(
      '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a');
  });

  it('padPassword of empty password is exactly the padding string', () => {
    expect(padPassword(new Uint8Array(0))).toEqual(PASSWORD_PADDING);
  });

  it('padPassword truncates passwords longer than 32 bytes', () => {
    const long = new Uint8Array(40).fill(0x41);
    expect(padPassword(long)).toEqual(new Uint8Array(32).fill(0x41));
  });

  it('fileKeyR234 at R=2 equals one MD5 over the spec inputs (ground truth)', () => {
    const pw = new Uint8Array(0);
    const O = new Uint8Array(32).fill(0x11);
    const id0 = hex('cafebabe');
    const P = -44; // typical permissions
    const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]);
    const expected = md5node(cat(padPassword(pw), O, pLE, id0)).subarray(0, 5);
    expect(fileKeyR234(pw, O, P, id0, 2, 40, true)).toEqual(expected);
  });

  it('fileKeyR234 at R=3 applies 50 extra MD5 rounds (ground truth)', () => {
    const pw = new Uint8Array(0);
    const O = new Uint8Array(32).fill(0x22);
    const id0 = hex('0badf00d');
    const P = -3904;
    const n = 16; // 128-bit
    const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]);
    let h = md5node(cat(padPassword(pw), O, pLE, id0));
    for (let i = 0; i < 50; i++) h = md5node(h.subarray(0, n));
    expect(fileKeyR234(pw, O, P, id0, 3, 128, true)).toEqual(h.subarray(0, n));
  });

  it('objectKeyV4 (RC4) matches MD5(fileKey + num3 + gen2) truncated', () => {
    const fk = new Uint8Array(16).fill(0xab);
    const exp = md5node(cat(fk, new Uint8Array([7, 0, 0, 0, 0]))).subarray(0, 16);
    expect(objectKeyV4(fk, 7, 0, false)).toEqual(exp);
  });

  it('objectKeyV4 (AES) appends the sAlT bytes', () => {
    const fk = new Uint8Array(16).fill(0xcd);
    const salt = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"
    const exp = md5node(cat(fk, new Uint8Array([5, 0, 0, 1, 0]), salt)).subarray(0, 16);
    expect(objectKeyV4(fk, 5, 1, true)).toEqual(exp);
  });
});

describe('hash2B (R6 hardened hash)', () => {
  it('is deterministic and returns 32 bytes', () => {
    const salt = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = hash2B(new Uint8Array(0), salt, new Uint8Array(0));
    const b = hash2B(new Uint8Array(0), salt, new Uint8Array(0));
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('differs for different salts', () => {
    const a = hash2B(new Uint8Array(0), Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]), new Uint8Array(0));
    const b = hash2B(new Uint8Array(0), Uint8Array.from([2, 2, 2, 2, 2, 2, 2, 2]), new Uint8Array(0));
    expect(a).not.toEqual(b);
  });
});
