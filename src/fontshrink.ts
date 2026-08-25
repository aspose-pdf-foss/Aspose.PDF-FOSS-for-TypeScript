import { SfntFont } from './sfnt.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { glyphClosure, assembleSfnt, cat, u16b, u32b } from './subset.js';
import { CffFont, bias, readIndex, parseDict, op1 } from './cff.js';
import {
  parseCffProgram, flattenGlyph, assembleCidCff, parseDictSpans, writeIndex, DictSpan,
} from './cffsubset.js';

/** Tables carrying no information needed to render already-positioned text:
 *  layout (GSUB/GPOS/GDEF/BASE/JSTF/kern), hinting/device metrics
 *  (hdmx/VDMX/LTSH/gasp/PCLT), embedded bitmaps (EBDT/EBLC/CBDT/CBLC/sbix),
 *  colour/vector extras (SVG /MATH), and the signature (DSIG).
 *  Note: 'SVG ' is space-padded to four characters, as sfnt tags always are. */
export const DROP_TABLES: ReadonlySet<string> = new Set([
  'GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'DSIG', 'kern', 'hdmx', 'VDMX',
  'LTSH', 'PCLT', 'gasp', 'EBDT', 'EBLC', 'CBDT', 'CBLC', 'sbix', 'SVG ', 'MATH',
]);

export interface ShrinkResult {
  bytes: Uint8Array;
  gidsKept: number;
  gidsDropped: number;
}

export interface ShrinkOptions {
  /** Rewrite a `post` v2.0 table to v3.0, discarding its glyph names. Only set
   *  this where nothing can resolve a glyph by name — a nonsymbolic simple
   *  TrueType font resolves `/Differences` names outside the AGL through `post`
   *  (PDF 32000 9.6.6.4), and dropping them there shows the wrong glyph.
   *  See `nameResolvingPrograms` in optimize.ts. */
  dropGlyphNames?: boolean;
}

/** Rewrite a `post` v2.0 table as v3.0: the same 32-byte header, without the
 *  glyph-name index and string pool that follow it. On a large face that pool
 *  runs to tens of kilobytes.
 *
 *  `undefined` for every other version, leaving the caller to keep the table
 *  verbatim: v3.0 is already nameless, v1.0 names glyphs by the implied
 *  Macintosh ordering, and v2.5/v4.0 carry no pool this could drop. Returning
 *  `undefined` rather than guessing also makes a second `Optimize` a no-op. */
function rewritePostV3(post: Uint8Array): Uint8Array | undefined {
  if (post.length < 32) return undefined;
  const v = new DataView(post.buffer, post.byteOffset, post.byteLength);
  if (v.getUint32(0) !== 0x00020000) return undefined;
  const out = post.slice(0, 32);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, 0x00030000);
  return out;
}

/**
 * Sparse-shrink a glyf font: keep `numGlyphs` and GID numbering, blank the
 * outlines of glyphs outside `keep` (closed over composite components), and drop
 * DROP_TABLES. cmap/hmtx/hhea/maxp are copied verbatim, so every existing
 * code->GID mapping in the document stays valid without any rewrite. `post` is
 * copied verbatim too unless `opts.dropGlyphNames` says its names are provably
 * unused.
 */
export function shrinkGlyf(font: SfntFont, keep: Set<number>, opts: ShrinkOptions = {}): ShrinkResult {
  const closure = glyphClosure(font, keep);

  // glyf + loca, same entry count; dropped glyphs become zero-length.
  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  let off = 0;
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    let g = closure.has(gid) ? font.glyphData(gid) : new Uint8Array(0);
    if (g.length % 2) g = cat([g, new Uint8Array(1)]); // even-align for short loca
    parts.push(g); off += g.length; offsets.push(off);
  }
  const glyf = cat(parts);
  const longLoca = off > 0x1fffe;
  const loca = cat(offsets.map((o) => (longLoca ? u32b(o) : u16b(o / 2))));

  const head = font.table('head')!.slice();
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  hv.setUint32(8, 0);                  // checkSumAdjustment recomputed at assembly
  hv.setInt16(50, longLoca ? 1 : 0);   // indexToLocFormat

  const tables: { tag: string; data: Uint8Array }[] = [];
  for (const tag of font.tables.keys()) {
    if (DROP_TABLES.has(tag) || tag === 'glyf' || tag === 'loca' || tag === 'head') continue;
    const data = font.table(tag, false);
    if (!data) continue;
    if (tag === 'post' && opts.dropGlyphNames) {
      const v3 = rewritePostV3(data);
      if (v3) { tables.push({ tag, data: v3 }); continue; }
    }
    tables.push({ tag, data: data.slice() });
  }
  tables.push({ tag: 'glyf', data: glyf }, { tag: 'loca', data: loca }, { tag: 'head', data: head });

  return {
    bytes: assembleSfnt(tables),
    gidsKept: closure.size,
    gidsDropped: font.numGlyphs - closure.size,
  };
}

