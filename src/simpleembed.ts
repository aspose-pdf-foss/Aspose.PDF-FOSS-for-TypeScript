// Embedding a TrueType program into a NON-embedded simple font dict, and
// putting the dict back exactly as it was when the program does not draw what
// the page shows. Two callers: `pdfastd14.ts` (ConvertToPdfA's bundled
// Standard-14 substitutes, 29z6.6) and `embedfonts.ts` (`doc.EmbedFonts`, a
// face from a registered folder, g0ky.2). One engine, so "agrees with what is
// shown" means the same thing to both.
//
// **Invariant:** the font becomes a NON-SYMBOLIC `/TrueType` whose encoding is
// rewritten to express the SAME code -> glyph-name map over a WinAnsi or
// MacRoman base (32000-1 9.6.6.4; ISO 19005-2 6.2.11.6 forbids a Standard
// base), so every reader maps a code to a glyph by name -> Unicode -> the (3,1)
// cmap -- the chain this module checks. `/Widths` is kept, or for a Latin
// Standard-14 face written from the AFM metrics every viewer lays the text out
// with.
//
// **Invariant:** the usage scan cannot map codes for a font with NO program,
// so every font is embedded FIRST, the document scanned ONCE, and each font
// checked per SHOWN code: the code must have a glyph, and its width must agree
// with the program's advance within 1/1000 em. A font that fails is put back
// from a snapshot. What can be decided without the scan is decided BEFORE
// anything is touched, and a run that embeds nothing leaves the document
// unmodified -- `choosePath()` takes the incremental sign path only for an
// unmodified base (`pagemode.ts`'s trap).

import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isStream, name } from './types.js';
import type { StdFont } from './metrics.js';
import { standardEncodingNames, winAnsiEncodingNames, macRomanEncodingNames, glyphToUnicode } from './encoding.js';
import { std14Widths } from './font.js';
import { encodeStream } from './filters.js';
import { collectGlyphUsage } from './glyphusage.js';
import { shrinkGlyf, shrinkNameKeyedCff, shrinkType1 } from './fontshrink.js';
import { eraseType1Glyphs, type Type1Font, type Type1Rewrite } from './type1.js';
import { readType1Header } from './type1header.js';
import type { SfntFont } from './sfnt.js';
import { CffFont } from './cff.js';
import { matchStd14 } from './metrics.js';
import { rethrowLimit } from './errors.js';
import { enumerateFonts, type Ctx } from './validatectx.js';

const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];

/** A font dict the document holds: its object when it is one, and the 1-based
 *  pages whose resources declare it. */
export interface HeldFont { dict: PdfDict; ref?: PdfRef; pages: number[] }

/**
 * Every font dict the document holds, INDIRECT OR DIRECT (g0ky.7): the page
 * resource walk `validatectx.ts`'s `enumerateFonts` makes -- the one the
 * validators and `doc.Fonts` share -- which is the only place a font dict
 * written directly in a /Resources is found; then (g0ky.9) the scopes that walk
 * does not enter -- annotation appearances, tiling patterns, Type 3 fonts'
 * resources and `/AcroForm /DR` -- for a direct dict only they hold; then every
 * indirect `/Type /Font` object neither reached. One dict, one entry.
 *
 * **Invariant:** `enumerateFonts` itself is NOT widened: the validators and
 * `doc.Fonts` read it, and their reports must not move for a reach only
 * embedding needs. A dict found here gets the page it was found from, or none
 * for `/DR`.
 */
