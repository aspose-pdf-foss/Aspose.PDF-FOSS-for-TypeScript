// Builds a minimal bare CFF (non-CID) with 2 glyphs (0 .notdef, 1 = box), and an
// OpenType-CFF (OTTO) sfnt wrapping it with a cmap mapping 'A'->gid 1.
import { buildHead, buildOS2, buildPost, buildName, buildCmap } from './build-sfnt.js';

function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
function i16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const len = arrs.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len); let o = 0; for (const p of arrs) { out.set(p, o); o += p.length; }
  return out;
}
function pad4(b: Uint8Array): Uint8Array { const r = b.length % 4; return r === 0 ? b : concat([b, new Uint8Array(4 - r)]); }

/** Encode a CFF DICT integer in the fixed 5-byte form (marker 29 + int32). */
function dictInt5(n: number): Uint8Array { return concat([[29], u32(n)]); }

/** A CFF INDEX over `items`, offSize chosen to fit — a fixture with more than
 *  255 bytes of data needs 2+, and silently truncating the offsets there
 *  produces a corrupt INDEX that still parses. */
function index(items: Uint8Array[]): Uint8Array {
  if (items.length === 0) return u16(0);
  const dataLen = items.reduce((s, it) => s + it.length, 0);
  const lastOff = dataLen + 1;
  const offSize = lastOff <= 0xff ? 1 : lastOff <= 0xffff ? 2 : lastOff <= 0xffffff ? 3 : 4;
  const bytes: number[] = [];
  const writeOff = (o: number): void => { for (let k = offSize - 1; k >= 0; k--) bytes.push((o >> (8 * k)) & 0xff); };
  let off = 1; writeOff(off);
  for (const it of items) { off += it.length; writeOff(off); }
  return concat([u16(items.length), Uint8Array.from([offSize]), Uint8Array.from(bytes), ...items]);
}

/** The box charstring: rmoveto (100,0) then rlineto around (900,0)-(900,700)-(100,700). */
function boxCharstring(): Uint8Array {
  return Uint8Array.from([
    239, 139, 21,                        // 100 0 rmoveto
    249, 180, 139, 139, 249, 80, 253, 180, 139, 5,  // 800 0 0 700 -800 0 rlineto
    14,                                  // endchar
  ]);
}

/** Minimal non-CID CFF: header, Name/TopDICT/String/GlobalSubr INDEXes, CharStrings. */
export function buildMinimalCff(): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);           // major minor hdrSize offSize
  const nameIndex = index([new TextEncoder().encode('BOX')]);
  const stringIndex = index([]);
  const gsubrIndex = index([]);

  // Top DICT references CharStrings by absolute offset; lay everything out first.
  const topDictBody = concat([dictInt5(0), [17]]);        // placeholder offset + CharStrings op
  const topIndex = index([topDictBody]);
  const charStringsOffset = header.length + nameIndex.length + topIndex.length + stringIndex.length + gsubrIndex.length;

  const topDict = concat([dictInt5(charStringsOffset), [17]]);
  const topIndexFinal = index([topDict]);
  const charStrings = index([Uint8Array.from([14]), boxCharstring()]);  // gid0 .notdef, gid1 box
  return concat([header, nameIndex, topIndexFinal, stringIndex, gsubrIndex, charStrings]);
}

/** A minimal CID-keyed CFF (ROS + charset + FDSelect + FDArray) with 2 glyphs and
 *  an identity charset (CID = GID); glyph 1 is the box charstring. All Top DICT
 *  offsets use the fixed 5-byte form so the layout can be computed in one pass. */
