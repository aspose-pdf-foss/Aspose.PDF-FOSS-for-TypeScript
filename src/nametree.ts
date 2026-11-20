// The /Root /Names name-tree vocabulary, read and write.
//
// A LEAF, deliberately: it imports Document as a TYPE only, which is what lets
// document.ts, embeddedfile.ts and docaction.ts all hold it without any of them
// depending on another — the arrangement tablegrid.ts already has between the
// two table detectors. It lives here rather than in outline.ts because that
// module is bookmarks and destinations, and a name tree is neither: /Dests is
// only one of its three branches.
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfString, isArray, isDict, isString } from './types.js';
import { decodePdfByteString, encodePdfByteString } from './metadata.js';

type KeyRange = readonly [min: Uint8Array, max: Uint8Array];

/** A decoded name can match both the single-byte and UTF-16BE spellings. */
function keyRanges(key: string | Uint8Array): KeyRange[] {
  if (typeof key !== 'string') return [[key, key]];

  const utf16 = Buffer.from(`\ufeff${key}`, 'utf16le').swap16();
  // The byte-string decoder tolerates one incomplete trailing UTF-16 code unit.
  const ranges: KeyRange[] = [[utf16, Buffer.concat([utf16, Uint8Array.of(0xff)])]];
  const single = Buffer.from(key, 'latin1');
  if (single.toString('latin1') === key && !(single[0] === 0xfe && single[1] === 0xff))
    ranges.push([single, single]);
  return ranges;
}

/** Look up a raw PDF key or a decoded API name, pruning children by byte order. */
export function lookupNameTree(doc: Document, node: PdfObject, key: string | Uint8Array): PdfObject | undefined {
  return lookup(doc, node, key, keyRanges(key), 1, new Set<PdfDict>());
}

function lookup(
  doc: Document, node: PdfObject, key: string | Uint8Array, ranges: readonly KeyRange[],
  depth: number, seen: Set<PdfDict>,
): PdfObject | undefined {
  const n = doc.resolve(node);
  // A node already on this walk is a cycle: damage, which costs the subtree and
  // never throws. Depth is a bound: it throws. The two differ on purpose, and a
  // tree that names itself used to recurse until the stack gave out.
  if (!isDict(n) || seen.has(n)) return undefined;
  seen.add(n);
  doc.loadLimits.enforce('maxNestingDepth', depth, 'name tree');
  const names = doc.resolve(n.get('Names'));
  if (isArray(names)) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.resolve(names[i]);
      if (!isString(k)) continue;
      const matches = typeof key === 'string' ? decodePdfByteString(k.bytes) === key : Buffer.compare(k.bytes, key) === 0;
      if (matches) return names[i + 1];
    }
  }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) {
    for (const kid of kids) {
      const kd = doc.resolve(kid);
      if (!isDict(kd)) continue;
      const limits = doc.resolve(kd.get('Limits'));
      if (isArray(limits)) {
        const lo = doc.resolve(limits[0]);
        const hi = doc.resolve(limits[1]);
        if (isString(lo) && isString(hi) && !ranges.some(([min, max]) =>
          Buffer.compare(max, lo.bytes) >= 0 && Buffer.compare(min, hi.bytes) <= 0)) continue;
      }
      const found = lookup(doc, kd, key, ranges, depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Collect every (name → value) pair from a /Names name-tree node, flattening
 *  any /Kids recursion. Values are returned raw (undecoded). */
export function collectNameTree(
  doc: Document, node: PdfObject | undefined, out: Array<[string, PdfObject]>,
  depth = 1, seen = new Set<PdfDict>(),
): void {
  for (const [key, value] of nameTreeEntries(doc, node, depth, seen))
    out.push([decodePdfByteString(key.bytes), value]);
}

/** Flatten a name tree without interpreting its keys. @internal */
export function* nameTreeEntries(
  doc: Document, node: PdfObject | undefined, depth = 1, seen = new Set<PdfDict>(),
): Generator<[PdfString, PdfObject]> {
  const n = doc.resolve(node);
  if (!isDict(n) || seen.has(n)) return;
  seen.add(n);
  doc.loadLimits.enforce('maxNestingDepth', depth, 'name tree');
  const names = doc.resolve(n.get('Names'));
  if (isArray(names))
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.resolve(names[i]);
      if (isString(k)) yield [k, names[i + 1]];
    }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) for (const kid of kids) yield* nameTreeEntries(doc, kid, depth + 1, seen);
}

/** Consume entries and build a flat node sorted by unsigned key bytes.
 *  For duplicate byte keys, the last value wins. ISO 32000-1 §7.9.6. */
export function flatNameNode(entries: Array<[PdfString, PdfObject]>): PdfDict {
  entries.sort(([a], [b]) => Buffer.compare(a.bytes, b.bytes));
  const names: PdfObject[] = [];
  let previous: PdfString | undefined;
  for (const [key, value] of entries) {
    if (previous && Buffer.compare(previous.bytes, key.bytes) === 0) names[names.length - 1] = value;
    else names.push(key, value);
    previous = key;
  }
  return new Map<string, PdfObject>([['Names', names]]);
}

/** Upsert `key` → `value` into `/Root /Names /<branch>`, creating the
 *  containers as needed and rewriting the branch as a single flat node — no
 *  balanced-tree rebalancing, which is what all three branches already did.
 *  Existing byte spellings of the decoded name keep their original keys.
 *  Destinations also need the key spelling used by authored bookmarks.
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
  const entries = [...nameTreeEntries(doc, names.get(branch))];
  const authoredKey: PdfString = { kind: 'string', bytes: encodePdfByteString(key) };
  let needsKey = true;
  for (const entry of entries) {
    if (decodePdfByteString(entry[0].bytes) !== key) continue;
    entry[1] = value;
    if (branch !== 'Dests' || Buffer.compare(entry[0].bytes, authoredKey.bytes) === 0) needsKey = false;
  }
  if (needsKey) entries.push([authoredKey, value]);
  names.set(branch, doc.allocObject(flatNameNode(entries)));
}

/** Remove every byte spelling of the decoded `key` in `/Root /Names /<branch>`.
 *  Return the removed values so `removeEmbeddedFile` can unregister their
 *  filespecs from /AF.
 *
 *  **Pruning is two-level.** Emptying the branch deletes it from /Names, and if
 *  /Names is then empty it is deleted from the catalog. One level leaves
 *  `<< /Names << >> >>` behind: legal, harmless, and different from what the
 *  other branches produce — so the divergence surfaces as a byte diff in an
 *  unrelated feature rather than as a failure here. */
export function removeNameTreeEntries(
  doc: Document, branch: string, key: string,
): PdfObject[] {
  const catalog = doc.catalog();
  const names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) return [];
  const entries: Array<[PdfString, PdfObject]> = [];
  const removed: PdfObject[] = [];
  for (const entry of nameTreeEntries(doc, names.get(branch))) {
    if (decodePdfByteString(entry[0].bytes) === key) removed.push(entry[1]);
    else entries.push(entry);
  }
  if (removed.length === 0) return removed;
  if (entries.length === 0) {
    names.delete(branch);
    if (names.size === 0) catalog.delete('Names');
  } else {
    names.set(branch, doc.allocObject(flatNameNode(entries)));
  }
  return removed;
}
