// ECDH-ES key-agreement primitives for CMS KeyAgreeRecipientInfo (RFC 5652 §6.2.2,
// RFC 5753): the ANSI-X9.63 concatenation KDF, the ECC-CMS-SharedInfo structure,
// and RFC 3394 AES key wrap/unwrap. Built on node:crypto and the asn1.ts DER layer.
// Zero runtime dependencies. Used by cms.ts for EC recipient certificates.

import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { der, OID } from './asn1.js';

export type KdfHash = 'sha1' | 'sha256' | 'sha384' | 'sha512';

/** dhSinglePass-stdDH-*kdf scheme OID -> KDF hash. Includes the X9.63 SHA-1
 *  scheme (openssl's `cms -encrypt` default) for read interop. */
export const KDF_HASH: Record<string, KdfHash> = {
  [OID.dhSinglePassStdDHsha1]: 'sha1',
  [OID.dhSinglePassStdDHsha256]: 'sha256',
  [OID.dhSinglePassStdDHsha384]: 'sha384',
  [OID.dhSinglePassStdDHsha512]: 'sha512',
};
export const DH_SINGLE_PASS: Record<'sha256' | 'sha384' | 'sha512', string> = {
  sha256: OID.dhSinglePassStdDHsha256,
  sha384: OID.dhSinglePassStdDHsha384,
  sha512: OID.dhSinglePassStdDHsha512,
};
/** aes-wrap OID -> node cipher name + KEK byte length. */
export const WRAP_CIPHER: Record<string, { name: string; keyLen: number }> = {
  [OID.aes128Wrap]: { name: 'aes128-wrap', keyLen: 16 },
  [OID.aes192Wrap]: { name: 'aes192-wrap', keyLen: 24 },
  [OID.aes256Wrap]: { name: 'aes256-wrap', keyLen: 32 },
};
export const AES_WRAP_OID: Record<number, string> = {
  16: OID.aes128Wrap, 24: OID.aes192Wrap, 32: OID.aes256Wrap,
};

/** RFC 3394 default IV for AES key wrap. */
const WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

/** ANSI-X9.63 KDF: K = Hash(Z ‖ counter32-BE ‖ sharedInfo), counter from 1. */
export function x963Kdf(
  z: Uint8Array, keyLenBytes: number, sharedInfo: Uint8Array, hash: KdfHash,
): Uint8Array {
  const out: Buffer[] = [];
  let counter = 1;
  let total = 0;
  while (total < keyLenBytes) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(counter++, 0);
    const block = createHash(hash).update(z).update(ctr).update(sharedInfo).digest();
    out.push(block);
    total += block.length;
  }
  return new Uint8Array(Buffer.concat(out).subarray(0, keyLenBytes));
}

/** ECC-CMS-SharedInfo ::= SEQUENCE { keyInfo AlgorithmIdentifier,
 *  [0] entityUInfo OPTIONAL (omitted), [2] suppPubInfo OCTET STRING (keylen bits) }. */
export function eccCmsSharedInfo(wrapAlgId: Uint8Array, keyLenBits: number): Uint8Array {
  const bits = new Uint8Array(4);
  new DataView(bits.buffer).setUint32(0, keyLenBits, false);
  return der.sequence(wrapAlgId, der.explicit(2, der.octetString(bits)));
}

export function aesKeyWrap(kek: Uint8Array, cek: Uint8Array): Uint8Array {
  const cipher = WRAP_CIPHER[AES_WRAP_OID[kek.length]];
  const c = createCipheriv(cipher.name, Buffer.from(kek), WRAP_IV);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(cek)), c.final()]));
}

export function aesKeyUnwrap(kek: Uint8Array, wrapped: Uint8Array): Uint8Array {
  const cipher = WRAP_CIPHER[AES_WRAP_OID[kek.length]];
  const d = createDecipheriv(cipher.name, Buffer.from(kek), WRAP_IV);
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(wrapped)), d.final()]));
}
