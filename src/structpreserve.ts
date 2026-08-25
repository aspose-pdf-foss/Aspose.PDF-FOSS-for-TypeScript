import type { Document } from './document.js';
import { PdfObject, PdfDict, PdfRef, isDict, isArray, isRef, isName, ref, name } from './types.js';
import { lookupNumberTree } from './struct.js';

/** One copied page: where it came from and where it landed. */
export interface PageOrigin {
  srcDoc: Document;
  srcPageNum: number;   // source page object number in srcDoc
  newPageNum: number;   // resulting page object number in outDoc
}

const asNum = (o: PdfObject): number | undefined => (typeof o === 'number' ? o : undefined);

/** A surviving structure-bearing annotation in the out doc, keyed (in the map
 *  below) by the source ELEMENT number it points to. The object /StructParent
 *  key is allocated later (Phase 3b) so ParentTree keys stay ascending. */
interface ObjSurv { newRef: PdfRef; annotDict: PdfDict; }

/** Accumulating state for the out-doc structure tree (created or extended). */
interface OutTree {
  rootDict: PdfDict;
  rootRef: PdfRef;
  topK: PdfObject[];      // /K of the root (cloned top-level elements)
  nums: PdfObject[];      // flat /ParentTree /Nums: [key, value, key, value, ...]
  nextKey: number;        // next /StructParents key to allocate
  roleMap: Map<string, string>;
}

/** Rebuild/extend outDoc's structure tree from the structure of the pages in
 *  `origins`. No-op when no source is tagged. */
export function preserveStructure(outDoc: Document, origins: PageOrigin[]): void {
  const bySrc = new Map<Document, PageOrigin[]>();
  for (const o of origins) {
    const list = bySrc.get(o.srcDoc) ?? [];
    list.push(o);
    bySrc.set(o.srcDoc, list);
  }

  let tree: OutTree | undefined;
  for (const [srcDoc, list] of bySrc) {
    const srcRoot = srcDoc.GetStructTree();
    if (!srcDoc.IsTagged || srcRoot === null) continue;
    tree ??= openOutTree(outDoc);
    cloneSource(outDoc, srcDoc, srcRoot.Dict, list, tree);
  }
  if (tree) finalizeTree(outDoc, tree);
}

/** Create a fresh /StructTreeRoot, or adopt an existing one for extension. */
function openOutTree(outDoc: Document): OutTree {
  const catalog = outDoc.catalog();
  const existingRef = catalog.get('StructTreeRoot');
  const existing = outDoc.resolve(existingRef);
  if (isRef(existingRef) && isDict(existing)) {
    const pt = outDoc.resolve(existing.get('ParentTree'));
    const ptNums = isDict(pt) ? outDoc.resolve(pt.get('Nums')) : null;
    const nums = isArray(ptNums) ? [...ptNums] : [];
    const nextKey = asNum(outDoc.resolve(existing.get('ParentTreeNextKey'))) ?? maxKey(nums) + 1;
    const k = outDoc.resolve(existing.get('K'));
    const topK = isArray(k) ? [...k] : k != null ? [existing.get('K') as PdfObject] : [];
    return { rootDict: existing, rootRef: existingRef, topK, nums, nextKey, roleMap: readRoleMap(outDoc, existing) };
  }
  const rootDict: PdfDict = new Map([['Type', name('StructTreeRoot')]]);
  const rootRef = outDoc.allocObject(rootDict);
  return { rootDict, rootRef, topK: [], nums: [], nextKey: 0, roleMap: new Map() };
}

function maxKey(nums: PdfObject[]): number {
  let m = -1;
  for (let i = 0; i < nums.length; i += 2) { const k = asNum(nums[i]); if (k !== undefined && k > m) m = k; }
  return m;
}

function readRoleMap(doc: Document, rootDict: PdfDict): Map<string, string> {
  const out = new Map<string, string>();
  const rm = doc.resolve(rootDict.get('RoleMap'));
  if (isDict(rm)) for (const [k, v] of rm) { const t = doc.resolve(v); if (isName(t)) out.set(k, t.name); }
  return out;
}

