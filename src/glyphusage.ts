import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfDict, PdfObject, PdfStream, isDict, isName, isStream, isArray, isString,
} from './types.js';
import { parseContentStream, ContentOp } from './content.js';
import { contentStreamBytes } from './text.js';
import { decodeStream } from './filters.js';
import { CffFont } from './cff.js';
import { parseSfnt, SfntFont } from './sfnt.js';
import { resolveSimpleEncoding } from './font.js';
import { winAnsi, standardEncoding, glyphToUnicode } from './encoding.js';

/** Glyphs a font actually shows, and whether that set is trustworthy. */
export interface FontUsage {
  gids: Set<number>;
  /** False when some usage site could not be scanned — the font must be skipped. */
  complete: boolean;
  reason?: string;
}

export type UsageMap = Map<PdfDict, FontUsage>;

const MAX_XOBJECT_DEPTH = 8;

/**
 * Resolves character codes to GIDs for one font dict.
 *
 * `gidsOf` returns *every* GID a plausible viewer could show for `code`, not one
 * answer. Simple fonts have several defensible code->GID chains (a symbolic cmap
 * against `/Differences` names; a PDF `/Encoding` against a CFF's built-in one)
 * and viewers disagree on which to follow, so the scan unions them. The union is
 * safe in the only direction that matters: keeping a glyph some chain might show
 * wastes a few bytes, while dropping one blanks a glyph on the page. A chain that
 * fails to resolve is not a hazard — a viewer following it renders `.notdef` —
 * so `undefined`, meaning *no* chain resolved the code, is the only skip trigger.
 */
interface CodeMapper {
  codeWidth: 1 | 2;
  gidsOf(code: number): number[] | undefined;
}

/** Union the answers of several chains; undefined when every one comes up empty. */
function unionChains(chains: ((code: number) => number | undefined)[]): (code: number) => number[] | undefined {
  return (code) => {
    const out: number[] = [];
    for (const chain of chains) {
      const gid = chain(code);
      if (gid !== undefined && !out.includes(gid)) out.push(gid);
    }
    return out.length ? out : undefined;
  };
}

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}

/** Build a code->GID mapper, or a reason the font cannot be handled. */
function buildMapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const subtype = nameOf(doc, font.get('Subtype'));
  if (subtype === 'Type0') return type0Mapper(doc, font);
  if (subtype === 'TrueType') return simpleTrueTypeMapper(doc, font);
  // Type1/MMType1 reach the CFF chain only when the program is a /FontFile3
  // Type1C; a /FontFile PFB has no CFF to resolve against and is reported.
  if (subtype === 'Type1' || subtype === 'MMType1') return simpleCffMapper(doc, font);
  if (subtype === 'Type3') return { reason: 'Type3 font' };
  return { reason: `unsupported font subtype: ${subtype ?? 'none'}` };
}

/** Parse a simple font's embedded sfnt program (/FontFile2, or an /OpenType
 *  /FontFile3 whole-embed). */
function sfntOf(doc: Document, font: PdfDict): { sfnt?: SfntFont; reason?: string } {
  const fd = resolveDict(doc, font.get('FontDescriptor'));
  if (!fd) return { reason: 'font has no FontDescriptor' };

  let stream: PdfStream | undefined;
  const ff2 = doc.resolve(fd.get('FontFile2'));
  if (isStream(ff2)) stream = ff2;
  else {
    const ff3 = doc.resolve(fd.get('FontFile3'));
    if (isStream(ff3) && nameOf(doc, ff3.dict.get('Subtype')) === 'OpenType') stream = ff3;
  }
  if (!stream) return { reason: 'TrueType font program is not embedded' };

  try { return { sfnt: parseSfnt(decodeStream(stream)) }; }
  catch { return { reason: 'font program failed to parse' }; }
}

/** The best Unicode cmap subtable, scored as readCmap does but never falling
 *  back to a (3,0) symbol table — this chain must read Unicode. */
