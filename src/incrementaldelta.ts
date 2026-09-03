import { PdfObject } from './types.js';
import { serializeObject } from './serialize.js';

/** What an incremental update must write, relative to the document as opened. */
export interface ObjectDelta {
  /** Present in both, serializing differently: write the live value. */
  replaced: Set<number>;
  /** Absent from the baseline: write the live value. */
  added: Set<number>;
  /** Present in the baseline, absent now: write a free xref entry. */
  freed: Set<number>;
}

/** Compare a pristine `baseline` against the `live` object map.
 *
 *  Equality is byte-equality of `serializeObject`'s output, with BOTH sides
 *  through the same serializer. That is sound however the mutation happened --
 *  including a direct write through a public `Dict` handle, which reports
 *  nothing -- and it fails in the safe direction: a document that merely
 *  reordered a dict's keys is reported changed and written again, where a
 *  missed change would be silently dropped from the revision. */
export function diffObjects(
  baseline: Map<number, PdfObject>,
  live: Map<number, PdfObject>,
): ObjectDelta {
  const replaced = new Set<number>();
  const added = new Set<number>();
  const freed = new Set<number>();

  for (const [num, obj] of live) {
    if (!baseline.has(num)) { added.add(num); continue; }
    if (!sameBytes(serializeObject(baseline.get(num)!), serializeObject(obj))) replaced.add(num);
  }
  for (const num of baseline.keys()) if (!live.has(num)) freed.add(num);

  return { replaced, added, freed };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