/** A bare Type2 `endchar` — a valid, empty outline. */
const ENDCHAR = Uint8Array.from([14]);

/** CFF DICT integer, fixed 5-byte form (29 + int32) — constant width, so a DICT's
 *  length is known before the offsets it carries are. */
function dictInt5(n: number): Uint8Array {
  const b = new Uint8Array(5); b[0] = 29; new DataView(b.buffer).setUint32(1, n >>> 0); return b;
}

/** Re-emit one DICT span: its operands, then its operator. */
function emitSpan(op: number, operands: Uint8Array): Uint8Array {
  const tail = op > 0xc00 ? Uint8Array.from([12, op & 0xff]) : Uint8Array.from([op]);
  return cat([operands, tail]);
}

/**
 * Byte length of a charset at `off`. Predefined charsets (0/1/2) occupy no bytes.
 * Format 0 is one u16 per glyph after .notdef; formats 1/2 are ranges walked
 * until every glyph is covered.
 */
function charsetLength(v: DataView, off: number, numGlyphs: number): number {
  if (off <= 2) return 0;
  const format = v.getUint8(off);
  if (format === 0) return 1 + 2 * (numGlyphs - 1);
  if (format === 1 || format === 2) {
    let p = off + 1, covered = 1;
    while (covered < numGlyphs) {
      const nLeft = format === 1 ? v.getUint8(p + 2) : v.getUint16(p + 2);
      p += format === 1 ? 3 : 4;
      covered += nLeft + 1;
    }
    return p - off;
  }
  throw new UnsupportedFeatureError(`CFF charset format ${format} unsupported`);
}

/** Byte length of an Encoding at `off`. Predefined encodings (0/1) occupy none. */
function encodingLength(v: DataView, off: number): number {
  if (off <= 1) return 0;
  const b0 = v.getUint8(off);
  const format = b0 & 0x7f;
  let len: number;
  if (format === 0) len = 2 + v.getUint8(off + 1);              // format, nCodes, codes
  else if (format === 1) len = 2 + 2 * v.getUint8(off + 1);     // format, nRanges, (first,nLeft)*
  else throw new UnsupportedFeatureError(`CFF Encoding format ${format} unsupported`);
  if (b0 & 0x80) len += 1 + 3 * v.getUint8(off + len);          // nSups, (code,SID)*
  return len;
}

/**
 * Sparse-shrink a **name-keyed** CFF (`FontFile3` `/Subtype /Type1C`): keep
 * `numGlyphs` and GID numbering, replace the charstrings of glyphs outside `keep`
 * with a bare `endchar`, and re-assemble preserving every structure a simple font
 * dict's code -> name -> GID chain runs through.
 *
 * This exists because `shrinkCff` cannot serve here. It re-assembles through
 * `assembleCidCff`, which emits a CID-keyed program: a `/ROS`, a charset
 * publishing integer CIDs, FDArray/FDSelect, and a String INDEX holding only
 * `Adobe`/`Identity`. That is right for `CIDFontType0C`, where the viewer resolves
 * CID -> charset -> GID. Handed to a viewer under a *simple* font dict it is
 * invalid, not merely lossy: every glyph name and the built-in encoding are gone,
 * and the chain the dict actually follows has nothing left to resolve against.
 *
 * charset and Encoding are copied as raw bytes rather than re-emitted from a
 * parse: re-emitting a charset as format 0 inflates a range-coded one, and no
 * Encoding format can express a glyph that has no code. The Top DICT is rebuilt
 * from byte spans so reals (`FontMatrix`) and unknown operators survive, with only
 * the four offset operators rewritten — each in fixed 5-byte form, so the DICT's
 * length is settled before its offsets are and the program lays out in one pass.
 */
