/** The signature field seed value dictionary (`/SV`, 32000-1 12.7.4.5): what a
 *  document states a valid signature in a given field must look like.
 *
 *  A pure LEAF over `types.js` and `metadata.js`'s text-string codec, taking
 *  `resolve` as an argument, so every rule is drivable from hand-built dicts
 *  with no PDF built. This module WRITES and READS; it attaches no meaning.
 *  Enforcing a seed value when signing is a separate decision (`puep.3`).
 *
 *  The vocabulary is transcribed rather than recalled. The `/Ff` bits are
 *  PDFBox's `PDSeedValue.FLAG_*` (bits 1-7) and pyHanko's `SigSeedValFlags`
 *  (the same seven plus LockDocument 128 and AppearanceFilter 256, PDF 2.0).
 *
 *  Note the one place the anchors DISAGREE: `/MDP /P 0`. Adobe's own seed-value
 *  documentation and pyHanko read it as an ordinary APPROVAL signature
 *  (pyHanko: `P == 0` -> "an approval signature (i.e. a non-certification
 *  signature)"); PDFBox's javadoc calls it an "author signature". We follow the
 *  two that agree, and the public type spells the answer as a word
 *  (`'approval'`) so no caller has to know which reading 0 carries. */
import { PdfDict, PdfObject, isArray, isDict, isName, isString, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import type { DocMdpPermission } from './signature.js';
import type { DigestAlgorithm } from './sigalg.js';
import { SeedValueError } from './errors.js';

/** An acceptable `/DigestMethod` (Table 234's list). */
export type SeedDigestMethod = 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512' | 'RIPEMD160';

/** `/LockDocument` (PDF 2.0): whether the signer should lock the document. */
export type SeedLockDocument = 'true' | 'false' | 'auto';

/** The seed-value entries that have a `/Ff` bit, and so can be made BINDING.
 *  `mdp` is absent because `/MDP` has no bit and always binds; `timestamp` is
 *  absent because its requirement flag lives inside its own dictionary. */
export type SeedRequirement =
  | 'filter' | 'subFilter' | 'v' | 'reasons' | 'legalAttestation'
  | 'addRevInfo' | 'digestMethod' | 'lockDocument' | 'appearanceFilter';

/** A signature field seed value. Every entry is optional and ADVISORY unless
 *  named in `required`, which is written as the `/Ff` bits. */
export interface SeedValue {
  /** `/Filter`: the signature handler to use (e.g. `Adobe.PPKLite`). */
  filter?: string;
  /** `/SubFilter`: acceptable encodings, most preferred first. */
  subFilter?: string[];
  /** `/DigestMethod`: acceptable digest algorithms. */
  digestMethod?: SeedDigestMethod[];
  /** `/V`: the minimum seed-value processor capability required. */
  v?: number;
  /** `/Reasons`: acceptable reasons for signing, stored verbatim. */
  reasons?: string[];
  /** `/LegalAttestation`: acceptable legal attestations. */
  legalAttestation?: string[];
  /** `/AppearanceFilter` (PDF 2.0): a named appearance to sign with. */
  appearanceFilter?: string;
  /** `/AddRevInfo`: whether revocation information should be embedded. */
  addRevInfo?: boolean;
  /** `/LockDocument` (PDF 2.0). */
  lockDocument?: SeedLockDocument;
  /** `/MDP /P`: the kind of signature this field is for — an ordinary
   *  `'approval'` signature (P 0) or a certification at the given DocMDP level
   *  (P 1-3). It has no `/Ff` bit and always binds. */
  mdp?: 'approval' | DocMdpPermission;
  /** `/TimeStamp`: the authority to timestamp through, and whether a timestamp
   *  is mandatory (its own `/Ff` bit 1). */
  timestamp?: { url: string; required?: boolean };
  /** `/Cert`: constraints on the signer's CERTIFICATE (`puep.6`). Recorded
   *  and read back; not evaluated when signing, since the caller supplies the
   *  credentials directly. */
  cert?: SeedCertValue;
  /** The entries that BIND (`/Ff`). Each must also be stated above. */
  required?: SeedRequirement[];
}

/** An RFC 5280 key usage, in the bit order a `/KeyUsage` string follows. */
export type KeyUsageName =
  | 'digitalSignature' | 'nonRepudiation' | 'keyEncipherment' | 'dataEncipherment'
  | 'keyAgreement' | 'keyCertSign' | 'cRLSign' | 'encipherOnly' | 'decipherOnly';

/** The certificate seed value entries that have a `/Cert /Ff` bit. `/OID`
 *  (bit 4) is not modelled — see {@link SeedCertValue}. */
export type SeedCertRequirement = 'subject' | 'issuer' | 'subjectDN' | 'keyUsage' | 'url';

/** A certificate seed value (`/Cert`, `/Type /SVCert`, 32000-1 Table 235).
 *  Every entry is ADVISORY unless named in `required`, its own `/Ff`.
 *
 *  `/OID` — certificate-policy OIDs — is deliberately NOT modelled: the spec
 *  says "byte strings containing OIDs" without saying whether that is DER or
 *  dotted text, pyHanko marks it unsupported, and a guessed encoding fails to
 *  interoperate silently. The reader drops it and its bit. */
export interface SeedCertValue {
  /** `/Subject`: the certificates (DER) allowed to sign. */
  subject?: Uint8Array[];
  /** `/Issuer`: issuer certificates (DER) the signer's must chain to. */
  issuer?: Uint8Array[];
  /** `/SubjectDN`: distinguished-name attribute sets, e.g. `{ CN, O }`. */
  subjectDN?: Record<string, string>[];
  /** `/KeyUsage`: acceptable key-usage profiles, each a set of usages the
   *  certificate must have and a set it must not; the rest are unconstrained. */
  keyUsage?: { required?: KeyUsageName[]; forbidden?: KeyUsageName[] }[];
  /** `/URL`: where to get a suitable certificate. */
  url?: string;
  /** `/URLType`: how to open `url` (a name; `Browser` is the spec default). */
  urlType?: string;
  /** The entries that BIND (`/Cert /Ff`). Each must also be stated above. */
  required?: SeedCertRequirement[];
}

/** `/Cert /Ff` bits, pyHanko's `SigCertConstraintFlags`: subject 1, issuer 2,
 *  OID 4 (unmodelled), subjectDN 8, reserved 16, keyUsage 32, URL 64. */
const CERT_FF_BITS: ReadonlyArray<readonly [SeedCertRequirement, number]> = [
  ['subject', 1],
  ['issuer', 2],
  ['subjectDN', 8],
  ['keyUsage', 32],
  ['url', 64],
];

/** RFC 5280 KeyUsage bit order: position i of a `/KeyUsage` string is bit i. */
const KEY_USAGES: readonly KeyUsageName[] = [
  'digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment',
  'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly',
];

/** `/Ff` bit for each bindable entry. Order is the bit order, which is also
 *  the order `required` reads back in. */
const FF_BITS: ReadonlyArray<readonly [SeedRequirement, number]> = [
  ['filter', 1],
  ['subFilter', 2],
  ['v', 4],
  ['reasons', 8],
  ['legalAttestation', 16],
  ['addRevInfo', 32],
  ['digestMethod', 64],
  ['lockDocument', 128],
  ['appearanceFilter', 256],
];

const DIGESTS: readonly SeedDigestMethod[] = ['SHA1', 'SHA256', 'SHA384', 'SHA512', 'RIPEMD160'];
const LOCKS: readonly SeedLockDocument[] = ['true', 'false', 'auto'];
const MDP_BY_P = ['approval', 'no-changes', 'form-fill', 'form-fill-and-annotate'] as const;

const text = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

function checkName(key: string, v: unknown): string {
  if (typeof v !== 'string') throw new TypeError(`seedValue.${key} must be a string`);
  if (v === '') throw new RangeError(`seedValue.${key} must not be empty`);
  return v;
}

function checkStrings(key: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))
    throw new TypeError(`seedValue.${key} must be an array of strings`);
  return v as string[];
}