export function heldFonts(doc: Document): HeldFont[] {
  const out: HeldFont[] = [];
  const byDict = new Map<PdfDict, HeldFont>();
  const ctx: Ctx = { doc, catalog: doc.catalog(), R: (o) => doc.resolve(o), cache: new Map() };
  for (const f of enumerateFonts(ctx)) {
    const h: HeldFont = { dict: f.dict, ref: f.ref, pages: [...f.pages] };
    out.push(h);
    byDict.set(f.dict, h);
  }
  const seen = new Set<PdfDict>();
  const reach = (start: PdfObject | undefined, page: number | undefined): void => {
    const stack: (PdfObject | undefined)[] = [start];
    while (stack.length > 0) {
      const res = doc.resolve(stack.pop());
      if (!isDict(res) || seen.has(res)) continue;
      seen.add(res);
      doc.loadLimits.enforce('maxContainerItems', seen.size, 'font resource dictionaries');
      const add = (v: PdfObject | undefined): void => {
        const d = doc.resolve(v);
        if (!isDict(d)) return;
        if ((doc.resolve(d.get('Subtype')) as { name?: string })?.name === 'Type3') stack.push(d.get('Resources'));
        if (byDict.has(d)) return;
        const h: HeldFont = { dict: d, ...(isRef(v) ? { ref: v } : {}), pages: page === undefined ? [] : [page] };
        out.push(h);
        byDict.set(d, h);
      };
      const fonts = doc.resolve(res.get('Font'));
      if (isDict(fonts)) for (const v of fonts.values()) add(v);
      const egs = doc.resolve(res.get('ExtGState'));
      if (isDict(egs)) {
        for (const v of egs.values()) {
          const g = doc.resolve(v);
          const spec = isDict(g) ? doc.resolve(g.get('Font')) : undefined;
          if (isArray(spec)) add(spec[0]);
        }
      }
      for (const key of ['XObject', 'Pattern']) {
        const d = doc.resolve(res.get(key));
        if (!isDict(d)) continue;
        for (const v of d.values()) { const x = doc.resolve(v); if (isStream(x)) stack.push(x.dict.get('Resources')); }
      }
    }
  };
  doc.Pages.forEach((page, i) => {
    reach(page.Resources, i + 1);
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) return;
    for (const a of annots) {
      const annot = doc.resolve(a);
      const ap = isDict(annot) ? doc.resolve(annot.get('AP')) : undefined;
      if (!isDict(ap)) continue;
      for (const k of ['N', 'R', 'D']) {
        const v = doc.resolve(ap.get(k));
        const states = isStream(v) ? [v] : isDict(v) ? [...v.values()].map((st) => doc.resolve(st)) : [];
        for (const st of states) if (isStream(st)) reach(st.dict.get('Resources'), i + 1);
      }
    }
  });
  const acro = doc.resolve(ctx.catalog.get('AcroForm'));
  if (isDict(acro)) reach(acro.get('DR'), undefined);
  for (const [ref, obj] of doc.objectEntries()) {
    if (!isDict(obj) || (obj.get('Type') as { name?: string })?.name !== 'Font') continue;
    const h = byDict.get(obj);
    if (h) { h.ref ??= ref; continue; }
    const fresh: HeldFont = { dict: obj, ref, pages: [] };
    out.push(fresh);
    byDict.set(obj, fresh);
  }
  return out;
}

/** Whether a font dict's descriptor carries a program. */
export function hasProgram(doc: Document, font: PdfDict): boolean {
  const fd = doc.resolve(font.get('FontDescriptor'));
  return isDict(fd) && PROGRAM_KEYS.some((k) => fd.has(k));
}

/** `code -> glyph name` for a NON-embedded simple font, per 32000-1 9.6.6.1:
 *  a named base encoding, else StandardEncoding (a Latin face's built-in), with
 *  `/Differences` over it. `undefined` when the base is not a Latin one. */
export function finalNames(doc: Document, font: PdfDict): (string | undefined)[] | undefined {
  const enc = doc.resolve(font.get('Encoding'));
  const table = (n: string | undefined): readonly (string | undefined)[] | undefined =>
    n === undefined || n === 'StandardEncoding' ? standardEncodingNames
      : n === 'WinAnsiEncoding' ? winAnsiEncodingNames
      : n === 'MacRomanEncoding' ? macRomanEncodingNames : undefined;
  if (enc === undefined || enc === null) return [...standardEncodingNames];
  if (isName(enc)) return table(enc.name)?.slice();
  if (!isDict(enc)) return undefined;
  const b = doc.resolve(enc.get('BaseEncoding'));
  const base = table(isName(b) ? b.name : undefined);
  if (!base) return undefined;
  const out = base.slice();
  const diffs = doc.resolve(enc.get('Differences'));
  if (isArray(diffs)) {
    let code = 0;
    for (const d of diffs) {
      const r = doc.resolve(d);
      if (typeof r === 'number') code = r;
      else if (isName(r)) out[code++ & 0xff] = r.name;
    }
  }
  return out;
}

