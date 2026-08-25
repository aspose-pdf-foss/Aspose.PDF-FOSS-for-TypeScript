// Generates signer credentials for digital-signature tests: an RSA / EC /
// Ed25519 keypair plus a self-signed X.509 certificate, assembled with the
// library's own DER encoder. No checked-in secrets — minted at test time.

import { generateKeyPairSync, sign as cryptoSign, KeyObject } from 'node:crypto';
import { der } from '../../src/asn1.js';

export interface TestSigner {
  privateKey: KeyObject;
  publicKey: KeyObject;
  certificate: Uint8Array; // DER
  commonName: string;
}

export interface SignerOptions {
  type?: 'rsa' | 'ec' | 'ed25519';
  namedCurve?: string;     // for type 'ec' (default P-256)
  commonName?: string;
}

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const ECDSA_WITH = { sha256: '1.2.840.10045.4.3.2', sha384: '1.2.840.10045.4.3.3', sha512: '1.2.840.10045.4.3.4' };
const ED25519 = '1.3.101.112';
const CN = '2.5.4.3';

function algId(oid: string, withNull: boolean): Uint8Array {
  return withNull ? der.sequence(der.oid(oid), der.null_()) : der.sequence(der.oid(oid));
}

function name(commonName: string): Uint8Array {
  return der.sequence(der.set(der.sequence(der.oid(CN), der.utf8String(commonName))));
}

export function buildSigner(opts: SignerOptions = {}): TestSigner {
  const type = opts.type ?? 'rsa';
  const commonName = opts.commonName ?? 'Test Signer';

  let privateKey: KeyObject, publicKey: KeyObject, certAlgId: Uint8Array;
  let signTbs: (tbs: Uint8Array) => Buffer;

  if (type === 'rsa') {
    ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
    certAlgId = algId(SHA256_WITH_RSA, true);
    signTbs = (tbs) => cryptoSign('sha256', tbs, privateKey);
  } else if (type === 'ec') {
    const namedCurve = opts.namedCurve ?? 'P-256';
    ({ privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve }));
    const dg = namedCurve === 'P-384' ? 'sha384' : namedCurve === 'P-521' ? 'sha512' : 'sha256';
    certAlgId = algId(ECDSA_WITH[dg], false);
    signTbs = (tbs) => cryptoSign(dg, tbs, privateKey);
  } else {
    ({ privateKey, publicKey } = generateKeyPairSync('ed25519'));
    certAlgId = algId(ED25519, false);
    signTbs = (tbs) => cryptoSign(null, tbs, privateKey);
  }

  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  const notBefore = der.utcTime(new Date(Date.UTC(2020, 0, 1)));
  const notAfter = der.utcTime(new Date(Date.UTC(2049, 11, 31)));

  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),       // version v3
    der.integer(0x0123456789n),            // serialNumber
    certAlgId,                             // signature
    name(commonName),                      // issuer
    der.sequence(notBefore, notAfter),     // validity
    name(commonName),                      // subject (self-signed)
    spki,                                  // subjectPublicKeyInfo
  );

  const sig = new Uint8Array(signTbs(tbs));
  const certificate = der.sequence(tbs, certAlgId, der.bitString(sig));

  return { privateKey, publicKey, certificate, commonName };
}

export function buildRsaSigner(commonName = 'Test Signer'): TestSigner {
  return buildSigner({ type: 'rsa', commonName });
}

// --- CA-issued certificates (for chain-validation tests) -----------------

const BASIC_CONSTRAINTS = '2.5.29.19';
const KEY_USAGE = '2.5.29.15';
let nextSerial = 0x1000n;

export interface IssueOptions {
  type?: 'rsa' | 'ec';
  commonName?: string;
  /** Issuer that signs this certificate. Omit for a self-signed (root) cert. */
  issuer?: TestSigner;
  /** Mark as a CA (basicConstraints CA:TRUE + keyUsage keyCertSign). */
  ca?: boolean;
  /** Add keyUsage digitalSignature (typical for a leaf signer). */
  digitalSignature?: boolean;
  notBefore?: Date;
  notAfter?: Date;
}

/** A KeyUsage BIT STRING with the given bit indices set (digitalSignature=0 …). */
function keyUsageBits(bits: number[]): Uint8Array {
  const maxBit = Math.max(...bits);
  const arr = new Uint8Array((maxBit >> 3) + 1);
  for (const b of bits) arr[b >> 3] |= 0x80 >> (b & 7);
  return der.bitString(arr, arr.length * 8 - (maxBit + 1));
}

function extension(oid: string, critical: boolean, value: Uint8Array): Uint8Array {
  const parts = [der.oid(oid)];
  if (critical) parts.push(der.boolean(true));
  parts.push(der.octetString(value));
  return der.sequence(...parts);
}

function extensions(opts: IssueOptions): Uint8Array | undefined {
  const exts: Uint8Array[] = [];
  if (opts.ca) {
    exts.push(extension(BASIC_CONSTRAINTS, true, der.sequence(der.boolean(true))));
    exts.push(extension(KEY_USAGE, true, keyUsageBits([5]))); // keyCertSign
  } else if (opts.digitalSignature) {
    exts.push(extension(KEY_USAGE, false, keyUsageBits([0]))); // digitalSignature
  }
  return exts.length ? der.explicit(3, der.sequence(...exts)) : undefined;
}

/** Issue an X.509 certificate signed by `opts.issuer` (or self-signed when
 *  omitted), optionally a CA, with validity and key-usage extensions. */
export function issueCert(opts: IssueOptions = {}): TestSigner {
  const type = opts.type ?? 'rsa';
  const commonName = opts.commonName ?? 'Test Cert';
  const { privateKey, publicKey } = type === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const signKey = opts.issuer ? opts.issuer.privateKey : privateKey;
  const rsaSign = signKey.asymmetricKeyType === 'rsa';
  const certAlgId = algId(rsaSign ? SHA256_WITH_RSA : ECDSA_WITH.sha256, rsaSign);
  const issuerName = name(opts.issuer ? opts.issuer.commonName : commonName);

  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  const validity = der.sequence(
    der.utcTime(opts.notBefore ?? new Date(Date.UTC(2020, 0, 1))),
    der.utcTime(opts.notAfter ?? new Date(Date.UTC(2049, 11, 31))),
  );
  const ext = extensions(opts);
  const tbsParts = [
    der.explicit(0, der.integer(2)),       // version v3
    der.integer(nextSerial++),             // serialNumber (unique per cert)
    certAlgId,
    issuerName,
    validity,
    name(commonName),
    spki,
  ];
  if (ext) tbsParts.push(ext);
  const tbs = der.sequence(...tbsParts);
  const sig = new Uint8Array(cryptoSign('sha256', tbs, signKey));
  const certificate = der.sequence(tbs, certAlgId, der.bitString(sig));
  return { privateKey, publicKey, certificate, commonName };
}