/** Clone the surviving structure of one source doc into the out tree. */
function cloneSource(outDoc: Document, srcDoc: Document, srcRootDict: PdfDict, origins: PageOrigin[], tree: OutTree): void {
  // src page obj num -> new page obj num (first occurrence wins; repeats untagged)
  const pageMap = new Map<number, number>();
  for (const o of origins) if (!pageMap.has(o.srcPageNum)) pageMap.set(o.srcPageNum, o.newPageNum);

  const srcPt = srcDoc.resolve(srcRootDict.get('ParentTree'));

  // Phase 1 — mark keep-set + collect each page's MCID->element array.
  const keep = new Set<number>();
  const pageArrays: { newPageNum: number; arr: PdfObject[] }[] = [];
  for (const [srcPageNum, newPageNum] of pageMap) {
    const srcPage = srcDoc.getObject(srcPageNum);
    const spKey = isDict(srcPage) ? asNum(srcDoc.resolve(srcPage.get('StructParents'))) : undefined;
    if (spKey === undefined || !isDict(srcPt)) continue;
    const arr = srcDoc.resolve(lookupNumberTree(srcDoc, srcPt, spKey));
    if (!isArray(arr)) continue;
    for (const e of arr) if (isRef(e)) markKeep(srcDoc, e.num, keep);
    pageArrays.push({ newPageNum, arr });
  }

  // Object-keyed structure (annotations via /StructParent). Build a survivor map
  // keyed by the ELEMENT the annotation points to, and mark those elements keep.
  // New annots are inline dicts in the new page's /Annots, aligned by survivor
  // index with the source page's resolved annots; promote the relevant one to an
  // indirect object so its OBJR can point at it.
  const objSurv = new Map<number, ObjSurv>(); // src ELEMENT num -> info
  const srcRootForObj = srcDoc.GetStructTree()!; // non-null: caller checked IsTagged
  for (const [srcPageNum, newPageNum] of pageMap) {
    const srcPage = srcDoc.getObject(srcPageNum);
    const newPage = outDoc.getObject(newPageNum);
    if (!isDict(srcPage) || !isDict(newPage)) continue;
    const srcAnnots = srcDoc.resolve(srcPage.get('Annots'));
    const newAnnots = outDoc.resolve(newPage.get('Annots'));
    if (!isArray(srcAnnots) || !isArray(newAnnots)) continue;
    let j = 0;
    for (const sa of srcAnnots) {
      const sd = srcDoc.resolve(sa);
      if (!isDict(sd)) continue;
      const newEntry = newAnnots[j++]; // aligned copy (inline dict or ref)
      const spk = asNum(srcDoc.resolve(sd.get('StructParent')));
      if (spk === undefined) continue;
      const elem = srcRootForObj.ElementForObject(spk);
      if (!elem || elem.Ref === undefined) continue;
      markKeep(srcDoc, elem.Ref.num, keep);
      const newAnnotDict = outDoc.resolve(newEntry);
      if (!isDict(newAnnotDict)) continue;
      const annotRef = isRef(newEntry) ? newEntry : outDoc.allocObject(newAnnotDict);
      if (!isRef(newEntry)) newAnnots[j - 1] = annotRef; // swap inline -> ref
      objSurv.set(elem.Ref.num, { newRef: annotRef, annotDict: newAnnotDict });
    }
  }

  if (keep.size === 0) return;

  // Phase 2 — clone kept elements top-down from the root, preserving order.
  const cache = new Map<number, PdfRef>();   // src elem num -> new ref
  for (const k of childEntries(srcDoc, srcRootDict)) {
    if (isRef(k) && keep.has(k.num)) {
      const r = cloneElem(outDoc, srcDoc, k.num, pageMap, keep, cache, objSurv, tree.rootRef);
      tree.topK.push(r);
    }
  }

  // Phase 3 — rebuild ParentTree entries with cloned refs + fresh keys.
  for (const { newPageNum, arr } of pageArrays) {
    const newArr = arr.map((e) => (isRef(e) && cache.has(e.num) ? cache.get(e.num)! : null));
    const newKey = tree.nextKey++;
    const newPage = outDoc.getObject(newPageNum);
    if (isDict(newPage)) newPage.set('StructParents', newKey);
    tree.nums.push(newKey, newArr);
  }

  // Phase 3b — object entries: allocate a key, set the annotation's
  // /StructParent, and add ParentTree[objKey] = cloned element ref.
  for (const [srcElemNum, info] of objSurv) {
    const cloned = cache.get(srcElemNum);
    if (!cloned) continue;
    const objKey = tree.nextKey++;
    info.annotDict.set('StructParent', objKey);
    tree.nums.push(objKey, cloned);
  }

  mergeRoleMap(outDoc, srcDoc, srcRootDict, cache, tree);
}

