import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isStream, isString } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { regenerateAppearance } from './annotdraw.js';
import type { ImportReport, ImportedAnnot } from './formdata.js';

/** Deep-copy `o`, resolving every reference to the object it points at, so the
 *  result stands alone with no dependency on the document's object map.
 *
 *  A reference already on the current path resolves to null: annotation
 *  subgraphs can cycle (/Popup → popup → /Parent → back), and a self-contained
 *  value cannot hold a cycle. Callers strip the cycling keys before calling
 *  this, so the guard is a backstop, not the mechanism. */
export function inlineRefs(doc: Document, o: PdfObject): PdfObject {
  const path = new Set<number>();

  const walk = (v: PdfObject): PdfObject => {
    if (isRef(v)) {
      const num = (v as PdfRef).num;
      if (path.has(num)) return null;
      path.add(num);
      const out = walk(doc.resolve(v));
      path.delete(num);
      return out;
    }
    if (isArray(v)) return v.map(walk);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, walk(e));
      return out;
    }
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, walk(e));
      return { kind: 'stream', dict, raw: v.raw };
    }
    return v;
  };

  return walk(o);
}

/** Deep-copy `o`, replacing every inline stream with a reference to a freshly
 *  allocated object. PDF has no inline stream syntax, so a self-contained dict
 *  carrying streams has to be re-hydrated this way before it goes into a
 *  document. */
export function allocStreams(doc: Document, o: PdfObject): PdfObject {
  const walk = (v: PdfObject): PdfObject => {
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, walk(e));
      return doc.allocObject({ kind: 'stream', dict, raw: v.raw });
    }
    if (isArray(v)) return v.map(walk);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, walk(e));
      return out;
    }
    return v;
  };

  return walk(o);
}

/** The 18 annotation types the XFDF vocabulary covers, as PDF /Subtype names.
 *  Widget is deliberately absent: widgets are form fields, and travel through
 *  the /Fields path instead. */
export const XFDF_SUBTYPES: ReadonlySet<string> = new Set<string>([
  'Text', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Square', 'Circle',
  'Line', 'Polygon', 'PolyLine', 'Ink', 'FreeText', 'Stamp', 'Caret', 'Sound',
  'Link', 'FileAttachment', 'Popup',
]);

/** Keys that point back into document structure, or sideways at a sibling
 *  annotation. Stripped from the neutral model: the first three cannot be
 *  meaningful in another document, and the last two are carried by name
 *  instead — as refs they would make the dict cyclic and un-inlinable. */
const STRIPPED = ['P', 'Parent', 'StructParent', 'Popup', 'IRT'];

export interface AnnotData {
  /** 0-based page index — XFDF's own convention for the page attribute. */
  page: number;
  /** Self-contained annotation dict: refs inlined, STRIPPED keys removed. */
  dict: PdfDict;
  /** /NM of this annotation's popup, when it has one. */
  popupName?: string;
  /** /NM of the annotation this one replies to, when it is a reply. */
  inReplyTo?: string;
}

const pdfString = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** An annotation's /NM as a string; undefined when absent. */
function nameOf(doc: Document, dict: PdfDict): string | undefined {
  const nm = doc.resolve(dict.get('NM'));
  return isString(nm) ? decodePdfText(nm.bytes) : undefined;
}

/** The /NM of the annotation `key` points at, minting one if it has none. */
function linkedName(
  doc: Document, dict: PdfDict, key: string, mint: () => string,
): string | undefined {
  const target = doc.resolve(dict.get(key));
  if (!isDict(target)) return undefined;
  let nm = nameOf(doc, target);
  if (nm === undefined) {
    nm = mint();
    target.set('NM', pdfString(nm));   // written back: the link needs a stable anchor
  }
  return nm;
}

/** Read every non-widget annotation into the format-neutral model.
 *
 *  Annotations without an /NM get one minted and written back to the live
 *  document, so a second export produces the same names and an import of the
 *  first file still matches by name. */