/** Validate `sv` and build its `/SV` dictionary. Throws — `TypeError` for the
 *  wrong kind of thing, `RangeError` for a value outside its allowed set —
 *  and allocates nothing, so a caller validating before it mutates leaves a
 *  rejected document byte-identical.
 *
 *  Written: `/Type /SV`, then each stated entry. `/Ff` only when something
 *  binds, and `/V` only when stated: a document says what its author said,
 *  never a version this library computed. */
export function encodeSeedValue(sv: SeedValue): PdfDict {
  if (typeof sv !== 'object' || sv === null || Array.isArray(sv))
    throw new TypeError('seedValue must be an object');
  const d: PdfDict = new Map<string, PdfObject>([['Type', name('SV')]]);

  if (sv.filter !== undefined) d.set('Filter', name(checkName('filter', sv.filter)));
  if (sv.subFilter !== undefined) {
    const list = checkStrings('subFilter', sv.subFilter);
    if (list.length === 0) throw new RangeError('seedValue.subFilter must not be empty');
    d.set('SubFilter', list.map((s) => name(checkName('subFilter', s))));
  }
  if (sv.digestMethod !== undefined) {
    const list = checkStrings('digestMethod', sv.digestMethod);
    if (list.length === 0) throw new RangeError('seedValue.digestMethod must not be empty');
    for (const m of list)
      if (!DIGESTS.includes(m as SeedDigestMethod))
        throw new RangeError(`seedValue.digestMethod '${m}' must be one of ${DIGESTS.join(', ')}`);
    d.set('DigestMethod', list.map((m) => name(m)));
  }
  if (sv.v !== undefined) {
    if (typeof sv.v !== 'number') throw new TypeError('seedValue.v must be a number');
    if (!Number.isInteger(sv.v) || sv.v < 1) throw new RangeError('seedValue.v must be a positive integer');
    d.set('V', sv.v);
  }
  if (sv.reasons !== undefined) d.set('Reasons', checkStrings('reasons', sv.reasons).map(text));
  if (sv.legalAttestation !== undefined)
    d.set('LegalAttestation', checkStrings('legalAttestation', sv.legalAttestation).map(text));
  if (sv.appearanceFilter !== undefined)
    d.set('AppearanceFilter', text(checkName('appearanceFilter', sv.appearanceFilter)));
  if (sv.addRevInfo !== undefined) {
    if (typeof sv.addRevInfo !== 'boolean') throw new TypeError('seedValue.addRevInfo must be a boolean');
    d.set('AddRevInfo', sv.addRevInfo);
  }
  if (sv.lockDocument !== undefined) {
    if (!LOCKS.includes(sv.lockDocument))
      throw new RangeError(`seedValue.lockDocument must be one of ${LOCKS.join(', ')}`);
    d.set('LockDocument', name(sv.lockDocument));
  }
  if (sv.mdp !== undefined) {
    const p = (MDP_BY_P as readonly string[]).indexOf(sv.mdp);
    if (p < 0) throw new RangeError(`seedValue.mdp must be one of ${MDP_BY_P.join(', ')}`);
    d.set('MDP', new Map<string, PdfObject>([['P', p]]));
  }
  if (sv.timestamp !== undefined) {
    const ts = sv.timestamp;
    if (typeof ts !== 'object' || ts === null) throw new TypeError('seedValue.timestamp must be an object');
    const url = checkName('timestamp.url', ts.url);
    if (ts.required !== undefined && typeof ts.required !== 'boolean')
      throw new TypeError('seedValue.timestamp.required must be a boolean');
    const t: PdfDict = new Map<string, PdfObject>([['URL', text(url)]]);
    if (ts.required) t.set('Ff', 1);
    d.set('TimeStamp', t);
  }

  if (sv.cert !== undefined) d.set('Cert', encodeSeedCert(sv.cert));

  if (sv.required !== undefined) {
    if (!Array.isArray(sv.required)) throw new TypeError('seedValue.required must be an array');
    let ff = 0;
    for (const r of sv.required) {
      const bit = FF_BITS.find(([k]) => k === r);
      if (!bit)
        throw new RangeError(`seedValue.required: '${String(r)}' has no /Ff bit (one of ${FF_BITS.map(([k]) => k).join(', ')})`);
      if (ff & bit[1]) throw new RangeError(`seedValue.required names '${r}' twice`);
      // Requiring a constraint the seed value does not state binds nothing.
      if (sv[r] === undefined) throw new RangeError(`seedValue.required names '${r}', which is not set`);
      ff |= bit[1];
    }
    if (ff !== 0) d.set('Ff', ff);
  }
  return d;
}

