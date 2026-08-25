import type { Path, Seg } from './pagerender.js';
import { PdfParseError } from './errors.js';
import { sidToName } from './cffstrings.js';

/**
 * A parsed CFF (Compact Font Format) program — the outline source for
 * `/FontFile3` (Type1C / CIDFontType0C) and OpenType-CFF (`CFF ` table) fonts.
 * Parses the INDEX/DICT structures, charset, and (for CID-keyed fonts) the
 * FDArray/FDSelect, then interprets Type2 charstrings to cubic-Bézier outlines.
 */
export class CffFont {
  /** The raw CFF program bytes, retained so consumers can re-emit it verbatim. */
  readonly raw: Uint8Array;
  readonly numGlyphs: number;
  readonly unitsPerEm: number;
  readonly isCID: boolean;

  private readonly charStrings: Uint8Array[];
  private readonly globalSubrs: Uint8Array[];
  private readonly globalBias: number;
  /** Non-CID: one entry. CID: one per FD. */
  private readonly fdLocalSubrs: Uint8Array[][];
  private readonly fdBias: number[];
  private readonly fdWidths: { nominal: number; default: number }[];
  private readonly fdSelect: (gid: number) => number;
  private readonly cidToGidMap?: Map<number, number>;
  /** gid -> CID, inverted from {@link cidToGidMap} on first use. */
  private gidToCidMap?: Map<number, number>;
  /** gid -> charstring width, computed on demand. */
  private readonly widthCache = new Map<number, number>();
  /** Retained for the lazy name-keyed reads below (charsetNames/builtinEncoding). */
  private readonly view: DataView;
  private readonly stringIndex: Uint8Array[];
  private readonly charsetOff: number;
  private readonly encodingOff: number;

  constructor(bytes: Uint8Array) {
    this.raw = bytes;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.view = v;
    const hdrSize = v.getUint8(2);

    let p = hdrSize;
    const nameIdx = readIndex(bytes, v, p); p = nameIdx.end;      // Name INDEX (unused)
    const topIdx = readIndex(bytes, v, p); p = topIdx.end;        // Top DICT INDEX
    const stringIdx = readIndex(bytes, v, p); p = stringIdx.end;  // String INDEX
    const gsubrIdx = readIndex(bytes, v, p); p = gsubrIdx.end;    // Global Subr INDEX
    this.stringIndex = stringIdx.items;

    if (topIdx.items.length === 0) throw new PdfParseError('CFF: empty Top DICT INDEX');
    const top = parseDict(topIdx.items[0]);

    const csOff = op1(top, 17);
    if (csOff === undefined) throw new PdfParseError('CFF: Top DICT has no CharStrings offset');
    const cs = readIndex(bytes, v, csOff);
    this.charStrings = cs.items;
    this.numGlyphs = cs.items.length;

    this.globalSubrs = gsubrIdx.items;
    this.globalBias = bias(this.globalSubrs.length);

    const fm = top.get(0xc07);                                   // 12 7 FontMatrix
    this.unitsPerEm = fm && fm[0] ? Math.round(1 / fm[0]) : 1000;

    this.isCID = top.has(0xc1e);                                 // 12 30 ROS
    this.charsetOff = op1(top, 15) ?? 0;                         // 0 = predefined ISOAdobe
    this.encodingOff = op1(top, 16) ?? 0;                        // 0 = predefined Standard

    this.fdLocalSubrs = [];
    this.fdBias = [];
    this.fdWidths = [];

    if (this.isCID) {
      const fdArrayOff = op1(top, 0xc24);                        // 12 36 FDArray
      const fdSelectOff = op1(top, 0xc25);                       // 12 37 FDSelect
      const fdArray = fdArrayOff !== undefined ? readIndex(bytes, v, fdArrayOff).items : [];
      for (const fdDictBytes of fdArray) this.loadPrivate(bytes, v, parseDict(fdDictBytes));
      if (this.fdLocalSubrs.length === 0) this.pushEmptyFd();
      this.fdSelect = fdSelectOff !== undefined ? parseFDSelect(bytes, v, fdSelectOff, this.numGlyphs) : () => 0;
      this.cidToGidMap = parseCharsetCid(bytes, v, this.charsetOff, this.numGlyphs);
    } else {
      this.loadPrivate(bytes, v, top);
      if (this.fdLocalSubrs.length === 0) this.pushEmptyFd();
      this.fdSelect = () => 0;
    }
  }

