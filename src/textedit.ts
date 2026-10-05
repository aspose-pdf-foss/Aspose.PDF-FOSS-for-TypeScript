// Positioned text search (S1): locate a string or RegExp across a page using
// the same word/line assembly as GetText, returning page-space quads plus the
// glyph events that produced each match (op provenance for constrained replace).
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitContent, layoutLines, runFromGlyph, walkOpts, contentStreamBytes } from './text.js';
import { inflateStream } from './flate.js';
import { planAdjustment, runsAdvance, glyphAdvance, type AdjustEdit, type KernInsert } from './replaceadjust.js';
import { EditableContent } from './editcontent.js';
import type { ContentAddr } from './editcontent.js';
import { ContentOp, parseContentStream } from './content.js';
import { PdfObject, PdfDict, isString, isArray, isDict, isStream, isName } from './types.js';
import type { ReplaceTextOptions, Run, RunStyle, UndrawableText } from './replacefont.js';
import { assignRuns, checkReplaceOptions, pushRun } from './replacefont.js';
import { splitShowOp, type FontRestore, type ShowPiece } from './showsplit.js';
import { driverFor, registerFontIn, type AuthoringFont } from './stamp.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import type { EmbeddedFont } from './embeddedfont.js';
import { UnsupportedFeatureError } from './errors.js';

/** A positioned text match. `quads` is one page-space box per line the match
 *  spans; `hits` are the glyph events behind the match (op provenance for S2). */
export interface TextMatch {
  /** The matched substring of the assembled page text. */
  text: string;
  /** Device-space boxes [x0,y0,x1,y1], one per line the match covers. */
  quads: Rect[];
  /** Glyph events that produced the match, in reading order. */
  hits: GlyphEvent[];
}

/** Scope for a text search. */
export interface SearchOptions {
  /** Restrict the search to this page-space rectangle. A glyph is in or out by
   *  its quad's CENTROID, never partly in.
   *
   *  **Invariant:** the containment rule is `extractTables`' rule, deliberately.
   *  Centroid rather than intersection makes the answer independent of glyph
   *  size, so a large glyph straddling the edge does not join both sides — and
   *  two features answering "is this inside the region" differently is how a
   *  search and a table extraction come to disagree about one page. */
  region?: Rect;
  /** Report text the document's default optional-content configuration HIDES.
   *
   *  `Search` answers "what does this page show", so it defaults to false and
   *  skips a switched-off layer exactly as `GetText` does. **The EDIT entry
   *  points set it true**: `RedactText` and `MarkRedactText` must act on
   *  everything the file holds — redacting only what a viewer happens to be
   *  shown would silently leave the secret in the bytes — and `ReplaceText`
   *  follows the same rule, so one call cannot rewrite half the occurrences.
   *  The divergence from `Search` is deliberate and asserted from both sides. */
  includeHidden?: boolean;
  /** Match letters regardless of case (u3l5.3). A string `find` is compared
   *  by Unicode simple case folding; a RegExp gains the `i` flag. Default
   *  false. */
  ignoreCase?: boolean;
  /** Accept a match only where it is not part of a longer word (u3l5.3): the
   *  characters either side must not be letters, digits, combining marks or
   *  `_`. A line break or a space layout inserted counts as a boundary.
   *  Default false. */
  wholeWord?: boolean;
}

/** Whether a glyph quad lies in `region` by the CENTROID rule described on
 *  `SearchOptions.region`. Exported so `compare.ts` scopes a comparison by
 *  the one rule search and table extraction already share. */
export function centroidIn(region: Rect, q: Rect): boolean {
  const x = (q[0] + q[2]) / 2, y = (q[1] + q[3]) / 2;
  return x >= region[0] && x <= region[2] && y >= region[1] && y <= region[3];
}

/** Find every occurrence of `find` in the page's assembled text. A string is
 *  matched literally; a RegExp is always applied globally (its own `g` flag is
 *  irrelevant). Returns matches in reading order.
 *
 *  **Invariant:** `opts.region` filters glyphs BEFORE line assembly, so a match
 *  straddling the boundary is not found — only the glyphs inside the region are
 *  ever assembled into text, and a word cut in half is no longer that word.
 *  That is the point (a region means "search here"), but it reads like a bug, so
 *  `test/search-region.test.ts` asserts it directly. */
export function searchText(
  doc: Document, page: Page, find: string | RegExp, opts: SearchOptions = {},
): TextMatch[] {
  const { text, refs } = pageText(doc, page, opts);
  if (text.length === 0) return [];
  return findRanges(text, find, opts).map(([start, end]) => buildMatch(text, refs, start, end));
}

/** The page's assembled text and, per UTF-16 code unit, the glyph that drew
 *  it (`undefined` for a space or line break layout inserted). The ONE layout
 *  `Search` and `ReplaceText` read, so the two cannot disagree about where a
 *  match is. */