/** The `/Encoding` a non-symbolic TrueType may carry under PDF/A — a WinAnsi or
 *  MacRoman base (ISO 19005-2 6.2.11.6) — expressing exactly `names`. Codes a
 *  base defines and `names` does not become `/.notdef`, so no code starts
 *  drawing a glyph it did not draw before. */
function encodingFor(doc: Document, font: PdfDict, names: (string | undefined)[]): PdfObject {
  const enc = doc.resolve(font.get('Encoding'));
  const keepBase = isName(enc) ? enc.name : isDict(enc) ? (doc.resolve(enc.get('BaseEncoding')) as { name?: string })?.name : undefined;
  const baseName = keepBase === 'MacRomanEncoding' ? 'MacRomanEncoding' : 'WinAnsiEncoding';
  const base = baseName === 'MacRomanEncoding' ? macRomanEncodingNames : winAnsiEncodingNames;
  const diffs: PdfObject[] = [];
  let last = -2;
  for (let c = 0; c < 256; c++) {
    if (names[c] === base[c]) continue;
    if (c !== last + 1) diffs.push(c);
    diffs.push(name(names[c] ?? '.notdef'));
    last = c;
  }
  if (diffs.length === 0) return name(baseName);
  return new Map<string, PdfObject>([
    ['Type', name('Encoding')], ['BaseEncoding', name(baseName)], ['Differences', diffs],
  ]);
}

/** Descriptor flags for a Latin face: Nonsymbolic, plus FixedPitch, Serif and
 *  Italic as the face is. */
function latinFlags(std: StdFont): number {
  let f = 32;
  if (std.startsWith('Courier')) f |= 1;
  if (std.startsWith('Times')) f |= 2;
  if (/Italic|Oblique/.test(std)) f |= 64;
  return f;
}

export function newDescriptor(font: PdfDict, sfnt: SfntFont, std: StdFont | undefined): PdfDict {
  const k = 1000 / sfnt.unitsPerEm;
  const s = (v: number): number => Math.round(v * k);
  return new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', font.get('BaseFont')!],
    ['Flags', std ? latinFlags(std) : sfnt.flags], ['FontBBox', sfnt.bbox.map(s)],
    ['ItalicAngle', sfnt.italicAngle], ['Ascent', s(sfnt.ascent)], ['Descent', s(sfnt.descent)],
    ['CapHeight', s(sfnt.capHeight)], ['StemV', sfnt.stemV || 80],
  ]);
}

/** A descriptor for a Type 1 program from its own header: nonsymbolic, the
 *  header's bounding box (in 1/1000 em) standing in for the metrics a Type 1
 *  does not state separately. */
function type1Descriptor(font: PdfDict, t1: Type1Font): PdfDict {
  const h = readType1Header(t1.raw);
  const k = 1000 / t1.unitsPerEm;
  const bbox = (h.bbox ?? [0, 0, 1000, 1000]).map((v) => Math.round(v * k));
  return new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', font.get('BaseFont')!], ['Flags', 32],
    ['FontBBox', bbox], ['ItalicAngle', h.italicAngle], ['Ascent', bbox[3]], ['Descent', bbox[1]],
    ['CapHeight', bbox[3]], ['StemV', 80],
  ]);
}

const snapshot = (d: PdfDict): (() => void) => {
  const saved = new Map(d);
  return () => { d.clear(); for (const [k, v] of saved) d.set(k, v); };
};

/** The advance of `gid` in the program, in 1/1000 em. */
const advance = (s: SfntFont, gid: number): number => (s.advanceWidth(gid) * 1000) / s.unitsPerEm;

