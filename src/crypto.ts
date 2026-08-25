import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { PdfObject, PdfDict, isDict, isStream, isString, isArray, isName } from './types.js';
import { InvalidPasswordError, UnsupportedFeatureError } from './errors.js';

export const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
export const sha1 = (b: Uint8Array) => new Uint8Array(createHash('sha1').update(b).digest());
export const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
export const sha384 = (b: Uint8Array) => new Uint8Array(createHash('sha384').update(b).digest());
export const sha512 = (b: Uint8Array) => new Uint8Array(createHash('sha512').update(b).digest());

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** RC4 stream cipher. Symmetric: the same call encrypts and decrypts. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const t = s[a]; s[a] = s[b]; s[b] = t;
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

/** Decrypt PDF AES-CBC data: first 16 bytes are the IV, rest is ciphertext with
 *  PKCS#7 padding. Key length selects AES-128 vs AES-256. Sub-block input -> []. */
export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0); // need IV + >=1 padded block
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const d = createDecipheriv(algo, key, iv);
  d.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
}

/** AES-CBC decrypt with an explicit IV and NO padding (for /UE, /OE). */
export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const d = createDecipheriv(algo, key, iv);
  d.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
}

/** AES-128-CBC encrypt with explicit IV and NO padding (used by the R6 hash). */
export function aesCbc128Encrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

/** The 32-byte password padding string (PDF spec, Algorithm 2 step a). */
export const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

/** Pad/truncate a password to exactly 32 bytes per Algorithm 2 step a. */
export function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(pw.length, 32);
  out.set(pw.subarray(0, n), 0);
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n);
  return out;
}

/** Algorithm 2: compute the file encryption key for R2-R4.
 *  `length` is the key length in bits; returns length/8 bytes. */
export function fileKeyR234(
  pw: Uint8Array, O: Uint8Array, P: number, id0: Uint8Array,
  R: number, length: number, encryptMetadata: boolean,
): Uint8Array {
  const n = length / 8;
  const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >>> 24) & 0xff]);
  const meta = (R >= 4 && !encryptMetadata) ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0);
  let h = md5(concat(padPassword(pw), O.subarray(0, 32), pLE, id0, meta));
  if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

/** Algorithm 1: per-object key for V<=4. `isAes` appends the "sAlT" bytes. */
export function objectKeyV4(fileKey: Uint8Array, num: number, gen: number, isAes: boolean): Uint8Array {
  const ext = concat(
    fileKey,
    new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
    isAes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0),
  );
  return md5(ext).subarray(0, Math.min(fileKey.length + 5, 16));
}

type Cipher = 'rc4' | 'aes128' | 'aes256' | 'identity';
type Resolve = (o: PdfObject | undefined) => PdfObject;

export interface Decryptor {
  decryptObject(obj: PdfObject, num: number, gen: number): PdfObject;
}

const asNum = (o: PdfObject | undefined): number | undefined => (typeof o === 'number' ? o : undefined);
const asName = (o: PdfObject | undefined): string | undefined => (isName(o) ? o.name : undefined);
const asBytes = (o: PdfObject | undefined): Uint8Array | undefined => (isString(o) ? o.bytes : undefined);

/** Map a crypt-filter /CFM name to our cipher tag. */
function cfmToCipher(cfm: string | undefined): Cipher {
  switch (cfm) {
    case 'V2': return 'rc4';
    case 'AESV2': return 'aes128';
    case 'AESV3': return 'aes256';
    case 'Identity': case undefined: return 'identity';
    default: throw new UnsupportedFeatureError(`unsupported crypt filter /CFM ${cfm}`);
  }
}

/** Resolve /StmF or /StrF (a filter name) to a cipher via /CF. */
function filterCipher(cf: PdfObject, filterName: string | undefined, resolve: Resolve): Cipher {
  if (filterName === undefined || filterName === 'Identity') return 'identity';
  const cfDict = resolve(cf);
  if (!isDict(cfDict)) return 'identity';
  const entry = resolve(cfDict.get(filterName));
  if (!isDict(entry)) return 'identity';
  return cfmToCipher(asName(entry.get('CFM')));
}

