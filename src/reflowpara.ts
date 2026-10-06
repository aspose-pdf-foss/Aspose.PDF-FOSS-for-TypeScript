// The paragraph around an edit, for ReplaceText({ adjust: 'reflow' }) (u3l5.5).
// Pure over glyph events and the page's layout: it reads no content stream and
// allocates nothing, and answers a Paragraph or the reason it will not reflow.
import type { GlyphEvent } from './text.js';
import { groupLineBlocks } from './text.js';
import type { ContentAddr } from './editcontent.js';
import type { ChainGap } from './replaceadjust.js';
import type { UnreflowableReason } from './replacefont.js';

export type Rect = [number, number, number, number];

/** A word: the text glyphs between two gaps, in reading order. */
export interface ParaWord { glyphs: GlyphEvent[]; start: number; end: number; line: number }
/** An original line: its words [first, last], baseline and edges. */
export interface ParaLine { first: number; last: number; baseline: number; left: number; right: number }

export interface Paragraph {
  /** Every glyph of the paragraph, text-less ones included. */
  members: Set<GlyphEvent>;
  words: ParaWord[];
  lines: ParaLine[];
  /** The natural gap BEFORE each word, device units; 0 for the first. */
  gaps: number[];
  box: Rect;
  pitch: number;
  /** The median member glyph font size. */
  size: number;
  align: 'left' | 'right' | 'center' | 'justify';
  /** Line 0's left minus the other lines'. */
  indent: number;
}

export interface ParaInput {
  all: readonly GlyphEvent[];
  text: string;
  refs: readonly (GlyphEvent | undefined)[];
  covered: Uint8Array;
  /** The paragraph a TEXT glyph belongs to; undefined for none. */
  keyOf: (g: GlyphEvent) => unknown;
  anchor: GlyphEvent;
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap;
  /** Images and paths. */
  inks: readonly Rect[];
  annots: readonly { subtype: string; rect: Rect }[];
}