export function buildCidCff(): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);
  const nameIndex = index([new TextEncoder().encode('CID')]);
  const stringIndex = index([new TextEncoder().encode('Adobe'), new TextEncoder().encode('Identity')]);  // SID 391, 392
  const gsubrIndex = index([]);

  // Fixed-size Top DICT body (43 bytes): ROS, CharStrings, charset, FDArray, FDSelect.
  const topBodyLen = (5 * 3 + 2) + (5 + 1) + (5 + 1) + (5 + 2) + (5 + 2);
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const prefixLen = header.length + nameIndex.length + topIndexLen + stringIndex.length + gsubrIndex.length;

  const charStrings = index([Uint8Array.from([14]), boxCharstring()]);
  const charset = concat([[0], u16(1)]);                    // format 0: gid1 -> CID 1
  const fdSelect = concat([[0], [0, 0]]);                   // format 0: all glyphs -> FD 0
  const fontDict = concat([dictInt5(0), dictInt5(0), [18]]); // Private [size 0, offset 0]
  const fdArray = index([fontDict]);

  const csOff = prefixLen;
  const charsetOff = csOff + charStrings.length;
  const fdSelectOff = charsetOff + charset.length;
  const fdArrayOff = fdSelectOff + fdSelect.length;

  const topDict = concat([
    dictInt5(391), dictInt5(392), dictInt5(0), [12, 30],   // ROS
    dictInt5(csOff), [17],                                  // CharStrings
    dictInt5(charsetOff), [15],                             // charset
    dictInt5(fdArrayOff), [12, 36],                         // FDArray
    dictInt5(fdSelectOff), [12, 37],                        // FDSelect
  ]);
  const topIndex = index([topDict]);
  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex, charStrings, charset, fdSelect, fdArray]);
}

/** An OTTO sfnt wrapping {@link buildMinimalCff}, with a cmap mapping 'A'->gid 1. */
export function buildCffOtto(): Uint8Array {
  const maxp = concat([u32(0x00005000), u16(2)]);          // v0.5, numGlyphs 2
  const hhea = new Uint8Array(36); { const v = new DataView(hhea.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, 2); }
  const hmtx = concat([u16(1000), i16(0), u16(1000), i16(0)]);

  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'CFF ', data: buildMinimalCff() },
    { tag: 'OS/2', data: buildOS2() },
    { tag: 'cmap', data: buildCmap() },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx },
    { tag: 'maxp', data: maxp },
    { tag: 'name', data: buildName() },
    { tag: 'post', data: buildPost() },
  ];
  const numTables = tables.length;
  let offset = 12 + numTables * 16;
  const placed = tables.map((t) => { const at = offset; const padded = pad4(t.data); offset += padded.length; return { tag: t.tag, at, length: t.data.length, padded }; });
  const offsetTable = concat([u32(0x4f54544f), u16(numTables), u16(0), u16(0), u16(0)]);  // 'OTTO'
  const dir = concat(placed.map((p) => concat([new TextEncoder().encode(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

/** A non-CID CFF with decoy + live global and local subrs, 6 glyphs, for
 *  exercising subset inlining, pruning, and non-CID -> CID conversion.
 *  gid1 draws the box via global subr #1; gid2 via local subr #1. */
export function buildRichCff(): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);
  const nameIndex = index([new TextEncoder().encode('RICH')]);
  const stringIndex = index([]);

  const decoy = Uint8Array.from([139, 139, 21, 11]);                          // 0 0 rmoveto return
  const boxG = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 11]);
  const gsubrIndex = index([decoy, boxG]);                                    // global subrs [0]=decoy [1]=box

  const glyphs: Uint8Array[] = [
    Uint8Array.from([14]),                                                    // 0 .notdef
    Uint8Array.from([33, 29, 14]),                                            // 1 callgsubr #1 (33 -> -106; +bias107 = idx1)
    Uint8Array.from([33, 10, 14]),                                            // 2 callsubr  #1
    Uint8Array.from([239, 139, 21, 189, 139, 5, 14]),                        // 3 inline: 100 0 rmoveto 50 0 rlineto
    Uint8Array.from([239, 139, 21, 239, 139, 5, 14]),                        // 4 inline: 100 0 rmoveto 100 0 rlineto
    Uint8Array.from([139, 139, 21, 14]),                                     // 5 inline: 0 0 rmoveto
  ];
  const charStrings = index(glyphs);

  const boxL = Uint8Array.from([239, 139, 21, 139, 189, 5, 11]);             // 100 0 rmoveto 0 50 rlineto return
  const localSubrs = index([decoy, boxL]);                                    // local subrs [0]=decoy [1]=box2

  const privLen = 5 + 1;                                                      // dictInt5(subrsOff) + op(19)
  const privateDict = concat([dictInt5(privLen), [19]]);                      // Subrs at offset = privLen

  const topBodyLen = (5 + 5 + 1) + (5 + 1);                                   // Private[size off](18) + CharStrings(17) = 17
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const prefixLen = header.length + nameIndex.length + topIndexLen + stringIndex.length + gsubrIndex.length;

  const csOff = prefixLen;
  const privOff = csOff + charStrings.length;

  const topDict = concat([
    dictInt5(privLen), dictInt5(privOff), [18],
    dictInt5(csOff), [17],
  ]);
  const topIndex = index([topDict]);
  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex, charStrings, privateDict, localSubrs]);
}