/** How a font is embedded and checked, decided before anything is touched.
 *
 *  - `truetype`: a text font over TrueType outlines, written as a nonsymbolic
 *    `/TrueType` with an explicit encoding; a code goes name -> Unicode -> the
 *    (3,1) cmap.
 *  - `symbolic`: a symbolic font that states no `/Encoding` (Wingdings,
 *    Symbol), over a face with a (3,0) cmap; it stays a symbolic `/TrueType`
 *    with no encoding, and a code goes through (3,0) as itself or at
 *    0xF000 + code -- 32000-1 9.6.6.4, and the chain the usage scan follows.
 *  - `cff`: a text font over an OpenType-CFF face whose CFF is NAME-keyed,
 *    written as a `/Type1` with the bare CFF as `/FontFile3 /Type1C` (PDF 1.2,
 *    which every reader takes) and an explicit encoding; a code goes name ->
 *    the CFF charset. A CID-keyed CFF -- what `type1cff.ts` makes of a `.pfb`
 *    -- has no names for a simple font to select by.
 *  - `type1`: a text font over a Type 1 program (`.pfb`/`.pfa`, g0ky.7),
 *    embedded as ITSELF in `/FontFile` with `/Length1..3` and an explicit
 *    encoding; a code goes name -> the program's `/CharStrings`. */
type Route =
  | { kind: 'truetype'; names: (string | undefined)[] }
  | { kind: 'symbolic'; sym: Map<number, number> }
  | { kind: 'cff'; names: (string | undefined)[]; cff: CffFont; bytes: Uint8Array; byName: Map<string, number> }
  | { kind: 'type1'; names: (string | undefined)[]; t1: Type1Font; program: Type1Rewrite };

/** Whether a non-embedded font is symbolic: its descriptor says Symbolic and
 *  not Nonsymbolic, or it has none and names Symbol or ZapfDingbats. */
function isSymbolic(doc: Document, font: PdfDict): boolean {
  const fd = doc.resolve(font.get('FontDescriptor'));
  if (isDict(fd)) {
    const f = doc.resolve(fd.get('Flags'));
    return typeof f === 'number' && (f & 4) !== 0 && (f & 32) === 0;
  }
  const bf = doc.resolve(font.get('BaseFont'));
  const std = isName(bf) ? matchStd14(bf.name.replace(/^[A-Z]{6}\+/, '')) : undefined;
  return std === 'Symbol' || std === 'ZapfDingbats';
}

function routeFor(doc: Document, font: PdfDict, req: SimpleEmbedRequest): Route | { decline: SimpleEmbedDecline; detail?: string } {
  if (req.type1) {
    // A symbolic Type 1 with no /Encoding draws by the program's built-in
    // encoding, which an explicit one would replace -- not a shape to guess at.
    if (isSymbolic(doc, font) && !font.has('Encoding')) return { decline: 'encoding' };
    const names = finalNames(doc, font);
    if (!names) return { decline: 'encoding' };
    // Re-emitted PDF-shaped (binary eexec, no PFB framing) with every glyph
    // kept; the subset step erases from this same program.
    const all = new Set<string>();
    for (let g = 0; g < req.type1.numGlyphs; g++) all.add(req.type1.glyphName(g)!);
    let program: Type1Rewrite;
    try { program = eraseType1Glyphs(req.type1.raw, all); } catch (caught) {
      rethrowLimit(caught);
      return { decline: 'outlines', detail: 'the Type 1 program cannot be re-emitted' };
    }
    return { kind: 'type1', names, t1: req.type1, program };
  }
  const sfnt = req.sfnt!;
  if (sfnt.outlines === 'cff') {
    let cff: CffFont;
    try {
      cff = new CffFont(sfnt.table('CFF ')!, sfnt.limits);
    } catch (caught) { rethrowLimit(caught); return { decline: 'outlines', detail: 'the CFF table will not parse' }; }
    const charset = cff.isCID ? [] : cff.charsetNames();
    if (charset.length === 0) return { decline: 'outlines', detail: 'the CFF is CID-keyed, so a simple font cannot select its glyphs by name' };
    const names = finalNames(doc, font);
    if (!names) return { decline: 'encoding' };
    const byName = new Map<string, number>();
    charset.forEach((n, gid) => { if (n !== undefined && gid > 0 && !byName.has(n)) byName.set(n, gid); });
    return { kind: 'cff', names, cff, bytes: cff.raw, byName };
  }
  if (isSymbolic(doc, font) && !font.has('Encoding')) {
    const sym = sfnt.cmapSubtable(3, 0);
    return sym?.size ? { kind: 'symbolic', sym } : { decline: 'cmap' };
  }
  const names = finalNames(doc, font);
  if (!names) return { decline: 'encoding' };
  return sfnt.cmapSubtable(3, 1) ? { kind: 'truetype', names } : { decline: 'cmap' };
}