/** A certificate list: raw DER as a BYTE string, never a text string. */
function checkCerts(key: string, v: unknown): PdfObject[] {
  if (!Array.isArray(v) || v.some((c) => !(c instanceof Uint8Array)))
    throw new TypeError(`seedValue.cert.${key} must be an array of DER certificates (Uint8Array)`);
  if (v.length === 0) throw new RangeError(`seedValue.cert.${key} must not be empty`);
  if (v.some((c: Uint8Array) => c.length === 0)) throw new RangeError(`seedValue.cert.${key} holds an empty certificate`);
  return v.map((c: Uint8Array) => ({ kind: 'string', bytes: new Uint8Array(c) }));
}

/** Validate and build a `/Cert` dictionary. Same posture as the seed value
 *  around it: throws, allocates nothing, states only what was given. */
function encodeSeedCert(cert: SeedCertValue): PdfDict {
  if (typeof cert !== 'object' || cert === null || Array.isArray(cert))
    throw new TypeError('seedValue.cert must be an object');
  const d: PdfDict = new Map<string, PdfObject>([['Type', name('SVCert')]]);
  if (cert.subject !== undefined) d.set('Subject', checkCerts('subject', cert.subject));
  if (cert.issuer !== undefined) d.set('Issuer', checkCerts('issuer', cert.issuer));
  if (cert.subjectDN !== undefined) {
    if (!Array.isArray(cert.subjectDN) || cert.subjectDN.length === 0)
      throw new RangeError('seedValue.cert.subjectDN must be a non-empty array');
    d.set('SubjectDN', cert.subjectDN.map((dn) => {
      if (typeof dn !== 'object' || dn === null) throw new TypeError('seedValue.cert.subjectDN entries must be objects');
      const entries = Object.entries(dn);
      if (entries.length === 0) throw new RangeError('seedValue.cert.subjectDN entries must not be empty');
      return new Map<string, PdfObject>(entries.map(([k, v]) => {
        if (k === '') throw new RangeError('seedValue.cert.subjectDN attribute names must not be empty');
        if (typeof v !== 'string') throw new TypeError(`seedValue.cert.subjectDN.${k} must be a string`);
        return [k, text(v)] as [string, PdfObject];
      }));
    }));
  }
  if (cert.keyUsage !== undefined) {
    if (!Array.isArray(cert.keyUsage) || cert.keyUsage.length === 0)
      throw new RangeError('seedValue.cert.keyUsage must be a non-empty array');
    d.set('KeyUsage', cert.keyUsage.map((ku) => text(keyUsageString(ku))));
  }
  if (cert.url !== undefined) d.set('URL', text(checkName('cert.url', cert.url)));
  if (cert.urlType !== undefined) {
    if (cert.url === undefined) throw new RangeError('seedValue.cert.urlType needs a url');
    d.set('URLType', name(checkName('cert.urlType', cert.urlType)));
  }
  if (cert.required !== undefined) {
    if (!Array.isArray(cert.required)) throw new TypeError('seedValue.cert.required must be an array');
    let ff = 0;
    for (const r of cert.required) {
      const bit = CERT_FF_BITS.find(([k]) => k === r);
      if (!bit)
        throw new RangeError(`seedValue.cert.required: '${String(r)}' has no supported /Ff bit (one of ${CERT_FF_BITS.map(([k]) => k).join(', ')})`);
      if (ff & bit[1]) throw new RangeError(`seedValue.cert.required names '${r}' twice`);
      if (cert[r] === undefined) throw new RangeError(`seedValue.cert.required names '${r}', which is not set`);
      ff |= bit[1];
    }
    if (ff !== 0) d.set('Ff', ff);
  }
  return d;
}

