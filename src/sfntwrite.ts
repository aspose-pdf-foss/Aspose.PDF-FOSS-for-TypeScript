import { PdfParseError } from './errors.js';

function pad4(len: number): number { return (4 - (len & 3)) & 3; }

/** Big-endian uint32 sum over `data` padded to a 4-byte boundary (sfnt checksum). */
function tableChecksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const b0 = data[i] ?? 0, b1 = data[i + 1] ?? 0, b2 = data[i + 2] ?? 0, b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Assemble an sfnt: offset table + directory (tags ascending) + padded bodies,
 *  with per-table checksums and a correct `head.checksumAdjustment`. */
export function assembleSfnt(flavor: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset;
    offset += t.data.length + pad4(t.data.length);
    return { tag: t.tag, at, len: t.data.length, data: t.data };
  });
  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  let entrySelector = 0;
  while ((1 << (entrySelector + 1)) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  dv.setUint32(0, flavor >>> 0);
  dv.setUint16(4, numTables);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, numTables * 16 - searchRange);
  let p = 12;
  let headOffset = -1;
  for (const pl of placed) {
    for (let k = 0; k < 4; k++) out[p + k] = pl.tag.charCodeAt(k);
    dv.setUint32(p + 4, tableChecksum(pl.data));
    dv.setUint32(p + 8, pl.at);
    dv.setUint32(p + 12, pl.len);
    out.set(pl.data, pl.at);
    if (pl.tag === 'head') headOffset = pl.at;
    p += 16;
  }
  // head.checksumAdjustment = 0xB1B0AFBA - checksum(whole font with adjustment=0)
  if (headOffset >= 0) {
    dv.setUint32(headOffset + 8, 0);                    // zero the field first
    const whole = tableChecksum(out);
    dv.setUint32(headOffset + 8, (0xb1b0afba - whole) >>> 0);
  }
  return out;
}

/** Parse an sfnt directory into a tag→bytes map. */
function readTables(sfnt: Uint8Array): Map<string, Uint8Array> {
  if (sfnt.length < 12) throw new PdfParseError('sfnt too short');
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = dv.getUint16(4);
  const out = new Map<string, Uint8Array>();
  let p = 12;
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(sfnt[p], sfnt[p + 1], sfnt[p + 2], sfnt[p + 3]);
    const off = dv.getUint32(p + 8);
    const len = dv.getUint32(p + 12);
    if (off + len > sfnt.length) throw new PdfParseError(`'${tag}' table out of bounds`);
    out.set(tag, sfnt.subarray(off, off + len));
    p += 16;
  }
  return out;
}

/** Return the sfnt with table `tag` replaced (or inserted), re-assembled. */
export function replaceTable(sfnt: Uint8Array, tag: string, data: Uint8Array): Uint8Array {
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const flavor = dv.getUint32(0);
  const tables = readTables(sfnt);
  tables.set(tag, data);
  return assembleSfnt(flavor, [...tables].map(([t, d]) => ({ tag: t, data: d })));
}

/** Build a `cmap` table. A (3,1) format-4 subtable covers BMP keys; a (3,10)
 *  format-12 subtable is added when any key exceeds 0xFFFF. */
export function buildCmap(map: Map<number, number>): Uint8Array {
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const bmp = entries.filter(([cp]) => cp <= 0xffff);
  const hasAstral = entries.some(([cp]) => cp > 0xffff);
  const sub4 = buildFormat4(bmp);
  const subs: { plat: number; enc: number; data: Uint8Array }[] = [{ plat: 3, enc: 1, data: sub4 }];
  if (hasAstral) subs.push({ plat: 3, enc: 10, data: buildFormat12(entries) });
  // cmap header: version(0) numTables, then a record per subtable, then bodies.
  const headerLen = 4 + subs.length * 8;
  let off = headerLen;
  const placedSubs = subs.map((s) => { const at = off; off += s.data.length; return { ...s, at }; });
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0);
  dv.setUint16(2, subs.length);
  let p = 4;
  for (const s of placedSubs) {
    dv.setUint16(p, s.plat); dv.setUint16(p + 2, s.enc); dv.setUint32(p + 4, s.at);
    out.set(s.data, s.at);
    p += 8;
  }
  return out;
}

