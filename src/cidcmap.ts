import { Lexer } from './lexer.js';

/**
 * CID CMaps: the code -> CID direction, for a composite (Type0) font's
 * `/Encoding`. This is a different mapping from cmap.ts's, which reads the
 * code -> Unicode direction out of `/ToUnicode` and `bf` operators; the two
 * grammars share a tokenizer and nothing else, and a CMap file may carry both.
 *
 * The shape a predefined Adobe CMap needs and `/ToUnicode` never does is the
 * *codespace*: a CMap's codes are not a fixed width. `UniJIS-UTF8-H` mixes
 * 1-, 2-, 3- and 4-byte codes in one show string, and even the ostensibly
 * two-byte `90ms-RKSJ-H` takes single bytes for ASCII and half-width katakana.
 * So a caller cannot slice a show string into codes up front — it must ask this
 * class for one code at a time ({@link CidCMap.next}).
 */

/** How many bytes a character code may occupy (PDF 32000-1 9.7.6.2). */
const MAX_CODE_BYTES = 4;

/** One codespace range. `lo`/`hi` are the range's `nbytes` bytes big-endian. */
export interface CodespaceRange {
  readonly nbytes: number;
  readonly lo: number;
  readonly hi: number;
}

/** Codes `lo..hi` (of `nbytes` bytes) mapping to consecutive CIDs from `cid`. */
export interface CidRange {
  readonly nbytes: number;
  readonly lo: number;
  readonly hi: number;
  readonly cid: number;
}

/** One character code taken off a show string. */
export interface CodeUnit {
  /** The consumed bytes as a big-endian integer. */
  readonly code: number;
  /** Bytes consumed. Always >= 1, so a caller's loop always advances. */
  readonly len: number;
  /** False when no codespace range accepted these bytes; `cid` will be 0. */
  readonly matched: boolean;
}

/** A decoded code plus the CID it selects. */
export interface CidCode extends CodeUnit {
  readonly cid: number;
}

/** The range data alone — everything cmapcodec.ts puts in a bundled blob. The
 *  scalars a CMap also declares are deliberately not here: predefcmap.ts must
 *  answer them (a name's `/WMode`, its `usecmap` parent) *without* inflating,
 *  so they live in the side table and have exactly one home. */
export interface CMapGeometry {
  codespace: CodespaceRange[];
  cidRanges: CidRange[];
  notdefRanges: CidRange[];
}

/** Everything a CMap declares, before it is indexed for lookup. Produced by
 *  {@link parseCidCMap} from CMap text and by predefcmap.ts from a blob plus
 *  its side-table entry. */
export interface CMapParts extends CMapGeometry {
  /** `/CMapName`, when the CMap states one. */
  name?: string;
  /** `/WMode`: 0 horizontal, 1 vertical. */
  wmode: 0 | 1;
  /** The name in a `/Name usecmap` — the parent this CMap extends. */
  usecmap?: string;
  registry?: string;
  ordering?: string;
  supplement?: number;
}

/** An empty parts record, for a parser that found nothing it recognised. */
export function emptyCMapParts(): CMapParts {
  return { wmode: 0, codespace: [], cidRanges: [], notdefRanges: [] };
}

/** Ranges of one byte-width, sorted by `lo`, for binary search. */
interface RangeIndex {
  readonly lo: Uint32Array;
  readonly hi: Uint32Array;
  readonly cid: Uint32Array;
}

function buildIndex(ranges: CidRange[]): RangeIndex {
  const sorted = ranges.slice().sort((a, b) => a.lo - b.lo);
  const n = sorted.length;
  const lo = new Uint32Array(n), hi = new Uint32Array(n), cid = new Uint32Array(n);
  for (let i = 0; i < n; i++) { lo[i] = sorted[i].lo; hi[i] = sorted[i].hi; cid[i] = sorted[i].cid; }
  return { lo, hi, cid };
}

