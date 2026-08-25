import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { readFontNames } from './fontnames.js';
import { extractTtcFace } from './ttc.js';
import { parseOtLayout, type OtLayout } from './otlayout.js';
import { sfntFromWoff } from './woff.js';
import { isType1 } from './type1header.js';
import { sfntFromType1 } from './type1cff.js';
import { isDfont, extractDfontFace } from './dfont.js';

export type OutlineKind = 'glyf' | 'cff';

/** One on/off-curve point of a glyph contour, in font design units (y-up). */
export interface GlyphPoint { x: number; y: number; on: boolean; }

interface TableRec { offset: number; length: number; }

const f2dot14 = (n: number): number => n / 16384;

class Reader {
  private view: DataView;
  constructor(public bytes: Uint8Array, public pos = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new PdfParseError('unexpected end of font data', this.pos);
  }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  tag(): string { this.need(4); const s = String.fromCharCode(...this.bytes.subarray(this.pos, this.pos + 4)); this.pos += 4; return s; }
}

export class SfntFont {
  readonly outlines: OutlineKind;
  readonly raw: Uint8Array;
  /** @internal */ readonly tables: Map<string, TableRec>;
  numGlyphs = 0;
  unitsPerEm = 1000;
  indexToLocFormat: 0 | 1 = 0;
  bbox: [number, number, number, number] = [0, 0, 0, 0];
  /** @internal advance widths per gid (font units), one per long horizontal metric. */
  advances: number[] = [];
  /** @internal code point -> gid, from the best available Unicode cmap subtable. */
  cmap: Map<number, number> = new Map();
  /** @internal numGlyphs+1 byte offsets into the glyf table (glyf fonts only). */
  loca: number[] = [];
  /** @internal the raw glyf table bytes (glyf fonts only). */
  glyf: Uint8Array = new Uint8Array(0);
  ascent = 0; descent = 0; capHeight = 0; xHeight = 0; italicAngle = 0; flags = 0; stemV = 0;
  /** @internal `post` underline metrics in font units; 0 when the table is absent. */
  underlinePosition = 0; underlineThickness = 0;
  /** @internal OS/2 strikeout metrics in font units; 0 when the table is absent. */
  strikeoutPosition = 0; strikeoutSize = 0;
  postScriptName: string | undefined;

  /** Raw glyf bytes for `gid` (empty for `.notdef`, empty glyphs, or CFF fonts). */
  glyphData(gid: number): Uint8Array {
    if (this.outlines !== 'glyf' || gid < 0 || gid + 1 >= this.loca.length) return new Uint8Array(0);
    return this.glyf.subarray(this.loca[gid], this.loca[gid + 1]);
  }

  /** Component gids of a composite glyph (`[]` for simple or empty glyphs). */
  componentGids(gid: number): number[] {
    const g = this.glyphData(gid);
    if (g.length < 2) return [];
    const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
    if (v.getInt16(0) >= 0) return []; // simple glyph
    const ARG_WORDS = 0x0001, WE_HAVE_A_SCALE = 0x0008, MORE = 0x0020,
      X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080;
    const gids: number[] = [];
    let p = 10; // skip numberOfContours(2) + bbox(8)
    for (;;) {
      const flags = v.getUint16(p); const glyphIndex = v.getUint16(p + 2);
      gids.push(glyphIndex);
      p += 4;
      p += (flags & ARG_WORDS) ? 4 : 2;
      if (flags & WE_HAVE_A_SCALE) p += 2;
      else if (flags & X_AND_Y_SCALE) p += 4;
      else if (flags & TWO_BY_TWO) p += 8;
      if (!(flags & MORE)) break;
    }
    return gids;
  }

  /** Decode a glyph's outline to contours of on/off-curve points (font units,
   *  y-up). Resolves composite glyphs recursively (transform + offset). Returns
   *  `[]` for empty glyphs, CFF fonts, or on malformed data. */
  glyphOutline(gid: number, depth = 0): GlyphPoint[][] {
    if (this.outlines !== 'glyf' || depth > 6) return [];
    const g = this.glyphData(gid);
    if (g.length < 10) return [];
    const v = new DataView(g.buffer, g.byteOffset, g.byteLength);
    const numContours = v.getInt16(0);
    try {
      return numContours < 0 ? this.decodeComposite(g, v, depth) : this.decodeSimple(g, v, numContours);
    } catch { return []; }
  }

