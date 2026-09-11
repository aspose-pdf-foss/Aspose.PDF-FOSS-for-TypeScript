// Builds a minimal valid TrueType (glyf) sfnt for parser tests.
// Glyphs: 0=.notdef (empty), 1='A' (simple), 2='B' (composite -> 1).

function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function i16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function pad4(b: Uint8Array): Uint8Array {
  const r = b.length % 4; if (r === 0) return b;
  return concat([b, new Uint8Array(4 - r)]);
}

export function buildHead(unitsPerEm = 1000): Uint8Array {
  const b = new Uint8Array(54); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setUint32(12, 0x5F0F3CF5);  // magicNumber
  v.setUint16(18, unitsPerEm);
  v.setInt16(36, 0); v.setInt16(38, -200); v.setInt16(40, 700); v.setInt16(42, 800); // bbox
  v.setInt16(50, 0);            // indexToLocFormat = 0 (short)
  return b;
}
export function buildMaxp(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setUint16(4, 3);            // numGlyphs
  return b;
}
export function buildHhea(): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setInt16(4, 800); v.setInt16(6, -200); // ascender/descender
  v.setUint16(34, 3);           // numberOfHMetrics
  return b;
}
export function buildHmtx(): Uint8Array {
  // 3 longHorMetrics: (advanceWidth u16, lsb i16)
  return concat([u16(500), i16(0), u16(600), i16(0), u16(700), i16(0)]);
}
export function buildCmap(): Uint8Array {
  // format 4 mapping 0x41->1, 0x42->2 (+ required 0xFFFF terminator segment)
  const idDelta0 = (1 - 0x41) & 0xffff; // -64 -> 65472; 0x41+(-64)=1, 0x42+(-64)=2
  const sub = concat([
    u16(4), u16(32), u16(0),          // format, length, language
    u16(4), u16(4), u16(1), u16(0),   // segCountX2, searchRange, entrySelector, rangeShift
    u16(0x42), u16(0xFFFF),           // endCode[2]
    u16(0),                            // reservedPad
    u16(0x41), u16(0xFFFF),           // startCode[2]
    u16(idDelta0), u16(1),            // idDelta[2]
    u16(0), u16(0),                   // idRangeOffset[2]
  ]);
  const header = concat([u16(0), u16(1), u16(3), u16(1), u32(12)]); // version, numTables, (plat3,enc1,offset12)
  return concat([header, sub]);
}
/** A cmap table wrapping `subs`, each placed in directory order. */
export function buildCmapTable(subs: { plat: number; enc: number; data: Uint8Array }[]): Uint8Array {
  let off = 4 + subs.length * 8;
  const records: Uint8Array[] = [];
  for (const s of subs) { records.push(concat([u16(s.plat), u16(s.enc), u32(off)])); off += s.data.length; }
  return concat([u16(0), u16(subs.length), ...records, ...subs.map((s) => s.data)]);
}

/** Format 0 subtable: a 256-entry byte array (the Mac (1,0) shape). */
export function cmapFormat0(map: Record<number, number>): Uint8Array {
  const gids = new Uint8Array(256);
  for (const [code, gid] of Object.entries(map)) gids[Number(code)] = gid;
  return concat([u16(0), u16(262), u16(0), gids]);
}

/** Format 4 subtable, one segment per entry (+ the required 0xFFFF terminator). */
export function cmapFormat4(entries: [number, number][]): Uint8Array {
  const segs = [...entries].sort((a, b) => a[0] - b[0]).map(([code, gid]) => ({ code, gid }));
  segs.push({ code: 0xffff, gid: 1 });   // terminator: idDelta 1 maps 0xffff -> 0
  const n = segs.length;
  return concat([
    u16(4), u16(16 + n * 8), u16(0),
    u16(n * 2), u16(0), u16(0), u16(0),                       // segCountX2 + (ignored) search hints
    ...segs.map((s) => u16(s.code)), u16(0),                  // endCode[], reservedPad
    ...segs.map((s) => u16(s.code)),                          // startCode[]
    ...segs.map((s) => u16((s.gid - s.code) & 0xffff)),       // idDelta[]
    ...segs.map(() => u16(0)),                                // idRangeOffset[]
  ]);
}

/** Format 6 subtable: a contiguous `gids` run starting at `first`. */
export function cmapFormat6(first: number, gids: number[]): Uint8Array {
  return concat([u16(6), u16(10 + gids.length * 2), u16(0), u16(first), u16(gids.length), ...gids.map(u16)]);
}

/** A `post` v2.0 table naming each glyph. Names are emitted as custom Pascal
 *  strings (index >= 258) rather than Macintosh standard indices. `header` sets
 *  the fields a v3.0 downgrade must carry over; all default to 0. */
export function buildPostV2(
  names: string[],
  header: { italicAngle?: number; underlinePosition?: number; isFixedPitch?: number } = {},
): Uint8Array {
  const strings = names.map((s) => concat([Uint8Array.from([s.length]), new TextEncoder().encode(s)]));
  const h = new Uint8Array(32);
  const v = new DataView(h.buffer);
  v.setUint32(0, 0x00020000);                    // version 2.0
  v.setInt32(4, header.italicAngle ?? 0);        // 16.16 fixed
  v.setInt16(8, header.underlinePosition ?? 0);
  v.setUint32(12, header.isFixedPitch ?? 0);
  return concat([h, u16(names.length), ...names.map((_, i) => u16(258 + i)), ...strings]);
}

