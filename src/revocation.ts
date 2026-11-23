// Verification of caller-supplied or embedded OCSP and CRL evidence.
// See RFC 6960 §§3.2, 4.2 and RFC 5280 §§5, 6.3.

import { createHash, X509Certificate } from 'node:crypto';
import { der, parseBoundedDer, readOid, readInteger, type Asn1Node } from './asn1.js';
import { detectScheme, verifyData, x509SigAlg } from './sigalg.js';
import { rethrowLimit } from './errors.js';

/** A revocation verdict for one certificate. Material that cannot establish
 *  status yields 'unknown'. With no material the verdict is 'unchecked'. */
export type RevocationStatus = 'good' | 'revoked' | 'unknown' | 'unchecked';

export interface RevocationResult {
  status: RevocationStatus;
  /** Which source produced a conclusive verdict, when one did. */
  source?: 'ocsp' | 'crl';
}

/** Raw revocation material for one certificate (DER bytes, as fetched). */
export interface RevocationMaterial {
  ocsp?: Uint8Array;
  crl?: Uint8Array;
}

/** @internal Keep parsing and streamed discovery caps aligned. */
export const MAX_OCSP_BYTES = 512 * 1024;
/** @internal Keep parsing and streamed discovery caps aligned. */
export const MAX_CRL_BYTES = 4 * 1024 * 1024;
const MAX_CERT_BYTES = 128 * 1024;
const MAX_OCSP_AGE_MS = 24 * 60 * 60 * 1000; // if nextUpdate is omitted
const BASIC_OCSP = '1.3.6.1.5.5.7.48.1.1';
const OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const KEY_USAGE = '2.5.29.15';
const EXTENDED_KEY_USAGE = '2.5.29.37';
const SUBJECT_KEY_ID = '2.5.29.14';
const AUTHORITY_KEY_ID = '2.5.29.35';
const HASH_BY_OID = new Map([
  ['1.3.14.3.2.26', 'sha1'],
  ['2.16.840.1.101.3.4.2.1', 'sha256'],
  ['2.16.840.1.101.3.4.2.2', 'sha384'],
  ['2.16.840.1.101.3.4.2.3', 'sha512'],
]);
const SUPPORTED_HASHES = new Set(HASH_BY_OID.values());

// DER structure and certificate fields used by both protocols.
function invalid(): never { throw new Error('invalid or unsupported revocation DER'); }

function tagged(node: Asn1Node | undefined, tagClass: number, tag: number, constructed: boolean): boolean {
  return node !== undefined && node.tagClass === tagClass && node.tag === tag && node.constructed === constructed;
}

function sequence(node: Asn1Node | undefined, min = 0, max = Infinity): Asn1Node[] {
  if (!node || !tagged(node, 0, 16, true) || node.children.length < min || node.children.length > max) invalid();
  return node.children;
}

function explicit(node: Asn1Node | undefined, tag: number): Asn1Node {
  if (!node || !tagged(node, 2, tag, true) || node.children.length !== 1) invalid();
  return node.children[0];
}

function primitive(node: Asn1Node | undefined, tag: number): Uint8Array {
  if (!node || !tagged(node, 0, tag, false)) invalid();
  return node.content;
}

function numberValue(node: Asn1Node, tag: number, maxLength: number): bigint {
  const bytes = primitive(node, tag);
  if (!bytes.length || bytes.length > maxLength || bytes[0] & 0x80
    || (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80))) invalid();
  return readInteger(node);
}

function oid(node: Asn1Node): string {
  const bytes = primitive(node, 6);
  if (!bytes.length || bytes.length > 64 || bytes[bytes.length - 1] & 0x80) invalid();
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x80 && (i === 0 || !(bytes[i - 1] & 0x80))) invalid();
  }
  return readOid(node);
}

function algorithm(node: Asn1Node): string {
  const [id, parameters] = sequence(node, 1, 2);
  if (parameters !== undefined && primitive(parameters, 5).length !== 0) invalid();
  return oid(id);
}

function signatureAlgorithm(node: Asn1Node): string {
  const id = algorithm(node);
  // ECDSA and Ed25519 AlgorithmIdentifiers carry no parameters.
  if (node.children.length === 2 && x509SigAlg(id)?.scheme !== 'rsa') invalid();
  return id;
}

