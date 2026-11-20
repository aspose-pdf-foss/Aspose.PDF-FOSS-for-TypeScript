import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isStream, isString } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { regenerateAppearance } from './annotdraw.js';
import { clearReplyLink, hasReplyCycle, isAnnotationDict } from './annotlinks.js';
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
      // The path IS the reference depth, so the cycle guard's own set measures
      // it: a chain of distinct objects is no cycle and was unbounded.
      doc.loadLimits.enforce('maxNestingDepth', path.size, 'annotation reference chain');
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
  /** An unnamed nested XFDF popup, identified by its owner during import. */
  anonymousPopup?: AnnotData;
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

interface PageImport {
  entries: PdfObject[];
  names: Map<string, number>;
  replaced: Map<PdfDict, number>;
  incoming: Map<number, AnnotData>;
  anonymousPopups: Map<AnnotData, number>;
}

function indexPage(doc: Document, page: PdfDict): PageImport {
  const annots = doc.resolve(page.get('Annots'));
  const entries = isArray(annots) ? annots : [];
  if (entries !== annots) page.set('Annots', entries);
  const names = new Map<string, number>();
  entries.forEach((entry, index) => {
    const dict = doc.resolve(entry);
    if (!isDict(dict)) return;
    const nm = nameOf(doc, dict);
    if (nm !== undefined) names.set(nm, index);
  });
  return { entries, names, replaced: new Map(), incoming: new Map(), anonymousPopups: new Map() };
}

function isPopup(doc: Document, dict: PdfDict): boolean {
  const sub = doc.resolve(dict.get('Subtype'));
  return isName(sub) && sub.name === 'Popup';
}

function ownedPopupIndex(doc: Document, page: PageImport, owner: AnnotData): number | undefined {
  const nm = nameOf(doc, owner.dict);
  const ownerIndex = nm === undefined ? undefined : page.names.get(nm);
  if (ownerIndex === undefined) return undefined;
  const existing = doc.resolve(page.entries[ownerIndex]);
  if (!isDict(existing)) return undefined;
  const popup = doc.resolve(existing.get('Popup'));
  if (!isDict(popup) || !isPopup(doc, popup)) return undefined;
  const parent = doc.resolve(popup.get('Parent'));
  if (isDict(parent) && parent !== existing && page.replaced.get(parent) !== ownerIndex) return undefined;
  const index = page.entries.findIndex((entry) => doc.resolve(entry) === popup);
  return index < 0 ? undefined : index;
}

/** Keep links carried by an earlier version when this import omits them. */
function preserveLinks(doc: Document, previous: PdfDict, dict: PdfDict, incoming: AnnotData): void {
  const keys: string[] = [];
  if (incoming.inReplyTo === undefined && previous.has('IRT')) keys.push('IRT', 'RT');
  keys.push('Popup');
  if (isPopup(doc, previous) && isPopup(doc, dict)) keys.push('Parent');
  for (const key of keys) {
    const value = previous.get(key);
    if (value !== undefined && !dict.has(key)) dict.set(key, value);
  }
}

