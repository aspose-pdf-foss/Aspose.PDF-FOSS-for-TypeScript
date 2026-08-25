// Certificate-revocation checking for PDF signature verification (V3): parse
// OCSP responses (RFC 6960) and CRLs (RFC 5280), match the signer certificate,
// verify the responder/issuer signature over the revocation data, and render a
// good | revoked | unknown verdict. Built on asn1.ts + node:crypto; the actual
// OCSP/CRL bytes come from caller callbacks (online) or embedded /DSS data
// (offline, wired by dss.ts). Zero runtime dependencies.

import { createHash, X509Certificate } from 'node:crypto';
import { parse, readOid, readInteger, Asn1Node } from './asn1.js';
import { verifyData, x509SigAlg } from './sigalg.js';

/** A revocation verdict for one certificate. `unchecked` means no material was
 *  available; `unknown` means material was present but inconclusive (no matching
 *  entry, bad signature, or an OCSP `unknown`/error status). */
export type RevocationStatus = 'good' | 'revoked' | 'unknown' | 'unchecked';

export interface RevocationResult {
  status: RevocationStatus;
  /** Which source produced a conclusive verdict, when one did. */
  source?: 'ocsp' | 'crl';
}

/** Raw revocation material for one certificate (DER bytes, as fetched). */
export interface RevocationMaterial {
  ocsp?: Uint8Array;  // an OCSPResponse
  crl?: Uint8Array;   // a CertificateList (CRL)
}

