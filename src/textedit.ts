// Positioned text search (S1): locate a string or RegExp across a page using
// the same word/line assembly as GetText, returning page-space quads plus the
// glyph events that produced each match (op provenance for constrained replace).
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitContent, layoutLines, runFromGlyph, walkOpts, contentStreamBytes } from './text.js';
import { inflateStream } from './flate.js';
import { planAdjustment, runsAdvance, runUnits, splitRuns, glyphAdvance, type AdjustEdit, type ShowInsert, type ChainGap } from './replaceadjust.js';
import { EditableContent } from './editcontent.js';
import { findParagraph, untaggedKeys, MOVABLE_ANNOTS, type Paragraph, type Rect as ParaRect } from './reflowpara.js';
import { wrapParagraph, type HyphenWrap, type WrapUnit, type LineBox } from './reflowwrap.js';
import { hyphenator, resolveHyphenation, type Hyphenator } from './hyphenate.js';
import { regenerateAppearance } from './annotdraw.js';
import type { ContentAddr } from './editcontent.js';
import { ContentOp, parseContentStream } from './content.js';
import { PdfObject, PdfDict, isString, isArray, isDict, isStream, isName, isRef, name, type PdfStream } from './types.js';
import type { FontTiers, ReplaceTextOptions, Run, RunStyle, UndrawableText, UnreflowableReason, UnreflowableText } from './replacefont.js';
import { assignRuns, checkReplaceOptions, pushRun } from './replacefont.js';
import { splitShowOp, type FontRestore, type ShowPiece } from './showsplit.js';
import { driverFor, registerFontIn, type AuthoringFont } from './stamp.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import type { EmbeddedFont } from './embeddedfont.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';

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
  const { text, refs } = pageLayout(doc, page, opts);
  if (text.length === 0) return [];
  return findRanges(text, find, opts).map(([start, end]) => buildMatch(text, refs, start, end));
}

/** The page's assembled text and, per UTF-16 code unit, the glyph that drew
 *  it (`undefined` for a space or line break layout inserted). The ONE layout
 *  `Search` and `ReplaceText` read, so the two cannot disagree about where a
 *  match is. */
/** @internal — exported for tests. */
export function pageLayout(
  doc: Document, page: Page, opts: SearchOptions,
): { text: string; refs: (GlyphEvent | undefined)[]; all: GlyphEvent[]; inks: Rect[]; whole: () => { text: string; refs: (GlyphEvent | undefined)[] } } {
  const runs: RefRun<GlyphEvent>[] = [];
  const wholeRuns: RefRun<GlyphEvent>[] = [];   // ignoring region, from the same glyph objects (u3l5.10)
  const all: GlyphEvent[] = [];   // every glyph, in content order (u3l5.4)
  const inks: Rect[] = [];   // images and paths, for reflow's free-space rules (u3l5.5)
  const region = opts.region;
  visitContent(doc, page, {
    glyph: (e) => {
      all.push(e);
      if (!e.text) return;
      if (region) wholeRuns.push(runFromGlyph(e, e));
      if (region && !centroidIn(region, e.quad)) return;
      runs.push(runFromGlyph(e, e));
    },
    image: (e) => inks.push(e.quad),
    path: (e) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [ax, ay, bx, by] of e.segments) {
        x0 = Math.min(x0, ax, bx); y0 = Math.min(y0, ay, by);
        x1 = Math.max(x1, ax, bx); y1 = Math.max(y1, ay, by);
      }
      if (x0 <= x1) inks.push([x0, y0, x1, y1]);
    },
  }, walkOpts(opts));
  const layout = layoutLines(runs);
  return { ...layout, all, inks, whole: () => (region ? layoutLines(wholeRuns) : layout) };
}

/** The /Font dict of the scope at `path`, or `undefined` when that scope holds
 *  no /Resources of its OWN (a form without one uses its parent's, 7.8.3, and
 *  registering a font there would need a fresh dict that hides the rest). */
function scopeFonts(doc: Document, page: Page, path: readonly string[]): PdfDict | undefined {
  const fonts = doc.resolve(scopeResources(doc, page, path, false)?.get('Font'));
  return isDict(fonts) ? fonts : undefined;
}

/** The /Resources the scope at `path` looks names up in. With `inherit`, a
 *  form without its own uses its parent's, as `visitContent` reads it;
 *  without, such a form answers `undefined`. */
function scopeResources(doc: Document, page: Page, path: readonly string[], inherit: boolean): PdfDict | undefined {
  let res = page.Resources;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    const xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return undefined;
    const own = doc.resolve(xo.dict.get('Resources'));
    if (isDict(own)) res = own;
    else if (!inherit) return undefined;
  }
  return res;
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
  /** Where a reflow hyphenated the edit's own text (6y39): a hyphen after unit
   *  `unit` of `runUnits(runs, anchor)`, the rest at `tail`, moved there by
   *  `tm` (set by `writeReflow`). Ascending by `unit`. */
  breaks?: { unit: number; hyphen: Run; tail: [number, number]; tm?: ContentOp }[];
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
  /** Kerns `adjust` inserts before glyphs no edit touches (u3l5.4), and
   *  operators the reflow writes before a glyph (u3l5.5). */
  inserts: Map<number, ShowInsert[]>;
  /** Operators written AFTER an operator (u3l5.5). */
  after: Map<number, ContentOp[]>;
  /** Operators written BEFORE an operator (u3l5.6). */
  before: Map<number, ContentOp[]>;
}

/** The text-positioning operators after which a show operator's pen no longer
 *  follows the one before: each sets the pen from the line matrix, which no
 *  kern moves. */
const PEN_RESET = new Set(['BT', 'ET', 'Td', 'TD', 'Tm', 'T*', "'", '"']);

/** How an error names a page: `page N`, or — for a page outside `doc.Pages`,
 *  such as a template's, whose number is 0 — which kind of page it is (u3l5.8). */
export function pageLabel(pageNumber: number): string {
  return pageNumber > 0 ? `page ${pageNumber}` : 'a page outside the page tree';
}

function streamKey(addr: ContentAddr): string {
  return `${addr.path.join('\0')}${addr.streamIndex}`;
}

/** Replace every occurrence of `find` with `replacement`, written in place
 *  through the F1 op-list. No layout reflow: positioning operators are
 *  preserved, so a wider replacement may overlap and a narrower one may leave
 *  a gap. Returns the number of occurrences replaced — a match made only of
 *  spaces layout inserted draws nothing, edits nothing and is not counted.
 *
 *  Removing a `Tj` the edit emptied shifts the index of every later operator in
 *  its stream, so a `ContentAddr` (or `TextMatch.hits`) taken before the call
 *  may name a different operator afterwards: search again after editing.
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

/** @internal A restyle request (u3l5.6): each match is rewritten as its OWN
 *  text, piece by piece, styled through `opts.font`/`fontSize`/`color`. */
export interface RestyleRequest {
  /** False for a decoration-only restyle: no character is rewritten. */
  rewrite: boolean;
  /** Plans decorations once the text plan (reflow included) is known; throws
   *  to refuse, before anything changes. */
  decorate?: (ctx: DecorateContext) => void;
  /** Form streams an earlier page of the same call already restyled: a match
   *  inside one is skipped. Pages sharing one /Resources dict reach the SAME
   *  form, so re-planning page 2 after page 1 was applied finds the restyled
   *  text still matching and would restyle it again. */
  skipForms?: ReadonlySet<PdfStream>;
}
export interface RestylePiece { anchor: GlyphEvent; glyphs: GlyphEvent[]; runs?: Run[] }
export interface DecorateContext {
  pageNumber: number;
  pieces: readonly RestylePiece[];
  /** Reflow targets (glyph origin incl. rise, device space); empty without reflow. */
  targets: ReadonlyMap<GlyphEvent, [number, number]>;
  /** Each glyph's drawn extent per line after a hyphenated reflow, hyphen
   *  included (6y39); empty without one. */
  boxes: ReadonlyMap<GlyphEvent, readonly LineBox[]>;
  /** How far along its baseline (device units) each glyph's start moves
   *  without reflow: the width changes of the edits before it in its pen chain
   *  and the kerns `adjust` inserts before it. */
  shifts: ReadonlyMap<GlyphEvent, number>;
  /** The parsed ops of the scope at `path`, per stream, read-only. */
  scopeOps(path: readonly string[]): ContentOp[][];
  /** The operators that set `g`'s fill, valid in `g`'s own scope — a colour
   *  named outside a form is copied in, as a replacement colour's restore
   *  does (u3l5.9). `0 g` for the initial fill. */
  fillOps(g: GlyphEvent): ContentOp[];
  /** How many times the page draws the content place `g` stands at: more
   *  than one for a Form XObject drawn more than once (u3l5.12). */
  drawings(g: GlyphEvent): number;
  before(addr: ContentAddr, ops: readonly ContentOp[]): void;
  after(addr: ContentAddr, ops: readonly ContentOp[]): void;
}