/** The glyph `code` selects once embedded, by the route's own chain. */
function gidFor(route: Route, sfnt: SfntFont | undefined, code: number): number | undefined {
  if (route.kind === 'symbolic') return route.sym.get(code) || route.sym.get(0xf000 | code);
  const n = route.names[code];
  if (n === undefined) return undefined;
  if (route.kind === 'cff') return route.byName.get(n);
  if (route.kind === 'type1') {
    // Type 1 gid 0 is a real glyph (the program's own order), so no gid-0 test.
    const g = route.t1.gidForName(n);
    return g === undefined || n === '.notdef' ? undefined : g;
  }
  if (!sfnt) return undefined;
  const ch = glyphToUnicode(n);
  return ch === undefined || [...ch].length !== 1 ? undefined : sfnt.cmapSubtable(3, 1)!.get(ch.codePointAt(0)!);
}

/** The program stream: `/Length1` for a TrueType, `/Subtype /Type1C` for a
 *  CFF, `/Length1..3` for a Type 1. */
function programStream(route: Route, bytes: Uint8Array, t1?: Type1Rewrite): ReturnType<typeof encodeStream> {
  if (route.kind === 'type1') {
    const p = t1 ?? route.program;
    return encodeStream(p.bytes, 'FlateDecode', new Map<string, PdfObject>([
      ['Length1', p.length1], ['Length2', p.length2], ['Length3', p.length3],
    ]));
  }
  return route.kind === 'cff'
    ? encodeStream(bytes, 'FlateDecode', new Map<string, PdfObject>([['Subtype', name('Type1C')]]))
    : encodeStream(bytes, 'FlateDecode', new Map<string, PdfObject>([['Length1', bytes.length]]));
}

/** One font to embed. */
export interface SimpleEmbedRequest {
  /** The font dict's object; undefined for a dict written directly in a
   *  resource dictionary. */
  object?: PdfRef;
  font: PdfDict;
  /** The face to embed: TrueType outlines, or an OpenType-CFF whose CFF table
   *  is name-keyed. Exactly one of `sfnt` and `type1` is set. */
  sfnt?: SfntFont;
  /** A Type 1 program to embed as itself (g0ky.7). */
  type1?: Type1Font;
  /** Set for a Latin Standard-14 face: a font with no `/Widths` then gets them
   *  from the AFM metrics, and a new descriptor gets the face's flags. */
  std?: StdFont;
}

/** Why a font was put back. */
export type SimpleEmbedDecline =
  | 'outlines'        // the face's CFF is CID-keyed or will not parse, or a
                      // Type 1 program cannot be re-emitted
  | 'encoding'        // the font's code -> name map is not a Latin one
  | 'cmap'            // the face has no cmap the font's codes can go through:
                      // (3,1) for a text font, (3,0) for a symbolic one
  | 'widths'          // the font states no /Widths and is not a Standard-14 face
  | 'usage'           // the usage scan could not account for every code shown
  | 'glyph'           // a shown code has no glyph in the face
  | 'width-mismatch'  // a shown code's /Widths entry disagrees with the face
  | 'shared';         // a composite font's descendant is shared with another
                      // Type0 font, so one program would serve both unchecked