function supportedReason(reason: Asn1Node): boolean {
  const code = numberValue(reason, 10, 1);
  return code <= 10n && code !== 7n && code !== 8n; // 8 (removeFromCRL) requires a delta
}

function bits(node: Asn1Node): Uint8Array {
  const value = primitive(node, 3);
  const unused = value[0];
  if (value.length < 2 || unused > 7 || (value[value.length - 1] & ((1 << unused) - 1))) invalid();
  return value;
}

function signatureBytes(node: Asn1Node): Uint8Array {
  const value = bits(node);
  if (value[0] !== 0) invalid();
  return value.subarray(1);
}

interface Extension { critical: boolean; value: Uint8Array }

function readExtensions(node: Asn1Node): Map<string, Extension> {
  const out = new Map<string, Extension>();
  for (const entry of sequence(node)) {
    const f = sequence(entry, 2, 3);
    const id = oid(f[0]);
    if (out.has(id)) invalid();
    let critical = false;
    if (f.length === 3) {
      const flag = primitive(f[1], 1);
      if (flag.length !== 1 || flag[0] !== 0xff) invalid();
      critical = true;
    }
    out.set(id, { critical, value: primitive(f[f.length - 1], 4) });
  }
  return out;
}

function hasCritical(extensions: Map<string, Extension>): boolean {
  return [...extensions.values()].some((ext) => ext.critical);
}

function parseCert(der: Uint8Array) {
  const [tbs] = sequence(parseBoundedDer(der, MAX_CERT_BYTES), 3, 3);
  const fields = sequence(tbs, 6);
  const start = tagged(fields[0], 2, 0, true) ? 1 : 0;
  const ext = fields.slice(start + 6).find((node) => tagged(node, 2, 3, true));
  return {
    serial: numberValue(fields[start], 2, 21),
    issuer: fields[start + 2].raw,
    subject: fields[start + 4].raw,
    key: bits(sequence(fields[start + 5], 2, 2)[1]).subarray(1),
    extensions: ext ? readExtensions(explicit(ext, 3)) : new Map<string, Extension>(),
  };
}

function x509(der: Uint8Array): X509Certificate {
  if (der.length > MAX_CERT_BYTES) invalid();
  return new X509Certificate(der);
}

function issuedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
  return (issuer.ca || cert.raw.equals(issuer.raw))
    && cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
}

function withinValidity(cert: X509Certificate, at: Date): boolean {
  return at >= new Date(cert.validFrom) && at <= new Date(cert.validTo);
}

function permitsUsage(extensions: Map<string, Extension>, bit: number): boolean {
  const ext = extensions.get(KEY_USAGE);
  if (!ext) return true;
  const keyBits = bits(parseBoundedDer(ext.value, 32));
  return (keyBits[1 + (bit >> 3)] & (0x80 >> (bit & 7))) !== 0;
}

function permitsOcspDelegation(extensions: Map<string, Extension>): boolean {
  for (const [id, ext] of extensions) {
    if (ext.critical && id !== KEY_USAGE && id !== EXTENDED_KEY_USAGE && id !== '2.5.29.19') return false;
  }
  const eku = extensions.get(EXTENDED_KEY_USAGE);
  return eku !== undefined && sequence(parseBoundedDer(eku.value, MAX_CERT_BYTES), 1).map(oid).includes(OCSP_SIGNING);
}

/** Find a certificate that cryptographically issued the target, including a
 *  verified self-signed target when no other match exists. @internal */
export function matchRevocationIssuer(cert: Uint8Array, pool: readonly Uint8Array[]): Uint8Array | undefined {
  try {
    const target = x509(cert);
    for (const candidate of [...pool, cert]) {
      try {
        if (issuedBy(target, x509(candidate))) return candidate;
      } catch (caught) { rethrowLimit(caught); }
    }
  } catch (caught) { rethrowLimit(caught); }
  return undefined;
}

/** Find a cryptographic issuer when available. The legacy fallback returns the
 *  target itself. Use checkRevocation to authenticate evidence against it. */
export function findIssuer(cert: Uint8Array, pool: Uint8Array[]): Uint8Array {
  return matchRevocationIssuer(cert, pool) ?? cert;
}

