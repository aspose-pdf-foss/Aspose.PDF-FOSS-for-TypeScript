import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';
import { numsArrays } from './numbertree.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import { visitContent } from './text.js';
import type { ContentOp } from './content.js';

/** What a removal released.
 *
 *  `unreachable` counts marked-content items whose `BDC` the content walk
 *  cannot address — an item whose /Pg does not resolve, and a BDC inside a
 *  tiling pattern, a Type 3 /CharProcs or an annotation appearance, none of
 *  which `ContentAddr`'s XObject-name chain can name (the `85l8.6` limit). */
export interface StructRemoveResult {
  /** Elements detached, including descendants. */
  elements: number;
  /** /ParentTree marked-content slots released. */
  mcids: number;
  /** OBJR annotations unwired. */
  annotations: number;
  /** Marked-content sequences whose BDC could not be reached. */
  unreachable: number;
}

const asNum = (o: PdfObject | undefined): number | undefined =>
  (typeof o === 'number' ? o : undefined);

/** The element and every descendant, cycle-guarded. */
function subtree(el: StructElement, out: StructElement[], seen: Set<PdfDict>): void {
  if (seen.has(el.Dict)) return;
  seen.add(el.Dict);
  out.push(el);
  for (const c of el.Children) subtree(c, out, seen);
}

/** Null the slot at `mcid` in the array the page key maps to. True when a live
 *  entry was actually released.
 *
 *  **Invariant:** the slot is NULLED, never spliced, and the page's key/value
 *  pair is never removed. MCIDs are INDICES, so shortening the array renumbers
 *  every later one; and that pair's value is the array shared by EVERY element
 *  on the page, so removing it orphans all of them. That is exactly what
 *  `untagObjects`'s `clearParentTreeKeys` would have done, which is why it is
 *  a precedent here rather than a function to call. */
function releaseMcid(doc: Document, pt: PdfDict, pageKey: number, mcid: number): boolean {
  for (const nums of numsArrays(doc, pt)) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (asNum(doc.resolve(nums[i])) !== pageKey) continue;
      const arr = doc.resolve(nums[i + 1]);
      if (!isArray(arr) || mcid < 0 || mcid >= arr.length) return false;
      if (arr[mcid] === null) return false;   // already released
      arr[mcid] = null;
      return true;
    }
  }
  return false;
}

/** Splice an object key's whole key/value pair out. True when one went.
 *
 *  **Invariant:** an annotation's /StructParent names ONE entry, so the pair
 *  goes whole — the opposite of the MCID case above, and the distinction this
 *  whole feature turns on. */
function releaseObjectKey(doc: Document, pt: PdfDict, key: number): boolean {
  for (const nums of numsArrays(doc, pt)) {
    for (let i = nums.length - 2; i >= 0; i -= 2) {
      if (asNum(doc.resolve(nums[i])) === key) { nums.splice(i, 2); return true; }
    }
  }
  return false;
}

/** The element and every descendant, cycle-guarded.
 *
 *  Exported so `structmove.ts` shares one answer to "what is this element's
 *  subtree" — the containment test behind the cycle refusal, and the walk the
 *  /Pg materialization runs. */
export function subtreeOf(el: StructElement): StructElement[] {
  const out: StructElement[] = [];
  subtree(el, out, new Set());
  return out;
}

/** Detach `dict` from `parent`'s /K. True when it was there. */
export function detachKid(doc: Document, parent: PdfDict, dict: PdfDict): boolean {
  const raw = doc.resolve(parent.get('K'));
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      if (doc.resolve(raw[i]) === dict) { raw.splice(i, 1); return true; }
    }
    return false;
  }
  if (raw !== undefined && doc.resolve(raw) === dict) { parent.delete('K'); return true; }
  return false;
}

/** Index of the `EMC` matching the `BDC` at `from`, or -1.
 *
 *  **Invariant:** it counts NESTING. A child element's marked content is
 *  commonly nested inside its parent's — a `/Link` mid-paragraph is the
 *  everyday case — so the first `EMC` after a `BDC` is frequently the CHILD's.
 *  Take that one and the parent's sequence is left unterminated, which is a
 *  content stream no reader can make sense of. */
