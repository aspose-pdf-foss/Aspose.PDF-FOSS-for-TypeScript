import { PdfObject, PdfDict, isRef, isArray } from './types.js';
import { enc, serializeObject } from './serialize.js';
import { Encryptor } from './encrypt.js';
import { readXref, XrefEntry } from './xref.js';
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
  /** New or replaced indirect objects, keyed by object number. Each is written
   *  at the generation the previous cross-reference recorded for it. */
  objects: Map<number, PdfObject>;
  /** Object numbers to mark FREE in the appended cross-reference section.
   *  An appended `f` entry shadows the original `n` entry, which is how a
   *  deletion is expressed without touching the original bytes. */
  freed?: Set<number>;
  /** Encrypt appended strings and streams with the document's own key. The
   *  `/Encrypt` object already lives in the original bytes, so the new trailer
   *  references it rather than rewriting it. */
  encryptor?: Encryptor;
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
  /** Encrypt the appended objects and the signature dict strings with the
   *  document own key. `/Contents` stays in the clear (32000-1 7.6.2). */
  encryptor?: Encryptor;
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

  const ph = buildSigDictPlaceholder(opts.sigDict, placeholderBytes, opts.encryptor, opts.sigObjNum);
  const header = `${opts.sigObjNum} 0 obj\n`;
  const text = `${header}${ph.body}\nendobj\n`;

  const { bytes, sigStart } = layout(original, {
    objects,
    encryptor: opts.encryptor,
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
  for (const [num, obj] of opts.objects) {
    // Encrypt under the object's OWN number and generation, which is what the
    // per-object key derivation hashes — the same numbers the xref rows below
    // record, since an append never renumbers.
    const gen = prevGen(prev.entries, num);
    const body = serializeObject(opts.encryptor ? opts.encryptor.encryptObject(obj, num, gen) : obj);
    items.push({ num, body });
  }
  if (sigObject) items.push({ num: sigObject.num, body: enc(sigObject.text) });
  items.sort((a, b) => a.num - b.num);

  const chunks: Uint8Array[] = [];
  let len = original.length;
  const push = (b: Uint8Array): void => { chunks.push(b); len += b.length; };

  // Ensure the appended region starts on its own line.
  if (!endsWithEol(original)) push(enc('\n'));

  const rows: XrefRow[] = [];
  let sigStart = 0;
  for (const item of items) {
    const gen = prevGen(prev.entries, item.num);
    rows.push({ num: item.num, kind: 'n', offset: len, gen });
    if (sigObject && item.num === sigObject.num) {
      // The signature object text already includes "N G obj ... endobj\n".
      sigStart = len;
      push(item.body);
    } else {
      push(enc(`${item.num} ${gen} obj\n`));
      push(item.body);
      push(enc('\nendobj\n'));
    }
  }
  for (const num of opts.freed ?? []) {
    // A free entry's generation is the one the object WILL have if reused, so
    // it is the previous generation plus one. The 10-digit field heads a free
    // list we do not maintain, so it is 0 (the list terminator).
    rows.push({ num, kind: 'f', offset: 0, gen: prevGen(prev.entries, num) + 1 });
  }

  const xrefOffset = len;
  push(enc(buildXrefSection(rows)));

  let maxNum = 0;
  for (const i of items) if (i.num > maxNum) maxNum = i.num;
  for (const n of opts.freed ?? []) if (n > maxNum) maxNum = n;
  const size = Math.max(prevSize, maxNum + 1);

  let tr = `trailer\n<< /Size ${size} /Root ${rootNum} 0 R /Prev ${prevStartxref}`;
  if (infoNum !== undefined) tr += ` /Info ${infoNum} 0 R`;
  if (id !== undefined) tr += ` /ID ${serializeValueLatin(id)}`;
  // The /Encrypt object already lives in the original bytes, so the appended
  // revision REFERENCES it. Omitting it is what made a reader take the newest
  // trailer at its word, treat the document as unencrypted, and decode every
  // pre-existing encrypted string to garbage.
  const encRef = prev.trailer.get('Encrypt');
  if (isRef(encRef)) tr += ` /Encrypt ${encRef.num} ${encRef.gen} R`;
  tr += ` >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(enc(tr));

  return { bytes: concat(original, chunks), sigStart };
}

interface XrefRow { num: number; kind: 'n' | 'f'; offset: number; gen: number }

/** Build a classic `xref` section from `rows`, grouping consecutive runs.
 *
 *  A section with no rows still needs a subsection header: `xref` immediately
 *  followed by `trailer` is malformed and some readers reject the file, so an
 *  empty update emits the degenerate `0 0` subsection. */
function buildXrefSection(rows: XrefRow[]): string {
  const sorted = [...rows].sort((a, b) => a.num - b.num);
  if (sorted.length === 0) return 'xref\n0 0\n';
  let s = 'xref\n';
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].num === sorted[j].num + 1) j++;
    s += `${sorted[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) {
      const r = sorted[k];
      s += `${String(r.offset).padStart(10, '0')} ${String(r.gen).padStart(5, '0')} ${r.kind} \n`;
    }
    i = j + 1;
  }
  return s;
}

/** The generation the previous cross-reference recorded for `num` (0 when it
 *  named no offset entry: a compressed object is generation 0 by definition,
 *  and an object the previous xref never named is new). */
function prevGen(entries: Map<number, XrefEntry>, num: number): number {
  const e = entries.get(num);
  return e !== undefined && e.type === 'offset' ? e.gen : 0;
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
