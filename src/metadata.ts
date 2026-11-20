import { PdfDict, PdfObject, isString } from './types.js';
import { pdfDateToIso, isoToPdfDate } from './pdfdate.js';
import { pdfDocEncoding } from './encoding.js';

function decodePdfString(bytes: Uint8Array, singleByteEncoding?: readonly (string | undefined)[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  let s = '';
  for (const b of bytes) s += singleByteEncoding?.[b] ?? String.fromCharCode(b);
  return s;
}

/** Decode a PDF text string (ISO 32000-1 §7.9.2.2). Retain unassigned bytes
 *  verbatim so a malformed single-byte string still has a readable value. */
export function decodePdfText(bytes: Uint8Array): string {
  return decodePdfString(bytes, pdfDocEncoding);
}

/** Read a byte-oriented field exposed as a string, such as a name-tree key
 *  or URI. Keep the earlier one-to-one byte mapping and accept its UTF-16BE
 *  form for compatibility with files already written by the library.
 *  Truly binary fields continue to use the original byte array. */
export function decodePdfByteString(bytes: Uint8Array): string {
  return decodePdfString(bytes);
}

function encodePdfString(s: string, singleByteEncoding?: readonly (string | undefined)[]): Uint8Array {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f || (singleByteEncoding !== undefined && singleByteEncoding[code] !== s[i])) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe; out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = (c >> 8) & 0xff;
    out[2 + i * 2 + 1] = c & 0xff;
  }
  return out;
}

/** Use PDFDocEncoding-compatible ASCII bytes or write UTF-16BE with a BOM. */
export function encodePdfText(s: string): Uint8Array {
  return encodePdfString(s, pdfDocEncoding);
}

/** Preserve the existing ASCII and UTF-16BE forms for byte-oriented fields. */
export function encodePdfByteString(s: string): Uint8Array {
  return encodePdfString(s);
}

/** Format a Date as a PDF date string in UTC, e.g. D:20240603123045+00'00'. */
export function formatPdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

/** Parse a PDF date string to a Date; returns the raw string when it can't be parsed. */
export function parsePdfDate(s: string): Date | string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(s);
  if (!m) return s;
  const y = +m[1], mo = +(m[2] ?? '1'), d = +(m[3] ?? '1');
  const h = +(m[4] ?? '0'), mi = +(m[5] ?? '0'), se = +(m[6] ?? '0');
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  if (m[8]) { // signed offset: wall-clock is local, so UTC = local - offset
    const offsetMin = (+m[9] * 60 + +(m[10] ?? '0')) * (m[8] === '-' ? -1 : 1);
    ms -= offsetMin * 60000;
  }
  const date = new Date(ms);
  return isNaN(date.getTime()) ? s : date;
}

export interface Metadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date | string;
  modDate?: Date | string;
  custom: Record<string, string>;
}

export interface MetadataUpdate {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: Date | string | null;
  modDate?: Date | string | null;
  custom?: Record<string, string | null>;
}

/** [Metadata field, /Info key] pairs for the eight standard entries. */
const STANDARD_FIELDS: ReadonlyArray<readonly [keyof Metadata, string]> = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
  ['creationDate', 'CreationDate'],
  ['modDate', 'ModDate'],
];
const DATE_FIELDS = new Set<keyof Metadata>(['creationDate', 'modDate']);

/** Build a Metadata view of an /Info dict. `resolve` dereferences indirect values. */
export function readMetadata(
  info: PdfDict | undefined,
  resolve: (o: PdfObject | undefined) => PdfObject,
): Metadata {
  const meta: Metadata = { custom: {} };
  if (!info) return meta;
  const fieldByKey = new Map(STANDARD_FIELDS.map(([f, k]) => [k, f] as const));
  for (const [key, raw] of info) {
    const val = resolve(raw);
    if (!isString(val)) continue; // metadata values are text strings; ignore anything else
    const field = fieldByKey.get(key);
    if (field) {
      (meta as unknown as Record<string, unknown>)[field] = DATE_FIELDS.has(field)
        ? parsePdfDate(decodePdfByteString(val.bytes))
        : decodePdfText(val.bytes);
    } else {
      meta.custom[key] = decodePdfText(val.bytes);
    }
  }
  return meta;
}

/** A /Info date's text. A string that reads as an ISO 8601 date and NOT as a
 *  `D:` one is converted (`o6uu.4`) — that is a caller handing XMP syntax to
 *  the /Info side; anything else is written as given, as it always was. */
function pdfDateText(v: Date | string): string {
  if (v instanceof Date) return formatPdfDate(v);
  const s = String(v);
  return pdfDateToIso(s) === undefined ? isoToPdfDate(s) ?? s : s;
}

/** Merge an update into a working /Info dict in place: undefined leaves, null deletes, value sets. */
export function applyUpdate(info: PdfDict, update: MetadataUpdate): void {
  for (const [field, key] of STANDARD_FIELDS) {
    const v = (update as unknown as Record<string, string | Date | null | undefined>)[field];
    if (v === undefined) continue;
    if (v === null) { info.delete(key); continue; }
    const bytes = DATE_FIELDS.has(field)
      ? encodePdfByteString(pdfDateText(v as Date | string))
      : encodePdfText(String(v));
    info.set(key, { kind: 'string', bytes });
  }
  if (update.custom) {
    for (const [k, v] of Object.entries(update.custom)) {
      if (v === null) info.delete(k);
      else info.set(k, { kind: 'string', bytes: encodePdfText(v) });
    }
  }
}