function buildGlyf(): { glyf: Uint8Array; loca: Uint8Array } {
  const g0 = new Uint8Array(0); // .notdef empty
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]); // simple: numContours=1 + bbox (10 bytes)
  const flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
  const g2 = concat([i16(-1), i16(0), i16(0), i16(0x100), i16(0x100), u16(flags), u16(1), i16(0), i16(0)]); // composite -> gid 1 (18 bytes)
  const glyf = concat([g0, g1, g2]);
  const offs = [0, g0.length, g0.length + g1.length, g0.length + g1.length + g2.length]; // 0,0,10,28
  const loca = concat(offs.map((o) => u16(o / 2))); // short loca: offset/2 -> [0,0,5,14]
  return { glyf, loca };
}
export function buildName(): Uint8Array {
  const psName = new TextEncoder().encode('TestFont'); // platform 1 ASCII
  const header = concat([u16(0), u16(1), u16(6 + 12)]); // format, count, stringOffset
  const record = concat([u16(1), u16(0), u16(0), u16(6), u16(psName.length), u16(0)]); // plat1,enc0,lang0,nameID6,len,off
  return concat([header, record, psName]);
}
export function buildOS2(): Uint8Array {
  const b = new Uint8Array(96); const v = new DataView(b.buffer);
  v.setUint16(0, 4);            // version
  v.setUint16(4, 400);         // usWeightClass
  v.setUint16(62, 0x40);       // fsSelection: REGULAR
  v.setInt16(68, 800);         // sTypoAscender
  v.setInt16(70, -200);        // sTypoDescender
  v.setInt16(88, 700);         // sCapHeight
  return b;
}
export function buildPost(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00030000);   // version 3.0 (no glyph names)
  v.setInt32(4, 0);             // italicAngle (16.16) = 0
  return b;
}

export function buildMinimalTtf(
  over: { cmap?: Uint8Array; post?: Uint8Array; head?: Uint8Array } = {},
): Uint8Array {
  const { glyf, loca } = buildGlyf();
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: over.cmap ?? buildCmap() },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: over.head ?? buildHead() },
    { tag: 'hhea', data: buildHhea() },
    { tag: 'hmtx', data: buildHmtx() },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: over.post ?? buildPost() },
  ];
  const numTables = tables.length;
  const dirSize = 12 + numTables * 16;
  // Lay out table bodies 4-byte aligned after the directory.
  let offset = dirSize;
  const placed = tables.map((t) => {
    const at = offset; const padded = pad4(t.data); offset += padded.length;
    return { tag: t.tag, at, length: t.data.length, padded };
  });
  // Offset table (searchRange etc. are ignored by the parser; computed for realism).
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = (1 << entrySelector) * 16;
  const offsetTable = concat([
    u32(0x00010000), u16(numTables), u16(searchRange), u16(entrySelector),
    u16(numTables * 16 - searchRange),
  ]);
  const dir = concat(placed.map((p) =>
    concat([new TextEncoder().encode(p.tag), u32(0) /*checksum ignored*/, u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** Rebuild a font's offset table + directory with `tag` removed (body dropped)
 *  to simulate a missing required table. */
export function stripTable(ttf: Uint8Array, tag: string): Uint8Array {
  const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const numTables = v.getUint16(4);
  const keep: { tag: string; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = String.fromCharCode(...ttf.subarray(rec, rec + 4));
    if (t === tag) continue;
    keep.push({ tag: t, offset: v.getUint32(rec + 8), length: v.getUint32(rec + 12) });
  }
  const dirSize = 12 + keep.length * 16;
  let offset = dirSize;
  const bodies: Uint8Array[] = [];
  const dirParts: Uint8Array[] = [];
  for (const k of keep) {
    const body = pad4(ttf.subarray(k.offset, k.offset + k.length));
    dirParts.push(concat([new TextEncoder().encode(k.tag), u32(0), u32(offset), u32(k.length)]));
    bodies.push(body); offset += body.length;
  }
  const offsetTable = concat([u32(v.getUint32(0)), u16(keep.length), u16(0), u16(0), u16(0)]);
  return concat([offsetTable, ...dirParts, ...bodies]);
}

function buildMaxp4(): Uint8Array {
  const b = new Uint8Array(32); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, 4); // numGlyphs = 4
  return b;
}
function buildHhea4(): Uint8Array {
  const b = new Uint8Array(36); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200);
  v.setUint16(34, 4); // numberOfHMetrics = 4
  return b;
}
function buildHmtx4(): Uint8Array {
  return concat([u16(500), i16(0), u16(600), i16(0), u16(700), i16(0), u16(800), i16(0)]);
}
function buildClosureGlyf(): { glyf: Uint8Array; loca: Uint8Array } {
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);  // simple (10)
  const g2 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);  // simple (10)
  const flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
  const g3 = concat([i16(-1), i16(0), i16(0), i16(0x100), i16(0x100), u16(flags), u16(2), i16(0), i16(0)]); // composite -> gid 2 (18)
  const glyf = concat([g0, g1, g2, g3]);
  const offs = [0, 0, 10, 20, 38];
  const loca = concat(offs.map((o) => u16(o / 2)));
  return { glyf, loca };
}
/** A 4-glyph TrueType font exercising subsetting: 0 .notdef, 1 simple (droppable),
 *  2 simple, 3 composite -> gid 2. Advances 500/600/700/800. */
export function buildClosureTtf(): Uint8Array {
  const { glyf, loca } = buildClosureGlyf();
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea4() },
    { tag: 'hmtx', data: buildHmtx4() },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp4() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  const dirSize = 12 + numTables * 16;
  let offset = dirSize;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** A cmap (format 4) mapping arbitrary single code points to gids, sorted by
 *  code point, plus the required 0xFFFF terminator segment. */
function buildCmapFor(mappings: [number, number][]): Uint8Array {
  const sorted = [...mappings].sort((a, b) => a[0] - b[0]);
  const segs = [...sorted.map(([cp, gid]) => ({ start: cp, end: cp, delta: (gid - cp) & 0xffff })),
    { start: 0xffff, end: 0xffff, delta: 1 }];
  const segCount = segs.length;
  const sub = concat([
    u16(4), u16(16 + segCount * 8), u16(0),                 // format, length, language
    u16(segCount * 2), u16(0), u16(0), u16(0),              // segCountX2, searchRange, entrySelector, rangeShift
    ...segs.map((s) => u16(s.end)),                          // endCode[]
    u16(0),                                                  // reservedPad
    ...segs.map((s) => u16(s.start)),                        // startCode[]
    ...segs.map((s) => u16(s.delta)),                        // idDelta[]
    ...segs.map(() => u16(0)),                               // idRangeOffset[] (all 0)
  ]);
  const header = concat([u16(0), u16(1), u16(3), u16(1), u32(12)]); // version, numTables, (plat3,enc1,offset12)
  return concat([header, sub]);
}

/** A 3-glyph TrueType font (0 .notdef, 1 simple, 2 simple) whose cmap maps
 *  'A' (U+0041) -> gid 1 and '中' (U+4E2D, not WinAnsi-encodable) -> gid 2.
 *  Advances 500/600/700; unitsPerEm 1000. Exercises arbitrary-Unicode embedding. */
