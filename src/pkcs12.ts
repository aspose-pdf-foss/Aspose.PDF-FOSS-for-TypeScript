// PKCS#12 (.pfx / .p12) parser: ASN.1 structure walk + the classic PKCS#12 KDF
// (RFC 7292 Appendix B.2) + PBES1 / PBES2 decryption, yielding the private key
// and certificate chain for the digital-signature stack. Built on the asn1.ts
// DER layer and node:crypto primitives (ciphers, PBKDF2, HMAC). Zero runtime
// dependencies. Read counterpart used by signer.ts to resolve a `{ pkcs12 }`
// credential into a CmsSigner.

import {
  KeyObject, createPrivateKey, createPublicKey, createDecipheriv, pbkdf2Sync,
  createHash, createHmac,
} from 'node:crypto';
import { parse, readInteger, readOid, Asn1Node } from './asn1.js';
import { InvalidPasswordError, UnsupportedFeatureError, PdfParseError } from './errors.js';

export interface Pkcs12Result {
  /** The recovered private key. */
  privateKey: KeyObject;
  /** Embedded certificates (DER); the leaf matching the key is placed first. */
  certificates: Uint8Array[];
}

// --- OIDs --------------------------------------------------------------------
const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  // bag types
  keyBag: '1.2.840.113549.1.12.10.1.1',
  pkcs8ShroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  // PBES2 / PBKDF2
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  // PBES1 (PKCS#12)
  pbeSHA3DES: '1.2.840.113549.1.12.1.3',   // pbeWithSHAAnd3-KeyTripleDES-CBC
  pbeSHA2DES: '1.2.840.113549.1.12.1.4',   // pbeWithSHAAnd2-KeyTripleDES-CBC
  pbeSHA128RC2: '1.2.840.113549.1.12.1.5', // pbeWithSHAAnd128BitRC2-CBC
  pbeSHA40RC2: '1.2.840.113549.1.12.1.6',  // pbeWithSHAAnd40BitRC2-CBC
  // 3DES (PBES2 encryptionScheme)
  desEDE3CBC: '1.2.840.113549.3.7',
  // AES-CBC encryptionSchemes
  aes128CBC: '2.16.840.1.101.3.4.1.2',
  aes192CBC: '2.16.840.1.101.3.4.1.22',
  aes256CBC: '2.16.840.1.101.3.4.1.42',
} as const;

// prf OID -> node hash name (PBKDF2 default is hmacWithSHA1).
const PRF_HASH: Record<string, string> = {
  '1.2.840.113549.2.7': 'sha1',
  '1.2.840.113549.2.8': 'sha224',
  '1.2.840.113549.2.9': 'sha256',
  '1.2.840.113549.2.10': 'sha384',
  '1.2.840.113549.2.11': 'sha512',
};
// digestAlgorithm OID -> node hash name (MAC).
const DIGEST_HASH: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
// hash name -> { output bytes u, block bytes v } for the PKCS#12 KDF.
const HASH_PARAMS: Record<string, { u: number; v: number }> = {
  sha1: { u: 20, v: 64 }, sha224: { u: 28, v: 64 }, sha256: { u: 32, v: 64 },
  sha384: { u: 48, v: 128 }, sha512: { u: 64, v: 128 },
};
// AES encryptionScheme OID -> key length.
const AES_KEYLEN: Record<string, number> = {
  [OID.aes128CBC]: 16, [OID.aes192CBC]: 24, [OID.aes256CBC]: 32,
};
const AES_CIPHER: Record<number, string> = { 16: 'aes-128-cbc', 24: 'aes-192-cbc', 32: 'aes-256-cbc' };

// --- PKCS#12 KDF (RFC 7292 B.2) ---------------------------------------------
/** Password as a BMPString (UTF-16BE) with a two-byte null terminator. */
function bmpString(pw: string): Buffer {
  const out = Buffer.alloc(pw.length * 2 + 2);
  for (let i = 0; i < pw.length; i++) {
    const c = pw.charCodeAt(i);
    out[i * 2] = c >> 8; out[i * 2 + 1] = c & 0xff;
  }
  return out;
}

function extend(data: Buffer, v: number): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(v * Math.ceil(data.length / v));
  for (let i = 0; i < out.length; i++) out[i] = data[i % data.length];
  return out;
}

