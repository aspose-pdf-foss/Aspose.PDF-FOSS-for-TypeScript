import { PdfDict, PdfObject, name, isString, isArray, isDict, isStream } from './types.js';
import {
  aesCbcEncrypt, aesCbcEncryptNoPad, aes256EcbEncrypt, randomBytes, hash2B,
  md5, rc4, padPassword, PASSWORD_PADDING, fileKeyR234, objectKeyV4, Cipher, CryptKeys, isSignatureDict,
} from './crypto.js';

export interface Permissions {
  printing?: boolean;
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  accessibility?: boolean;
  assembling?: boolean;
  highQualityPrinting?: boolean;
}

export interface EncryptOptions {
  userPassword?: string;
  ownerPassword?: string;
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  permissions?: Permissions;
  encryptMetadata?: boolean;
}

export interface Encryptor {
  readonly encryptDict: PdfDict;
  encryptObject(obj: PdfObject, num: number, gen: number): PdfObject;
  encryptStreamRaw(raw: Uint8Array, num: number, gen: number): Uint8Array;
}

const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
const EMPTY = new Uint8Array(0);
const ZERO16 = new Uint8Array(16);

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Signed-int32 /P from permission flags (each defaults to allowed). */
export function permissionsToP(p: Permissions = {}): number {
  let v = 0xfffff0c0; // reserved bits 7,8 and 13..32 set; 1,2 clear
  const on = (flag: boolean | undefined, bit: number) => { if (flag !== false) v |= bit; };
  on(p.printing, 0x04);
  on(p.modifying, 0x08);
  on(p.copying, 0x10);
  on(p.annotating, 0x20);
  on(p.fillingForms, 0x100);
  on(p.accessibility, 0x200);
  on(p.assembling, 0x400);
  on(p.highQualityPrinting, 0x800);
  return v | 0; // coerce to signed int32
}

/** Decode a signed-int32 /P back into permission flags (inverse of permissionsToP). */
export function permissionsFromP(P: number): Permissions {
  const on = (bit: number) => (P & bit) !== 0;
  return {
    printing: on(0x04),
    modifying: on(0x08),
    copying: on(0x10),
    annotating: on(0x20),
    fillingForms: on(0x100),
    accessibility: on(0x200),
    assembling: on(0x400),
    highQualityPrinting: on(0x800),
  };
}

type CipherFn = (data: Uint8Array, num: number, gen: number) => Uint8Array;

/** Wrap string/stream ciphers into an Encryptor that recurses like decryptObject. */
export function makeEncryptor(encryptDict: PdfDict, strCipher: CipherFn, stmCipher: CipherFn): Encryptor {
  const encryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return pdfStr(strCipher(obj.bytes, num, gen));
    if (isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = encryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) {
      // A signature dict's /Contents is exempt (32000-1 7.6.2).
      const skip = isSignatureDict(obj) ? 'Contents' : undefined;
      for (const [k, v] of obj) if (k !== skip) obj.set(k, encryptObject(v, num, gen));
      return obj;
    }
    if (isStream(obj)) {
      const d = obj.dict;
      for (const [k, v] of d) d.set(k, encryptObject(v, num, gen));
      return { kind: 'stream', dict: d, raw: stmCipher(obj.raw, num, gen) };
    }
    return obj;
  };
  return {
    encryptDict,
    encryptObject,
    encryptStreamRaw: (raw, num, gen) => stmCipher(raw, num, gen),
  };
}

function buildAes256(userPw: Uint8Array, ownerPw: Uint8Array, P: number, encryptMetadata: boolean): Encryptor {
  const fileKey = randomBytes(32);

  // Algorithm 8: /U, /UE
  const uVal = randomBytes(8), uKey = randomBytes(8);
  const U = concat(hash2B(userPw, uVal, EMPTY), uVal, uKey); // 48 bytes
  const UE = aesCbcEncryptNoPad(hash2B(userPw, uKey, EMPTY), ZERO16, fileKey);

  // Algorithm 9: /O, /OE (udata = the 48-byte U)
  const oVal = randomBytes(8), oKey = randomBytes(8);
  const O = concat(hash2B(ownerPw, oVal, U), oVal, oKey);
  const OE = aesCbcEncryptNoPad(hash2B(ownerPw, oKey, U), ZERO16, fileKey);

  // Algorithm 13: /Perms
  const perms = new Uint8Array(16);
  perms[0] = P & 0xff; perms[1] = (P >> 8) & 0xff; perms[2] = (P >> 16) & 0xff; perms[3] = (P >>> 24) & 0xff;
  perms[4] = perms[5] = perms[6] = perms[7] = 0xff;
  perms[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  perms[9] = 0x61; perms[10] = 0x64; perms[11] = 0x62; // 'a','d','b'
  perms.set(randomBytes(4), 12);
  const Perms = aes256EcbEncrypt(fileKey, perms);

  const stdcf: PdfDict = new Map<string, PdfObject>([
    ['CFM', name('AESV3')], ['Length', 32], ['AuthEvent', name('DocOpen')],
  ]);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Standard')], ['V', 5], ['R', 6], ['Length', 256], ['P', P],
    ['O', pdfStr(O)], ['U', pdfStr(U)], ['OE', pdfStr(OE)], ['UE', pdfStr(UE)], ['Perms', pdfStr(Perms)],
    ['CF', new Map<string, PdfObject>([['StdCF', stdcf]])],
    ['StmF', name('StdCF')], ['StrF', name('StdCF')],
  ]);
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher: CipherFn = (data) => aesCbcEncrypt(fileKey, data);
  return makeEncryptor(dict, cipher, cipher);
}

