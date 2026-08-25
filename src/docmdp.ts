import {
  PdfObject, PdfDict, PdfStream, isDict, isStream, isName, isArray, isRef, isString,
} from './types.js';

/** `/DocMDP` permitted-changes enforcement on verify (V4).
 *
 *  A certification signature (`/Perms /DocMDP`) declares the maximum class of
 *  changes that may be appended after it (PDF 32000-1 §12.8.2.2):
 *   - **P=1** (`no-changes`): no changes at all.
 *   - **P=2** (`form-fill`): filling form fields and signing existing fields.
 *   - **P=3** (`form-fill-and-annotate`): the above plus annotation create / edit
 *     / delete.
 *
 *  Given the set of objects added or modified in revisions appended after the
 *  certified one, {@link docMdpVerdict} classifies each change by the minimum
 *  level that permits it and reports `ok` when every change fits within the
 *  certified level, else `violated`. This is a structural, object-level
 *  approximation (the spec defines the model in terms of permitted operations);
 *  it recognizes the change shapes this library itself produces — approval
 *  signatures, form fills, and annotation edits — and treats any content- or
 *  structure-level change (page contents, the page tree, unexpected catalog keys)
 *  as exceeding every level. */

export type DocMdpVerdict = 'ok' | 'violated';

/** `/DocMDP` `/P` level (1/2/3). */
export type DocMdpLevel = 1 | 2 | 3;

/** Minimal read view over one revision's objects for DocMDP analysis. */
export interface DocMdpDoc {
  /** The direct indirect object stored at `num` (a later override wins), or null. */
  getObject(num: number): PdfObject;
  /** Follow a reference to its target within this revision (identity-preserving). */
  resolve(o: PdfObject | undefined): PdfObject;
}

/** One object that differs between the signed revision and the current one. */
export interface DocMdpChange {
  object: number;
  change: 'added' | 'modified';
}

/** The two revisions plus the catalog/AcroForm identities needed to classify
 *  each post-signing change. */
export interface DocMdpEnv {
  /** The certified (signed) revision. */
  prev: DocMdpDoc;
  /** The current document (with all later revisions applied). */
  cur: DocMdpDoc;
  /** `/Root` (document catalog) object number. */
  catalogNum: number;
  /** Catalog `/AcroForm` object number, when it is an indirect object. */
  acroFormNum?: number;
}

const NEVER = Number.POSITIVE_INFINITY;

/** Catalog keys whose addition/change accompanies a permitted signing/form/LTV
 *  change (forms infrastructure, `/Perms`, `/DSS` validation data, metadata). */
const CATALOG_ALLOWED = new Set(['AcroForm', 'Perms', 'DSS', 'Extensions', 'Metadata', 'Version', 'MarkInfo']);
/** AcroForm keys that may change when a field is filled or a signature added. */
const ACROFORM_ALLOWED = new Set(['Fields', 'SigFlags', 'DR', 'DA', 'NeedAppearances', 'XFA', 'CO']);
/** Field/widget keys touched by form filling or signing (value + appearance). */
const FILL_KEYS = new Set(['V', 'AP', 'AS', 'DV', 'I', 'Lock']);
/** Field/widget keys touched by an annotation-class edit of a widget. */
const ANNOT_KEYS = new Set(['Rect', 'F', 'M', 'C', 'CA', 'Border', 'BS', 'NM']);

/** DocMDP verdict for a certification at permitted level `p` given the
 *  post-signing object `changes`: `ok` when every change is permitted at `p`,
 *  else `violated`. */
export function docMdpVerdict(p: DocMdpLevel, changes: DocMdpChange[], env: DocMdpEnv): DocMdpVerdict {
  for (const c of changes) if (requiredLevel(c, env) > p) return 'violated';
  return 'ok';
}

/** Read the certification level (`/P`) from a certification signature's value
 *  dictionary via its `/Reference` DocMDP transform, or undefined when absent. */
export function readDocMdpLevel(
  sigDict: PdfDict, resolve: (o: PdfObject | undefined) => PdfObject,
): DocMdpLevel | undefined {
  const refs = resolve(sigDict.get('Reference'));
  if (!isArray(refs)) return undefined;
  for (const r of refs) {
    const sr = resolve(r);
    if (isDict(sr) && nameOf(sr.get('TransformMethod')) === 'DocMDP') {
      const tp = resolve(sr.get('TransformParams'));
      if (isDict(tp)) {
        const p = tp.get('P');
        if (p === 1 || p === 2 || p === 3) return p;
      }
    }
  }
  return undefined;
}

/** The minimum DocMDP level that permits one change, or {@link NEVER}. */
function requiredLevel(c: DocMdpChange, env: DocMdpEnv): number {
  const cur = env.cur.getObject(c.object);
  if (c.change === 'added') return addedLevel(cur, env);
  return modifiedLevel(c.object, env.prev.getObject(c.object), cur, env);
}

/** Classify a newly-added object by its kind. */
function addedLevel(obj: PdfObject, env: DocMdpEnv): number {
  if (isStream(obj)) return streamLevel(obj);
  if (!isDict(obj)) return NEVER;
  const type = nameOf(obj.get('Type'));
  if (type === 'Sig') return 2;                                   // signature value dict
  if (nameOf(obj.get('Subtype')) === 'Widget') return widgetLevel(obj, env);
  if (type === 'Annot') return 3;                                 // annotation
  if (isLtvDict(obj)) return 2;                                   // /DSS, /VRI, OCSP/CRL container
  if (type === 'Font' || type === 'ExtGState' || type === 'XObject') return 2; // appearance resource
  return NEVER;
}

