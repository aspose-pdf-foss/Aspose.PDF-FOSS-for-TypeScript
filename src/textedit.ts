// Positioned text search (S1): locate a string or RegExp across a page using
// the same word/line assembly as GetText, returning page-space quads plus the
// glyph events that produced each match (op provenance for constrained replace).
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitContent, layoutLines, runFromGlyph, walkOpts } from './text.js';
import { EditableContent } from './editcontent.js';
import type { ContentAddr } from './editcontent.js';
import { ContentOp } from './content.js';
import { PdfObject, isString, isArray } from './types.js';

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
}

const centroidOf = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const inRect = (r: Rect, x: number, y: number): boolean =>
  x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

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
  const runs: RefRun<GlyphEvent>[] = [];
  const region = opts.region;
  visitContent(doc, page, {
    glyph: (e) => {
      if (!e.text) return;
      if (region && !inRect(region, ...centroidOf(e.quad))) return;
      runs.push(runFromGlyph(e, e));
    },
  }, walkOpts(opts));
  const { text, refs } = layoutLines(runs);
  if (text.length === 0) return [];

  const matches: TextMatch[] = [];
  for (const [start, end] of findRanges(text, find)) {
    matches.push(buildMatch(text, refs, start, end));
  }
  return matches;
}

/** Yield [start, end) char ranges for each non-overlapping match.
 *
 *  Exported for `annotsearch.ts`: the rule that a RegExp is always applied
 *  globally regardless of its own `g` flag has exactly one owner. */
export function findRanges(text: string, find: string | RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  if (typeof find === 'string') {
    if (find.length === 0) return ranges;
    for (let i = text.indexOf(find); i !== -1; i = text.indexOf(find, i + find.length)) {
      ranges.push([i, i + find.length]);
    }
    return ranges;
  }
  const re = new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
    // Guard against zero-width matches looping forever.
    if (m[0].length === 0) re.lastIndex++;
  }
  return ranges;
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

/** A byte-range edit on one show string: replace [start,end) with `insert`. */
interface StrEdit { elementIndex: number; start: number; end: number; insert: Uint8Array; }

function streamKey(addr: ContentAddr): string {
  return `${addr.path.join('\0')}${addr.streamIndex}`;
}

/** Replace every occurrence of `find` with `replacement`, re-encoded in the
 *  matched glyphs' own font and written in place through the F1 op-list. No
 *  layout reflow: positioning operators are preserved, so a wider replacement
 *  may overlap and a narrower one may leave a gap. Throws
 *  {@link UnsupportedFeatureError} when the font is Type0/composite or a
 *  replacement character is not representable in its encoding. Returns the
 *  number of occurrences replaced. */
export function replaceText(
  doc: Document, page: Page, find: string | RegExp, replacement: string,
  opts: SearchOptions = {},
): number {
  // An EDIT acts on what the file CONTAINS. Rewriting only the occurrences a
  // viewer is currently shown would leave the rest behind, so a caller's own
  // `includeHidden` cannot narrow this below true.
  const matches = searchText(doc, page, find, { ...opts, includeHidden: true });
  if (matches.length === 0) return 0;

  // stream -> opIndex -> pending string edits, gathered against original bytes.
  const streams = new Map<string, { addr: ContentAddr; perOp: Map<number, StrEdit[]> }>();
  const bucket = (addr: ContentAddr): Map<number, StrEdit[]> => {
    const sk = streamKey(addr);
    let s = streams.get(sk);
    if (!s) { s = { addr, perOp: new Map() }; streams.set(sk, s); }
    return s.perOp;
  };

  for (const m of matches) {
    if (m.hits.length === 0) continue;
    // Re-encode once per match (throws before any edit is applied).
    const repl = m.hits[0].font.encode(replacement);
    // Group the match's glyphs by the show string they came from; the first
    // group (reading order) receives the whole replacement, the rest are cleared.
    const groups = new Map<string, { addr: ContentAddr; opIndex: number; elementIndex: number; start: number; end: number }>();
    let primary: string | undefined;
    for (const h of m.hits) {
      const key = `${streamKey(h.addr)}|${h.addr.opIndex}|${h.elementIndex}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { addr: h.addr, opIndex: h.addr.opIndex, elementIndex: h.elementIndex, start: h.byteStart, end: h.byteStart + h.byteLen });
        if (primary === undefined) primary = key;
      } else {
        g.start = Math.min(g.start, h.byteStart);
        g.end = Math.max(g.end, h.byteStart + h.byteLen);
      }
    }
    for (const [key, g] of groups) {
      const perOp = bucket(g.addr);
      let edits = perOp.get(g.opIndex);
      if (!edits) { edits = []; perOp.set(g.opIndex, edits); }
      edits.push({ elementIndex: g.elementIndex, start: g.start, end: g.end, insert: key === primary ? repl : EMPTY });
    }
  }

  const ec = new EditableContent(doc, page);
  for (const { addr, perOp } of streams.values()) {
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    const out = ops.map((op, i) => { const e = perOp.get(i); return e ? spliceShowOp(op, e) : op; });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  ec.commit();
  return matches.length;
}

/** Apply byte-range edits to a show op's string operand(s), keeping operator and
 *  (for `"`) the spacing operands and (for `TJ`) the numeric kerns intact. */
function spliceShowOp(op: ContentOp, edits: StrEdit[]): ContentOp {
  switch (op.operator) {
    case 'Tj': return { operator: 'Tj', operands: [spliceElement(op.operands[0], edits, 0)] };
    case "'": return { operator: "'", operands: [spliceElement(op.operands[0], edits, 0)] };
    case '"': return { operator: '"', operands: [op.operands[0], op.operands[1], spliceElement(op.operands[2], edits, 0)] };
    case 'TJ': {
      const arr = op.operands[0];
      if (!isArray(arr)) return op;
      return { operator: 'TJ', operands: [arr.map((el, idx) => (isString(el) ? spliceElement(el, edits, idx) : el))] };
    }
    default: return op;
  }
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
    out.push(...e.insert);
    pos = e.end;
  }
  for (let i = pos; i < bytes.length; i++) out.push(bytes[i]);
  return { kind: 'string', bytes: Uint8Array.from(out) };
}