/** Derive `n` bytes for diversifier `id` (1=key, 2=IV, 3=MAC) from the password. */
function pkcs12Kdf(pwBmp: Buffer, salt: Buffer, iter: number, id: number, n: number, hash: string): Buffer {
  const { u, v } = HASH_PARAMS[hash];
  const D = Buffer.alloc(v, id);
  const I = Buffer.concat([extend(salt, v), extend(pwBmp, v)]);
  const chunks: Buffer[] = [];
  let generated = 0;
  while (generated < n) {
    let A = Buffer.concat([D, I]);
    for (let i = 0; i < iter; i++) A = createHash(hash).update(A).digest();
    chunks.push(A); generated += A.length;
    if (generated >= n) break;
    const B = Buffer.alloc(v);
    for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff; carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(chunks).subarray(0, n);
}

// --- decryption --------------------------------------------------------------
/** Decrypt `ciphertext` given an encryption AlgorithmIdentifier + password. */
function decrypt(algId: Asn1Node, ciphertext: Buffer, pw: string): Buffer {
  const oid = readOid(algId.children[0]);
  const params = algId.children[1];
  if (oid === OID.pbes2) return decryptPbes2(params, ciphertext, pw);
  return decryptPbes1(oid, params, ciphertext, pw);
}

function decryptPbes2(params: Asn1Node, ciphertext: Buffer, pw: string): Buffer {
  const kdf = params.children[0];      // keyDerivationFunc
  const enc = params.children[1];      // encryptionScheme
  if (readOid(kdf.children[0]) !== OID.pbkdf2)
    throw new UnsupportedFeatureError(`PKCS#12: unsupported PBES2 KDF ${readOid(kdf.children[0])}`);
  const kp = kdf.children[1];          // PBKDF2-params
  const salt = Buffer.from(kp.children[0].content);
  const iter = Number(readInteger(kp.children[1]));
  // Optional keyLength and prf follow in any order after salt+iter.
  let prfHash = 'sha1';
  for (let i = 2; i < kp.children.length; i++) {
    const ch = kp.children[i];
    if (ch.tag === 0x10) prfHash = PRF_HASH[readOid(ch.children[0])] ?? 'sha1'; // SEQUENCE prf
  }
  const encOid = readOid(enc.children[0]);
  const keyLen = AES_KEYLEN[encOid] ?? (encOid === OID.desEDE3CBC ? 24 : 0);
  if (!keyLen) throw new UnsupportedFeatureError(`PKCS#12: unsupported PBES2 cipher ${encOid}`);
  const iv = Buffer.from(enc.children[1].content);
  const key = pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, iter, keyLen, prfHash);
  const cipher = encOid === OID.desEDE3CBC ? 'des-ede3-cbc' : AES_CIPHER[keyLen];
  return runDecipher(cipher, key, iv, ciphertext);
}

function decryptPbes1(oid: string, params: Asn1Node, ciphertext: Buffer, pw: string): Buffer {
  // pkcs-12PbeParams ::= SEQUENCE { salt OCTET STRING, iterations INTEGER }
  const salt = Buffer.from(params.children[0].content);
  const iter = Number(readInteger(params.children[1]));
  const spec = pbe1Spec(oid);
  const pwBmp = bmpString(pw);
  const key = pkcs12Kdf(pwBmp, salt, iter, 1, spec.keyLen, 'sha1');
  const iv = pkcs12Kdf(pwBmp, salt, iter, 2, spec.ivLen, 'sha1');
  return runDecipher(spec.cipher, key, iv, ciphertext);
}

function pbe1Spec(oid: string): { cipher: string; keyLen: number; ivLen: number } {
  switch (oid) {
    case OID.pbeSHA3DES: return { cipher: 'des-ede3-cbc', keyLen: 24, ivLen: 8 };
    case OID.pbeSHA40RC2: return { cipher: 'rc2-40-cbc', keyLen: 5, ivLen: 8 };
    case OID.pbeSHA128RC2: return { cipher: 'rc2-cbc', keyLen: 16, ivLen: 8 };
    default:
      throw new UnsupportedFeatureError(`PKCS#12: unsupported PBES1 algorithm ${oid}`);
  }
}

function runDecipher(cipher: string, key: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  let d;
  try {
    d = createDecipheriv(cipher, key, iv);
  } catch (e) {
    throw new UnsupportedFeatureError(`PKCS#12: cipher ${cipher} unavailable in this runtime`);
  }
  try {
    return Buffer.concat([d.update(ciphertext), d.final()]);
  } catch {
    // Bad padding ⇒ wrong password (on files without a MAC to catch it earlier).
    throw new InvalidPasswordError('PKCS#12: wrong passphrase');
  }
}

// --- MAC ---------------------------------------------------------------------
/** Verify the PKCS#12 MAC over the AuthenticatedSafe; throw on mismatch. */
function verifyMac(macData: Asn1Node, authSafeContent: Buffer, pw: string): void {
  const digestInfo = macData.children[0];
  const macHashOid = readOid(digestInfo.children[0].children[0]);
  const hash = DIGEST_HASH[macHashOid];
  if (!hash) throw new UnsupportedFeatureError(`PKCS#12: unsupported MAC digest ${macHashOid}`);
  const expected = Buffer.from(digestInfo.children[1].content);
  const macSalt = Buffer.from(macData.children[1].content);
  const iter = macData.children.length > 2 ? Number(readInteger(macData.children[2])) : 1;
  const u = HASH_PARAMS[hash].u;

  for (const pwBmp of [bmpString(pw), ...(pw === '' ? [Buffer.alloc(0)] : [])]) {
    const key = pkcs12Kdf(pwBmp, macSalt, iter, 3, u, hash);
    const actual = createHmac(hash, key).update(authSafeContent).digest();
    if (actual.equals(expected)) return;
  }
  throw new InvalidPasswordError('PKCS#12: MAC verification failed (wrong passphrase)');
}

