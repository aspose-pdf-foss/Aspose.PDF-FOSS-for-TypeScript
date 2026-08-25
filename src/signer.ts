// Signer credentials for digital signing: a discriminated union over the
// credential source (PEM, PKCS#12, external callback, or a pre-resolved key),
// plus resolveSigner(), which normalizes any variant into the CmsSigner the CMS
// layer consumes. PEM and the external callback are native via node:crypto;
// PKCS#12 goes through pkcs12.ts. Used by Document.Sign.

import { createPrivateKey, X509Certificate, KeyObject } from 'node:crypto';
import { CmsSigner } from './cms.js';
import { SigAlg, SignatureScheme, DigestAlgorithm, detectScheme } from './sigalg.js';
import { parsePkcs12 } from './pkcs12.js';

/** Options common to the credential-source signer variants. */
export interface SignerOptions {
  /** Digest algorithm for the signature (default `sha256`). */
  digestAlgorithm?: DigestAlgorithm;
  /** Signature scheme; defaults to one detected from the key/certificate. */
  signatureScheme?: SignatureScheme;
  /** Signing time (`/M`); defaults to now. */
  signingTime?: Date;
}

/** Sign from a PEM private key plus its PEM/DER certificate chain (leaf first). */
export interface PemSigner extends SignerOptions {
  pem: {
    key: string | Buffer;
    passphrase?: string;
    certificates: (string | Buffer)[];
  };
}

/** Sign from a PKCS#12 (`.pfx`/`.p12`) blob; the key and chain are extracted. */
export interface Pkcs12Signer extends SignerOptions {
  pkcs12: Uint8Array;
  passphrase?: string;
}

/** Sign via an external callback (HSM/KMS/smartcard) — the key never leaves the
 *  device. `certificates` is the signer's chain (leaf first), PEM or DER. */
export interface ExternalSigner extends SignerOptions {
  certificates: (string | Buffer)[];
  sign: (data: Uint8Array, alg: SigAlg) => Promise<Uint8Array> | Uint8Array;
}

/** Any accepted signer: a credential source, or a pre-resolved {@link CmsSigner}
 *  (certificate DER + `KeyObject`) for callers that already hold a key. */
export type Signer = PemSigner | Pkcs12Signer | ExternalSigner | CmsSigner;

function isPkcs12(s: Signer): s is Pkcs12Signer { return 'pkcs12' in s; }
function isPem(s: Signer): s is PemSigner { return 'pem' in s; }
function isExternal(s: Signer): s is ExternalSigner { return 'certificates' in s && 'sign' in s; }

/** Parse a PEM string or DER buffer into a certificate's DER encoding. */
function toCertDer(input: string | Buffer): Uint8Array {
  return new Uint8Array(new X509Certificate(input).raw);
}

/** The default scheme for a certificate's public key (RSA → PKCS#1 v1.5). */
function schemeOfCert(certDer: Uint8Array): SignatureScheme {
  return detectScheme(new X509Certificate(Buffer.from(certDer)).publicKey);
}

/** Normalize any {@link Signer} into the {@link CmsSigner} the CMS layer uses. */
export async function resolveSigner(signer: Signer): Promise<CmsSigner> {
  if (isPkcs12(signer)) {
    const { privateKey, certificates } = parsePkcs12(signer.pkcs12, signer.passphrase ?? '');
    return withChain(certificates, { privateKey }, signer);
  }
  if (isPem(signer)) {
    const privateKey = createPrivateKey({ key: signer.pem.key, passphrase: signer.pem.passphrase });
    const certs = signer.pem.certificates.map(toCertDer);
    return withChain(certs, { privateKey }, signer);
  }
  if (isExternal(signer)) {
    const certs = signer.certificates.map(toCertDer);
    const scheme = signer.signatureScheme ?? schemeOfCert(certs[0]);
    return withChain(certs, { sign: signer.sign, signatureScheme: scheme }, signer);
  }
  return signer; // already a resolved CmsSigner
}

/** Assemble a CmsSigner from a cert list (leaf first) + signing material + opts. */
function withChain(
  certs: Uint8Array[],
  material: { privateKey?: KeyObject; sign?: ExternalSigner['sign']; signatureScheme?: SignatureScheme },
  opts: SignerOptions,
): CmsSigner {
  if (certs.length === 0) throw new Error('signer: no certificate provided');
  return {
    certificate: certs[0],
    chain: certs.slice(1),
    ...material,
    digestAlgorithm: opts.digestAlgorithm,
    signatureScheme: material.signatureScheme ?? opts.signatureScheme,
    signingTime: opts.signingTime,
  };
}
