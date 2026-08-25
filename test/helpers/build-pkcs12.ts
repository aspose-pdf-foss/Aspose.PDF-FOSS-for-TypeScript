// Builds a real, spec-conformant PKCS#12 (.p12) blob at test time so the
// parser is exercised against independently-encoded fixtures — no checked-in
// secrets. Uses PBES2 (PBKDF2-HMAC-SHA256 + AES-256-CBC) for the bags and the
// classic PKCS#12 KDF (RFC 7292 B.2) for the HMAC-SHA256 MAC. The KDF here is a
// second, independent implementation of the one in src/pkcs12.ts: a fixture the
// parser verifies cross-checks both. node:crypto does the actual ciphers/PBKDF2.

import { createHash, createHmac, createCipheriv, pbkdf2Sync, randomBytes, KeyObject } from 'node:crypto';
import { der } from '../../src/asn1.js';
import { buildSigner } from './build-signer.js';

// OIDs (PKCS#7/PKCS#12/PKCS#5).
const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacWithSHA256: '1.2.840.113549.2.9',
  aes256CBC: '2.16.840.1.101.3.4.1.42',
  certBag: '1.2.840.113549.1.12.10.1.3',
  pkcs8ShroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  sha256: '2.16.840.1.101.3.4.2.1',
} as const;

// --- PKCS#12 KDF (RFC 7292 B.2), SHA-256: u=32, v=64. ------------------------
function bmp(pw: string): Buffer {
  const out = Buffer.alloc(pw.length * 2 + 2); // UTF-16BE + two-byte terminator
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

function pkcs12Kdf(pw: string, salt: Buffer, iter: number, id: number, n: number): Buffer {
  const u = 32, v = 64;
  const D = Buffer.alloc(v, id);
  let I = Buffer.concat([extend(salt, v), extend(bmp(pw), v)]);
  const chunks: Buffer[] = [];
  let generated = 0;
  while (generated < n) {
    let A = Buffer.concat([D, I]);
    for (let i = 0; i < iter; i++) A = createHash('sha256').update(A).digest();
    chunks.push(A); generated += u;
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

// --- DER helpers -------------------------------------------------------------
const u8 = (b: Buffer): Uint8Array => new Uint8Array(b);

function pbes2AlgId(salt: Buffer, iter: number, iv: Buffer): Uint8Array {
  return der.sequence(
    der.oid(OID.pbes2),
    der.sequence(
      der.sequence( // keyDerivationFunc: PBKDF2
        der.oid(OID.pbkdf2),
        der.sequence(
          der.octetString(u8(salt)),
          der.integer(iter),
          der.sequence(der.oid(OID.hmacWithSHA256), der.null_()), // prf
        ),
      ),
      der.sequence(der.oid(OID.aes256CBC), der.octetString(u8(iv))), // encryptionScheme
    ),
  );
}

/** PBES2-encrypt `plain` with the password; returns { algId, ciphertext }. */
function pbes2Encrypt(plain: Buffer, pw: string): { algId: Uint8Array; ct: Buffer } {
  const salt = randomBytes(16), iv = randomBytes(16), iter = 2048;
  const key = pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, iter, 32, 'sha256');
  const c = createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { algId: pbes2AlgId(salt, iter, iv), ct };
}

function certBag(certDer: Uint8Array): Uint8Array {
  const cb = der.sequence(der.oid(OID.x509Certificate), der.explicit(0, der.octetString(certDer)));
  return der.sequence(der.oid(OID.certBag), der.explicit(0, cb));
}

export interface BuiltPkcs12 {
  p12: Uint8Array;
  certificate: Uint8Array; // DER of the leaf cert that matches the private key
  privateKey: KeyObject;
}

export interface BuildPkcs12Options {
  passphrase?: string;
  extraCerts?: number; // additional (intermediate) certs to embed
}

export function buildPkcs12(opts: BuildPkcs12Options = {}): BuiltPkcs12 {
  const pw = opts.passphrase ?? '';
  const signer = buildSigner({ type: 'rsa', commonName: 'P12 Test' });
  const certs = [signer.certificate];
  for (let i = 0; i < (opts.extraCerts ?? 0); i++) {
    certs.push(buildSigner({ type: 'rsa', commonName: `Intermediate ${i}` }).certificate);
  }

  // certs ContentInfo: encryptedData (PBES2) wrapping SafeContents of certBags.
  const certSafeContents = der.sequence(...certs.map(certBag));
  const certEnc = pbes2Encrypt(Buffer.from(certSafeContents), pw);
  const encryptedContent = (() => { // [0] IMPLICIT OCTET STRING
    const o = der.octetString(u8(certEnc.ct)); o[0] = 0x80; return o;
  })();
  const encryptedData = der.sequence(
    der.integer(0),
    der.sequence(der.oid(OID.data), certEnc.algId, encryptedContent),
  );
  const certCI = der.sequence(OID_DATA_ENC(), der.explicit(0, encryptedData));

  // key ContentInfo: data wrapping SafeContents with a pkcs8ShroudedKeyBag.
  const pkcs8 = new Uint8Array(signer.privateKey.export({ format: 'der', type: 'pkcs8' }));
  const keyEnc = pbes2Encrypt(Buffer.from(pkcs8), pw);
  const epki = der.sequence(keyEnc.algId, der.octetString(u8(keyEnc.ct))); // EncryptedPrivateKeyInfo
  const keyBag = der.sequence(der.oid(OID.pkcs8ShroudedKeyBag), der.explicit(0, epki));
  const keySafeContents = der.sequence(keyBag);
  const keyCI = der.sequence(der.oid(OID.data), der.explicit(0, der.octetString(keySafeContents)));

  const authSafe = der.sequence(certCI, keyCI);

  // MAC over the AuthenticatedSafe bytes: PKCS#12 KDF (id=3) -> HMAC-SHA256.
  const macSalt = randomBytes(8), macIter = 2048;
  const macKey = pkcs12Kdf(pw, macSalt, macIter, 3, 32);
  const macValue = createHmac('sha256', macKey).update(authSafe).digest();
  const macData = der.sequence(
    der.sequence(der.sequence(der.oid(OID.sha256), der.null_()), der.octetString(u8(macValue))),
    der.octetString(u8(macSalt)),
    der.integer(macIter),
  );

  const pfx = der.sequence(
    der.integer(3),
    der.sequence(der.oid(OID.data), der.explicit(0, der.octetString(authSafe))),
    macData,
  );
  return { p12: pfx, certificate: signer.certificate, privateKey: signer.privateKey };
}

// pkcs7-data OID used as the encryptedData ContentInfo's outer type.
function OID_DATA_ENC(): Uint8Array { return der.oid(OID.encryptedData); }