export function buildUnicodeTtf(): Uint8Array {
  const { glyf, loca } = buildGlyf();
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmapFor([[0x41, 1], [0x4e2d, 2]]) },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea() },
    { tag: 'hmtx', data: buildHmtx() },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** Build a simple glyph from absolute on-curve contours (each `[x,y,x,y,...]`). */
function buildSimpleGlyph(contours: number[][]): Uint8Array {
  const allX: number[] = [], allY: number[] = [], ends: number[] = [];
  let count = 0;
  for (const c of contours) { for (let i = 0; i < c.length; i += 2) { allX.push(c[i]); allY.push(c[i + 1]); } count += c.length / 2; ends.push(count - 1); }
  const flags = new Uint8Array(allX.length).fill(0x01);
  const xd: Uint8Array[] = []; let px = 0; for (const x of allX) { xd.push(i16(x - px)); px = x; }
  const yd: Uint8Array[] = []; let py = 0; for (const y of allY) { yd.push(i16(y - py)); py = y; }
  return concat([
    i16(contours.length), i16(Math.min(...allX)), i16(Math.min(...allY)), i16(Math.max(...allX)), i16(Math.max(...allY)),
    ...ends.map((e) => u16(e)), u16(0), flags, ...xd, ...yd,
  ]);
}

/** Assemble a 2-glyph glyf font (glyph 0 empty, glyph 1 = `glyph1`), advances 1000,
 *  unitsPerEm 1000, cmap mapping 'A'→1/'B'→2. */
function assembleGlyfFont(glyph1: Uint8Array): Uint8Array {
  const g0 = new Uint8Array(0);
  const glyf = concat([g0, glyph1]);
  const loca = concat([0, g0.length, g0.length + glyph1.length].map((o) => u16(o / 2)));
  const maxp = new Uint8Array(32); { const v = new DataView(maxp.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, 2); }
  const hhea = new Uint8Array(36); { const v = new DataView(hhea.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, 2); }
  const hmtx = concat([u16(1000), i16(0), u16(1000), i16(0)]);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmap() }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** A 2-glyph TrueType font whose glyph 1 is a solid box filling most of the em
 *  (100,0)-(900,700); unitsPerEm 1000. For rasterization tests via Identity GIDs. */
export function buildInkTtf(): Uint8Array {
  return assembleGlyfFont(buildSimpleGlyph([[100, 0, 900, 0, 900, 700, 100, 700]]));
}

/** Like {@link buildInkTtf} but glyph 1 has a hole: a CCW outer box (0,0)-(1000,700)
 *  and a CW inner box (350,200)-(650,500), so nonzero winding leaves the middle empty. */
export function buildHoleTtf(): Uint8Array {
  return assembleGlyfFont(buildSimpleGlyph([
    [0, 0, 1000, 0, 1000, 700, 0, 700],       // outer, CCW
    [350, 200, 350, 500, 650, 500, 650, 200], // inner, CW (reversed) → hole
  ]));
}

/** A 3-glyph TrueType font with *well-formed* outlines: gid0 empty, gid1 a real
 *  4-point box (0,0)-(500,700), gid2 a real composite translating gid1 by
 *  (+100,+50). unitsPerEm 1000; cmap 'A'→1, 'B'→2. Exercises the WOFF2 glyf
 *  transform across all three glyph kinds (unlike the degenerate glyphs in the
 *  other fixtures, whose "contours" carry no points). */
export function buildCompositeTtf(): Uint8Array {
  const g0 = new Uint8Array(0);
  const g1 = buildSimpleGlyph([[0, 0, 500, 0, 500, 700, 0, 700]]); // 4 points → even length
  const flags = 0x0003; // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES
  const g2 = concat([i16(-1), i16(100), i16(50), i16(600), i16(750), u16(flags), u16(1), i16(100), i16(50)]);
  const glyf = concat([g0, g1, g2]);
  const offs = [0, g0.length, g0.length + g1.length, g0.length + g1.length + g2.length];
  const loca = concat(offs.map((o) => u16(o / 2))); // offsets even by construction
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmap() }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: buildHhea() }, { tag: 'hmtx', data: buildHmtx() },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: buildMaxp() }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** Minimal OTTO (CFF) font: the glyf-flavored fixture's metric tables plus an
 *  empty 'CFF ' table, re-tagged 'OTTO', with no 'glyf'/'loca'. */
export function makeOttoWithCff(): Uint8Array {
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'CFF ', data: new Uint8Array(4) },
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea() },
    { tag: 'hmtx', data: buildHmtx() },
    { tag: 'maxp', data: buildMaxp() },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const dirSize = 12 + tables.length * 16;
  let offset = dirSize;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x4F54544F), u16(tables.length), u16(0), u16(0), u16(0)]); // 'OTTO'
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

// ─── OpenType layout (GSUB/GPOS/GDEF) synthetic emitters (8u0.1) ───
// Each lookup emitter returns raw Lookup subtable bytes + its feature tag/type/flag.
// buildGsub/buildGpos assemble a full table (ScriptList DFLT+latn, FeatureList, LookupList).

const tag4 = (s: string) => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);

export interface LookupDef { tag: string; type: number; flag: number; subtables: Uint8Array[]; }

/** Coverage format 1 over a gid list (sorted). */
export function coverage1(gids: number[]): Uint8Array {
  const s = [...gids].sort((a, b) => a - b);
  return concat([u16(1), u16(s.length), ...s.map(u16)]);
}

export function singleSubstDelta(tag: string, coverGid: number, delta: number): LookupDef {
  // Single fmt1: format, coverageOff(6), deltaGlyphID; Coverage at byte 6.
  const sub = concat([u16(1), u16(6), i16(delta), coverage1([coverGid])]);
  return { tag, type: 1, flag: 0, subtables: [sub] };
}

export function ligatureLookup(tag: string, first: number, rest: number[], ligGid: number, flag = 0): LookupDef {
  const compCount = 1 + rest.length;
  const ligature = concat([u16(ligGid), u16(compCount), ...rest.map(u16)]);
  const ligSet = concat([u16(1), u16(4), ligature]);          // ligCount=1, ligOff=4 (from LigatureSet)
  const headLen = 8;                                          // format,coverageOff,ligSetCount,ligSetOffsets[1]
  const covOff = headLen + ligSet.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), ligSet, coverage1([first])]);
  return { tag, type: 4, flag, subtables: [sub] };
}