/** cmap format 4 over BMP (cp,gid) pairs. Contiguous runs become segments with
 *  idDelta; a required 0xFFFF→0 terminator segment closes the table. */
function buildFormat4(pairs: [number, number][]): Uint8Array {
  // Group into contiguous cp runs where gid also increments by 1.
  const segs: { start: number; end: number; delta: number }[] = [];
  for (let i = 0; i < pairs.length; ) {
    const [c0, g0] = pairs[i];
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[j][0] + 1 && pairs[j + 1][1] === pairs[j][1] + 1) j++;
    segs.push({ start: c0, end: pairs[j][0], delta: (g0 - c0) & 0xffff });
    i = j + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });   // terminator: 0xFFFF -> 0
  const segCount = segs.length;
  const segX2 = segCount * 2;
  let sel = 0; while ((1 << (sel + 1)) <= segCount) sel++;
  const searchRange = 2 * (1 << sel);
  const len = 16 + segCount * 8;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 4);
  dv.setUint16(2, len);
  dv.setUint16(4, 0);                                    // language
  dv.setUint16(6, segX2);
  dv.setUint16(8, searchRange);
  dv.setUint16(10, sel);
  dv.setUint16(12, segX2 - searchRange);
  let p = 14;
  for (const s of segs) { dv.setUint16(p, s.end); p += 2; }
  dv.setUint16(p, 0); p += 2;                            // reservedPad
  for (const s of segs) { dv.setUint16(p, s.start); p += 2; }
  for (const s of segs) { dv.setUint16(p, s.delta); p += 2; }
  for (let i = 0; i < segCount; i++) { dv.setUint16(p, 0); p += 2; } // idRangeOffset all 0
  return out;
}

export interface OtfMetrics {
  numGlyphs: number; unitsPerEm: number; advances: number[];
  bbox: [number, number, number, number]; ascent: number; descent: number;
  /** PostScript name for the synthesized `name` table. Default 'Embedded',
   *  which is right for htmlfontembed.ts, where the name is never read. */
  psName?: string;
}

function u16(v: DataView, o: number, n: number): void { v.setUint16(o, n & 0xffff); }
function i16(v: DataView, o: number, n: number): void { v.setInt16(o, n | 0); }

function buildHead(m: OtfMetrics): Uint8Array {
  const b = new Uint8Array(54); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);                 // version 1.0
  v.setUint32(4, 0x00010000);                 // fontRevision
  v.setUint32(12, 0x5f0f3cf5);                // magicNumber
  u16(v, 16, 0x000b);                         // flags
  u16(v, 18, m.unitsPerEm);
  i16(v, 36, m.bbox[0]); i16(v, 38, m.bbox[1]); i16(v, 40, m.bbox[2]); i16(v, 42, m.bbox[3]);
  i16(v, 48, 2);                              // fontDirectionHint
  i16(v, 50, 0);                              // indexToLocFormat (CFF: 0)
  i16(v, 52, 0);                              // glyphDataFormat
  return b;
}

function buildHhea(m: OtfMetrics, numHMetrics: number): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);
  i16(v, 4, m.ascent); i16(v, 6, m.descent); i16(v, 8, 0);   // ascender/descender/lineGap
  u16(v, 10, m.unitsPerEm);                                   // advanceWidthMax (approx)
  u16(v, 34, numHMetrics);
  return b;
}

function buildHmtx(m: OtfMetrics): Uint8Array {
  const def = Math.round(m.unitsPerEm / 2);
  const b = new Uint8Array(m.numGlyphs * 4); const v = new DataView(b.buffer);
  for (let g = 0; g < m.numGlyphs; g++) {
    const adv = m.advances[g];
    u16(v, g * 4, Math.max(0, Math.round(adv === undefined || adv <= 0 ? def : adv)));
    i16(v, g * 4 + 2, 0);
  }
  return b;
}

