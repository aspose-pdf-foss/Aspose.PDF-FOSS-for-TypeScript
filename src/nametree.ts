// The /Root /Names name-tree vocabulary, read and write.
//
// A LEAF, deliberately: it imports Document as a TYPE only, which is what lets
// document.ts, embeddedfile.ts and docaction.ts all hold it without any of them
// depending on another — the arrangement tablegrid.ts already has between the
// two table detectors. It lives here rather than in outline.ts because that
// module is bookmarks and destinations, and a name tree is neither: /Dests is
// only one of its three branches.
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isString } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** Look up `key` in a /Names name-tree node (honoring /Limits when present). */
export function lookupNameTree(doc: Document, node: PdfObject, key: string): PdfObject | undefined {
  const n = doc.resolve(node);
  if (!isDict(n)) return undefined;
  const names = doc.resolve(n.get('Names'));
  if (isArray(names)) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.resolve(names[i]);
      if (isString(k) && decodePdfText(k.bytes) === key) return names[i + 1];
    }
  }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) {
    for (const kid of kids) {
      const kd = doc.resolve(kid);
      if (!isDict(kd)) continue;
      const limits = doc.resolve(kd.get('Limits'));
      if (isArray(limits) && isString(limits[0]) && isString(limits[1])) {
        const lo = decodePdfText(limits[0].bytes), hi = decodePdfText(limits[1].bytes);
        if (key < lo || key > hi) continue;
      }
      const found = lookupNameTree(doc, kd, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Collect every (name → value) pair from a /Names name-tree node, flattening
 *  any /Kids recursion. Values are returned raw (undecoded). */
export function collectNameTree(doc: Document, node: PdfObject | undefined, out: Array<[string, PdfObject]>): void {
  const n = doc.resolve(node);
  if (!isDict(n)) return;
  const names = doc.resolve(n.get('Names'));
  if (isArray(names))
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.resolve(names[i]);
      if (isString(k)) out.push([decodePdfText(k.bytes), names[i + 1]]);
    }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) for (const kid of kids) collectNameTree(doc, kid, out);
}

/** Build a single flat name-tree node (`<< /Names [(k) v ...] >>`) from a map,
 *  keys sorted ascending as the /Names array requires. */
export function flatNameNode(entries: Map<string, PdfObject>): PdfDict {
  const keys = [...entries.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const names: PdfObject[] = [];
  for (const k of keys) names.push({ kind: 'string', bytes: encodePdfText(k) }, entries.get(k)!);
  return new Map<string, PdfObject>([['Names', names]]);
}

/** Upsert `key` → `value` into `/Root /Names /<branch>`, creating the
 *  containers as needed and rewriting the branch as a single flat node — no
 *  balanced-tree rebalancing, which is what all three branches already did.
 *
 *  The value is stored EXACTLY as given: `/Dests` stores a direct array and
 *  `/EmbeddedFiles` a ref, so this must not decide for them. The branch NODE is
 *  always allocated, which every existing call site did and which the attachment
 *  suite's saved-bytes assertions depend on. */
export function upsertNameTreeEntry(
  doc: Document, branch: string, key: string, value: PdfObject,
): void {
  const catalog = doc.catalog();
  let names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) { names = new Map<string, PdfObject>(); catalog.set('Names', names); }
  const entries = new Map<string, PdfObject>();
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, collected);
  for (const [k, v] of collected) entries.set(k, v);
  entries.set(key, value);
  names.set(branch, doc.allocObject(flatNameNode(entries)));
}

/** Remove `key` from `/Root /Names /<branch>`, returning the value that was
 *  there (undefined when the key, the branch or /Names was absent).
 *
 *  Returns the VALUE rather than a boolean because `removeEmbeddedFile` needs it
 *  to unregister the filespec from /AF, and would otherwise walk the tree a
 *  second time to recover what this call already found. `!== undefined` is the
 *  boolean for callers that only want that.
 *
 *  **Pruning is two-level.** Emptying the branch deletes it from /Names, and if
 *  /Names is then empty it is deleted from the catalog. One level leaves
 *  `<< /Names << >> >>` behind: legal, harmless, and different from what the
 *  other branches produce — so the divergence surfaces as a byte diff in an
 *  unrelated feature rather than as a failure here. */
export function removeNameTreeEntry(
  doc: Document, branch: string, key: string,
): PdfObject | undefined {
  const catalog = doc.catalog();
  const names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) return undefined;
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, collected);
  const entries = new Map<string, PdfObject>(collected);
  const removed = entries.get(key);
  if (!entries.delete(key)) return undefined;
  if (entries.size === 0) {
    names.delete(branch);
    if (names.size === 0) catalog.delete('Names');
  } else {
    names.set(branch, doc.allocObject(flatNameNode(entries)));
  }
  return removed;
}
