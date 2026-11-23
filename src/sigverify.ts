import { X509Certificate } from 'node:crypto';
import { parseSignedData, verifySignedData, SignerLocation } from './cms.js';
import { verifyTimestampToken, type TimestampInfo } from './rfc3161.js';
import { checkRevocation, findIssuer, type RevocationMaterial } from './revocation.js';
import { verifyCertChain } from './chain.js';
import { readXref } from './xref.js';
import { digestByteRange, byteRangeContent, signatureRevisionEnd } from './signature.js';
import type { SignatureField } from './signature.js';
import { rethrowLimit } from './errors.js';
import type { UnsignedContentSummary } from './unsignedcontent.js';
import type { ShadowAnalysis } from './shadowanalysis.js';
import type { SignatureStructureFinding } from './sigstructure.js';

/** A fetcher for revocation material: given the target and its issuer (DER),
 *  return the OCSP response / CRL bytes, or undefined when none is available. */
export type RevocationFetcher =
  (cert: Uint8Array, issuer: Uint8Array) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

/** Options for {@link Document.VerifySignatures}. */
export interface VerifyOptions {
  /** Compare each verified signed revision's appearance with the current file. */
  shadowAnalysis?: boolean;
  /** Online OCSP fetch for the signer certificate (e.g. an HTTP call to the
   *  responder named in the cert's AIA extension). */
  getOCSP?: RevocationFetcher;
  /** Online CRL fetch for the signer certificate (e.g. from its CRL DP). */
  getCRL?: RevocationFetcher;
  /** Pre-collected offline material per signature, keyed by signature field
   *  name — e.g. the certs/OCSPs/CRLs read back from an embedded `/DSS`. */
  offline?: Map<string, RevocationMaterial>;
  /** Trusted root/intermediate certificates (DER). When supplied, each signer's
   *  certificate path is built and validated to one of these anchors and the
   *  result reported as `trusted`/`untrusted` (else `unchecked`). */
  trustAnchors?: Uint8Array[];
  /** Validation time for certificate validity-period checks when the signature
   *  has no verified timestamp. Defaults to the current time in that case. */
  at?: Date;
}

/** Chain-validation inputs threaded into {@link verifySignature}. */
export interface ChainCheckOptions {
  trustAnchors?: Uint8Array[];
  at?: Date;
  /** Extra intermediate certificates (e.g. read back from `/DSS`). */
  extraCerts?: Uint8Array[];
}

/** Signature verification core (V1): recompute the `/ByteRange` digest, verify
 *  the detached CMS, and diff what changed after each signature. Certificate
 *  chain validation (V2), revocation (V3), and timestamps (T1) layer on top;
 *  `/DocMDP` enforcement (V4) is evaluated document-wide in
 *  {@link Document.VerifySignatures} (see `docmdp.ts`). */

/** Summary of the signer's X.509 certificate. */
export interface CertInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}

/** One object that changed in a revision added after a signature. */
export interface Change {
  /** Object number that was added or replaced after the signature. */
  object: number;
  change: 'added' | 'modified';
}

export interface SignatureReport {
  /** Signature field name (`/T`). */
  name: string;
  /** Whether the `/ByteRange` digest matches the CMS `messageDigest` attribute. */
  integrity: 'valid' | 'tampered';
  /** Whether the CMS signature over the signed attributes verifies. */
  signature: 'valid' | 'invalid';
  /** Whether `/ByteRange` spans the whole file (no later incremental revision). */
  coversWholeFile: boolean;
  /** Objects added/modified in revisions appended after this signature. */
  modifications: Change[];
  /** Structural findings for this signature and its claimed coverage. */
  structureFindings: SignatureStructureFinding[];
  /** Content attribution for the latest signature with a usable signed range,
   *  when its digest and CMS signature both verify. */
  unsignedContent?: UnsignedContentSummary;
  /** Appearance comparison when requested and the signed revision is available. */
  shadowAnalysis?: ShadowAnalysis;
  /** Certificate-chain trust against the supplied anchors. */
  chain: 'trusted' | 'untrusted' | 'unchecked';
  /** Revocation status from caller-supplied or embedded validation material. */
  revocation: 'good' | 'revoked' | 'unknown' | 'unchecked';
  /** `/DocMDP` permitted-changes verdict for a certification signature or an
   *  approval signature with a document lock level. `ok` means the subsequent
   *  changes stay within the level, `violated` means one exceeds it, and `n/a`
   *  means no level was evaluated. */
  docMDP: 'ok' | 'violated' | 'n/a';
  /** Field-lock (`/FieldMDP`) verdict for a signature whose field carried a
   *  `/Lock`: `violated` when a field the lock freezes was changed or removed in
   *  a revision appended after this signature, `ok` when none was, `n/a` when
   *  the signature carries no FieldMDP transform. Filling an UNSIGNED signature
   *  field is exempt, so a lock does not forbid the signatures that follow it. */
  fieldMDP: 'ok' | 'violated' | 'n/a';
  /** The full names of the locked fields that changed, when `fieldMDP` was
   *  evaluated. */
  lockedFieldsChanged?: string[];
  /** RFC 3161 signature-timestamp verdict (time + imprint/TSA-signature checks),
   *  present only when the signature carries an `id-aa-timeStampToken`. */
  timestamp?: TimestampInfo;
  /** The signer's certificate summary, when the CMS could be parsed. */
  signerCert?: CertInfo;
  /** CAdES commitment-type (friendly name or OID), when the signature carries it. */
  commitmentType?: string;
  /** CAdES signer-location, when the signature carries it. */
  signerLocation?: SignerLocation;
  /** PAdES baseline level of this signature (structural presence, not trust):
   *  `B-B` (basic) → `B-T` (verified timestamp token) → `B-LT` (long-term validation data)
   *  → `B-LTA` (archive timestamp). Undefined when not classified. */
  padesLevel?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
}

