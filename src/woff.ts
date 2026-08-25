import { inflateSync, brotliDecompressSync } from 'node:zlib';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

const SIG_WOFF1 = 0x774f4646; // 'wOFF'
const SIG_WOFF2 = 0x774f4632; // 'wOF2'

/** Little forward byte reader (mirrors sfnt.ts). `pos`/`bytes` are public so
 *  sub-stream decoders can slice and seek. */
class Reader {
  private view: DataView;
  constructor(public bytes: Uint8Array, public pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new PdfParseError('unexpected end of WOFF data', this.pos);
  }
  u8(): number { this.need(1); return this.bytes[this.pos++]; }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  tag(): string { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4)); this.pos += 4; return s; }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16be(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }

/** Assemble a standard sfnt from decoded tables: offset table + directory
 *  (tags ascending) + 4-byte-padded bodies. Checksums written 0 (the parser
 *  ignores them, matching test/helpers/build-sfnt.ts). */
function writeSfnt(version: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset;
    const pad = (4 - (t.data.length & 3)) & 3;
    offset += t.data.length + pad;
    return { tag: t.tag, at, len: t.data.length, data: t.data };
  });
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  dv.setUint32(0, version >>> 0);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, numTables * 16 - searchRange);
  let p = 12;
  for (const pl of placed) {
    for (let k = 0; k < 4; k++) out[p + k] = pl.tag.charCodeAt(k);
    dv.setUint32(p + 4, 0);
    dv.setUint32(p + 8, pl.at);
    dv.setUint32(p + 12, pl.len);
    p += 16;
    out.set(pl.data, pl.at);
  }
  return out;
}

/** Unwrap WOFF (per-table zlib) or WOFF2 (brotli + transforms) to raw sfnt. */
export function sfntFromWoff(bytes: Uint8Array): Uint8Array {
  const sig = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (sig === SIG_WOFF1) return decodeWoff1(bytes);
  if (sig === SIG_WOFF2) return decodeWoff2(bytes);
  throw new PdfParseError('not a WOFF/WOFF2 font', 0);
}

function decodeWoff1(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  r.u32();                       // signature
  const flavor = r.u32();
  r.u32();                       // length
  const numTables = r.u16();
  r.u16();                       // reserved
  r.u32();                       // totalSfntSize
  r.u16(); r.u16();              // major/minor version
  r.u32(); r.u32(); r.u32();     // meta offset/length/origLength
  r.u32(); r.u32();              // priv offset/length
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32();                     // origChecksum
    if (offset + compLength > bytes.length) throw new PdfParseError('WOFF table out of bounds', offset);
    const comp = bytes.subarray(offset, offset + compLength);
    let data: Uint8Array;
    if (compLength < origLength) {
      try { data = new Uint8Array(inflateSync(Buffer.from(comp))); }
      catch { throw new PdfParseError('WOFF table inflate failed', offset); }
      if (data.length !== origLength) throw new PdfParseError('WOFF table length mismatch', offset);
    } else {
      data = comp;               // stored uncompressed (compLength == origLength)
    }
    tables.push({ tag, data });
  }
  return writeSfnt(flavor, tables);
}

// --- WOFF2 ---

/** WOFF2 known-table tags, indexed 0..62 by the directory flags byte (spec
 *  Table 6). Index 63 (0x3f) means a 4-byte arbitrary tag follows. */
const KNOWN_TAGS: string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function readUIntBase128(r: Reader): number {
  let accum = 0;
  for (let i = 0; i < 5; i++) {
    const b = r.u8();
    if (i === 0 && b === 0x80) throw new PdfParseError('WOFF2 UIntBase128 leading zero', r.pos);
    if (accum & 0xfe000000) throw new PdfParseError('WOFF2 UIntBase128 overflow', r.pos);
    accum = ((accum << 7) | (b & 0x7f)) >>> 0;
    if ((b & 0x80) === 0) return accum;
  }
  throw new PdfParseError('WOFF2 UIntBase128 too long', r.pos);
}

function read255UShort(r: Reader): number {
  const code = r.u8();
  if (code === 253) return r.u16();
  if (code === 255) return r.u8() + 253;
  if (code === 254) return r.u8() + 506;
  return code;
}