function endpointUris(ext: Extension | undefined, locations: (node: Asn1Node) => Asn1Node[]): string[] {
  if (!ext) return [];
  try {
    return sequence(parseBoundedDer(ext.value, MAX_CERT_BYTES), 1).flatMap(locations)
      .filter((node) => tagged(node, 2, 6, false)) // GeneralName.uniformResourceIdentifier
      .map((node) => Buffer.from(node.content).toString('latin1'))
      .filter((value) => /^[!-~]+$/.test(value));
  } catch (caught) { rethrowLimit(caught); return []; }
}

/** Read OCSP AIA and direct, unrestricted full-name CRL distribution points.
 *  URL authorization belongs to the discovery policy. @internal */
export function revocationEndpoints(cert: Uint8Array): { ocsp: string[]; crl: string[] } {
  const extensions = parseCert(cert).extensions;
  const ocsp = endpointUris(extensions.get('1.3.6.1.5.5.7.1.1'), (entry) => {
    const [method, location] = sequence(entry, 2, 2);
    return oid(method) === '1.3.6.1.5.5.7.48.1' ? [location] : [];
  });
  const crl = endpointUris(extensions.get('2.5.29.31'), (entry) => {
    const fields = sequence(entry, 1, 3);
    // A reason mask or another CRL issuer needs scope processing outside this path.
    if (fields.length !== 1 || !tagged(fields[0], 2, 0, true)) return [];
    const point = explicit(fields[0], 0);
    return tagged(point, 2, 0, true) ? point.children : [];
  });
  return { ocsp, crl };
}

/** Encode the one-certificate DER OCSP request for a matched issuer. @internal */
export function buildOcspRequest(cert: Uint8Array, issuer: Uint8Array): Uint8Array {
  const target = parseCert(cert);
  const certId = der.sequence(
    der.sequence(der.oid('1.3.14.3.2.26'), der.null_()),
    der.octetString(digest('sha1', target.issuer)),
    der.octetString(digest('sha1', parseCert(issuer).key)),
    der.integer(target.serial),
  );
  const requestList = der.sequence(der.sequence(certId));
  return der.sequence(der.sequence(requestList));
}

// OCSP (RFC 6960).
export interface OcspSingleResponse {
  hashAlg: string;
  issuerNameHash: Uint8Array;
  issuerKeyHash: Uint8Array;
  serialNumber: bigint;
  status: 'good' | 'revoked' | 'unknown';
  revocationTime?: Date;
  thisUpdate: Date;
  nextUpdate?: Date;
}

export interface OcspResponse {
  responseStatus: number;
  producedAt?: Date;
  responderId?: { type: 'name' | 'key'; value: Uint8Array };
  responses: OcspSingleResponse[];
  responderCerts: Uint8Array[];
  tbsResponseData: Uint8Array;
  signatureAlgorithm: string;
  signature: Uint8Array;
}

/** Parse an OCSP response. Throws on malformed or unsupported input. */
export function parseOcspResponse(der: Uint8Array): OcspResponse {
  const [status, body] = sequence(parseBoundedDer(der, MAX_OCSP_BYTES), 1, 2);
  const responseStatus = Number(numberValue(status, 10, 1));
  if (responseStatus !== 0) {
    return { responseStatus, responses: [], responderCerts: [], tbsResponseData: new Uint8Array(),
      signatureAlgorithm: '', signature: new Uint8Array() };
  }
  const [type, encoded] = sequence(explicit(body, 0), 2, 2);
  if (oid(type) !== BASIC_OCSP) invalid();

  const [data, alg, sig, certs] = sequence(parseBoundedDer(primitive(encoded, 4), MAX_OCSP_BYTES), 3, 4);
  const fields = sequence(data, 3, 5);
  let i = 0;
  if (tagged(fields[0], 2, 0, true) && numberValue(explicit(fields[i++], 0), 2, 1) !== 0n) invalid();
  const id = fields[i++];
  let responderId: NonNullable<OcspResponse['responderId']>;
  if (tagged(id, 2, 1, true)) {
    const subject = explicit(id, 1);
    sequence(subject);
    responderId = { type: 'name', value: subject.raw };
  } else {
    const key = primitive(explicit(id, 2), 4);
    if (key.length !== 20) invalid();
    responderId = { type: 'key', value: key };
  }
  const producedAt = time(fields[i++], true);
  const responses = sequence(fields[i++], 1).map(parseSingleResponse);
  if (i < fields.length && hasCritical(readExtensions(explicit(fields[i++], 1)))) invalid();
  if (i !== fields.length) invalid();
  return {
    responseStatus, responderId, producedAt, responses,
    responderCerts: certs ? sequence(explicit(certs, 0), 1, 32).map((cert) => cert.raw) : [],
    tbsResponseData: data.raw, signatureAlgorithm: signatureAlgorithm(alg), signature: signatureBytes(sig),
  };
}

