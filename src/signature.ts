import { createHash } from 'node:crypto';
import { PdfObject, PdfDict, PdfString, isArray, isDict, isName, name } from './types.js';
import type { Document } from './document.js';
import { CmsSigner, CadesAttributes } from './cms.js';
import { parse } from './asn1.js';
import type { DigestAlgorithm } from './sigalg.js';
import type { TimestampProvider } from './rfc3161.js';

/** Digital-signature field/value-dict model and signing orchestration helpers
 *  shared by {@link Document.Sign}. The byte-level placeholder mechanics live in
 *  `sigplaceholder.ts`; the two write paths in `incremental.ts` (append) and
 *  `serializer.ts` (full rewrite); the CMS in `cms.ts`. This module owns the PDF
 *  signature *objects* (the `/Sig` value dictionary and the read-side view). */

/** Any accepted signer credential source — PEM, PKCS#12, an external callback,
 *  or a pre-resolved {@link CmsSigner}. Defined in `signer.ts`; re-exported here
 *  for back-compat. {@link resolveSigner} normalizes it to a {@link CmsSigner}. */
export type { Signer } from './signer.js';

/** A visible signature appearance request. When present on {@link SignOptions},
 *  the signature widget is placed at `rect` on page `page` (0-based) with a
 *  generated `/AP /N` Form XObject instead of the default zero-rect invisible
 *  widget. See `sigappearance.ts` for the rendering. */
export interface SignatureAppearance {
  /** 0-based page index to place the visible widget on. */
  page: number;
  /** Widget rectangle `[x1, y1, x2, y2]` in page (default) user space. */
  rect: [number, number, number, number];
  /** Override text. When omitted, a name/date/reason/location block is built
   *  from {@link SignOptions} (and the certificate subject when `name` is unset).
   *  Lines split on `\n`; long lines wrap to the box. */
  text?: string;
  /** Optional JPEG/PNG image bytes, drawn left of the text (or filling the box
   *  when there is no text). */
  image?: Uint8Array;
}

export interface SignOptions {
  /** Human-readable reason for signing (`/Reason`). */
  reason?: string;
  /** Signing location (`/Location`). */
  location?: string;
  /** Signer contact info (`/ContactInfo`). */
  contactInfo?: string;
  /** Signer name (`/Name`); defaults to the certificate subject when omitted. */
  name?: string;
  /** Signing time (`/M`); defaults to now. */
  signingTime?: Date;
  /** Signature flavour. `'CMS'` → `adbe.pkcs7.detached` (default). `'PAdES'`
   *  → `ETSI.CAdES.detached` (adds the ESS `signing-certificate-v2` signed
   *  attribute; combine with `timestamp` for PAdES-B-T). */
  subFilter?: 'CMS' | 'PAdES';
  /** Field name (`/T`); defaults to `Signature<n>`. */
  fieldName?: string;
  /** Reserved `/Contents` capacity in bytes. Default 8192. */
  placeholderBytes?: number;
  /** Render a visible signature widget (appearance) instead of the default
   *  invisible zero-rect one. */
  appearance?: SignatureAppearance;
  /** RFC 3161 timestamp provider. When set, the signature value is timestamped
   *  by this callback (typically a TSA over HTTP) and the token embedded as an
   *  unsigned `id-aa-timeStampToken` attribute (PAdES-B-T). */
  timestamp?: TimestampProvider;
  /** Digest algorithm for the timestamp message imprint. Default: the signer's
   *  digest algorithm. */
  timestampDigest?: DigestAlgorithm;
  /** Optional CAdES signed attributes (commitment-type, signer-location).
   *  Requires `subFilter: 'PAdES'`; throws otherwise. */
  cades?: CadesAttributes;
}

export type { CadesAttributes, CommitmentType, SignerLocation } from './cms.js';

/** DocMDP permitted-changes level for a certification signature (PDF 32000-1
 *  §12.8.2.2): the `/P` value in the DocMDP `/TransformParams`.
 *  - `no-changes` (P=1): no changes permitted; any change invalidates.
 *  - `form-fill` (P=2): form filling and signing allowed.
 *  - `form-fill-and-annotate` (P=3): the above plus annotation create/edit/delete. */
export type DocMdpPermission = 'no-changes' | 'form-fill' | 'form-fill-and-annotate';

/** Options for {@link Document.Certify}: a {@link SignOptions} plus the DocMDP
 *  permitted-changes level (default `no-changes`). */
export interface CertifyOptions extends SignOptions {
  /** Permitted changes after certification. Default `no-changes`. */
  permissions?: DocMdpPermission;
}

/** Options for {@link Document.AddDocumentTimestamp}. */
export interface DocumentTimestampOptions {
  /** Imprint hash algorithm for the timestamp request. Default `'sha256'`. */
  digest?: DigestAlgorithm;
  /** Reserved `/Contents` capacity in bytes. Default 16384 — the token embeds
   *  the TSA certificate, so the signature default is usually too small. */
  placeholderBytes?: number;
  /** Field name (`/T`); defaults to `Timestamp<n>`. */
  fieldName?: string;
}

/** The numeric `/P` for a {@link DocMdpPermission} (1/2/3). */
export function docMdpP(perm: DocMdpPermission): 1 | 2 | 3 {
  return perm === 'no-changes' ? 1 : perm === 'form-fill' ? 2 : 3;
}

/** Build a DocMDP signature reference dictionary (`/Type /SigRef`) for a
 *  certification signature's `/Reference` array. */