/** Verify one signed signature field against the full file `bytes`. Assumes
 *  `sig.isSigned` (i.e. `byteRange` and `contents` are present). When
 *  `chain.trustAnchors` is supplied, the signer's certificate path is validated
 *  to an anchor and reported in `chain`. */
export function verifySignature(
  bytes: Uint8Array, sig: SignatureField, chain: ChainCheckOptions = {},
): SignatureReport {
  const base: SignatureReport = {
    name: sig.name,
    integrity: 'tampered',
    signature: 'invalid',
    coversWholeFile: sig.coversWholeFile,
    modifications: [],
    structureFindings: [],
    chain: 'unchecked',
    revocation: 'unchecked',
    docMDP: 'n/a',
    fieldMDP: 'n/a',
  };
  if (!sig.byteRange || !sig.contents) return base;
  const signedEnd = signatureRevisionEnd(sig.byteRange, bytes.length);

  const cms = sig.cmsLength !== undefined ? sig.contents.subarray(0, sig.cmsLength) : sig.contents;
  try {
    const parsed = parseSignedData(cms);
    const expectedDigest = signedEnd === undefined ? undefined : digestByteRange(bytes, sig.byteRange, parsed.digestAlgorithm);
    const res = verifySignedData(cms, expectedDigest);
    base.integrity = res.digestMatches ? 'valid' : 'tampered';
    base.signature = res.signatureValid ? 'valid' : 'invalid';
    base.signerCert = certInfo(res.signerCertificate);
    base.commitmentType = parsed.commitmentType;
    base.signerLocation = parsed.signerLocation;
    // RFC 3161 signature timestamp, when embedded as an unsigned attribute.
    if (parsed.timestampToken) {
      try { base.timestamp = verifyTimestampToken(parsed.timestampToken, parsed.signature); }
      catch (caught) { rethrowLimit(caught); /* malformed token: omit the timestamp verdict */ }
    }
    // Certificate-path validation to the caller's trust anchors (V2).
    if (chain.trustAnchors && chain.trustAnchors.length) {
      const at = base.timestamp?.valid ? base.timestamp.time : chain.at;
      const pool = [...parsed.certificates, ...(chain.extraCerts ?? [])];
      base.chain = verifyCertChain(parsed.signerCertificate, pool, { trustAnchors: chain.trustAnchors, at }).status;
    }
  } catch (caught) { rethrowLimit(caught);
    return base; // unparseable CMS -> invalid/tampered
  }

  if (signedEnd !== undefined && signedEnd < bytes.length)
    base.modifications = revisionChanges(bytes, signedEnd);
  return base;
}

/** Verdict for one document timestamp (`/DocTimeStamp`): the RFC 3161 token's
 *  time and imprint/TSA-signature checks, plus coverage and the TSA cert. */