interface Woff2Entry { tag: string; transformVersion: number; origLength: number; transformLength: number; transformed: boolean; }

/** @internal Test hook: reconstruct standard glyf/loca from a transformed glyf
 *  table (WOFF2 §5.1). */
export function reconstructGlyfForTest(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; indexFormat: number } {
  return reconstructGlyf(data);
}

/** @internal Test hook for the WOFF2 hmtx transform (version 1). */
export function reconstructHmtxForTest(data: Uint8Array, numGlyphs: number, numHMetrics: number, xMins: number[]): Uint8Array {
  return reconstructHmtx(data, numGlyphs, numHMetrics, xMins);
}

/** Reconstruct a standard hmtx from the WOFF2 hmtx transform (version 1):
 *  advances are always present; lsb / trailing-lsb arrays may be omitted and
 *  reconstructed from each glyph's xMin. */
function reconstructHmtx(data: Uint8Array, numGlyphs: number, numHMetrics: number, xMins: number[]): Uint8Array {
  const r = new Reader(data);
  const flags = r.u8();
  const lsbAbsent = (flags & 0x01) !== 0;
  const trailingAbsent = (flags & 0x02) !== 0;
  const advances: number[] = [];
  for (let i = 0; i < numHMetrics; i++) advances.push(r.u16());
  const lsbs: number[] = [];
  for (let i = 0; i < numHMetrics; i++) lsbs.push(lsbAbsent ? (xMins[i] ?? 0) : r.i16());
  const trailing: number[] = [];
  for (let i = numHMetrics; i < numGlyphs; i++) trailing.push(trailingAbsent ? (xMins[i] ?? 0) : r.i16());

  const out = new Uint8Array(numHMetrics * 4 + trailing.length * 2);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < numHMetrics; i++) { dv.setUint16(o, advances[i]); dv.setInt16(o + 2, lsbs[i]); o += 4; }
  for (const t of trailing) { dv.setInt16(o, t); o += 2; }
  return out;
}

const withSign = (flag: number, base: number): number => (flag & 1) ? base : -base;

function reconstructGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; indexFormat: number } {
  const h = new Reader(data);
  h.u16();                       // reserved
  const optionFlags = h.u16();
  const numGlyphs = h.u16();
  let indexFormat = h.u16();
  const nContourSize = h.u32();
  const nPointsSize = h.u32();
  const flagSize = h.u32();
  const glyphSize = h.u32();
  const compositeSize = h.u32();
  const bboxSize = h.u32();
  const instructionSize = h.u32();
  let p = h.pos;
  const nContourStream = new Reader(data, p); p += nContourSize;
  const nPointsStream = new Reader(data, p); p += nPointsSize;
  const flagStream = new Reader(data, p); p += flagSize;
  const glyphStream = new Reader(data, p); p += glyphSize;
  const compositeStream = new Reader(data, p); p += compositeSize;
  const bboxStart = p; p += bboxSize;
  const instructionStream = new Reader(data, p); p += instructionSize;
  let overlapBitmap: Uint8Array | undefined;
  if (optionFlags & 0x0001) { const n = Math.ceil(numGlyphs / 8); overlapBitmap = data.subarray(p, p + n); p += n; }

  const bitmapLen = Math.ceil(numGlyphs / 8);
  const bboxBitmap = data.subarray(bboxStart, bboxStart + bitmapLen);
  const bboxValues = new Reader(data, bboxStart + bitmapLen);
  const hasBbox = (i: number): boolean => (bboxBitmap[i >> 3] & (0x80 >> (i & 7))) !== 0;
  const overlaps = (i: number): boolean => !!overlapBitmap && (overlapBitmap[i >> 3] & (0x80 >> (i & 7))) !== 0;

  const glyphs: Uint8Array[] = [];
  for (let i = 0; i < numGlyphs; i++) {
    const nContours = nContourStream.i16();
    if (nContours === 0) { glyphs.push(new Uint8Array(0)); continue; }
    if (nContours < 0) {
      glyphs.push(reconstructComposite(compositeStream, glyphStream, instructionStream, bboxValues, i, hasBbox));
    } else {
      glyphs.push(reconstructSimple(nContours, nPointsStream, flagStream, glyphStream, instructionStream, bboxValues, i, hasBbox, overlaps(i)));
    }
  }

  const bodies: Uint8Array[] = [];
  const offsets = [0];
  let total = 0;
  for (const g of glyphs) {
    const padded = (g.length & 1) ? concat([g, new Uint8Array(1)]) : g;
    bodies.push(padded); total += padded.length; offsets.push(total);
  }
  if (indexFormat === 0 && total > 0x1fffe) indexFormat = 1; // short loca can't address it
  const glyf = concat(bodies);
  let loca: Uint8Array;
  if (indexFormat === 0) {
    loca = new Uint8Array((numGlyphs + 1) * 2);
    const dv = new DataView(loca.buffer);
    for (let i = 0; i <= numGlyphs; i++) dv.setUint16(i * 2, offsets[i] / 2);
  } else {
    loca = new Uint8Array((numGlyphs + 1) * 4);
    const dv = new DataView(loca.buffer);
    for (let i = 0; i <= numGlyphs; i++) dv.setUint32(i * 4, offsets[i]);
  }
  return { glyf, loca, indexFormat };
}