  private decodeSimple(g: Uint8Array, v: DataView, numContours: number): GlyphPoint[][] {
    let p = 10;
    const ends: number[] = [];
    for (let i = 0; i < numContours; i++) { ends.push(v.getUint16(p)); p += 2; }
    const numPoints = numContours === 0 ? 0 : ends[numContours - 1] + 1;
    p += 2 + v.getUint16(p);                       // skip instructions

    const flags: number[] = [];
    while (flags.length < numPoints) {
      const f = g[p++]; flags.push(f);
      if (f & 0x08) { let rep = g[p++]; while (rep-- > 0) flags.push(f); }
    }
    const xs: number[] = []; let x = 0;
    for (const f of flags) {
      if (f & 0x02) { const dx = g[p++]; x += (f & 0x10) ? dx : -dx; }
      else if (!(f & 0x10)) { x += v.getInt16(p); p += 2; }
      xs.push(x);
    }
    const ys: number[] = []; let y = 0;
    for (const f of flags) {
      if (f & 0x04) { const dy = g[p++]; y += (f & 0x20) ? dy : -dy; }
      else if (!(f & 0x20)) { y += v.getInt16(p); p += 2; }
      ys.push(y);
    }
    const contours: GlyphPoint[][] = [];
    let s = 0;
    for (const e of ends) {
      const pts: GlyphPoint[] = [];
      for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
      if (pts.length) contours.push(pts);
      s = e + 1;
    }
    return contours;
  }

