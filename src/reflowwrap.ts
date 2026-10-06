// Where each glyph of a reflowed paragraph lands (u3l5.5). Pure: words go
// through layoutRuns as ATOMIC boxes — the one wrapping engine — with each gap
// a one-space run measured at exactly that gap, so lines break only BETWEEN
// words and a replacement containing spaces stays one unit.
import type { GlyphEvent } from './text.js';
import type { Paragraph } from './reflowpara.js';
import { layoutRuns, type FontDriver, type LayoutRun } from './layout.js';

export interface WrapInput {
  para: Paragraph;
  advanceOf: (g: GlyphEvent) => number;
  /** The original offset from the glyph before `g` in its word to `g` — a
   *  TJ kern — kept when the word moves; absent means 0. */
  leadOf?: (g: GlyphEvent) => number;
  firstEdited: number;
  lastEdited: number;
}
export interface WrapResult {
  targets: Map<GlyphEvent, [number, number]>;
  addedLines: number;
  lowest: number;
}

/** Device units the wrap box is widened by; far below anything visible. */
const BOX_SLACK = 1e-3;

/** A driver whose space is exactly `w` wide. */
const gapDriver = (w: number): FontDriver => ({
  measure: (t) => (t === ' ' ? w : 0),
  encode: () => new Uint8Array([0x20]),
  probe: (t) => t.length,
});

export function wrapParagraph(inp: WrapInput): WrapResult {
  const { para: p, advanceOf } = inp;
  const targets = new Map<GlyphEvent, [number, number]>();
  const lead = (g: GlyphEvent, i: number) => (i > 0 && inp.leadOf ? inp.leadOf(g) : 0);
  const width = (w: number) => p.words[w].glyphs.reduce((s, g, i) => s + lead(g, i) + advanceOf(g), 0);
  // Place a word's glyphs from x on a line whose baseline is y; a glyph keeps
  // its rise relative to its ORIGINAL line's baseline.
  const place = (w: number, x: number, y: number): number => {
    const word = p.words[w];
    const lineBase = p.lines[word.line].baseline;
    word.glyphs.forEach((g, i) => {
      x += lead(g, i);
      targets.set(g, [x, y + (g.quad[1] - lineBase)]);
      x += advanceOf(g);
    });
    return x;
  };

  const L = p.words[inp.firstEdited].line;
  // Lines before the edit keep their places.
  for (let w = 0; w < p.lines[L].first; w++) {
    for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1]]);
  }

  const boxLeft = p.align === 'right' || p.align === 'center'
    ? Math.min(...p.lines.map((l) => l.left))
    : p.lines.length >= 2 ? p.lines[1].left : p.lines[0].left;
  const boxRight = Math.max(...p.lines.map((l) => l.right));
  const indent = L === 0 ? p.indent : 0;

  // Runs: atomic word, then a gap run before each later word. Zero-width words
  // (wholly deleted) drop out with their gap.
  const runs: LayoutRun[] = [];
  const runWord: number[] = [];   // run index -> word index, for atomics
  for (let w = p.lines[L].first; w < p.words.length; w++) {
    const wd = width(w);
    if (wd <= 0) continue;
    if (runs.length > 0) { runs.push({ text: ' ', driver: gapDriver(p.gaps[w]), fontSize: p.size }); runWord.push(-1); }
    runs.push({ atomic: { width: wd, height: p.size, align: 'baseline' } });
    runWord.push(w);
  }
  // The box is only known as wide as its widest line, which the same words
  // must still fit: summing their advances can land a few ulps past the
  // measured edge, so the box gets a hair of slack.
  const laid = layoutRuns(runs, boxRight - boxLeft + BOX_SLACK, 1e9, p.pitch, p.size, indent).lines;
  const newLines = laid.map((ln) => ln.segments.filter((s) => s.atomic).map((s) => runWord[s.run]));

  // Convergence: the first new line (after the first) starting where an
  // original line starts, past the last edit.
  let used = newLines.length;
  let shift = newLines.length - (p.lines.length - L);
  for (let k = 1; k < newLines.length; k++) {
    const first = newLines[k][0];
    if (first === undefined || first <= inp.lastEdited) continue;
    const j = p.lines.findIndex((l) => l.first === first);
    if (j > L) { used = k; shift = (L + k) - j; break; }
  }

  const baseY = p.lines[L].baseline;
  for (let k = 0; k < used; k++) {
    const ws = newLines[k];
    const y = baseY - k * p.pitch;
    const lineWidth = ws.reduce((s, w, i) => s + width(w) + (i > 0 ? p.gaps[w] : 0), 0);
    const left = boxLeft + (k === 0 ? indent : 0);
    const isLast = k === newLines.length - 1 && used === newLines.length;
    let x = p.align === 'right' ? boxRight - lineWidth
      : p.align === 'center' ? (boxLeft + boxRight) / 2 - lineWidth / 2
      : left;
    const extra = p.align === 'justify' && !isLast && ws.length > 1
      ? (boxRight - left - lineWidth) / (ws.length - 1) : 0;
    ws.forEach((w, i) => {
      if (i > 0) x += p.gaps[w] + extra;
      x = place(w, x, y);
    });
  }
  // Lines after convergence: their own breaks and x, moved by the shift.
  if (used < newLines.length) {
    const j0 = p.lines.findIndex((l) => l.first === newLines[used][0]);
    for (let j = j0; j < p.lines.length; j++) {
      for (let w = p.lines[j].first; w <= p.lines[j].last; w++) {
        for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1] - shift * p.pitch]);
      }
    }
  }
  // Zero-width words keep their original origin: they draw nothing.
  for (const w of p.words) for (const g of w.glyphs) if (!targets.has(g)) targets.set(g, [g.quad[0], g.quad[1]]);

  let lowest = Infinity;
  for (const [, [, y]] of targets) lowest = Math.min(lowest, y);
  return { targets, addedLines: shift, lowest };
}
