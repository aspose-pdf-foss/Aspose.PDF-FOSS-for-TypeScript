// Independent decode-path conformance test. It decrypts the bytes our PubSec
// encryptor produces using ONLY raw node:crypto + the ASN.1 parser — it never
// calls buildPubSecDecryptor or openEnvelopedData. This verifies the spec byte
// layout (RSA-PKCS1 key transport, AES-128-CBC envelope with IV in the algorithm
// params, seed(20)+perms(4) payload, SHA-256(seed ‖ recipients) key derivation,
// AES-256 object encryption with a prepended IV) rather than merely proving our
// own encrypt and decrypt agree with each other.

import { describe, it, expect } from 'vitest';
import { privateDecrypt, createDecipheriv, createHash, constants } from 'node:crypto';
import { parse } from '../src/asn1.js';
import { buildPubSecEncryptor } from '../src/pubsec.js';
import { isDict, isArray, isString, isName } from '../src/types.js';
import { buildRsaSigner } from './helpers/build-signer.js';

describe('PubSec encoder conformance (independent decode path)', () => {
  it('an independent decoder recovers an AES-256 encrypted string', () => {
    const r = buildRsaSigner('Golden Recipient');
    const enc = buildPubSecEncryptor({
      recipients: [{ certificate: r.certificate }], algorithm: 'aes256',
    });

    // Encrypt a known string at object (num=7, gen=0) with our encoder.
    const plaintext = 'golden';
    const ct = enc.encryptObject(
      { kind: 'string', bytes: new TextEncoder().encode(plaintext) }, 7, 0);
    expect(isString(ct)).toBe(true);
    const ctBytes = (ct as { kind: 'string'; bytes: Uint8Array }).bytes;

    // --- Independent decode, using only node:crypto + der.parse ---

    // Pull the single /Recipients envelope out of /CF /DefaultCryptFilter.
    const cf = enc.encryptDict.get('CF');
    expect(isDict(cf)).toBe(true);
    const dcf = (cf as Map<string, any>).get('DefaultCryptFilter');
    expect(isDict(dcf)).toBe(true);
    const recips = (dcf as Map<string, any>).get('Recipients');
    expect(isArray(recips)).toBe(true);
    const envBytes: Uint8Array = (recips as any[])[0].bytes;

    // Confirm the handler dict advertises the AES-256 profile.
    const stmf = enc.encryptDict.get('StmF');
    expect(isName(stmf) && (stmf as any).name).toBe('DefaultCryptFilter');
    expect((dcf as Map<string, any>).get('CFM')).toMatchObject({ name: 'AESV3' });

    // Parse EnvelopedData -> KeyTransRecipientInfo -> RSA-unwrap the CEK.
    const contentInfo = parse(envBytes);
    const envelopedData = contentInfo.children[1].children[0];
    const ri = envelopedData.children[1].children[0];          // first RecipientInfo
    const eci = envelopedData.children[2];                     // EncryptedContentInfo
    const encryptedKey = ri.children[3].content;
    const cek = privateDecrypt(
      { key: r.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(encryptedKey));
    expect(cek.length).toBe(16); // AES-128 content-encryption key

    // AES-128-CBC decrypt the envelope content -> 24-byte seed+perms payload.
    const envIv = eci.children[1].children[1].content;         // algorithm params IV
    const envCt = eci.children[2].content;                     // [0] IMPLICIT OCTET STRING
    const d1 = createDecipheriv('aes-128-cbc', cek, Buffer.from(envIv));
    const payload = Buffer.concat([d1.update(Buffer.from(envCt)), d1.final()]);
    expect(payload.length).toBe(24);
    const seed = payload.subarray(0, 20);

    // Independently derive the file key: SHA-256(seed ‖ envelope), all 32 bytes.
    const fileKey = createHash('sha256')
      .update(Buffer.concat([seed, Buffer.from(envBytes)])).digest();
    expect(fileKey.length).toBe(32);

    // AES-256 object: ciphertext is IV(16) ‖ CBC ciphertext, file key used directly.
    const objIv = ctBytes.subarray(0, 16);
    const objCt = ctBytes.subarray(16);
    const d2 = createDecipheriv('aes-256-cbc', fileKey, Buffer.from(objIv));
    const decoded = Buffer.concat([d2.update(Buffer.from(objCt)), d2.final()]).toString('utf8');

    expect(decoded).toBe(plaintext);
  });
});