function buildOtTable(lookups: LookupDef[]): Uint8Array {
  const featureCount = lookups.length;
  const featureIdx = lookups.map((_, i) => i);
  const langSys = concat([u16(0), u16(0xFFFF), u16(featureCount), ...featureIdx.map(u16)]);
  const scriptTable = concat([u16(4), u16(0), langSys]);      // defaultLangSysOff=4, langSysCount=0
  const slHeader = concat([u16(2), tag4('DFLT'), u16(0), tag4('latn'), u16(0)]); // 14 bytes
  const stOff = slHeader.length;
  const slV = new DataView(slHeader.buffer);
  slV.setUint16(6, stOff); slV.setUint16(12, stOff);         // both ScriptRecords -> ScriptTable
  const scriptList = concat([slHeader, scriptTable]);
  // FeatureList: one feature per lookup, referencing its own lookup index.
  let fAt = 2 + featureCount * 6;
  const featRecs: Uint8Array[] = [];
  const featBodies: Uint8Array[] = [];
  lookups.forEach((lk, i) => {
    const body = concat([u16(0), u16(1), u16(i)]);           // featureParams, lookupCount=1, lookupIndex=i
    featRecs.push(concat([tag4(lk.tag), u16(fAt)]));
    featBodies.push(body); fAt += body.length;
  });
  const featureList = concat([u16(featureCount), ...featRecs, ...featBodies]);
  // LookupList.
  let lAt = 2 + lookups.length * 2;
  const lkOffs: Uint8Array[] = [];
  const lkBodies: Uint8Array[] = [];
  for (const lk of lookups) {
    const subOffsets: number[] = [];
    let subAt = 6 + lk.subtables.length * 2;
    const subBytes: Uint8Array[] = [];
    for (const s of lk.subtables) { subOffsets.push(subAt); subBytes.push(s); subAt += s.length; }
    const body = concat([u16(lk.type), u16(lk.flag), u16(lk.subtables.length), ...subOffsets.map(u16), ...subBytes]);
    lkOffs.push(u16(lAt)); lkBodies.push(body); lAt += body.length;
  }
  const lookupList = concat([u16(lookups.length), ...lkOffs, ...lkBodies]);
  const sOff = 10, fOff = sOff + scriptList.length, lOff = fOff + featureList.length;
  return concat([u16(1), u16(0), u16(sOff), u16(fOff), u16(lOff), scriptList, featureList, lookupList]);
}

export function buildGsub(lookups: LookupDef[]): Uint8Array { return buildOtTable(lookups); }
export function buildGpos(lookups: LookupDef[]): Uint8Array { return buildOtTable(lookups); }

export function multipleLookup(tag: string, coverGid: number, seq: number[]): LookupDef {
  const sequence = concat([u16(seq.length), ...seq.map(u16)]);
  const headLen = 8;                                          // format,coverageOff,seqCount,seqOffsets[1]
  const covOff = headLen + sequence.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), sequence, coverage1([coverGid])]);
  return { tag, type: 2, flag: 0, subtables: [sub] };
}

export function alternateLookup(tag: string, coverGid: number, alts: number[]): LookupDef {
  const altSet = concat([u16(alts.length), ...alts.map(u16)]);
  const headLen = 8;
  const covOff = headLen + altSet.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), altSet, coverage1([coverGid])]);
  return { tag, type: 3, flag: 0, subtables: [sub] };
}

export interface SeqLookupRec { seqIndex: number; lookupIndex: number; }
const recBytes = (recs: SeqLookupRec[]) => concat(recs.flatMap((rc) => [u16(rc.seqIndex), u16(rc.lookupIndex)]));

/** Chaining contextual, format 3 (coverage-based). `back`/`input`/`ahead` are
 *  lists of gid-groups (each group = one Coverage). `type` = 6 (GSUB) or 8 (GPOS). */
export function chainLookup(tag: string, back: number[][], input: number[][], ahead: number[][], recs: SeqLookupRec[], type = 6): LookupDef {
  const groups = [...back, ...input, ...ahead];
  const headU16 = 1 + 1 + back.length + 1 + input.length + 1 + ahead.length + 1 + recs.length * 2;
  let at = headU16 * 2;
  const covs: Uint8Array[] = [];
  const covOffs: number[] = [];
  for (const g of groups) { covOffs.push(at); const c = coverage1(g); covs.push(c); at += c.length; }
  let gi = 0;
  const nums: number[] = [3, back.length];
  for (let k = 0; k < back.length; k++) nums.push(covOffs[gi++]);
  nums.push(input.length); for (let k = 0; k < input.length; k++) nums.push(covOffs[gi++]);
  nums.push(ahead.length); for (let k = 0; k < ahead.length; k++) nums.push(covOffs[gi++]);
  nums.push(recs.length);
  const sub = concat([...nums.map(u16), recBytes(recs), ...covs]);
  return { tag, type, flag: 0, subtables: [sub] };
}

/** Chaining contextual, format 1 (glyph-sequence). `input` = glyphs AFTER the
 *  coverage glyph. `type` = 6 (GSUB) or 8 (GPOS). */
export function chainLookupFmt1(tag: string, coverGid: number, back: number[], input: number[], ahead: number[], recs: SeqLookupRec[], type = 6): LookupDef {
  const rule = concat([
    u16(back.length), ...back.map(u16),
    u16(input.length + 1), ...input.map(u16),
    u16(ahead.length), ...ahead.map(u16),
    u16(recs.length), recBytes(recs),
  ]);
  const ruleSet = concat([u16(1), u16(4), rule]);            // ruleCount=1, ruleOff=4
  const headLen = 8;                                          // format,coverageOff,ruleSetCount,ruleSetOffsets[1]
  const covOff = headLen + ruleSet.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), ruleSet, coverage1([coverGid])]);
  return { tag, type, flag: 0, subtables: [sub] };
}

/** Contextual, format 1 (glyph-sequence, non-chaining). `input` = glyphs AFTER the
 *  coverage glyph. Per the OpenType spec a SequenceRule orders its fields
 *  glyphCount, seqLookupCount, inputSequence, records (seqLookupCount BEFORE the
 *  input glyphs — unlike the chaining ChainedSequenceRule). `type` = 5/7. */
