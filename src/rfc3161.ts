// RFC 3161 timestamping for PDF digital signatures (PAdES-B-T). Builds a
// TimeStampReq over a signature's value, normalizes the TSA's response into a
// TimeStampToken (a CMS ContentInfo), and — on the read side — parses the
// embedded TSTInfo and verifies that (a) its message imprint matches the
// signature it timestamps and (b) the TSA's own CMS signature over the TSTInfo
// is valid. A {@link buildTimeStampToken} helper assembles a token from a
// request, enough to stand up a TSA (used by tests). Built on asn1.ts + cms.ts;
// zero runtime dependencies.

import { createHash, randomBytes } from 'node:crypto';
import { der, parse, readOid, readInteger, OID } from './asn1.js';
import { DigestAlgorithm } from './sigalg.js';
import { buildSignedData, parseSignedData, verifySignedData, type CmsSigner } from './cms.js';

/** A timestamp provider: given a DER `TimeStampReq`, return either the bare
 *  `TimeStampToken` (a CMS ContentInfo) or a full `TimeStampResp`. Typically a
 *  thin wrapper over an HTTP call to an RFC 3161 TSA. May be async. */
export type TimestampProvider = (request: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Default policy OID stamped into tokens built by {@link buildTimeStampToken}
 *  when the caller supplies none. A real TSA states its own policy. */
const DEFAULT_TSA_POLICY = '1.3.6.1.4.1.601.10.3.1';

const DIGEST_OID: Record<DigestAlgorithm, string> = {
  sha256: OID.sha256, sha384: OID.sha384, sha512: OID.sha512,
};
const DIGEST_BY_OID: Record<string, DigestAlgorithm> = {
  [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512',
};

function digestAlgId(alg: DigestAlgorithm): Uint8Array {
  return der.sequence(der.oid(DIGEST_OID[alg]), der.null_());
}

function randomNonce(): bigint {
  let v = 0n;
  for (const b of randomBytes(8)) v = (v << 8n) | BigInt(b);
  return v;
}

// --- Request -------------------------------------------------------------

export interface TimeStampRequestOptions {
  /** Anti-replay nonce echoed in the token. Default: 64 random bits. */
  nonce?: bigint;
  /** Ask the TSA to embed its certificate in the token (default true), so the
   *  token can be verified later without out-of-band cert retrieval. */
  certReq?: boolean;
  /** Request a specific TSA policy OID. */
  reqPolicy?: string;
}

/** Build a DER `TimeStampReq` (RFC 3161 §2.4.1) carrying a message imprint over
 *  `imprint` (already hashed with `hashAlg`). */
export function buildTimeStampRequest(
  imprint: Uint8Array, hashAlg: DigestAlgorithm, opts: TimeStampRequestOptions = {},
): Uint8Array {
  const messageImprint = der.sequence(digestAlgId(hashAlg), der.octetString(imprint));
  const parts = [der.integer(1), messageImprint];      // version v1
  if (opts.reqPolicy) parts.push(der.oid(opts.reqPolicy));
  parts.push(der.integer(opts.nonce ?? randomNonce())); // nonce
  parts.push(der.boolean(opts.certReq ?? true));        // certReq
  return der.sequence(...parts);
}

export interface TimeStampRequestInfo {
  hashAlg: DigestAlgorithm;
  imprint: Uint8Array;
  nonce?: bigint;
}

/** Parse the message imprint and nonce out of a DER `TimeStampReq`. */
export function parseTimeStampRequest(request: Uint8Array): TimeStampRequestInfo {
  const seq = parse(request);
  const mi = seq.children[1]; // messageImprint
  const hashAlg = DIGEST_BY_OID[readOid(mi.children[0].children[0])] ?? 'sha256';
  const imprint = mi.children[1].content;
  let nonce: bigint | undefined;
  for (let i = 2; i < seq.children.length; i++) {
    const c = seq.children[i];
    if (c.tagClass === 0 && c.tag === 0x02) { nonce = readInteger(c); break; } // INTEGER nonce
  }
  return { hashAlg, imprint, nonce };
}

// --- Response normalization ---------------------------------------------

/** Normalize a TSA reply into a bare `TimeStampToken` (ContentInfo): pass a
 *  ContentInfo through unchanged, or unwrap the token from a `TimeStampResp`. */
export function extractTimeStampToken(respOrToken: Uint8Array): Uint8Array {
  const node = parse(respOrToken);
  const first = node.children[0];
  // ContentInfo starts with the contentType OID; TimeStampResp starts with the
  // PKIStatusInfo SEQUENCE.
  if (first.tagClass === 0 && first.tag === 0x06) return node.raw;
  const token = node.children[1];
  if (!token) throw new Error('rfc3161: timestamp response carries no token (status not granted?)');
  return token.raw;
}

// --- Token assembly (TSA side) ------------------------------------------

/** The TSTInfo bytes embedded as the eContent of a TimeStampToken. */
function extractTstInfoBytes(token: Uint8Array): Uint8Array {
  const contentInfo = parse(token);
  const signedData = contentInfo.children[1].children[0];
  const encap = signedData.children[2];     // encapContentInfo SEQUENCE
  const eContent = encap.children[1];        // [0] EXPLICIT
  return eContent.children[0].content;       // OCTET STRING content = TSTInfo DER
}

interface TstInfoFields {
  hashAlg: DigestAlgorithm;
  imprint: Uint8Array;
  serialNumber: bigint;
  genTime: Date;
  policy: string;
  nonce?: bigint;
}

function buildTstInfo(f: TstInfoFields): Uint8Array {
  const messageImprint = der.sequence(digestAlgId(f.hashAlg), der.octetString(f.imprint));
  const parts = [
    der.integer(1),                  // version v1
    der.oid(f.policy),               // policy
    messageImprint,                  // messageImprint (echoes the request)
    der.integer(f.serialNumber),     // serialNumber
    der.generalizedTime(f.genTime),  // genTime
  ];
  if (f.nonce !== undefined) parts.push(der.integer(f.nonce)); // nonce (accuracy/ordering omitted)
  return der.sequence(...parts);
}

export interface TimeStampTokenOptions {
  genTime?: Date;
  serialNumber?: bigint;
  policy?: string;
}

/** Assemble a `TimeStampToken` for `request`, signed by `signer` (the TSA): echo
 *  the request's imprint/nonce into a TSTInfo, embed it as the eContent of a CMS
 *  SignedData, and sign. Enough to act as an RFC 3161 TSA. */
export async function buildTimeStampToken(
  request: Uint8Array, signer: CmsSigner, opts: TimeStampTokenOptions = {},
): Promise<Uint8Array> {
  const info = parseTimeStampRequest(request);
  const tstInfo = buildTstInfo({
    hashAlg: info.hashAlg,
    imprint: info.imprint,
    nonce: info.nonce,
    serialNumber: opts.serialNumber ?? randomNonce(),
    genTime: opts.genTime ?? new Date(),
    policy: opts.policy ?? DEFAULT_TSA_POLICY,
  });
  const digest = new Uint8Array(createHash(signer.digestAlgorithm ?? 'sha256').update(tstInfo).digest());
  return buildSignedData(digest, signer, { eContentType: OID.tstInfo, eContent: tstInfo });
}

// --- Parsing + verification (read side) ---------------------------------

export interface TstInfo {
  hashAlg: DigestAlgorithm;
  imprint: Uint8Array;
  serialNumber: bigint;
  genTime: Date;
  policy: string;
  nonce?: bigint;
}

/** Parse the TSTInfo carried by a TimeStampToken. */
export function parseTstInfo(token: Uint8Array): TstInfo {
  const seq = parse(extractTstInfoBytes(token));
  const policy = readOid(seq.children[1]);
  const mi = seq.children[2];
  const hashAlg = DIGEST_BY_OID[readOid(mi.children[0].children[0])] ?? 'sha256';
  const imprint = mi.children[1].content;
  const serialNumber = readInteger(seq.children[3]);
  const genTime = parseGeneralizedTime(asciiOf(seq.children[4].content));
  let nonce: bigint | undefined;
  for (let i = 5; i < seq.children.length; i++) {
    const c = seq.children[i];
    if (c.tagClass === 0 && c.tag === 0x02) { nonce = readInteger(c); break; }
  }
  return { hashAlg, imprint, serialNumber, genTime, policy, nonce };
}

/** Verdict on a signature timestamp: the asserted time plus whether the token
 *  binds to the signature (imprint) and whether the TSA's signature is valid. */
export interface TimestampInfo {
  /** The TSA-asserted signing time (`genTime`). */
  time: Date;
  /** Whether the token's message imprint matches the timestamped signature. */
  imprintMatches: boolean;
  /** Whether the TSA's CMS signature over the TSTInfo verifies. */
  tokenSignatureValid: boolean;
  /** `imprintMatches && tokenSignatureValid` — the overall token verdict.
   *  (TSA-certificate trust is a chain-validation concern, reported separately.) */
  valid: boolean;
  /** The TSA policy OID. */
  policy: string;
  /** The token serial number (decimal string). */
  serialNumber: string;
}

/** Verify a TimeStampToken against the `signedValue` it timestamps (the outer
 *  signature's signatureValue): check the message-imprint binding and the TSA's
 *  own CMS signature over the embedded TSTInfo. */
export function verifyTimestampToken(token: Uint8Array, signedValue: Uint8Array): TimestampInfo {
  const info = parseTstInfo(token);
  const recomputed = new Uint8Array(createHash(info.hashAlg).update(signedValue).digest());
  const imprintMatches = bytesEqual(recomputed, info.imprint);

  // The TSA's SignedData carries the TSTInfo as eContent; verify its signature
  // by digesting that eContent with the token's own digest algorithm.
  const tstInfoBytes = extractTstInfoBytes(token);
  const parsed = parseSignedData(token);
  const tstDigest = new Uint8Array(createHash(parsed.digestAlgorithm).update(tstInfoBytes).digest());
  const r = verifySignedData(token, tstDigest);
  const tokenSignatureValid = r.signatureValid && r.digestMatches;

  return {
    time: info.genTime,
    imprintMatches,
    tokenSignatureValid,
    valid: imprintMatches && tokenSignatureValid,
    policy: info.policy,
    serialNumber: info.serialNumber.toString(),
  };
}

// --- small helpers -------------------------------------------------------

function asciiOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Parse an ASN.1 GeneralizedTime (`YYYYMMDDHHMMSS[.fff]Z`) to a Date (UTC). */
function parseGeneralizedTime(s: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error(`rfc3161: unparseable GeneralizedTime "${s}"`);
  const [, Y, Mo, D, H, Mi, S, frac] = m;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S, ms));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
