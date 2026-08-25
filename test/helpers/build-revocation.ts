// Mints signed OCSP responses (RFC 6960) and CRLs (RFC 5280) for revocation
// tests, using the library's own DER encoder and node:crypto for signing. The
// "responder"/"issuer" is a TestSigner (self-signed cert acting as its own CA).

import { sign as cryptoSign, createHash } from 'node:crypto';
import { der, parse, readInteger, type Asn1Node } from '../../src/asn1.js';
import type { TestSigner } from './build-signer.js';

const SHA1_OID = '1.3.14.3.2.26';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const OCSP_BASIC = '1.3.6.1.5.5.7.48.1.1';
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

function tbsOf(cert: Uint8Array): Asn1Node { return parse(cert).children[0]; }
function si(t: Asn1Node): number { return t.children[0].tagClass === 2 ? 1 : 0; }
function serialOf(cert: Uint8Array): bigint { const t = tbsOf(cert); return readInteger(t.children[si(t)]); }
function subjectRaw(cert: Uint8Array): Uint8Array { const t = tbsOf(cert); return t.children[si(t) + 4].raw; }
function keyBytes(cert: Uint8Array): Uint8Array {
  const t = tbsOf(cert);
  return t.children[si(t) + 5].children[1].content.subarray(1); // SPKI subjectPublicKey value
}

function algId(oid: string, withNull: boolean): Uint8Array {
  return withNull ? der.sequence(der.oid(oid), der.null_()) : der.sequence(der.oid(oid));
}

/** The X.509 signatureAlgorithm + node digest for a signer's key type. */
function sigAlgFor(signer: TestSigner): { id: Uint8Array; digest: 'sha256' } {
  const rsa = signer.privateKey.asymmetricKeyType === 'rsa';
  return { id: algId(rsa ? SHA256_WITH_RSA : ECDSA_WITH_SHA256, rsa), digest: 'sha256' };
}

function signWith(signer: TestSigner, data: Uint8Array): Uint8Array {
  return new Uint8Array(cryptoSign('sha256', data, signer.privateKey));
}

export interface OcspOptions {
  /** The OCSP responder (here, the issuer/CA signing the response). */
  responder: TestSigner;
  /** The certificate whose status is being asserted (DER). */
  cert: Uint8Array;
  /** The issuer certificate (DER) — for the CertID name/key hashes. */
  issuer: Uint8Array;
  status: 'good' | 'revoked';
  producedAt?: Date;
  revocationTime?: Date;
  /** Corrupt the responder signature (to test signature-verification failure). */
  tamper?: boolean;
}

/** Build a signed `OCSPResponse` (status successful) asserting `cert`'s status. */
export function buildOcspResponse(o: OcspOptions): Uint8Array {
  const nameHash = new Uint8Array(createHash('sha1').update(subjectRaw(o.issuer)).digest());
  const keyHash = new Uint8Array(createHash('sha1').update(keyBytes(o.issuer)).digest());
  const certID = der.sequence(
    algId(SHA1_OID, true),
    der.octetString(nameHash),
    der.octetString(keyHash),
    der.integer(serialOf(o.cert)),
  );
  const certStatus = o.status === 'good'
    ? Uint8Array.of(0x80, 0x00)                                   // good [0] IMPLICIT NULL
    : der.explicit(1, der.generalizedTime(o.revocationTime ?? new Date())); // revoked [1]
  const singleResponse = der.sequence(certID, certStatus, der.generalizedTime(new Date()));

  const responderID = der.explicit(1, subjectRaw(o.responder.certificate)); // byName [1]
  const responseData = der.sequence(
    responderID,
    der.generalizedTime(o.producedAt ?? new Date()),
    der.sequence(singleResponse),                                // responses SEQUENCE OF
  );

  const { id: sigAlgId } = sigAlgFor(o.responder);
  const signature = signWith(o.responder, responseData);
  if (o.tamper) signature[0] ^= 0xff;
  const basic = der.sequence(
    responseData,
    sigAlgId,
    der.bitString(signature),
    der.explicit(0, der.sequence(o.responder.certificate)),      // [0] certs
  );

  const responseBytes = der.sequence(der.oid(OCSP_BASIC), der.octetString(basic));
  return der.sequence(
    Uint8Array.of(0x0a, 0x01, 0x00),                             // responseStatus ENUMERATED successful
    der.explicit(0, responseBytes),
  );
}

export interface CrlOptions {
  /** The CRL issuer (CA) signing the list. */
  issuer: TestSigner;
  revokedSerials?: bigint[];
  thisUpdate?: Date;
  nextUpdate?: Date;
}

/** Build a signed `CertificateList` (CRL) revoking `revokedSerials`. */
export function buildCrl(o: CrlOptions): Uint8Array {
  const { id: sigAlgId } = sigAlgFor(o.issuer);
  const entries = (o.revokedSerials ?? []).map((s) =>
    der.sequence(der.integer(s), der.utcTime(new Date(Date.UTC(2026, 0, 1)))));
  const tbs = der.sequence(
    der.integer(1),                                              // version v2
    sigAlgId,                                                    // signature
    subjectRaw(o.issuer.certificate),                           // issuer Name
    der.utcTime(o.thisUpdate ?? new Date(Date.UTC(2026, 0, 1))),
    der.utcTime(o.nextUpdate ?? new Date(Date.UTC(2030, 0, 1))),
    der.sequence(...entries),                                   // revokedCertificates
  );
  return der.sequence(tbs, sigAlgId, der.bitString(signWith(o.issuer, tbs)));
}