export function contextLookupFmt1(tag: string, coverGid: number, input: number[], recs: SeqLookupRec[], type = 5): LookupDef {
  const rule = concat([
    u16(input.length + 1),                                    // glyphCount
    u16(recs.length),                                         // seqLookupCount (precedes inputSequence)
    ...input.map(u16),                                        // inputSequence[glyphCount-1]
    recBytes(recs),
  ]);
  const ruleSet = concat([u16(1), u16(4), rule]);            // ruleCount=1, ruleOff=4
  const headLen = 8;                                          // format,coverageOff,ruleSetCount,ruleSetOffsets[1]
  const covOff = headLen + ruleSet.length;
  const sub = concat([u16(1), u16(covOff), u16(1), u16(headLen), ruleSet, coverage1([coverGid])]);
  return { tag, type, flag: 0, subtables: [sub] };
}

/** Bare ClassDef, format 2 (range list). `[gid, class]` pairs; unlisted -> class 0. */
function classDef2(classes: [number, number][]): Uint8Array {
  const sorted = [...classes].sort((a, b) => a[0] - b[0]);
  return concat([u16(2), u16(sorted.length), ...sorted.flatMap(([g, c]) => [u16(g), u16(g), u16(c)])]);
}

export interface Fmt2Rule { input: number[]; recs: SeqLookupRec[]; }
export interface ChainFmt2Rule { back: number[]; input: number[]; ahead: number[]; recs: SeqLookupRec[]; }

// One ClassSequenceRule / ChainedClassSequenceRule. Non-chaining order is
// glyphCount, seqLookupCount, inputClasses, records; chaining puts seqLookupCount last.
function classRule(rule: Fmt2Rule | ChainFmt2Rule, chaining: boolean): Uint8Array {
  if (chaining) {
    const r = rule as ChainFmt2Rule;
    return concat([
      u16(r.back.length), ...r.back.map(u16),
      u16(r.input.length + 1), ...r.input.map(u16),
      u16(r.ahead.length), ...r.ahead.map(u16),
      u16(r.recs.length), recBytes(r.recs),
    ]);
  }
  const r = rule as Fmt2Rule;
  return concat([u16(r.input.length + 1), u16(r.recs.length), ...r.input.map(u16), recBytes(r.recs)]);
}
function classRuleSet(rules: (Fmt2Rule | ChainFmt2Rule)[], chaining: boolean): Uint8Array {
  let at = 2 + rules.length * 2;
  const offs: number[] = []; const bodies: Uint8Array[] = [];
  for (const rl of rules) { offs.push(at); const b = classRule(rl, chaining); bodies.push(b); at += b.length; }
  return concat([u16(rules.length), ...offs.map(u16), ...bodies]);
}

/** Contextual, format 2 (class-based). `classes` = [gid, class] for the ClassDef;
 *  `ruleSets[c]` = rules chosen when the first glyph is class `c` (empty -> null set).
 *  Each rule's `input` = class values for the glyphs AFTER the first. `type` = 5/7. */
export function contextLookupFmt2(tag: string, classes: [number, number][], ruleSets: Fmt2Rule[][], type = 5): LookupDef {
  const cov = coverage1(classes.map(([g]) => g));
  const cd = classDef2(classes);
  const setCount = ruleSets.length;
  let at = (4 + setCount) * 2;
  const covOff = at; at += cov.length;
  const cdOff = at; at += cd.length;
  const setOffs: number[] = []; const setBodies: Uint8Array[] = [];
  for (const rs of ruleSets) {
    if (rs.length === 0) { setOffs.push(0); continue; }
    setOffs.push(at); const b = classRuleSet(rs, false); setBodies.push(b); at += b.length;
  }
  const sub = concat([u16(2), u16(covOff), u16(cdOff), u16(setCount), ...setOffs.map(u16), cov, cd, ...setBodies]);
  return { tag, type, flag: 0, subtables: [sub] };
}

/** Chained contextual, format 2 (class-based). Separate ClassDefs for backtrack/
 *  input/lookahead. Rule set is chosen by the input class of the first glyph.
 *  `type` = 6 (GSUB) or 8 (GPOS). */
export function chainContextLookupFmt2(tag: string, back: [number, number][], input: [number, number][], ahead: [number, number][], ruleSets: ChainFmt2Rule[][], type = 6): LookupDef {
  const cov = coverage1(input.map(([g]) => g));
  const backCD = classDef2(back), inputCD = classDef2(input), aheadCD = classDef2(ahead);
  const setCount = ruleSets.length;
  let at = (6 + setCount) * 2;
  const covOff = at; at += cov.length;
  const backOff = at; at += backCD.length;
  const inputOff = at; at += inputCD.length;
  const aheadOff = at; at += aheadCD.length;
  const setOffs: number[] = []; const setBodies: Uint8Array[] = [];
  for (const rs of ruleSets) {
    if (rs.length === 0) { setOffs.push(0); continue; }
    setOffs.push(at); const b = classRuleSet(rs, true); setBodies.push(b); at += b.length;
  }
  const sub = concat([u16(2), u16(covOff), u16(backOff), u16(inputOff), u16(aheadOff), u16(setCount), ...setOffs.map(u16), cov, backCD, inputCD, aheadCD, ...setBodies]);
  return { tag, type, flag: 0, subtables: [sub] };
}

/** Wrap an inner lookup as an Extension (GSUB type 7 / GPOS type 9). */
export function extensionLookup(tag: string, inner: LookupDef, outerType = 7): LookupDef {
  const sub = concat([u16(1), u16(inner.type), u32(8), inner.subtables[0]]); // format1, innerType, offset=8
  return { tag, type: outerType, flag: 0, subtables: [sub] };
}

/** Reverse chaining single (GSUB type 8), format 1. `subst` maps each covered
 *  glyph (in coverage order) to its replacement. */
