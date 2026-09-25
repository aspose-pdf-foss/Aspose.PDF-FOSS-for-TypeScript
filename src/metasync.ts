import { isString, type PdfDict, type PdfObject } from './types.js';
import { decodePdfText, type MetadataUpdate } from './metadata.js';
import { NS, readXmp, splitAuthors, xmpScalar, type XmpUpdate } from './xmp.js';
import { parseRdfPacket, type RdfValue } from './xmprdf.js';
import { pdfDateToIso, isoToPdfDate, sameInstant } from './pdfdate.js';
import { rethrowLimit } from './errors.js';
import type { LoadLimits } from './loadlimits.js';

/** `/Info` ↔ XMP synchronisation (`o6uu.4`): read both sides as RAW TEXT and
 *  plan the smallest update that makes the target agree with the source.
 *
 *  Pure — no `Document`: the two sides arrive as `SideText` records, so every
 *  comparison rule is drivable from plain strings. Raw text rather than
 *  `GetMetadata()`, whose dates are JS `Date`s that have lost their offset.
 *  The sync is an EXACT MIRROR: a field absent on the source is deleted on
 *  the target. The one exception is a source DATE that does not read — the
 *  target is left alone and the field reported in `skipped`, since deleting a
 *  good date or copying garbage are both worse. */

export type MetadataField =
  'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer' | 'creationDate' | 'modDate';
export type SyncDirection = 'infoToXmp' | 'xmpToInfo';
export interface MetadataSyncReport { changed: MetadataField[]; skipped: MetadataField[] }
/** A side's eight fields as text. `null` means PRESENT BUT UNREADABLE — an
 *  /Info entry that is not a string, an XMP property that is a struct — which
 *  is not the same as absent: an exact mirror deletes what is absent, and must
 *  not delete a value merely because it could not read the other side's. */
export type SideText = Partial<Record<MetadataField, string | null>>;
export interface SyncPlan extends MetadataSyncReport { info: MetadataUpdate; xmp: XmpUpdate }

type Kind = 'text' | 'author' | 'date';
/** Field, /Info key, XmpUpdate key, XMP (ns, name), kind — in report order. */
const MAP: readonly (readonly [MetadataField, string, keyof XmpUpdate, string, string, Kind])[] = [
  ['title', 'Title', 'title', NS.dc, 'title', 'text'],
  ['author', 'Author', 'authors', NS.dc, 'creator', 'author'],
  ['subject', 'Subject', 'description', NS.dc, 'description', 'text'],
  ['keywords', 'Keywords', 'keywords', NS.pdf, 'Keywords', 'text'],
  ['creator', 'Creator', 'creatorTool', NS.xmp, 'CreatorTool', 'text'],
  ['producer', 'Producer', 'producer', NS.pdf, 'Producer', 'text'],
  ['creationDate', 'CreationDate', 'createDate', NS.xmp, 'CreateDate', 'date'],
  ['modDate', 'ModDate', 'modifyDate', NS.xmp, 'ModifyDate', 'date'],
];

/** The /Info-mirrored field a top-level XMP property is, if any (`o6uu.8`). */
export function mirroredField(ns: string, name: string): MetadataField | undefined {
  return MAP.find(([, , , n, m]) => n === ns && m === name)?.[0];
}

/** The eight /Info entries as decoded text. A non-string entry is `null`
 *  (present, unreadable); one that resolves to `null` — a dead reference,
 *  which 7.3.10 makes null — is absent. */
export function infoSide(info: PdfDict | undefined, resolve: (o: PdfObject | undefined) => PdfObject): SideText {
  const out: SideText = {};
  if (!info) return out;
  for (const [field, key] of MAP) {
    const v = resolve(info.get(key));
    if (isString(v)) out[field] = decodePdfText(v.bytes);
    else if (v !== null) out[field] = null;
  }
  return out;
}

const simpleText = (v: RdfValue): string | undefined => (v.kind === 'simple' ? v.value : undefined);

/** An Alt's `x-default` item, else its first — `readXmp`'s own reading, so
 *  the sync and `GetXmp` agree about what the title is. */
function altText(v: RdfValue): string | undefined {
  if (v.kind === 'simple') return v.value;
  if (v.kind !== 'array' || v.items.length === 0) return undefined;
  const item = v.items.find((i) => i.lang?.toLowerCase() === 'x-default') ?? v.items[0];
  return simpleText(item.value);
}

