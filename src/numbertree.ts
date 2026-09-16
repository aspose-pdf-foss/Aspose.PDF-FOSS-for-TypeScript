import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';

/** The PDF number tree (7.9.7), read and write.
 *
 *  **Invariant:** a near-LEAF — `Document` arrives as a TYPE only, for
 *  `resolve` — so every rule here is testable from hand-built Maps with no PDF
 *  built. It is a module rather than part of `struct.ts` because
 *  `structremove.ts` needs it and `struct.ts` imports THAT by value, so
 *  reaching back would close a cycle. `nametree.ts` is the NAME-tree sibling,
 *  and the extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
 *  `langmatch.ts` and `structtype.ts` each already made. */

/** Look up `key` in a PDF number tree rooted at `node` (/Nums leaves, /Kids
 *  with /Limits). Returns the RAW value so a caller can resolve it itself. */
export function lookupNumberTree(doc: Document, node: PdfDict, key: number): PdfObject | undefined {
  let cur: PdfDict | undefined = node;
  const seen = new Set<PdfDict>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (doc.resolve(nums[i]) === key) return nums[i + 1];
      }
    }
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return undefined;
    let next: PdfDict | undefined;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (!isDict(kd)) continue;
      const lim = doc.resolve(kd.get('Limits'));
      if (isArray(lim) && lim.length === 2) {
        const lo = doc.resolve(lim[0]); const hi = doc.resolve(lim[1]);
        if (typeof lo === 'number' && typeof hi === 'number' && key >= lo && key <= hi) {
          next = kd; break;
        }
      }
    }
    cur = next;
  }
  return undefined;
}

/** Every LIVE flat /Nums array in the tree, in document order.
 *
 *  The WRITE side: `lookupNumberTree` answers "what is the value for key K",
 *  which is enough to read a slot and not enough to null one or to splice a
 *  pair out. A caller mutates what this returns in place.
 *
 *  **Invariant:** it descends /Kids WITHOUT consulting /Limits, unlike the
 *  lookup. A release has no key to steer by — it is collecting every leaf —
 *  and a tree whose /Limits are wrong would otherwise hide a pair that really
 *  is there, which is precisely the damaged-file case this must survive. */
export function numsArrays(doc: Document, node: PdfDict): PdfObject[][] {
  const out: PdfObject[][] = [];
  const seen = new Set<PdfDict>();
  const walk = (cur: PdfDict): void => {
    if (seen.has(cur)) return;
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) out.push(nums);
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (isDict(kd)) walk(kd);
    }
  };
  walk(node);
  return out;
}
