/** Untagged document-shape heuristics: what a line looks like on the page.
 *
 *  Pure by design. It takes positioned lines and returns classifications, so
 *  every bullet character, nesting tolerance and heading rule is testable
 *  without building a PDF — the split floatstack.ts and booklet.ts already make
 *  against the modules that draw. Nothing here may import a Document.
 *
 *  **Invariant:** the marker grammar has ONE owner, `parseMarkerText`. The
 *  tagged path parses a /Lbl's text with it and the untagged path parses a
 *  line's opening with it; two grammars is how an export comes to read `(3)` as
 *  a list in one document and as prose in the other. */

import type { StyleSpan, TextBlock, TextFragment, TextLine } from './text.js';
import { dominantFragmentSize } from './textrank.js';

/** What a marker proves about its item. */
export interface Marker {
  ordered: boolean;
  /** Decimal value only. A roman or alphabetic ordinal is ordered but carries no
   *  number: `start` would have to invent one, and CommonMark's `start` is
   *  decimal regardless. */
  ordinal?: number;
  /** A task-list box's state. Absent for an ordinary item. */
  checked?: boolean;
}

const BULLET = /^[•◦▪‣·–—*+-](?:\s+|$)/;
const TASK = /^([☐☑])(?:\s+|$)/;
const ORDINAL = /^\(?(\d{1,9}|[ivxlcdm]{1,7}|[IVXLCDM]{1,7}|[a-zA-Z])[.)](?:\s+|$)/;

/** The marker opening `s`, with the length of the marker and the space after it.
 *  Undefined when `s` does not open an item. */
export function parseMarkerText(s: string): { marker: Marker; length: number } | undefined {
  const task = TASK.exec(s);
  if (task) return { marker: { ordered: false, checked: task[1] === '☑' }, length: task[0].length };
  const bullet = BULLET.exec(s);
  if (bullet) return { marker: { ordered: false }, length: bullet[0].length };
  const ord = ORDINAL.exec(s);
  if (ord) {
    const marker: Marker = { ordered: true };
    if (/^\d+$/.test(ord[1])) marker.ordinal = Number(ord[1]);
    return { marker, length: ord[0].length };
  }
  return undefined;
}

/** A marker found on a positioned line, with the geometry nesting needs. */
export interface LineMarker extends Marker {
  /** Index into `line.text` where the item's own content begins. */
  textStart: number;
  /** Page-space x of the line's left edge — the marker's own x. */
  markerX: number;
  /** Page-space x where the content begins — the item's body indent. */
  bodyX: number;
}

export function markerOf(line: TextLine): LineMarker | undefined {
  const hit = parseMarkerText(line.text);
  if (!hit) return undefined;
  return {
    ...hit.marker,
    textStart: hit.length,
    markerX: line.quad[0],
    bodyX: contentX(line, hit.length),
  };
}

/** Page-space x of the character at `textStart`.
 *
 *  A fragment boundary is preferred over interpolation because it is exact and
 *  because it is the shape our own lists produce — flow.ts stamps the marker
 *  separately from the body. `assembleLines` may synthesize a space between
 *  gapped fragments, which shifts text indices without touching fragment order,
 *  so the boundary is allowed one character of slack. A line whose marker and
 *  body share one fragment falls back to interpolating within it. */
export function contentX(line: TextLine, textStart: number): number {
  let seen = 0;
  for (const f of line.fragments) {
    if (f.text.trim() !== '' && seen >= textStart - 1) return f.quad[0];
    seen += f.text.length;
  }
  const f = line.fragments[0];
  if (!f) return line.quad[0];
  const len = f.text.length;
  if (len === 0) return f.quad[0];
  return f.quad[0] + (f.quad[2] - f.quad[0]) * (Math.min(textStart, len) / len);
}

/** A face name naming a monospaced family. Deliberately a NAME test rather than
 *  an advance-width test: a code block set in one glyph per Tj gives no run to
 *  measure, and a name is what every producer of code listings supplies. */
const MONO = /courier|mono/i;