  private decodeComposite(g: Uint8Array, v: DataView, depth: number): GlyphPoint[][] {
    const ARG_WORDS = 0x0001, ARGS_XY = 0x0002, WE_HAVE_A_SCALE = 0x0008,
      MORE = 0x0020, X_AND_Y_SCALE = 0x0040, TWO_BY_TWO = 0x0080;
    const out: GlyphPoint[][] = [];
    let p = 10;
    for (;;) {
      const flags = v.getUint16(p); const gi = v.getUint16(p + 2); p += 4;
      let arg1: number, arg2: number;
      if (flags & ARG_WORDS) { arg1 = v.getInt16(p); arg2 = v.getInt16(p + 2); p += 4; }
      else { arg1 = (g[p] << 24) >> 24; arg2 = (g[p + 1] << 24) >> 24; p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      if (flags & WE_HAVE_A_SCALE) { a = d = f2dot14(v.getInt16(p)); p += 2; }
      else if (flags & X_AND_Y_SCALE) { a = f2dot14(v.getInt16(p)); d = f2dot14(v.getInt16(p + 2)); p += 4; }
      else if (flags & TWO_BY_TWO) { a = f2dot14(v.getInt16(p)); b = f2dot14(v.getInt16(p + 2)); c = f2dot14(v.getInt16(p + 4)); d = f2dot14(v.getInt16(p + 6)); p += 8; }
      const dx = (flags & ARGS_XY) ? arg1 : 0, dy = (flags & ARGS_XY) ? arg2 : 0;
      for (const contour of this.glyphOutline(gi, depth + 1)) {
        out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      }
      if (!(flags & MORE)) break;
    }
    return out;
  }

  /** Glyph id for a Unicode code point, or `undefined` if unmapped. */
  cmapLookup(cp: number): number | undefined { return this.cmap.get(cp); }

  /** @internal (platform<<16|encoding) -> subtable offset, built on first use. */
  private _cmapDir?: Map<number, number>;
  /** @internal parsed subtables, keyed like {@link _cmapDir}. */
  private readonly _cmapSubs = new Map<number, Map<number, number>>();

  /**
   * The code->gid map of one *named* cmap subtable, or `undefined` when the font
   * has no such (platform, encoding) pair. Unlike {@link cmap}, which resolves to
   * whichever subtable is the best *Unicode* source, this returns exactly the one
   * asked for — simple-font code->GID chains are defined per encoding, so they
   * must know which subtable they are reading. Parsed lazily and cached.
   */
  cmapSubtable(platform: number, encoding: number): Map<number, number> | undefined {
    const key = (platform << 16) | encoding;
    const cached = this._cmapSubs.get(key);
    if (cached) return cached;
    const data = this.table('cmap', false);
    if (!data) return undefined;
    if (!this._cmapDir) {
      this._cmapDir = new Map();
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const n = v.getUint16(2);
      for (let i = 0; i < n; i++) {
        const rec = 4 + i * 8;
        const k = (v.getUint16(rec) << 16) | v.getUint16(rec + 2);
        if (!this._cmapDir.has(k)) this._cmapDir.set(k, v.getUint32(rec + 4));
      }
    }
    const off = this._cmapDir.get(key);
    if (off === undefined) return undefined;
    const m = parseCmapSubtable(data, off);
    this._cmapSubs.set(key, m);
    return m;
  }

  /** @internal `post` glyph names, or null once a table without them was seen. */
  private _postNames?: (string | undefined)[] | null;

  /**
   * Glyph names from a `post` v2.0 table, indexed by gid, or `undefined` when the
   * font carries none (v3.0, the common case for subset fonts). Glyphs named
   * through the Macintosh standard ordering are left `undefined`: those names are
   * all in the Adobe Glyph List, so a name->Unicode->cmap chain already resolves
   * them, and this table exists for the custom names that chain cannot answer.
   */
  postNames(): (string | undefined)[] | undefined {
    if (this._postNames === undefined) this._postNames = readPostNames(this.table('post', false)) ?? null;
    return this._postNames ?? undefined;
  }

  /** gid -> first code point that maps to it (for building /ToUnicode). */
  cmapReverse(): Map<number, number> {
    const rev = new Map<number, number>();
    for (const [cp, gid] of this.cmap) if (!rev.has(gid)) rev.set(gid, cp);
    return rev;
  }

  /** Advance width of `gid` in font units. For gids past the last long metric,
   *  returns the last advance (the monospace tail rule). */
  advanceWidth(gid: number): number {
    if (this.advances.length === 0) return 0;
    const i = Math.min(gid, this.advances.length - 1);
    return this.advances[i] ?? this.advances[this.advances.length - 1];
  }

  /** @internal Lazily-parsed & cached OpenType layout tables (GDEF/GSUB/GPOS),
   *  or `undefined` if the font carries none. */
  private _otLayout?: OtLayout | null;
  otLayout(): OtLayout | undefined {
    if (this._otLayout === undefined) this._otLayout = parseOtLayout(this) ?? null;
    return this._otLayout ?? undefined;
  }

  constructor(bytes: Uint8Array) {
    this.raw = bytes;
    const r = new Reader(bytes);
    const version = r.u32();
    if (version === 0x74727565 /* 'true' */ || version === 0x00010000) { /* TrueType */ }
    else if (version === 0x4F54544F /* 'OTTO' */) { /* OpenType CFF */ }
    else if (version === 0x774F4646 /* 'wOFF' */ || version === 0x774F4632 /* 'wOF2' */)
      throw new UnsupportedFeatureError('WOFF/WOFF2 fonts are not supported; provide a raw sfnt (.ttf/.otf)');
    else throw new PdfParseError(`unrecognized sfnt version 0x${version.toString(16)}`, 0);

    const numTables = r.u16();
    r.u16(); r.u16(); r.u16(); // searchRange, entrySelector, rangeShift (ignored)
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const tag = r.tag(); r.u32(); // checksum (ignored)
      const offset = r.u32(); const length = r.u32();
      this.tables.set(tag, { offset, length });
    }
    this.outlines = this.tables.has('CFF ') ? 'cff' : 'glyf';
    if (this.outlines === 'glyf' && !this.tables.has('glyf'))
      throw new PdfParseError('font has neither a glyf nor a CFF table');
  }

  /** @internal Return a table's bytes, or throw if a required table is absent. */
  table(tag: string, required = true): Uint8Array | undefined {
    const rec = this.tables.get(tag);
    if (!rec) { if (required) throw new PdfParseError(`missing required '${tag}' table`); return undefined; }
    if (rec.offset + rec.length > this.raw.length) throw new PdfParseError(`'${tag}' table out of bounds`, rec.offset);
    return this.raw.subarray(rec.offset, rec.offset + rec.length);
  }
}

