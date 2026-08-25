import { readIndex, parseDict, op1, bias } from './cff.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

interface FdData { localSubrs: Uint8Array[]; }

export interface CffProgram {
  nameIndex: Uint8Array[];
  globalSubrs: Uint8Array[];
  charStrings: Uint8Array[];
  numGlyphs: number;
  isCID: boolean;
  fdOf: (gid: number) => number;
  localSubrsOf: (fd: number) => Uint8Array[];
  fdCount: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Decode a Type2 integer operand at `at`, or undefined if it is not an integer
 *  (e.g. a 255 16.16 fixed real) — used to read a subr index literal. */
function decodeInt(code: Uint8Array, at: number): number | undefined {
  const b = code[at];
  if (b === 28) return ((code[at + 1] << 8) | code[at + 2]) << 16 >> 16;
  if (b >= 32 && b <= 246) return b - 139;
  if (b >= 247 && b <= 250) return (b - 247) * 256 + code[at + 1] + 108;
  if (b >= 251 && b <= 254) return -(b - 251) * 256 - code[at + 1] - 108;
  return undefined;
}

/** One DICT entry: an operator and the raw bytes of the operands preceding it. */
export interface DictSpan {
  /** Two-byte (escape 12) operators are keyed `0xc00 | b1`, matching `parseDict`. */
  op: number;
  operands: Uint8Array;
}

/** Width of the DICT operand starting at `i`, or 0 when `data[i]` is not one. */
function operandWidth(data: Uint8Array, i: number): number {
  const b = data[i];
  if (b === 28) return 3;                                        // int16
  if (b === 29) return 5;                                        // int32
  if (b === 30) {                                                // real (BCD): scan to the 0xf nibble
    let j = i + 1;
    while (j < data.length) {
      const c = data[j++];
      if ((c >> 4) === 0xf || (c & 0xf) === 0xf) break;
    }
    return j - i;
  }
  if (b >= 32 && b <= 246) return 1;
  if (b >= 247 && b <= 254) return 2;
  return 0;
}

/**
 * Split a DICT into operator entries carrying their operands as **raw bytes**.
 *
 * The counterpart to `parseDict`, which decodes operands to numbers. Re-emitting
 * a DICT from decoded numbers corrupts it: a real (BCD) operand like FontMatrix
 * would come back as an integer, and an operator this code does not model would
 * be dropped entirely. Rewriting only the offset operators while copying every
 * other span byte-for-byte keeps an unknown DICT intact.
 */
export function parseDictSpans(data: Uint8Array): DictSpan[] {
  const spans: DictSpan[] = [];
  let i = 0, start = 0;
  while (i < data.length) {
    const w = operandWidth(data, i);
    if (w > 0) { i += w; continue; }
    const b = data[i];
    if (b <= 21) {                                               // operator
      const opStart = i;
      let op = b; i++;
      if (b === 12) { op = 0xc00 | data[i]; i++; }
      spans.push({ op, operands: data.subarray(start, opStart) });
      start = i;
    } else i++;                                                  // reserved: skip
  }
  return spans;
}

export interface FlattenCtx { localSubrs: Uint8Array[]; localBias: number; globalSubrs: Uint8Array[]; globalBias: number; }
interface FlattenState { out: Uint8Array[]; nStems: number; depth: number; }

/** Recursively emit `code` with subr calls expanded inline. `startStack` is the
 *  operand-stack depth on entry (threaded so a subr that leaves values for its
 *  caller is handled). Returns the ending stack depth and whether `endchar` was
 *  reached (which terminates the whole glyph). */
function flattenInto(code: Uint8Array, ctx: FlattenCtx, st: FlattenState, startStack: number): { stack: number; done: boolean } {
  if (st.depth > 60) throw new UnsupportedFeatureError('CFF subset: subr recursion too deep');
  let i = 0, stackLen = startStack, emitFrom = 0, lastStart = -1;
  while (i < code.length) {
    const b = code[i];
    if (b >= 32 || b === 28) {                       // operand
      lastStart = i;
      if (b === 28) i += 3;
      else if (b < 247) i += 1;
      else if (b < 251) i += 2;
      else if (b < 255) i += 2;
      else i += 5;                                   // 255: 16.16 fixed
      stackLen++;
      continue;
    }
    switch (b) {
      case 1: case 3: case 18: case 23:              // h/v stem(hm)
        st.nStems += stackLen >> 1; stackLen = 0; i++; break;
      case 19: case 20:                              // hintmask / cntrmask
        st.nStems += stackLen >> 1; stackLen = 0;
        i += 1 + ((st.nStems + 7) >> 3); break;      // mask bytes copied by later bulk flush
      case 10: case 29: {                            // callsubr / callgsubr
        const idx = decodeInt(code, lastStart);
        if (idx === undefined) throw new UnsupportedFeatureError('CFF subset: non-literal subr index');
        const subrs = b === 10 ? ctx.localSubrs : ctx.globalSubrs;
        const ti = idx + (b === 10 ? ctx.localBias : ctx.globalBias);
        if (ti < 0 || ti >= subrs.length) throw new UnsupportedFeatureError('CFF subset: subr index out of range');
        st.out.push(code.subarray(emitFrom, lastStart)); // everything up to (not incl.) the index literal
        st.depth++;
        const r = flattenInto(subrs[ti], ctx, st, Math.max(0, stackLen - 1));
        st.depth--;
        stackLen = r.stack;
        i++;                                         // skip the call op
        emitFrom = i;
        if (r.done) return { stack: stackLen, done: true };
        break;
      }
      case 11:                                       // return
        st.out.push(code.subarray(emitFrom, i));     // drop the return byte
        return { stack: stackLen, done: false };
      case 14:                                       // endchar
        if (stackLen >= 4) throw new UnsupportedFeatureError('CFF subset: seac-form endchar unsupported');
        st.out.push(code.subarray(emitFrom, i + 1)); // include endchar
        return { stack: 0, done: true };
      case 12: i += 2; stackLen = 0; break;          // escape (flex etc.)
      default: stackLen = 0; i++; break;             // moves / curves / lines
    }
  }
  st.out.push(code.subarray(emitFrom, i));
  return { stack: stackLen, done: false };
}

export function flattenGlyph(code: Uint8Array, ctx: FlattenCtx): Uint8Array {
  const st: FlattenState = { out: [], nStems: 0, depth: 0 };
  const r = flattenInto(code, ctx, st, 0);
  if (!r.done) st.out.push(Uint8Array.from([14]));   // ensure endchar terminates the glyph
  return cat(st.out);
}

function u16b(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }

/** Serialize items as a CFF INDEX (auto offSize). */
export function writeIndex(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return u16b(0);
  let dataLen = 0; for (const it of items) dataLen += it.length;
  const lastOff = dataLen + 1;
  const offSize = lastOff <= 0xff ? 1 : lastOff <= 0xffff ? 2 : lastOff <= 0xffffff ? 3 : 4;
  const head: number[] = [(items.length >> 8) & 0xff, items.length & 0xff, offSize];
  const writeOff = (o: number): void => { for (let k = offSize - 1; k >= 0; k--) head.push((o >> (8 * k)) & 0xff); };
  let off = 1; writeOff(off);
  for (const it of items) { off += it.length; writeOff(off); }
  return cat([Uint8Array.from(head), ...items]);
}

/** CFF DICT integer, fixed 5-byte form (29 + int32) — keeps DICTs constant-width
 *  so the program lays out in a single pass. */
function dictInt5(n: number): Uint8Array {
  const b = new Uint8Array(5); b[0] = 29; new DataView(b.buffer).setUint32(1, n >>> 0); return b;
}

/** Assemble a bare CID-keyed CFF (CIDFontType0C): single FD, empty subrs, charset
 *  mapping subset gid -> original gid (CID). */
export function assembleCidCff(nameIndex: Uint8Array[], charStrings: Uint8Array[], cidOfSubsetGid: number[]): Uint8Array {
  const n = charStrings.length;
  const header = Uint8Array.from([1, 0, 4, 1]);
  const name = writeIndex(nameIndex.length ? nameIndex : [new TextEncoder().encode('Subset')]);
  const strings = writeIndex([new TextEncoder().encode('Adobe'), new TextEncoder().encode('Identity')]); // SID 391, 392
  const gsubr = writeIndex([]);
  const cs = writeIndex(charStrings);

  // charset format 0: gid 1..n-1 -> u16 CID (gid0 => CID0 implicitly).
  const charsetParts: Uint8Array[] = [Uint8Array.from([0])];
  for (let g = 1; g < n; g++) charsetParts.push(u16b(cidOfSubsetGid[g]));
  const charset = cat(charsetParts);

  // FDSelect format 3: one range, all glyphs -> FD 0.
  const fdSelect = cat([Uint8Array.from([3]), u16b(1), u16b(0), Uint8Array.from([0]), u16b(n)]);

  // FDArray: one Font DICT with Private [size 0, offset 0] (no Private body).
  const fontDict = cat([dictInt5(0), dictInt5(0), Uint8Array.from([18])]);
  const fdArray = writeIndex([fontDict]);

  // Fixed-width Top DICT (ROS, CharStrings, charset, FDArray, FDSelect); FDArray
  // is emitted last, so all offsets are known once the prefix length is fixed.
  const topLen = (5 * 3 + 2) + (5 + 1) + (5 + 1) + (5 + 2) + (5 + 2);   // = 43
  const topIndexLen = 2 + 1 + 2 + topLen;                               // 1 item, offSize 1
  const prefixLen = header.length + name.length + topIndexLen + strings.length + gsubr.length;

  const csOff = prefixLen;
  const charsetOff = csOff + cs.length;
  const fdSelectOff = charsetOff + charset.length;
  const fdArrayOff = fdSelectOff + fdSelect.length;

  const topDict = cat([
    dictInt5(391), dictInt5(392), dictInt5(0), Uint8Array.from([12, 30]),  // ROS
    dictInt5(csOff), Uint8Array.from([17]),                                // CharStrings
    dictInt5(charsetOff), Uint8Array.from([15]),                           // charset
    dictInt5(fdArrayOff), Uint8Array.from([12, 36]),                       // FDArray
    dictInt5(fdSelectOff), Uint8Array.from([12, 37]),                      // FDSelect
  ]);
  if (topDict.length !== topLen) throw new PdfParseError('CFF subset: Top DICT length mismatch');
  const topIndex = writeIndex([topDict]);

  return cat([header, name, topIndex, strings, gsubr, cs, charset, fdSelect, fdArray]);
}

export function subsetCff(cff: Uint8Array, usedGids: Iterable<number>): { bytes: Uint8Array; gidMap: Map<number, number> } {
  const prog = parseCffProgram(cff);

  const keep = new Set<number>([0]);
  for (const g of usedGids) if (Number.isInteger(g) && g >= 0 && g < prog.numGlyphs) keep.add(g);
  const order = [...keep].sort((a, b) => a - b);
  const gidMap = new Map<number, number>(); order.forEach((g, i) => gidMap.set(g, i));

  const globalBias = bias(prog.globalSubrs.length);
  const charStrings = order.map((g) => {
    const local = prog.localSubrsOf(prog.fdOf(g));
    const ctx: FlattenCtx = { localSubrs: local, localBias: bias(local.length), globalSubrs: prog.globalSubrs, globalBias };
    return flattenGlyph(prog.charStrings[g], ctx);
  });

  const bytes = assembleCidCff(prog.nameIndex, charStrings, order);   // cidOfSubsetGid[i] = order[i] = origGID
  return { bytes, gidMap };
}

/** Read a Private DICT [size, offset]'s local subr INDEX (or [] if none). */
function loadLocalSubrs(bytes: Uint8Array, v: DataView, priv: number[] | undefined): Uint8Array[] {
  if (priv && priv.length >= 2) {
    const size = priv[0], off = priv[1];
    if (size > 0 && off + size <= bytes.length) {
      const subrsOff = op1(parseDict(bytes.subarray(off, off + size)), 19);
      if (subrsOff !== undefined) return readIndex(bytes, v, off + subrsOff).items;
    }
  }
  return [];
}

function parseFdSelect(bytes: Uint8Array, v: DataView, off: number, numGlyphs: number): (gid: number) => number {
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
  throw new UnsupportedFeatureError(`CFF FDSelect format ${format} unsupported`);
}

export function parseCffProgram(cff: Uint8Array): CffProgram {
  const v = view(cff);
  const hdrSize = v.getUint8(2);
  let p = hdrSize;
  const nameIdx = readIndex(cff, v, p); p = nameIdx.end;
  const topIdx = readIndex(cff, v, p); p = topIdx.end;
  const stringIdx = readIndex(cff, v, p); p = stringIdx.end;   // unused, but advances p
  const gsubrIdx = readIndex(cff, v, p);

  if (topIdx.items.length === 0) throw new PdfParseError('CFF: empty Top DICT INDEX');
  const top = parseDict(topIdx.items[0]);

  const csOff = op1(top, 17);
  if (csOff === undefined) throw new PdfParseError('CFF: Top DICT has no CharStrings offset');
  const charStrings = readIndex(cff, v, csOff).items;
  const numGlyphs = charStrings.length;
  const isCID = top.has(0xc1e);   // 12 30 ROS

  let fds: FdData[]; let fdOf: (gid: number) => number;
  if (isCID) {
    const fdArrayOff = op1(top, 0xc24);   // 12 36 FDArray
    const fdSelectOff = op1(top, 0xc25);  // 12 37 FDSelect
    const fdArray = fdArrayOff !== undefined ? readIndex(cff, v, fdArrayOff).items : [];
    fds = fdArray.map((d) => ({ localSubrs: loadLocalSubrs(cff, v, parseDict(d).get(18)) }));
    if (fds.length === 0) fds = [{ localSubrs: [] }];
    fdOf = fdSelectOff !== undefined ? parseFdSelect(cff, v, fdSelectOff, numGlyphs) : () => 0;
  } else {
    fds = [{ localSubrs: loadLocalSubrs(cff, v, top.get(18)) }];
    fdOf = () => 0;
  }

  return {
    nameIndex: nameIdx.items, globalSubrs: gsubrIdx.items,
    charStrings, numGlyphs, isCID, fdOf,
    localSubrsOf: (fd) => fds[fd]?.localSubrs ?? [],
    fdCount: fds.length,
  };
}