/** A planned replacement on one page: nothing is mutated until `apply`. */
export interface ReplacePlan {
  count: number;
  apply(): void;
  /** The scope paths a restyle wrote into (u3l5.6), for `skipForms`. */
  restyledPaths?: (readonly string[])[];
}

/** Plan a replacement on one page, mutating NOTHING (u3l5.2): search, assign
 *  each written character a font, encode what is in the original font.
 *  `doc.ReplaceText` plans every page before applying any, so a refusal on one
 *  page leaves the others untouched. */
export function planReplace(
  doc: Document, page: Page, pageNumber: number, find: string | RegExp, replacement: string | RestyleRequest,
  opts: ReplaceTextOptions,
): ReplacePlan {
  // An EDIT acts on what the file CONTAINS. Rewriting only the occurrences a
  // viewer is currently shown would leave the rest behind, so a caller's own
  // `includeHidden` cannot narrow this below true.
  const { text, refs, all, inks, whole } = pageLayout(doc, page, { ...opts, includeHidden: true });
  const ranges = text.length === 0 ? [] : findRanges(text, find, opts);
  if (ranges.length === 0) return { count: 0, apply: () => {} };

  // The character plan: which positions a match covers, and where each
  // match's replacement is emitted.
  const covered = new Uint8Array(text.length);
  const matchAt = new Int32Array(text.length).fill(-1);   // which piece covers a position
  const insertAt = new Map<number, string>();
  const restyle = typeof replacement === 'string' ? undefined : replacement;
  // **Invariant (u3l5.6):** a restyle rewrites each match WHERE ITS GLYPHS ARE,
  // so a match is cut into pieces at every change of show-string element and
  // each piece is written as its own text. A replacement is one piece, emitted
  // at the match's anchor (u3l5.1). Positions layout inserted end a piece.
  const pieces: [number, number, number][] = [];   // [start, end, match index]
  ranges.forEach(([s, e], m) => {
    if (!restyle) { pieces.push([s, e, m]); return; }
    let ps = -1;
    let key = '';
    for (let p = s; p <= e; p++) {
      const g = p < e ? refs[p] : undefined;
      const k = g ? `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}` : '';
      if (ps >= 0 && k !== key) { pieces.push([ps, p, m]); ps = -1; }
      if (g && ps < 0) { ps = p; key = k; }
    }
  });
  const anchored: [number, number][] = [];
  const matchOfPiece: number[] = [];
  const inked = new Set<number>();   // matches with at least one glyph that drew text
  for (const [s, e, m] of pieces) {
    let anchor = s;
    while (anchor < e && refs[anchor] === undefined) anchor++;
    if (anchor === e) continue;   // only characters layout inserted: no ink to rewrite
    inked.add(m);
    const ap = refs[anchor]!.addr.path;
    if (restyle?.skipForms && ap.length > 0) {
      const form = scopeStream(doc, page, ap);
      if (form && restyle.skipForms.has(form)) continue;
    }
    if (!restyle || restyle.rewrite) {
      covered.fill(1, s, e);
      matchAt.fill(anchored.length, s, e);
      insertAt.set(anchor, restyle ? text.slice(s, e) : (replacement as string));
    }
    anchored.push([s, e]);
    matchOfPiece.push(m);
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
    if (!s) { s = { addr, perOp: new Map(), kerns: new Map(), restore: new Map(), inserts: new Map(), after: new Map(), before: new Map() }; streams.set(sk, s); }
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
  const paint = new PaintRestorer(doc, page, pageNumber);
  const styleOf = (g: GlyphEvent): RunStyle | undefined => {
    if (!styled) return undefined;
    if ((opts.font !== undefined || opts.fontSize !== undefined) && !canSwitch(g)) {
      throw new UnsupportedFeatureError(
        `ReplaceText: ${pageLabel(pageNumber)}: cannot change the font or size of text in a scope without its own /Resources naming its font`);
    }
    const style: RunStyle = {};
    // Points as rendered: the ratio of the Tf size to the device size is the
    // scaling the matched text already has.
    if (opts.fontSize !== undefined) style.size = g.fontSize !== 0 ? opts.fontSize * g.tfSize / g.fontSize : opts.fontSize;
    if (opts.color !== undefined) {
      style.fill = { set: { operator: 'rg', operands: [...opts.color] }, restore: paint.restore(g, false) };
      // (u3l5.9) Text whose render mode strokes is coloured by its stroke too;
      // fill-only text gets no stroke operators, so its output does not move.
      if (STROKING_MODES.has(g.renderMode ?? 0)) {
        style.stroke = { set: { operator: 'RG', operands: [...opts.color] }, restore: paint.restore(g, true) };
      }
    }
    return style;
  };

  // Every glyph that drew text, grouped by the show string it came from and
  // walked in byte order.
  const byElement = new Map<string, { g: GlyphEvent; gs: number; ge: number }[]>();
  /** Bytes of text-less glyphs a match's edit swept in, per show string and
   *  match: they are removed with it, so they count toward "wholly matched". */
  const swept = new Map<string, number>();
  for (const [g, [gs, ge]] of spans) {
    const key = `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}`;
    const list = byElement.get(key);
    if (list) list.push({ g, gs, ge }); else byElement.set(key, [{ g, gs, ge }]);
  }
  for (const list of byElement.values()) {
    list.sort((a, b) => a.g.byteStart - b.g.byteStart);
    const edited = new Set<number>();
    let open: StrEdit | undefined;
    let openEnd = -1;   // position just past the open edit's last glyph
    for (const { g, gs, ge } of list) {
      let touched = false;
      for (let p = gs; p < ge && !touched; p++) touched = covered[p] === 1;
      if (!touched) { open = undefined; continue; }
      // **Invariant (u3l5.6):** a form drawn twice is ONE stream, so its glyph
      // at this byte has already been edited by the first drawing's match.
      // Editing it again wrote the replacement twice.
      if (edited.has(g.byteStart)) continue;
      edited.add(g.byteStart);
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
        const sk = `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}|${matchAt[gs]}`;
        swept.set(sk, (swept.get(sk) ?? 0) + g.byteStart - open.end);
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
  //
  // **Invariant (u3l5.7):** a text-less glyph the match's edit swept in counts
  // as matched — its bytes go with the edit — so a string holding one inside a
  // word is still wholly matched and the kerns around it are dropped. One the
  // edit did NOT sweep (at an element's edge) still draws, and keeps its kerns.
  for (const [k, [s, e]] of anchored.entries()) {
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
    for (const [key, { addr, span }] of perOp) {
      if (span.hi - span.lo < 2) continue;   // adjacent elements: nothing between them
      for (const [j, n] of span.matched) span.matched.set(j, n + (swept.get(`${key}|${j}|${k}`) ?? 0));
      const { kerns } = streamFor(addr);
      const list = kerns.get(addr.opIndex);
      if (list) list.push(span); else kerns.set(addr.opIndex, [span]);
    }
  }

  if (opts.adjust === 'shiftRest' || opts.adjust === 'spaceWidth') {
    planLineAdjust(doc, page, pageNumber, opts.adjust, streams, streamFor, all, text, refs, covered, spans, matchAt, opts.region ? whole() : undefined, chainGapFor(doc, page));
  }
  const unreflowable: UnreflowableText[] = [];
  const annotWrites: (() => void)[] = [];
  const targets = new Map<GlyphEvent, [number, number]>();
  const boxes = new Map<GlyphEvent, LineBox[]>();
  if (opts.adjust === 'reflow') {
    planReflow(doc, page, pageNumber, streams, streamFor, all, text, refs, covered, spans, inks, anchored, unreflowable, annotWrites, targets, opts, { tiersFor, canSwitch }, boxes);
  }

  let drawCount: Map<string, number> | undefined;
  const placeKey = (g: GlyphEvent) => `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}|${g.byteStart}`;
  if (restyle?.decorate) {
    const editByAnchor = new Map<GlyphEvent, StrEdit>();
    for (const s of streams.values()) for (const list of s.perOp.values()) for (const e of list) editByAnchor.set(e.anchor, e);
    const restylePieces: RestylePiece[] = anchored.map(([s, e]) => {
      const gs: GlyphEvent[] = [];
      for (let p = s; p < e; p++) { const g = refs[p]; if (g && gs[gs.length - 1] !== g) gs.push(g); }
      return { anchor: gs[0], glyphs: gs, runs: editByAnchor.get(gs[0])?.runs };
    });
    const push = (map: 'before' | 'after') => (addr: ContentAddr, ops: readonly ContentOp[]): void => {
      const m = streamFor(addr)[map];
      const list = m.get(addr.opIndex);
      if (list) list.push(...ops); else m.set(addr.opIndex, [...ops]);
    };
    restyle.decorate({
      pageNumber, pieces: restylePieces, targets, boxes, shifts: naturalShifts(all, streams, chainGapFor(doc, page)),
      scopeOps: (path) => readScopeOps(doc, page, path),
      fillOps: (g) => paint.restore(g, false),
      drawings: (g) => {
        if (!drawCount) {
          drawCount = new Map();
          for (const x of all) drawCount.set(placeKey(x), (drawCount.get(placeKey(x)) ?? 0) + 1);
        }
        return drawCount.get(placeKey(g)) ?? 1;
      },
      before: push('before'), after: push('after'),
    });
  }
  const undrawable: UndrawableText[] = [];
  const missingByMatch = new Map<number, string[]>();
  anchored.forEach((_, k) => {
    if (missing[k].length === 0) return;
    const list = missingByMatch.get(matchOfPiece[k]);
    if (list) list.push(...missing[k]); else missingByMatch.set(matchOfPiece[k], [...missing[k]]);
  });
  for (const [m, chars] of missingByMatch) {
    undrawable.push({ page: pageNumber, match: text.slice(ranges[m][0], ranges[m][1]), missing: [...new Set(chars)] });
  }
  if (undrawable.length > 0 && !opts.onUndrawable) {
    const chars = [...new Set(undrawable.flatMap((u) => u.missing))];
    throw new UnsupportedFeatureError(
      `ReplaceText: ${pageLabel(pageNumber)}: no available font can draw ${chars.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  return {
    // **Invariant (u3l5.7):** a match made only of spaces layout inserted draws
    // nothing and edits nothing, so it is not counted. A match in a form an
    // earlier page already restyled IS: it shows the restyled text (u3l5.6).
    count: inked.size,
    restyledPaths: restyle ? [...new Map(anchored.map(([s]) => {
      let a = s;
      while (refs[a] === undefined) a++;
      const p = refs[a]!.addr.path;
      return [p.join('\0'), [...p]] as const;
    })).values()].filter((p) => p.length > 0) : undefined,
    apply: () => {
      applyEdits(doc, page, streams.values(), paint.copies);
      for (const w of annotWrites) w();
      for (const u of undrawable) opts.onUndrawable?.({ ...u, missing: [...u.missing] });
      for (const u of unreflowable) opts.onUnreflowable?.({ ...u });
    },
  };
}

/**
 * Where each glyph's START moves along its baseline once the planned edits are
 * written, without reflow (u3l5.6): a pen is relative, so an edit that changes
 * width moves everything after it in its CHAIN by the difference, and a kern
 * `adjust` inserts moves the glyph it precedes and the rest of the chain. A
 * positioning operator between two glyphs starts the chain again.
 *
 * **Invariant:** the edit's own anchor does not move — its new width moves
 * what follows it — and every original glyph in an edit's byte range gives up
 * its advance, since the edit's runs replace all of them.
 */
function naturalShifts(
  all: readonly GlyphEvent[], streams: Map<string, StreamEdits>,
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap,
): Map<GlyphEvent, number> {
  const editsAt = new Map<string, StrEdit[]>();
  const kernAt = new Map<string, number>();
  for (const s of streams.values()) {
    for (const [op, list] of s.perOp) {
      for (const e of list) {
        const k = `${streamKey(s.addr)}|${op}|${e.elementIndex}`;
        const l = editsAt.get(k);
        if (l) l.push(e); else editsAt.set(k, [e]);
      }
    }
    for (const [op, list] of s.inserts) {
      for (const ins of list) {
        if (ins.piece.kind !== 'kern') continue;
        const k = `${streamKey(s.addr)}|${op}|${ins.elementIndex}|${ins.byteStart}`;
        kernAt.set(k, (kernAt.get(k) ?? 0) + ins.piece.value);
      }
    }
  }
  const out = new Map<GlyphEvent, number>();
  const state = new Map<string, { last?: GlyphEvent; shift: number }>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    let st = state.get(scope);
    if (!st) { st = { shift: 0 }; state.set(scope, st); }
    if (!st.last || gap(st.last.addr, g.addr) !== 'none') st.shift = 0;
    st.last = g;
    const k = kernAt.get(`${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}|${g.byteStart}`);
    if (k) st.shift += -k / 1000 * g.fontSize * g.hscale;
    out.set(g, st.shift);
    const e = editsAt.get(`${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}`)
      ?.find((x) => g.byteStart >= x.start && g.byteStart < x.end);
    if (e) {
      if (g === e.anchor) st.shift += runsAdvance(e.runs, g);
      st.shift -= glyphAdvance(g);
    }
  }
  return out;
}

/** Write the planned edits through one `EditableContent` and commit it. An
 *  operator whose edits carry a run in another font is SPLIT around it
 *  (`splitShowOp`); every other operator takes u3l5.1's byte splice, which is
 *  what keeps a replacement the original font can draw byte-identical. */
function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>, copies: readonly ResourceCopy[] = []): void {
  const ec = new EditableContent(doc, page);
  let any = false;
  // (u3l5.9) Resource entries a restore names, written into the form's own
  // /Resources — reached through the EditableContent, after its copy-on-write.
  for (const c of copies) {
    ensureOwnSubdict(doc, ec.ownXObjectResources(c.path), c.category).set(c.key, c.value);
  }
  for (const { addr, perOp, kerns, restore, inserts, after, before } of streams) {
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
      out.push(...(before.get(i) ?? []));
      const e = perOp.get(i) ?? [], k = kerns.get(i) ?? [], ins = inserts.get(i) ?? [];
      if (e.length === 0 && k.length === 0 && ins.length === 0) out.push(op);
      else if (ins.length > 0 || e.some(hasForeign) || e.some((x) => x.breaks)) {
        out.push(...splitShowOp(op, showPieces(op, e, k, keyFor, ins), restore.get(i) ?? NO_RESTORE));
      } else {
        const next = spliceShowOp(op, e, k);
        if (!emptiedTj(op, next)) out.push(next);
      }
      out.push(...(after.get(i) ?? []));
    });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  if (any) ec.commit();
}

/** A foreign run's bytes — and, when its spaces must be widened, the `TJ`
 *  array that does it.
 *
 *  **Invariant (u3l5.8):** a space takes `Tw` only as the ONE-BYTE code 32
 *  (32000-1 9.3.3), and an embedded fallback is written as Type0 2-byte codes,
 *  so where word spacing is in force — justified text — its spaces would come
 *  out narrower than the original font's around them. Each is followed by a
 *  kern of `-Tw × 1000 / Tf size`, which moves the pen by exactly `Tw`, so the
 *  run is spaced as the text it replaced. A Standard-14 face is written one
 *  byte a character and gets `Tw` itself. `runsAdvance` measures the same. */
function encodeForeign(
  font: AuthoringFont, text: string, wordSpacing: number, tfSize: number,
): { bytes: Uint8Array; tj?: PdfObject[] } {
  const driver = driverFor(font);
  if (typeof font === 'string' || wordSpacing === 0 || tfSize === 0 || !text.includes(' ')) {
    return { bytes: driver.encode(text) };
  }
  const kern = -wordSpacing * 1000 / tfSize;
  const tj: PdfObject[] = [];
  const chunks: Uint8Array[] = [];
  const parts = text.split(' ');
  parts.forEach((part, i) => {
    const seg = i < parts.length - 1 ? `${part} ` : part;
    if (seg === '') return;
    const bytes = driver.encode(seg);
    chunks.push(bytes);
    tj.push({ kind: 'string', bytes });
    if (i < parts.length - 1) tj.push(kern);
  });
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return { bytes, tj };
}

/** What a show operator draws after its edits, as `splitShowOp` pieces. A
 *  foreign run is encoded HERE, at apply time, so a refused plan records no
 *  glyph usage on an embedded fallback. */
function showPieces(
  op: ContentOp, edits: StrEdit[], kerns: KernSpan[], keyFor: (f: AuthoringFont) => string,
  inserts: readonly ShowInsert[] = [],
): ShowPiece[] {
  const els: PdfObject[] = op.operator === 'TJ'
    ? (isArray(op.operands[0]) ? op.operands[0] : [])
    : [op.operands[op.operator === '"' ? 2 : 0]];
  const drop = op.operator === 'TJ' ? droppedKerns(els, kerns) : new Set<number>();
  const pieces: ShowPiece[] = [];
  const runPiece = (r: Run, anchor: GlyphEvent): ShowPiece => {
    if (r.font === 'original' && r.style === undefined) return { kind: 'bytes', bytes: r.bytes };
    const size = r.style?.size;
    return {
      kind: 'foreign',
      ...(r.font === 'original'
        ? { bytes: r.bytes }
        : { key: keyFor(r.font), ...encodeForeign(r.font, r.text, anchor.wordSpacing, size ?? anchor.tfSize) }),
      size, fill: r.style?.fill, stroke: r.style?.stroke,
    };
  };
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
        const pc = kernsHere[ki].piece;
        pieces.push(pc.kind === 'run' ? runPiece(pc.run, pc.anchor) : pc);
        pos = kernsHere[ki].byteStart;
      }
    };
    for (const x of mine) {
      kernsUpTo(x.start);
      pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, x.start) });
      const segs = x.breaks ? splitRuns(x.runs, x.anchor, x.breaks.map((b) => b.unit + 1)) : [x.runs];
      segs.forEach((seg, si) => {
        for (const r of seg) pieces.push(runPiece(r, x.anchor));
        const b = x.breaks?.[si];
        if (b) { pieces.push(runPiece(b.hyphen, x.anchor)); pieces.push({ kind: 'op', op: b.tm! }); }
      });
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
 *
 * **Invariant (u3l5.10):** a Form XObject drawn twice is ONE stream, so one
 * edit rewrites both drawings. Each drawing gets an `AdjustEdit` of its own,
 * measured against THAT drawing's glyphs — summing every glyph in the byte
 * range counted both drawings and doubled what the edit removed — so the
 * rest of each drawing's line moves. Where the drawings would need different
 * kerns in the stream they share, the call is refused.
 *
 * **Invariant (u3l5.10):** `region` scopes the SEARCH, never the line. The
 * line is the whole page's layout, with each match carried over to it, so the
 * text after a match is moved whether or not it lies inside the region.
 */
function planLineAdjust(
  doc: Document, page: Page, pageNumber: number, mode: 'shiftRest' | 'spaceWidth',
  streams: Map<string, StreamEdits>, streamFor: (a: ContentAddr) => StreamEdits,
  all: readonly GlyphEvent[], text: string, refs: readonly (GlyphEvent | undefined)[], covered: Uint8Array,
  spans: Map<GlyphEvent, [number, number]>, matchAt: Int32Array,
  wholeLayout: { text: string; refs: readonly (GlyphEvent | undefined)[] } | undefined,
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap,
): void {
  const opsCache = new Map<string, ContentOp[][]>();
  const opsOf = (path: readonly string[]): ContentOp[][] => {
    const key = path.join('\0');
    let ops = opsCache.get(key);
    if (!ops) { ops = readScopeOps(doc, page, path); opsCache.set(key, ops); }
    return ops;
  };

  // The line layout: the whole page's, and the search's carried over to it.
  const full = wholeLayout ?? { text, refs };
  const spansF = new Map<GlyphEvent, [number, number]>();
  full.refs.forEach((g, i) => {
    if (!g) return;
    const sp = spansF.get(g);
    if (sp) sp[1] = i + 1; else spansF.set(g, [i, i + 1]);
  });
  let coveredF = covered;
  if (wholeLayout) {
    coveredF = new Uint8Array(full.text.length);
    const matchF = new Int32Array(full.text.length).fill(-1);
    for (let q = 0; q < text.length; q++) {
      const g = refs[q];
      const a = g && spans.get(g), b = g && spansF.get(g);
      if (!a || !b) continue;
      const f = b[0] + (q - a[0]);
      if (f < b[1]) { coveredF[f] = covered[q]; matchF[f] = matchAt[q]; }
    }
    // A space layout inserted INSIDE a match: both neighbours in one match.
    for (let f = 0; f < full.text.length; f++) {
      if (full.refs[f] !== undefined) continue;
      let a = f - 1, b = f + 1;
      while (a >= 0 && full.refs[a] === undefined) a--;
      while (b < full.text.length && full.refs[b] === undefined) b++;
      if (a >= 0 && b < full.text.length && matchF[a] !== -1 && matchF[a] === matchF[b]) coveredF[f] = 1;
    }
  }

  const index = new Map<GlyphEvent, number>();
  all.forEach((g, i) => index.set(g, i));
  const sameOp = (a: GlyphEvent, b: GlyphEvent): boolean =>
    a.addr.opIndex === b.addr.opIndex && a.addr.streamIndex === b.addr.streamIndex
    && a.elementIndex === b.elementIndex && a.addr.path.join('\0') === b.addr.path.join('\0');

  const edits: { edit: StrEdit; addr: ContentAddr; adjs: AdjustEdit[] }[] = [];
  for (const s of streams.values()) {
    for (const [opIndex, list] of s.perOp) {
      for (const edit of list) {
        if (edit.anchor.vertical) {
          throw new UnsupportedFeatureError(`ReplaceText: ${pageLabel(pageNumber)}: adjust does not apply to vertical text`);
        }
        const addr = { ...s.addr, opIndex };
        const adjs: AdjustEdit[] = [];
        // One drawing per glyph standing where the anchor stands in the stream.
        for (const anchor of all) {
          if (!sameOp(anchor, edit.anchor) || anchor.byteStart !== edit.anchor.byteStart) continue;
          const members: GlyphEvent[] = [];
          let removed = 0;
          const from = index.get(anchor)!;
          for (let j = from; j < all.length && sameOp(all[j], anchor) && (j === from || all[j].byteStart > all[j - 1].byteStart); j++) {
            const g = all[j];
            if (g.byteStart < edit.start || g.byteStart >= edit.end) continue;
            members.push(g);
            removed += glyphAdvance(g);
          }
          const pos = spansF.get(anchor)?.[0];
          const last = [...members].reverse().find((g) => spansF.has(g));
          if (pos === undefined || last === undefined) continue;
          adjs.push({
            anchor, elementIndex: edit.elementIndex, start: edit.start, end: edit.end,
            delta: runsAdvance(edit.runs, anchor) - removed, pos, endPos: spansF.get(last)![1], members,
          });
        }
        edits.push({ edit, addr, adjs });
      }
    }
    // A dropped kern had moved the pen by -v/1000 text units; removing it
    // moves it back, charged to the edit before it in the same TJ — in each
    // drawing, at that drawing's scale.
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
        if (owner) for (const adj of owner.adjs) adj.delta += v / 1000 * adj.anchor.hscale * adj.anchor.fontSize;
      }
    }
  }
  const posOf = new Map<GlyphEvent, number>();
  for (const [g, [p]] of spansF) posOf.set(g, p);
  const plan = planAdjustment(mode, all, edits.flatMap((x) => x.adjs),
    { text: full.text, covered: coveredF, posOf, refs: full.refs }, gap);
  if (plan.conflicts > 0) {
    throw new UnsupportedFeatureError(
      `ReplaceText: ${pageLabel(pageNumber)}: adjust cannot move the line around a Form XObject drawn more than once, where its drawings need different spacing`);
  }
  for (const k of plan.inserts) {
    const ins = streamFor(k.addr).inserts;
    const list = ins.get(k.addr.opIndex);
    if (list) list.push(k); else ins.set(k.addr.opIndex, [k]);
  }
}

const ABSOLUTE = new Set(['BT', 'ET', 'Tm']);

/** The `ChainGap` between two glyphs of one scope, from the scope's ops read
 *  ONCE and cached. Going backwards — a form drawn a second time — is
 *  `'absolute'`: its chain starts again. */
function chainGapFor(doc: Document, page: Page): (a: ContentAddr, b: ContentAddr) => ChainGap {
  const cache = new Map<string, ContentOp[][]>();
  const opsOf = (path: readonly string[]): ContentOp[][] => {
    const key = path.join('\0');
    let ops = cache.get(key);
    if (!ops) { ops = readScopeOps(doc, page, path); cache.set(key, ops); }
    return ops;
  };
  return (a, b) => {
    if (a.path.join('\0') !== b.path.join('\0')) return 'absolute';
    if (b.streamIndex < a.streamIndex || (b.streamIndex === a.streamIndex && b.opIndex < a.opIndex)) return 'absolute';
    if (b.streamIndex === a.streamIndex && b.opIndex === a.opIndex) return 'none';
    const ops = opsOf(a.path);
    let found: ChainGap = 'none';
    for (let si = a.streamIndex; si <= b.streamIndex; si++) {
      const list = ops[si];
      if (!list) return 'absolute';
      const from = si === a.streamIndex ? a.opIndex + 1 : 0;
      const to = si === b.streamIndex ? b.opIndex : list.length - 1;
      for (let i = from; i <= to; i++) {
        if (ABSOLUTE.has(list[i].operator)) return 'absolute';
        if (PEN_RESET.has(list[i].operator)) found = 'relative';
      }
    }
    return found;
  };
}

const DESCENT = 0.25;

/**
 * Plan `adjust: 'reflow'` (u3l5.5): for each paragraph a match touches, find
 * it, wrap it, refuse or report what cannot be reflowed, and turn its target
 * origins into `Tm` and kern inserts.
 *
 * **Invariant:** a word is corrected only where its NATURAL position differs
 * from its target. The natural position is the pen chain's (u3l5.4); after a
 * relative pen reset (`Td TD T* ' "`) it is the ORIGINAL position only while
 * no `Tm` of ours is in force in that text object (`dirty`), since those
 * operators are relative to a line matrix we may have moved. An absolute reset
 * (`BT ET Tm`) clears `dirty`.
 *
 * **Invariant:** before the first NON-member glyph after a member in the same
 * scope, while `dirty`, a `Tm` restoring the last member's line matrix is
 * written after that member's operator — so content positioned relative to
 * the line matrix after the paragraph does not move.
 */
function planReflow(
  doc: Document, page: Page, pageNumber: number,
  streams: Map<string, StreamEdits>, streamFor: (a: ContentAddr) => StreamEdits,
  all: readonly GlyphEvent[], text: string, refs: readonly (GlyphEvent | undefined)[],
  covered: Uint8Array, spans: Map<GlyphEvent, [number, number]>, inks: readonly ParaRect[],
  anchored: [number, number][], unreflowable: UnreflowableText[], annotWrites: (() => void)[],
  targetsOut: Map<GlyphEvent, [number, number]>, opts: ReplaceTextOptions, faces: ReflowFaces,
  boxesOut: Map<GlyphEvent, LineBox[]> = new Map(),
): void {
  const gap = chainGapFor(doc, page);
  const annots = annotRects(doc, page);
  // A tagged page's paragraph is its block-level structure element; geometry
  // is the fallback for an untagged one.
  const keyOf = taggedKeys(doc, page) ?? untaggedKeys(text, refs);

  // Every StrEdit with the op it sits in, and each edited glyph's edit.
  const edits: { edit: StrEdit; addr: ContentAddr }[] = [];
  for (const s of streams.values()) for (const [opIndex, list] of s.perOp) for (const edit of list) edits.push({ edit, addr: { ...s.addr, opIndex } });
  // Indexed by op and element (u3l5.11): a scan of every edit per glyph was
  // O(glyphs x edits).
  const editsAt = new Map<string, StrEdit[]>();
  for (const { edit, addr } of edits) {
    const k = `${streamKey(addr)}|${addr.opIndex}|${edit.elementIndex}`;
    const l = editsAt.get(k);
    if (l) l.push(edit); else editsAt.set(k, [edit]);
  }
  const editOfGlyph = new Map<GlyphEvent, StrEdit>();
  for (const g of all) {
    const hit = editsAt.get(`${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}`)
      ?.find((e) => g.byteStart >= e.start && g.byteStart < e.end);
    if (hit) editOfGlyph.set(g, hit);
  }
  /** Device advance after the edits: an edit's whole new width on its anchor. */
  const advanceOf = (g: GlyphEvent): number => {
    const e = editOfGlyph.get(g);
    if (!e) return glyphAdvance(g);
    return g === e.anchor ? runsAdvance(e.runs, e.anchor) : 0;
  };

  const h = opts.hyphenate;
  /** The paragraph's hyphenator, or undefined: off, or no bundled language. */
  const hyphenFor = (anchor: GlyphEvent): { h: Hyphenator; manual: boolean } | undefined => {
    if (h === undefined || h === false) return undefined;
    try {
      const r = resolveHyphenation(h, h.lang === undefined ? langAt(doc, page, anchor) : undefined);
      return { h: hyphenator(r), manual: r.mode === 'manual' };
    } catch (e) {
      rethrowLimit(e);
      return undefined;   // no language, or none with patterns: whole words
    }
  };
  const hyphenRuns = new Map<GlyphEvent, Run | undefined>();
  const hyphenOf = (g: GlyphEvent): Run | undefined => {
    if (!hyphenRuns.has(g)) hyphenRuns.set(g, hyphenRunFor(g, faces));
    return hyphenRuns.get(g);
  };

  // One paragraph per distinct key, with the matches it holds.
  const done = new Set<unknown>();
  // Every member glyph already written, by its place in the content and the
  // linear part of its CTM: a form drawn twice is one stream, so its second
  // drawing must not be written again (u3l5.4's `placed` rule).
  const placed = new Map<string, string>();
  const glyphKey = (g: GlyphEvent) => `${streamKey(g.addr)}|${g.addr.opIndex}|${g.elementIndex}|${g.byteStart}`;
  const linear = (g: GlyphEvent) => g.ctm.slice(0, 4).map((v) => v.toFixed(9)).join(' ');
  const crop = page.CropBox;
  const annotPlan = new Map<PdfDict, ParaRect[]>();
  // **Invariant (u3l5.11):** a match crossing two paragraphs reflows BOTH —
  // the one holding its anchor takes the replacement, the other loses the
  // matched text and closes up. Only the anchor's used to be reflowed, and
  // the other kept a hole, unreported.
  const work: { s: number; anchor: GlyphEvent; key: unknown }[] = [];
  for (const [s, e] of anchored) {
    for (let q = s; q < e; q++) {
      const g = refs[q];
      if (!g) continue;
      const key = keyOf(g);
      if (!work.some((w) => w.s === s && w.key === key)) work.push({ s, anchor: g, key });
    }
  }
  for (const { s, anchor, key } of work) {
    if (done.has(key)) continue;
    done.add(key);
    const refuse = (reason: UnreflowableReason): void => {
      if (!opts.onUnreflowable) {
        throw new UnsupportedFeatureError(`ReplaceText: ${pageLabel(pageNumber)}: cannot reflow the paragraph holding ${JSON.stringify(text.slice(s, anchored.find((r) => r[0] === s)![1]))}: ${reason}`);
      }
      unreflowable.push({ page: pageNumber, match: text.slice(s, anchored.find((r) => r[0] === s)![1]), reason });
    };
    const p = findParagraph({ all, text, refs, covered, keyOf, anchor, gap, inks, annots });
    if (typeof p === 'string') { refuse(p); continue; }

    const wordOf = new Map<GlyphEvent, number>();
    p.words.forEach((w, i) => { for (const g of w.glyphs) wordOf.set(g, i); });
    const editedWords = p.words.map((_, i) => i).filter((i) => p.words[i].glyphs.some((g) => editOfGlyph.has(g)));
    if (editedWords.length === 0) continue;
    const seen = [...p.members].map((g) => placed.get(glyphKey(g)));
    if (seen.every((x) => x !== undefined)) {
      // Drawn again: the first drawing's inserts already reflow it, and
      // agree with this one only when the two CTMs differ by a translation.
      if ([...p.members].some((g) => placed.get(glyphKey(g)) !== linear(g))) refuse('scopes');
      continue;
    }
    if (seen.some((x) => x !== undefined)) { refuse('scopes'); continue; }
    const leads = new Map<GlyphEvent, number>();
    for (const w of p.words) {
      for (let i = 1; i < w.glyphs.length; i++) {
        const g = w.glyphs[i], e = editOfGlyph.get(g);
        // A kern inside a match is dropped with it; one beside it stays.
        leads.set(g, e && g !== e.anchor ? 0 : g.quad[0] - w.glyphs[i - 1].penEnd[0]);
      }
    }
    const hy = hyphenFor(anchor);
    const hyphenWrap: HyphenWrap | undefined = hy && {
      hyphenator: hy.h, manual: hy.manual,
      unitsOf: (g): WrapUnit[] => {
        const e = editOfGlyph.get(g);
        if (e && g !== e.anchor) return [];
        if (e) {
          // An edit's units are its characters: a replacement may split too.
          return runUnits(e.runs, g).map((u) => {
            const run = hyphenRunFor(g, faces, e.runs[u.run]);
            return { text: u.text, width: u.width, hyphen: run && runsAdvance([run], g) };
          });
        }
        const run = hyphenOf(g);
        return [{ text: g.text, width: advanceOf(g), hyphen: run && runsAdvance([run], g) }];
      },
      // A hyphen glyph an edit rewrote is the edit's; any other may go.
      canSuppress: (g) => !editOfGlyph.has(g),
    };
    const wrap = wrapParagraph({
      para: p, advanceOf, leadOf: (g) => leads.get(g) ?? 0,
      firstEdited: editedWords[0], lastEdited: editedWords[editedWords.length - 1],
      hyphen: hyphenWrap,
    });

    if (wrap.addedLines > 0 && !roomBelow(p, wrap.lowest, all, inks, annots, crop)) { refuse('no-room'); continue; }
    // A line-end hyphen the rejoin no longer needs becomes an empty edit over
    // its bytes: it draws nothing, advances nothing, and is not a match.
    for (const h of wrap.suppressed) {
      const e: StrEdit = { elementIndex: h.elementIndex, start: h.byteStart, end: h.byteStart + h.byteLen, runs: [], anchor: h, pos: -1, endPos: -1 };
      const { perOp } = streamFor(h.addr);
      const list = perOp.get(h.addr.opIndex);
      if (list) list.push(e); else perOp.set(h.addr.opIndex, [e]);
      editOfGlyph.set(h, e);
    }
    const hyphenAfter = new Map<GlyphEvent, Run>();
    for (const b of wrap.breaks) {
      if (b.own) continue;                       // the original hyphen stays
      const e = editOfGlyph.get(b.glyph);
      const units = e ? runUnits(e.runs, b.glyph) : undefined;
      // A break exists only where a face does.
      const run = (e ? hyphenRunFor(b.glyph, faces, e.runs[units![b.unit].run]) : hyphenOf(b.glyph))!;
      if (run.font !== 'original') streamFor(b.glyph.addr).restore.set(b.glyph.addr.opIndex, { key: b.glyph.tfKey, size: b.glyph.tfSize });
      if (e && b.unit < units!.length - 1) (e.breaks ??= []).push({ unit: b.unit, hyphen: run, tail: b.tail! });
      else hyphenAfter.set(b.glyph, run);
    }
    writeReflow(p, wrap.targets, all, gap, editOfGlyph, advanceOf, streamFor, wrap.boxes, hyphenAfter);
    for (const [g, tg] of wrap.targets) targetsOut.set(g, tg);
    for (const [g, bx] of wrap.boxes) boxesOut.set(g, bx);
    for (const g of p.members) placed.set(glyphKey(g), linear(g));
    moveAnnotQuads(doc, page, p, wrap.targets, advanceOf, annotWrites, annotPlan, wrap.boxes, new Set(wrap.suppressed));
  }
}

/** The fonts a reflow may draw a hyphen in (6y39). */
interface ReflowFaces { tiersFor(g: GlyphEvent): FontTiers; canSwitch(g: GlyphEvent): boolean }

/** The run that draws '-' after a unit of `g`, in the unit's own face first
 *  (`unitRun`'s foreign font, else `g`'s font through `drawCode`), then the
 *  registered same face and `fallbackFonts` where `g`'s scope can switch font.
 *  It carries the unit's style, so a styled replacement's hyphen matches it.
 *  Undefined: no face draws '-', and the point is skipped. */
function hyphenRunFor(g: GlyphEvent, faces: ReflowFaces, unitRun?: Run): Run | undefined {
  const style = unitRun?.style;
  if (unitRun && unitRun.font !== 'original') {
    return driverFor(unitRun.font).probe('-') > 0 ? { font: unitRun.font, text: '-', style } : undefined;
  }
  const bytes = g.font.drawCode('-');
  if (bytes) return { font: 'original', bytes, style };
  if (!faces.canSwitch(g)) return undefined;
  const t = faces.tiersFor(g);
  const f = [t.registered, ...t.fallbacks].find((x): x is AuthoringFont => x !== undefined && driverFor(x).probe('-') > 0);
  return f === undefined ? undefined : { font: f, text: '-', style };
}

/** The language a reflowed paragraph hyphenates in: the anchor glyph's
 *  structure element's, which falls back to the catalog's, or the catalog's
 *  on an untagged page. */
function langAt(doc: Document, page: Page, g: GlyphEvent): string | undefined {
  const root = doc.GetStructTree();
  const sp = doc.resolve(page.Dict.get('StructParents'));
  if (root && typeof sp === 'number' && g.mcid !== undefined && g.addr.path.length === 0) {
    const el = root.ElementFor(sp, g.mcid);
    if (el) return el.EffectiveLang;
  }
  return doc.Lang;
}

/** Block-level structure types: a paragraph is the nearest of these above a
 *  glyph's MCID element (after the RoleMap). */
const BLOCK_TYPES = new Set(['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LBody', 'TD', 'TH', 'Caption', 'BlockQuote', 'Note']);

/** The tagged paragraph key: the Dict of the block-level element owning a
 *  glyph's MCID. Undefined when the page is not tagged (no structure tree or
 *  no /StructParents), so the caller falls back to geometry. A glyph inside a
 *  form, or with no MCID, has no key. */
function taggedKeys(doc: Document, page: Page): ((g: GlyphEvent) => unknown) | undefined {
  const root = doc.GetStructTree();
  const sp = doc.resolve(page.Dict.get('StructParents'));
  if (!root || typeof sp !== 'number') return undefined;
  const memo = new Map<number, unknown>();
  return (g) => {
    if (g.mcid === undefined || g.addr.path.length > 0) return undefined;
    if (memo.has(g.mcid)) return memo.get(g.mcid);
    let el = root.ElementFor(sp, g.mcid);
    while (el && !BLOCK_TYPES.has(el.StandardType) && !/^H\d+$/.test(el.StandardType)) el = el.Parent;
    const key = el?.Dict;
    memo.set(g.mcid, key);
    return key;
  };
}

/** Whether lines may grow down to `lowest` without reaching the next ink
 *  below the paragraph within its horizontal span, or the crop box. */
function roomBelow(
  p: Paragraph, lowest: number, all: readonly GlyphEvent[], inks: readonly ParaRect[],
  annots: readonly { subtype: string; rect: ParaRect }[], crop: number[],
): boolean {
  const floor = lowest - DESCENT * p.size;
  if (floor < crop[1]) return false;
  const below = (r: ParaRect) => r[3] <= p.box[1] + 0.01 && Math.min(r[2], p.box[2]) - Math.max(r[0], p.box[0]) > 0.01;
  for (const g of all) if (g.text && !p.members.has(g) && below(g.quad) && g.quad[3] > floor) return false;
  for (const r of inks) if (below(r) && r[3] > floor) return false;
  // (u3l5.11) An annotation or widget below is ink a viewer draws over the
  // grown lines. A /Popup is a window, not part of the page.
  for (const a of annots) if (a.subtype !== 'Popup' && below(a.rect) && a.rect[3] > floor) return false;
  return true;
}

/** Turn targets into inserts, walking each scope's glyphs in content order. */
function writeReflow(
  p: Paragraph, targets: Map<GlyphEvent, [number, number]>, all: readonly GlyphEvent[],
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap, editOfGlyph: Map<GlyphEvent, StrEdit>,
  advanceOf: (g: GlyphEvent) => number, streamFor: (a: ContentAddr) => StreamEdits,
  boxes: ReadonlyMap<GlyphEvent, readonly LineBox[]> = new Map(), hyphenAfter: ReadonlyMap<GlyphEvent, Run> = new Map(),
): void {
  const insert = (g: GlyphEvent, piece: ShowInsert['piece']) => {
    const e = editOfGlyph.get(g);
    const ins: ShowInsert = { addr: g.addr, elementIndex: g.elementIndex, byteStart: e ? e.start : g.byteStart, piece };
    const map = streamFor(g.addr).inserts;
    const list = map.get(g.addr.opIndex);
    if (list) list.push(ins); else map.set(g.addr.opIndex, [ins]);
  };
  const after = (g: GlyphEvent, op: ContentOp) => {
    const map = streamFor(g.addr).after;
    const list = map.get(g.addr.opIndex);
    if (list) list.push(op); else map.set(g.addr.opIndex, [op]);
  };
  const tmFor = (g: GlyphEvent, x: number, y: number): ContentOp => {
    const [ca, cb, cc, cd] = g.ctm;
    const dx = x - g.quad[0], dy = y - g.quad[1];
    const det = ca * cd - cb * cc;
    const de = (dx * cd - dy * cc) / det, df = (dy * ca - dx * cb) / det;
    const r = (v: number) => Math.round(v * 1e6) / 1e6;
    return { operator: 'Tm', operands: [r(g.tm[0]), r(g.tm[1]), r(g.tm[2]), r(g.tm[3]), r(g.tm[4] + de), r(g.tm[5] + df)] };
  };
  type St = { pen?: [number, number]; dirty: boolean; last?: GlyphEvent; lastMember?: GlyphEvent; prevEnd?: number };
  const state = new Map<string, St>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    let st = state.get(scope);
    if (!st) { st = { dirty: false }; state.set(scope, st); }
    const kind = st.last ? gap(st.last.addr, g.addr) : 'absolute';
    if (kind === 'absolute') st.dirty = false;
    if (kind !== 'none') st.pen = undefined;
    st.last = g;
    // The original distance from the previous glyph's pen end to this one's
    // origin is what the content adds between them — a TJ kern — and the pen
    // carries it, or every kept kern is answered with a second one.
    const chainedFrom = kind === 'none' ? st.prevEnd : undefined;
    st.prevEnd = g.penEnd[0];
    if (!p.members.has(g)) {
      if (st.lastMember && st.dirty) {
        after(st.lastMember, { operator: 'Tm', operands: [...st.lastMember.tlm] });
        st.dirty = false;
      }
      st.lastMember = undefined;
      continue;
    }
    st.lastMember = g;
    const e = editOfGlyph.get(g);
    if (e && g !== e.anchor) continue;          // drawn by its edit's anchor
    if (st.pen && chainedFrom !== undefined) st.pen[0] += g.quad[0] - chainedFrom;
    const t = targets.get(g);
    if (!t) { if (st.pen) st.pen[0] += advanceOf(g); continue; }   // text-less: rides along
    if (!st.pen && !st.dirty) st.pen = [g.quad[0], g.quad[1]];     // a chain start we did not move
    if (!st.pen || Math.abs(st.pen[1] - t[1]) > 1e-6) {
      insert(g, { kind: 'op', op: tmFor(g, t[0], t[1]) });
      st.dirty = true;
    } else if (Math.abs(st.pen[0] - t[0]) > 1e-6) {
      const per = g.fontSize * g.hscale;
      insert(g, { kind: 'kern', value: Math.round(-(t[0] - st.pen[0]) * 1000 / per * 1000) / 1000 });
    }
    if (e?.breaks) {
      for (const br of e.breaks) br.tm = tmFor(g, br.tail[0], br.tail[1]);
      st.dirty = true;
    }
    const hr = hyphenAfter.get(g);
    if (hr) {
      const e2 = editOfGlyph.get(g);
      const ins: ShowInsert = { addr: g.addr, elementIndex: g.elementIndex, byteStart: e2 ? e2.end : g.byteStart + g.byteLen, piece: { kind: 'run', run: hr, anchor: g } };
      const map = streamFor(g.addr).inserts;
      const list = map.get(g.addr.opIndex);
      if (list) list.push(ins); else map.set(g.addr.opIndex, [ins]);
    }
    const bx = boxes.get(g);
    const lastBox = bx?.[bx.length - 1];
    st.pen = lastBox ? [lastBox.x + lastBox.width, lastBox.y] : [t[0] + advanceOf(g), t[1]];
  }
  for (const st of state.values()) {
    if (st.lastMember && st.dirty) after(st.lastMember, { operator: 'Tm', operands: [...st.lastMember.tlm] });
  }
}

/** Every annotation's subtype and /Rect, for the overlap rules. */
function annotRects(doc: Document, page: Page): { subtype: string; rect: ParaRect }[] {
  const out: { subtype: string; rect: ParaRect }[] = [];
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return out;
  for (const a of annots) {
    const d = doc.resolve(a);
    if (!isDict(d)) continue;
    const st = doc.resolve(d.get('Subtype'));
    const r = doc.resolve(d.get('Rect'));
    if (!isName(st) || !isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'number')) continue;
    const [x0, y0, x1, y1] = r as number[];
    out.push({ subtype: st.name, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] });
  }
  return out;
}

/** Recompute /QuadPoints and /Rect of every Link or text-markup annotation
 *  over the paragraph from its glyphs' targets — one quad per target line —
 *  as a closure `apply` runs. A glyph is covered by its quad's CENTROID,
 *  `SearchOptions.region`'s rule. */
function moveAnnotQuads(
  doc: Document, page: Page, p: Paragraph, targets: Map<GlyphEvent, [number, number]>,
  advanceOf: (g: GlyphEvent) => number, annotWrites: (() => void)[],
  plan: Map<PdfDict, ParaRect[]>,
  boxes: ReadonlyMap<GlyphEvent, readonly LineBox[]> = new Map(), gone: ReadonlySet<GlyphEvent> = new Set(),
): void {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const d = doc.resolve(a);
    if (!isDict(d)) continue;
    const st = doc.resolve(d.get('Subtype'));
    if (!isName(st) || !MOVABLE_ANNOTS.has(st.name)) continue;
    const qp = doc.resolve(d.get('QuadPoints'));
    const rect = doc.resolve(d.get('Rect'));
    let areas: ParaRect[] = [];
    if (plan.has(d)) areas = plan.get(d)!;
    else if (isArray(qp) && qp.length >= 8 && qp.length % 8 === 0 && qp.every((v) => typeof v === 'number')) {
      const n = qp as number[];
      for (let i = 0; i < n.length; i += 8) {
        const xs = [n[i], n[i + 2], n[i + 4], n[i + 6]], ys = [n[i + 1], n[i + 3], n[i + 5], n[i + 7]];
        areas.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    } else if (isArray(rect) && rect.length === 4 && rect.every((v) => typeof v === 'number')) {
      const r = rect as number[];
      areas.push([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
    } else continue;
    const mine = [...p.members].filter((g) => g.text.trim() !== '' && !gone.has(g));
    const covered = mine.filter((g) => areas.some((r) => centroidIn(r, g.quad)));
    if (covered.length === 0) continue;
    if (covered.every((g) => { const t = targets.get(g); return !t || (t[0] === g.quad[0] && t[1] === g.quad[1]); })) continue;
    // Group by target baseline, then one quad per line.
    const byLine = new Map<number, ParaRect>();
    // A word split by a hyphenated reflow has a box on each line it sits on,
    // the head's reaching over its hyphen (6y39).
    for (const g of covered) {
      const t = targets.get(g) ?? [g.quad[0], g.quad[1]];
      for (const b of boxes.get(g) ?? [{ x: t[0], y: t[1], width: advanceOf(g) }]) {
        const key = Math.round(b.y * 1000);
        const box: ParaRect = [b.x, b.y, b.x + b.width, b.y + g.fontSize];
        const cur = byLine.get(key);
        byLine.set(key, cur ? [Math.min(cur[0], box[0]), Math.min(cur[1], box[1]), Math.max(cur[2], box[2]), Math.max(cur[3], box[3])] : box);
      }
    }
    // **Invariant (u3l5.11):** only the quads over THIS paragraph are replaced;
    // one over another paragraph is kept, and the annotation's areas are
    // planned once across paragraphs, then written once.
    const kept = areas.filter((r) => !mine.some((g) => centroidIn(r, g.quad)));
    const first = !plan.has(d);
    plan.set(d, [...kept, ...byLine.values()].sort((x, y) => y[1] - x[1] || x[0] - y[0]));
    if (!first) continue;
    annotWrites.push(() => {
      const lines = plan.get(d)!;
      const quads = lines.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
      const union: ParaRect = [
        Math.min(...lines.map((l) => l[0])), Math.min(...lines.map((l) => l[1])),
        Math.max(...lines.map((l) => l[2])), Math.max(...lines.map((l) => l[3])),
      ];
      d.set('QuadPoints', quads);
      d.set('Rect', [...union]);
      // A markup appearance is drawn for its OLD rect; left in place a viewer
      // stretches it over the new one. A link draws nothing.
      if (st.name !== 'Link' && d.has('AP')) regenerateAppearance(doc, d);
      doc.markModified();
    });
  }
}

/** @internal The Form XObject stream the scope `path` names on `page`, or
 *  undefined for the page itself or a path that does not resolve. */
export function scopeStream(doc: Document, page: Page, path: readonly string[]): PdfStream | undefined {
  let res = page.Resources;
  let xo: PdfObject | undefined;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return undefined;
    const own = doc.resolve(xo.dict.get('Resources'));
    if (isDict(own)) res = own;
  }
  return isStream(xo) ? xo : undefined;
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

/** The text render modes that stroke (32000-1 Table 106). */
const STROKING_MODES = new Set([1, 2, 5, 6]);

/** A resource entry a restore needs in a form's own /Resources (u3l5.9). */
export interface ResourceCopy { path: readonly string[]; category: 'ColorSpace' | 'Pattern'; key: string; value: PdfObject }

const sameObject = (a: PdfObject | undefined, b: PdfObject | undefined): boolean =>
  a !== undefined && (a === b || (isRef(a) && isRef(b) && a.num === b.num && a.gen === b.gen));

/** Plans the operators that put back a glyph's fill or stroke after a
 *  coloured replacement: `GlyphEvent.fillState`/`strokeState` re-emitted, or
 *  `0 g`/`0 G` for the initial colour.
 *
 *  **Invariant (u3l5.9):** a colour-space or pattern NAME resolves only in the
 *  scope it was named in, so a colour inherited from another scope — set on
 *  the page, the text in a form — is restored by COPYING that entry into the
 *  form's own /Resources and renaming the operand. The key is the one that
 *  already names the same object there, else a fresh one, chosen here and
 *  reserved against the plan's other choices; nothing is written until
 *  `copies` are applied, so a refused plan changes nothing. A form with no
 *  /Resources of its own cannot take an entry (a fresh dict would hide its
 *  parent's), and that alone is still refused. */
class PaintRestorer {
  readonly copies: ResourceCopy[] = [];
  constructor(private readonly doc: Document, private readonly page: Page, private readonly pageNumber: number) {}

  restore(g: GlyphEvent, stroke: boolean): ContentOp[] {
    const st = stroke ? g.strokeState : g.fillState;
    if (!st) return [{ operator: stroke ? 'G' : 'g', operands: [0] }];
    const same = st.path.length === g.addr.path.length && st.path.every((n, i) => n === g.addr.path[i]);
    if (same) return [...st.ops];
    return st.ops.map((op) => {
      const isCs = op.operator === 'cs' || op.operator === 'CS';
      const isScn = op.operator === 'scn' || op.operator === 'SCN';
      return {
        operator: op.operator,
        operands: op.operands.map((o, i) => {
          if (!isName(o)) return o;
          if (isCs && i === 0 && !RESTORABLE.has(o.name)) return name(this.copy(g, st.path, 'ColorSpace', o.name, stroke));
          if (isScn && i === op.operands.length - 1) return name(this.copy(g, st.path, 'Pattern', o.name, stroke));
          return o;
        }),
      };
    });
  }

  private copy(g: GlyphEvent, from: readonly string[], category: 'ColorSpace' | 'Pattern', key: string, stroke: boolean): string {
    const refuse = (why: string): never => {
      throw new UnsupportedFeatureError(
        `ReplaceText: ${pageLabel(this.pageNumber)}: cannot restore a ${stroke ? 'stroke' : 'fill'} colour set in another scope through a named ${category === 'Pattern' ? 'pattern' : 'colour space'}: ${why}`);
    };
    const src = this.doc.resolve(scopeResources(this.doc, this.page, from, true)?.get(category));
    const value = isDict(src) ? src.get(key) : undefined;
    if (value === undefined) return refuse(`/${key} is not in the scope that set it`);
    // Already the same object under the same name where the text is — a form
    // inheriting its parent's /Resources, say: nothing to copy.
    const here = this.doc.resolve(scopeResources(this.doc, this.page, g.addr.path, true)?.get(category));
    if (isDict(here) && sameObject(here.get(key), value)) return key;
    const target = scopeResources(this.doc, this.page, g.addr.path, false);
    if (!target) return refuse('the Form XObject holding the text has no /Resources of its own');
    const dict = this.doc.resolve(target.get(category));
    if (isDict(dict)) for (const [k, v] of dict) if (sameObject(v, value)) return k;
    const scope = g.addr.path.join('\0');
    const mine = this.copies.filter((c) => c.path.join('\0') === scope && c.category === category);
    const hit = mine.find((c) => sameObject(c.value, value));
    if (hit) return hit.key;
    const prefix = category === 'Pattern' ? 'P' : 'CS';
    let fresh = '';
    for (let i = 0; ; i++) {
      fresh = `${prefix}${i}`;
      if (!(isDict(dict) && dict.has(fresh)) && !mine.some((c) => c.key === fresh)) break;
    }
    this.copies.push({ path: [...g.addr.path], category, key: fresh, value });
    return fresh;
  }
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