function reconstructSimple(
  nContours: number, nPointsStream: Reader, flagStream: Reader, glyphStream: Reader,
  instructionStream: Reader, bboxValues: Reader, gi: number, hasBbox: (i: number) => boolean, overlap: boolean,
): Uint8Array {
  const endPts: number[] = [];
  let nPoints = 0;
  for (let c = 0; c < nContours; c++) { nPoints += read255UShort(nPointsStream); endPts.push(nPoints - 1); }

  const xs = new Array<number>(nPoints), ys = new Array<number>(nPoints), on = new Array<boolean>(nPoints);
  let x = 0, y = 0;
  for (let i = 0; i < nPoints; i++) {
    const flag = flagStream.u8();
    const onCurve = (flag & 0x80) === 0;
    const f = flag & 0x7f;
    const nBytes = f < 84 ? 1 : f < 120 ? 2 : f < 124 ? 3 : 4;
    const d: number[] = [];
    for (let k = 0; k < nBytes; k++) d.push(glyphStream.u8());
    let dx: number, dy: number;
    if (f < 10) { dx = 0; dy = withSign(f, ((f & 14) << 7) + d[0]); }
    else if (f < 20) { dx = withSign(f, (((f - 10) & 14) << 7) + d[0]); dy = 0; }
    else if (f < 84) { const b0 = f - 20, b1 = d[0]; dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4)); dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)); }
    else if (f < 120) { const b0 = f - 84; dx = withSign(f, 1 + ((Math.floor(b0 / 12)) << 8) + d[0]); dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + d[1]); }
    else if (f < 124) { const b2 = d[1]; dx = withSign(f, (d[0] << 4) + (b2 >> 4)); dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + d[2]); }
    else { dx = withSign(f, (d[0] << 8) + d[1]); dy = withSign(f >> 1, (d[2] << 8) + d[3]); }
    x += dx; y += dy; xs[i] = x; ys[i] = y; on[i] = onCurve;
  }

  const instrLen = read255UShort(glyphStream);
  const instr: number[] = [];
  for (let k = 0; k < instrLen; k++) instr.push(instructionStream.u8());

  let xMin: number, yMin: number, xMax: number, yMax: number;
  if (hasBbox(gi)) { xMin = bboxValues.i16(); yMin = bboxValues.i16(); xMax = bboxValues.i16(); yMax = bboxValues.i16(); }
  else if (nPoints === 0) { xMin = yMin = xMax = yMax = 0; }
  else { xMin = Math.min(...xs); yMin = Math.min(...ys); xMax = Math.max(...xs); yMax = Math.max(...ys); }

  const head = new Uint8Array(10 + nContours * 2 + 2 + instr.length);
  const dv = new DataView(head.buffer);
  dv.setInt16(0, nContours);
  dv.setInt16(2, xMin); dv.setInt16(4, yMin); dv.setInt16(6, xMax); dv.setInt16(8, yMax);
  let o = 10;
  for (const e of endPts) { dv.setUint16(o, e); o += 2; }
  dv.setUint16(o, instr.length); o += 2;
  for (const b of instr) head[o++] = b;

  // Emit the compact glyf encoding: a delta that fits one unsigned byte goes out
  // SHORT with its sign in the SAME bit, a zero delta as SAME with no bytes at
  // all, and equal flag bytes collapse into REPEAT runs. The WOFF2 transform
  // discards these choices, so they are made afresh here.
  const SHORT_X = 0x02, SHORT_Y = 0x04, REPEAT = 0x08, SAME_X = 0x10, SAME_Y = 0x20;
  const flags: number[] = [], xc: number[] = [], yc: number[] = [];
  let px = 0, py = 0;
  for (let i = 0; i < nPoints; i++) {
    let fb = on[i] ? 0x01 : 0x00;
    if (i === 0 && overlap) fb |= 0x40;
    const dx = xs[i] - px, dy = ys[i] - py;
    px = xs[i]; py = ys[i];
    if (dx === 0) fb |= SAME_X;
    else if (dx >= -255 && dx <= 255) { fb |= SHORT_X; if (dx > 0) fb |= SAME_X; xc.push(Math.abs(dx)); }
    else xc.push((dx >> 8) & 0xff, dx & 0xff);
    if (dy === 0) fb |= SAME_Y;
    else if (dy >= -255 && dy <= 255) { fb |= SHORT_Y; if (dy > 0) fb |= SAME_Y; yc.push(Math.abs(dy)); }
    else yc.push((dy >> 8) & 0xff, dy & 0xff);
    flags.push(fb);
  }

  const flagBytes: number[] = [];
  for (let i = 0; i < flags.length;) {
    const f = flags[i];
    let run = 1;
    while (i + run < flags.length && flags[i + run] === f && run < 256) run++;
    if (run > 1) flagBytes.push(f | REPEAT, run - 1);
    else flagBytes.push(f);
    i += run;
  }

  return concat([head, Uint8Array.from(flagBytes), Uint8Array.from(xc), Uint8Array.from(yc)]);
}