export function reverseChainLookup(tag: string, cover: number[], back: number[][], ahead: number[][], subst: number[]): LookupDef {
  const groups = [...back, ...ahead];
  // format(1) coverageOff backCount backCov[] aheadCount aheadCov[] glyphCount subst[]
  const headU16 = 1 + 1 + 1 + back.length + 1 + ahead.length + 1 + subst.length;
  let at = headU16 * 2;
  const covMain = coverage1(cover);
  const covMainOff = at; at += covMain.length;
  const covs: Uint8Array[] = []; const covOffs: number[] = [];
  for (const g of groups) { covOffs.push(at); const c = coverage1(g); covs.push(c); at += c.length; }
  let gi = 0;
  const nums: number[] = [1, covMainOff, back.length];
  for (let k = 0; k < back.length; k++) nums.push(covOffs[gi++]);
  nums.push(ahead.length); for (let k = 0; k < ahead.length; k++) nums.push(covOffs[gi++]);
  nums.push(subst.length); for (const s of subst) nums.push(s);
  const sub = concat([...nums.map(u16), covMain, ...covs]);
  return { tag, type: 8, flag: 0, subtables: [sub] };
}

export function pairKernLookup(tag: string, first: number, second: number, kern: number): LookupDef {
  // Pair fmt1, valueFormat1 = 0x0004 (xAdvance), valueFormat2 = 0.
  const pairValue = concat([u16(second), i16(kern)]);
  const pairSet = concat([u16(1), pairValue]);               // pairValueCount=1
  const headLen = 12;                                        // format,coverageOff,vf1,vf2,pairSetCount,pairSetOffsets[1]
  const covOff = headLen + pairSet.length;
  const sub = concat([u16(1), u16(covOff), u16(0x0004), u16(0), u16(1), u16(headLen), pairSet, coverage1([first])]);
  return { tag, type: 2, flag: 0, subtables: [sub] };
}

export function singleAdjustLookup(tag: string, coverGid: number, dx: number, dAdv: number): LookupDef {
  // Single fmt1, valueFormat = xPlacement|xAdvance = 0x0005.
  const value = concat([i16(dx), i16(dAdv)]);                // xPlacement then xAdvance (bit order)
  const headLen = 6;                                         // format,coverageOff,valueFormat
  const sub = concat([u16(1), u16(headLen + value.length), u16(0x0005), value, coverage1([coverGid])]);
  return { tag, type: 1, flag: 0, subtables: [sub] };
}

export interface XY { x: number; y: number; }
function anchorBytes(a: XY): Uint8Array { return concat([u16(1), i16(a.x), i16(a.y)]); }

// Shared layout for mark-to-base (type 4) and mark-to-mark (type 6): a single mark
// (class 0) attaching to a single base/mark2. markClassCount = 1.
function markAttachLookup(tag: string, type: number, markGid: number, markAnchor: XY, baseGid: number, baseAnchor: XY): LookupDef {
  const markCov = coverage1([markGid]);
  const baseCov = coverage1([baseGid]);
  const markArray = concat([u16(1), u16(0), u16(6), anchorBytes(markAnchor)]); // count1, [markClass0, anchorOff=6]
  const baseArray = concat([u16(1), u16(4), anchorBytes(baseAnchor)]);          // count1, [anchorOff=4]
  const headLen = 12;
  let at = headLen;
  const markCovOff = at; at += markCov.length;
  const baseCovOff = at; at += baseCov.length;
  const markArrayOff = at; at += markArray.length;
  const baseArrayOff = at; at += baseArray.length;
  const sub = concat([u16(1), u16(markCovOff), u16(baseCovOff), u16(1), u16(markArrayOff), u16(baseArrayOff), markCov, baseCov, markArray, baseArray]);
  return { tag, type, flag: 0, subtables: [sub] };
}

export function markBaseLookup(tag: string, markGid: number, markAnchor: XY, baseGid: number, baseAnchor: XY): LookupDef {
  return markAttachLookup(tag, 4, markGid, markAnchor, baseGid, baseAnchor);
}
export function markMarkLookup(tag: string, mark1Gid: number, mark1Anchor: XY, mark2Gid: number, mark2Anchor: XY): LookupDef {
  return markAttachLookup(tag, 6, mark1Gid, mark1Anchor, mark2Gid, mark2Anchor);
}

/** Cursive attachment (GPOS type 3), format 1. Each entry provides an optional
 *  entry and/or exit anchor for its glyph. `flag` can carry RIGHT_TO_LEFT (0x0001). */
export interface CursiveEntry { gid: number; entry?: XY; exit?: XY; }
export function cursiveLookup(tag: string, entries: CursiveEntry[], flag = 0): LookupDef {
  const sorted = [...entries].sort((a, b) => a.gid - b.gid);    // records align to sorted coverage order
  const count = sorted.length;
  let at = 6 + count * 4;                                       // format,coverageOff,entryExitCount,records
  const anchors: Uint8Array[] = [];
  const recs: number[][] = [];
  for (const e of sorted) {
    let entryOff = 0, exitOff = 0;
    if (e.entry) { entryOff = at; const b = anchorBytes(e.entry); anchors.push(b); at += b.length; }
    if (e.exit)  { exitOff = at;  const b = anchorBytes(e.exit);  anchors.push(b); at += b.length; }
    recs.push([entryOff, exitOff]);
  }
  const covOff = at;
  const sub = concat([
    u16(1), u16(covOff), u16(count),
    ...recs.flatMap(([en, ex]) => [u16(en), u16(ex)]),
    ...anchors,
    coverage1(sorted.map((e) => e.gid)),
  ]);
  return { tag, type: 3, flag, subtables: [sub] };
}

/** Mark-to-ligature (GPOS type 5), format 1. `marks` = [gid, class, anchor];
 *  `components[c][k]` = the anchor (or null) of ligature component `c` for mark
 *  class `k`. Single ligature glyph `ligGid`. */
