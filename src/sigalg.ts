// Signature-algorithm mapping between CMS AlgorithmIdentifiers and node:crypto
// sign/verify primitives. Covers RSA PKCS#1 v1.5, RSA-PSS, ECDSA (P-256/384/521),
// and Ed25519 (experimental). Built on the asn1.ts DER layer.

import { sign as cryptoSign, verify as cryptoVerify, KeyObject, constants } from 'node:crypto';
import { der, OID } from './asn1.js';

export type SignatureScheme = 'rsa' | 'rsa-pss' | 'ecdsa' | 'ed25519';
export type DigestAlgorithm = 'sha256' | 'sha384' | 'sha512';

/** Signature algorithm passed to an external signer callback: the public-key
 *  scheme plus the message-digest algorithm to hash the data with. */
export interface SigAlg {
  scheme: SignatureScheme;
  digest: DigestAlgorithm;
}

const MGF1 = '1.2.840.113549.1.1.8';
const DIGEST_OID: Record<DigestAlgorithm, string> = { sha256: OID.sha256, sha384: OID.sha384, sha512: OID.sha512 };
const ECDSA_OID: Record<DigestAlgorithm, string> = {
  sha256: OID.ecdsaWithSHA256, sha384: OID.ecdsaWithSHA384, sha512: OID.ecdsaWithSHA512,
};
const SALT_LEN: Record<DigestAlgorithm, number> = { sha256: 32, sha384: 48, sha512: 64 };

/** Map a private/public key to its default signature scheme. */
export function detectScheme(key: KeyObject): SignatureScheme {
  switch (key.asymmetricKeyType) {
    case 'rsa': return 'rsa';
    case 'rsa-pss': return 'rsa-pss';
    case 'ec': return 'ecdsa';
    case 'ed25519': return 'ed25519';
    default: throw new Error(`sigalg: unsupported key type ${key.asymmetricKeyType}`);
  }
}

export function signData(data: Uint8Array, key: KeyObject, scheme: SignatureScheme, digest: DigestAlgorithm): Uint8Array {
  switch (scheme) {
    case 'rsa': return new Uint8Array(cryptoSign(digest, data, key));
    case 'ecdsa': return new Uint8Array(cryptoSign(digest, data, key));
    case 'rsa-pss': return new Uint8Array(cryptoSign(digest, data,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }));
    case 'ed25519': return new Uint8Array(cryptoSign(null, data, key));
  }
}

export function verifyData(data: Uint8Array, key: KeyObject, signature: Uint8Array, scheme: SignatureScheme, digest: DigestAlgorithm): boolean {
  try {
    switch (scheme) {
      case 'rsa': return cryptoVerify(digest, data, key, signature);
      case 'ecdsa': return cryptoVerify(digest, data, key, signature);
      case 'rsa-pss': return cryptoVerify(digest, data,
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      case 'ed25519': return cryptoVerify(null, data, key, signature);
    }
  } catch {
    return false; // malformed signature bytes
  }
}

function hashAlgId(digest: DigestAlgorithm): Uint8Array {
  return der.sequence(der.oid(DIGEST_OID[digest]), der.null_());
}

/** Build the CMS SignerInfo signatureAlgorithm AlgorithmIdentifier. */
export function signatureAlgorithmId(scheme: SignatureScheme, digest: DigestAlgorithm): Uint8Array {
  switch (scheme) {
    case 'rsa': return der.sequence(der.oid(OID.rsaEncryption), der.null_());
    case 'ecdsa': return der.sequence(der.oid(ECDSA_OID[digest]));
    case 'ed25519': return der.sequence(der.oid(OID.ed25519));
    case 'rsa-pss': {
      const params = der.sequence(
        der.explicit(0, hashAlgId(digest)),                                // hashAlgorithm
        der.explicit(1, der.sequence(der.oid(MGF1), hashAlgId(digest))),   // maskGenAlgorithm (MGF1)
        der.explicit(2, der.integer(SALT_LEN[digest])),                    // saltLength
      );
      return der.sequence(der.oid(OID.rsaPss), params);
    }
  }
}

/** Map a parsed signatureAlgorithm OID name back to its scheme. */
export function schemeFromSigAlg(oidNameOrDotted: string): SignatureScheme {
  if (oidNameOrDotted === 'rsaEncryption') return 'rsa';
  if (oidNameOrDotted === 'rsaPss') return 'rsa-pss';
  if (oidNameOrDotted.startsWith('ecdsaWithSHA')) return 'ecdsa';
  if (oidNameOrDotted === 'ed25519') return 'ed25519';
  throw new Error(`sigalg: unknown signature algorithm ${oidNameOrDotted}`);
}

// X.509 / CRL / OCSP signatureAlgorithm OIDs that bundle scheme + digest in a
// single identifier (unlike CMS, where the digest is a separate attribute).
const X509_SIG_ALG: Record<string, SigAlg> = {
  '1.2.840.113549.1.1.11': { scheme: 'rsa', digest: 'sha256' },     // sha256WithRSAEncryption
  '1.2.840.113549.1.1.12': { scheme: 'rsa', digest: 'sha384' },     // sha384WithRSAEncryption
  '1.2.840.113549.1.1.13': { scheme: 'rsa', digest: 'sha512' },     // sha512WithRSAEncryption
  '1.2.840.10045.4.3.2': { scheme: 'ecdsa', digest: 'sha256' },     // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3': { scheme: 'ecdsa', digest: 'sha384' },     // ecdsa-with-SHA384
  '1.2.840.10045.4.3.4': { scheme: 'ecdsa', digest: 'sha512' },     // ecdsa-with-SHA512
  '1.3.101.112': { scheme: 'ed25519', digest: 'sha512' },           // Ed25519 (digest unused)
};

/** Resolve a dotted X.509/CRL/OCSP signatureAlgorithm OID to a {@link SigAlg}
 *  (scheme + digest), or undefined if unrecognized. */
export function x509SigAlg(dottedOid: string): SigAlg | undefined {
  return X509_SIG_ALG[dottedOid];
}