function creatorText(v: RdfValue): string | undefined {
  if (v.kind === 'simple') return v.value;
  if (v.kind !== 'array') return undefined;
  const names = v.items.map((i) => simpleText(i.value)).filter((s): s is string => s !== undefined);
  return names.length > 0 ? names.join(', ') : undefined;
}

/** The eight XMP properties as raw text. A packet that will not parse falls
 *  back to `readXmp`'s scan — exactly what `SetXmp` edits from in that case
 *  — so an unparseable packet never reads as an EMPTY one, which an exact
 *  mirror would then copy over /Info as eight deletions. */
export function xmpSide(bytes: Uint8Array | undefined, limits: LoadLimits): SideText {
  const out: SideText = {};
  if (bytes === undefined) return out;
  try {
    const props = parseRdfPacket(bytes, limits).properties;
    for (const [field, , , ns, name, kind] of MAP) {
      const p = props.find((q) => q.ns === ns && q.name === name);
      if (!p) continue;
      const text = kind === 'author' ? creatorText(p.value)
        : field === 'title' || field === 'subject' ? altText(p.value) : simpleText(p.value);
      out[field] = text ?? null;
    }
    return out;
  } catch (e) {
    rethrowLimit(e);
    const m = readXmp(bytes);
    // Dates as WRITTEN, not readXmp's `Date`: that one is `new Date(s)`, which
    // reads a zone-less time as local, so its ISO text differs by machine.
    const raw = m.raw ?? '';
    const fallback: SideText = {
      title: m.title, author: m.authors?.join(', '), subject: m.description, keywords: m.keywords,
      creator: m.creatorTool, producer: m.producer,
      creationDate: xmpScalar(raw, 'xmp:CreateDate'), modDate: xmpScalar(raw, 'xmp:ModifyDate'),
    };
    for (const [k, v] of Object.entries(fallback)) if (v !== undefined) out[k as MetadataField] = v;
    return out;
  }
}

/** The update that makes the target side agree with the source side. */
export function planSync(info: SideText, xmp: SideText, direction: SyncDirection): SyncPlan {
  const plan: SyncPlan = { changed: [], skipped: [], info: {}, xmp: {} };
  const toXmp = direction === 'infoToXmp';
  const write = (field: MetadataField, xkey: keyof XmpUpdate, v: string | string[] | null) => {
    plan.changed.push(field);
    if (toXmp) (plan.xmp as Record<string, unknown>)[xkey] = v;
    else (plan.info as Record<string, unknown>)[field] = v;
  };
  for (const [field, , xkey, , , kind] of MAP) {
    let src = toXmp ? info[field] : xmp[field];
    const tgt = toXmp ? xmp[field] : info[field];
    // A source value present but unreadable says nothing to copy — and
    // deleting the target for it would lose a value we could read.
    if (src === null) { plan.skipped.push(field); continue; }
    // An /Author of nothing but separators names no author.
    if (toXmp && kind === 'author' && src !== undefined && splitAuthors(src).length === 0) src = undefined;
    if (src === undefined) {
      if (tgt !== undefined) write(field, xkey, null);
      continue;
    }
    if (kind === 'date') {
      const want = toXmp ? pdfDateToIso(src) : isoToPdfDate(src);
      if (want === undefined) { plan.skipped.push(field); continue; }
      const srcIso = toXmp ? want : src;
      const tgtIso = typeof tgt !== 'string' ? undefined : toXmp ? tgt : pdfDateToIso(tgt);
      if (tgtIso !== undefined && sameInstant(srcIso, tgtIso)) continue;
      write(field, xkey, want);
    } else if (kind === 'author') {
      // /Author is compared in its canonical split-and-joined form BOTH ways:
      // SetMetadata writes `A,B` verbatim beside dc:creator [A, B].
      if (toXmp) {
        const list = splitAuthors(src);
        if (tgt === list.join(', ')) continue;
        write(field, xkey, list);
      } else {
        if (typeof tgt === 'string' && splitAuthors(tgt).join(', ') === src) continue;
        write(field, xkey, src);
      }
    } else {
      if (tgt === src) continue;
      write(field, xkey, src);
    }
  }
  return plan;
}