function parseSingleResponse(node: Asn1Node): OcspSingleResponse {
  const fields = sequence(node, 3, 5);
  const [hash, nameHash, keyHash, serial] = sequence(fields[0], 4, 4);
  const hashAlg = HASH_BY_OID.get(algorithm(hash)) ?? '';
  const cs = fields[1];
  let status: OcspSingleResponse['status'];
  let revocationTime: Date | undefined;
  if (tagged(cs, 2, 1, true)) {
    if (cs.children.length < 1 || cs.children.length > 2) invalid();
    status = 'revoked';
    revocationTime = time(cs.children[0], true);
    if (cs.children[1] && !supportedReason(explicit(cs.children[1], 0))) invalid();
  } else {
    if ((!tagged(cs, 2, 0, false) && !tagged(cs, 2, 2, false)) || cs.length !== 0) invalid();
    status = cs.tag === 0 ? 'good' : 'unknown';
  }
  let i = 3;
  const nextUpdate = tagged(fields[i], 2, 0, true) ? time(explicit(fields[i++], 0), true) : undefined;
  if (i < fields.length && hasCritical(readExtensions(explicit(fields[i++], 1)))) invalid();
  if (i !== fields.length) invalid();
  return { hashAlg, issuerNameHash: primitive(nameHash, 4), issuerKeyHash: primitive(keyHash, 4),
    serialNumber: numberValue(serial, 2, 21), status, revocationTime, thisUpdate: time(fields[2], true), nextUpdate };
}

function matchingResponse(resp: OcspResponse, cert: Uint8Array, issuer: Uint8Array): OcspSingleResponse | undefined {
  const target = parseCert(cert);
  const key = parseCert(issuer).key;
  const hashes = new Map<string, { name: Uint8Array; key: Uint8Array }>();
  let match: OcspSingleResponse | undefined;
  for (const sr of resp.responses) {
    if (sr.serialNumber !== target.serial || !SUPPORTED_HASHES.has(sr.hashAlg)) continue;
    let pair = hashes.get(sr.hashAlg);
    if (!pair) {
      pair = { name: digest(sr.hashAlg, target.issuer), key: digest(sr.hashAlg, key) };
      hashes.set(sr.hashAlg, pair);
    }
    if (bytesEqual(sr.issuerNameHash, pair.name) && bytesEqual(sr.issuerKeyHash, pair.key)) {
      if (match) return undefined;
      match = sr;
    }
  }
  return match;
}

/** Look up the raw status for a CertID. Use checkRevocation for authorization
 *  and freshness validation. */
export function ocspStatus(resp: OcspResponse, cert: Uint8Array, issuer: Uint8Array): OcspSingleResponse['status'] {
  return matchingResponse(resp, cert, issuer)?.status ?? 'unknown';
}

/** Authenticate the signature, responder ID, and issuer delegation. */
export function verifyOcspSignature(resp: OcspResponse, issuer: Uint8Array, at?: Date): boolean {
  const alg = x509SigAlg(resp.signatureAlgorithm);
  const { responderId, producedAt } = resp;
  if (!alg || !responderId || !producedAt || resp.responseStatus !== 0) return false;
  try {
    const ca = x509(issuer);
    if (!withinValidity(ca, producedAt)) return false;
    for (const candidate of [issuer, ...resp.responderCerts]) {
      try {
        const fields = parseCert(candidate);
        const nameOrKey = responderId.type === 'name' ? fields.subject : digest('sha1', fields.key);
        if (!bytesEqual(responderId.value, nameOrKey) || !permitsUsage(fields.extensions, 0)) continue;
        const signer = x509(candidate);
        if (!withinValidity(signer, producedAt) || (at !== undefined && !withinValidity(signer, at))) continue;
        if (!signer.raw.equals(ca.raw)
          && (!issuedBy(signer, ca) || !permitsOcspDelegation(fields.extensions))) continue;
        const key = signer.publicKey;
        if (detectScheme(key) === alg.scheme && verifyData(resp.tbsResponseData, key, resp.signature, alg.scheme, alg.digest)) return true;
      } catch (caught) { rethrowLimit(caught); }
    }
  } catch (caught) { rethrowLimit(caught); }
  return false;
}

