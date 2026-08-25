import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isStream, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import type { AnnotData } from './annotdata.js';
import type { SkippedAnnot } from './formdata.js';

/** The annotation array plus the indirect objects it references. */
export interface FdfObjects {
  /** The value for the FDF's /Annots key: one ref per annotation. */
  array: PdfObject[];
  /** Object number → object body, for the writer to emit. */
  objects: Map<number, PdfObject>;
}

const ref = (num: number): PdfRef => ({ kind: 'ref', num, gen: 0 });

/** An annotation's /NM as a string; undefined when absent. */
function nameOf(dict: PdfDict): string | undefined {
  const nm = dict.get('NM');
  return isString(nm) ? decodePdfText(nm.bytes) : undefined;
}

/** Serialize annotations as an FDF /Annots subgraph, numbering objects from
 *  `firstObj`. Inline streams become their own objects (PDF has no inline
 *  stream syntax) and name links become real refs between the emitted dicts. */
export function writeFdfAnnots(annots: AnnotData[], firstObj: number): FdfObjects {
  const objects = new Map<number, PdfObject>();
  let next = firstObj;

  // Pass 1: reserve a number for every annotation, so links can be resolved
  // before the dicts that carry them are built.
  const slot = new Map<AnnotData, number>();
  for (const a of annots) slot.set(a, next++);
  const byName = new Map<string, number>();
  for (const a of annots) {
    const nm = nameOf(a.dict);
    if (nm !== undefined) byName.set(nm, slot.get(a)!);
  }

  const alloc = (o: PdfObject): PdfRef => { const n = next++; objects.set(n, o); return ref(n); };

  /** Copy, promoting every inline stream to an indirect object. */
  const promote = (v: PdfObject): PdfObject => {
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, promote(e));
      return alloc({ kind: 'stream', dict, raw: v.raw });
    }
    if (isArray(v)) return v.map(promote);
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, promote(e));
      return out;
    }
    return v;
  };

  // Pass 2: fill each reserved slot.
  const array: PdfObject[] = [];
  for (const a of annots) {
    const dict: PdfDict = new Map<string, PdfObject>();
    for (const [k, v] of a.dict) dict.set(k, promote(v));
    dict.set('Page', a.page);   // FDF's own record of the target page, 0-based
    if (a.popupName !== undefined) {
      const target = byName.get(a.popupName);
      if (target !== undefined) dict.set('Popup', ref(target));
    }
    if (a.inReplyTo !== undefined) {
      const target = byName.get(a.inReplyTo);
      if (target !== undefined) dict.set('IRT', ref(target));
    }
    const n = slot.get(a)!;
    objects.set(n, dict);
    array.push(ref(n));
  }
  return { array, objects };
}

/** Keys dropped on the way into the neutral model: structure back-references
 *  that cannot mean anything in another document, plus the two sibling links,
 *  which are carried by name instead. */
const DROPPED = new Set(['Page', 'Popup', 'IRT', 'P', 'Parent', 'StructParent']);

/** Read an FDF /Annots array into the neutral model. References are inlined so
 *  each dict stands alone; /Popup and /IRT are lifted back into name links,
 *  which is what keeps the inlining acyclic. */
export function readFdfAnnots(
  arr: PdfObject, resolve: (o: PdfObject) => PdfObject, skipped: SkippedAnnot[],
): AnnotData[] {
  if (!isArray(arr)) return [];

  /** Deep copy with refs resolved; a ref already on the path becomes null. */
  const inline = (v: PdfObject, path: Set<number>): PdfObject => {
    if (isRef(v)) {
      const num = (v as PdfRef).num;
      if (path.has(num)) return null;
      path.add(num);
      const out = inline(resolve(v), path);
      path.delete(num);
      return out;
    }
    if (isArray(v)) return v.map((e) => inline(e, path));
    if (isDict(v)) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v) out.set(k, inline(e, path));
      return out;
    }
    if (isStream(v)) {
      const dict: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of v.dict) dict.set(k, inline(e, path));
      return { kind: 'stream', dict, raw: v.raw };
    }
    return v;
  };

  const out: AnnotData[] = [];
  for (const entry of arr) {
    const d = resolve(entry);
    if (!isDict(d)) continue;
    const sub = d.get('Subtype');
    const subtype = isName(sub) ? sub.name : undefined;

    const pageRaw = resolve(d.get('Page') ?? null);
    if (typeof pageRaw !== 'number' || !Number.isInteger(pageRaw) || pageRaw < 0) {
      skipped.push({ ...(subtype !== undefined ? { subtype } : {}), reason: 'missing page index' });
      continue;
    }

    // Lift the sibling links to names before inlining, so no cycle is possible.
    const popupTarget = resolve(d.get('Popup') ?? null);
    const irtTarget = resolve(d.get('IRT') ?? null);
    const popupName = isDict(popupTarget) ? nameOf(popupTarget) : undefined;
    const inReplyTo = isDict(irtTarget) ? nameOf(irtTarget) : undefined;

    const dict: PdfDict = new Map<string, PdfObject>();
    for (const [k, v] of d) {
      if (DROPPED.has(k)) continue;
      dict.set(k, inline(v, new Set<number>()));
    }

    const a: AnnotData = { page: pageRaw, dict };
    if (popupName !== undefined) a.popupName = popupName;
    if (inReplyTo !== undefined) a.inReplyTo = inReplyTo;
    out.push(a);
  }
  return out;
}