/** Algorithm 6 (R2/R3+): validate the user password by recomputing /U. */
function validateUserR234(fileKey: Uint8Array, U: Uint8Array, id0: Uint8Array, R: number): boolean {
  if (R === 2) {
    const u = rc4(fileKey, PASSWORD_PADDING);
    return u.every((b, i) => b === U[i]);
  }
  const h = md5(concat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  for (let i = 0; i < 16; i++) if (data[i] !== U[i]) return false; // trailing 16 are arbitrary
  return true;
}

/**
 * Build a Decryptor from a resolved /Encrypt dict, the first /ID element, and a
 * password. Returns undefined when nothing needs decrypting. Throws
 * UnsupportedFeatureError for non-standard handlers and InvalidPasswordError on
 * a password that validates against neither /U nor /O.
 */
export function buildDecryptor(
  encrypt: PdfDict, id0: Uint8Array | undefined, password: string, resolve: Resolve,
): Decryptor | undefined {
  const filter = asName(resolve(encrypt.get('Filter')));
  if (filter !== 'Standard') throw new UnsupportedFeatureError(`unsupported security handler: ${filter}`);

  const V = asNum(resolve(encrypt.get('V'))) ?? 0;
  const R = asNum(resolve(encrypt.get('R'))) ?? 0;
  const length = asNum(resolve(encrypt.get('Length'))) ?? 40;
  const P = asNum(resolve(encrypt.get('P'))) ?? 0;
  const O = asBytes(resolve(encrypt.get('O'))) ?? new Uint8Array(0);
  const U = asBytes(resolve(encrypt.get('U'))) ?? new Uint8Array(0);
  const encryptMetadata = resolve(encrypt.get('EncryptMetadata')) !== false;
  const pw = new TextEncoder().encode(password);
  const id = id0 ?? new Uint8Array(0);

  // crypt-filter selection
  let streamCipher: Cipher;
  let stringCipher: Cipher;
  if (V >= 4) {
    const cf = encrypt.get('CF') ?? null;
    streamCipher = filterCipher(cf, asName(resolve(encrypt.get('StmF'))), resolve);
    stringCipher = filterCipher(cf, asName(resolve(encrypt.get('StrF'))), resolve);
  } else {
    streamCipher = 'rc4';
    stringCipher = 'rc4';
  }
  if (streamCipher === 'identity' && stringCipher === 'identity') return undefined;

  // file key + password validation
  let fileKey: Uint8Array;
  if (R <= 4) {
    fileKey = fileKeyR234(pw, O, P, id, R, length, encryptMetadata);
    if (!validateUserR234(fileKey, U, id, R)) throw new InvalidPasswordError();
  } else {
    fileKey = fileKeyR56(pw, encrypt, resolve, R);
  }

  const applyCipher = (cipher: Cipher, data: Uint8Array, num: number, gen: number): Uint8Array => {
    switch (cipher) {
      case 'identity': return data;
      case 'rc4': return rc4(objectKeyV4(fileKey, num, gen, false), data);
      case 'aes128': return aesCbcDecrypt(objectKeyV4(fileKey, num, gen, true), data);
      case 'aes256': return aesCbcDecrypt(fileKey, data);
    }
  };

  const decryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return { kind: 'string', bytes: applyCipher(stringCipher, obj.bytes, num, gen) };
    if (isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = decryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) { for (const [k, v] of obj) obj.set(k, decryptObject(v, num, gen)); return obj; }
    if (isStream(obj)) {
      for (const [k, v] of obj.dict) obj.dict.set(k, decryptObject(v, num, gen));
      return { kind: 'stream', dict: obj.dict, raw: applyCipher(streamCipher, obj.raw, num, gen) };
    }
    return obj;
  };

  return { decryptObject };
}

/** Algorithm 2.B: the R6 hardened hash. `udata` is empty for the user-key path
 *  and the 48-byte /U for the owner-key path. */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let K = sha256(concat(password, salt, udata));
  for (let round = 0; ; round++) {
    const block = concat(password, K, udata);
    const K1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) K1.set(block, i * block.length);
    const E = aesCbc128Encrypt(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0; for (let i = 0; i < 16; i++) mod += E[i]; mod %= 3;
    K = mod === 0 ? sha256(E) : mod === 1 ? sha384(E) : sha512(E);
    if (round >= 63 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}

/** Cryptographically strong random bytes. */
export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

/** AES-CBC encrypt: a random 16-byte IV is prepended; PKCS#7 padding. Key length
 *  (16 or 32) selects AES-128 vs AES-256. Inverse of aesCbcDecrypt. */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(16);
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = createCipheriv(algo, key, iv);
  c.setAutoPadding(true);
  const body = new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
  return concat(iv, body);
}

/** AES-CBC encrypt with an explicit IV and NO padding (for /UE, /OE). */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = createCipheriv(algo, key, iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

/** AES-256-ECB encrypt, no padding, no IV (for the 16-byte /Perms block). */
export function aes256EcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

/** Algorithm 2.A (R5/R6): recover the file key from /U,/UE (user) or /O,/OE
 *  (owner). R6 uses the hardened hash; R5 uses plain SHA-256. */
function fileKeyR56(pw: Uint8Array, encrypt: PdfDict, resolve: Resolve, R: number): Uint8Array {
  const U = asBytes(resolve(encrypt.get('U'))) ?? new Uint8Array(0);
  const UE = asBytes(resolve(encrypt.get('UE'))) ?? new Uint8Array(0);
  const O = asBytes(resolve(encrypt.get('O'))) ?? new Uint8Array(0);
  const OE = asBytes(resolve(encrypt.get('OE'))) ?? new Uint8Array(0);
  const empty = new Uint8Array(0);
  const eq = (a: Uint8Array, b: Uint8Array, n: number) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };

  // user path: salts in U[32..40] (validation), U[40..48] (key)
  const hashU = R === 6 ? hash2B(pw, U.subarray(32, 40), empty) : sha256(concat(pw, U.subarray(32, 40)));
  if (eq(hashU, U, 32)) {
    const ik = R === 6 ? hash2B(pw, U.subarray(40, 48), empty) : sha256(concat(pw, U.subarray(40, 48)));
    return aesCbcDecryptNoPad(ik, new Uint8Array(16), UE);
  }
  // owner path: salts in O, udata = U[0..48]
  const u48 = U.subarray(0, 48);
  const hashO = R === 6 ? hash2B(pw, O.subarray(32, 40), u48) : sha256(concat(pw, O.subarray(32, 40), u48));
  if (eq(hashO, O, 32)) {
    const ik = R === 6 ? hash2B(pw, O.subarray(40, 48), u48) : sha256(concat(pw, O.subarray(40, 48), u48));
    return aesCbcDecryptNoPad(ik, new Uint8Array(16), OE);
  }
  throw new InvalidPasswordError();
}
