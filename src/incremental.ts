import { PdfObject, PdfDict, isRef, isArray } from './types.js';
import { enc, serializeObject } from './serialize.js';
import { readXref } from './xref.js';
import { PdfParseError } from './errors.js';
import {
  DEFAULT_PLACEHOLDER_BYTES, SignatureLayout, buildSigDictPlaceholder, finalizePlaceholder,
} from './sigplaceholder.js';

export { fillSignature } from './sigplaceholder.js';
export type { SignatureLayout } from './sigplaceholder.js';

/** Append-only (incremental-update) PDF writer.
 *
 *  The original bytes are preserved verbatim; new and replaced indirect objects,
 *  a fresh classic cross-reference section, and a trailer chaining `/Prev` back
 *  to the previous section are concatenated onto the end. This is the foundation
 *  for signing already-opened (and already-signed) documents, where the signed
 *  byte image must not change.
 *
 *  `appendSignatureUpdate` is the signing-oriented entry point: it lays out a
 *  signature value dictionary with a fixed-size `/Contents` placeholder and a
 *  computed `/ByteRange`, returning enough information for the caller to digest
 *  the byte range, build the CMS, and drop it into the placeholder with
 *  `fillSignature` — all without changing any byte offset. */

export interface IncrementalUpdateOptions {
  /** New or replaced indirect objects (generation 0), keyed by object number. */
  objects: Map<number, PdfObject>;
  /** `/Root` object number for the new trailer. Default: carried from original. */
  rootNum?: number;
  /** `/Info` object number for the new trailer. Default: carried from original. */
  infoNum?: number;
  /** `/ID` array for the new trailer. Default: carried from original (kept
   *  identical, as signatures require). */
  id?: PdfObject;
}

/** Append an incremental update and return the full `original ++ appended` image. */
export function appendIncrementalUpdate(original: Uint8Array, opts: IncrementalUpdateOptions): Uint8Array {
  return layout(original, opts).bytes;
}

export interface SignatureUpdateOptions {
  /** Object number to assign the signature value dictionary. */
  sigObjNum: number;
  /** Signature value dictionary WITHOUT `/Contents` or `/ByteRange` — both are
   *  generated here (any caller-supplied values are ignored). Typically holds
   *  `/Type /Sig`, `/Filter`, `/SubFilter`, and optional `/M`, `/Name`,
   *  `/Reason`, `/Location`, `/ContactInfo`, `/Reference`. */
  sigDict: PdfDict;
  /** Other new/replaced objects to append alongside the signature (e.g. the
   *  signature field/widget, `/AcroForm`, the updated catalog, page `/Annots`). */
  objects?: Map<number, PdfObject>;
  /** Reserved capacity for the detached CMS, in bytes. Default 8192. */
  placeholderBytes?: number;
  /** `/Root` object number for the new trailer. Default: carried from original. */
  rootNum?: number;
  /** `/Info` object number for the new trailer. Default: carried from original. */
  infoNum?: number;
  /** `/ID` array for the new trailer. Default: carried from original. */
  id?: PdfObject;
}

/** Append a signature-bearing incremental update with a `/Contents` placeholder
 *  and a computed `/ByteRange`. The returned bytes are ready to be digested over
 *  `byteRange`; pass the result and the DER CMS to `fillSignature` to finish. */
export function appendSignatureUpdate(original: Uint8Array, opts: SignatureUpdateOptions): SignatureLayout {
  const placeholderBytes = opts.placeholderBytes ?? DEFAULT_PLACEHOLDER_BYTES;
  const objects = new Map<number, PdfObject>(opts.objects ?? []);
  // The signature object is built specially (placeholder + ByteRange slots), so
  // exclude it from the generic plain-object pass.
  objects.delete(opts.sigObjNum);

  const ph = buildSigDictPlaceholder(opts.sigDict, placeholderBytes);
  const header = `${opts.sigObjNum} 0 obj\n`;
  const text = `${header}${ph.body}\nendobj\n`;

  const { bytes, sigStart } = layout(original, {
    objects,
    rootNum: opts.rootNum,
    infoNum: opts.infoNum,
    id: opts.id,
  }, { num: opts.sigObjNum, text });

  // The dict body begins after the "N 0 obj\n" header; patch from there.
  return finalizePlaceholder(bytes, sigStart + header.length, ph, placeholderBytes);
}