export interface MarkDef { gid: number; cls: number; anchor: XY; }
export function markLigLookup(tag: string, marks: MarkDef[], ligGid: number, components: (XY | null)[][], markClassCount = 1): LookupDef {
  const sortedMarks = [...marks].sort((a, b) => a.gid - b.gid);
  // MarkArray: markCount, MarkRecord[]{markClass, anchorOffset}, anchor blobs.
  let mAt = 2 + sortedMarks.length * 4;
  const mAnchors: Uint8Array[] = [];
  const mRecs = sortedMarks.map((m) => { const off = mAt; const b = anchorBytes(m.anchor); mAnchors.push(b); mAt += b.length; return concat([u16(m.cls), u16(off)]); });
  const markArray = concat([u16(sortedMarks.length), ...mRecs, ...mAnchors]);
  // LigatureAttach: componentCount, per-component anchorOffset[markClassCount], anchor blobs.
  let lAt = 2 + components.length * markClassCount * 2;
  const lAnchors: Uint8Array[] = [];
  const lOffs: number[] = [];
  for (const comp of components) for (let k = 0; k < markClassCount; k++) {
    const a = comp[k];
    if (a) { lOffs.push(lAt); const b = anchorBytes(a); lAnchors.push(b); lAt += b.length; } else lOffs.push(0);
  }
  const ligAttach = concat([u16(components.length), ...lOffs.map(u16), ...lAnchors]);
  const ligArray = concat([u16(1), u16(4), ligAttach]);        // ligatureCount=1, attachOffset=4
  const markCov = coverage1(sortedMarks.map((m) => m.gid));
  const ligCov = coverage1([ligGid]);
  const headLen = 12;
  let at = headLen;
  const markCovOff = at; at += markCov.length;
  const ligCovOff = at; at += ligCov.length;
  const markArrayOff = at; at += markArray.length;
  const ligArrayOff = at; at += ligArray.length;
  const sub = concat([u16(1), u16(markCovOff), u16(ligCovOff), u16(markClassCount), u16(markArrayOff), u16(ligArrayOff), markCov, ligCov, markArray, ligArray]);
  return { tag, type: 5, flag: 0, subtables: [sub] };
}

export function buildGdefClasses(classes: [number, number][]): Uint8Array {
  const sorted = [...classes].sort((a, b) => a[0] - b[0]);
  const cd = concat([u16(2), u16(sorted.length), ...sorted.flatMap(([g, c]) => [u16(g), u16(g), u16(c)])]);
  return concat([u16(1), u16(0), u16(12), u16(0), u16(0), u16(0), cd]); // glyphClassDefOffset=12
}

/** A glyf font (100 glyphs, advances = max(100, gid*100), unitsPerEm 1000)
 *  carrying optional GSUB/GPOS/GDEF tables. For otlayout end-to-end tests. */
export function buildOtFont(ot: { gsub?: Uint8Array; gpos?: Uint8Array; gdef?: Uint8Array }): Uint8Array {
  const numGlyphs = 100;
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]); // one shared simple glyph shape
  const glyphs: Uint8Array[] = [g0]; for (let i = 1; i < numGlyphs; i++) glyphs.push(g1);
  const glyf = concat(glyphs);
  const offs = [0]; for (let i = 0; i < numGlyphs; i++) offs.push(offs[i] + glyphs[i].length);
  const loca = concat(offs.map((o) => u16(o / 2)));
  const maxp = (() => { const b = new Uint8Array(32); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, numGlyphs); return b; })();
  const hhea = (() => { const b = new Uint8Array(36); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, numGlyphs); return b; })();
  const hmtxParts: Uint8Array[] = []; for (let i = 0; i < numGlyphs; i++) hmtxParts.push(u16(Math.max(100, i * 100)), i16(0));
  const hmtx = concat(hmtxParts);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmap() }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  if (ot.gdef) tables.push({ tag: 'GDEF', data: ot.gdef });
  if (ot.gsub) tables.push({ tag: 'GSUB', data: ot.gsub });
  if (ot.gpos) tables.push({ tag: 'GPOS', data: ot.gpos });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1)); // sfnt directory: tags ascending
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** Like {@link buildOtFont} but with a caller-supplied cmap (code point -> gid),
 *  so shaping tests can map real code points to specific glyph ids. */
export function buildOtFontFor(
  ot: { gsub?: Uint8Array; gpos?: Uint8Array; gdef?: Uint8Array; cmap: [number, number][] },
): Uint8Array {
  const numGlyphs = 100;
  const g0 = new Uint8Array(0);
  const g1 = concat([i16(1), i16(0), i16(0), i16(0x100), i16(0x100)]);
  const glyphs: Uint8Array[] = [g0]; for (let i = 1; i < numGlyphs; i++) glyphs.push(g1);
  const glyf = concat(glyphs);
  const offs = [0]; for (let i = 0; i < numGlyphs; i++) offs.push(offs[i] + glyphs[i].length);
  const loca = concat(offs.map((o) => u16(o / 2)));
  const maxp = (() => { const b = new Uint8Array(32); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, numGlyphs); return b; })();
  const hhea = (() => { const b = new Uint8Array(36); const v = new DataView(b.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, numGlyphs); return b; })();
  const hmtxParts: Uint8Array[] = []; for (let i = 0; i < numGlyphs; i++) hmtxParts.push(u16(Math.max(100, i * 100)), i16(0));
  const hmtx = concat(hmtxParts);
  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: buildOS2() }, { tag: 'cmap', data: buildCmapFor(ot.cmap) }, { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() }, { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp }, { tag: 'name', data: buildName() }, { tag: 'post', data: buildPost() },
  ];
  if (ot.gdef) tables.push({ tag: 'GDEF', data: ot.gdef });
  if (ot.gsub) tables.push({ tag: 'GSUB', data: ot.gsub });
  if (ot.gpos) tables.push({ tag: 'GPOS', data: ot.gpos });
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** A `name` table from arbitrary records. `plat` 3 encodes UTF-16BE (the
 *  Windows convention), any other value ASCII. */
export function buildNameRecords(
  records: { plat: number; nameID: number; text: string }[],
): Uint8Array {
  const encoded = records.map((r) => {
    if (r.plat === 3) {
      const b = new Uint8Array(r.text.length * 2);
      for (let i = 0; i < r.text.length; i++) {
        b[i * 2] = r.text.charCodeAt(i) >> 8;
        b[i * 2 + 1] = r.text.charCodeAt(i) & 0xff;
      }
      return b;
    }
    return new TextEncoder().encode(r.text);
  });
  const stringOffset = 6 + records.length * 12;
  const parts: Uint8Array[] = [concat([u16(0), u16(records.length), u16(stringOffset)])];
  let off = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    parts.push(concat([
      u16(r.plat), u16(r.plat === 3 ? 1 : 0), u16(0), u16(r.nameID),
      u16(encoded[i].length), u16(off),
    ]));
    off += encoded[i].length;
  }
  return concat([...parts, ...encoded]);
}