export function collectAnnots(doc: Document): AnnotData[] {
  const out: AnnotData[] = [];
  let seq = 0;
  const mint = (): string => `annot-${++seq}`;

  const pages = doc.Pages;
  for (let p = 0; p < pages.length; p++) {
    for (const annot of pages[p].Annotations) {
      const live = annot.Dict;
      const sub = live.get('Subtype');
      const subtype = isName(sub) ? sub.name : '';
      if (!XFDF_SUBTYPES.has(subtype)) continue;   // Widget included: not in the set

      if (nameOf(doc, live) === undefined) live.set('NM', pdfString(mint()));
      const popupName = linkedName(doc, live, 'Popup', mint);
      const inReplyTo = linkedName(doc, live, 'IRT', mint);

      const copy = inlineRefs(doc, live) as PdfDict;
      for (const k of STRIPPED) copy.delete(k);

      const entry: AnnotData = { page: p, dict: copy };
      if (popupName !== undefined) entry.popupName = popupName;
      if (inReplyTo !== undefined) entry.inReplyTo = inReplyTo;
      out.push(entry);
    }
  }
  return out;
}

/** Index a page's existing annotations by /NM, for replace-on-import. */
function namedOnPage(doc: Document, pageDict: PdfDict): Map<string, PdfObject> {
  const out = new Map<string, PdfObject>();
  const arr = doc.resolve(pageDict.get('Annots'));
  if (!isArray(arr)) return out;
  for (const e of arr) {
    const d = doc.resolve(e);
    if (!isDict(d)) continue;
    const nm = nameOf(doc, d);
    if (nm !== undefined) out.set(nm, e);
  }
  return out;
}

/** The page's /Annots array, created and attached when absent. */
function annotsArray(doc: Document, pageDict: PdfDict): PdfObject[] {
  const arr = doc.resolve(pageDict.get('Annots'));
  if (isArray(arr)) return arr;
  const made: PdfObject[] = [];
  pageDict.set('Annots', made);
  return made;
}

/** Graft annotations into the document, reporting what landed and what did not.
 *
 *  An annotation whose /NM matches one already on the target page replaces it,
 *  so importing the same data twice is idempotent rather than doubling every
 *  comment. Name links (/Popup, /IRT) are resolved in a second pass, once every
 *  dict has a reference to point at. */
export function applyAnnots(doc: Document, annots: AnnotData[], report: ImportReport): void {
  const pages = doc.Pages;
  /** /NM → the ref of the dict we grafted for it, for the second pass. */
  const grafted = new Map<string, PdfObject>();
  const pending: { data: AnnotData; dict: PdfDict }[] = [];

  for (const a of annots) {
    const sub = a.dict.get('Subtype');
    const subtype = isName(sub) ? sub.name : '';

    if (!XFDF_SUBTYPES.has(subtype)) {
      report.skippedAnnots.push({ page: a.page, subtype, reason: 'unsupported annotation type' });
      continue;
    }
    if (!Number.isInteger(a.page) || a.page < 0 || a.page >= pages.length) {
      report.skippedAnnots.push({ page: a.page, subtype, reason: 'no such page' });
      continue;
    }

    const pageDict = pages[a.page].Dict;
    const dict = allocStreams(doc, a.dict) as PdfDict;
    if (!dict.has('AP')) regenerateAppearance(doc, dict);

    const ref = doc.allocObject(dict);
    const arr = annotsArray(doc, pageDict);
    const nm = nameOf(doc, dict);
    const existing = nm === undefined ? undefined : namedOnPage(doc, pageDict).get(nm);
    if (existing !== undefined) {
      const at = arr.findIndex((e) => e === existing);
      if (at >= 0) arr[at] = ref; else arr.push(ref);
    } else {
      arr.push(ref);
    }

    if (nm !== undefined) grafted.set(nm, ref);
    pending.push({ data: a, dict });
    const entry: ImportedAnnot = { page: a.page, subtype };
    if (nm !== undefined) entry.name = nm;
    report.importedAnnots.push(entry);
  }

  // Second pass: rebuild the sibling links now that every target has a ref.
  for (const { data, dict } of pending) {
    if (data.popupName !== undefined) {
      const target = grafted.get(data.popupName);
      if (target !== undefined) dict.set('Popup', target);
    }
    if (data.inReplyTo !== undefined) {
      const target = grafted.get(data.inReplyTo);
      if (target !== undefined) dict.set('IRT', target);
    }
  }

  if (report.importedAnnots.length > 0) doc.markModified();
}