/** Classify a modified object by what changed between the two revisions. */
function modifiedLevel(num: number, prev: PdfObject, cur: PdfObject, env: DocMdpEnv): number {
  if (isStream(cur)) return streamLevel(cur);
  if (!isDict(cur)) return NEVER;
  const keys = changedKeys(prev, cur);
  if (keys.size === 0) return 2;
  if (num === env.catalogNum) return allowedOnly(keys, CATALOG_ALLOWED);
  if (num === env.acroFormNum) return allowedOnly(keys, ACROFORM_ALLOWED);
  if (nameOf(cur.get('Type')) === 'Page') return pageChangeLevel(keys, prev, cur, env);
  if (nameOf(cur.get('Subtype')) === 'Widget' || isName(cur.get('FT'))) return fieldChangeLevel(keys);
  if (nameOf(cur.get('Type')) === 'Annot') return 3;             // annotation edit
  return NEVER;
}

/** A widget is `signing` (P≥2) when it is a signature field, else a form/annot
 *  widget (P≥3). */
function widgetLevel(w: PdfDict, env: DocMdpEnv): number {
  if (nameOf(w.get('FT')) === 'Sig') return 2;
  const v = env.cur.resolve(w.get('V'));
  return isDict(v) && nameOf(v.get('Type')) === 'Sig' ? 2 : 3;
}

/** Appearance/image streams (P≥2) vs any other stream — e.g. page content (never). */
function streamLevel(s: PdfStream): number {
  const subtype = nameOf(s.dict.get('Subtype'));
  return subtype === 'Form' || subtype === 'Image' ? 2 : NEVER;
}

/** A page may only gain/lose `/Annots`; classify the annotations added/removed. */
function pageChangeLevel(keys: Set<string>, prev: PdfObject, cur: PdfDict, env: DocMdpEnv): number {
  for (const k of keys) if (k !== 'Annots') return NEVER;
  const before = annotRefs(prev, env.prev);
  const after = annotRefs(cur, env.cur);
  let need = 2;
  for (const n of before) if (!after.has(n)) need = Math.max(need, 3); // deletion → annotation class
  for (const n of after) {
    if (before.has(n)) continue;
    const annot = env.cur.getObject(n);
    need = Math.max(need, isDict(annot) && isSigningWidget(annot, env) ? 2 : 3);
  }
  return need;
}

/** A field/widget change is form-fill/signing (P≥2) or an annotation-class edit
 *  (P≥3); any other key change exceeds every level. */
function fieldChangeLevel(keys: Set<string>): number {
  let need = 2;
  for (const k of keys) {
    if (FILL_KEYS.has(k)) continue;
    if (ANNOT_KEYS.has(k)) { need = Math.max(need, 3); continue; }
    return NEVER;
  }
  return need;
}

/** Whether a widget annotation is a signature field (its own `/FT` or `/V /Sig`). */
function isSigningWidget(w: PdfDict, env: DocMdpEnv): boolean {
  if (nameOf(w.get('FT')) === 'Sig') return true;
  const v = env.cur.resolve(w.get('V'));
  return isDict(v) && nameOf(v.get('Type')) === 'Sig';
}

/** 2 when every changed key is in `allowed`, else {@link NEVER}. */
function allowedOnly(keys: Set<string>, allowed: Set<string>): number {
  for (const k of keys) if (!allowed.has(k)) return NEVER;
  return 2;
}

/** Object numbers referenced by a page dict's `/Annots` array. */
function annotRefs(pageDict: PdfObject, doc: DocMdpDoc): Set<number> {
  const out = new Set<number>();
  if (!isDict(pageDict)) return out;
  const annots = doc.resolve(pageDict.get('Annots'));
  if (isArray(annots)) for (const a of annots) if (isRef(a)) out.add(a.num);
  return out;
}

/** Keys whose value differs between `prev` and `cur` (added, removed, or changed).
 *  When `prev` is not a dict (e.g. the object was replaced wholesale), every key
 *  of `cur` counts as changed. */
function changedKeys(prev: PdfObject, cur: PdfDict): Set<string> {
  const out = new Set<string>();
  if (!isDict(prev)) { for (const k of cur.keys()) out.add(k); return out; }
  for (const [k, v] of cur) if (!equalObj(v, prev.get(k))) out.add(k);
  for (const k of prev.keys()) if (!cur.has(k)) out.add(k);
  return out;
}

/** A `/DSS`/`/VRI`-style LTV container or an OCSP/CRL holder. */
function isLtvDict(d: PdfDict): boolean {
  return d.has('Certs') || d.has('CRLs') || d.has('OCSPs') || d.has('VRI');
}

function nameOf(o: PdfObject | undefined): string | undefined {
  return isName(o) ? o.name : undefined;
}

/** Structural equality over the PDF object model (references compare by id). */
function equalObj(a: PdfObject | undefined, b: PdfObject | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (isRef(a)) return isRef(b) && a.num === b.num && a.gen === b.gen;
  if (isName(a)) return isName(b) && a.name === b.name;
  if (isString(a)) return isString(b) && bytesEqual(a.bytes, b.bytes);
  if (isArray(a)) return isArray(b) && a.length === b.length && a.every((x, i) => equalObj(x, b[i]));
  if (isStream(a)) return isStream(b) && equalObj(a.dict, b.dict) && bytesEqual(a.raw, b.raw);
  if (isDict(a)) {
    if (!isDict(b) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equalObj(v, b.get(k))) return false;
    return true;
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
