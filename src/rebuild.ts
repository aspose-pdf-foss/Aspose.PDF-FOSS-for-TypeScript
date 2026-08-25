// Rebuilding document structure from recovered objects: the parsing half of
// recovery, paired with recover.ts's pure byte sweep. Everything here
// identifies structure by *shape*, for a file that lost the references that
// would otherwise name it. Takes plain maps and callbacks and never touches a
// Document, so it is testable without building a PDF.

import { XrefEntry } from './xref.js';
import { PdfObject, PdfDict, isArray, isDict, isName, isRef, isStream, ref } from './types.js';
import { decodeObjStm, ObjStmDamage } from './objstm.js';
import { PdfParseError } from './errors.js';
import { readXmp, mirrorXmpToMeta } from './xmp.js';
import { applyUpdate } from './metadata.js';
import { inflateStream } from './flate.js';

/** Register every object the /ObjStm containers in `entries` declare, mutating
 *  `entries` in place and returning the object numbers added plus a damage
 *  record for every container that decoded only partially.
 *
 *  A container carries its own `N G obj` header so the sweep finds it, but the
 *  objects inside carry none and are invisible to any byte scan. Without this,
 *  /Root is unreachable in every file Save({ compressed: true }) produced.
 *
 *  An existing `offset` entry always wins: it was found literally in the file,
 *  whereas the container's header is only a claim about what it holds. A
 *  container that yields nothing at all is skipped, not fatal; one that yields
 *  something registers what it yielded, however damaged. */
export function expandObjectStreams(
  entries: Map<number, XrefEntry>,
  load: (num: number) => PdfObject,
): { added: number[]; damaged: ObjStmDamage[] } {
  const added: number[] = [];
  const damaged: ObjStmDamage[] = [];
  for (const [num, e] of [...entries]) {
    if (e.type !== 'offset') continue;
    let contents: Map<number, PdfObject>;
    try {
      const s = load(num);
      if (!isStream(s)) continue;
      const t = s.dict.get('Type');
      if (!isName(t) || t.name !== 'ObjStm') continue;
      const r = decodeObjStm(s, num);
      contents = r.objects;
      if (r.damage) damaged.push(r.damage);
    } catch {
      continue;
    }
    let index = 0;
    for (const inner of contents.keys()) {
      if (!entries.has(inner)) {
        entries.set(inner, { type: 'compressed', streamObj: num, index });
        added.push(inner);
      }
      index++;
    }
  }
  return { added, damaged };
}

/** Resolve one level against a recovered object map; a dangling ref is null. */
function deref(objects: Map<number, PdfObject>, o: PdfObject | undefined): PdfObject {
  if (o === undefined) return null;
  return isRef(o) ? objects.get(o.num) ?? null : o;
}

/** File offset of an object, following a compressed one to its container.
 *  -1 when unknown, which sorts below every real offset. */
function offsetOf(num: number, entries: Map<number, XrefEntry>): number {
  const e = entries.get(num);
  if (!e) return -1;
  if (e.type === 'offset') return e.offset;
  const c = entries.get(e.streamObj);
  return c && c.type === 'offset' ? c.offset : -1;
}

/** Identify the document catalog among recovered objects.
 *
 *  Validated first, then latest: keep the candidates whose /Pages resolves to a
 *  /Type /Pages, and among those take the highest file offset — last-wins, as
 *  dxfk.1 does for duplicate candidates, matching append-only incremental
 *  updates. Validation earns its cost on a tail-truncated file, where the
 *  *newest* catalog is precisely the broken one.
 *
 *  With nothing walkable, fall back to plain highest-offset rather than
 *  failing: a document with a damaged page tree should still open, carrying the
 *  damage in doc.recovery. Partial salvage beats nothing. */
export function chooseCatalog(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
): { root: number; candidates: number[] } | undefined {
  const candidates: number[] = [];
  for (const [num, o] of objects) {
    if (!isDict(o)) continue;
    const t = o.get('Type');
    if (isName(t) && t.name === 'Catalog') candidates.push(num);
  }
  if (candidates.length === 0) return undefined;

  const walkable = candidates.filter((n) => {
    const pages = deref(objects, (objects.get(n) as PdfDict).get('Pages'));
    if (!isDict(pages)) return false;
    const t = pages.get('Type');
    return isName(t) && t.name === 'Pages';
  });
  const byOffset = (a: number, b: number) => offsetOf(a, entries) - offsetOf(b, entries);
  const pool = (walkable.length > 0 ? walkable : candidates).slice().sort(byOffset);
  return { root: pool[pool.length - 1], candidates: candidates.slice().sort(byOffset) };
}

/** The eight standard /Info entries (32000-1 14.3.3). A candidate must carry at
 *  least one; how many it carries is its score. */
const INFO_KEYS = [
  'Producer', 'Creator', 'CreationDate', 'ModDate',
  'Title', 'Author', 'Subject', 'Keywords',
] as const;

/** Object numbers reachable from `start` by following every ref in the graph. */
function reachableFrom(objects: Map<number, PdfObject>, start: number): Set<number> {
  const seen = new Set<number>();
  const stack: PdfObject[] = [ref(start)];
  while (stack.length > 0) {
    const o = stack.pop() as PdfObject;
    if (isRef(o)) {
      if (seen.has(o.num)) continue;
      seen.add(o.num);
      const v = objects.get(o.num);
      if (v !== undefined) stack.push(v);
    } else if (isArray(o)) {
      for (const v of o) stack.push(v);
    } else if (isDict(o)) {
      for (const v of o.values()) stack.push(v);
    } else if (isStream(o)) {
      for (const v of o.dict.values()) stack.push(v);
    }
  }
  return seen;
}