export function buildEncryptor(opts: EncryptOptions, id0: Uint8Array): Encryptor {
  const algorithm = opts.algorithm ?? 'aes256';
  if (algorithm !== 'aes256' && algorithm !== 'aes128' && algorithm !== 'rc4')
    throw new TypeError(`unknown encryption algorithm: ${algorithm}`);
  const enc = new TextEncoder();
  const userPw = enc.encode(opts.userPassword ?? '');
  const ownerPw = enc.encode(opts.ownerPassword ?? opts.userPassword ?? '');
  const P = permissionsToP(opts.permissions);
  const encryptMetadata = opts.encryptMetadata !== false;

  if (algorithm === 'aes256') return buildAes256(userPw, ownerPw, P, encryptMetadata);
  return buildR34(algorithm, userPw, ownerPw, P, id0, encryptMetadata);
}

/** Algorithm 3: compute /O (32 bytes) for R3/R4 (128-bit). */
function computeO(ownerPw: Uint8Array, userPw: Uint8Array, n: number): Uint8Array {
  let h = md5(padPassword(ownerPw.length ? ownerPw : userPw));
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n)); // R>=3
  const key = h.subarray(0, n);
  let data = rc4(key, padPassword(userPw));
  for (let i = 1; i <= 19; i++) data = rc4(key.map((b) => b ^ i), data);
  return data;
}

/** Algorithm 5: compute /U (32 bytes) for R3/R4. */
function computeU(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  const h = md5(concat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  const U = new Uint8Array(32);
  U.set(data.subarray(0, 16), 0);
  U.set(randomBytes(16), 16); // arbitrary trailing padding (reader checks first 16)
  return U;
}

function buildR34(
  algorithm: 'aes128' | 'rc4', userPw: Uint8Array, ownerPw: Uint8Array,
  P: number, id0: Uint8Array, encryptMetadata: boolean,
): Encryptor {
  const n = 16; // 128-bit
  const R = algorithm === 'rc4' ? 3 : 4;
  const V = algorithm === 'rc4' ? 2 : 4;
  const isAes = algorithm === 'aes128';

  const O = computeO(ownerPw, userPw, n);
  const fileKey = fileKeyR234(userPw, O, P, id0, R, 128, encryptMetadata);
  const U = computeU(fileKey, id0);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Standard')], ['V', V], ['R', R], ['Length', 128], ['P', P],
    ['O', pdfStr(O)], ['U', pdfStr(U)],
  ]);
  if (isAes) {
    const stdcf: PdfDict = new Map<string, PdfObject>([
      ['CFM', name('AESV2')], ['Length', 16], ['AuthEvent', name('DocOpen')],
    ]);
    dict.set('CF', new Map<string, PdfObject>([['StdCF', stdcf]]));
    dict.set('StmF', name('StdCF'));
    dict.set('StrF', name('StdCF'));
  }
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher: CipherFn = (data, num, gen) => {
    const key = objectKeyV4(fileKey, num, gen, isAes);
    return isAes ? aesCbcEncrypt(key, data) : rc4(key, data);
  };
  return makeEncryptor(dict, cipher, cipher);
}

export interface PubSecRecipientCert {
  /** Recipient certificate, DER (Uint8Array) or PEM (string). */
  certificate: string | Uint8Array;
  /** Permissions for this recipient; falls back to the document `permissions`.
   *  Recipients sharing one permission set are grouped into one CMS envelope. */
  permissions?: Permissions;
}

export interface PubSecEncryptOptions {
  recipients: PubSecRecipientCert[];
  /** Document cipher. Default 'aes256'. (Envelope encryption is always AES-128.) */
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  /** Default permissions for recipients without their own. */
  permissions?: Permissions;
  /** RSA key-transport padding for RSA recipients. Default 'pkcs1'. */
  keyWrap?: 'pkcs1' | 'oaep';
  /** OAEP hash when keyWrap is 'oaep'. Default 'sha256'. */
  oaepHash?: 'sha1' | 'sha256';
  /** Encrypt the document metadata stream. Default true. */
  encryptMetadata?: boolean;
}

/** An Encryptor that reuses a document's OWN key and `/Encrypt` dict.
 *
 *  This is the mirror of `buildDecryptor`'s `applyCipher`: RC4 is symmetric,
 *  AES swaps decrypt for encrypt, identity passes through. It exists because
 *  encryption CANNOT be re-derived from what an opened document retains — the
 *  owner password is hashed into `/O` and unrecoverable, and `buildEncryptor`
 *  defaults `ownerPassword ?? userPassword`, so re-deriving would silently
 *  equate them. The dict is carried VERBATIM for the same reason: `/O /U /P`
 *  are statements about credentials we do not hold. */
export function buildEncryptorFromKeys(keys: CryptKeys, encryptDict: PdfDict): Encryptor {
  const apply = (cipher: Cipher): CipherFn => {
    switch (cipher) {
      case 'identity': return (data) => data;
      case 'rc4': return (data, num, gen) => rc4(objectKeyV4(keys.fileKey, num, gen, false), data);
      case 'aes128': return (data, num, gen) => aesCbcEncrypt(objectKeyV4(keys.fileKey, num, gen, true), data);
      case 'aes256': return (data) => aesCbcEncrypt(keys.fileKey, data);
    }
  };
  return makeEncryptor(encryptDict, apply(keys.stringCipher), apply(keys.streamCipher));
}