/** '/ABCDEF+Courier-Bold' -> 'Courier-Bold'. */
function baseName(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

/** True when EVERY fragment on the line is set in a monospaced face. Every, not
 *  some: one proportional word means the line is prose that quotes an
 *  identifier, which is an inline code span and not a code block. */
export function isCodeLine(line: TextLine): boolean {
  if (line.fragments.length === 0) return false;
  return line.fragments.every(
    (f: TextFragment) => f.fontName !== undefined && MONO.test(baseName(f.fontName)));
}

/** Page-level measurements the line rules need. Passed in rather than derived
 *  per line, so a heading's "short" is measured against the page's column and
 *  not against its own block. */
export interface PageMetrics {
  /** The widest line on the page, excluding table regions. */
  columnWidth: number;
  /** Median baseline-to-baseline distance between consecutive lines. */
  leading: number;
}

export function pageMetrics(blocks: TextBlock[], bodySize: number): PageMetrics {
  let columnWidth = 0;
  const gaps: number[] = [];
  for (const b of blocks) {
    for (const l of b.lines) columnWidth = Math.max(columnWidth, l.quad[2] - l.quad[0]);
    for (let i = 1; i < b.lines.length; i++) {
      const gap = b.lines[i - 1].quad[1] - b.lines[i].quad[1];
      if (gap > 0) gaps.push(gap);
    }
  }
  gaps.sort((a, b) => a - b);
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodySize * 1.2;
  return { columnWidth, leading };
}

/** A destination and the text a `/Link` annotation was found to cover.
 *
 *  The TEXT, not the rect: a link's glyphs are resolved by the caller (which has
 *  the page and can intersect the annotation's rect with the real glyph boxes),
 *  because the alternative — slicing a fragment by interpolated x — is only
 *  right for a monospaced face. `y0`/`y1` bound the band the annotation covers,
 *  so a rect cannot link a matching phrase on another line. */
export interface LinkSpan { text: string; href: string; y0: number; y1: number }

/** A piece of a line, linked or not, emphasized or not. */
export interface LineSegment {
  text: string; href?: string; bold?: boolean; italic?: boolean;
  script?: 'sub' | 'super';
}

/** `line.text[from..to)` cut into pieces of uniform emphasis, each carrying
 *  `href`.
 *
 *  **Invariant:** the cut uses `line.styles`, whose offsets were recorded when
 *  `line.text` was assembled. Recovering them from `line.fragments` here would
 *  have to re-derive the synthesized inter-fragment spaces, which is the same
 *  rebuild this function is written to avoid. A line with no `styles` returns
 *  ONE piece holding the slice unchanged, which is what keeps every existing
 *  snapshot byte for byte. */
function stylePieces(line: TextLine, from: number, to: number, href?: string): LineSegment[] {
  const seg = (text: string, s?: StyleSpan): LineSegment => ({
    text,
    ...(href !== undefined ? { href } : {}),
    ...(s?.bold ? { bold: true } : {}), ...(s?.italic ? { italic: true } : {}),
    ...(s?.script ? { script: s.script } : {}),
  });
  if (!line.styles) return [seg(line.text.slice(from, to))];

  const out: LineSegment[] = [];
  let pos = from;
  for (const s of line.styles) {
    if (s.end <= pos || s.start >= to) continue;
    const a = Math.max(pos, s.start), b = Math.min(to, s.end);
    // A synthesized separator space belongs to no span; it joins the piece
    // before it rather than becoming an unstyled fragment of its own.
    if (a > pos) out.push(seg(line.text.slice(pos, a)));
    if (b > a) out.push(seg(line.text.slice(a, b), s));
    pos = b;
  }
  if (pos < to) out.push(seg(line.text.slice(pos, to)));
  return out.filter((p) => p.text !== '');
}

/** Split `line` into linked and unlinked segments against `spans`.
 *
 *  **Invariant:** a line no span touches returns ONE segment holding
 *  `line.text` unchanged, byte for byte. That is what keeps a page without link
 *  annotations — every page in the existing snapshots — emitting exactly what it
 *  did before. The text is only ever SLICED, never rebuilt from fragments, since
 *  `line.text` carries synthesized inter-fragment spaces a rebuild would lose.
 *
 *  A span whose text occurs more than once in the line is skipped rather than
 *  guessed at: linking the wrong occurrence is worse than not linking, and the
 *  words still render either way. */
export function splitLineLinks(line: TextLine, spans: LinkSpan[]): LineSegment[] {
  const plain: LineSegment[] = stylePieces(line, 0, line.text.length);
  if (!spans.length) return plain;

  const midY = (line.quad[1] + line.quad[3]) / 2;
  const hits: { at: number; end: number; href: string }[] = [];
  for (const s of spans) {
    if (midY < s.y0 || midY > s.y1) continue;
    const needle = s.text.trim();
    if (!needle) continue;
    const at = line.text.indexOf(needle);
    if (at < 0 || line.text.indexOf(needle, at + 1) >= 0) continue;   // absent or ambiguous
    hits.push({ at, end: at + needle.length, href: s.href });
  }
  if (!hits.length) return plain;

  hits.sort((a, b) => a.at - b.at);
  const out: LineSegment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at < pos) continue;                       // overlaps one already taken
    if (h.at > pos) out.push(...stylePieces(line, pos, h.at));
    out.push(...stylePieces(line, h.at, h.end, h.href));
    pos = h.end;
  }
  if (pos < line.text.length) out.push(...stylePieces(line, pos, line.text.length));
  return out;
}

/** What a line is, once its neighbours have been taken into account. */
export type LineClass =
  | { kind: 'item'; marker: LineMarker; depth: number }
  | { kind: 'continuation' }
  | { kind: 'code' }
  | { kind: 'heading' }
  | { kind: 'text' };