/**
 * A whole glyf sfnt carrying the given names and style.
 *
 * `padGlyf` inflates the `glyf` table so the `name` table lands well past any
 * fixed prefix a reader might optimistically grab -- the shape fontsource.ts's
 * partial reads must survive.
 */
export function buildNamedFont(opts: {
  family: string; subfamily?: string;
  typographicFamily?: string;
  bold?: boolean; italic?: boolean; weight?: number;
  padGlyf?: number;
  /** Code point -> gid. Default: buildCmap()'s 0x41->1, 0x42->2. */
  cmap?: [number, number][];
  /** OS/2.ulUnicodeRange1..4. Default: all zero. */
  unicodeRange?: [number, number, number, number];
  /** OS/2.sFamilyClass high byte. Default: 0 (unclassified). */
  familyClass?: number;
  /** name ID 6. Default: the family with its spaces removed. A REAL font
   *  states a PostScript name that is not derivable from the family that way --
   *  MS Mincho states `MS-Mincho` -- which is exactly what /BaseFont carries. */
  postScriptName?: string;
}): Uint8Array {
  const recs = [
    { plat: 3, nameID: 1, text: opts.family },
    { plat: 3, nameID: 2, text: opts.subfamily ?? 'Regular' },
    { plat: 3, nameID: 6, text: opts.postScriptName ?? opts.family.replace(/\s+/g, '') },
  ];
  if (opts.typographicFamily) recs.push({ plat: 3, nameID: 16, text: opts.typographicFamily });

  const head = buildHead();
  new DataView(head.buffer, head.byteOffset).setUint16(
    44, (opts.bold ? 1 : 0) | (opts.italic ? 2 : 0));

  const os2 = buildOS2();
  const os2v = new DataView(os2.buffer, os2.byteOffset);
  os2v.setUint16(4, opts.weight ?? 400);
  if (opts.familyClass !== undefined) os2v.setUint16(30, opts.familyClass << 8);
  if (opts.unicodeRange) {
    os2v.setUint32(42, opts.unicodeRange[0]); os2v.setUint32(46, opts.unicodeRange[1]);
    os2v.setUint32(50, opts.unicodeRange[2]); os2v.setUint32(54, opts.unicodeRange[3]);
  }

  // TWO glyphs (.notdef + one box), then padding so `glyf` can be made
  // arbitrarily large. The maxp/hhea/hmtx below are built locally rather than
  // taken from the exported buildMaxp/buildHhea/buildHmtx: those declare THREE
  // glyphs, and parseSfnt reads numGlyphs+1 loca entries, so a 3-entry loca
  // would be read one entry past its end. `assembleGlyfFont` in this file
  // builds its own tables for exactly that reason.
  const g1 = buildSimpleGlyph([[100, 0, 900, 0, 900, 700, 100, 700]]);
  const pad = (opts.padGlyf ?? 0) & ~1;         // even: loca stores offset/2
  const glyf = concat([g1, new Uint8Array(pad)]);
  const loca = concat([u16(0), u16(0), u16((g1.length + pad) / 2)]);
  const maxp = new Uint8Array(32);
  { const v = new DataView(maxp.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, 2); }
  const hhea = new Uint8Array(36);
  { const v = new DataView(hhea.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, 2); }
  const hmtx = concat([u16(1000), i16(0), u16(1000), i16(0)]);

  const tables = [
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: opts.cmap
      ? buildCmapTable([{ plat: 3, enc: 1, data: cmapFormat4(opts.cmap) }])
      : buildCmap() },
    { tag: 'glyf', data: glyf }, { tag: 'head', data: head },
    { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp },
    { tag: 'name', data: buildNameRecords(recs) }, { tag: 'post', data: buildPost() },
  ];
  // `name` LAST in the file body, after the padded glyf, which is the layout
  // the partial-read test needs. The directory stays tag-sorted as required.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  let offset = 12 + tables.length * 16;
  const order = [...tables].sort((a, b) => (a.tag === 'name' ? 1 : b.tag === 'name' ? -1 : 0));
  const at = new Map<string, number>();
  const bodies: Uint8Array[] = [];
  for (const t of order) { at.set(t.tag, offset); const p = pad4(t.data); offset += p.length; bodies.push(p); }
  const dir = concat(tables.map((t) => concat([
    new TextEncoder().encode(t.tag), u32(0), u32(at.get(t.tag)!), u32(t.data.length),
  ])));
  return concat([concat([u32(0x00010000), u16(tables.length), u16(0), u16(0), u16(0)]), dir, ...bodies]);
}

/**
 * A TrueType Collection wrapping the given fonts.
 *
 * Each face's table directory is rewritten with offsets into the COLLECTION,
 * which is what makes a .ttc's directories usable in place -- and what makes
 * naively keeping the whole file as a face's `raw` so tempting. Tables are
 * concatenated without dedup: the point here is a valid container, not a
 * space-efficient one.
 */
export function buildTtc(fonts: Uint8Array[]): Uint8Array {
  const headerLen = 12 + fonts.length * 4;
  // Lay out each face's directory, then its tables, after the TTC header.
  const dirs: Uint8Array[] = [];
  const bodies: Uint8Array[] = [];
  const dirAt: number[] = [];

  let dirCursor = headerLen;
  for (const f of fonts) {
    const numTables = (f[4] << 8) | f[5];
    dirAt.push(dirCursor);
    dirCursor += 12 + numTables * 16;
  }
  let bodyCursor = dirCursor;

  for (const f of fonts) {
    const numTables = (f[4] << 8) | f[5];
    const dir = f.slice(0, 12 + numTables * 16);
    const dv = new DataView(dir.buffer, dir.byteOffset);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const off = dv.getUint32(rec + 8), len = dv.getUint32(rec + 12);
      const data = pad4(f.slice(off, off + len));
      dv.setUint32(rec + 8, bodyCursor);     // rewrite to a collection offset
      bodies.push(data);
      bodyCursor += data.length;
    }
    dirs.push(dir);
  }

  const header = concat([
    new TextEncoder().encode('ttcf'), u32(0x00010000), u32(fonts.length),
    ...dirAt.map((a) => u32(a)),
  ]);
  return concat([header, ...dirs, ...bodies]);
}
