import { SfntFont } from './sfnt.js';
import { UnsupportedFeatureError } from './errors.js';

export interface SubsetResult {
  bytes: Uint8Array;
  gidMap: Map<number, number>;
}

/** {0} ∪ used, closed over composite-glyph component gids. */
export function glyphClosure(font: SfntFont, used: Iterable<number>): Set<number> {
  const set = new Set<number>([0]);
  for (const g of used) if (Number.isInteger(g) && g >= 0 && g < font.numGlyphs) set.add(g);
  const stack = [...set];
  while (stack.length) {
    const g = stack.pop()!;
    for (const c of font.componentGids(g))
      if (!set.has(c) && c >= 0 && c < font.numGlyphs) { set.add(c); stack.push(c); }
  }
  return set;
}

/** Copy a glyph's bytes, rewriting any composite component gids via `gidMap`. */
export function remapCompositeGlyph(bytes: Uint8Array, gidMap: Map<number, number>): Uint8Array {
  const out = bytes.slice();
  if (out.length < 2) return out;
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (v.getInt16(0) >= 0) return out; // simple/empty glyph
  const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
    X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080;
  let p = 10; // numberOfContours(2) + bbox(8)
  for (;;) {
    const flags = v.getUint16(p); const comp = v.getUint16(p + 2);
    const mapped = gidMap.get(comp);
    if (mapped !== undefined) v.setUint16(p + 2, mapped);
    p += 4;
    p += (flags & ARG_WORDS) ? 4 : 2;
    if (flags & WE_HAVE_A_SCALE) p += 2;
    else if (flags & X_AND_Y_SCALE) p += 4;
    else if (flags & TWO_BY_TWO) p += 8;
    if (!(flags & MORE)) break;
  }
  return out;
}

export function u16b(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; }
export function u32b(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
export function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function pad4b(b: Uint8Array): Uint8Array { const r = b.length % 4; return r ? cat([b, new Uint8Array(4 - r)]) : b; }
function tableChecksum(b: Uint8Array): number {
  const p = pad4b(b); const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let sum = 0; for (let i = 0; i < p.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum >>> 0;
}
/** The sfnt version tag of a CFF-outlined OpenType font. */
export const OTTO_TAG = 0x4f54544f;

export function assembleSfnt(
  tables: { tag: string; data: Uint8Array }[],
  sfntVersion = 0x00010000,
): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  let offset = 12 + numTables * 16;
  const placed = sorted.map((t) => {
    const at = offset; const padded = pad4b(t.data); offset += padded.length;
    return { tag: t.tag, at, length: t.data.length, padded, checksum: tableChecksum(t.data) };
  });
  const offsetTable = cat([u32b(sfntVersion), u16b(numTables), u16b(0), u16b(0), u16b(0)]);
  const dir = cat(placed.map((p) => cat([new TextEncoder().encode(p.tag), u32b(p.checksum), u32b(p.at), u32b(p.length)])));
  const font = cat([offsetTable, dir, ...placed.map((p) => p.padded)]);
  const fv = new DataView(font.buffer, font.byteOffset, font.byteLength);
  let sum = 0; for (let i = 0; i < font.length; i += 4) sum = (sum + fv.getUint32(i)) >>> 0;
  const head = placed.find((p) => p.tag === 'head');
  if (head) fv.setUint32(head.at + 8, (0xB1B0AFBA - sum) >>> 0); // checkSumAdjustment
  return font;
}

/** Build a minimal valid glyf sfnt containing the closure of `used` glyphs,
 *  returning the subset bytes and an original->subset gid map. */
export function subsetGlyf(font: SfntFont, used: Iterable<number>): SubsetResult {
  if (font.outlines !== 'glyf') throw new UnsupportedFeatureError('subsetGlyf requires a glyf-outline font');
  const order = [...glyphClosure(font, used)].sort((a, b) => a - b);
  const gidMap = new Map<number, number>();
  order.forEach((g, i) => gidMap.set(g, i));
  const n = order.length;

  // glyf + loca (each glyph padded to even length for short-loca compatibility).
  const parts: Uint8Array[] = []; const offsets: number[] = [0]; let off = 0;
  for (const origGid of order) {
    let g = remapCompositeGlyph(font.glyphData(origGid), gidMap);
    if (g.length % 2) g = cat([g, new Uint8Array(1)]);
    parts.push(g); off += g.length; offsets.push(off);
  }
  const glyf = cat(parts);
  const longLoca = off > 0x1fffe;
  const loca = cat(offsets.map((o) => (longLoca ? u32b(o) : u16b(o / 2))));

  const head = font.table('head')!.slice();
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hv.setUint32(8, 0);                  // checkSumAdjustment recomputed at assembly
  hv.setInt16(50, longLoca ? 1 : 0);   // indexToLocFormat

  const maxp = font.table('maxp')!.slice();
  new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, n);

  const hhea = font.table('hhea')!.slice();
  new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, n);

  const hmtx = new Uint8Array(n * 4); const mv = new DataView(hmtx.buffer);
  order.forEach((origGid, i) => { mv.setUint16(i * 4, font.advanceWidth(origGid) & 0xffff); mv.setInt16(i * 4 + 2, 0); });

  const bytes = assembleSfnt([
    { tag: 'glyf', data: glyf }, { tag: 'head', data: head }, { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx }, { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp },
  ]);
  return { bytes, gidMap };
}