/** Everything a block's lines are judged against. */
export interface ClassifyContext {
  metrics: PageMetrics;
  /** The page's dominant font size. A line above it is ranked by size and never
   *  reaches the heading signals here. */
  bodySize: number;
  /** Baseline of the last line before this block. Absent for the first block on
   *  a page, which counts as having a gap above it. */
  prevBaseline?: number;
  /** First line of the next block that will be emitted, for the "followed by
   *  body text" corroboration. Absent when this is the last block. */
  nextLine?: TextLine;
}

/** Marker x positions this close are the same nesting level. */
function tolerance(bodySize: number): number { return Math.max(3, 0.5 * bodySize); }

const BOLD = /bold|black|heavy|semibold|demi/i;

/** True when every cased letter is uppercase, over at least two letters. One
 *  letter is an initial, not a style. */
function allCaps(s: string): boolean {
  const letters = s.match(/\p{L}/gu);
  return letters !== null && letters.length >= 2 && s === s.toUpperCase();
}

/** The corroboration all three heading signals share: short, a gap above, and
 *  body text below at the same left edge.
 *
 *  The follower requirement is load-bearing rather than decorative — without it
 *  the bare short-isolated signal promotes `test/html-identity.test.ts`'s
 *  'Card heading', a short body-size line inside a ruled card with nothing after
 *  it, and moves a snapshot that has nothing to do with this feature. */
function corroborated(
  lines: TextLine[], i: number, ctx: ClassifyContext, tol: number,
): boolean {
  const l = lines[i];
  const width = l.quad[2] - l.quad[0];
  if (ctx.metrics.columnWidth <= 0 || width >= 0.6 * ctx.metrics.columnWidth) return false;

  const prevBaseline = i > 0 ? lines[i - 1].quad[1] : ctx.prevBaseline;
  // The first block on a page has no predecessor and counts as having a gap.
  if (prevBaseline !== undefined && prevBaseline - l.quad[1] < 1.2 * ctx.metrics.leading)
    return false;

  const next = i + 1 < lines.length ? lines[i + 1] : ctx.nextLine;
  if (!next) return false;
  if (Math.abs(next.quad[0] - l.quad[0]) > tol) return false;
  return dominantFragmentSize(next.fragments) <= ctx.bodySize + 0.5;
}

/** True when a body-size line carries heading evidence. A size-derived rank
 *  always wins, so this is consulted only at body size. */
function isHeading(lines: TextLine[], i: number, ctx: ClassifyContext, tol: number): boolean {
  const l = lines[i];
  if (dominantFragmentSize(l.fragments) > ctx.bodySize + 0.5) return false;  // ranked by size
  if (!corroborated(lines, i, ctx, tol)) return false;
  const bold = l.fragments.every((f) => f.fontName !== undefined && BOLD.test(f.fontName));
  // The trailing-punctuation refusal belongs to the bare signal alone: a bold or
  // all-caps heading that ends in a stop is still a heading.
  return bold || allCaps(l.text.trim()) || !/[.,]$/.test(l.text.trim());
}

export function classifyBlock(lines: TextLine[], ctx: ClassifyContext): LineClass[] {
  const tol = tolerance(ctx.bodySize);
  const code = lines.map((l) => isCodeLine(l));
  const markers = lines.map((l, i) => (code[i] ? undefined : markerOf(l)));

  // A marked line forms an item only with corroboration: an adjacent marked
  // line, or a following line indented to its own body x. Without this,
  // '1990. It was a good year' is a list.
  const item = markers.map((m, i) => {
    if (!m) return false;
    if (markers[i - 1] || markers[i + 1]) return true;
    const next = lines[i + 1];
    return next !== undefined && !code[i + 1] && Math.abs(next.quad[0] - m.bodyX) <= tol;
  });

  // Depth is the rank of the marker's x bucket among the buckets in this block.
  const xs = [...new Set(markers.filter((m, i) => item[i]).map((m) => m!.markerX))]
    .sort((a, b) => a - b);
  const buckets: number[] = [];
  for (const x of xs) {
    if (!buckets.length || x - buckets[buckets.length - 1] > tol) buckets.push(x);
  }
  const depthOf = (x: number): number => {
    let d = 0;
    for (let i = 0; i < buckets.length; i++) if (x >= buckets[i] - tol) d = i;
    return d;
  };

  const out: LineClass[] = [];
  let open: LineMarker | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) { open = undefined; out.push({ kind: 'code' }); continue; }
    const m = markers[i];
    if (m && item[i]) { open = m; out.push({ kind: 'item', marker: m, depth: depthOf(m.markerX) }); continue; }
    if (open && Math.abs(lines[i].quad[0] - open.bodyX) <= tol) { out.push({ kind: 'continuation' }); continue; }
    open = undefined;
    out.push(isHeading(lines, i, ctx, tol) ? { kind: 'heading' } : { kind: 'text' });
  }
  return out;
}