// CRL (RFC 5280).
export interface CrlEntry { serialNumber: bigint; revocationDate: Date }

export interface Crl {
  issuer: Uint8Array;
  thisUpdate: Date;
  nextUpdate?: Date;
  revoked: CrlEntry[];
  tbsCertList: Uint8Array;
  signatureAlgorithm: string;
  signature: Uint8Array;
  /** Whether the parsed list has full direct-issuer scope. */
  complete?: boolean;
  authorityKeyId?: Uint8Array;
}

/** Parse a CertificateList. Throws on malformed input. */
export function parseCrl(der: Uint8Array): Crl {
  const [tbs, outerAlg, sig] = sequence(parseBoundedDer(der, MAX_CRL_BYTES), 3, 3);
  const fields = sequence(tbs, 3, 7);
  let i = 0;
  if (tagged(fields[0], 0, 2, false) && numberValue(fields[i++], 2, 1) !== 1n) invalid();
  const sigAlgorithm = signatureAlgorithm(outerAlg);
  if (!bytesEqual(fields[i++].raw, outerAlg.raw)) invalid();
  const issuer = fields[i++];
  sequence(issuer);
  const thisUpdate = time(fields[i++]);
  const nextUpdate = isTime(fields[i]) ? time(fields[i++]) : undefined;
  let complete = true;
  const serials = new Set<bigint>();
  const revoked: CrlEntry[] = [];
  if (tagged(fields[i], 0, 16, true)) {
    for (const entry of sequence(fields[i++])) {
      const [serial, date, exts] = sequence(entry, 2, 3);
      const serialNumber = numberValue(serial, 2, 21);
      if (serials.has(serialNumber)) invalid();
      serials.add(serialNumber);
      if (exts) {
        const extensions = readExtensions(exts);
        const reason = extensions.get('2.5.29.21');
        if (hasCritical(extensions) || extensions.has('2.5.29.29')
          || (reason && !supportedReason(parseBoundedDer(reason.value, 16)))) complete = false;
      }
      revoked.push({ serialNumber, revocationDate: time(date) });
    }
  }
  let authorityKeyId: Uint8Array | undefined;
  if (i < fields.length) {
    const extensions = readExtensions(explicit(fields[i++], 0));
    // A delta, indirect, partitioned, or otherwise scoped list is inconclusive
    // without distribution-point processing and coverage for all reasons.
    if (hasCritical(extensions) || extensions.has('2.5.29.27') || extensions.has('2.5.29.28')) complete = false;
    const authority = extensions.get(AUTHORITY_KEY_ID);
    if (authority) {
      const items = sequence(parseBoundedDer(authority.value, MAX_CERT_BYTES), 1, 3);
      authorityKeyId = items.find((item) => tagged(item, 2, 0, false))?.content;
      if (!authorityKeyId?.length) complete = false;
    }
  }
  if (i !== fields.length) invalid();
  return { issuer: issuer.raw, thisUpdate, nextUpdate, revoked, tbsCertList: tbs.raw, signatureAlgorithm: sigAlgorithm,
    signature: signatureBytes(sig), complete, authorityKeyId };
}

/** Look up a serial number in the raw list. Use checkRevocation for
 *  authentication, applicability, and freshness validation. */
export function crlStatus(crl: Crl, cert: Uint8Array): 'good' | 'revoked' {
  const serial = parseCert(cert).serial;
  return crl.revoked.some((e) => e.serialNumber === serial) ? 'revoked' : 'good';
}

