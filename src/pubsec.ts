// PDF public-key ("PubSec") security handler: certificate-based encryption on
// Save and decryption on Open, the write/read counterpart to the standard
// password handler. A 20-byte seed + 4-byte permission int is enveloped to the
// recipient certificates via CMS EnvelopedData (cms.ts); the file key is derived
// by hashing seed ‖ recipient-blobs, after which the per-object ciphers are
// identical to the standard handler (crypto.ts). Zero runtime dependencies.

import { X509Certificate, KeyObject } from 'node:crypto';
import { PdfDict, PdfObject, name, isDict, isName, isString, isArray, isStream } from './types.js';
import {
  sha1, sha256, objectKeyV4, rc4, aesCbcEncrypt, aesCbcDecrypt, randomBytes, Decryptor, Cipher, CryptKeys, isSignatureDict,
} from './crypto.js';
import {
  Encryptor, makeEncryptor, permissionsToP, permissionsFromP,
  PubSecEncryptOptions, Permissions,
} from './encrypt.js';
import { buildEnvelopedData, openEnvelopedData } from './cms.js';
import { InvalidPasswordError, UnsupportedFeatureError } from './errors.js';

const FF4 = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Derive the file encryption key: HASH(seed ‖ each recipient blob ‖ 0xFFFFFFFF
 *  when metadata is not encrypted), truncated to `keyLen` bytes. */
export function deriveFileKey(
  seed: Uint8Array, recipientBlobs: Uint8Array[], hash: 'sha1' | 'sha256',
  keyLen: number, encryptMetadata: boolean,
): Uint8Array {
  const parts = [seed, ...recipientBlobs];
  if (!encryptMetadata) parts.push(FF4);
  const digest = hash === 'sha256' ? sha256(concat(...parts)) : sha1(concat(...parts));
  return digest.subarray(0, keyLen);
}

const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
const asNum = (o: PdfObject | undefined): number | undefined => (typeof o === 'number' ? o : undefined);
const asName = (o: PdfObject | undefined): string | undefined => (isName(o) ? o.name : undefined);

interface Profile {
  V: number; R: number; length: number; cfm: string;
  hash: 'sha1' | 'sha256'; isAes: boolean; isV5: boolean; subFilter: string;
}
const PROFILES: Record<'rc4' | 'aes128' | 'aes256', Profile> = {
  rc4:    { V: 4, R: 4, length: 128, cfm: 'V2',    hash: 'sha1',   isAes: false, isV5: false, subFilter: 'adbe.pkcs7.s4' },
  aes128: { V: 4, R: 4, length: 128, cfm: 'AESV2', hash: 'sha1',   isAes: true,  isV5: false, subFilter: 'adbe.pkcs7.s4' },
  aes256: { V: 5, R: 6, length: 256, cfm: 'AESV3', hash: 'sha256', isAes: true,  isV5: true,  subFilter: 'adbe.pkcs7.s5' },
};

/** Normalize a certificate (PEM string or DER) to DER via node's parser. */
function toCertDer(cert: string | Uint8Array): Uint8Array {
  return new Uint8Array(new X509Certificate(
    typeof cert === 'string' ? cert : Buffer.from(cert)).raw);
}

export function buildPubSecEncryptor(opts: PubSecEncryptOptions): Encryptor {
  const algorithm = opts.algorithm ?? 'aes256';
  const p = PROFILES[algorithm];
  if (!p) throw new TypeError(`unknown PubSec algorithm: ${algorithm}`);
  const encryptMetadata = opts.encryptMetadata !== false;

  // One shared 20-byte seed for the whole document (ISO 32000-1 §7.6.4.2).
  const seed = randomBytes(20);

  // Group recipients by resolved permission set; one CMS envelope per group, in
  // first-appearance order (which fixes the /Recipients array order — the file
  // key hashes every blob, so the order must be reproducible on read).
  const groups = new Map<number, Uint8Array[]>();
  for (const r of opts.recipients) {
    const P = permissionsToP(r.permissions ?? opts.permissions);
    const cert = toCertDer(r.certificate);
    const list = groups.get(P);
    if (list) list.push(cert); else groups.set(P, [cert]);
  }

  const envOpts = { keyWrap: opts.keyWrap, oaepHash: opts.oaepHash };
  const blobs: Uint8Array[] = [];
  for (const [P, certs] of groups) {
    // 24-byte payload: seed(20) ‖ P(4, big-endian).
    const payload = new Uint8Array(24);
    payload.set(seed, 0);
    payload[20] = (P >>> 24) & 0xff; payload[21] = (P >>> 16) & 0xff;
    payload[22] = (P >>> 8) & 0xff;  payload[23] = P & 0xff;
    blobs.push(buildEnvelopedData(certs, payload, envOpts));
  }
  const fileKey = deriveFileKey(seed, blobs, p.hash, p.length / 8, encryptMetadata);

  const cryptFilter: PdfDict = new Map<string, PdfObject>([
    ['CFM', name(p.cfm)],
    ['Length', p.length / 8],
    ['AuthEvent', name('DocOpen')],
    ['Recipients', blobs.map(pdfStr)],
  ]);
  if (!encryptMetadata) cryptFilter.set('EncryptMetadata', false);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Adobe.PubSec')],
    ['SubFilter', name(p.subFilter)],
    ['V', p.V], ['R', p.R], ['Length', p.length],
    ['CF', new Map<string, PdfObject>([['DefaultCryptFilter', cryptFilter]])],
    ['StmF', name('DefaultCryptFilter')], ['StrF', name('DefaultCryptFilter')],
  ]);
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher = (data: Uint8Array, num: number, gen: number): Uint8Array => {
    if (p.isV5) return aesCbcEncrypt(fileKey, data);
    const key = objectKeyV4(fileKey, num, gen, p.isAes);
    return p.isAes ? aesCbcEncrypt(key, data) : rc4(key, data);
  };
  return makeEncryptor(dict, cipher, cipher);
}

