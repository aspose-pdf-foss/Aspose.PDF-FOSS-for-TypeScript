import { deflateSync, brotliCompressSync } from 'node:zlib';

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function tagBytes(t: string): Uint8Array { return Uint8Array.from([t.charCodeAt(0), t.charCodeAt(1), t.charCodeAt(2), t.charCodeAt(3)]); }
function pad4(b: Uint8Array): Uint8Array { const r = b.length & 3; return r === 0 ? b : concat([b, new Uint8Array(4 - r)]); }

/** Parse an sfnt into its version + table list (tag/data), data unpadded. */
export function parseSfntTables(sfnt: Uint8Array): { version: number; tables: { tag: string; data: Uint8Array }[] } {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const version = v.getUint32(0);
  const numTables = v.getUint16(4);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...sfnt.subarray(rec, rec + 4));
    const off = v.getUint32(rec + 8);
    const len = v.getUint32(rec + 12);
    tables.push({ tag, data: sfnt.subarray(off, off + len) });
  }
  return { version, tables };
}

/** Wrap an sfnt as WOFF (v1): each table zlib-deflated, or stored if that is
 *  not smaller. */
export function wrapWoff1(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const headerSize = 44;
  const dirSize = tables.length * 20;
  let offset = headerSize + dirSize;
  const dirRecs: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    const deflated = new Uint8Array(deflateSync(Buffer.from(t.data)));
    const useComp = deflated.length < t.data.length;
    const stored = useComp ? deflated : t.data;
    const compLength = stored.length;
    dirRecs.push(concat([tagBytes(t.tag), u32(offset), u32(compLength), u32(t.data.length), u32(0)]));
    const padded = pad4(stored);
    bodies.push(padded);
    offset += padded.length;
    totalSfntSize += pad4(t.data).length;
  }
  const totalLength = offset;
  const header = concat([
    tagBytes('wOFF'), u32(version), u32(totalLength), u16(tables.length), u16(0),
    u32(totalSfntSize), u16(0), u16(0),
    u32(0), u32(0), u32(0),   // meta
    u32(0), u32(0),           // priv
  ]);
  return concat([header, ...dirRecs, ...bodies]);
}

const KNOWN_TAGS: string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

function base128(n: number): Uint8Array {
  const bytes: number[] = [];
  let v = n >>> 0;
  do { bytes.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return Uint8Array.from(bytes);
}
export function u255(n: number): Uint8Array {
  if (n < 253) return Uint8Array.from([n]);
  if (n < 253 + 256) return Uint8Array.from([255, n - 253]);
  if (n < 253 + 512) return Uint8Array.from([254, n - 506]);
  return concat([Uint8Array.from([253]), u16(n)]);
}
function u8(n: number): Uint8Array { return Uint8Array.from([n & 0xff]); }

/** Directory-entry bytes for a WOFF2 table with a given transform version and
 *  optional transformLength (present only when transformed). */
function woff2DirEntry(tag: string, transformVersion: number, origLength: number, transformLength?: number): Uint8Array {
  const idx = KNOWN_TAGS.indexOf(tag);
  const known = idx >= 0 && idx < 0x3f;
  const flags = ((transformVersion & 0x3) << 6) | (known ? idx : 0x3f);
  const parts = [u8(flags)];
  if (!known) parts.push(tagBytes(tag));
  parts.push(base128(origLength));
  if (transformLength !== undefined) parts.push(base128(transformLength));
  return concat(parts);
}

/** Assemble a WOFF2 from directory entries + the per-table stream bodies
 *  (concatenated, unpadded) that will be brotli-compressed. */
function assembleWoff2(version: number, numTables: number, dir: Uint8Array[], streamBodies: Uint8Array[], totalSfntSize: number): Uint8Array {
  const stream = concat(streamBodies);
  const compressed = new Uint8Array(brotliCompressSync(Buffer.from(stream)));
  const dirBytes = concat(dir);
  const header = concat([
    tagBytes('wOF2'), u32(version), u32(0), u16(numTables), u16(0),
    u32(totalSfntSize), u32(compressed.length), u16(0), u16(0),
    u32(0), u32(0), u32(0), u32(0), u32(0),
  ]);
  const total = header.length + dirBytes.length + compressed.length;
  new DataView(header.buffer).setUint32(8, total); // length field
  return concat([header, dirBytes, compressed]);
}

/** Wrap an sfnt as WOFF2 with all tables null-transformed (glyf/loca verbatim,
 *  transform version 3; others version 0). */
export function wrapWoff2Null(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const dir: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    const nullVersion = (t.tag === 'glyf' || t.tag === 'loca') ? 3 : 0;
    dir.push(woff2DirEntry(t.tag, nullVersion, t.data.length));
    bodies.push(t.data);
    totalSfntSize += pad4(t.data).length;
  }
  return assembleWoff2(version, tables.length, dir, bodies, totalSfntSize);
}