/** A Type2 small integer: bytes 32..246 encode -107..107 as `v - 139`. */
const t2int = (n: number): number => 139 + (((n % 215) + 215) % 215) - 107;

/** A closed triangle whose coordinates vary with `seed`, so glyphs differ from
 *  one another the way a real font's do. Identical charstrings would deflate to
 *  almost nothing and the font would already be small — the one case that cannot
 *  demonstrate shrinking (see boxGlyph in build-optimize-pdf.ts, same reasoning).
 *  10 bytes. */
function shapeFor(seed: number): Uint8Array {
  return Uint8Array.from([
    t2int(seed * 7), t2int(seed * 3), 21,      // dx dy rmoveto
    t2int(seed * 11), t2int(seed * 5), 5,      // dx dy rlineto
    t2int(seed * 13), t2int(seed * 17), 5,     // dx dy rlineto
    14,                                        // endchar
  ]);
}

/**
 * A non-CID, **name-keyed** CFF of `n` glyphs — the shape a real Type1C subset
 * embed has, and the only fixture that can prove the name-keyed chain:
 *
 * - charset (format 0) names gid1 `A` via standard SID 34, and gid2.. via custom
 *   SIDs 391+ resolved through the String INDEX (`g07`, `g08`, ...);
 * - a built-in Encoding (format 0) maps 'A'->gid1 and 'B'->gid2;
 * - a Private DICT carries local Subrs, and gid1 draws through one — so a shrink
 *   must inline it before dropping the Subrs operator.
 *
 * Every Top DICT offset uses the fixed 5-byte form, so the layout computes in a
 * single pass, exactly as the other builders here do.
 */
export function buildNameKeyedCff(n = 8): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);
  const nameIndex = index([new TextEncoder().encode('NAMED')]);

  // Custom glyph names for gid2..n-1 -> SIDs 391, 392, ...
  const custom: Uint8Array[] = [];
  for (let g = 2; g < n; g++) custom.push(new TextEncoder().encode(`g${String(g + 5).padStart(2, '0')}`));
  const stringIndex = index(custom);
  const gsubrIndex = index([]);

  const decoy = Uint8Array.from([139, 139, 21, 11]);                          // 0 0 rmoveto return
  const boxSubr = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 11]);

  const glyphs: Uint8Array[] = [Uint8Array.from([14])];                       // gid0 .notdef
  glyphs.push(Uint8Array.from([33, 10, 14]));                                 // gid1: callsubr #1 -> box
  for (let g = 2; g < n; g++) glyphs.push(shapeFor(g));
  const charStrings = index(glyphs);

  // charset format 0: gid1 -> SID 34 ('A'), gid2.. -> 391+.
  const charsetParts: Uint8Array[] = [Uint8Array.from([0]), u16(34)];
  for (let g = 2; g < n; g++) charsetParts.push(u16(391 + (g - 2)));
  const charset = concat(charsetParts);

  // Encoding format 0: nCodes entries, code for gid1 then gid2.
  const encoding = concat([[0, 2], [0x41, 0x42]]);

  const localSubrs = index([decoy, boxSubr]);
  const privLen = 5 + 1;                                                      // dictInt5(subrsOff) + op(19)
  const privateDict = concat([dictInt5(privLen), [19]]);                      // Subrs at offset privLen

  const topBodyLen = (5 + 1) + (5 + 1) + (5 + 1) + (5 + 5 + 1);               // charset, Encoding, CharStrings, Private
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const prefixLen = header.length + nameIndex.length + topIndexLen + stringIndex.length + gsubrIndex.length;

  const csOff = prefixLen;
  const charsetOff = csOff + charStrings.length;
  const encodingOff = charsetOff + charset.length;
  const privOff = encodingOff + encoding.length;

  const topDict = concat([
    dictInt5(charsetOff), [15],
    dictInt5(encodingOff), [16],
    dictInt5(csOff), [17],
    dictInt5(privLen), dictInt5(privOff), [18],
  ]);
  if (topDict.length !== topBodyLen) throw new Error('buildNameKeyedCff: Top DICT length mismatch');
  const topIndex = index([topDict]);

  return concat([
    header, nameIndex, topIndex, stringIndex, gsubrIndex,
    charStrings, charset, encoding, privateDict, localSubrs,
  ]);
}