export function shrinkNameKeyedCff(cff: Uint8Array, keep: Set<number>): ShrinkResult {
  const v = new DataView(cff.buffer, cff.byteOffset, cff.byteLength);
  const prog = parseCffProgram(cff);
  if (prog.isCID) throw new UnsupportedFeatureError('shrinkNameKeyedCff: program is CID-keyed');

  const hdrSize = v.getUint8(2);
  let p = hdrSize;
  const nameIdx = readIndex(cff, v, p); p = nameIdx.end;
  const topIdx = readIndex(cff, v, p); p = topIdx.end;
  const stringIdx = readIndex(cff, v, p);
  const top = parseDict(topIdx.items[0]);

  // Charstrings: flatten what we keep (subrs are dropped below), blank the rest.
  const globalBias = bias(prog.globalSubrs.length);
  const charStrings: Uint8Array[] = [];
  let kept = 0;
  for (let gid = 0; gid < prog.numGlyphs; gid++) {
    if (gid !== 0 && !keep.has(gid)) { charStrings.push(ENDCHAR); continue; }
    const localSubrs = prog.localSubrsOf(prog.fdOf(gid));
    charStrings.push(flattenGlyph(prog.charStrings[gid], {
      localSubrs, localBias: bias(localSubrs.length),
      globalSubrs: prog.globalSubrs, globalBias,
    }));
    kept++;
  }

  // Raw regions carried over untouched.
  const charsetOff = op1(top, 15) ?? 0;
  const encodingOff = op1(top, 16) ?? 0;
  const charset = charsetOff > 2
    ? cff.subarray(charsetOff, charsetOff + charsetLength(v, charsetOff, prog.numGlyphs))
    : undefined;
  const encoding = encodingOff > 1
    ? cff.subarray(encodingOff, encodingOff + encodingLength(v, encodingOff))
    : undefined;

  // Private DICT: copied, minus Subrs (19) — the charstrings no longer call any.
  const priv = top.get(18);
  let privateDict: Uint8Array | undefined;
  if (priv && priv.length >= 2 && priv[0] > 0) {
    const body = cff.subarray(priv[1], priv[1] + priv[0]);
    privateDict = cat(parseDictSpans(body)
      .filter((s) => s.op !== 19)
      .map((s) => emitSpan(s.op, s.operands)));
  }

  const header = cff.subarray(0, hdrSize);
  const name = writeIndex(nameIdx.items);
  const strings = writeIndex(stringIdx.items);          // verbatim: keeps every SID >= 391 valid
  const gsubr = writeIndex([]);
  const cs = writeIndex(charStrings);

  // Rewrite only the offset-bearing operators; copy every other span verbatim.
  const rewritten = new Set([15, 16, 17, 18]);
  const carried: DictSpan[] = parseDictSpans(topIdx.items[0]).filter((s) => !rewritten.has(s.op));
  const carriedBytes = cat(carried.map((s) => emitSpan(s.op, s.operands)));

  const topLen = carriedBytes.length
    + (charset ? 6 : 0) + (encoding ? 6 : 0) + 6      // charset, Encoding, CharStrings
    + (privateDict ? 11 : 0);                          // Private [size, offset]
  const topIndexLen = 2 + 1 + 2 + topLen;              // 1 item, offSize 1
  const prefixLen = header.length + name.length + topIndexLen + strings.length + gsubr.length;

  const csOff = prefixLen;
  const charsetNewOff = csOff + cs.length;
  const encodingNewOff = charsetNewOff + (charset?.length ?? 0);
  const privNewOff = encodingNewOff + (encoding?.length ?? 0);

  const parts: Uint8Array[] = [carriedBytes];
  if (charset) parts.push(dictInt5(charsetNewOff), Uint8Array.from([15]));
  if (encoding) parts.push(dictInt5(encodingNewOff), Uint8Array.from([16]));
  parts.push(dictInt5(csOff), Uint8Array.from([17]));
  if (privateDict) parts.push(dictInt5(privateDict.length), dictInt5(privNewOff), Uint8Array.from([18]));
  const topDict = cat(parts);
  if (topDict.length !== topLen) throw new PdfParseError('CFF name-keyed shrink: Top DICT length mismatch');

  const bytes = cat([
    header, name, writeIndex([topDict]), strings, gsubr, cs,
    ...(charset ? [charset] : []), ...(encoding ? [encoding] : []),
    ...(privateDict ? [privateDict] : []),
  ]);

  return { bytes, gidsKept: kept, gidsDropped: prog.numGlyphs - kept };
}

/**
 * Sparse-shrink a CFF program: keep `numGlyphs` and GID numbering, replace the
 * charstrings of glyphs outside `keep` with a bare `endchar`, and re-emit the
 * original charset so CID->GID resolution is unchanged. Kept charstrings are
 * flattened (subrs inlined) because assembleCidCff emits empty subr INDEXes.
 *
 * CFF has no composite glyphs (`seac` is legacy and already flattened by
 * flattenGlyph), so no closure pass is needed — unlike glyf.
 */
export function shrinkCff(cff: Uint8Array, keep: Set<number>): ShrinkResult {
  const prog = parseCffProgram(cff);
  const font = new CffFont(cff);
  const globalBias = bias(prog.globalSubrs.length);

  const charStrings: Uint8Array[] = [];
  let kept = 0;
  for (let gid = 0; gid < prog.numGlyphs; gid++) {
    if (gid !== 0 && !keep.has(gid)) { charStrings.push(ENDCHAR); continue; }
    const localSubrs = prog.localSubrsOf(prog.fdOf(gid));
    charStrings.push(flattenGlyph(prog.charStrings[gid], {
      localSubrs, localBias: bias(localSubrs.length),
      globalSubrs: prog.globalSubrs, globalBias,
    }));
    kept++;
  }

  // charset: subset gid == original gid, so publish each gid's original CID.
  const cidOfGid: number[] = [];
  for (let gid = 0; gid < prog.numGlyphs; gid++) cidOfGid.push(font.gidToCid(gid));

  return {
    bytes: assembleCidCff(prog.nameIndex, charStrings, cidOfGid),
    gidsKept: kept,
    gidsDropped: prog.numGlyphs - kept,
  };
}