function i16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }

/** Parse a standard simple glyph into raw points (design units). */
function parseSimpleGlyph(g: Uint8Array): { endPts: number[]; xs: number[]; ys: number[]; on: boolean[]; instrLen: number; instr: Uint8Array } {
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const nContours = v.getInt16(0);
  let p = 10;
  const endPts: number[] = [];
  for (let i = 0; i < nContours; i++) { endPts.push(v.getUint16(p)); p += 2; }
  const nPoints = nContours === 0 ? 0 : endPts[nContours - 1] + 1;
  const instrLen = v.getUint16(p); p += 2;
  const instr = g.subarray(p, p + instrLen); p += instrLen;
  const flags: number[] = [];
  while (flags.length < nPoints) { const f = g[p++]; flags.push(f); if (f & 0x08) { let r = g[p++]; while (r-- > 0) flags.push(f); } }
  const xs: number[] = []; let x = 0;
  for (const f of flags) { if (f & 0x02) { const dx = g[p++]; x += (f & 0x10) ? dx : -dx; } else if (!(f & 0x10)) { x += v.getInt16(p); p += 2; } xs.push(x); }
  const ys: number[] = []; let y = 0;
  for (const f of flags) { if (f & 0x04) { const dy = g[p++]; y += (f & 0x20) ? dy : -dy; } else if (!(f & 0x20)) { y += v.getInt16(p); p += 2; } ys.push(y); }
  const on = flags.map((f) => (f & 0x01) !== 0);
  return { endPts, xs, ys, on, instrLen, instr };
}

/** Byte length of one composite component record (mirrors sfnt.ts). */
function componentLen(g: Uint8Array, at: number): { len: number; more: boolean; instr: boolean } {
  const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020, X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080, WE_HAVE_INSTR = 0x0100;
  const flags = v.getUint16(at);
  let n = 4;
  n += (flags & ARG_WORDS) ? 4 : 2;
  if (flags & WE_HAVE_A_SCALE) n += 2;
  else if (flags & X_AND_Y_SCALE) n += 4;
  else if (flags & TWO_BY_TWO) n += 8;
  return { len: n, more: (flags & MORE) !== 0, instr: (flags & WE_HAVE_INSTR) !== 0 };
}

/** Encode a standard glyf+loca into a transformed WOFF2 glyf sub-stream
 *  (always-4-byte triplets; bbox bit set for every non-empty glyph). */