/** A key-usage profile as Table 235's string: one character per RFC 5280 bit,
 *  `1` must have, `0` must not have, `X` unconstrained. */
function keyUsageString(ku: { required?: KeyUsageName[]; forbidden?: KeyUsageName[] }): string {
  if (typeof ku !== 'object' || ku === null) throw new TypeError('seedValue.cert.keyUsage entries must be objects');
  const req = ku.required ?? [], forb = ku.forbidden ?? [];
  if (!Array.isArray(req) || !Array.isArray(forb))
    throw new TypeError('seedValue.cert.keyUsage required/forbidden must be arrays');
  if (req.length === 0 && forb.length === 0)
    throw new RangeError('seedValue.cert.keyUsage entries must require or forbid something');
  for (const u of [...req, ...forb])
    if (!KEY_USAGES.includes(u)) throw new RangeError(`unknown key usage '${String(u)}' (one of ${KEY_USAGES.join(', ')})`);
  for (const u of req) if (forb.includes(u)) throw new RangeError(`key usage '${u}' is both required and forbidden`);
  return KEY_USAGES.map((u) => (req.includes(u) ? '1' : forb.includes(u) ? '0' : 'X')).join('');
}

/** Read a `/KeyUsage` string back. Only the first nine characters count and a
 *  missing position is unconstrained (pyHanko's reading); a character other
 *  than 0, 1 or X makes the string unreadable. */