/** A non-CID CFF with `n` glyphs (gid0 .notdef, the rest a 14-byte box), no
 *  subrs — sized so subsetting to a few glyphs is demonstrably smaller. */
export function buildManyGlyphCff(n: number): Uint8Array {
  const header = Uint8Array.from([1, 0, 4, 1]);
  const nameIndex = index([new TextEncoder().encode('MANY')]);
  const stringIndex = index([]);
  const gsubrIndex = index([]);

  const box = Uint8Array.from([239, 139, 21, 249, 180, 139, 139, 249, 80, 253, 180, 139, 5, 14]);
  const glyphs: Uint8Array[] = [Uint8Array.from([14])];
  for (let g = 1; g < n; g++) glyphs.push(box);
  const charStrings = index(glyphs);

  const topBodyLen = 5 + 1;                            // CharStrings offset(17)
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const csOff = header.length + nameIndex.length + topIndexLen + stringIndex.length + gsubrIndex.length;

  const topDict = concat([dictInt5(csOff), [17]]);
  const topIndex = index([topDict]);
  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex, charStrings]);
}

/** A 2-glyph name-keyed CFF whose Private DICT carries defaultWidthX 250 and
 *  nominalWidthX 400, exercising BOTH Type 2 width paths:
 *  gid 0 omits the width operand (-> 250), gid 1 supplies one (-> 400 + 100). */
export function buildWidthCff(): Uint8Array {
  const notdef = Uint8Array.from([14]);                       // endchar, no width operand
  // 100 0 0 rmoveto : three operands where rmoveto needs two, so the leading
  // 100 is the width delta -> nominalWidthX + 100 = 500.
  const wide = Uint8Array.from([239, 139, 139, 21, 14]);
  const charStrings = index([notdef, wide]);

  const privateDict = concat([dictInt5(250), [20], dictInt5(400), [21]]);
  const privLen = privateDict.length;

  const header = Uint8Array.from([1, 0, 4, 2]);
  const nameIndex = index([new TextEncoder().encode('WidthTest')]);
  const stringIndex = index([]);
  const gsubrIndex = index([]);

  // Top DICT: charset(15), CharStrings(17), Private(18) — each a 5-byte int, so
  // the body length is fixed at 23 regardless of the offsets it will carry.
  const topBodyLen = (5 + 1) + (5 + 1) + (5 + 5 + 1);
  const fixed = header.length + nameIndex.length;
  // INDEX = count(2) + offSize(1) + (count+1) offsets + data. One item, and
  // 23+1 fits a byte, so offSize is 1 and the two offsets cost 2 bytes.
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const csOff = fixed + topIndexLen + stringIndex.length + gsubrIndex.length;
  const charsetOff = csOff + charStrings.length;
  const charset = Uint8Array.from([0, 0, 1]);                 // format 0, one SID: gid1 -> SID 1
  const privOff = charsetOff + charset.length;

  const topDict = concat([
    dictInt5(charsetOff), [15],
    dictInt5(csOff), [17],
    dictInt5(privLen), dictInt5(privOff), [18],
  ]);
  if (topDict.length !== topBodyLen) throw new Error('buildWidthCff: Top DICT length mismatch');
  const topIndex = index([topDict]);
  // Both assertions are load-bearing: every offset above was computed from
  // these two lengths, and a mismatch produces a CFF that still parses but
  // reads the wrong bytes.
  if (topIndex.length !== topIndexLen) throw new Error('buildWidthCff: Top INDEX length mismatch');

  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex,
    charStrings, charset, privateDict]);
}