function buildMaxpCff(numGlyphs: number): Uint8Array {
  const b = new Uint8Array(6); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00005000);                 // version 0.5 (CFF)
  u16(v, 4, numGlyphs);
  return b;
}

function buildOS2(m: OtfMetrics): Uint8Array {
  const b = new Uint8Array(96); const v = new DataView(b.buffer);
  u16(v, 0, 4);                               // version 4
  i16(v, 2, Math.round(m.unitsPerEm / 2));    // xAvgCharWidth (approx)
  u16(v, 4, 400);                             // usWeightClass
  u16(v, 6, 5);                               // usWidthClass
  u16(v, 8, 0);                               // fsType = 0 (installable)
  b[32] = 0x20; b[33] = 0x20; b[34] = 0x20; b[35] = 0x20; // achVendID (spaces)
  i16(v, 68, m.ascent); i16(v, 70, -Math.abs(m.descent)); // sTypoAscender/Descender
  i16(v, 72, 0);                              // sTypoLineGap
  u16(v, 74, m.ascent); u16(v, 76, Math.abs(m.descent)); // usWinAscent/Descent
  i16(v, 88, m.ascent);                       // sxHeight (approx)
  i16(v, 90, m.ascent);                       // sCapHeight (approx)
  return b;
}

function buildName(str = 'Embedded'): Uint8Array {
  // Minimal name table: family=1, subfamily=2, full=4, ps=6, Windows/Unicode.
  const utf16 = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) utf16[i * 2 + 1] = str.charCodeAt(i);
  const ids = [1, 2, 4, 6];
  const count = ids.length;
  const headerLen = 6 + count * 12;
  const b = new Uint8Array(headerLen + utf16.length);
  const v = new DataView(b.buffer);
  u16(v, 0, 0);                               // format
  u16(v, 2, count);
  u16(v, 4, headerLen);                       // stringOffset
  let p = 6;
  for (const id of ids) {
    u16(v, p, 3); u16(v, p + 2, 1); u16(v, p + 4, 0x409); u16(v, p + 6, id);
    u16(v, p + 8, utf16.length); u16(v, p + 10, 0);
    p += 12;
  }
  b.set(utf16, headerLen);
  return b;
}

function buildPostV3(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00030000);                 // version 3.0 (no glyph names)
  return b;
}

/** Wrap a bare CFF program into an OTTO sfnt with synthesized required tables. */
export function otfFromCff(cff: Uint8Array, cmap: Uint8Array, m: OtfMetrics): Uint8Array {
  const numHMetrics = m.numGlyphs;
  const tables = [
    { tag: 'CFF ', data: cff },
    { tag: 'OS/2', data: buildOS2(m) },
    { tag: 'cmap', data: cmap },
    { tag: 'head', data: buildHead(m) },
    { tag: 'hhea', data: buildHhea(m, numHMetrics) },
    { tag: 'hmtx', data: buildHmtx(m) },
    { tag: 'maxp', data: buildMaxpCff(m.numGlyphs) },
    { tag: 'name', data: buildName(m.psName) },
    { tag: 'post', data: buildPostV3() },
  ];
  return assembleSfnt(0x4f54544f, tables);    // 'OTTO'
}

/** cmap format 12 over all (cp,gid) pairs as contiguous groups. */
function buildFormat12(pairs: [number, number][]): Uint8Array {
  const groups: { start: number; end: number; gid: number }[] = [];
  for (let i = 0; i < pairs.length; ) {
    const [c0, g0] = pairs[i];
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[j][0] + 1 && pairs[j + 1][1] === pairs[j][1] + 1) j++;
    groups.push({ start: c0, end: pairs[j][0], gid: g0 });
    i = j + 1;
  }
  const len = 16 + groups.length * 12;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 12);
  dv.setUint32(4, len);
  dv.setUint32(12, groups.length);
  let p = 16;
  for (const g of groups) { dv.setUint32(p, g.start); dv.setUint32(p + 4, g.end); dv.setUint32(p + 8, g.gid); p += 12; }
  return out;
}