function reconstructComposite(
  compositeStream: Reader, glyphStream: Reader, instructionStream: Reader,
  bboxValues: Reader, gi: number, hasBbox: (i: number) => boolean,
): Uint8Array {
  if (!hasBbox(gi)) throw new PdfParseError('WOFF2 composite glyph missing bbox', compositeStream.pos);
  const xMin = bboxValues.i16(), yMin = bboxValues.i16(), xMax = bboxValues.i16(), yMax = bboxValues.i16();

  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
    X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080, WE_HAVE_INSTR = 0x0100;
  const comps: Uint8Array[] = [];
  let haveInstructions = false;
  for (;;) {
    const start = compositeStream.pos;
    const flags = compositeStream.u16();
    compositeStream.u16();                       // glyphIndex
    if (flags & WE_HAVE_INSTR) haveInstructions = true;
    compositeStream.pos += (flags & ARG_WORDS) ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) compositeStream.pos += 2;
    else if (flags & X_AND_Y_SCALE) compositeStream.pos += 4;
    else if (flags & TWO_BY_TWO) compositeStream.pos += 8;
    comps.push(compositeStream.bytes.subarray(start, compositeStream.pos));
    if (!(flags & MORE)) break;
  }

  const head = new Uint8Array(10);
  const dv = new DataView(head.buffer);
  dv.setInt16(0, -1);
  dv.setInt16(2, xMin); dv.setInt16(4, yMin); dv.setInt16(6, xMax); dv.setInt16(8, yMax);
  const parts = [head, ...comps];
  if (haveInstructions) {
    const instrLen = read255UShort(glyphStream);
    const instr: number[] = [];
    for (let k = 0; k < instrLen; k++) instr.push(instructionStream.u8());
    parts.push(u16be(instrLen), Uint8Array.from(instr));
  }
  return concat(parts);
}