  /** @internal Lazily-read name-keyed views; `null` once known absent. */
  private _charsetNames?: (string | undefined)[] | null;
  private _builtinEncoding?: Map<number, number> | null;

  /**
   * `gid -> glyph name` from the charset, for a name-keyed (non-CID) font.
   *
   * Empty for a CID-keyed font, whose charset publishes CIDs rather than string
   * SIDs — use {@link gidToCid} there. A per-gid `undefined` means the SID ran
   * past the String INDEX: a malformed charset, which callers must treat as
   * unresolvable rather than guess through.
   */
  charsetNames(): (string | undefined)[] {
    if (this._charsetNames === undefined) {
      this._charsetNames = this.isCID
        ? null
        : parseCharsetSids(this.view, this.charsetOff, this.numGlyphs)
          .map((sid) => sidToName(sid, this.stringIndex));
    }
    return this._charsetNames ?? [];
  }

  /**
   * The font's built-in Encoding, `code -> gid`. `undefined` when the font uses a
   * predefined encoding (Standard or Expert), which embeds no table — the caller
   * decides what a predefined encoding means rather than being handed a guess.
   */
  builtinEncoding(): Map<number, number> | undefined {
    if (this._builtinEncoding === undefined) {
      this._builtinEncoding = this.isCID
        ? null
        : parseBuiltinEncoding(
          this.view, this.encodingOff, this.numGlyphs,
          parseCharsetSids(this.view, this.charsetOff, this.numGlyphs),
        ) ?? null;
    }
    return this._builtinEncoding ?? undefined;
  }

  /** Original glyph id for a CID (identity when the font is not CID-keyed or the
   *  charset is missing). */
  cidToGid(cid: number): number {
    if (!this.cidToGidMap) return cid;
    return this.cidToGidMap.get(cid) ?? 0;
  }

  /** CID for a GID — the inverse of {@link cidToGid} (identity when the font is
   *  not CID-keyed or the charset is missing). Used to re-emit an unchanged
   *  charset when blanking. */
  gidToCid(gid: number): number {
    if (!this.cidToGidMap) return gid;
    if (!this.gidToCidMap) {
      this.gidToCidMap = new Map();
      for (const [cid, g] of this.cidToGidMap) this.gidToCidMap.set(g, cid);
    }
    return this.gidToCidMap.get(gid) ?? 0;
  }

  /** Interpret glyph `gid`'s Type2 charstring to a cubic outline (font units). */
  glyphPath(gid: number): Path {
    if (gid < 0 || gid >= this.charStrings.length) return [];
    const fd = this.fdSelect(gid);
    const ctx: T2Ctx = {
      path: [], x: 0, y: 0, stack: [], nStems: 0, haveWidth: false, open: false,
      localSubrs: this.fdLocalSubrs[fd] ?? [], localBias: this.fdBias[fd] ?? 107,
      globalSubrs: this.globalSubrs, globalBias: this.globalBias,
      width: this.fdWidths[fd]?.default ?? 0, nominalWidth: this.fdWidths[fd]?.nominal ?? 0,
      depth: 0,
    };
    try { runCharString(this.charStrings[gid], ctx); } catch { /* degrade to whatever was drawn */ }
    if (ctx.open) ctx.path.push({ op: 'Z' });
    return ctx.path;
  }

  /**
   * The advance width `gid`'s charstring declares, in the font's own units.
   *
   * A Type 2 charstring encodes its width as an *optional* leading operand on
   * the first stack-clearing operator: present means `nominalWidthX + operand`,
   * absent means `defaultWidthX`. The interpreter already resolves that into
   * `T2Ctx.width`; this exposes it. Callers must divide out {@link unitsPerEm}
   * — see `glyphprogram.ts`.
   *
   * Deliberately re-runs the charstring rather than caching the whole context
   * alongside {@link glyphPath}: sharing one `Path` array between callers would
   * make a mutation by any of them visible to all.
   */
  glyphWidth(gid: number): number | undefined {
    if (gid < 0 || gid >= this.charStrings.length) return undefined;
    const hit = this.widthCache.get(gid);
    if (hit !== undefined) return hit;
    const fd = this.fdSelect(gid);
    const ctx: T2Ctx = {
      path: [], x: 0, y: 0, stack: [], nStems: 0, haveWidth: false, open: false,
      localSubrs: this.fdLocalSubrs[fd] ?? [], localBias: this.fdBias[fd] ?? 107,
      globalSubrs: this.globalSubrs, globalBias: this.globalBias,
      width: this.fdWidths[fd]?.default ?? 0, nominalWidth: this.fdWidths[fd]?.nominal ?? 0,
      depth: 0,
    };
    try { runCharString(this.charStrings[gid], ctx); } catch { /* keep what was resolved */ }
    this.widthCache.set(gid, ctx.width);
    return ctx.width;
  }