function parseCmapSubtable(data: Uint8Array, base: number): Map<number, number> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = v.getUint16(base);
  const out = new Map<number, number>();
  if (format === 0) {
    for (let c = 0; c < 256; c++) {
      const gid = v.getUint8(base + 6 + c);
      if (gid !== 0) out.set(c, gid);
    }
  } else if (format === 6) {
    const first = v.getUint16(base + 6); const count = v.getUint16(base + 8);
    for (let i = 0; i < count; i++) {
      const gid = v.getUint16(base + 10 + i * 2);
      if (gid !== 0) out.set(first + i, gid);
    }
  } else if (format === 4) {
    const segX2 = v.getUint16(base + 6); const segCount = segX2 / 2;
    const endBase = base + 14;
    const startBase = endBase + segX2 + 2;        // + reservedPad
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let s = 0; s < segCount; s++) {
      const end = v.getUint16(endBase + s * 2);
      const start = v.getUint16(startBase + s * 2);
      const delta = v.getUint16(deltaBase + s * 2);
      const rangeOff = v.getUint16(rangeBase + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let gid: number;
        if (rangeOff === 0) gid = (c + delta) & 0xffff;
        else {
          const gi = v.getUint16(rangeBase + s * 2 + rangeOff + (c - start) * 2);
          gid = gi === 0 ? 0 : (gi + delta) & 0xffff;
        }
        if (gid !== 0) out.set(c, gid);
      }
    }
  } else if (format === 12) {
    const nGroups = v.getUint32(base + 12);
    let g = base + 16;
    for (let i = 0; i < nGroups; i++) {
      const startChar = v.getUint32(g); const endChar = v.getUint32(g + 4); const startGid = v.getUint32(g + 8);
      for (let c = startChar; c <= endChar; c++) out.set(c, startGid + (c - startChar));
      g += 12;
    }
  }
  return out;
}

function readCmap(data: Uint8Array): Map<number, number> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = v.getUint16(2);
  const candidates: { score: number; offset: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 4 + i * 8;
    const plat = v.getUint16(rec); const enc = v.getUint16(rec + 2); const off = v.getUint32(rec + 4);
    let score = -1;
    if (plat === 3 && enc === 10) score = 4;       // Windows UCS-4
    else if (plat === 3 && enc === 1) score = 3;   // Windows BMP
    else if (plat === 0) score = 2;                // Unicode
    else if (plat === 3 && enc === 0) score = 1;   // Windows Symbol
    if (score >= 0) candidates.push({ score, offset: off });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    const m = parseCmapSubtable(data, c.offset);
    if (m.size > 0) return m;
  }
  return new Map();
}

/** Read `post` v2.0 glyph names. Indices below 258 select a Macintosh standard
 *  name and are left `undefined` — see {@link SfntFont.postNames}. */
function readPostNames(data: Uint8Array | undefined): (string | undefined)[] | undefined {
  if (!data || data.length < 34) return undefined;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0) !== 0x00020000) return undefined;
  const numGlyphs = v.getUint16(32);
  if (34 + numGlyphs * 2 > data.length) return undefined;

  const custom: string[] = [];
  for (let p = 34 + numGlyphs * 2; p < data.length;) {
    const len = data[p];
    if (p + 1 + len > data.length) break;
    custom.push(String.fromCharCode(...data.subarray(p + 1, p + 1 + len)));
    p += 1 + len;
  }

  const names: (string | undefined)[] = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    const idx = v.getUint16(34 + gid * 2);
    names.push(idx >= 258 ? custom[idx - 258] : undefined);
  }
  return names;
}

/**
 * Parse an sfnt, a WOFF/WOFF2 wrapper, or one face of a `.ttc`/`.otc`.
 *
 * `faceIndex` selects the face of a COLLECTION and is ignored for anything
 * else — a caller may not know which kind of file it was handed, so naming a
 * face of a plain font is meaningless rather than an error.
 */