/** Authenticate the signature and issuer's CRL signing usage. */
export function verifyCrlSignature(crl: Crl, issuer: Uint8Array): boolean {
  const alg = x509SigAlg(crl.signatureAlgorithm);
  if (!alg) return false;
  try {
    const fields = parseCert(issuer);
    const ski = fields.extensions.get(SUBJECT_KEY_ID);
    if (crl.authorityKeyId && ski
      && !bytesEqual(crl.authorityKeyId, primitive(parseBoundedDer(ski.value, MAX_CERT_BYTES), 4))) return false;
    const key = x509(issuer).publicKey;
    return bytesEqual(fields.subject, crl.issuer) && permitsUsage(fields.extensions, 6)
      && detectScheme(key) === alg.scheme && verifyData(crl.tbsCertList, key, crl.signature, alg.scheme, alg.digest);
  } catch (caught) { rethrowLimit(caught); return false; }
}

/** Evaluate evidence at 'at' (default now), preferring a conclusive OCSP
 *  response before a current, complete direct CRL. */
export function checkRevocation(
  cert: Uint8Array, issuer: Uint8Array, material: RevocationMaterial, at = new Date(),
): RevocationResult {
  if (!material.ocsp && !material.crl) return { status: 'unchecked' };
  const inconclusive: RevocationResult = { status: 'unknown' };
  if (!Number.isFinite(at.getTime())) return inconclusive;
  let ca: X509Certificate, targetCert: X509Certificate;
  try {
    ca = x509(issuer);
    targetCert = x509(cert);
    if (!withinValidity(ca, at) || !issuedBy(targetCert, ca)) return inconclusive;
  } catch (caught) { rethrowLimit(caught); return inconclusive; }
  if (material.ocsp) {
    try {
      const resp = parseOcspResponse(material.ocsp);
      const match = matchingResponse(resp, cert, issuer);
      if (match && resp.producedAt && resp.producedAt <= at && match.thisUpdate <= resp.producedAt
        && fresh(match.thisUpdate, match.nextUpdate, at, MAX_OCSP_AGE_MS)
        && match.status !== 'unknown'
        && (match.status !== 'revoked' || (match.revocationTime && match.revocationTime <= match.thisUpdate))
        && verifyOcspSignature(resp, issuer, at)) return { status: match.status, source: 'ocsp' };
    } catch (caught) { rethrowLimit(caught); }
  }
  if (material.crl) {
    try {
      const crl = parseCrl(material.crl);
      if (crl.complete && crl.nextUpdate && fresh(crl.thisUpdate, crl.nextUpdate, at)
        && withinValidity(ca, crl.thisUpdate) && verifyCrlSignature(crl, issuer)) {
        const target = parseCert(cert);
        if (!bytesEqual(target.issuer, crl.issuer)) return inconclusive;
        const entry = crl.revoked.find((e) => e.serialNumber === target.serial);
        if (entry && entry.revocationDate <= crl.thisUpdate) return { status: 'revoked', source: 'crl' };
        if (!entry && withinValidity(targetCert, crl.thisUpdate)) return { status: 'good', source: 'crl' };
      }
    } catch (caught) { rethrowLimit(caught); }
  }
  return inconclusive;
}

function fresh(start: Date, end: Date | undefined, at: Date, maxAgeMs = 0): boolean {
  return start <= at && (end ? start < end && at < end : at.getTime() - start.getTime() <= maxAgeMs);
}

function isTime(node: Asn1Node | undefined): boolean {
  return tagged(node, 0, 23, false) || tagged(node, 0, 24, false);
}

/** Require an actual calendar instant in the RFC 5280 UTC formats. */
function time(node: Asn1Node, generalizedOnly = false): Date {
  if (!node || !isTime(node) || (generalizedOnly && node.tag !== 24)) invalid();
  const text = Buffer.from(node.content).toString('latin1');
  const utc = node.tag === 23;
  const match = (utc ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/ :
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/).exec(text);
  if (!match) invalid();
  const [, y, m, d, h, min, s] = match;
  const year = utc ? +y + (+y >= 50 ? 1900 : 2000) : +y;
  const date = new Date(Date.UTC(year, +m - 1, +d, +h, +min, +s));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d
    || date.getUTCHours() !== +h || date.getUTCMinutes() !== +min || date.getUTCSeconds() !== +s) invalid();
  return date;
}

function digest(alg: string, value: Uint8Array): Uint8Array {
  return createHash(alg).update(value).digest();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