  private loadPrivate(bytes: Uint8Array, v: DataView, dict: Map<number, number[]>): void {
    const priv = dict.get(18);                                   // 18 Private [size offset]
    let localSubrs: Uint8Array[] = [];
    let nominal = 0, def = 0;
    if (priv && priv.length >= 2) {
      const size = priv[0], off = priv[1];
      if (size > 0 && off + size <= bytes.length) {
        const pd = parseDict(bytes.subarray(off, off + size));
        nominal = op1(pd, 21) ?? 0;                              // nominalWidthX
        def = op1(pd, 20) ?? 0;                                  // defaultWidthX
        const subrsOff = op1(pd, 19);                            // Subrs (relative to Private)
        if (subrsOff !== undefined) localSubrs = readIndex(bytes, v, off + subrsOff).items;
      }
    }
    this.fdLocalSubrs.push(localSubrs);
    this.fdBias.push(bias(localSubrs.length));
    this.fdWidths.push({ nominal, default: def });
  }

  private pushEmptyFd(): void {
    this.fdLocalSubrs.push([]); this.fdBias.push(107); this.fdWidths.push({ nominal: 0, default: 0 });
  }
}

// ---------- INDEX / DICT primitives ----------

export interface IndexResult { items: Uint8Array[]; end: number; }

export function readIndex(bytes: Uint8Array, v: DataView, at: number): IndexResult {
  const count = v.getUint16(at);
  if (count === 0) return { items: [], end: at + 2 };
  const offSize = v.getUint8(at + 2);
  const offBase = at + 3;
  const readOff = (i: number): number => {
    let o = 0;
    for (let k = 0; k < offSize; k++) o = (o << 8) | v.getUint8(offBase + i * offSize + k);
    return o;
  };
  const dataBase = offBase + (count + 1) * offSize - 1;          // offsets are 1-based
  const items: Uint8Array[] = [];
  for (let i = 0; i < count; i++) items.push(bytes.subarray(dataBase + readOff(i), dataBase + readOff(i + 1)));
  return { items, end: dataBase + readOff(count) };
}

/** Parse a CFF DICT to operator→operands. Two-byte (escape 12) operators are
 *  keyed as `0xc00 | b1`. */
export function parseDict(data: Uint8Array): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  const operands: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b <= 21) {                                               // operator
      let op = b; i++;
      if (b === 12) { op = 0xc00 | data[i]; i++; }
      dict.set(op, operands.slice());
      operands.length = 0;
    } else if (b === 28) { operands.push(((data[i + 1] << 8) | data[i + 2]) << 16 >> 16); i += 3; }
    else if (b === 29) { operands.push((data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4]); i += 5; }
    else if (b === 30) { const r = parseReal(data, i + 1); operands.push(r.value); i = r.next; }
    else if (b >= 32 && b <= 246) { operands.push(b - 139); i++; }
    else if (b >= 247 && b <= 250) { operands.push((b - 247) * 256 + data[i + 1] + 108); i += 2; }
    else if (b >= 251 && b <= 254) { operands.push(-(b - 251) * 256 - data[i + 1] - 108); i += 2; }
    else i++;                                                    // reserved: skip
  }
  return dict;
}

/** Decode a CFF real (BCD) number starting at `i` (after the 30 marker). */
function parseReal(data: Uint8Array, i: number): { value: number; next: number } {
  let s = '';
  for (;;) {
    const b = data[i++];
    for (const nib of [b >> 4, b & 0xf]) {
      if (nib <= 9) s += nib;
      else if (nib === 0xa) s += '.';
      else if (nib === 0xb) s += 'E';
      else if (nib === 0xc) s += 'E-';
      else if (nib === 0xe) s += '-';
      else if (nib === 0xf) return { value: parseFloat(s) || 0, next: i };
    }
  }
}

export function op1(dict: Map<number, number[]>, key: number): number | undefined {
  const a = dict.get(key);
  return a && a.length ? a[0] : undefined;
}

export const bias = (n: number): number => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

// ---------- charset / Encoding / FDSelect ----------