/** Union the source RoleMap into the out tree. On a key collision with a
 *  DIFFERENT target, rename the source role (suffix _2, _3, …) and rewrite the
 *  /S of every element cloned from this source that used the old name. */
function mergeRoleMap(
  outDoc: Document, srcDoc: Document, srcRootDict: PdfDict,
  cache: Map<number, PdfRef>, tree: OutTree,
): void {
  const srcRm = readRoleMap(srcDoc, srcRootDict);
  if (srcRm.size === 0) return;
  const renames = new Map<string, string>(); // old src role -> new unique role
  for (const [role, target] of srcRm) {
    const existing = tree.roleMap.get(role);
    if (existing === undefined) { tree.roleMap.set(role, target); continue; }
    if (existing === target) continue; // identical mapping — nothing to do
    let alt = role, i = 2;
    while (tree.roleMap.has(alt)) { alt = `${role}_${i++}`; }
    tree.roleMap.set(alt, target);
    renames.set(role, alt);
  }
  if (renames.size === 0) return;
  // Rewrite cloned elements' /S that used a renamed role.
  for (const newRef of cache.values()) {
    const elem = outDoc.getObject(newRef.num);
    if (!isDict(elem)) continue;
    const s = elem.get('S');
    if (isName(s) && renames.has(s.name)) elem.set('S', name(renames.get(s.name)!));
  }
}

/** Add `num` and its /P ancestors (that are structure elements) to `keep`. */
function markKeep(srcDoc: Document, num: number, keep: Set<number>): void {
  let cur = num;
  while (!keep.has(cur)) {
    keep.add(cur);
    const d = srcDoc.getObject(cur);
    const p = isDict(d) ? d.get('P') : undefined;
    if (!isRef(p) || !isStructElemNum(srcDoc, p.num)) break;
    cur = p.num;
  }
}

/** Clone a kept element + its kept descendants; rebuild /K in source order. */
function cloneElem(
  outDoc: Document, srcDoc: Document, srcNum: number,
  pageMap: Map<number, number>, keep: Set<number>, cache: Map<number, PdfRef>,
  objSurv: Map<number, ObjSurv>, parentRef: PdfRef,
): PdfRef {
  const hit = cache.get(srcNum);
  if (hit) return hit;
  const src = srcDoc.getObject(srcNum) as PdfDict;
  const clone: PdfDict = new Map();
  const newRef = outDoc.allocObject(clone);
  cache.set(srcNum, newRef);

  for (const [key, val] of src) {
    if (key === 'K' || key === 'P' || key === 'Pg') continue;
    clone.set(key, deepCopy(outDoc, srcDoc, val, new Map()));
  }
  clone.set('P', parentRef);
  const pg = src.get('Pg');
  if (isRef(pg) && pageMap.has(pg.num)) clone.set('Pg', ref(pageMap.get(pg.num)!));

  const newK: PdfObject[] = [];
  for (const entry of childEntries(srcDoc, src)) {
    if (isRef(entry) && isStructElemNum(srcDoc, entry.num)) {
      if (keep.has(entry.num)) newK.push(cloneElem(outDoc, srcDoc, entry.num, pageMap, keep, cache, objSurv, newRef));
    } else {
      const item = remapContentItem(srcDoc, entry, pageMap, objSurv, srcNum);
      if (item !== undefined) newK.push(item);
    }
  }
  clone.set('K', newK);
  return newRef;
}

