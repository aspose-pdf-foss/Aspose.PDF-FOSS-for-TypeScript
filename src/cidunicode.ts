import { brotliDecompressSync } from 'node:zlib';
import { CID_UNICODE_DATA } from './cidunidata.js';

/**
 * CID -> Unicode, from Adobe's published mapping tables (cidunidata.ts).
 *
 * The last step of reading CJK text. A composite font's `/Encoding` CMap gives
 * code -> CID, which is enough to *draw* the right glyph but says nothing about
 * what character it is; a CID is an index into a glyph collection. Most CJK
 * producers ship a `/ToUnicode` and that answers it, but a large class of real
 * documents does not, and for those the only route left is the collection named
 * by `/CIDSystemInfo` — `Japan1`, `GB1`, `CNS1`, `Korea1`, `KR` — and Adobe's
 * table for it.
 *
 * **Invariant:** these tables are *not* derivable by inverting the bundled
 * `Uni*-UCS2-H` CMaps, which is the tempting way to get them for free. Measured
 * against Adobe's own tables, inversion agrees on 39% of Adobe-Japan1's CIDs,
 * 86% of Adobe-CNS1's and 94% of Adobe-Korea1's — and its disagreements are not
 * edge cases. Japan1 CID 93 is U+00A6 and CID 99 is U+007C; inverting yields
 * exactly the two swapped, because both characters map into both CIDs going the
 * other way. Round-tripping a many-to-one mapping cannot recover the choice
 * Adobe made, and 13,569 Japan1 CIDs are not reachable from UCS-2 at all.
 *
 * **Invariant:** a CID the table cannot answer for contributes *nothing* to the
 * extracted text — never U+FFFD. Adobe's tables use U+FFFD to mean "no Unicode
 * for this CID" (once for CID 0 in most collections, 199 times in Adobe-CNS1),
 * and carrying that through would salt extracted text with replacement
 * characters that look like a decoding bug rather than an absent mapping. The
 * generator drops them.
 */

/** A CID -> Unicode table for one collection. */
export interface CidToUnicode {
  /** The `/CIDSystemInfo /Ordering` this table serves. */
  readonly ordering: string;
  /** The text `cid` stands for, or undefined when the table cannot say. */
  lookup(cid: number): string | undefined;
}

/** Loaded tables by ordering. `null` marks one that failed (do not retry). */
const cache = new Map<string, CidToUnicode | null>();

/**
 * Own-property test, so an ordering out of the document — `/Ordering
 * (constructor)` — cannot find `Object.prototype.constructor` and be treated as
 * a bundled table.
 *
 * Defence in depth here, unlike predefcmap.ts's twin: the load below is wrapped
 * in a `try`, and an inherited value is a function that `Buffer.from` rejects,
 * so the outcome is the same "no table" either way. There is deliberately no
 * test pinning this line — it kills no mutant on its own. It stays because the
 * `try` exists to tolerate corrupt *data*, and leaning on it for a prototype
 * lookup would make this correct only by accident.
 */
function has(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CID_UNICODE_DATA, name);
}

/** The orderings a bundled table exists for. */
export function cidUnicodeOrderings(): string[] {
  return Object.keys(CID_UNICODE_DATA);
}

/**
 * The CID -> Unicode table for a `/CIDSystemInfo /Ordering`, or undefined when
 * no table is bundled for it — an unrecognised ordering, `Identity` (whose CIDs
 * are glyph indices with no character meaning at all), or the deprecated
 * `Japan2`. Never throws; the caller falls back to contributing no text.
 */
export function getCidToUnicode(ordering: string): CidToUnicode | undefined {
  const hit = cache.get(ordering);
  if (hit !== undefined) return hit ?? undefined;
  if (!has(ordering)) return undefined;

  let table: CidToUnicode | null = null;
  try {
    const bytes = new Uint8Array(
      brotliDecompressSync(Buffer.from(CID_UNICODE_DATA[ordering], 'base64')));
    table = buildTable(ordering, decodeCidUnicode(bytes));
  } catch {
    table = null;
  }
  cache.set(ordering, table);
  return table ?? undefined;
}

function buildTable(ordering: string, m: CidUnicodeMap): CidToUnicode {
  return {
    ordering,
    lookup(cid: number): string | undefined {
      const i = binarySearch(m.singleCids, cid);
      if (i >= 0) return String.fromCharCode(m.singleUnits[i]);
      const j = binarySearch(m.multiCids, cid);
      if (j >= 0) return m.multi[j];
      return undefined;
    },
  };
}