function readKeyUsage(s: string): { required?: KeyUsageName[]; forbidden?: KeyUsageName[] } | undefined {
  const chars = s.slice(0, KEY_USAGES.length);
  if (!/^[01X]*$/.test(chars)) return undefined;
  const required: KeyUsageName[] = [], forbidden: KeyUsageName[] = [];
  [...chars].forEach((c, i) => { if (c === '1') required.push(KEY_USAGES[i]); else if (c === '0') forbidden.push(KEY_USAGES[i]); });
  return { ...(required.length ? { required } : {}), ...(forbidden.length ? { forbidden } : {}) };
}

/** Read a `/Cert` dictionary, leniently — the reader's posture for `/SV`. */
function readSeedCert(resolve: (o: PdfObject) => PdfObject, raw: PdfObject): SeedCertValue | undefined {
  const d = resolve(raw);
  if (!isDict(d)) return undefined;
  const get = (k: string) => (d.has(k) ? resolve(d.get(k) ?? null) : undefined);
  const out: SeedCertValue = {};
  const certs = (v: PdfObject | undefined): Uint8Array[] | undefined => {
    if (!isArray(v)) return undefined;
    const items = v.map(resolve);
    return items.every(isString) && items.length > 0 ? items.map((s) => new Uint8Array(s.bytes)) : undefined;
  };
  const subject = certs(get('Subject'));
  if (subject) out.subject = subject;
  const issuer = certs(get('Issuer'));
  if (issuer) out.issuer = issuer;
  const dn = get('SubjectDN');
  if (isArray(dn)) {
    const sets = dn.map(resolve).map((e) => {
      if (!isDict(e) || e.size === 0) return undefined;
      const rec: Record<string, string> = {};
      for (const [k, v] of e) {
        const r = resolve(v);
        if (!isString(r)) return undefined;
        rec[k] = decodePdfText(r.bytes);
      }
      return rec;
    });
    const good = sets.filter((s): s is Record<string, string> => s !== undefined);
    if (good.length > 0) out.subjectDN = good;
  }
  const ku = get('KeyUsage');
  if (isArray(ku)) {
    const good = ku.map(resolve).flatMap((s) => {
      const r = isString(s) ? readKeyUsage(decodePdfText(s.bytes)) : undefined;
      return r === undefined ? [] : [r];
    });
    if (good.length > 0) out.keyUsage = good;
  }
  const url = get('URL');
  if (isString(url)) {
    out.url = decodePdfText(url.bytes);
    const ut = get('URLType');
    if (isName(ut)) out.urlType = ut.name;
  }
  const ff = get('Ff');
  if (typeof ff === 'number') {
    const req = CERT_FF_BITS.filter(([, bit]) => (ff & bit) !== 0).map(([k]) => k);
    if (req.length > 0) out.required = req;
  }
  return out;
}