/**
 * The CID for `code`, or undefined when no range covers it.
 *
 * `interpolate` is the whole difference between the two range flavours. A
 * `cidrange` runs consecutive CIDs across the range, so the offset is added;
 * a `notdefrange` names **one** substitute glyph for every code in the range
 * (Adobe TN #5014), so adding the offset would turn `B5pc-H`'s
 * `<00> <1f> 1` — all 32 control codes to CID 1 — into a march across CIDs
 * 1 to 32, i.e. real glyphs, drawn for codes that map to nothing.
 */
function searchIndex(ix: RangeIndex, code: number, interpolate: boolean): number | undefined {
  let a = 0, b = ix.lo.length - 1, found = -1;
  while (a <= b) {                       // greatest i with lo[i] <= code
    const m = (a + b) >> 1;
    if (ix.lo[m] <= code) { found = m; a = m + 1; } else b = m - 1;
  }
  if (found < 0 || code > ix.hi[found]) return undefined;
  return (interpolate ? ix.cid[found] + (code - ix.lo[found]) : ix.cid[found]) >>> 0;
}

/** Split `ranges` into one index per byte-width. */
function indexByLen(ranges: CidRange[]): (RangeIndex | undefined)[] {
  const buckets: CidRange[][] = [];
  for (const r of ranges) (buckets[r.nbytes] ??= []).push(r);
  const out: (RangeIndex | undefined)[] = [];
  for (let n = 0; n <= MAX_CODE_BYTES; n++) out[n] = buckets[n] ? buildIndex(buckets[n]) : undefined;
  return out;
}

/** The `k`-th byte of an `nbytes`-wide code. */
function byteAt(value: number, nbytes: number, k: number): number {
  return (value / 2 ** (8 * (nbytes - 1 - k))) & 0xff;
}

/**
 * A parsed CMap, indexed for lookup, optionally extending a `usecmap` parent.
 *
 * **Invariant:** a `usecmap` parent supplies the codespace as well as the
 * mappings. Nearly every vertical CMap Adobe ships (`UniJIS-UCS2-V` and its
 * kin) declares *no* `begincodespacerange` at all — it states only the hundred
 * or so codes whose glyphs differ when set vertically and inherits the rest. A
 * child indexed on its own ranges alone therefore matches no code whatsoever
 * and every vertical CMap silently decodes to nothing.
 */
export class CidCMap {
  readonly name?: string;
  readonly wmode: 0 | 1;
  readonly registry?: string;
  readonly ordering?: string;
  readonly supplement?: number;
  readonly parent?: CidCMap;

  /** Own codespace ranges, then the parent's, bucketed by byte-width. */
  private readonly codespace: CodespaceRange[][] = [];
  private readonly cidIndex: (RangeIndex | undefined)[];
  private readonly notdefIndex: (RangeIndex | undefined)[];
  /** Narrowest codespace width, the fallback consumption for an unmatched byte. */
  private readonly minLen: number;

  constructor(parts: CMapParts, parent?: CidCMap) {
    this.name = parts.name;
    this.wmode = parts.wmode;
    this.registry = parts.registry ?? parent?.registry;
    this.ordering = parts.ordering ?? parent?.ordering;
    this.supplement = parts.supplement ?? parent?.supplement;
    this.parent = parent;

    for (let n = 0; n <= MAX_CODE_BYTES; n++) this.codespace[n] = [];
    for (const r of parts.codespace) this.codespace[r.nbytes]?.push(r);
    if (parent) {
      for (let n = 1; n <= MAX_CODE_BYTES; n++) this.codespace[n].push(...parent.codespace[n]);
    }
    let min = 0;
    for (let n = 1; n <= MAX_CODE_BYTES; n++) if (this.codespace[n].length && !min) min = n;
    this.minLen = min || 1;

    this.cidIndex = indexByLen(parts.cidRanges);
    this.notdefIndex = indexByLen(parts.notdefRanges);
  }