function matchingEmc(ops: readonly ContentOp[], from: number): number {
  let depth = 0;
  for (let i = from; i < ops.length; i++) {
    const op = ops[i].operator;
    if (op === 'BDC' || op === 'BMC') depth++;
    else if (op === 'EMC') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Delete the BDC/EMC pair of every `(page, mcid)` in `byPage`, keeping every
 *  op between them. Returns how many sequences could not be reached. */
function unwrapContent(doc: Document, byPage: Map<Page, Set<number>>): number {
  let unreachable = 0;
  for (const [page, want] of byPage) {
    const hits: { addr: ContentAddr; mcid: number }[] = [];
    // No ContentWalkOptions: skipHidden keeps its `false` default, so content
    // the current optional-content configuration hides is untagged too. An
    // EDIT consumer must see what the file contains (q1g2.3).
    visitContent(doc, page, {
      marked(e) { if (want.has(e.mcid)) hits.push({ addr: e.addr, mcid: e.mcid }); },
    });
    const found = new Set(hits.map((h) => h.mcid));
    for (const m of want) if (!found.has(m)) unreachable++;
    if (hits.length === 0) continue;

    const ec = new EditableContent(doc, page);
    const scopes = new Map<string, { addr: ContentAddr; starts: Set<number> }>();
    for (const h of hits) {
      const key = `${h.addr.path.join('\0')}${h.addr.streamIndex}`;
      const hit = scopes.get(key);
      if (hit) hit.starts.add(h.addr.opIndex);
      else scopes.set(key, { addr: h.addr, starts: new Set([h.addr.opIndex]) });
    }

    for (const { addr, starts } of scopes.values()) {
      const top = addr.path.length === 0;
      const list = [...(top ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path))];
      // Pair each BDC with its EMC BEFORE deleting anything, then delete every
      // index DESCENDING.
      //
      // **Invariant, and it is the INVERSE of q7hc.1's:** `retagContentItems`
      // may collect addresses up front because a REPLACE moves nothing. A
      // DELETE shifts every later index, so both the pairing and the order
      // matter. Ascending deletion takes the wrong ops for the second sequence
      // in a stream — and still yields a parseable content stream, so only an
      // op-level assertion can see it.
      const doomed: number[] = [];
      for (const s of starts) {
        if (list[s]?.operator !== 'BDC') { unreachable++; continue; }
        const e = matchingEmc(list, s);
        if (e < 0) { unreachable++; continue; }
        doomed.push(s, e);
      }
      if (doomed.length === 0) continue;
      doomed.sort((a, b) => b - a);
      for (const i of doomed) list.splice(i, 1);
      if (top) ec.setTopOps(addr.streamIndex, list);
      else ec.setXobjectOps(addr.path, list);
    }
    ec.commit();
  }
  return unreachable;
}

/** Remove `element` and its subtree from the structure tree, releasing every
 *  /ParentTree slot it holds and unwiring its OBJR annotations.
 *
 *  The element dicts are NOT deleted from the document: `Save`'s mark-sweep
 *  drops them once unreachable, which is this library's model everywhere else.
 *
 *  **Invariant:** an OBJR's annotation SURVIVES, losing only its
 *  /StructParent. `untagObjects` never clears that key because its objects are
 *  dying; here they are not, and a /StructParent naming a released entry
 *  dangles. */
export function removeElement(doc: Document, element: StructElement): StructRemoveResult {
  const out: StructRemoveResult = { elements: 0, mcids: 0, annotations: 0, unreachable: 0 };

  // Detach FIRST, and bail when it was not attached: that is what makes a
  // second Remove() a no-op rather than a second release.
  const parentRaw = element.Dict.get('P');
  const parentDict = doc.resolve(parentRaw);
  const container = isDict(parentDict) ? parentDict : element.Root.Dict;
  if (!detachKid(doc, container, element.Dict)) return out;

  const els = subtreeOf(element);
  out.elements = els.length;

  const pt = doc.resolve(element.Root.Dict.get('ParentTree'));
  if (!isDict(pt)) { doc.markModified(); return out; }

  const byPage = new Map<Page, Set<number>>();
  for (const el of els) {
    for (const item of el.ContentItems) {
      if (item.kind === 'objr') {
        const annot = doc.resolve(item.ref);
        if (!isDict(annot)) continue;
        const key = asNum(doc.resolve(annot.get('StructParent')));
        if (key === undefined) continue;
        if (releaseObjectKey(doc, pt, key)) out.annotations++;
        annot.delete('StructParent');
        continue;
      }
      if (item.page === undefined) { out.unreachable++; continue; }
      const pageKey = asNum(doc.resolve(item.page.Dict.get('StructParents')));
      if (pageKey === undefined) { out.unreachable++; continue; }
      if (releaseMcid(doc, pt, pageKey, item.mcid)) out.mcids++;
      let s = byPage.get(item.page);
      if (!s) { s = new Set<number>(); byPage.set(item.page, s); }
      s.add(item.mcid);
    }
  }

  out.unreachable += unwrapContent(doc, byPage);
  doc.markModified();
  return out;
}