/** Read a seed value dictionary, typed. LENIENT: an entry of the wrong type,
 *  a name outside its set, or an array holding anything but its element type
 *  reads as absent, and `/Ff` bits nobody has defined are dropped — so a
 *  damaged or foreign `/SV` degrades rather than throws (`GetXmp`'s rule).
 *  Reports only what the dictionary STATES: nothing is defaulted.
 *
 *  `/DigestMethod` is read as names OR strings, case-folded: the spec says
 *  names, and pyHanko writes strings. We always write names. */
export function readSeedValue(
  resolve: (o: PdfObject) => PdfObject, raw: PdfObject,
): SeedValue | undefined {
  const d = resolve(raw);
  if (!isDict(d)) return undefined;
  const out: SeedValue = {};
  const get = (k: string) => (d.has(k) ? resolve(d.get(k) ?? null) : undefined);

  const names = (v: PdfObject | undefined): string[] | undefined => {
    if (!isArray(v)) return undefined;
    const items = v.map(resolve);
    return items.every(isName) ? items.map((n) => n.name) : undefined;
  };
  const texts = (v: PdfObject | undefined): string[] | undefined => {
    if (!isArray(v)) return undefined;
    const items = v.map(resolve);
    return items.every(isString) ? items.map((s) => decodePdfText(s.bytes)) : undefined;
  };

  const filter = get('Filter');
  if (isName(filter)) out.filter = filter.name;
  const sub = names(get('SubFilter'));
  if (sub) out.subFilter = sub;
  const dm = get('DigestMethod');
  if (isArray(dm)) {
    const list = dm.map(resolve).flatMap((o): SeedDigestMethod[] => {
      const s = isName(o) ? o.name : isString(o) ? decodePdfText(o.bytes) : undefined;
      const up = s?.toUpperCase();
      return up !== undefined && DIGESTS.includes(up as SeedDigestMethod) ? [up as SeedDigestMethod] : [];
    });
    if (list.length > 0) out.digestMethod = list;
  }
  const v = get('V');
  if (typeof v === 'number') out.v = v;
  const reasons = texts(get('Reasons'));
  if (reasons) out.reasons = reasons;
  const legal = texts(get('LegalAttestation'));
  if (legal) out.legalAttestation = legal;
  const af = get('AppearanceFilter');
  if (isString(af)) out.appearanceFilter = decodePdfText(af.bytes);
  const ari = get('AddRevInfo');
  if (typeof ari === 'boolean') out.addRevInfo = ari;
  const lock = get('LockDocument');
  if (isName(lock) && LOCKS.includes(lock.name as SeedLockDocument))
    out.lockDocument = lock.name as SeedLockDocument;
  const mdp = get('MDP');
  if (isDict(mdp)) {
    const p = resolve(mdp.get('P') ?? null);
    if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 3) out.mdp = MDP_BY_P[p];
  }
  const ts = get('TimeStamp');
  if (isDict(ts)) {
    const url = resolve(ts.get('URL') ?? null);
    const ff = resolve(ts.get('Ff') ?? null);
    if (isString(url))
      out.timestamp = { url: decodePdfText(url.bytes), required: typeof ff === 'number' && (ff & 1) === 1 };
  }
  if (d.has('Cert')) {
    const cert = readSeedCert(resolve, d.get('Cert') ?? null);
    if (cert !== undefined) out.cert = cert;
  }
  const ff = get('Ff');
  if (typeof ff === 'number') {
    const req = FF_BITS.filter(([, bit]) => (ff & bit) !== 0).map(([k]) => k);
    if (req.length > 0) out.required = req;
  }
  return out;
}

/** What a signing call brings to a seed value: the facts `planSeedValue`
 *  checks against. An UNSTATED choice is `undefined`, which is what lets the
 *  seed value supply it — a stated one is the caller's and is only checked. */
export interface SeedRequest {
  /** `Certify` (true) or `Sign` (false). */
  certify: boolean;
  /** The DocMDP level `Certify` was asked for, when it was asked for one. */
  permissions?: DocMdpPermission;
  /** The `SignOptions.subFilter` the caller stated. */
  subFilter?: 'CMS' | 'PAdES';
  /** The digest the signer stated (`SignerOptions.digestAlgorithm`). */
  digest?: DigestAlgorithm;
  /** The `/Reason` the caller gives. */
  reason?: string;
  /** Whether the caller supplied its own timestamp provider. */
  hasTimestamp: boolean;
  /** The level the field's own `/Lock /P` already sets, if any (`puep.7`). */
  lockPermissions?: DocMdpPermission;
}