  /** Every codespace range in force, this CMap's own and its chain's, narrowest
   *  code width first. This is what says how wide a code may be — a caller that
   *  needs to know before decoding (or to state the widths it must handle)
   *  reads it here rather than assuming two bytes. */
  get codespaces(): CodespaceRange[] {
    const out: CodespaceRange[] = [];
    for (let n = 1; n <= MAX_CODE_BYTES; n++) out.push(...this.codespace[n]);
    return out;
  }

  /**
   * Take the next character code off `bytes` at `i`.
   *
   * Codespace ranges are compared **byte by byte**, not as integers
   * (32000-1 9.7.6.2). `<8140> <9ffc>` admits `0x81 0x40` and rejects
   * `0x82 0x00`, which an integer `lo <= code <= hi` test would wrongly accept —
   * and a Shift-JIS lead byte followed by an out-of-range trail byte is exactly
   * what damaged or mislabelled CJK text is made of.
   *
   * An unmatched byte still consumes something: the width of the longest
   * codespace whose *first* byte accepted it, else the narrowest codespace
   * width. `len` is never 0, so the caller's loop cannot spin.
   */
  next(bytes: Uint8Array, i: number): CodeUnit {
    const avail = bytes.length - i;
    let partial = 0;
    for (let n = 1; n <= MAX_CODE_BYTES; n++) {
      const ranges = this.codespace[n];
      if (!ranges.length) continue;
      for (const r of ranges) {
        const b0 = bytes[i];
        if (b0 >= byteAt(r.lo, n, 0) && b0 <= byteAt(r.hi, n, 0)) { partial = n; break; }
      }
      if (n > avail) continue;
      for (const r of ranges) {
        let ok = true;
        for (let k = 0; k < n && ok; k++) {
          const b = bytes[i + k];
          ok = b >= byteAt(r.lo, n, k) && b <= byteAt(r.hi, n, k);
        }
        if (ok) return { code: codeOf(bytes, i, n), len: n, matched: true };
      }
    }
    const len = Math.max(1, Math.min(partial || this.minLen, Math.max(avail, 1)));
    return { code: codeOf(bytes, i, len), len, matched: false };
  }

  /** The CID `code` selects, or 0 (`.notdef`) when nothing maps it. */
  cid(code: number, nbytes: number): number {
    const c = this.lookupCid(code, nbytes);
    if (c !== undefined) return c;
    return this.lookupNotdef(code, nbytes) ?? 0;
  }

  /** `cidrange`/`cidchar` mappings, this CMap's own first, then the chain's. */
  private lookupCid(code: number, nbytes: number): number | undefined {
    const ix = this.cidIndex[nbytes];
    const hit = ix && searchIndex(ix, code, true);
    if (hit !== undefined) return hit;
    return this.parent?.lookupCid(code, nbytes);
  }

  /** `notdefrange` substitutes, consulted only after the whole chain's
   *  `cidrange`s miss — a notdef is a fallback, so a parent's real mapping
   *  must outrank a child's substitute. */
  private lookupNotdef(code: number, nbytes: number): number | undefined {
    const ix = this.notdefIndex[nbytes];
    const hit = ix && searchIndex(ix, code, false);
    if (hit !== undefined) return hit;
    return this.parent?.lookupNotdef(code, nbytes);
  }

  /** Split a show string into codes and their CIDs. */
  decode(bytes: Uint8Array): CidCode[] {
    const out: CidCode[] = [];
    for (let i = 0; i < bytes.length; ) {
      const u = this.next(bytes, i);
      out.push({ ...u, cid: u.matched ? this.cid(u.code, u.len) : 0 });
      i += u.len;
    }
    return out;
  }
}

/** Big-endian integer of `n` bytes at `i`, zero-padding past the end. */
function codeOf(bytes: Uint8Array, i: number, n: number): number {
  let code = 0;
  for (let k = 0; k < n; k++) code = code * 256 + (bytes[i + k] ?? 0);
  return code >>> 0;
}