function unicodeCmap(f: SfntFont): Map<number, number> | undefined {
  for (const [plat, enc] of [[3, 10], [3, 1], [0, 6], [0, 4], [0, 3], [0, 2], [0, 1], [0, 0]] as const) {
    const sub = f.cmapSubtable(plat, enc);
    if (sub?.size) return sub;
  }
  return undefined;
}

/** Simple TrueType, PDF 32000 9.6.6.4. Every chain the specification sanctions is
 *  unioned rather than selected between: the `/Flags` symbolic bit is widely
 *  wrong in the wild, and a font can carry both a symbol cmap and a
 *  `/Differences` array. */
function simpleTrueTypeMapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const { sfnt, reason } = sfntOf(doc, font);
  if (!sfnt) return { reason };

  const enc = resolveSimpleEncoding(font, (o) => doc.resolve(o));
  const chains: ((code: number) => number | undefined)[] = [];

  // Symbolic: the code indexes a (3,0) subtable directly, either as-is or in the
  // 0xF0xx private-use block those subtables conventionally occupy.
  const sym = sfnt.cmapSubtable(3, 0);
  if (sym?.size) chains.push((code) => sym.get(code) ?? sym.get(0xf000 | code));

  // Symbolic, Mac flavour: a (1,0) subtable indexed by the raw code.
  const mac = sfnt.cmapSubtable(1, 0);
  if (mac?.size) chains.push((code) => mac.get(code));

  // Nonsymbolic: /Encoding + /Differences -> Unicode -> a Unicode subtable. With
  // no /Encoding the specification says StandardEncoding while producers assume
  // WinAnsi, so both tables are tried.
  const uni = unicodeCmap(sfnt);
  if (uni) {
    const tables = enc.implicit ? [winAnsi, standardEncoding] : [enc.unicode];
    for (const table of tables) {
      chains.push((code) => {
        const s = table[code];
        if (s === undefined || [...s].length !== 1) return undefined;
        return uni.get(s.codePointAt(0)!);
      });
    }
  }

  // Nonsymbolic, names outside the AGL (`g01`, subset-specific names): the glyph
  // name goes to the `post` table, which the Unicode chain cannot answer for.
  const post = sfnt.postNames();
  if (post) {
    const byName = new Map<string, number>();
    post.forEach((n, gid) => { if (n !== undefined && !byName.has(n)) byName.set(n, gid); });
    chains.push((code) => { const n = enc.names[code]; return n === undefined ? undefined : byName.get(n); });
  }

  if (!chains.length) return { reason: 'TrueType font has no usable cmap subtable' };
  return { mapper: { codeWidth: 1, gidsOf: unionChains(chains) } };
}

/** Simple CFF (`/FontFile3` `/Subtype /Type1C`, or an OTTO whole-embed): the
 *  chain runs code -> glyph *name* -> charset -> GID, the opposite direction from
 *  a CID-keyed font. As with TrueType, every defensible chain is unioned rather
 *  than selected between. */
function simpleCffMapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const fd = resolveDict(doc, font.get('FontDescriptor'));
  if (!fd) return { reason: 'font has no FontDescriptor' };
  const ff3 = doc.resolve(fd.get('FontFile3'));
  if (!isStream(ff3)) {
    // A /FontFile PFB is Type1 charstrings, not CFF — nothing here can read it.
    return { reason: isStream(doc.resolve(fd.get('FontFile')))
      ? 'Type1 /FontFile (PFB) has no CFF to resolve against'
      : 'CFF font program is not embedded' };
  }

  let cff: CffFont;
  try { cff = new CffFont(cffBytesOf(ff3)); } catch { return { reason: 'CFF program failed to parse' }; }
  if (cff.isCID) return { reason: 'simple font dict points at a CID-keyed CFF' };

  const names = cff.charsetNames();
  if (!names.length) return { reason: 'CFF charset is predefined or unreadable' };

  const byName = new Map<string, number>();
  names.forEach((n, gid) => { if (n !== undefined && !byName.has(n)) byName.set(n, gid); });

  const byUnicode = new Map<string, number>();
  for (const [n, gid] of byName) {
    const u = glyphToUnicode(n);
    if (u !== undefined && !byUnicode.has(u)) byUnicode.set(u, gid);
  }

  const enc = resolveSimpleEncoding(font, (o) => doc.resolve(o));
  const chains: ((code: number) => number | undefined)[] = [];

  // 1. /Differences name -> charset. Exact: the name is stated, not inferred.
  chains.push((code) => { const n = enc.names[code]; return n === undefined ? undefined : byName.get(n); });

  // 2. code -> Unicode (base encoding) -> a charset name with that Unicode.
  //    Skipped when the dict carries no /Encoding: resolveSimpleEncoding guesses
  //    WinAnsi there, which is wrong for a CFF — the built-in encoding governs,
  //    and chain 3 is the one that speaks for it.
  if (!enc.implicit) {
    chains.push((code) => { const s = enc.unicode[code]; return s === undefined ? undefined : byUnicode.get(s); });
  }

  // 3. The CFF's own built-in Encoding. Exact, and the only chain when the dict
  //    has no /Encoding. Absent for a predefined built-in: Standard is covered by
  //    chain 2 through the AGL, and Expert has no chain here.
  const builtin = cff.builtinEncoding();
  if (builtin) chains.push((code) => builtin.get(code));

  return { mapper: { codeWidth: 1, gidsOf: unionChains(chains) } };
}