function decodeWoff2(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  r.u32();                       // signature
  const flavor = r.u32();
  r.u32();                       // length
  const numTables = r.u16();
  r.u16();                       // reserved
  r.u32();                       // totalSfntSize
  const totalCompressedSize = r.u32();
  r.u16(); r.u16();              // major/minor version
  r.u32(); r.u32(); r.u32();     // meta offset/length/origLength
  r.u32(); r.u32();              // priv offset/length

  const dir: Woff2Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x3;
    const tag = tagIndex === 0x3f ? r.tag() : KNOWN_TAGS[tagIndex];
    if (!tag) throw new PdfParseError('WOFF2 unknown table tag index', r.pos);
    const origLength = readUIntBase128(r);
    const isGlyfLoca = tag === 'glyf' || tag === 'loca';
    const transformed = isGlyfLoca ? transformVersion === 0 : transformVersion !== 0;
    const transformLength = transformed ? readUIntBase128(r) : origLength;
    dir.push({ tag, transformVersion, origLength, transformLength, transformed });
  }

  const compStart = r.pos;
  if (compStart + totalCompressedSize > bytes.length) throw new PdfParseError('WOFF2 compressed block out of bounds', compStart);
  let stream: Uint8Array;
  try { stream = new Uint8Array(brotliDecompressSync(Buffer.from(bytes.subarray(compStart, compStart + totalCompressedSize)))); }
  catch { throw new PdfParseError('WOFF2 brotli decompress failed', compStart); }

  const raw = new Map<string, Uint8Array>();
  let off = 0;
  for (const e of dir) {
    const len = e.transformed ? e.transformLength : e.origLength;
    if (off + len > stream.length) throw new PdfParseError('WOFF2 decompressed stream underrun', off);
    raw.set(e.tag, stream.subarray(off, off + len));
    off += len;
  }

  const out: { tag: string; data: Uint8Array }[] = [];
  const glyfEntry = dir.find((e) => e.tag === 'glyf');
  let reconIndexFormat: number | undefined;
  if (glyfEntry && glyfEntry.transformed) {
    const { glyf, loca, indexFormat } = reconstructGlyf(raw.get('glyf')!);
    reconIndexFormat = indexFormat;
    out.push({ tag: 'glyf', data: glyf }, { tag: 'loca', data: loca });
  }
  for (const e of dir) {
    if (e.tag === 'glyf' || e.tag === 'loca') {
      if (e.transformed) continue;               // reconstructed above (transformed) ...
      out.push({ tag: e.tag, data: raw.get(e.tag)! }); // ... or verbatim (null transform)
      continue;
    }
    if (e.tag === 'hmtx' && e.transformed) continue; // reconstructed below
    if (e.transformed) throw new UnsupportedFeatureError(`WOFF2 transform for '${e.tag}' not supported`);
    out.push({ tag: e.tag, data: raw.get(e.tag)! });
  }
  if (reconIndexFormat !== undefined) {
    const head = out.find((t) => t.tag === 'head');
    if (head) new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength).setInt16(50, reconIndexFormat);
  }

  const hmtxEntry = dir.find((e) => e.tag === 'hmtx');
  if (hmtxEntry && hmtxEntry.transformed) {
    if (hmtxEntry.transformVersion !== 1) throw new UnsupportedFeatureError(`WOFF2 hmtx transform version ${hmtxEntry.transformVersion} not supported`);
    const hhea = out.find((t) => t.tag === 'hhea')?.data ?? raw.get('hhea');
    const maxp = out.find((t) => t.tag === 'maxp')?.data ?? raw.get('maxp');
    if (!hhea || !maxp) throw new PdfParseError('WOFF2 hmtx transform without hhea/maxp', 0);
    const numHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
    const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);
    const glyfTable = out.find((t) => t.tag === 'glyf')?.data;
    const locaTable = out.find((t) => t.tag === 'loca')?.data;
    const headTable = out.find((t) => t.tag === 'head')?.data;
    const idxFmt = reconIndexFormat ?? (headTable ? new DataView(headTable.buffer, headTable.byteOffset, headTable.byteLength).getInt16(50) : 0);
    const xMins: number[] = [];
    if (glyfTable && locaTable) {
      const lv = new DataView(locaTable.buffer, locaTable.byteOffset, locaTable.byteLength);
      for (let i = 0; i < numGlyphs; i++) {
        const a = idxFmt === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4);
        const b = idxFmt === 0 ? lv.getUint16((i + 1) * 2) * 2 : lv.getUint32((i + 1) * 4);
        xMins.push(b - a >= 10 ? new DataView(glyfTable.buffer, glyfTable.byteOffset + a, 10).getInt16(2) : 0);
      }
    }
    out.push({ tag: 'hmtx', data: reconstructHmtx(raw.get('hmtx')!, numGlyphs, numHMetrics, xMins) });
  }

  return writeSfnt(flavor, out);
}