function pageText(
  doc: Document, page: Page, opts: SearchOptions,
): { text: string; refs: (GlyphEvent | undefined)[]; all: GlyphEvent[] } {
  const runs: RefRun<GlyphEvent>[] = [];
  const all: GlyphEvent[] = [];   // every glyph, in content order (u3l5.4)
  const region = opts.region;
  visitContent(doc, page, {
    glyph: (e) => {
      all.push(e);
      if (!e.text) return;
      if (region && !centroidIn(region, e.quad)) return;
      runs.push(runFromGlyph(e, e));
    },
  }, walkOpts(opts));
  return { ...layoutLines(runs), all };
}

/** The /Font dict of the scope at `path`, or `undefined` when that scope holds
 *  no /Resources of its OWN (a form without one uses its parent's, 7.8.3, and
 *  registering a font there would need a fresh dict that hides the rest). */
function scopeFonts(doc: Document, page: Page, path: readonly string[]): PdfDict | undefined {
  let res = page.Resources;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    const xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return undefined;
    const own = doc.resolve(xo.dict.get('Resources'));
    if (!isDict(own)) return undefined;
    res = own;
  }
  const fonts = doc.resolve(res?.get('Font'));
  return isDict(fonts) ? fonts : undefined;
}

/** Yield [start, end) char ranges for each non-overlapping match.
 *
 *  Exported for `annotsearch.ts`: the rule that a RegExp is always applied
 *  globally regardless of its own `g` flag has exactly one owner, and so do
 *  `ignoreCase` and `wholeWord`.
 *
 *  **Invariant (u3l5.3):** a match `wholeWord` rejects resumes the search ONE
 *  code unit on, never past its end. In `ba a a` the first `a a` (after `b`)
 *  is rejected and the whole-word `a a` begins inside it; skipping the
 *  rejected match's length would miss it. */
export function findRanges(
  text: string, find: string | RegExp, mo: Pick<SearchOptions, 'ignoreCase' | 'wholeWord'> = {},
): [number, number][] {
  const ranges: [number, number][] = [];
  let re: RegExp;
  if (typeof find === 'string') {
    if (find.length === 0) return ranges;
    if (!mo.ignoreCase && !mo.wholeWord) {
      for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) {
        ranges.push([i, i + find.length]);
      }
      return ranges;
    }
    // Escapes valid under the `u` flag, which rejects an escaped `-`.
    re = new RegExp(find.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), mo.ignoreCase ? 'giu' : 'gu');
  } else {
    let flags = find.flags.includes('g') ? find.flags : find.flags + 'g';
    if (mo.ignoreCase && !flags.includes('i')) flags += 'i';
    re = new RegExp(find.source, flags);
  }
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const s = m.index, e = s + m[0].length;
    if (mo.wholeWord && (isWordAt(text, s, -1) || isWordAt(text, e, 1))) {
      re.lastIndex = s + 1;
      continue;
    }
    ranges.push([s, e]);
    // Guard against zero-width matches looping forever.
    if (m[0].length === 0) re.lastIndex++;
  }
  return ranges;
}

const WORD = /[\p{L}\p{N}\p{M}_]/u;
/** Whether the code point just before (`dir` -1) or at (`dir` 1) `i` is a
 *  word character, reading a surrogate pair whole. */
function isWordAt(text: string, i: number, dir: -1 | 1): boolean {
  let j = dir < 0 ? i - 1 : i;
  if (j < 0 || j >= text.length) return false;
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff, high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  if (dir < 0 && j > 0 && low(text.charCodeAt(j)) && high(text.charCodeAt(j - 1))) j--;
  return WORD.test(String.fromCodePoint(text.codePointAt(j)!));
}

/** Assemble a TextMatch from a [start,end) char range: collect distinct glyphs
 *  (skipping inserted spaces/newlines) and union their quads per line.
 *
 *  Exported for `annotsearch.ts`, which uses `text` and `quads` and drops
 *  `hits` — that discard is the single point where a `GlyphEvent` from an
 *  appearance-stream walk stops travelling. */
export function buildMatch(text: string, refs: (GlyphEvent | undefined)[], start: number, end: number): TextMatch {
  const hits: GlyphEvent[] = [];
  const quads: Rect[] = [];
  let line: GlyphEvent[] = [];
  let last: GlyphEvent | undefined;
  const flush = () => { if (line.length) { quads.push(unionQuad(line)); line = []; } };
  for (let i = start; i < end; i++) {
    if (text[i] === '\n') { flush(); last = undefined; continue; }
    const g = refs[i];
    if (!g || g === last) continue;   // inserted space, or another char of the same glyph
    last = g;
    line.push(g);
    hits.push(g);
  }
  flush();
  return { text: text.slice(start, end), quads, hits };
}