export interface NormalizedRecipient {
  privateKey: KeyObject;
  certificate: string | Uint8Array;
}

export function buildPubSecDecryptor(
  encrypt: PdfDict, recipient: NormalizedRecipient,
  resolve: (o: PdfObject | undefined) => PdfObject,
): { decryptObject: Decryptor['decryptObject']; permissions: Permissions; keys: CryptKeys } {
  const V = asNum(resolve(encrypt.get('V'))) ?? 4;
  const length = asNum(resolve(encrypt.get('Length'))) ?? 128;
  const isV5 = V >= 5;
  const hash: 'sha1' | 'sha256' = isV5 ? 'sha256' : 'sha1';
  const certDer = toCertDer(recipient.certificate);

  // Locate the crypt filter (V>=4: /CF /DefaultCryptFilter) and its /Recipients.
  const cf = resolve(encrypt.get('CF'));
  const stmf = asName(resolve(encrypt.get('StmF'))) ?? 'DefaultCryptFilter';
  const cfDict = isDict(cf) ? resolve(cf.get(stmf)) : null;
  if (!isDict(cfDict)) throw new UnsupportedFeatureError('PubSec: missing crypt filter');
  const cfm = asName(resolve(cfDict.get('CFM')));
  const isAes = cfm === 'AESV2' || cfm === 'AESV3';
  const encryptMetadata = resolve(cfDict.get('EncryptMetadata')) !== false
    && resolve(encrypt.get('EncryptMetadata')) !== false;

  const recipientsArr = resolve(cfDict.get('Recipients'));
  const blobs: Uint8Array[] = [];
  if (isArray(recipientsArr)) {
    for (const el of recipientsArr) { const s = resolve(el); if (isString(s)) blobs.push(s.bytes); }
  } else if (isString(recipientsArr)) {
    blobs.push(recipientsArr.bytes);
  }
  if (blobs.length === 0) throw new UnsupportedFeatureError('PubSec: no /Recipients');

  // Recover the 24-byte payload from the first envelope our key can open.
  let payload: Uint8Array | undefined;
  for (const blob of blobs) {
    payload = openEnvelopedData(blob, recipient.privateKey, certDer);
    if (payload) break;
  }
  if (!payload || payload.length < 24) throw new InvalidPasswordError();

  const seed = payload.subarray(0, 20);
  const P = ((payload[20] << 24) | (payload[21] << 16) | (payload[22] << 8) | payload[23]) | 0;
  const fileKey = deriveFileKey(seed, blobs, hash, length / 8, encryptMetadata);

  const applyCipher = (data: Uint8Array, num: number, gen: number): Uint8Array => {
    if (isV5) return aesCbcDecrypt(fileKey, data);
    const key = objectKeyV4(fileKey, num, gen, isAes);
    return isAes ? aesCbcDecrypt(key, data) : rc4(key, data);
  };

  const decryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return { kind: 'string', bytes: applyCipher(obj.bytes, num, gen) };
    if (isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = decryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) {
      // A signature dict's /Contents is exempt (32000-1 7.6.2).
      const skip = isSignatureDict(obj) ? 'Contents' : undefined;
      for (const [k, v] of obj) if (k !== skip) obj.set(k, decryptObject(v, num, gen));
      return obj;
    }
    if (isStream(obj)) {
      for (const [k, v] of obj.dict) obj.dict.set(k, decryptObject(v, num, gen));
      return { kind: 'stream', dict: obj.dict, raw: applyCipher(obj.raw, num, gen) };
    }
    return obj;
  };

  // PubSec applies ONE cipher to strings and streams alike, so both slots
  // carry the same value — unlike the standard handler, which selects /StmF
  // and /StrF independently.
  const cipher: Cipher = isV5 ? 'aes256' : isAes ? 'aes128' : 'rc4';
  return {
    decryptObject,
    permissions: permissionsFromP(P),
    keys: { fileKey, streamCipher: cipher, stringCipher: cipher },
  };
}