function type0Mapper(doc: Document, font: PdfDict): { mapper?: CodeMapper; reason?: string } {
  const encoding = nameOf(doc, font.get('Encoding'));
  if (encoding !== 'Identity-H') {
    return { reason: `Type0 encoding is not Identity-H: ${encoding ?? 'embedded CMap'}` };
  }
  const desc = doc.resolve(font.get('DescendantFonts'));
  const d0 = isArray(desc) ? resolveDict(doc, desc[0]) : undefined;
  if (!d0) return { reason: 'Type0 has no descendant font' };

  const dSub = nameOf(doc, d0.get('Subtype'));
  if (dSub === 'CIDFontType2') {
    const c2g = doc.resolve(d0.get('CIDToGIDMap'));
    if (isStream(c2g)) {
      let map: Uint8Array;
      try { map = decodeStream(c2g); } catch { return { reason: 'CIDToGIDMap stream failed to decode' }; }
      return {
        mapper: {
          codeWidth: 2,
          gidsOf: (cid) => (cid * 2 + 1 < map.length ? [(map[cid * 2] << 8) | map[cid * 2 + 1]] : undefined),
        },
      };
    }
    // /Identity, or absent (which defaults to Identity for CIDFontType2).
    return { mapper: { codeWidth: 2, gidsOf: (cid) => [cid] } };
  }
  if (dSub === 'CIDFontType0') {
    const fd = resolveDict(doc, d0.get('FontDescriptor'));
    const ff3 = fd ? doc.resolve(fd.get('FontFile3')) : undefined;
    if (!isStream(ff3)) return { reason: 'CIDFontType0 has no FontFile3' };
    let cff: CffFont;
    try { cff = new CffFont(cffBytesOf(ff3)); } catch { return { reason: 'CFF program failed to parse' }; }
    return { mapper: { codeWidth: 2, gidsOf: (cid) => [cff.cidToGid(cid)] } };
  }
  return { reason: `unsupported descendant subtype: ${dSub ?? 'none'}` };
}

/** The CFF bytes of a FontFile3 — either a bare CFF or the CFF table of an
 *  OpenType (OTTO) whole-embed. */
function cffBytesOf(ff3: PdfStream): Uint8Array {
  const bytes = decodeStream(ff3);
  // 'OTTO' whole-embed: pull out the 'CFF ' table.
  if (bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = v.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4));
      if (tag === 'CFF ') {
        const off = v.getUint32(rec + 8); const len = v.getUint32(rec + 12);
        return bytes.subarray(off, off + len);
      }
    }
  }
  return bytes;
}

interface Ctx {
  doc: Document;
  usage: UsageMap;
  mappers: Map<PdfDict, CodeMapper | undefined>;
}

function usageFor(ctx: Ctx, font: PdfDict): FontUsage {
  let u = ctx.usage.get(font);
  if (!u) { u = { gids: new Set(), complete: true }; ctx.usage.set(font, u); }
  return u;
}

