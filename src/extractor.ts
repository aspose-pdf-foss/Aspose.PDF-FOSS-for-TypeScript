import type { Document } from './document.js';
import { PageFormat } from './pageformat.js';
import { clearReplyLink } from './annotlinks.js';
import {
  PdfObject, PdfDict, PdfArray, isRef, isDict, isArray, isStream, isName, PdfRef, ref,
} from './types.js';

export interface PrunePolicy {
  /** Page-dict keys removed from the emitted page object entirely. */
  dropPageKeys: Set<string>;
  /** Sanitize /Annots. During a page copy, `registerCopy` allocates a copy and
   *  lets other annotations on that page refer to it. */
  sanitizeAnnots(
    doc: Document, annots: PdfArray,
    registerCopy?: (source: PdfObject, copy: PdfDict) => PdfRef,
  ): PdfArray;
}

export function defaultPrunePolicy(): PrunePolicy {
  return {
    dropPageKeys: new Set(['Parent', 'B', 'StructParents']),
    sanitizeAnnots: sanitizeAnnotationCopies,
  };
}

function sanitizeAnnotationCopies(
  doc: Document, annots: PdfArray,
  registerCopy?: (source: PdfObject, copy: PdfDict) => PdfRef, sameDocumentPage?: PdfRef,
): PdfArray {
  const localRefs = new Set<number>();
  if (registerCopy !== undefined) {
    for (const a of annots) {
      if (isRef(a) && isDict(doc.resolve(a))) localRefs.add(a.num);
    }
  }
  const out: PdfArray = [];
  for (const a of annots) {
    const annot = doc.resolve(a);
    if (!isDict(annot)) continue;
    const subtype = doc.resolve(annot.get('Subtype'));
    // Keep the field's existing widget reference when repeating a page in place.
    if (sameDocumentPage !== undefined && isRef(a) && isName(subtype) && subtype.name === 'Widget') {
      out.push(a);
      continue;
    }
    const copy: PdfDict = new Map(annot);
    if (sameDocumentPage === undefined) {
      copy.delete('P');
      // Strip same-document destinations and keep self-contained actions.
      const action = doc.resolve(copy.get('A'));
      const kind = isDict(action) ? action.get('S') : undefined;
      if (isName(kind) && kind.name === 'GoTo') copy.delete('A');
      copy.delete('Dest');
    } else if (copy.has('P')) {
      copy.set('P', sameDocumentPage);
    }
    if (registerCopy === undefined) {
      out.push(copy);
      continue;
    }
    if (!isLocalAnnotationRef(copy.get('IRT'), localRefs)) clearReplyLink(copy);
    if (!isLocalAnnotationRef(copy.get('Popup'), localRefs)) copy.delete('Popup');
    if (isName(subtype) && subtype.name === 'Popup' && !isLocalAnnotationRef(copy.get('Parent'), localRefs)) {
      copy.delete('Parent');
    }
    out.push(registerCopy(a, copy));
  }
  return out;
}

function isLocalAnnotationRef(value: PdfObject | undefined, refs: ReadonlySet<number>): boolean {
  return isRef(value) && refs.has(value.num);
}

/** Copy a page's annotation graph in its own reference namespace. The ordinary
 *  remapper can still share resources across pages, including repeated copies
 *  of the same source page. */
export function rewritePageRefs(
  doc: Document, page: PdfDict, policy: PrunePolicy,
  allocate: (object: PdfDict) => PdfRef, remap: (source: PdfRef) => PdfRef,
): void {
  const sourceAnnots = page.get('Annots');
  page.delete('Annots');
  rewriteRefs(page, remap);
  if (sourceAnnots === undefined) return;
  const annots = copyAnnots(doc, sourceAnnots, policy.sanitizeAnnots.bind(policy), allocate, remap);
  page.set('Annots', annots);
}

/** Give a repeated page in the same document its own annotations. */
export function duplicatePageAnnots(
  doc: Document, page: PdfDict, pageRef: PdfRef, allocate: (object: PdfDict) => PdfRef,
): void {
  const sourceAnnots = page.get('Annots');
  if (sourceAnnots === undefined) return;
  const annots = copyAnnots(doc, sourceAnnots, (source, entries, register) => {
    return sanitizeAnnotationCopies(source, entries, register, pageRef);
  }, allocate, (r) => r);
  page.set('Annots', annots);
}

function copyAnnots(
  doc: Document, sourceAnnots: PdfObject, sanitize: PrunePolicy['sanitizeAnnots'],
  allocate: (object: PdfDict) => PdfRef, remap: (source: PdfRef) => PdfRef,
): PdfArray {
  const annots = doc.resolve(sourceAnnots);
  if (!isArray(annots)) return [];
  const localRefs = new Map<number, PdfRef>();
  const registered = new Map<PdfRef, PdfDict>();
  const copies = sanitize(doc, annots, (source, copy) => {
    const dict = new Map(copy);
    const dest = allocate(dict);
    if (isRef(source)) localRefs.set(source.num, dest);
    registered.set(dest, dict);
    return dest;
  });
  const remapAnnotationRef = (r: PdfRef): PdfRef => localRefs.get(r.num) ?? remap(r);
  for (const copy of registered.values()) rewriteRefs(copy, remapAnnotationRef);
  // A custom policy may still return source refs or inline objects.
  return copies.map((value) => {
    if (isRef(value)) return registered.has(value) ? value : remapAnnotationRef(value);
    return passthrough(value, remapAnnotationRef);
  });
}