/** What signing takes FROM a seed value: each is set only where the seed value
 *  decided something the caller left open. */
export interface SeedPlan {
  subFilter?: 'CMS' | 'PAdES';
  digest?: DigestAlgorithm;
  permissions?: DocMdpPermission;
  /** The `/TimeStamp /URL` to call: a REQUIRED timestamp with no caller TSA. */
  timestampUrl?: string;
  /** The `/Lock /P` level an APPROVAL signature must write into the field,
   *  because a required `/LockDocument` asks for one the field does not set. */
  lockPermissions?: DocMdpPermission;
}

const SUBFILTER_OPT: Record<string, 'CMS' | 'PAdES'> = {
  'adbe.pkcs7.detached': 'CMS',
  'ETSI.CAdES.detached': 'PAdES',
};
const DIGEST_OPT: Partial<Record<SeedDigestMethod, DigestAlgorithm>> = {
  SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512',
};
/** The highest `/V` understood: 3 is PDF 2.0 (pyHanko's `SeedValueDictVersion`). */
const MAX_V = 3;

/** Decide how a signing call honours a seed value, or refuse with a
 *  {@link SeedValueError} naming the entry. Pure: no document, no signer.
 *
 *  A REQUIRED entry the call cannot honour is a refusal — signing around a
 *  constraint the document states is worse than declining. An ADVISORY entry
 *  never refuses, and supplies a default only where the caller stated none:
 *  the first SUPPORTED subfilter and digest, and (for `Certify`) the lock's
 *  recommended DocMDP level. The rules follow pyHanko's
 *  `_enforce_seed_value_constraints`, with the two deliberate points this
 *  library adds noted inline.
 *
 *  `/Cert` is NOT evaluated: the caller supplies the credentials directly, so a
 *  certificate the field would not accept is theirs to notice. */