/** Mark a font unusable, keeping the first reason recorded. */
function markIncomplete(ctx: Ctx, font: PdfDict, reason: string): void {
  const u = usageFor(ctx, font);
  if (u.complete) { u.complete = false; u.reason = reason; }
}

function mapperFor(ctx: Ctx, font: PdfDict): CodeMapper | undefined {
  if (ctx.mappers.has(font)) return ctx.mappers.get(font);
  const { mapper, reason } = buildMapper(ctx.doc, font);
  ctx.mappers.set(font, mapper);
  usageFor(ctx, font);
  if (!mapper) markIncomplete(ctx, font, reason ?? 'unsupported font');
  return mapper;
}

/** Split a show string into codes and record their GIDs. */
function record(ctx: Ctx, font: PdfDict, bytes: Uint8Array): void {
  const m = mapperFor(ctx, font);
  if (!m) return;
  const u = usageFor(ctx, font);
  for (let i = 0; i + m.codeWidth <= bytes.length; i += m.codeWidth) {
    const code = m.codeWidth === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    const gids = m.gidsOf(code);
    if (!gids) { markIncomplete(ctx, font, `code ${code} has no GID`); return; }
    for (const gid of gids) u.gids.add(gid);
  }
}

/** Walk one graphics scope: an op stream plus the resources it resolves against. */
function walkOps(ctx: Ctx, ops: ContentOp[], resources: PdfDict | undefined, depth: number, seen: Set<PdfDict>): void {
  const fonts = resolveDict(ctx.doc, resources?.get('Font'));
  const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));
  let font: PdfDict | undefined;

  for (const op of ops) {
    switch (op.operator) {
      case 'Tf': {
        const key = op.operands[0];
        font = isName(key) ? resolveDict(ctx.doc, fonts?.get(key.name)) : undefined;
        break;
      }
      case 'Tj': case '\'': case '"': {
        const s = op.operands[op.operands.length - 1];
        if (font && isString(s)) record(ctx, font, s.bytes);
        break;
      }
      case 'TJ': {
        const arr = op.operands[0];
        if (font && isArray(arr)) for (const el of arr) if (isString(el)) record(ctx, font, el.bytes);
        break;
      }
      case 'Do': {
        const key = op.operands[0];
        if (!isName(key) || !xobjects) break;
        const xo = ctx.doc.resolve(xobjects.get(key.name));
        if (!isStream(xo)) break;
        if (nameOf(ctx.doc, xo.dict.get('Subtype')) !== 'Form') break;
        walkStream(ctx, xo, resolveDict(ctx.doc, xo.dict.get('Resources')) ?? resources, depth + 1, seen);
        break;
      }
      default: break;
    }
  }
}

/** Parse and walk a content stream. On parse/decode failure, mark every font in
 *  scope incomplete — the broken stream could have shown any of them. */
function walkStream(
  ctx: Ctx, stream: PdfStream, resources: PdfDict | undefined,
  depth: number, seen: Set<PdfDict>,
): void {
  if (depth > MAX_XOBJECT_DEPTH) { markScopeIncomplete(ctx, resources, 'XObject nesting too deep'); return; }
  if (seen.has(stream.dict)) return;
  seen.add(stream.dict);
  let ops: ContentOp[];
  try {
    ops = parseContentStream(decodeStream(stream));
  } catch {
    markScopeIncomplete(ctx, resources, 'content stream failed to parse');
    return;
  }
  walkOps(ctx, ops, resources, depth, seen);
}

/** Mark every font reachable from `resources` unusable. Module-local: it takes
 *  `Ctx`, and `declaration: true` forbids exporting a private type. */
function markScopeIncomplete(ctx: Ctx, resources: PdfDict | undefined, reason: string): void {
  const fonts = resolveDict(ctx.doc, resources?.get('Font'));
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (f) markIncomplete(ctx, f, reason);
  }
}

/** Every /AP appearance stream on a page's annotations: /N, /D, /R, including
 *  the sub-dictionary form (/N << /On 5 0 R /Off 6 0 R >>). */