const SHA1_OID = '1.3.14.3.2.26';
const HASH_BY_OID: Record<string, string> = {
  [SHA1_OID]: 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

// --- Certificate field helpers ------------------------------------------

function tbsOf(certDer: Uint8Array): Asn1Node {
  return parse(certDer).children[0];
}
/** Index of the serialNumber within a TBSCertificate (skips the optional
 *  explicit [0] version). */
function serialIndex(tbs: Asn1Node): number {
  return tbs.children[0].tagClass === 2 ? 1 : 0;
}
function certSerial(certDer: Uint8Array): bigint {
  const tbs = tbsOf(certDer);
  return readInteger(tbs.children[serialIndex(tbs)]);
}
function certIssuerRaw(certDer: Uint8Array): Uint8Array {
  const tbs = tbsOf(certDer);
  return tbs.children[serialIndex(tbs) + 2].raw; // issuer Name
}
function certSubjectRaw(certDer: Uint8Array): Uint8Array {
  const tbs = tbsOf(certDer);
  return tbs.children[serialIndex(tbs) + 4].raw; // subject Name
}
/** The subjectPublicKey BIT STRING value (excluding the unused-bits octet) — the
 *  input to an OCSP CertID issuerKeyHash. */
function certKeyBytes(certDer: Uint8Array): Uint8Array {
  const tbs = tbsOf(certDer);
  const spki = tbs.children[serialIndex(tbs) + 5];
  return spki.children[1].content.subarray(1);
}

/** Find the issuer certificate of `cert` among `pool` (subject == cert.issuer),
 *  or `cert` itself when self-issued / no better match is available. */
export function findIssuer(cert: Uint8Array, pool: Uint8Array[]): Uint8Array {
  const want = certIssuerRaw(cert);
  for (const c of pool) if (bytesEqual(certSubjectRaw(c), want)) return c;
  return cert;
}

// --- OCSP (RFC 6960) -----------------------------------------------------

export interface OcspSingleResponse {
  hashAlg: string;            // node hash name from the CertID
  issuerNameHash: Uint8Array;
  issuerKeyHash: Uint8Array;
  serialNumber: bigint;
  status: 'good' | 'revoked' | 'unknown';
  revocationTime?: Date;
  thisUpdate: Date;
  nextUpdate?: Date;
}

export interface OcspResponse {
  responseStatus: number;       // 0 = successful (RFC 6960 §4.2.1)
  producedAt?: Date;
  responses: OcspSingleResponse[];
  responderCerts: Uint8Array[]; // certs embedded in the BasicOCSPResponse
  tbsResponseData: Uint8Array;  // signed bytes
  signatureAlgorithm: string;   // dotted OID
  signature: Uint8Array;
}

/** Parse an `OCSPResponse` (RFC 6960). Throws on malformed input. */
export function parseOcspResponse(der: Uint8Array): OcspResponse {
  const resp = parse(der);
  const responseStatus = resp.children[0].content[0] ?? 6;
  if (responseStatus !== 0)
    return { responseStatus, responses: [], responderCerts: [], tbsResponseData: new Uint8Array(), signatureAlgorithm: '', signature: new Uint8Array() };

  const responseBytes = resp.children[1].children[0];     // [0] EXPLICIT -> SEQUENCE
  const basic = parse(responseBytes.children[1].content); // OCTET STRING -> BasicOCSPResponse
  const rd = basic.children[0];                           // tbsResponseData (ResponseData)
  const signatureAlgorithm = readOid(basic.children[1].children[0]);
  const signature = basic.children[2].content.subarray(1); // BIT STRING (drop unused-bits octet)
  let responderCerts: Uint8Array[] = [];
  const certsCtx = basic.children.find((c) => c.tagClass === 2 && c.tag === 0);
  if (certsCtx) responderCerts = splitSequenceOf(certsCtx.children[0]);

  const responsesSeq = rd.children.find((c) => c.tagClass === 0 && c.tag === 0x10)!;
  const producedAtNode = rd.children.find((c) => c.tagClass === 0 && c.tag === 0x18);
  const producedAt = producedAtNode ? parseAsn1Time(producedAtNode) : undefined;

  const responses = responsesSeq.children.map(parseSingleResponse);
  return { responseStatus, producedAt, responses, responderCerts, tbsResponseData: rd.raw, signatureAlgorithm, signature };
}

function parseSingleResponse(sr: Asn1Node): OcspSingleResponse {
  const certID = sr.children[0];
  const hashAlg = HASH_BY_OID[readOid(certID.children[0].children[0])] ?? 'sha1';
  const issuerNameHash = certID.children[1].content;
  const issuerKeyHash = certID.children[2].content;
  const serialNumber = readInteger(certID.children[3]);

  const cs = sr.children[1]; // certStatus CHOICE (context-tagged)
  let status: 'good' | 'revoked' | 'unknown' = 'unknown';
  let revocationTime: Date | undefined;
  if (cs.tag === 0) status = 'good';
  else if (cs.tag === 1) { status = 'revoked'; if (cs.children[0]) revocationTime = parseAsn1Time(cs.children[0]); }
  else status = 'unknown';

  const thisUpdate = parseAsn1Time(sr.children[2]);
  const nextUpdateCtx = sr.children.find((c, i) => i >= 3 && c.tagClass === 2 && c.tag === 0);
  const nextUpdate = nextUpdateCtx ? parseAsn1Time(nextUpdateCtx.children[0]) : undefined;
  return { hashAlg, issuerNameHash, issuerKeyHash, serialNumber, status, revocationTime, thisUpdate, nextUpdate };
}

/** The OCSP status for `cert` (issued by `issuer`): match a SingleResponse by
 *  CertID (issuer name/key hash + serial), or `unknown` when none matches. */
export function ocspStatus(resp: OcspResponse, cert: Uint8Array, issuer: Uint8Array): 'good' | 'revoked' | 'unknown' {
  const serial = certSerial(cert);
  for (const sr of resp.responses) {
    if (sr.serialNumber !== serial) continue;
    const nameHash = new Uint8Array(createHash(sr.hashAlg).update(certSubjectRaw(issuer)).digest());
    const keyHash = new Uint8Array(createHash(sr.hashAlg).update(certKeyBytes(issuer)).digest());
    if (bytesEqual(sr.issuerNameHash, nameHash) && bytesEqual(sr.issuerKeyHash, keyHash))
      return sr.status;
  }
  return 'unknown';
}

/** Verify the BasicOCSPResponse signature against an embedded responder cert or
 *  the `issuer` cert (a directly-issued OCSP response). */
export function verifyOcspSignature(resp: OcspResponse, issuer: Uint8Array): boolean {
  const alg = x509SigAlg(resp.signatureAlgorithm);
  if (!alg) return false;
  for (const candidate of [...resp.responderCerts, issuer]) {
    try {
      const key = new X509Certificate(Buffer.from(candidate)).publicKey;
      if (verifyData(resp.tbsResponseData, key, resp.signature, alg.scheme, alg.digest)) return true;
    } catch { /* try the next candidate */ }
  }
  return false;
}

// --- CRL (RFC 5280) ------------------------------------------------------

export interface CrlEntry { serialNumber: bigint; revocationDate: Date }

export interface Crl {
  issuer: Uint8Array;          // raw issuer Name
  thisUpdate: Date;
  nextUpdate?: Date;
  revoked: CrlEntry[];
  tbsCertList: Uint8Array;
  signatureAlgorithm: string;  // dotted OID
  signature: Uint8Array;
}

/** Parse a `CertificateList` (CRL, RFC 5280). Throws on malformed input. */
export function parseCrl(der: Uint8Array): Crl {
  const cl = parse(der);
  const tbs = cl.children[0];
  const signatureAlgorithm = readOid(cl.children[1].children[0]);
  const signature = cl.children[2].content.subarray(1);

  let i = 0;
  if (tbs.children[0].tagClass === 0 && tbs.children[0].tag === 0x02) i = 1; // optional version
  i += 1;                                  // signature AlgorithmIdentifier
  const issuer = tbs.children[i].raw; i += 1;
  const thisUpdate = parseAsn1Time(tbs.children[i]); i += 1;
  let nextUpdate: Date | undefined;
  if (tbs.children[i] && isTime(tbs.children[i])) { nextUpdate = parseAsn1Time(tbs.children[i]); i += 1; }
  let revoked: CrlEntry[] = [];
  const list = tbs.children[i];
  if (list && list.tagClass === 0 && list.tag === 0x10) {
    revoked = list.children.map((e) => ({
      serialNumber: readInteger(e.children[0]),
      revocationDate: parseAsn1Time(e.children[1]),
    }));
  }
  return { issuer, thisUpdate, nextUpdate, revoked, tbsCertList: tbs.raw, signatureAlgorithm, signature };
}

/** Whether `cert`'s serial appears in the CRL's revoked list. */
export function crlStatus(crl: Crl, cert: Uint8Array): 'good' | 'revoked' {
  const serial = certSerial(cert);
  return crl.revoked.some((e) => e.serialNumber === serial) ? 'revoked' : 'good';
}

/** Verify the CRL signature against the `issuer` certificate's public key. */
export function verifyCrlSignature(crl: Crl, issuer: Uint8Array): boolean {
  const alg = x509SigAlg(crl.signatureAlgorithm);
  if (!alg) return false;
  try {
    const key = new X509Certificate(Buffer.from(issuer)).publicKey;
    return verifyData(crl.tbsCertList, key, crl.signature, alg.scheme, alg.digest);
  } catch {
    return false;
  }
}

// --- Combined check ------------------------------------------------------

/** Determine the revocation status of `cert` (issued by `issuer`) from the given
 *  material, preferring a signature-verified OCSP response, then a verified CRL.
 *  A `good`/`revoked` verdict is reported only when the source signature checks
 *  out; otherwise `unknown` (material present) or `unchecked` (none). */
export function checkRevocation(cert: Uint8Array, issuer: Uint8Array, material: RevocationMaterial): RevocationResult {
  if (material.ocsp) {
    try {
      const resp = parseOcspResponse(material.ocsp);
      if (resp.responseStatus === 0 && verifyOcspSignature(resp, issuer)) {
        const st = ocspStatus(resp, cert, issuer);
        if (st !== 'unknown') return { status: st, source: 'ocsp' };
      }
    } catch { /* fall through to CRL */ }
  }
  if (material.crl) {
    try {
      const crl = parseCrl(material.crl);
      if (verifyCrlSignature(crl, issuer)) return { status: crlStatus(crl, cert), source: 'crl' };
    } catch { /* fall through */ }
  }
  return { status: material.ocsp || material.crl ? 'unknown' : 'unchecked' };
}

// --- small helpers -------------------------------------------------------

function splitSequenceOf(seq: Asn1Node): Uint8Array[] {
  return seq.children.map((c) => c.raw);
}

function isTime(node: Asn1Node): boolean {
  return node.tagClass === 0 && (node.tag === 0x17 || node.tag === 0x18); // UTCTime | GeneralizedTime
}

/** Parse a UTCTime (`YYMMDDHHMMSSZ`) or GeneralizedTime (`YYYYMMDD…Z`) node. */
function parseAsn1Time(node: Asn1Node): Date {
  let s = '';
  for (const b of node.content) s += String.fromCharCode(b);
  if (node.tag === 0x17) { // UTCTime: 2-digit year (>=50 -> 19xx, else 20xx)
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
    if (!m) throw new Error(`revocation: bad UTCTime "${s}"`);
    const yy = +m[1];
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
  }
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
  if (!m) throw new Error(`revocation: bad GeneralizedTime "${s}"`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