export function planSeedValue(sv: SeedValue, req: SeedRequest): SeedPlan {
  const plan: SeedPlan = {};
  const binds = (k: SeedRequirement) => sv.required?.includes(k) === true;
  const refuse = (entry: SeedValueError['entry'], msg: string): never => {
    throw new SeedValueError(entry, `seed value: ${msg}`);
  };

  if (binds('filter') && sv.filter !== undefined && sv.filter !== 'Adobe.PPKLite')
    refuse('filter', `the field requires the '${sv.filter}' signature handler; only Adobe.PPKLite is available`);

  // /SubFilter: "the first name in the array that matches an encoding supported
  // by the signature handler shall be the encoding that is actually used".
  if (sv.subFilter !== undefined) {
    const first = sv.subFilter.map((s) => SUBFILTER_OPT[s]).find((s) => s !== undefined);
    if (binds('subFilter')) {
      if (first === undefined)
        refuse('subFilter', `none of the required subfilters (${sv.subFilter.join(', ')}) is supported`);
      if (req.subFilter !== undefined && req.subFilter !== first)
        refuse('subFilter', `the field requires subfilter ${first}, but ${req.subFilter} was requested`);
    }
    if (req.subFilter === undefined && first !== undefined) plan.subFilter = first;
  }

  // /DigestMethod: FOLLOWED. SHA-1 and RIPEMD-160 are never substituted — a
  // required list naming only those is a refusal.
  if (sv.digestMethod !== undefined) {
    const supported = sv.digestMethod.flatMap((m) => DIGEST_OPT[m] ?? []);
    if (binds('digestMethod')) {
      if (supported.length === 0)
        refuse('digestMethod', `the field requires ${sv.digestMethod.join(', ')}, none of which is supported`);
      if (req.digest !== undefined && !supported.includes(req.digest))
        refuse('digestMethod', `the field requires ${sv.digestMethod.join(', ')}, but the signer uses ${req.digest}`);
    }
    if (req.digest === undefined && supported.length > 0) plan.digest = supported[0];
  }

  if (binds('v') && sv.v !== undefined && sv.v > MAX_V)
    refuse('v', `the field requires seed-value processor version ${sv.v}; ${MAX_V} is supported`);

  // /Reasons: an empty list, or the single entry '.', PROHIBITS a reason — and
  // so does a required flag with no list at all (pyHanko: "omission of the
  // /Reasons key amounts to a prohibition").
  if (binds('reasons')) {
    const list = sv.reasons ?? [];
    const mustOmit = list.length === 0 || (list.length === 1 && list[0] === '.');
    if (mustOmit && req.reason !== undefined)
      refuse('reasons', 'the field prohibits giving a reason for signing');
    if (!mustOmit && (req.reason === undefined || !list.includes(req.reason)))
      refuse('reasons', `the reason must be one of: ${list.map((r) => `"${r}"`).join(', ')}`);
  }

  // /LegalAttestation: the flag only restricts which attestations may be
  // supplied, and this signer supplies none — so a required one is met, not
  // refused (pyHanko's reading).

  if (binds('appearanceFilter') && sv.appearanceFilter !== undefined)
    refuse('appearanceFilter', `the field requires the named appearance '${sv.appearanceFilter}', and none is defined`);

  if (binds('addRevInfo') && sv.addRevInfo === true)
    refuse('addRevInfo', 'the field requires Adobe-style revocation information in the signature, which is not produced');

  // /MDP always binds: the KIND of signature must match, and a certification's
  // level is the field's. Refused rather than converted — turning Sign into a
  // certification silently is a surprise, and it must be the first signature.
  if (sv.mdp !== undefined) {
    const wantsCert = sv.mdp !== 'approval';
    if (wantsCert !== req.certify)
      refuse('mdp', wantsCert
        ? `the field is for a certification signature (${sv.mdp}); use Certify`
        : 'the field is for an approval signature; use Sign');
    if (wantsCert) {
      if (req.permissions !== undefined && req.permissions !== sv.mdp)
        refuse('mdp', `the field requires DocMDP level ${sv.mdp}, but ${req.permissions} was requested`);
      if (req.permissions === undefined) plan.permissions = sv.mdp as DocMdpPermission;
    }
  }

  // /LockDocument: a certification locks through its DocMDP level, an approval
  // signature through the field's /Lock /P (puep.7). true is level 1
  // (no-changes); false is any other level (pyHanko's sv_lock_lut).
  if (sv.lockDocument === 'true' || sv.lockDocument === 'false') {
    const lock = sv.lockDocument === 'true';
    // A field whose own /Lock /P contradicts a REQUIRED lock is inconsistent,
    // for either kind of signature (pyHanko: "Inconsistency in form field data").
    if (binds('lockDocument') && req.lockPermissions !== undefined
      && (req.lockPermissions === 'no-changes') !== lock)
      refuse('lockDocument', `the field's /Lock sets level ${req.lockPermissions}, which its seed value's `
        + `required /LockDocument ${sv.lockDocument} forbids`);
    if (req.certify) {
      const level = plan.permissions ?? req.permissions;
      const locked = level === undefined ? undefined : level === 'no-changes';
      if (binds('lockDocument') && locked !== undefined && locked !== lock)
        refuse('lockDocument', lock
          ? `the field requires the document be locked (no-changes), but ${level} was requested`
          : 'the field forbids locking the document, but no-changes was requested');
      if (level === undefined) plan.permissions = lock ? 'no-changes' : 'form-fill';
    } else if (lock && binds('lockDocument') && req.lockPermissions === undefined) {
      // A REQUIRED lock only: an advisory one must not impose a lock the caller
      // never asked for (pyHanko applies it; this library declines to).
      plan.lockPermissions = 'no-changes';
    }
  }

  // /TimeStamp: the /URL is CALLED only when a timestamp is REQUIRED and the
  // caller brought no TSA — so a document can make this library contact a host
  // only by mandating a timestamp, never by merely suggesting one — and only
  // over http(s).
  if (sv.timestamp?.required === true && !req.hasTimestamp) {
    if (!/^https?:\/\//i.test(sv.timestamp.url))
      refuse('timestamp', `the field requires a timestamp from '${sv.timestamp.url}', which is not an http(s) URL; supply opts.timestamp`);
    plan.timestampUrl = sv.timestamp.url;
  }
  return plan;
}