/** Identify the /Info dict among recovered objects.
 *
 *  /Info has no /Type, so it must be matched on shape - but the decisive signal
 *  is structural rather than lexical: a valid document never reaches /Info from
 *  the catalog graph, since it hangs off the trailer alone. That is what stops
 *  an outline item from winning, which carries /Title and no /Type and which a
 *  key-set test alone matches. An exclusion list of other-dict shapes would
 *  have to stay ahead of every construct in the format; reachability does not.
 *
 *  Among the unreachable, rank by how many /Info keys the dict carries, then by
 *  highest file offset. */
export function chooseInfo(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
  root: number,
): number | undefined {
  const reachable = reachableFrom(objects, root);
  let best: { num: number; score: number; offset: number } | undefined;
  for (const [num, o] of objects) {
    if (reachable.has(num) || !isDict(o) || o.has('Type')) continue;
    let score = 0;
    for (const k of INFO_KEYS) if (o.has(k)) score++;
    if (score === 0) continue;
    const offset = offsetOf(num, entries);
    if (!best || score > best.score || (score === best.score && offset > best.offset)) {
      best = { num, score, offset };
    }
  }
  return best?.num;
}

/** Find the /Encrypt dict by shape, for a file that lost the reference to it
 *  with its trailer. It is never itself encrypted, so `loadRaw` need not
 *  decrypt — and it is never inside an /ObjStm, so only offset entries are
 *  scanned. Requiring the handler's own keys keeps an unrelated dict carrying a
 *  /Filter (a stream dict, a filespec) from matching. */
export function findEncryptDict(
  entries: Map<number, XrefEntry>,
  loadRaw: (num: number) => PdfObject,
): { num: number; dict: PdfDict } | undefined {
  for (const [num, e] of entries) {
    if (e.type !== 'offset') continue;
    let d: PdfObject;
    try {
      d = loadRaw(num);
    } catch {
      continue;
    }
    if (!isDict(d) || d.has('Type')) continue;
    const f = d.get('Filter');
    if (!isName(f)) continue;
    if (f.name === 'Standard') {
      if (['V', 'R', 'O', 'U', 'P'].every((k) => d.has(k))) return { num, dict: d };
    } else if (f.name === 'Adobe.PubSec') {
      if (d.has('Recipients') || d.has('CF')) return { num, dict: d };
    }
  }
  return undefined;
}

/** Build an /Info dict from the catalog's XMP packet, for a document that lost
 *  its /Info entirely. Reuses the mirror xmp.ts already applies for SetXmp, so
 *  this introduces no second mapping of the shared fields. Undefined when there
 *  is no packet, it will not decode, or it carries none of the shared fields. */
function infoFromXmp(
  objects: Map<number, PdfObject>, root: number,
): PdfDict | undefined {
  const catalog = objects.get(root);
  if (!isDict(catalog)) return undefined;
  const md = deref(objects, catalog.get('Metadata'));
  if (!isStream(md)) return undefined;
  const info: PdfDict = new Map<string, PdfObject>();
  try {
    applyUpdate(info, mirrorXmpToMeta(readXmp(inflateStream(md))));
  } catch {
    return undefined;
  }
  return info.size > 0 ? info : undefined;
}

/** What trailer synthesis chose. Surfaced verbatim as RecoveryReport.trailer,
 *  rather than re-declared there, so the two spellings cannot drift. */
export interface TrailerChoice {
  root: number;
  /** Every /Type /Catalog found, ascending by offset, so a caller can see the
   *  ambiguity: "one catalog, obvious" reads differently from "three, we took
   *  the last". */
  rootCandidates: number[];
  info?: number;
  infoSource?: 'info-dict' | 'xmp';
}

/** Synthesize a trailer for a file that has none left anywhere.
 *
 *  Throws PdfParseError when no catalog exists. That is a *third* message
 *  alongside dxfk.1's two, not a replacement: 'no indirect objects found' still
 *  fires first on an empty sweep, and the three form a ladder - nothing in the
 *  file, objects but no catalog, catalog found. */
export function rebuildTrailer(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
  encrypt: { num: number } | undefined,
): { trailer: PdfDict; chosen: TrailerChoice } {
  const cat = chooseCatalog(objects, entries);
  if (!cat) throw new PdfParseError('no /Type /Catalog object found');

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(cat.root)]]);
  if (encrypt) trailer.set('Encrypt', ref(encrypt.num));
  const chosen: TrailerChoice = { root: cat.root, rootCandidates: cat.candidates };

  const info = chooseInfo(objects, entries, cat.root);
  if (info !== undefined) {
    trailer.set('Info', ref(info));
    chosen.info = info;
    chosen.infoSource = 'info-dict';
  } else {
    const fromXmp = infoFromXmp(objects, cat.root);
    if (fromXmp) {
      let num = 0;
      for (const n of objects.keys()) if (n > num) num = n;
      num += 1;
      objects.set(num, fromXmp);
      trailer.set('Info', ref(num));
      chosen.info = num;
      chosen.infoSource = 'xmp';
    }
  }
  return { trailer, chosen };
}
