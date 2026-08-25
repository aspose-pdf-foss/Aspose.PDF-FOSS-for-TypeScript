import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { x963Kdf, aesKeyWrap, aesKeyUnwrap, eccCmsSharedInfo } from '../src/cmskdf.js';
import { der, OID, parse, readOid } from '../src/asn1.js';

describe('cmskdf', () => {
  it('x963Kdf(sha256) matches Hash(Z || counter || info) for one block', () => {
    const z = new Uint8Array([1, 2, 3, 4]);
    const info = new Uint8Array([0xaa, 0xbb]);
    const ctr = Buffer.from([0, 0, 0, 1]);
    const expected = new Uint8Array(
      createHash('sha256').update(Buffer.concat([Buffer.from(z), ctr, Buffer.from(info)])).digest()).subarray(0, 16);
    expect([...x963Kdf(z, 16, info, 'sha256')]).toEqual([...expected]);
  });

  it('aesKeyWrap / aesKeyUnwrap round-trip (RFC 3394)', () => {
    const kek = new Uint8Array(16).map((_, i) => i);
    const cek = new Uint8Array(16).map((_, i) => 0x10 + i);
    const wrapped = aesKeyWrap(kek, cek);
    expect(wrapped.length).toBe(24); // 16 + 8
    expect([...aesKeyUnwrap(kek, wrapped)]).toEqual([...cek]);
  });

  it('eccCmsSharedInfo encodes keyInfo + suppPubInfo(keylen bits)', () => {
    const wrapAlg = der.sequence(der.oid(OID.aes128Wrap));
    const si = parse(eccCmsSharedInfo(wrapAlg, 128));
    expect(readOid(si.children[0].children[0])).toBe(OID.aes128Wrap);
    // suppPubInfo [2] EXPLICIT OCTET STRING = 00000080 (128 as 4-byte BE)
    const supp = si.children[si.children.length - 1];
    expect([...supp.children[0].content]).toEqual([0, 0, 0, 0x80]);
  });
});