export interface Extraction { objects: Map<number, PdfObject>; pageNum: number; }

/** @internal The page attributes 7.7.3.4 makes inheritable. */
export const INHERITABLE_PAGE_KEYS = ['MediaBox', 'CropBox', 'Resources', 'Rotate'] as const;

/** First ancestor value, raw so the copying walk can remap any references.
 *  Undefined if absent; a stated null stops inheritance just as Page's getters
 *  do. Cycle-guarded; does not read the leaf itself. */
function inheritedValue(doc: Document, src: PdfDict, key: string): PdfObject | undefined {
  let node: PdfObject = doc.resolve(src.get('Parent'));
  const seen = new Set<PdfDict>();
  while (isDict(node)) {
    if (seen.has(node)) break;
    seen.add(node);
    if (node.has(key)) return node.get(key)!;
    node = doc.resolve(node.get('Parent'));
  }
  return undefined;
}

/** The same usable box shape that Page.box reads, without resolving away the
 *  raw references the graph-copy walk still needs to remap. */
function isPageBox(doc: Document, value: PdfObject | undefined): boolean {
  const box = doc.resolve(value);
  if (!isArray(box) || box.length !== 4) return false;
  for (const item of box) if (typeof doc.resolve(item) !== 'number') return false;
  return true;
}

/** @internal Shallow-copy a leaf and materialize its inherited attributes
 *  and effective defaults before callers drop /Parent. Valid raw values still
 *  belong to the source graph; rewriteRefs and the caller's object-copy walk
 *  make them independent. */
export function clonePageDict(doc: Document, src: PdfDict): PdfDict {
  const page = new Map(src);
  for (const key of INHERITABLE_PAGE_KEYS) {
    if (!page.has(key)) {
      const v = inheritedValue(doc, src, key);
      if (v !== undefined) page.set(key, v);
    }
  }
  // An omitted or unusable attribute must not pick up the NEW parent's value.
  // Match Page's existing fallbacks while leaving valid source values intact.
  if (!isPageBox(doc, page.get('MediaBox'))) page.set('MediaBox', PageFormat.Letter.mediaBox());
  if (!isPageBox(doc, page.get('CropBox'))) page.set('CropBox', page.get('MediaBox')!);
  if (typeof doc.resolve(page.get('Rotate')) !== 'number') page.set('Rotate', 0);
  if (!isDict(doc.resolve(page.get('Resources')))) page.set('Resources', new Map());
  return page;
}

/** Build the self-contained, already-renumbered object set for one page.
 *  The page object becomes object 1; referenced objects get sequential numbers
 *  in BFS order. All refs inside the emitted objects are rewritten to the new
 *  numbers, so the writer can serialize the map directly. */
export function extractPage(doc: Document, pageDict: PdfDict, policy: PrunePolicy): Extraction {
  const objects = new Map<number, PdfObject>();
  // Materialize inheritance before dropping /Parent; then apply pruning.
  const page = clonePageDict(doc, pageDict);
  for (const k of policy.dropPageKeys) page.delete(k);
  const newNumByOld = new Map<number, number>();
  let next = 1;
  const pageNum = next++;
  objects.set(pageNum, page);

  const queue: PdfObject[] = [];
  const enqueueRef = (r: PdfRef): PdfRef => {
    let nn = newNumByOld.get(r.num);
    if (nn === undefined) {
      nn = next++;
      newNumByOld.set(r.num, nn);
      const resolved = doc.getObject(r.num);
      objects.set(nn, cloneShallow(resolved));
      queue.push(objects.get(nn)!);
    }
    return { kind: 'ref', num: nn, gen: 0 };
  };

  rewritePageRefs(doc, page, policy, (copy) => {
    const num = next++;
    objects.set(num, copy);
    return ref(num);
  }, enqueueRef);
  for (let i = 0; i < queue.length; i++) rewriteRefs(queue[i], enqueueRef);
  return { objects, pageNum };
}

export function cloneShallow(o: PdfObject): PdfObject {
  if (isDict(o)) return new Map(o);
  if (isArray(o)) return [...o];
  if (isStream(o)) return { kind: 'stream', dict: new Map(o.dict), raw: o.raw };
  return o;
}

/** Replace every PdfRef inside container `o` with policy-mapped refs (mutates o). */
export function rewriteRefs(o: PdfObject, map: (r: PdfRef) => PdfRef): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) o[i] = isRef(o[i]) ? map(o[i] as PdfRef) : passthrough(o[i], map);
  } else if (isDict(o)) {
    for (const [k, v] of o) o.set(k, isRef(v) ? map(v) : passthrough(v, map));
  } else if (isStream(o)) {
    for (const [k, v] of o.dict) o.dict.set(k, isRef(v) ? map(v) : passthrough(v, map));
  }
}

/** For nested arrays/dicts found inline, clone+rewrite so we don't mutate doc cache. */
function passthrough(v: PdfObject, map: (r: PdfRef) => PdfRef): PdfObject {
  if (isArray(v)) { const c = [...v]; rewriteRefs(c, map); return c; }
  if (isDict(v)) { const c = new Map(v); rewriteRefs(c, map); return c; }
  return v;
}
