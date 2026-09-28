import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfStream, isStream, isDict, isArray, isRef, isName, ref,
} from './types.js';
import { serializeValue } from './serialize.js';
import { decodeStream } from './filters.js';
import { imageKey } from './imagehref.js';
import { rethrowLimit } from './errors.js';

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

/** Filters whose output is a lossless function of their input and cheap to
 *  run, so decoding to compare costs less than the duplicate it finds. The
 *  opaque codecs (DCT, JPX, CCITT, JBIG2) are left to the byte-identical key. */
const TRANSPARENT_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL',
  'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85',
]);

/** The dict entries that describe how a payload is ENCODED, not what it holds. */
const ENCODING_KEYS: ReadonlySet<string> = new Set(['Filter', 'DecodeParms', 'DP', 'Length', 'DL']);

/** A key over an image XObject's DECODED samples, or `undefined` when the image
 *  is not one this compares that way — not an `/Image`, an opaque codec in its
 *  chain, or a payload that will not decode (the byte key still applies). */
function sampleKey(doc: Document, s: PdfStream): string | undefined {
  const sub = s.dict.get('Subtype');
  if (!isName(sub) || sub.name !== 'Image') return undefined;
  const f = doc.resolve(s.dict.get('Filter'));
  const chain = f === undefined || f === null ? [] : isArray(f) ? f.map((x) => doc.resolve(x)) : [f];
  if (!chain.every((x) => isName(x) && TRANSPARENT_FILTERS.has(x.name))) return undefined;
  let samples: Uint8Array;
  try { samples = decodeStream(s); } catch (caught) { rethrowLimit(caught); return undefined; }
  const meaning: PdfDict = new Map([...s.dict].filter(([k]) => !ENCODING_KEYS.has(k)));
  return `img:${imageKey(samples, canonicalDict(meaning))}`;
}

/** One pass: group streams by content key and merge each group into its
 *  smallest member. */
function dedupOnce(doc: Document): DedupResult {
  const groups = new Map<string, { num: number; size: number }[]>();
  const entries = [...doc.objectEntries()].sort((a, b) => a[0].num - b[0].num);
  for (const [r, obj] of entries) {
    if (!isStream(obj)) continue;
    const t = typeName(obj.dict);
    if (t !== undefined && EXEMPT_TYPES.has(t)) continue;
    const key = sampleKey(doc, obj)
      ?? `${canonicalDict(obj.dict)}${createHash('sha256').update(obj.raw).digest('hex')}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push({ num: r.num, size: obj.raw.length });
  }

  const dupToCanon = new Map<number, number>();
  let bytesSaved = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Keep the SMALLEST payload, ties to the lowest object number. For a
    // byte-identical group every size is equal, so this is the lowest number as
    // it always was; for a decoded-sample group it keeps the compressed copy
    // rather than the raw one.
    const keep = g.reduce((a, b) => (b.size < a.size ? b : a));
    for (const m of g) {
      if (m === keep) continue;
      dupToCanon.set(m.num, keep.num);
      bytesSaved += m.size;
    }
  }
  if (dupToCanon.size === 0) return { merged: 0, bytesSaved: 0 };

  for (const [, obj] of doc.objectEntries()) rewriteRefs(obj, dupToCanon);
  rewriteRefs(doc.trailer, dupToCanon);
  for (const num of dupToCanon.keys()) doc.deleteObject(num);
  return { merged: dupToCanon.size, bytesSaved };
}

/** Bound on merge passes; each pass that merges anything removes an object, so
 *  this only caps pathological chains of dicts-referencing-duplicates. */
const MAX_PASSES = 8;

/**
 * Merge indirect streams with equal content. The key is the dict plus the
 * payload bytes, except for an image XObject coded only with transparent
 * filters, which is keyed by its DECODED samples and the dict minus its
 * encoding entries (`29z6.3`) — one picture stored raw and again Flate-coded is
 * one picture. Refs to the duplicates are repointed at the survivor and the
 * duplicates are deleted. Identity-sensitive /Type values are exempt.
 *
 * Repeated until nothing merges: a dict key serializes its refs, so two images
 * whose `/SMask`s were duplicates only become equal once those masks have
 * merged.
 */
export function dedupStreams(doc: Document): DedupResult {
  const total: DedupResult = { merged: 0, bytesSaved: 0 };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = dedupOnce(doc);
    if (r.merged === 0) break;
    total.merged += r.merged;
    total.bytesSaved += r.bytesSaved;
  }
  return total;
}