export function buildDocMdpReference(perm: DocMdpPermission): PdfDict {
  const params: PdfDict = new Map<string, PdfObject>([
    ['Type', name('TransformParams')],
    ['P', docMdpP(perm)],
    ['V', name('1.2')],
  ]);
  return new Map<string, PdfObject>([
    ['Type', name('SigRef')],
    ['TransformMethod', name('DocMDP')],
    ['TransformParams', params],
  ]);
}

/** Read-side view of a signature field (always available, like `doc.Form`). */
export interface SignatureField {
  /** Fully-qualified field name (`/T`). */
  name: string;
  /** `/SubFilter` value (e.g. `adbe.pkcs7.detached`), or `''` when unsigned. */
  subFilter: string;
  /** Whether the field carries a signature value (`/V` with `/Contents`). */
  isSigned: boolean;
  /** The signature value dictionary (`/Type /Sig`), empty when unsigned. */
  valueDict: PdfDict;
  /** `/ByteRange` `[0, a, b, c]` when signed. */
  byteRange?: [number, number, number, number];
  /** Raw `/Contents` bytes (zero-padded placeholder) when signed. */
  contents?: Uint8Array;
  /** Length of the actual CMS DER inside `contents` (excludes zero padding). */
  cmsLength?: number;
  /** Whether `/ByteRange` spans the entire file except the `/Contents` hole. */
  coversWholeFile: boolean;
  /** Whether this is a document timestamp (`/DocTimeStamp` / `ETSI.RFC3161`)
   *  rather than an approval/certification signature. */
  isDocTimeStamp: boolean;
}

/** Map the public `subFilter` option to its PDF `/SubFilter` name. */
export function subFilterName(opts: SignOptions): string {
  return opts.subFilter === 'PAdES' ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.detached';
}

/** Build the `/Sig` value dictionary (without `/ByteRange` or `/Contents`, which
 *  the writer fills). Includes `/M` and any provided `/Name`/`/Reason`/etc. */
export function buildSigValueDict(opts: SignOptions, signingTime: Date): PdfDict {
  const d: PdfDict = new Map<string, PdfObject>();
  d.set('Type', name('Sig'));
  d.set('Filter', name('Adobe.PPKLite'));
  d.set('SubFilter', name(subFilterName(opts)));
  if (opts.name) d.set('Name', pdfString(opts.name));
  if (opts.reason) d.set('Reason', pdfString(opts.reason));
  if (opts.location) d.set('Location', pdfString(opts.location));
  if (opts.contactInfo) d.set('ContactInfo', pdfString(opts.contactInfo));
  d.set('M', pdfString(pdfDate(signingTime)));
  return d;
}

/** A literal PDF string from a JS string (UTF-8 bytes; serializer escapes them). */
export function pdfString(s: string): PdfString {
  return { kind: 'string', bytes: new TextEncoder().encode(s) };
}

/** Format a `Date` as a PDF date string `D:YYYYMMDDHHmmSSZ` (UTC). */
export function pdfDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** SHA-256/384/512 digest of the two `/ByteRange` segments of `bytes`. */
export function digestByteRange(bytes: Uint8Array, byteRange: [number, number, number, number], alg: string): Uint8Array {
  const [, a, b, c] = byteRange;
  const h = createHash(alg);
  h.update(bytes.subarray(0, a));
  h.update(bytes.subarray(b, b + c));
  return new Uint8Array(h.digest());
}

/** The two `/ByteRange` segments of `bytes` concatenated (the companion to
 *  {@link digestByteRange}, which returns their hash). Used to verify a
 *  `/DocTimeStamp`, whose token message-imprint is over these raw bytes. */
export function byteRangeContent(bytes: Uint8Array, byteRange: [number, number, number, number]): Uint8Array {
  const [, a, b, c] = byteRange;
  const out = new Uint8Array(a + c);
  out.set(bytes.subarray(0, a), 0);
  out.set(bytes.subarray(b, b + c), a);
  return out;
}

/** Build the `/DocTimeStamp` value dictionary (without `/ByteRange` or
 *  `/Contents`, which the writer fills). A document timestamp is an RFC 3161
 *  token over the `/ByteRange`; it carries no `/M`/`/Reason`/etc. */
export function buildDocTimeStampDict(): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('DocTimeStamp')],
    ['Filter', name('Adobe.PPKLite')],
    ['SubFilter', name('ETSI.RFC3161')],
  ]);
}

/** node:crypto hash name for the signer's digest algorithm (default sha256). */
export function digestName(signer: CmsSigner): string {
  return signer.digestAlgorithm ?? 'sha256';
}

/** Total length of the first DER TLV in `bytes` (tag + length-of-length + content). */
export function derTotalLength(bytes: Uint8Array): number {
  // Reuse the ASN.1 parser: it records each node's raw encoding.
  return parse(bytes).raw.length;
}

/** True when the document carries any signature field. Optimizing or converting
 *  one would invalidate it, and `Save()` returns the cached signed bytes
 *  verbatim, so every change would be discarded silently. One owner for the
 *  question: `optimize.ts` and `grayconvert.ts` both ask it. */
export function hasSignatureField(doc: Document): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return false;
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return false;
  const stack = [...fields];
  const seen = new Set<PdfDict>();
  while (stack.length) {
    const f = doc.resolve(stack.pop()!);
    if (!isDict(f) || seen.has(f)) continue;
    seen.add(f);
    const ft = doc.resolve(f.get('FT'));
    if (isName(ft) && ft.name === 'Sig') return true;
    const kids = doc.resolve(f.get('Kids'));
    if (isArray(kids)) stack.push(...kids);
  }
  return false;
}