// --- structure walk ----------------------------------------------------------
/** Parse a PKCS#12 blob into its private key and certificate chain. */
export function parsePkcs12(data: Uint8Array, passphrase = ''): Pkcs12Result {
  let pfx: Asn1Node;
  try {
    pfx = parse(data);
  } catch (e) {
    throw new PdfParseError(`PKCS#12: not valid DER (${(e as Error).message})`);
  }
  if (pfx.tag !== 0x10 || pfx.children.length < 2)
    throw new PdfParseError('PKCS#12: expected a PFX SEQUENCE');

  const authSafeCI = pfx.children[1]; // ContentInfo (type data)
  if (readOid(authSafeCI.children[0]) !== OID.data)
    throw new UnsupportedFeatureError('PKCS#12: only password-integrity mode is supported');
  // [0] EXPLICIT OCTET STRING whose content is the AuthenticatedSafe DER.
  const authSafeOctet = authSafeCI.children[1].children[0];
  const authSafeContent = Buffer.from(authSafeOctet.content);

  if (pfx.children.length > 2) verifyMac(pfx.children[2], authSafeContent, passphrase);

  const authSafe = parse(authSafeOctet.content);
  const certs: Uint8Array[] = [];
  const keys: Uint8Array[] = []; // PKCS#8 DER
  for (const ci of authSafe.children) {
    const safeContents = unwrapContentInfo(ci, passphrase);
    collectBags(parse(safeContents), certs, keys, passphrase);
  }

  if (keys.length === 0) throw new PdfParseError('PKCS#12: no private key found');
  const privateKey = createPrivateKey({ key: Buffer.from(keys[0]), format: 'der', type: 'pkcs8' });
  orderLeafFirst(certs, privateKey);
  return { privateKey, certificates: certs };
}

/** Resolve a ContentInfo to its plaintext SafeContents DER (decrypting if needed). */
function unwrapContentInfo(ci: Asn1Node, pw: string): Uint8Array {
  const type = readOid(ci.children[0]);
  if (type === OID.data) {
    // content [0] EXPLICIT OCTET STRING -> SafeContents
    return ci.children[1].children[0].content;
  }
  if (type === OID.encryptedData) {
    const encryptedData = ci.children[1].children[0]; // EncryptedData SEQUENCE
    const eci = encryptedData.children[1];            // encryptedContentInfo
    const algId = eci.children[1];                    // contentEncryptionAlgorithm
    const encContent = eci.children[2];               // [0] IMPLICIT OCTET STRING
    return decrypt(algId, Buffer.from(encContent.content), pw);
  }
  throw new UnsupportedFeatureError(`PKCS#12: unsupported ContentInfo type ${type}`);
}

function collectBags(safeContents: Asn1Node, certs: Uint8Array[], keys: Uint8Array[], pw: string): void {
  for (const bag of safeContents.children) {
    const bagId = readOid(bag.children[0]);
    const bagValue = bag.children[1].children[0]; // [0] EXPLICIT value
    if (bagId === OID.certBag) {
      // CertBag ::= SEQUENCE { certId OID, certValue [0] EXPLICIT OCTET STRING }
      if (readOid(bagValue.children[0]) === OID.x509Certificate)
        certs.push(bagValue.children[1].children[0].content);
    } else if (bagId === OID.keyBag) {
      keys.push(bagValue.raw); // plaintext PrivateKeyInfo (PKCS#8)
    } else if (bagId === OID.pkcs8ShroudedKeyBag) {
      // EncryptedPrivateKeyInfo ::= SEQUENCE { encryptionAlgorithm, encryptedData OCTET STRING }
      const algId = bagValue.children[0];
      const ct = Buffer.from(bagValue.children[1].content);
      keys.push(decrypt(algId, ct, pw));
    }
  }
}

/** Move the certificate whose public key matches `privateKey` to the front. */
function orderLeafFirst(certs: Uint8Array[], privateKey: KeyObject): void {
  let pub: Buffer;
  try {
    pub = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  } catch { return; }
  const idx = certs.findIndex((c) => {
    try { return certSpki(c).equals(pub); } catch { return false; }
  });
  if (idx > 0) { const [leaf] = certs.splice(idx, 1); certs.unshift(leaf); }
}

/** Extract a certificate's subjectPublicKeyInfo (DER) for key matching. */
function certSpki(certDer: Uint8Array): Buffer {
  const tbs = parse(certDer).children[0];
  let i = 0;
  if (tbs.children[0].tagClass === 2) i = 1; // skip explicit [0] version
  return Buffer.from(tbs.children[i + 5].raw); // serial, sigAlg, issuer, validity, subject, SPKI
}