/** Annotations anchored to glyphs, which move with them. */
export const MOVABLE_ANNOTS: ReadonlySet<string> = new Set(['Link', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

const TOL = 0.5;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const overlaps = (a: Rect, b: Rect): boolean =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.01 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.01;

/** The untagged paragraph key: the block (`groupLineBlocks`) of the layout
 *  line a glyph sits on. */
export function untaggedKeys(text: string, refs: readonly (GlyphEvent | undefined)[]): (g: GlyphEvent) => unknown {
  const quads: Rect[] = [];
  const lineOf = new Map<GlyphEvent, number>();
  let line = 0;
  let q: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  const close = () => { quads.push(q); q = [Infinity, Infinity, -Infinity, -Infinity]; line++; };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { close(); continue; }
    const g = refs[i];
    if (!g) continue;
    lineOf.set(g, line);
    q = [Math.min(q[0], g.quad[0]), Math.min(q[1], g.quad[1]), Math.max(q[2], g.quad[2]), Math.max(q[3], g.quad[3])];
  }
  close();
  const blocks = groupLineBlocks(quads.map((quad) => ({ quad })));
  // **Invariant (u3l5.11):** `groupLineBlocks` splits on LEFT edges, so the
  // short last line of a centred or right-aligned paragraph sitting far in
  // from the others becomes a block of its own, and growth was refused
  // 'no-room'. A one-line block joins the block above when that block holds
  // two or more lines sharing a centre (or a right edge) the line shares too,
  // and the line continues its pitch and size.
  for (let l = 1; l < quads.length; l++) {
    if (blocks[l] === blocks[l - 1] || (l + 1 < quads.length && blocks[l + 1] === blocks[l])) continue;
    const above: number[] = [];
    for (let k = l - 1; k >= 0 && blocks[k] === blocks[l - 1]; k--) above.unshift(k);
    if (above.length < 2) continue;
    const q = quads[l];
    const h = (r: Rect) => r[3] - r[1];
    const pitches = above.slice(1).map((k, i) => quads[above[i]][1] - quads[k][1]);
    const pitch = median(pitches), size = median(above.map((k) => h(quads[k])));
    const drop = quads[above[above.length - 1]][1] - q[1];
    if (Math.abs(drop - pitch) > 0.1 * pitch || Math.abs(h(q) - size) > 0.2 * size) continue;
    const agreeOn = (f: (r: Rect) => number) => [...above, l].every((k) => Math.abs(f(quads[k]) - f(quads[above[0]])) <= TOL);
    if (agreeOn((r) => (r[0] + r[2]) / 2) || agreeOn((r) => r[2])) blocks[l] = blocks[l - 1];
  }
  return (g) => { const l = lineOf.get(g); return l === undefined ? undefined : blocks[l]; };
}

/** The 2x2 linear part of `tm x ctm`: upright means no skew or rotation,
 *  positive axes, and EQUAL axis scale — a kern is sized by the font size,
 *  which only means one thing when both axes agree. */
function upright(g: GlyphEvent): boolean {
  const [a1, b1, c1, d1] = g.tm, [a2, b2, c2, d2] = g.ctm;
  const a = a1 * a2 + b1 * c2, b = a1 * b2 + b1 * d2, c = c1 * a2 + d1 * c2, d = c1 * b2 + d1 * d2;
  const eps = 1e-6 * Math.max(Math.abs(a), Math.abs(d), 1);
  return a > 0 && d > 0 && Math.abs(b) < eps && Math.abs(c) < eps && Math.abs(a - d) < eps;
}

export function findParagraph(inp: ParaInput): Paragraph | UnreflowableReason {
  const { all, text, refs, covered, keyOf, anchor, gap } = inp;
  const key = keyOf(anchor);
  if (key === undefined) return 'not-found';

  // Membership: a text glyph by its key; a text-less one inherits from the
  // glyph its pen is CHAINED to, before it, else after it.
  const members = new Set<GlyphEvent>();
  const isText = (g: GlyphEvent) => g.text !== '';
  const lastIn = new Map<string, GlyphEvent>();
  const pendingTextless = new Map<string, GlyphEvent[]>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    const prev = lastIn.get(scope);
    const chained = prev !== undefined && gap(prev.addr, g.addr) === 'none';
    if (isText(g)) {
      const mine = keyOf(g) === key;
      if (mine) members.add(g);
      for (const t of pendingTextless.get(scope) ?? []) if (mine) members.add(t);
      pendingTextless.delete(scope);
    } else if (chained && members.has(prev)) {
      members.add(g);
    } else if (chained || prev === undefined) {
      const l = pendingTextless.get(scope);
      if (l) l.push(g); else pendingTextless.set(scope, [g]);
    }
    lastIn.set(scope, g);
  }

  // Shape and scope.
  const memberList = all.filter((g) => members.has(g));
  for (const g of memberList) {
    if (g.vertical) return 'vertical';
    if (Math.abs(g.angle) > 0.01 || !upright(g)) return 'rotated';
  }
  const path0 = memberList[0].addr.path.join('\0');
  if (memberList.some((g) => g.addr.path.join('\0') !== path0)) return 'scopes';

  // Interleaving: a chained pair with exactly one member drags the other.
  const prevIn = new Map<string, GlyphEvent>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    const prev = prevIn.get(scope);
    if (prev && gap(prev.addr, g.addr) === 'none' && members.has(prev) !== members.has(g)) return 'interleaved';
    prevIn.set(scope, g);
  }

  // Words and lines over the member text positions, in reading order.
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) { const g = refs[i]; if (g && members.has(g)) positions.push(i); }
  const lo = positions[0], hi = positions[positions.length - 1];
  const words: ParaWord[] = [];
  const lines: ParaLine[] = [];
  let line = 0;
  let cur: ParaWord | undefined;
  const endWord = () => { if (cur) { words.push(cur); cur = undefined; } };
  for (let i = lo; i <= hi; i++) {
    const ch = text[i];
    if (ch === '\n') { endWord(); line++; continue; }
    if (ch === ' ' && !covered[i]) { endWord(); continue; }
    const g = refs[i];
    if (g && !members.has(g)) return 'foreign-ink';
    if (!cur) cur = { glyphs: [], start: i, end: i + 1, line };
    if (g && cur.glyphs[cur.glyphs.length - 1] !== g) cur.glyphs.push(g);
    cur.end = i + 1;
  }
  endWord();
  // Renumber lines densely (a blank layout line holds no word).
  const used = [...new Set(words.map((w) => w.line))];
  for (const w of words) w.line = used.indexOf(w.line);
  for (let l = 0; l < used.length; l++) {
    const first = words.findIndex((w) => w.line === l);
    let last = first;
    while (last + 1 < words.length && words[last + 1].line === l) last++;
    const gl = words.slice(first, last + 1).flatMap((w) => w.glyphs);
    lines.push({
      first, last,
      baseline: words[first].glyphs[0].quad[1],
      left: words[first].glyphs[0].quad[0],
      right: Math.max(...gl.map((g) => g.quad[2])),
    });
  }

  const box: Rect = [
    Math.min(...memberList.map((g) => g.quad[0])), Math.min(...memberList.map((g) => g.quad[1])),
    Math.max(...memberList.map((g) => g.quad[2])), Math.max(...memberList.map((g) => g.quad[3])),
  ];
  for (const g of all) if (g.text && !members.has(g) && overlaps(box, g.quad)) return 'foreign-ink';
  for (const r of inp.inks) if (overlaps(box, r)) return 'foreign-ink';
  for (const a of inp.annots) if (overlaps(box, a.rect) && !MOVABLE_ANNOTS.has(a.subtype)) return 'annotation';

  const size = median(memberList.filter(isText).map((g) => g.fontSize));
  let pitch = 1.2 * size;
  if (lines.length >= 2) {
    const drops = lines.slice(1).map((l, i) => lines[i].baseline - l.baseline);
    pitch = median(drops);
    if (drops.some((d) => Math.abs(d - pitch) > 0.1 * pitch)) return 'pitch';
  }

  // Alignment, from the original edges.
  const n = lines.length;
  const agree = (xs: number[]) => xs.length > 0 && Math.max(...xs) - Math.min(...xs) <= TOL;
  const lefts = lines.map((l) => l.left), rights = lines.map((l) => l.right);
  let align: Paragraph['align'] = 'left';
  let indent = 0;
  if (n >= 3 && agree(lefts.slice(1)) && agree(rights.slice(0, n - 1))) align = 'justify';
  // With two lines `lefts.slice(1)` is one value and agrees with itself, so it
  // says nothing; there the lefts must agree outright, or a centred pair reads
  // as left. An indented pair still lands on left, as the fallback.
  else if (n >= 2 && agree(lefts.slice(1)) && (n > 2 || agree(lefts))) align = 'left';
  else if (n >= 2 && agree(rights)) align = 'right';
  else if (n >= 2 && agree(lines.map((l) => (l.left + l.right) / 2))) align = 'center';
  if ((align === 'left' || align === 'justify') && n >= 2) indent = lines[0].left - lines[1].left;

  // Gaps: measured on a line; a line start takes the median, and justified
  // text takes its LAST line's median (the one line not stretched), else the
  // smallest gap measured.
  const measured: (number | undefined)[] = words.map((w, i) => {
    if (i === 0 || words[i - 1].line !== w.line) return undefined;
    const prev = words[i - 1].glyphs[words[i - 1].glyphs.length - 1];
    return w.glyphs[0].quad[0] - prev.penEnd[0];
  });
  // A gap wider than two em is not a word gap: `layoutLines` joins every
  // glyph on one baseline, so two COLUMNS sharing baselines arrive as one
  // paragraph with the gutter as a gap. Re-wrapping would pour one column into
  // the other; refuse instead.
  if (measured.some((x) => x !== undefined && x > 2 * size)) return 'foreign-ink';
  const known = measured.filter((x): x is number => x !== undefined);
  let base = known.length ? median(known) : 0.25 * size;
  if (align === 'justify') {
    const last = measured.filter((x, i): x is number => x !== undefined && words[i].line === n - 1);
    base = last.length ? median(last) : Math.min(...known);
  }
  const gaps = words.map((_, i) => (i === 0 ? 0 : align === 'justify' ? base : measured[i] ?? base));

  return { members, words, lines, gaps, box, pitch, size, align, indent };
}