/** A content item in /K that is not a child element: integer MCID, MCR dict, or
 *  OBJR dict. `ownerSrcNum` is the source element whose /K this belongs to (used
 *  to resolve the OBJR's surviving annotation). Returns undefined to drop. */
function remapContentItem(
  srcDoc: Document, entry: PdfObject, pageMap: Map<number, number>,
  objSurv: Map<number, ObjSurv>, ownerSrcNum: number,
): PdfObject | undefined {
  if (typeof entry === 'number') return entry; // MCID — content stream copied verbatim
  const d = srcDoc.resolve(entry);
  if (!isDict(d) || !isName(d.get('Type'))) return undefined;
  const type = (d.get('Type') as { name: string }).name;
  if (type === 'MCR') {
    const pg = d.get('Pg');
    if (isRef(pg) && !pageMap.has(pg.num)) return undefined; // MCR on a dropped page
    const copy = new Map(d);
    if (isRef(pg) && pageMap.has(pg.num)) copy.set('Pg', ref(pageMap.get(pg.num)!));
    return copy;
  }
  if (type === 'OBJR') {
    const info = objSurv.get(ownerSrcNum);
    if (!info) return undefined; // annotation did not survive
    const copy = new Map(d);
    copy.set('Obj', info.newRef);
    const pg = d.get('Pg');
    if (isRef(pg) && pageMap.has(pg.num)) copy.set('Pg', ref(pageMap.get(pg.num)!));
    return copy;
  }
  return undefined;
}

/** /K entries of a struct element or the root, normalized to an array. */
function childEntries(doc: Document, dict: PdfDict): PdfObject[] {
  const k = dict.get('K');
  if (k === undefined) return [];
  const resolved = doc.resolve(k);
  return isArray(resolved) ? resolved : [k];
}

function isStructElemNum(doc: Document, num: number): boolean {
  const d = doc.getObject(num);
  return isDict(d) && d.has('S');
}

/** Deep-copy an attribute value into outDoc, allocating referenced objects.
 *  Struct attribute graphs are acyclic in practice (no cycle guard needed). */
function deepCopy(outDoc: Document, srcDoc: Document, val: PdfObject, cache: Map<number, PdfRef>): PdfObject {
  if (isRef(val)) {
    const hit = cache.get(val.num);
    if (hit) return hit;
    const copied = deepCopy(outDoc, srcDoc, srcDoc.getObject(val.num), cache);
    const r = outDoc.allocObject(copied);
    cache.set(val.num, r);
    return r;
  }
  if (isArray(val)) return val.map((v) => deepCopy(outDoc, srcDoc, v, cache));
  if (isDict(val)) { const m: PdfDict = new Map(); for (const [k, v] of val) m.set(k, deepCopy(outDoc, srcDoc, v, cache)); return m; }
  return val; // scalar / name / string
}

/** Install the accumulated tree into outDoc's catalog. */
function finalizeTree(outDoc: Document, tree: OutTree): void {
  tree.rootDict.set('K', tree.topK);
  const existingPt = outDoc.resolve(tree.rootDict.get('ParentTree'));
  if (isDict(existingPt)) existingPt.set('Nums', tree.nums);
  else tree.rootDict.set('ParentTree', outDoc.allocObject(new Map([['Nums', tree.nums]])));
  tree.rootDict.set('ParentTreeNextKey', tree.nextKey);
  if (tree.roleMap.size > 0) {
    const rm: PdfDict = new Map();
    for (const [k, v] of tree.roleMap) rm.set(k, name(v));
    tree.rootDict.set('RoleMap', rm);
  }
  const catalog = outDoc.catalog();
  catalog.set('StructTreeRoot', tree.rootRef);
  catalog.set('MarkInfo', new Map([['Marked', true]]));
}