/**
 * The charset's 16-bit field per gid, `gid -> value`, with gid 0 implicitly 0.
 *
 * A charset's byte layout is identical whether the font is CID-keyed or
 * name-keyed — only the meaning of that field differs (a CID vs a string SID) —
 * so both readers share this walk.
 *
 * `off === 0` is the predefined ISOAdobe charset, where the value equals the gid
 * for the whole range. Offsets 1 and 2 (Expert, ExpertSubset) are predefined
 * tables this does not carry: it returns an empty array rather than guess, and
 * callers must treat that as unresolvable.
 */
function parseCharsetSids(v: DataView, off: number, numGlyphs: number): number[] {
  const sids: number[] = [0];                                    // gid 0 -> .notdef / CID 0
  if (off === 0) { for (let g = 1; g < numGlyphs; g++) sids.push(g); return sids; }
  if (off === 1 || off === 2) return [];                         // Expert / ExpertSubset: not carried
  const format = v.getUint8(off);
  let p = off + 1;
  if (format === 0) {
    while (sids.length < numGlyphs) { sids.push(v.getUint16(p)); p += 2; }
  } else if (format === 1 || format === 2) {
    while (sids.length < numGlyphs) {
      const first = v.getUint16(p); p += 2;
      const nLeft = format === 1 ? v.getUint8(p) : v.getUint16(p); p += format === 1 ? 1 : 2;
      for (let k = 0; k <= nLeft && sids.length < numGlyphs; k++) sids.push(first + k);
    }
  } else return [];                                              // unknown format: unresolvable
  return sids;
}

/** For a CID-keyed font, map CID→GID from the charset (gid→CID). */
function parseCharsetCid(bytes: Uint8Array, v: DataView, off: number, numGlyphs: number): Map<number, number> {
  const map = new Map<number, number>();
  map.set(0, 0);                                                 // gid 0 = CID 0 (.notdef)
  const sids = parseCharsetSids(v, off, numGlyphs);
  for (let gid = 1; gid < sids.length; gid++) map.set(sids[gid], gid);
  return map;
}

/**
 * A CFF's built-in Encoding, `code -> gid`. `undefined` when the font uses a
 * predefined encoding — offset 0 (Standard, the default) or 1 (Expert) — which
 * carries no embedded table to read.
 */
function parseBuiltinEncoding(
  v: DataView, off: number, numGlyphs: number, sids: number[],
): Map<number, number> | undefined {
  if (off === 0 || off === 1) return undefined;                  // predefined: nothing embedded
  const map = new Map<number, number>();
  const b0 = v.getUint8(off);
  const format = b0 & 0x7f;
  let p = off + 1;
  if (format === 0) {
    const nCodes = v.getUint8(p); p += 1;
    for (let i = 1; i <= nCodes && i < numGlyphs; i++) { map.set(v.getUint8(p), i); p += 1; }
  } else if (format === 1) {
    const nRanges = v.getUint8(p); p += 1;
    let gid = 1;
    for (let i = 0; i < nRanges; i++) {
      const first = v.getUint8(p); const nLeft = v.getUint8(p + 1); p += 2;
      for (let k = 0; k <= nLeft && gid < numGlyphs; k++) map.set(first + k, gid++);
    }
  } else return undefined;                                       // unknown format: no answer
  if (b0 & 0x80) {                                               // supplements: (code, SID) triples
    const nSups = v.getUint8(p); p += 1;
    for (let i = 0; i < nSups; i++) {
      const code = v.getUint8(p); const sid = v.getUint16(p + 1); p += 3;
      const gid = sids.indexOf(sid);
      if (gid > 0) map.set(code, gid);
    }
  }
  return map;
}

function parseFDSelect(bytes: Uint8Array, v: DataView, off: number, numGlyphs: number): (gid: number) => number {
  const format = v.getUint8(off);
  if (format === 0) {
    const fds = bytes.subarray(off + 1, off + 1 + numGlyphs);
    return (gid) => fds[gid] ?? 0;
  }
  if (format === 3) {
    const nRanges = v.getUint16(off + 1);
    const ranges: { first: number; fd: number }[] = [];
    let p = off + 3;
    for (let i = 0; i < nRanges; i++) { ranges.push({ first: v.getUint16(p), fd: v.getUint8(p + 2) }); p += 3; }
    const sentinel = v.getUint16(p);
    return (gid) => {
      for (let i = 0; i < ranges.length; i++) {
        const next = i + 1 < ranges.length ? ranges[i + 1].first : sentinel;
        if (gid >= ranges[i].first && gid < next) return ranges[i].fd;
      }
      return 0;
    };
  }
  return () => 0;
}