function unionQuad(glyphs: GlyphEvent[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of glyphs) {
    x0 = Math.min(x0, g.quad[0]); y0 = Math.min(y0, g.quad[1]);
    x1 = Math.max(x1, g.quad[2]); y1 = Math.max(y1, g.quad[3]);
  }
  return [x0, y0, x1, y1];
}

// --- S2: constrained replace ------------------------------------------------

const EMPTY = new Uint8Array(0);

/** A byte-range edit on one show string: replace [start,end) with `runs`. */
interface StrEdit {
  elementIndex: number; start: number; end: number; runs: Run[];
  /** The edit's first glyph and the [pos, endPos) of the text it rewrote. */
  anchor: GlyphEvent; pos: number; endPos: number;
}

/** True when an edit cannot be a byte splice: a run in another font, or a
 *  styled replacement (u3l5.3). */
const hasForeign = (e: StrEdit): boolean => e.runs.some((r) => r.font !== 'original' || r.style !== undefined);
/** The bytes an edit inserts when every run is in the original font. */
function insertOf(e: StrEdit): Uint8Array {
  const parts = e.runs.map((r) => (r.font === 'original' ? r.bytes : EMPTY));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** One match's reach into one TJ: its first and last string element, and per
 *  element the bytes of glyphs lying WHOLLY inside that match. */
interface KernSpan { lo: number; hi: number; matched: Map<number, number> }

/** Every edit planned for one content stream, keyed by operator index. */
interface StreamEdits {
  addr: ContentAddr;
  perOp: Map<number, StrEdit[]>;
  kerns: Map<number, KernSpan[]>;
  /** The `Tf` that restores each operator's original font after a foreign run. */
  restore: Map<number, FontRestore>;
  /** Kerns `adjust` inserts before glyphs no edit touches (u3l5.4). */
  inserts: Map<number, KernInsert[]>;
}

/** The text-positioning operators after which a show operator's pen no longer
 *  follows the one before: each sets the pen from the line matrix, which no
 *  kern moves. */
const PEN_RESET = new Set(['BT', 'ET', 'Td', 'TD', 'Tm', 'T*', "'", '"']);

function streamKey(addr: ContentAddr): string {
  return `${addr.path.join('\0')}${addr.streamIndex}`;
}

/** Replace every occurrence of `find` with `replacement`, written in place
 *  through the F1 op-list. No layout reflow: positioning operators are
 *  preserved, so a wider replacement may overlap and a narrower one may leave
 *  a gap. Returns the number of occurrences found.
 *
 *  **Invariant (u3l5.1):** the edit is planned per CHARACTER and written per
 *  GLYPH. A glyph may draw several characters — a ligature draws `fi` — so a
 *  glyph-level plan deletes the half of a ligature outside the match. Each
 *  touched glyph is rewritten as the characters no match covers, with each
 *  match's replacement emitted at that match's ANCHOR: the first position in
 *  it a real glyph drew. A match spanning several show strings therefore puts
 *  its whole replacement in the string where it starts, and the others only
 *  lose their matched glyphs. Several matches inside one glyph become ONE edit.
 *
 *  **Invariant:** everything is encoded before anything is edited, so a
 *  refused call leaves the document byte-identical. A replacement is encoded
 *  in its anchor glyph's font, residue in its own glyph's font, and a glyph
 *  left with no characters is never encoded at all — its font may be one that
 *  cannot encode (Type0). So an EMPTY replacement deletes Type0 text, while
 *  writing any character into a Type0 glyph — a replacement or a residue —
 *  throws {@link UnsupportedFeatureError}, as does any character a simple
 *  font cannot represent. */
export function replaceText(
  doc: Document, page: Page, find: string | RegExp, replacement: string,
  opts?: ReplaceTextOptions,
): number {
  const o = checkReplaceOptions(opts);
  const pageNumber = doc.Pages.findIndex((p) => p.Dict === page.Dict) + 1;
  const plan = planReplace(doc, page, pageNumber, find, replacement, o);
  plan.apply();
  return plan.count;
}

/** A planned replacement on one page: nothing is mutated until `apply`. */
export interface ReplacePlan { count: number; apply(): void }

/** Plan a replacement on one page, mutating NOTHING (u3l5.2): search, assign
 *  each written character a font, encode what is in the original font.
 *  `doc.ReplaceText` plans every page before applying any, so a refusal on one
 *  page leaves the others untouched. */
export function planReplace(
  doc: Document, page: Page, pageNumber: number, find: string | RegExp, replacement: string,
  opts: ReplaceTextOptions,
): ReplacePlan {
  // An EDIT acts on what the file CONTAINS. Rewriting only the occurrences a
  // viewer is currently shown would leave the rest behind, so a caller's own
  // `includeHidden` cannot narrow this below true.
  const { text, refs, all } = pageText(doc, page, { ...opts, includeHidden: true });
  const ranges = text.length === 0 ? [] : findRanges(text, find, opts);
  if (ranges.length === 0) return { count: 0, apply: () => {} };

  // The character plan: which positions a match covers, and where each
  // match's replacement is emitted.
  const covered = new Uint8Array(text.length);
  const matchAt = new Int32Array(text.length).fill(-1);   // which match covers a position
  const insertAt = new Map<number, string>();
  const anchored: [number, number][] = [];
  for (const [s, e] of ranges) {
    let anchor = s;
    while (anchor < e && refs[anchor] === undefined) anchor++;
    if (anchor === e) continue;   // only characters layout inserted: no ink to rewrite
    covered.fill(1, s, e);
    matchAt.fill(anchored.length, s, e);
    insertAt.set(anchor, replacement);
    anchored.push([s, e]);
  }

  // Each glyph's contiguous span of positions in `text`.
  const spans = new Map<GlyphEvent, [number, number]>();
  refs.forEach((g, i) => {
    if (!g) return;
    const sp = spans.get(g);
    if (sp) sp[1] = i + 1; else spans.set(g, [i, i + 1]);
  });

  const streams = new Map<string, StreamEdits>();
  const streamFor = (addr: ContentAddr): StreamEdits => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, perOp: new Map(), kerns: new Map(), restore: new Map(), inserts: new Map() }; streams.set(sk, s); }
    return s;
  };
  const editsFor = (addr: ContentAddr): StrEdit[] => {
    const { perOp } = streamFor(addr);
    let edits = perOp.get(addr.opIndex);
    if (!edits) { edits = []; perOp.set(addr.opIndex, edits); }
    return edits;
  };

  // Per match: the characters no font could draw, reported or refused below.
  const missing: string[][] = anchored.map(() => []);
  const fallbacks = opts.fallbackFonts ?? [];
  const registeredByName = new Map<string, EmbeddedFont | undefined>();
  const switchable = new Map<string, boolean>();
  /** Whether this glyph's scope can take a font switch: it holds its own
   *  /Resources (a form inheriting its parent's would lose them all to a fresh
   *  dict) whose /Font maps the glyph's `Tf` key to the glyph's own font, so
   *  the restoring `Tf` names what was drawn. */
  const canSwitch = (g: GlyphEvent): boolean => {
    const key = `${g.addr.path.join('\0')}|${g.tfKey}`;
    let ok = switchable.get(key);
    if (ok === undefined) {
      const fonts = scopeFonts(doc, page, g.addr.path);
      ok = fonts !== undefined && g.tfKey !== '' && doc.resolve(fonts.get(g.tfKey)) === g.font.dict;
      switchable.set(key, ok);
    }
    return ok;
  };
  const tiersFor = (g: GlyphEvent) => {
    if (!canSwitch(g)) return { original: g.font, fallbacks: [] as AuthoringFont[] };
    let registered: EmbeddedFont | undefined;
    if (opts.matchRegisteredFonts && g.font.name) {
      const ps = g.font.name.replace(/^[A-Z]{6}\+/, '');
      if (!registeredByName.has(ps)) registeredByName.set(ps, doc.fontByPostScriptName(ps));
      registered = registeredByName.get(ps);
    }
    return { original: g.font, registered, fallbacks };
  };

  // **Invariant (u3l5.3):** a style is checked, and refused, while PLANNING,
  // so a call that cannot apply it changes nothing. A font or size change
  // needs a scope that can name a font (`canSwitch`); a colour needs a fill
  // that can be put back where the replacement is written.
  const styled = opts.font !== undefined || opts.fontSize !== undefined || opts.color !== undefined;
  const styleOf = (g: GlyphEvent): RunStyle | undefined => {
    if (!styled) return undefined;
    if ((opts.font !== undefined || opts.fontSize !== undefined) && !canSwitch(g)) {
      throw new UnsupportedFeatureError(
        `ReplaceText: page ${pageNumber}: cannot change the font or size of text in a scope without its own /Resources naming its font`);
    }
    const style: RunStyle = {};
    // Points as rendered: the ratio of the Tf size to the device size is the
    // scaling the matched text already has.
    if (opts.fontSize !== undefined) style.size = g.fontSize !== 0 ? opts.fontSize * g.tfSize / g.fontSize : opts.fontSize;
    if (opts.color !== undefined) {
      style.fill = { set: { operator: 'rg', operands: [...opts.color] }, restore: restoreFill(g, pageNumber) };
    }
    return style;
  };

  // Every glyph that drew text, grouped by the show string it came from and
  // walked in byte order.
  const byElement = new Map<string, { g: GlyphEvent; gs: number; ge: number }[]>();
  for (const [g, [gs, ge]] of spans) {
    const key = `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}`;
    const list = byElement.get(key);
    if (list) list.push({ g, gs, ge }); else byElement.set(key, [{ g, gs, ge }]);
  }
  for (const list of byElement.values()) {
    list.sort((a, b) => a.g.byteStart - b.g.byteStart);
    let open: StrEdit | undefined;
    let openEnd = -1;   // position just past the open edit's last glyph
    for (const { g, gs, ge } of list) {
      let touched = false;
      for (let p = gs; p < ge && !touched; p++) touched = covered[p] === 1;
      if (!touched) { open = undefined; continue; }
      // Each written piece is attributed to a match: a replacement to the match
      // anchored at that position, residue to the first match touching the glyph.
      let owner = -1;
      for (let p = gs; p < ge && owner === -1; p++) owner = matchAt[p];
      const tiers = tiersFor(g);
      const replTiers = opts.font !== undefined ? { fallbacks: [opts.font, ...tiers.fallbacks] } : tiers;
      const runs: Run[] = [];
      let residue = '';
      const flushResidue = (): void => {
        if (residue) { assignRuns(residue, tiers, runs, missing[owner]); residue = ''; }
      };
      for (let p = gs; p < ge; p++) {
        const ins = insertAt.get(p);
        if (ins !== undefined) { flushResidue(); assignRuns(ins, replTiers, runs, missing[matchAt[p]], ins ? styleOf(g) : undefined); }
        if (!covered[p]) residue += text[p];
      }
      // Layout trims whitespace at a line's end, so a glyph's span may be only a
      // PREFIX of its text; the trimmed tail is unmatched and is kept.
      residue += g.text.slice(ge - gs);
      flushResidue();
      if (runs.some((r) => r.font !== 'original' || r.style !== undefined)) {
        streamFor(g.addr).restore.set(g.addr.opIndex, { key: g.tfKey, size: g.tfSize });
      }
      // **Invariant (u3l5.1):** a glyph that draws NO text never enters `text`,
      // so no match covers it by position. One lying between two glyphs of the
      // SAME match is part of that match — an ornament or a ToUnicode gap
      // inside a word — and the edit is extended over its bytes. One between
      // two different matches, or beside an unmatched character, is kept.
      if (open && matchAt[openEnd - 1] !== -1 && matchAt[openEnd - 1] === matchAt[gs]) {
        for (const r of runs) pushRun(open.runs, r);
        open.end = g.byteStart + g.byteLen;
        open.endPos = ge;
      } else {
        open = { elementIndex: g.elementIndex, start: g.byteStart, end: g.byteStart + g.byteLen, runs, anchor: g, pos: gs, endPos: ge };
        editsFor(g.addr).push(open);
      }
      openEnd = ge;
    }
  }

  // **Invariant (u3l5.1):** a TJ kern is dropped only when it lies between ONE
  // match's first and last string elements in that TJ AND every string element
  // between them is wholly matched by that match. Reading order comes from
  // layout, which sorts by position, so it can differ from stream order — and
  // a kern that positions text OUTSIDE the match must survive.
  for (const [s, e] of anchored) {
    const perOp = new Map<string, { addr: ContentAddr; span: KernSpan }>();
    for (let p = s; p < e; p++) {
      const g = refs[p];
      if (!g) continue;
      const [gs, ge] = spans.get(g)!;
      if (p !== Math.max(gs, s)) continue;   // count each glyph once
      const key = `${streamKey(g.addr)}|${g.addr.opIndex}`;
      let o = perOp.get(key);
      if (!o) { o = { addr: g.addr, span: { lo: g.elementIndex, hi: g.elementIndex, matched: new Map() } }; perOp.set(key, o); }
      const { span } = o;
      span.lo = Math.min(span.lo, g.elementIndex);
      span.hi = Math.max(span.hi, g.elementIndex);
      if (gs >= s && ge <= e) span.matched.set(g.elementIndex, (span.matched.get(g.elementIndex) ?? 0) + g.byteLen);
    }
    for (const { addr, span } of perOp.values()) {
      if (span.hi - span.lo < 2) continue;   // adjacent elements: nothing between them
      const { kerns } = streamFor(addr);
      const list = kerns.get(addr.opIndex);
      if (list) list.push(span); else kerns.set(addr.opIndex, [span]);
    }
  }

  if (opts.adjust !== undefined && opts.adjust !== 'none') {
    planLineAdjust(doc, page, pageNumber, opts.adjust, streams, streamFor, all, text, refs, covered, spans);
  }

  const undrawable: UndrawableText[] = [];
  anchored.forEach(([s, e], k) => {
    if (missing[k].length > 0) undrawable.push({ page: pageNumber, match: text.slice(s, e), missing: [...new Set(missing[k])] });
  });
  if (undrawable.length > 0 && !opts.onUndrawable) {
    const chars = [...new Set(undrawable.flatMap((u) => u.missing))];
    throw new UnsupportedFeatureError(
      `ReplaceText: page ${pageNumber}: no available font can draw ${chars.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  return {
    count: ranges.length,
    apply: () => {
      applyEdits(doc, page, streams.values());
      for (const u of undrawable) opts.onUndrawable?.({ ...u, missing: [...u.missing] });
    },
  };
}

/** Write the planned edits through one `EditableContent` and commit it. An
 *  operator whose edits carry a run in another font is SPLIT around it
 *  (`splitShowOp`); every other operator takes u3l5.1's byte splice, which is
 *  what keeps a replacement the original font can draw byte-identical. */
function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>): void {
  const ec = new EditableContent(doc, page);
  let any = false;
  for (const { addr, perOp, kerns, restore, inserts } of streams) {
    any = true;
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    let fonts: PdfDict | undefined;
    // The scope's own /Font dict, made writable once. A form is reached through
    // the EditableContent, never a dict captured before its copy-on-write.
    const keyFor = (font: AuthoringFont): string => {
      if (!fonts) {
        const res = addr.path.length === 0 ? ensureOwnResources(doc, page) : ec.ownXObjectResources(addr.path);
        fonts = ensureOwnSubdict(doc, res, 'Font');
      }
      return registerFontIn(doc, fonts, font);
    };
    const out: ContentOp[] = [];
    ops.forEach((op, i) => {
      const e = perOp.get(i) ?? [], k = kerns.get(i) ?? [], ins = inserts.get(i) ?? [];
      if (e.length === 0 && k.length === 0 && ins.length === 0) { out.push(op); return; }
      if (ins.length > 0 || e.some(hasForeign)) {
        out.push(...splitShowOp(op, showPieces(op, e, k, keyFor, ins), restore.get(i) ?? NO_RESTORE));
        return;
      }
      const next = spliceShowOp(op, e, k);
      if (!emptiedTj(op, next)) out.push(next);
    });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  if (any) ec.commit();
}

/** What a show operator draws after its edits, as `splitShowOp` pieces. A
 *  foreign run is encoded HERE, at apply time, so a refused plan records no
 *  glyph usage on an embedded fallback. */
function showPieces(
  op: ContentOp, edits: StrEdit[], kerns: KernSpan[], keyFor: (f: AuthoringFont) => string,
  inserts: readonly KernInsert[] = [],
): ShowPiece[] {
  const els: PdfObject[] = op.operator === 'TJ'
    ? (isArray(op.operands[0]) ? op.operands[0] : [])
    : [op.operands[op.operator === '"' ? 2 : 0]];
  const drop = op.operator === 'TJ' ? droppedKerns(els, kerns) : new Set<number>();
  const pieces: ShowPiece[] = [];
  els.forEach((el, idx) => {
    if (!isString(el)) { if (!drop.has(idx)) pieces.push({ kind: 'kern', value: el }); return; }
    // Edits and inserted kerns in byte order; a kern at an edit's start goes
    // first, since it positions what the edit writes (u3l5.4).
    const mine = edits.filter((x) => x.elementIndex === idx).sort((a, b) => a.start - b.start);
    const kernsHere = inserts.filter((x) => x.elementIndex === idx).sort((a, b) => a.byteStart - b.byteStart);
    let pos = 0;
    let ki = 0;
    const kernsUpTo = (at: number): void => {
      for (; ki < kernsHere.length && kernsHere[ki].byteStart <= at; ki++) {
        pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, kernsHere[ki].byteStart) });
        pieces.push({ kind: 'kern', value: kernsHere[ki].value });
        pos = kernsHere[ki].byteStart;
      }
    };
    for (const x of mine) {
      kernsUpTo(x.start);
      pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, x.start) });
      for (const r of x.runs) {
        if (r.font === 'original' && r.style === undefined) { pieces.push({ kind: 'bytes', bytes: r.bytes }); continue; }
        pieces.push({
          kind: 'foreign',
          ...(r.font === 'original'
            ? { bytes: r.bytes }
            : { key: keyFor(r.font), bytes: driverFor(r.font).encode(r.text) }),
          size: r.style?.size, fill: r.style?.fill,
        });
      }
      pos = x.end;
    }
    kernsUpTo(el.bytes.length);
    pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos) });
  });
  return pieces;
}

/** The restore of an operator that switches no font. */
const NO_RESTORE: FontRestore = { key: '', size: 0 };

/**
 * Plan `adjust`'s kerns (u3l5.4): measure each edit's change in pen advance,
 * then let `planAdjustment` decide where the rest of each line goes.
 *
 * **Invariant:** an edit's delta is what it WRITES minus everything it
 * REMOVES — every glyph in its byte range, the text-less ones it swept in
 * included, and the TJ kerns dropped inside its match. Measuring only the
 * matched characters misses both, and the line then lands off by a kern.
 */
function planLineAdjust(
  doc: Document, page: Page, pageNumber: number, mode: 'shiftRest' | 'spaceWidth',
  streams: Map<string, StreamEdits>, streamFor: (a: ContentAddr) => StreamEdits,
  all: readonly GlyphEvent[], text: string, refs: readonly (GlyphEvent | undefined)[], covered: Uint8Array, spans: Map<GlyphEvent, [number, number]>,
): void {
  const opsCache = new Map<string, ContentOp[][]>();
  const opsOf = (path: readonly string[]): ContentOp[][] => {
    const key = path.join('\0');
    let ops = opsCache.get(key);
    if (!ops) { ops = readScopeOps(doc, page, path); opsCache.set(key, ops); }
    return ops;
  };
  const edits: { edit: StrEdit; addr: ContentAddr; adj: AdjustEdit }[] = [];
  for (const s of streams.values()) {
    for (const [opIndex, list] of s.perOp) {
      for (const edit of list) {
        if (edit.anchor.vertical) {
          throw new UnsupportedFeatureError(`ReplaceText: page ${pageNumber}: adjust does not apply to vertical text`);
        }
        const addr = { ...s.addr, opIndex };
        let removed = 0;
        for (const g of all) {
          if (g.addr.opIndex === opIndex && g.addr.streamIndex === addr.streamIndex
            && g.addr.path.join('\0') === addr.path.join('\0') && g.elementIndex === edit.elementIndex
            && g.byteStart >= edit.start && g.byteStart < edit.end) removed += glyphAdvance(g);
        }
        const adj: AdjustEdit = {
          anchor: edit.anchor, elementIndex: edit.elementIndex, start: edit.start, end: edit.end,
          delta: runsAdvance(edit.runs, edit.anchor) - removed, pos: edit.pos, endPos: edit.endPos,
        };
        edits.push({ edit, addr, adj });
      }
    }
    // A dropped kern had moved the pen by -v/1000 text units; removing it
    // moves it back, charged to the edit before it in the same TJ.
    for (const [opIndex, spans_] of s.kerns) {
      const op = opsOf(s.addr.path)[s.addr.streamIndex]?.[opIndex];
      const arr = op?.operator === 'TJ' ? op.operands[0] : undefined;
      if (!isArray(arr)) continue;
      for (const j of droppedKerns(arr, spans_)) {
        const v = arr[j];
        if (typeof v !== 'number') continue;
        const owner = edits.filter((x) => x.addr.opIndex === opIndex && x.addr.streamIndex === s.addr.streamIndex
          && x.addr.path.join('\0') === s.addr.path.join('\0') && x.edit.elementIndex < j)
          .sort((a, b) => b.edit.elementIndex - a.edit.elementIndex)[0];
        if (owner) owner.adj.delta += v / 1000 * owner.adj.anchor.hscale * owner.adj.anchor.fontSize;
      }
    }
  }
  const posOf = new Map<GlyphEvent, number>();
  for (const [g, [p]] of spans) posOf.set(g, p);
  // Whether a positioning operator lies after `a` and up to `b` in their
  // scope's streams, read in order. Going BACKWARDS is a break too: a form
  // drawn a second time starts its chain again.
  const breaks = (a: ContentAddr, b: ContentAddr): boolean => {
    if (b.streamIndex < a.streamIndex || (b.streamIndex === a.streamIndex && b.opIndex < a.opIndex)) return true;
    if (b.streamIndex === a.streamIndex && b.opIndex === a.opIndex) return false;
    const ops = opsOf(a.path);
    for (let si = a.streamIndex; si <= b.streamIndex; si++) {
      const list = ops[si];
      if (!list) return true;
      const from = si === a.streamIndex ? a.opIndex + 1 : 0;
      const to = si === b.streamIndex ? b.opIndex : list.length - 1;
      for (let i = from; i <= to; i++) if (PEN_RESET.has(list[i].operator)) return true;
    }
    return false;
  };
  for (const k of planAdjustment(mode, all, edits.map((x) => x.adj), { text, covered, posOf, refs }, breaks)) {
    const ins = streamFor(k.addr).inserts;
    const list = ins.get(k.addr.opIndex);
    if (list) list.push(k); else ins.set(k.addr.opIndex, [k]);
  }
}

/** The parsed content of the scope at `path`, per stream, READ-ONLY — the
 *  page's /Contents streams, or a form's one stream. Empty when the path does
 *  not resolve. */
function readScopeOps(doc: Document, page: Page, path: readonly string[]): ContentOp[][] {
  if (path.length === 0) return contentStreamBytes(doc, page).map((b) => parseContentStream(b, doc.loadLimits));
  let res = page.Resources;
  let xo: PdfObject | undefined;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return [];
    const own = doc.resolve(xo.dict.get('Resources'));
    if (isDict(own)) res = own;
  }
  return isStream(xo) ? [parseContentStream(inflateStream(xo), doc.loadLimits)] : [];
}

const RESTORABLE = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern']);

/** The operators that put back `g`'s fill after a coloured replacement
 *  (u3l5.3): `GlyphEvent.fillState` re-emitted, or `0 g` for the initial fill.
 *  A colour-space NAME resolves only in the scope that set it, so a fill
 *  inherited from another scope through a named space cannot be restored
 *  here and the call is refused rather than written wrongly. */
function restoreFill(g: GlyphEvent, pageNumber: number): ContentOp[] {
  const fs = g.fillState;
  if (!fs) return [{ operator: 'g', operands: [0] }];
  const same = fs.path.length === g.addr.path.length && fs.path.every((n, i) => n === g.addr.path[i]);
  if (!same && fs.ops.some((op) => op.operands.some((o) => isName(o) && !RESTORABLE.has(o.name)))) {
    throw new UnsupportedFeatureError(
      `ReplaceText: page ${pageNumber}: cannot restore a fill colour set in another scope through a named colour space`);
  }
  return [...fs.ops];
}

/** True when the edits emptied a `Tj` that drew something. Such a `Tj` draws
 *  nothing and moves the pen by nothing, so it is removed — every planned op
 *  index was taken from the ORIGINAL list, and the removal happens while that
 *  list is copied, so no index is invalidated. A `TJ` is kept even when every
 *  string empties, since its kerns still move the pen, and `'`/`"` are kept
 *  because they move to the next line. A `Tj` that was already empty is not
 *  ours to remove. */
function emptiedTj(before: ContentOp, after: ContentOp): boolean {
  if (before.operator !== 'Tj') return false;
  const b = before.operands[0], a = after.operands[0];
  return isString(b) && b.bytes.length > 0 && isString(a) && a.bytes.length === 0;
}

/** Apply byte-range edits to a show op's string operand(s), keeping operator and
 *  (for `"`) the spacing operands intact. In a `TJ`, a numeric kern is kept
 *  unless `kerns` places it strictly inside a match. */
function spliceShowOp(op: ContentOp, edits: StrEdit[], kerns: KernSpan[]): ContentOp {
  switch (op.operator) {
    case 'Tj': return { operator: 'Tj', operands: [spliceElement(op.operands[0], edits, 0)] };
    case "'": return { operator: "'", operands: [spliceElement(op.operands[0], edits, 0)] };
    case '"': return { operator: '"', operands: [op.operands[0], op.operands[1], spliceElement(op.operands[2], edits, 0)] };
    case 'TJ': {
      const arr = op.operands[0];
      if (!isArray(arr)) return op;
      const drop = droppedKerns(arr, kerns);
      const out: PdfObject[] = [];
      arr.forEach((el, idx) => {
        if (drop.has(idx)) return;
        out.push(isString(el) ? spliceElement(el, edits, idx) : el);
      });
      return { operator: 'TJ', operands: [out] };
    }
    default: return op;
  }
}

/** The numeric elements of a TJ array lying strictly inside one match whose
 *  every string element in between is wholly matched (see `replaceText`). */
function droppedKerns(arr: PdfObject[], spans: KernSpan[]): Set<number> {
  const drop = new Set<number>();
  for (const { lo, hi, matched } of spans) {
    let whole = true;
    for (let j = lo + 1; j < hi && whole; j++) {
      const el = arr[j];
      if (isString(el) && el.bytes.length > 0 && matched.get(j) !== el.bytes.length) whole = false;
    }
    if (!whole) continue;
    for (let j = lo + 1; j < hi; j++) if (!isString(arr[j])) drop.add(j);
  }
  return drop;
}

/** Splice the edits targeting `elementIndex` into one show string. */
function spliceElement(strObj: PdfObject, edits: StrEdit[], elementIndex: number): PdfObject {
  if (!isString(strObj)) return strObj;
  const mine = edits.filter((e) => e.elementIndex === elementIndex).sort((a, b) => a.start - b.start);
  if (mine.length === 0) return strObj;
  const bytes = strObj.bytes;
  const out: number[] = [];
  let pos = 0;
  for (const e of mine) {
    for (let i = pos; i < e.start; i++) out.push(bytes[i]);
    out.push(...insertOf(e));
    pos = e.end;
  }
  for (let i = pos; i < bytes.length; i++) out.push(bytes[i]);
  return { kind: 'string', bytes: Uint8Array.from(out) };
}