function restorePageLinks(doc: Document, page: PageImport): void {
  const { entries, names, replaced, incoming, anonymousPopups } = page;
  const siblings = new Set<PdfDict>();
  for (const entry of entries) {
    const dict = doc.resolve(entry);
    if (isDict(dict)) siblings.add(dict);
  }

  // A link must point to the final indirect object in the page's /Annots array.
  const refAt = (index: number): PdfRef => {
    const entry = entries[index];
    if (isRef(entry)) return entry;
    const ref = doc.allocObject(entry);
    entries[index] = ref;
    return ref;
  };

  const isGroup = (dict: PdfDict): boolean => {
    const type = doc.resolve(dict.get('RT'));
    return isName(type) && type.name === 'Group';
  };
  const groupParents = new Set<PdfDict>();
  for (const dict of siblings) {
    for (const key of isPopup(doc, dict) ? ['Parent'] : ['IRT', 'Popup']) {
      const previous = doc.resolve(dict.get(key));
      if (!isDict(previous)) continue;
      const index = replaced.get(previous);
      if (index !== undefined) dict.set(key, refAt(index));
    }
    if (isGroup(dict)) {
      const parent = doc.resolve(dict.get('IRT'));
      if (isDict(parent)) groupParents.add(parent);
    }
  }

  for (const [index, data] of incoming) {
    const dict = doc.resolve(entries[index]) as PdfDict;
    if (data.inReplyTo !== undefined) {
      const parent = names.get(data.inReplyTo);
      const parentDict = parent === undefined ? null : doc.resolve(entries[parent]);
      const group = isGroup(dict);
      if (parent !== undefined && isAnnotationDict(doc, parentDict) && !groupParents.has(dict) &&
          (!group || doc.resolve(parentDict.get('IRT')) === null) && !hasReplyCycle(doc, dict, parentDict)) {
        dict.set('IRT', refAt(parent));
        if (group) groupParents.add(parentDict);
      } else {
        clearReplyLink(dict);
      }
    }

    const target = data.anonymousPopup !== undefined ? anonymousPopups.get(data.anonymousPopup)
      : data.popupName !== undefined ? names.get(data.popupName) : undefined;
    if (target === undefined || target === index) continue;
    const popup = doc.resolve(entries[target]);
    if (!isDict(popup) || !isPopup(doc, popup)) continue;
    const previousPopup = doc.resolve(dict.get('Popup'));
    if (previousPopup !== popup && isDict(previousPopup) && isPopup(doc, previousPopup) &&
        siblings.has(previousPopup) && doc.resolve(previousPopup.get('Parent')) === dict) {
      previousPopup.delete('Parent');
    }
    const previousParent = doc.resolve(popup.get('Parent'));
    if (isDict(previousParent) && siblings.has(previousParent) && doc.resolve(previousParent.get('Popup')) === popup) {
      previousParent.delete('Popup');
    }
    dict.set('Popup', refAt(target));
    popup.set('Parent', refAt(index));
  }
}

/** Graft annotations into the document, reporting what landed and what did not.
 *
 *  An annotation whose /NM matches one already on the target page replaces it,
 *  so importing the same data twice is idempotent rather than doubling every
 *  comment. Resolve name links on their own page after all replacements land,
 *  including links to and from annotations omitted from the import. */
export function applyAnnots(doc: Document, annots: AnnotData[], report: ImportReport): void {
  const pages = doc.Pages;
  const imports = new Map<number, PageImport>();
  const popupOwners = new Map<AnnotData, AnnotData>();
  for (const a of annots) {
    if (a.anonymousPopup !== undefined) popupOwners.set(a.anonymousPopup, a);
  }

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

    let page = imports.get(a.page);
    if (page === undefined) {
      page = indexPage(doc, pages[a.page].Dict);
      imports.set(a.page, page);
    }
    const dict = allocStreams(doc, a.dict) as PdfDict;
    if (!dict.has('AP')) regenerateAppearance(doc, dict);

    let nm = nameOf(doc, dict);
    const owner = popupOwners.get(a);
    const existing = owner === undefined
      ? (nm === undefined ? undefined : page.names.get(nm))
      : ownedPopupIndex(doc, page, owner);
    const index = existing ?? page.entries.length;
    const previous = doc.resolve(page.entries[index]);
    if (isDict(previous)) {
      preserveLinks(doc, previous, dict, a);
      page.replaced.set(previous, index);
      if (owner !== undefined) {
        nm = nameOf(doc, previous);
        if (nm !== undefined) dict.set('NM', pdfString(nm));
      }
    }
    page.entries[index] = doc.allocObject(dict);
    if (nm !== undefined) page.names.set(nm, index);
    if (owner !== undefined) page.anonymousPopups.set(a, index);
    page.incoming.set(index, a);

    const entry: ImportedAnnot = { page: a.page, subtype };
    if (nm !== undefined) entry.name = nm;
    report.importedAnnots.push(entry);
  }

  for (const page of imports.values()) restorePageLinks(doc, page);

  if (report.importedAnnots.length > 0) doc.markModified();
}