export function encodeTransformedGlyf(glyf: Uint8Array, loca: number[], numGlyphs: number, indexFormat: number): Uint8Array {
  const nContour: Uint8Array[] = [], nPoints: Uint8Array[] = [], flagS: Uint8Array[] = [];
  const glyphS: Uint8Array[] = [], compS: Uint8Array[] = [], instrS: Uint8Array[] = [];
  const bboxVals: Uint8Array[] = [];
  const bitmap = new Uint8Array(Math.ceil(numGlyphs / 8));

  for (let gid = 0; gid < numGlyphs; gid++) {
    const g = glyf.subarray(loca[gid], loca[gid + 1]);
    if (g.length < 10) { nContour.push(i16(0)); continue; } // empty
    const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const nc = v.getInt16(0);
    nContour.push(i16(nc));
    const setBbox = () => { bitmap[gid >> 3] |= 0x80 >> (gid & 7); bboxVals.push(g.subarray(2, 10)); };
    if (nc > 0) {
      const s = parseSimpleGlyph(g);
      for (let c = 0; c < nc; c++) { const start = c === 0 ? 0 : s.endPts[c - 1] + 1; nPoints.push(u255(s.endPts[c] - start + 1)); }
      let px = 0, py = 0;
      for (let i = 0; i < s.xs.length; i++) {
        const dx = s.xs[i] - px, dy = s.ys[i] - py; px = s.xs[i]; py = s.ys[i];
        let flag = 124 | (dx >= 0 ? 1 : 0) | (dy >= 0 ? 2 : 0);
        if (!s.on[i]) flag |= 0x80;
        flagS.push(Uint8Array.from([flag]));
        glyphS.push(u16(Math.abs(dx)), u16(Math.abs(dy)));
      }
      glyphS.push(u255(s.instrLen));
      if (s.instrLen) instrS.push(s.instr);
      setBbox();
    } else {
      // composite: copy component records verbatim, gather instructions.
      let at = 10, haveInstr = false;
      for (;;) { const c = componentLen(g, at); compS.push(g.subarray(at, at + c.len)); haveInstr = haveInstr || c.instr; at += c.len; if (!c.more) break; }
      if (haveInstr) {
        const iv = new DataView(g.buffer, g.byteOffset, g.byteLength);
        const instrLen = iv.getUint16(at);
        glyphS.push(u255(instrLen));
        instrS.push(g.subarray(at + 2, at + 2 + instrLen));
      }
      setBbox();
    }
  }

  const nContourB = concat(nContour), nPointsB = concat(nPoints), flagB = concat(flagS);
  const glyphB = concat(glyphS), compB = concat(compS), instrB = concat(instrS);
  const bboxB = concat([bitmap, ...bboxVals]);
  const header = new Uint8Array(36);
  const hv = new DataView(header.buffer);
  hv.setUint16(4, numGlyphs);
  hv.setUint16(6, indexFormat);
  hv.setUint32(8, nContourB.length);
  hv.setUint32(12, nPointsB.length);
  hv.setUint32(16, flagB.length);
  hv.setUint32(20, glyphB.length);
  hv.setUint32(24, compB.length);
  hv.setUint32(28, bboxB.length);
  hv.setUint32(32, instrB.length);
  return concat([header, nContourB, nPointsB, flagB, glyphB, compB, bboxB, instrB]);
}

/** Wrap an sfnt as WOFF2 with glyf/loca transformed (version 0). */
export function wrapWoff2Transformed(sfnt: Uint8Array): Uint8Array {
  const { version, tables } = parseSfntTables(sfnt);
  const head = tables.find((t) => t.tag === 'head')!;
  const maxp = tables.find((t) => t.tag === 'maxp')!;
  const numGlyphs = new DataView(maxp.data.buffer, maxp.data.byteOffset, maxp.data.byteLength).getUint16(4);
  const indexFormat = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength).getInt16(50);
  const glyfT = tables.find((t) => t.tag === 'glyf');
  const locaT = tables.find((t) => t.tag === 'loca');

  let transformedGlyf: Uint8Array | undefined;
  if (glyfT && locaT) {
    const lv = new DataView(locaT.data.buffer, locaT.data.byteOffset, locaT.data.byteLength);
    const loca: number[] = [];
    for (let i = 0; i <= numGlyphs; i++) loca.push(indexFormat === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4));
    transformedGlyf = encodeTransformedGlyf(glyfT.data, loca, numGlyphs, indexFormat);
  }

  const dir: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  let totalSfntSize = 12 + tables.length * 16;
  for (const t of tables) {
    if (t.tag === 'glyf' && transformedGlyf) {
      dir.push(woff2DirEntry('glyf', 0, t.data.length, transformedGlyf.length));
      bodies.push(transformedGlyf);
    } else if (t.tag === 'loca' && transformedGlyf) {
      dir.push(woff2DirEntry('loca', 0, t.data.length, 0)); // reconstructed → 0 bytes
      // no body
    } else {
      dir.push(woff2DirEntry(t.tag, 0, t.data.length));
      bodies.push(t.data);
    }
    totalSfntSize += pad4(t.data).length;
  }
  return assembleWoff2(version, tables.length, dir, bodies, totalSfntSize);
}