export interface DocumentTimestampReport {
  /** Timestamp field name (`/T`). */
  name: string;
  /** RFC 3161 verdict: `time`, `imprintMatches`, `tokenSignatureValid`, `valid`. */
  timestamp: TimestampInfo;
  /** Whether the `/ByteRange` spans the whole file (no later revision). */
  coversWholeFile: boolean;
  /** Objects added/modified in revisions appended after this timestamp. */
  modifications: Change[];
  /** Structural findings for this timestamp and its claimed coverage. */
  structureFindings: SignatureStructureFinding[];
  /** The TSA's certificate summary, when the token could be parsed. */
  signerCert?: CertInfo;
}

/** Verify one signed `/DocTimeStamp` field against the full file `bytes`:
 *  recompute the `/ByteRange` content, check the token's message-imprint binding
 *  and the TSA's CMS signature, and diff what changed after the timestamp.
 *  Assumes `sig.isDocTimeStamp` and that `byteRange`/`contents` are present. */
export function verifyDocumentTimestamp(bytes: Uint8Array, sig: SignatureField): DocumentTimestampReport {
  const failed: TimestampInfo = {
    time: new Date(0), imprintMatches: false, tokenSignatureValid: false,
    valid: false, policy: '', serialNumber: '',
  };
  const report: DocumentTimestampReport = {
    name: sig.name, timestamp: failed, coversWholeFile: sig.coversWholeFile,
    modifications: [], structureFindings: [],
  };
  if (!sig.byteRange || !sig.contents) return report;
  const signedEnd = signatureRevisionEnd(sig.byteRange, bytes.length);

  const token = sig.cmsLength !== undefined ? sig.contents.subarray(0, sig.cmsLength) : sig.contents;
  try {
    const signedBytes = signedEnd === undefined ? undefined : byteRangeContent(bytes, sig.byteRange);
    report.timestamp = verifyTimestampToken(token, signedBytes);
  } catch (caught) { rethrowLimit(caught);
    // malformed token: keep the failed verdict
  }
  try {
    report.signerCert = certInfo(parseSignedData(token).signerCertificate);
  } catch (caught) { rethrowLimit(caught);
    // no signer cert available
  }

  if (signedEnd !== undefined && signedEnd < bytes.length)
    report.modifications = revisionChanges(bytes, signedEnd);
  return report;
}

/** Objects whose newest definition lies beyond `signedEnd` — i.e. written in a
 *  revision appended after the signature — tagged `added` or `modified`. */
function revisionChanges(bytes: Uint8Array, signedEnd: number): Change[] {
  let full: ReturnType<typeof readXref>['entries'];
  try {
    full = readXref(bytes).entries;
  } catch (caught) { rethrowLimit(caught);
    return [];
  }
  let revivable: typeof full;
  try {
    revivable = readXref(bytes.subarray(0, signedEnd)).entries;
  } catch (caught) { rethrowLimit(caught);
    return [];
  }
  const changes: Change[] = [];
  for (const [num, entry] of full) {
    if (entry.type !== 'offset') continue;
    if (entry.offset >= signedEnd)
      changes.push({ object: num, change: revivable.has(num) ? 'modified' : 'added' });
  }
  changes.sort((a, b) => a.object - b.object);
  return changes;
}

/** Determine the revocation status of one signed field's signer certificate
 *  from `opts` (offline `/DSS` material and/or online OCSP/CRL callbacks).
 *  Returns the {@link SignatureReport.revocation} verdict. */
export async function checkSignatureRevocation(
  sig: SignatureField, opts: VerifyOptions,
): Promise<SignatureReport['revocation']> {
  if (!sig.contents) return 'unchecked';
  let signer: Uint8Array, issuer: Uint8Array;
  try {
    const cms = sig.cmsLength !== undefined ? sig.contents.subarray(0, sig.cmsLength) : sig.contents;
    const parsed = parseSignedData(cms);
    signer = parsed.signerCertificate;
    issuer = findIssuer(signer, parsed.certificates);
  } catch (caught) { rethrowLimit(caught);
    return 'unchecked';
  }

  const material: RevocationMaterial = { ...(opts.offline?.get(sig.name) ?? {}) };
  if (!material.ocsp && opts.getOCSP) material.ocsp = (await opts.getOCSP(signer, issuer)) ?? undefined;
  if (!material.crl && opts.getCRL) material.crl = (await opts.getCRL(signer, issuer)) ?? undefined;
  return checkRevocation(signer, issuer, material).status;
}

function certInfo(der: Uint8Array): CertInfo {
  const c = new X509Certificate(Buffer.from(der));
  return {
    subject: c.subject,
    issuer: c.issuer,
    serialNumber: c.serialNumber,
    notBefore: new Date(c.validFrom),
    notAfter: new Date(c.validTo),
  };
}
