import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, isStream, isDict, isArray, isRef, isName, ref,
} from './types.js';
import { serializeValue } from './serialize.js';

export interface DedupResult {
  merged: number;
  /** Sum of the raw payload bytes of every dropped duplicate. */
  bytesSaved: number;
}

/** Objects whose *identity* is meaningful even when their content matches. */
const EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'Page', 'Annot', 'OCG', 'Sig', 'XRef', 'ObjStm', 'Metadata',
]);

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

/** A canonical key for a dict: keys sorted, so insertion order cannot make two
 *  semantically equal dicts hash differently. Values are serialized as-is —
 *  refs included, so two streams whose dicts point at different objects (even
 *  equal ones) are correctly left unmerged. */
function canonicalDict(d: PdfDict): string {
  const keys = [...d.keys()].sort();
  return keys.map((k) => `${k}=${serializeValue(d.get(k) as PdfObject)}`).join(' ');
}

/** Rewrite every ref in `o` in place through `map`. Live dicts/arrays are
 *  mutated rather than copied so existing handles keep seeing the model. */
function rewriteRefs(o: PdfObject, map: Map<number, number>): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      if (isRef(v)) { const to = map.get(v.num); if (to !== undefined) o[i] = ref(to, 0); }
      else rewriteRefs(v, map);
    }
  } else if (isDict(o)) {
    for (const [k, v] of o) {
      if (isRef(v)) { const to = map.get(v.num); if (to !== undefined) o.set(k, ref(to, 0)); }
      else rewriteRefs(v, map);
    }
  } else if (isStream(o)) {
    rewriteRefs(o.dict, map);
  }
}

/**
 * Merge indirect streams with equal dicts and byte-identical payloads. The
 * lowest object number wins; refs to the duplicates are repointed at it and the
 * duplicates are deleted. Identity-sensitive /Type values are exempt.
 */
export function dedupStreams(doc: Document): DedupResult {
  // Group by content key, keeping the lowest object number as canonical.
  const canonical = new Map<string, number>();
  const dupToCanon = new Map<number, number>();
  let bytesSaved = 0;

  const entries = [...doc.objectEntries()].sort((a, b) => a[0].num - b[0].num);
  for (const [r, obj] of entries) {
    if (!isStream(obj)) continue;
    const t = typeName(obj.dict);
    if (t !== undefined && EXEMPT_TYPES.has(t)) continue;
    const key = `${canonicalDict(obj.dict)}${createHash('sha256').update(obj.raw).digest('hex')}`;
    const first = canonical.get(key);
    if (first === undefined) { canonical.set(key, r.num); continue; }
    dupToCanon.set(r.num, first);
    bytesSaved += obj.raw.length;
  }
  if (dupToCanon.size === 0) return { merged: 0, bytesSaved: 0 };

  for (const [, obj] of doc.objectEntries()) rewriteRefs(obj, dupToCanon);
  rewriteRefs(doc.trailer, dupToCanon);
  for (const num of dupToCanon.keys()) doc.deleteObject(num);

  return { merged: dupToCanon.size, bytesSaved };
}