// ---------- Type 2 charstring interpreter ----------

interface T2Ctx {
  path: Path; x: number; y: number;
  stack: number[]; nStems: number; haveWidth: boolean; open: boolean;
  localSubrs: Uint8Array[]; localBias: number;
  globalSubrs: Uint8Array[]; globalBias: number;
  width: number; nominalWidth: number; depth: number;
}

function moveTo(c: T2Ctx, dx: number, dy: number): void {
  if (c.open) c.path.push({ op: 'Z' });
  c.x += dx; c.y += dy;
  c.path.push({ op: 'M', x: c.x, y: c.y });
  c.open = true;
}
function lineTo(c: T2Ctx, dx: number, dy: number): void {
  c.x += dx; c.y += dy;
  c.path.push({ op: 'L', x: c.x, y: c.y });
}
function curveTo(c: T2Ctx, dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number): void {
  const x1 = c.x + dx1, y1 = c.y + dy1;
  const x2 = x1 + dx2, y2 = y1 + dy2;
  c.x = x2 + dx3; c.y = y2 + dy3;
  c.path.push({ op: 'C', x1, y1, x2, y2, x: c.x, y: c.y } as Seg);
}

/** Consume a leading width argument if the first stack-clearing operator carries
 *  more operands than it needs (`nargs`). */
function maybeWidth(c: T2Ctx, nargs: number): void {
  if (c.haveWidth) return;
  if (c.stack.length > nargs) c.width = c.nominalWidth + c.stack.shift()!;
  c.haveWidth = true;
}

function countStems(c: T2Ctx): void {
  if (!c.haveWidth && c.stack.length % 2 === 1) { c.width = c.nominalWidth + c.stack.shift()!; }
  c.haveWidth = true;
  c.nStems += c.stack.length >> 1;
  c.stack.length = 0;
}

function runCharString(code: Uint8Array, c: T2Ctx): void {
  if (c.depth > 10) return;
  let i = 0;
  while (i < code.length) {
    const b = code[i++];
    if (b >= 32 || b === 28) {                                   // operand
      if (b === 28) { c.stack.push(((code[i] << 8) | code[i + 1]) << 16 >> 16); i += 2; }
      else if (b < 247) c.stack.push(b - 139);
      else if (b < 251) { c.stack.push((b - 247) * 256 + code[i] + 108); i++; }
      else if (b < 255) { c.stack.push(-(b - 251) * 256 - code[i] - 108); i++; }
      else { c.stack.push(((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]) / 65536); i += 4; }
      continue;
    }
    switch (b) {
      case 1: case 3: case 18: case 23: countStems(c); break;   // h/v stem(hm)
      case 19: case 20: countStems(c); i += (c.nStems + 7) >> 3; break;  // hintmask/cntrmask
      case 21: maybeWidth(c, 2); moveTo(c, c.stack[0] ?? 0, c.stack[1] ?? 0); c.stack.length = 0; break; // rmoveto
      case 22: maybeWidth(c, 1); moveTo(c, c.stack[0] ?? 0, 0); c.stack.length = 0; break; // hmoveto
      case 4: maybeWidth(c, 1); moveTo(c, 0, c.stack[0] ?? 0); c.stack.length = 0; break;  // vmoveto
      case 5: { for (let k = 0; k + 1 < c.stack.length; k += 2) lineTo(c, c.stack[k], c.stack[k + 1]); c.stack.length = 0; break; } // rlineto
      case 6: alternatingLines(c, true); break;                 // hlineto
      case 7: alternatingLines(c, false); break;                // vlineto
      case 8: { for (let k = 0; k + 5 < c.stack.length; k += 6) curveTo(c, c.stack[k], c.stack[k + 1], c.stack[k + 2], c.stack[k + 3], c.stack[k + 4], c.stack[k + 5]); c.stack.length = 0; break; } // rrcurveto
      case 24: { let k = 0; for (; k + 5 < c.stack.length - 2; k += 6) curveTo(c, c.stack[k], c.stack[k + 1], c.stack[k + 2], c.stack[k + 3], c.stack[k + 4], c.stack[k + 5]); lineTo(c, c.stack[k], c.stack[k + 1]); c.stack.length = 0; break; } // rcurveline
      case 25: { let k = 0; for (; k + 1 < c.stack.length - 6; k += 2) lineTo(c, c.stack[k], c.stack[k + 1]); curveTo(c, c.stack[k], c.stack[k + 1], c.stack[k + 2], c.stack[k + 3], c.stack[k + 4], c.stack[k + 5]); c.stack.length = 0; break; } // rlinecurve
      case 26: vvcurveto(c); break;
      case 27: hhcurveto(c); break;
      case 30: hvOrVh(c, false); break;                         // vhcurveto
      case 31: hvOrVh(c, true); break;                          // hvcurveto
      case 10: callSubr(c, c.localSubrs, c.localBias); break;
      case 29: callSubr(c, c.globalSubrs, c.globalBias); break;
      case 11: return;                                          // return
      case 14: if (c.stack.length !== 4) maybeWidth(c, 0); if (c.open) { c.path.push({ op: 'Z' }); c.open = false; } return; // endchar
      case 12: escape(c, code[i++]); break;
      default: c.stack.length = 0; break;
    }
  }
}