// ---------------------------------------------------------------------------

interface LayoutResult {
  bytes: Uint8Array;
  /** Absolute byte offset where the signature object begins (when one is given). */
  sigStart: number;
}

/** Core append: concatenate `original`, the new objects (and optional raw
 *  signature-object text), a classic xref section, and a `/Prev`-chained trailer. */
function layout(
  original: Uint8Array,
  opts: IncrementalUpdateOptions,
  sigObject?: { num: number; text: string },
): LayoutResult {
  const prev = readXref(original);
  const prevStartxref = findPrevStartxref(original);

  const rootNum = opts.rootNum ?? refNum(prev.trailer.get('Root'));
  if (rootNum === undefined) throw new PdfParseError('cannot append: original /Root is not an indirect reference');
  const infoNum = opts.infoNum ?? refNum(prev.trailer.get('Info'));
  const id = opts.id ?? prev.trailer.get('ID');
  const prevSize = typeof prev.trailer.get('Size') === 'number' ? (prev.trailer.get('Size') as number) : 0;

  // Gather the appended objects in ascending number order for tidy xref runs.
  const items: Array<{ num: number; body: Uint8Array }> = [];
  for (const [num, obj] of opts.objects) items.push({ num, body: serializeObject(obj) });
  if (sigObject) items.push({ num: sigObject.num, body: enc(sigObject.text) });
  items.sort((a, b) => a.num - b.num);

  const chunks: Uint8Array[] = [];
  let len = original.length;
  const push = (b: Uint8Array): void => { chunks.push(b); len += b.length; };

  // Ensure the appended region starts on its own line.
  if (!endsWithEol(original)) push(enc('\n'));

  const offsets = new Map<number, number>();
  let sigStart = 0;
  for (const item of items) {
    if (sigObject && item.num === sigObject.num) {
      // The signature object text already includes "N 0 obj ... endobj\n".
      offsets.set(item.num, len);
      sigStart = len;
      push(item.body);
    } else {
      offsets.set(item.num, len);
      push(enc(`${item.num} 0 obj\n`));
      push(item.body);
      push(enc('\nendobj\n'));
    }
  }

  const xrefOffset = len;
  push(enc(buildXrefSection(items.map((i) => i.num), offsets)));

  let maxNum = 0;
  for (const i of items) if (i.num > maxNum) maxNum = i.num;
  const size = Math.max(prevSize, maxNum + 1);

  let tr = `trailer\n<< /Size ${size} /Root ${rootNum} 0 R /Prev ${prevStartxref}`;
  if (infoNum !== undefined) tr += ` /Info ${infoNum} 0 R`;
  if (id !== undefined) tr += ` /ID ${serializeValueLatin(id)}`;
  tr += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(enc(tr));

  return { bytes: concat(original, chunks), sigStart };
}

/** Build a classic `xref` section listing `nums`, grouping consecutive runs. */
function buildXrefSection(nums: number[], offsets: Map<number, number>): string {
  const sorted = [...nums].sort((a, b) => a - b);
  let s = 'xref\n';
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const count = j - i + 1;
    s += `${start} ${count}\n`;
    for (let k = i; k <= j; k++) s += `${String(offsets.get(sorted[k])!).padStart(10, '0')} 00000 n \n`;
    i = j + 1;
  }
  return s;
}

/** The `startxref` integer of the previous (newest existing) cross-reference. */
function findPrevStartxref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfParseError('cannot append: original has no startxref');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfParseError('cannot append: malformed startxref');
  return parseInt(m[1], 10);
}

function refNum(o: PdfObject | undefined): number | undefined {
  return o !== undefined && isRef(o) ? o.num : undefined;
}

function endsWithEol(buf: Uint8Array): boolean {
  const last = buf[buf.length - 1];
  return last === 0x0a || last === 0x0d;
}

/** Serialize a trailer value (`/ID` array of hex/literal strings) to latin1 text.
 *  `serializeValue` already emits ASCII-safe output for strings, names, refs. */
function serializeValueLatin(o: PdfObject): string {
  if (isArray(o)) return `[${o.map(serializeValueLatin).join(' ')}]`;
  // Reuse the canonical single-object serializer (ASCII for strings/names/refs).
  return new TextDecoder('latin1').decode(serializeObject(o));
}

function concat(head: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  let total = head.length;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set(head, 0);
  let p = head.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
