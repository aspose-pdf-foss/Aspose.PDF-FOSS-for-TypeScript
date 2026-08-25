import { describe, it, expect } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import {
  aesCbcEncrypt, aesCbcDecrypt, aesCbcEncryptNoPad, aesCbcDecryptNoPad,
  aes256EcbEncrypt, randomBytes,
} from '../src/crypto.js';

describe('write-side ciphers', () => {
  it('aesCbcEncrypt round-trips through aesCbcDecrypt (128 and 256)', () => {
    for (const klen of [16, 32]) {
      const key = randomBytes(klen);
      const data = randomBytes(40);
      const ct = aesCbcEncrypt(key, data);
      expect([...aesCbcDecrypt(key, ct)]).toEqual([...data]);
    }
  });

  it('aesCbcEncryptNoPad round-trips through aesCbcDecryptNoPad', () => {
    const key = randomBytes(32);
    const iv = new Uint8Array(16);
    const data = randomBytes(32);
    const ct = aesCbcEncryptNoPad(key, iv, data);
    expect([...aesCbcDecryptNoPad(key, iv, ct)]).toEqual([...data]);
  });

  it('aes256EcbEncrypt matches a node reference decrypt', () => {
    const key = randomBytes(32);
    const data = randomBytes(16);
    const ct = aes256EcbEncrypt(key, data);
    const d = createDecipheriv('aes-256-ecb', key, null);
    d.setAutoPadding(false);
    const pt = new Uint8Array(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
    expect([...pt]).toEqual([...data]);
  });

  it('randomBytes returns the requested length', () => {
    expect(randomBytes(16).length).toBe(16);
  });
});