function callSubr(c: T2Ctx, subrs: Uint8Array[], b: number): void {
  const idx = (c.stack.pop() ?? 0) + b;
  if (idx < 0 || idx >= subrs.length) return;
  c.depth++;
  runCharString(subrs[idx], c);
  c.depth--;
}

function alternatingLines(c: T2Ctx, startHorizontal: boolean): void {
  let horiz = startHorizontal;
  for (let k = 0; k < c.stack.length; k++) { if (horiz) lineTo(c, c.stack[k], 0); else lineTo(c, 0, c.stack[k]); horiz = !horiz; }
  c.stack.length = 0;
}

function vvcurveto(c: T2Ctx): void {
  const s = c.stack; let k = 0;
  let dx1 = 0;
  if (s.length % 4 === 1) { dx1 = s[0]; k = 1; }
  for (; k + 3 < s.length; k += 4) { curveTo(c, dx1, s[k], s[k + 1], s[k + 2], 0, s[k + 3]); dx1 = 0; }
  s.length = 0;
}
function hhcurveto(c: T2Ctx): void {
  const s = c.stack; let k = 0;
  let dy1 = 0;
  if (s.length % 4 === 1) { dy1 = s[0]; k = 1; }
  for (; k + 3 < s.length; k += 4) { curveTo(c, s[k], dy1, s[k + 1], s[k + 2], s[k + 3], 0); dy1 = 0; }
  s.length = 0;
}
function hvOrVh(c: T2Ctx, startHorizontal: boolean): void {
  const s = c.stack; let k = 0; let horiz = startHorizontal;
  while (k + 3 < s.length) {
    const last = s.length - k === 5;
    const df = last ? s[k + 4] : 0;
    if (horiz) curveTo(c, s[k], 0, s[k + 1], s[k + 2], df, s[k + 3]);
    else curveTo(c, 0, s[k], s[k + 1], s[k + 2], s[k + 3], df);
    horiz = !horiz; k += 4;
  }
  s.length = 0;
}

function escape(c: T2Ctx, b1: number): void {
  const s = c.stack;
  switch (b1) {
    case 34: {   // hflex
      const [dx1, dx2, dy2, dx3, dx4, dx5, dx6] = s;
      curveTo(c, dx1, 0, dx2, dy2, dx3, 0);
      curveTo(c, dx4, 0, dx5, -dy2, dx6, 0);
      break;
    }
    case 36: {   // hflex1
      const [dx1, dy1, dx2, dy2, dx3, dx4, dx5, dy5, dx6] = s;
      curveTo(c, dx1, dy1, dx2, dy2, dx3, 0);
      curveTo(c, dx4, 0, dx5, dy5, dx6, -(dy1 + dy2 + dy5));
      break;
    }
    case 35: {   // flex
      curveTo(c, s[0], s[1], s[2], s[3], s[4], s[5]);
      curveTo(c, s[6], s[7], s[8], s[9], s[10], s[11]);
      break;
    }
    case 37: {   // flex1
      const dx = s[0] + s[2] + s[4] + s[6] + s[8];
      const dy = s[1] + s[3] + s[5] + s[7] + s[9];
      curveTo(c, s[0], s[1], s[2], s[3], s[4], s[5]);
      if (Math.abs(dx) > Math.abs(dy)) curveTo(c, s[6], s[7], s[8], s[9], s[10], -dy);
      else curveTo(c, s[6], s[7], s[8], s[9], -dx, s[10]);
      break;
    }
    default: break;
  }
  c.stack.length = 0;
}