function walkAnnotations(ctx: Ctx, page: Page, seen: Set<PdfDict>): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const annot = resolveDict(ctx.doc, a);
    const ap = annot ? resolveDict(ctx.doc, annot.get('AP')) : undefined;
    if (!ap) continue;
    for (const key of ['N', 'D', 'R']) {
      const entry = ctx.doc.resolve(ap.get(key));
      const streams = isStream(entry) ? [entry]
        : isDict(entry) ? [...entry.values()].map((v) => ctx.doc.resolve(v)).filter(isStream)
        : [];
      for (const s of streams) {
        walkStream(ctx, s, resolveDict(ctx.doc, s.dict.get('Resources')), 0, seen);
      }
    }
  }
}

/** Every tiling pattern (PatternType 1) in a resource dict. Scanned
 *  unconditionally rather than on `scn` use — conservative and cheaper. */
function walkPatterns(ctx: Ctx, resources: PdfDict | undefined, seen: Set<PdfDict>): void {
  const patterns = resolveDict(ctx.doc, resources?.get('Pattern'));
  if (!patterns) return;
  for (const v of patterns.values()) {
    const p = ctx.doc.resolve(v);
    if (!isStream(p)) continue; // shading patterns are dicts, and show no text
    if (ctx.doc.resolve(p.dict.get('PatternType')) !== 1) continue;
    walkStream(ctx, p, resolveDict(ctx.doc, p.dict.get('Resources')), 0, seen);
  }
}

/** A Type3 font's glyph procedures can show text in *other* fonts. */
function walkType3(ctx: Ctx, fonts: PdfDict | undefined, seen: Set<PdfDict>): void {
  if (!fonts) return;
  for (const v of fonts.values()) {
    const f = resolveDict(ctx.doc, v);
    if (!f || nameOf(ctx.doc, f.get('Subtype')) !== 'Type3') continue;
    const procs = resolveDict(ctx.doc, f.get('CharProcs'));
    const res = resolveDict(ctx.doc, f.get('Resources'));
    if (!procs) continue;
    for (const pv of procs.values()) {
      const s = ctx.doc.resolve(pv);
      if (isStream(s)) walkStream(ctx, s, res, 0, seen);
    }
  }
}

/** Scan every site that can show a glyph and return per-font used GIDs. */
export function collectGlyphUsage(doc: Document): UsageMap {
  const ctx: Ctx = { doc, usage: new Map(), mappers: new Map() };
  for (const page of doc.Pages) walkPage(ctx, page);

  // Safety net: any font dict in the object graph that no walked scope reached
  // may be used somewhere this scan does not model. Never blank its glyphs.
  for (const [, obj] of doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(doc, obj.get('Type')) !== 'Font') continue;
    // A descendant CIDFont is only ever reachable through its Type0 parent, so
    // the scan never visits it directly. Its parent already stands in for it:
    // if that parent was unreachable it is itself marked incomplete, and the
    // program stays untouched. Flagging descendants here would report a skip
    // for every Type0 font in the document.
    const subtype = nameOf(doc, obj.get('Subtype'));
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;
    if (!ctx.usage.has(obj)) {
      ctx.usage.set(obj, { gids: new Set(), complete: false, reason: 'font not reached by the content scan' });
    }
  }
  return ctx.usage;
}

function walkPage(ctx: Ctx, page: Page): void {
  const resources = page.Resources;
  const seen = new Set<PdfDict>();
  let streams: Uint8Array[];
  try {
    streams = contentStreamBytes(ctx.doc, page);
  } catch {
    markScopeIncomplete(ctx, resources, 'page contents failed to decode');
    return;
  }
  for (const bytes of streams) {
    let ops: ContentOp[];
    try { ops = parseContentStream(bytes); }
    catch { markScopeIncomplete(ctx, resources, 'content stream failed to parse'); continue; }
    walkOps(ctx, ops, resources, 0, seen);
  }
  walkAnnotations(ctx, page, seen);
  walkPatterns(ctx, resources, seen);
  walkType3(ctx, resolveDict(ctx.doc, resources?.get('Font')), seen);
}