/** What happened to one {@link SimpleEmbedRequest}. */
export interface SimpleEmbedOutcome {
  request: SimpleEmbedRequest;
  embedded: boolean;
  reason?: SimpleEmbedDecline;
  /** For `glyph` and `width-mismatch`: the code, and what disagreed. */
  detail?: string;
}

/**
 * Embed each request's program, then keep only those that draw what the page
 * shows. Outcomes come back in request order. With `subset` the kept program
 * is shrunk to the glyphs shown (glyph slots are kept, never renumbered).
 */
export function embedSimpleFonts(
  doc: Document, requests: readonly SimpleEmbedRequest[], opts: { subset: boolean }, held?: readonly HeldFont[],
): SimpleEmbedOutcome[] {
  const outcomes: SimpleEmbedOutcome[] = requests.map((request) => ({ request, embedded: false }));
  const wasModified = doc.isModifiedInternal();

  // Descriptors several fonts share are COPIED before they are touched: writing
  // a /FontFile2 into a shared one would give every other font a program its
  // subtype does not describe.
  const descriptorUsers = new Map<PdfDict, number>();
  // A caller that walked already passes its walk: `heldFonts` is not cheap.
  for (const { dict } of held ?? heldFonts(doc)) {
    const fd = doc.resolve(dict.get('FontDescriptor'));
    if (isDict(fd)) descriptorUsers.set(fd, (descriptorUsers.get(fd) ?? 0) + 1);
  }

  interface Live { outcome: SimpleEmbedOutcome; route: Route; programRef: PdfRef; restore: () => void }
  const live: Live[] = [];
  for (const outcome of outcomes) {
    const { font, sfnt, std } = outcome.request;
    const route = routeFor(doc, font, outcome.request);
    if ('decline' in route) {
      outcome.reason = route.decline;
      if (route.detail !== undefined) outcome.detail = route.detail;
      continue;
    }
    // A symbolic font has no names to look AFM widths up by.
    if (!font.has('Widths') && (!std || route.kind === 'symbolic')) { outcome.reason = 'widths'; continue; }

    const restoreFont = snapshot(font);
    const fdRaw = doc.resolve(font.get('FontDescriptor'));
    const shared = isDict(fdRaw) && (descriptorUsers.get(fdRaw) ?? 0) > 1;
    const restoreFd = isDict(fdRaw) && !shared ? snapshot(fdRaw) : () => {};
    const allocated: number[] = [];
    let descriptor: PdfDict;
    // A symbolic font stays symbolic; every other one becomes nonsymbolic.
    const flagsOf = (f: PdfObject): number => {
      const v = typeof f === 'number' ? f : 0;
      return route.kind === 'symbolic' ? (v & ~32) | 4 : (v & ~4) | 32;
    };
    if (isDict(fdRaw)) {
      descriptor = shared ? new Map(fdRaw) : fdRaw;
      descriptor.set('Flags', flagsOf(doc.resolve(descriptor.get('Flags'))));
      if (shared) { const r = doc.allocObject(descriptor); allocated.push(r.num); font.set('FontDescriptor', r); }
    } else {
      descriptor = route.kind === 'type1' ? type1Descriptor(font, route.t1) : newDescriptor(font, sfnt!, std);
      descriptor.set('Flags', flagsOf(descriptor.get('Flags')!));
      const r = doc.allocObject(descriptor);
      allocated.push(r.num);
      font.set('FontDescriptor', r);
    }

    if (route.kind !== 'symbolic') {
      if (!font.has('Widths')) {
        const unicode = route.names.map((n) => (n === undefined ? undefined : glyphToUnicode(n)));
        font.set('FirstChar', 0); font.set('LastChar', 255); font.set('Widths', std14Widths(std!, unicode));
      }
      font.set('Encoding', encodingFor(doc, font, route.names));
    }
    font.set('Subtype', name(route.kind === 'cff' || route.kind === 'type1' ? 'Type1' : 'TrueType'));
    const programRef = doc.allocObject(programStream(route, route.kind === 'cff' ? route.bytes : route.kind === 'type1' ? route.program.bytes : sfnt!.raw));
    allocated.push(programRef.num);
    descriptor.set(route.kind === 'cff' ? 'FontFile3' : route.kind === 'type1' ? 'FontFile' : 'FontFile2', programRef);
    // A glyph set left from another program describes nothing in this one,
    // and a subset makes it wrong (g0ky.9). The snapshot restores it on decline.
    descriptor.delete('CharSet');
    descriptor.delete('CIDSet');
    live.push({
      outcome, route, programRef,
      restore: () => { restoreFont(); restoreFd(); for (const n of allocated) doc.deleteObject(n); },
    });
  }
  if (live.length === 0) return outcomes;

  // One scan for all of them, now that each is a TrueType the scan can map.
  const usage = collectGlyphUsage(doc);
  let kept = 0;
  for (const e of live) {
    const { font, sfnt } = e.outcome.request;
    const { route } = e;
    const u = usage.get(font);
    const widths = doc.resolve(font.get('Widths'));
    const first = doc.resolve(font.get('FirstChar'));
    if (!u || !u.complete || !isArray(widths) || typeof first !== 'number') {
      e.outcome.reason = 'usage';
      if (u?.reason !== undefined) e.outcome.detail = u.reason;
      e.restore();
      continue;
    }
    for (const code of [...u.codes].sort((a, b) => a - b)) {
      const label = route.kind === 'symbolic' ? `code ${code}` : `code ${code} (${route.names[code] ?? 'no glyph name'})`;
      const gid = gidFor(route, sfnt, code);
      if (gid === undefined || (gid === 0 && route.kind !== 'type1')) {
        e.outcome.reason = 'glyph';
        e.outcome.detail = `${label} has no glyph in the face`;
        break;
      }
      const w = doc.resolve(widths[code - first]);
      const a = route.kind === 'cff' ? (route.cff.glyphWidth(gid) ?? NaN) * 1000 / route.cff.unitsPerEm
        : route.kind === 'type1' ? route.t1.glyphWidth(gid) * 1000 / route.t1.unitsPerEm
          : advance(sfnt!, gid);
      if (typeof w !== 'number' || !(Math.abs(w - a) <= 1)) {
        e.outcome.reason = 'width-mismatch';
        e.outcome.detail = `${label}: /Widths ${typeof w === 'number' ? w : 'none'}, face ${Math.round(a)}`;
        break;
      }
    }
    if (e.outcome.reason) { e.restore(); continue; }

    if (opts.subset) {
      // Shrink to the glyphs shown; keep the whole program if that is not smaller.
      if (route.kind === 'type1') {
        let t1: Type1Rewrite | undefined;
        try {
          const r = shrinkType1(route.t1, u.gids);
          t1 = { bytes: r.bytes, ...r.type1Lengths! };
        } catch (caught) { rethrowLimit(caught); t1 = undefined; }
        if (t1 && t1.bytes.length < route.program.bytes.length) doc.replaceObject(e.programRef.num, programStream(route, t1.bytes, t1));
        e.outcome.embedded = true;
        kept++;
        continue;
      }
      const whole = route.kind === 'cff' ? route.bytes : sfnt!.raw;
      let shrunk: Uint8Array | undefined;
      try {
        shrunk = route.kind === 'cff' ? shrinkNameKeyedCff(route.bytes, u.gids).bytes : shrinkGlyf(sfnt!, u.gids).bytes;
      } catch (caught) { rethrowLimit(caught); shrunk = undefined; }
      if (shrunk && shrunk.length < whole.length) doc.replaceObject(e.programRef.num, programStream(route, shrunk));
    }
    e.outcome.embedded = true;
    kept++;
  }
  // Every font put back exactly as it was: the model has not diverged.
  if (kept === 0 && !wasModified) doc.clearModifiedInternal();
  return outcomes;
}