export function parseSfnt(bytes: Uint8Array, faceIndex = 0): SfntFont {
  const sig = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (sig === 0x774f4646 /* wOFF */ || sig === 0x774f4632 /* wOF2 */) bytes = sfntFromWoff(bytes);
  // A collection is rebuilt into a standalone sfnt before anything else sees
  // it — see ttc.ts for why reading one in place would be a trap.
  else if (sig === 0x74746366 /* ttcf */) bytes = extractTtcFace(bytes, faceIndex);
  // A Type 1 is converted to OpenType-CFF for the same reason: everything
  // downstream then sees an ordinary sfnt. faceIndex is ignored — a Type 1
  // holds exactly one face.
  else if (isType1(bytes)) bytes = sfntFromType1(bytes);
  // A .dfont carries no signature, so this is a structural walk rather than a
  // u32 compare — which is why it goes LAST, after every cheap test. A face is
  // a subarray of one `sfnt` resource; see dfont.ts for why nothing is rebuilt.
  else if (isDfont(bytes)) bytes = extractDfontFace(bytes, faceIndex);
  const f = new SfntFont(bytes);
  const maxp = f.table('maxp')!;
  f.numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4);

  const head = f.table('head')!;
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  f.unitsPerEm = hv.getUint16(18) || 1000;
  f.bbox = [hv.getInt16(36), hv.getInt16(38), hv.getInt16(40), hv.getInt16(42)];
  f.indexToLocFormat = hv.getInt16(50) === 1 ? 1 : 0;

  const hhea = f.table('hhea')!;
  const numberOfHMetrics = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34);
  const hmtx = f.table('hmtx')!;
  const mv = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength);
  for (let i = 0; i < numberOfHMetrics; i++) f.advances.push(mv.getUint16(i * 4));

  const cmapTable = f.table('cmap', false); // optional: subset fonts carry no cmap
  if (cmapTable) f.cmap = readCmap(cmapTable);

  if (f.outlines === 'glyf') {
    const locaBytes = f.table('loca')!;
    const lv = new DataView(locaBytes.buffer, locaBytes.byteOffset, locaBytes.byteLength);
    for (let i = 0; i <= f.numGlyphs; i++)
      f.loca.push(f.indexToLocFormat === 0 ? lv.getUint16(i * 2) * 2 : lv.getUint32(i * 4));
    f.glyf = f.table('glyf')!;
  }

  // Through fontnames.ts, the one owner of the name table: two readings would
  // otherwise be free to disagree about platform preference or UTF-16 decoding.
  f.postScriptName = readFontNames(bytes)?.postScriptName;

  const macStyle = hv.getUint16(44);

  const os2 = f.table('OS/2', false);
  let weight = 400;
  if (os2) {
    const ov = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    const ver = ov.getUint16(0);
    weight = ov.getUint16(4) || 400;
    f.ascent = ov.getInt16(68);
    f.descent = ov.getInt16(70);
    f.capHeight = ver >= 2 && os2.length >= 90 ? ov.getInt16(88) : Math.round(f.ascent * 0.7);
    // sxHeight sits at 86, sCapHeight at 88; both are version 2 and later only.
    // Zero means "the table said nothing", which callers fall back from.
    f.xHeight = ver >= 2 && os2.length >= 90 ? ov.getInt16(86) : 0;
    if (os2.length >= 30) {
      f.strikeoutSize = ov.getInt16(26);
      f.strikeoutPosition = ov.getInt16(28);
    }
  } else {
    f.ascent = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getInt16(4);
    f.descent = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getInt16(6);
    f.capHeight = Math.round(f.ascent * 0.7);
    f.xHeight = 0;
  }

  const post = f.table('post', false);
  if (post) {
    const pv = new DataView(post.buffer, post.byteOffset, post.byteLength);
    f.italicAngle = pv.getInt32(4) / 65536; // 16.16 fixed
    if (post.length >= 12) {
      f.underlinePosition = pv.getInt16(8);
      f.underlineThickness = pv.getInt16(10);
    }
  }

  const italic = (macStyle & 0x02) !== 0 || f.italicAngle !== 0;
  f.flags = 32 /* Nonsymbolic */ | (italic ? 64 /* Italic */ : 0);
  f.stemV = Math.max(50, Math.round((weight / 1000) * 220)); // approximation

  return f;
}