function bytesToCode(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n >>> 0;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * Parse CMap text (a predefined CMap resource, or an embedded `/Encoding`
 * CMap stream) into its declared parts.
 *
 * Like the other three grammars over this tokenizer, an unrecognised token is
 * skipped rather than rejected: a damaged CMap costs the entries it damaged,
 * not the font's whole encoding. Nothing here throws.
 */
export function parseCidCMap(buf: Uint8Array): CMapParts {
  const lx = new Lexer(buf);
  const out = emptyCMapParts();

  type V =
    | { kind: 'hex'; bytes: Uint8Array }
    | { kind: 'num'; v: number }
    | { kind: 'op'; v: string }
    | { kind: 'name'; v: string };
  const toks: V[] = [];
  for (;;) {
    const t = lx.next();
    if (t.t === 'eof') break;
    if (t.t === 'str') toks.push({ kind: 'hex', bytes: t.v });
    else if (t.t === 'num') toks.push({ kind: 'num', v: t.v });
    else if (t.t === 'kw') toks.push({ kind: 'op', v: t.v });
    else if (t.t === 'name') toks.push({ kind: 'name', v: t.v });
    // array and dict delimiters carry nothing this grammar reads
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    if (t.kind === 'name') {
      const next = toks[i + 1];
      // `/UniJIS-UCS2-H usecmap` — the name comes first.
      if (next?.kind === 'op' && next.v === 'usecmap') { out.usecmap = t.v; continue; }
      if (t.v === 'WMode' && next?.kind === 'num') out.wmode = next.v === 1 ? 1 : 0;
      else if (t.v === 'CMapName' && next?.kind === 'name') out.name = next.v;
      else if (t.v === 'Registry' && next?.kind === 'hex') out.registry = latin1(next.bytes);
      else if (t.v === 'Ordering' && next?.kind === 'hex') out.ordering = latin1(next.bytes);
      else if (t.v === 'Supplement' && next?.kind === 'num') out.supplement = next.v;
      continue;
    }

    if (t.kind !== 'op') continue;

    if (t.v === 'begincodespacerange') {
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const lo = toks[j], hi = toks[j + 1];
        if (lo?.kind === 'hex' && hi?.kind === 'hex' && lo.bytes.length > 0) {
          const nbytes = Math.min(lo.bytes.length, MAX_CODE_BYTES);
          out.codespace.push({ nbytes, lo: bytesToCode(lo.bytes), hi: bytesToCode(hi.bytes) });
          j += 2;
        } else j++;
      }
      i = j - 1;
    } else if (t.v === 'begincidrange' || t.v === 'beginnotdefrange') {
      const target = t.v === 'begincidrange' ? out.cidRanges : out.notdefRanges;
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const lo = toks[j], hi = toks[j + 1], cid = toks[j + 2];
        if (lo?.kind === 'hex' && hi?.kind === 'hex' && cid?.kind === 'num' && lo.bytes.length > 0) {
          const nbytes = Math.min(lo.bytes.length, MAX_CODE_BYTES);
          target.push({ nbytes, lo: bytesToCode(lo.bytes), hi: bytesToCode(hi.bytes), cid: cid.v >>> 0 });
          j += 3;
        } else j++;
      }
      i = j - 1;
    } else if (t.v === 'begincidchar') {
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const code = toks[j], cid = toks[j + 1];
        if (code?.kind === 'hex' && cid?.kind === 'num' && code.bytes.length > 0) {
          const nbytes = Math.min(code.bytes.length, MAX_CODE_BYTES);
          const v = bytesToCode(code.bytes);
          out.cidRanges.push({ nbytes, lo: v, hi: v, cid: cid.v >>> 0 });
          j += 2;
        } else j++;
      }
      i = j - 1;
    }
  }

  return out;
}