/** Index of `value` in a sorted array, or -1. */
function binarySearch(arr: Uint32Array, value: number): number {
  let a = 0, b = arr.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (arr[mid] === value) return mid;
    if (arr[mid] < value) a = mid + 1; else b = mid - 1;
  }
  return -1;
}

/**
 * The decoded table: entries whose destination is one UTF-16 unit kept in
 * parallel typed arrays, and the rest — surrogate pairs and the handful of
 * genuine multi-character expansions — as strings alongside their CIDs.
 *
 * Splitting them is what makes the encoding small: 95% of the 113,496 entries
 * are a single unit, and as two sorted columns of deltas they compress to a
 * fraction of what a uniform `(cid, length, units...)` record costs.
 */
export interface CidUnicodeMap {
  singleCids: Uint32Array;
  singleUnits: Uint32Array;
  multiCids: Uint32Array;
  multi: string[];
}

// ---- codec ----
//
// **Invariant:** encoder and decoder live together, for cmapcodec.ts's reason —
// the format carries no self-description, the encoder runs only at build time
// (scripts/gen-cidunicode.ts) and ships unused, and `test/cidunicode.test.ts`
// round-trips every bundled table through both halves.

function putVarint(out: number[], value: number): void {
  let n = value >>> 0;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = n >>> 7; }
  out.push(n);
}

function putSignedVarint(out: number[], value: number): void {
  putVarint(out, value < 0 ? -value * 2 - 1 : value * 2);
}

class Reader {
  private i = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean { return this.i >= this.buf.length; }
  varint(): number {
    let n = 0, shift = 0;
    for (let k = 0; k < 5 && this.i < this.buf.length; k++) {
      const b = this.buf[this.i++];
      n += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return n >>> 0;
  }
  signedVarint(): number {
    const n = this.varint();
    return (n & 1) ? -((n + 1) / 2) : n / 2;
  }
}

/** Encode a CID -> Unicode table. Build-time only; see the codec note. */
export function encodeCidUnicode(m: CidUnicodeMap): Uint8Array {
  const out: number[] = [];
  putVarint(out, m.singleCids.length);
  // Columnar: all CID gaps, then all destination steps. Adobe's tables are
  // largely runs of consecutive CIDs mapping to consecutive characters, so both
  // columns become long stretches of the same small delta.
  let prevCid = 0;
  for (const cid of m.singleCids) { putVarint(out, cid - prevCid); prevCid = cid; }
  let prevUnit = 0;
  for (const u of m.singleUnits) { putSignedVarint(out, u - prevUnit); prevUnit = u; }

  putVarint(out, m.multiCids.length);
  prevCid = 0;
  for (const cid of m.multiCids) { putVarint(out, cid - prevCid); prevCid = cid; }
  for (const s of m.multi) {
    putVarint(out, s.length);
    for (let i = 0; i < s.length; i++) putVarint(out, s.charCodeAt(i));
  }
  return Uint8Array.from(out);
}

/** Decode a CID -> Unicode table. Never throws; a truncated blob yields what it held. */
export function decodeCidUnicode(buf: Uint8Array): CidUnicodeMap {
  const rd = new Reader(buf);
  const nSingle = rd.varint();
  const singleCids = new Uint32Array(nSingle);
  const singleUnits = new Uint32Array(nSingle);
  let prevCid = 0;
  for (let i = 0; i < nSingle; i++) { prevCid += rd.varint(); singleCids[i] = prevCid; }
  let prevUnit = 0;
  for (let i = 0; i < nSingle; i++) { prevUnit += rd.signedVarint(); singleUnits[i] = prevUnit >>> 0; }

  const nMulti = rd.varint();
  const multiCids = new Uint32Array(nMulti);
  prevCid = 0;
  for (let i = 0; i < nMulti; i++) { prevCid += rd.varint(); multiCids[i] = prevCid; }
  const multi: string[] = [];
  for (let i = 0; i < nMulti; i++) {
    const len = rd.varint();
    let s = '';
    for (let k = 0; k < len; k++) s += String.fromCharCode(rd.varint());
    multi.push(s);
  }
  return { singleCids, singleUnits, multiCids, multi };
}
