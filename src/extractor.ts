import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfArray, isRef, isDict, isArray, isStream, isName, PdfRef,
} from './types.js';

export interface PrunePolicy {
  /** Page-dict keys removed from the emitted page object entirely. */
  dropPageKeys: Set<string>;
  /** Sanitize the /Annots array; return a new array (resolved annotation dicts). */
  sanitizeAnnots(doc: Document, annots: PdfArray): PdfArray;
}

export function defaultPrunePolicy(): PrunePolicy {
  return {
    dropPageKeys: new Set(['Parent', 'B', 'StructParents']),
    sanitizeAnnots(doc, annots) {
      const out: PdfArray = [];
      for (const a of annots) {
        const annot = doc.resolve(a);
        if (!isDict(annot)) continue;
        const copy: PdfDict = new Map(annot);
        copy.delete('P'); // back-reference to the page object
        // Strip same-document GoTo actions; keep URI / GoToR (self-contained).
        const action = doc.resolve(copy.get('A'));
        const isGoTo = isDict(action) && isName(action.get('S')) && (action.get('S') as any).name === 'GoTo';
        if (isGoTo) copy.delete('A');
        // A /Dest leaves the page; strip it.
        if (copy.has('Dest')) copy.delete('Dest');
        out.push(copy);
      }
      return out;
    },
  };
}

export interface Extraction { objects: Map<number, PdfObject>; pageNum: number; }

/** Build the self-contained, already-renumbered object set for one page.
 *  The page object becomes object 1; referenced objects get sequential numbers
 *  in BFS order. All refs inside the emitted objects are rewritten to the new
 *  numbers, so the writer can serialize the map directly. */
export function extractPage(doc: Document, pageDict: PdfDict, policy: PrunePolicy): Extraction {
  const objects = new Map<number, PdfObject>();
  // Prepare the page object: drop unwanted keys, sanitize annots.
  const page: PdfDict = new Map(pageDict);
  for (const k of policy.dropPageKeys) page.delete(k);
  if (page.has('Annots')) {
    const annots = doc.resolve(page.get('Annots'));
    page.set('Annots', isArray(annots) ? policy.sanitizeAnnots(doc, annots) : []);
  }

  const newNumByOld = new Map<number, number>();
  let next = 1;
  const pageNum = next++;
  objects.set(pageNum, page);

  const queue: PdfObject[] = [page];
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

  while (queue.length) {
    const cur = queue.shift()!;
    rewriteRefs(cur, enqueueRef);
  }
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
