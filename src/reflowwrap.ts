// Where each glyph of a reflowed paragraph lands (u3l5.5). Pure: words go
// through layoutRuns as ATOMIC boxes — the one wrapping engine — with each gap
// a one-space run measured at exactly that gap, so lines break only BETWEEN
// words and a replacement containing spaces stays one unit.
import type { GlyphEvent } from './text.js';
import type { Paragraph } from './reflowpara.js';
import { layoutRuns, type FontDriver, type LayoutRun } from './layout.js';
import type { Hyphenator } from './hyphenate.js';

export interface WrapInput {
  para: Paragraph;
  advanceOf: (g: GlyphEvent) => number;
  /** The original offset from the glyph before `g` in its word to `g` — a
   *  TJ kern — kept when the word moves; absent means 0. */
  leadOf?: (g: GlyphEvent) => number;
  firstEdited: number;
  lastEdited: number;
  /** Hyphenate words that no longer fit (6y39); absent, the atomic wrap. */
  hyphen?: HyphenWrap;
}
export interface WrapResult {
  targets: Map<GlyphEvent, [number, number]>;
  addedLines: number;
  lowest: number;
  /** Where a word was broken with a hyphen (6y39); empty without one. */
  breaks: WrapBreak[];
  /** Each split glyph's drawn extent per line, hyphen included. */
  boxes: Map<GlyphEvent, LineBox[]>;
  /** Original line-end hyphen glyphs a rejoin removed. */
  suppressed: GlyphEvent[];
}

export interface WrapUnit { text: string; width: number; hyphen?: number }
export interface HyphenWrap {
  hyphenator: Hyphenator;
  manual: boolean;
  /** The units `g` draws, WITHOUT its kern lead: one for an untouched glyph,
   *  an edit anchor's units, none for a glyph its edit's anchor draws. */
  unitsOf(g: GlyphEvent): WrapUnit[];
  /** Whether a line-final drawn hyphen glyph may be removed (Task 4). */
  canSuppress(g: GlyphEvent): boolean;
}
export interface LineBox { x: number; y: number; width: number }
export interface WrapBreak {
  glyph: GlyphEvent; unit: number;
  /** Where unit + 1 of the SAME glyph starts, when the break is inside it. */
  tail?: [number, number];
  /** An original hyphen glyph kept at the line end: nothing is inserted. */
  own?: GlyphEvent;
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
  if (inp.hyphen) {
    const h = wrapHyphenated(inp, inp.hyphen);
    if (h) return h;
  }
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
  return { targets, addedLines: shift, lowest, breaks: [], boxes: new Map(), suppressed: [] };
}

/** First proxy code point: supplementary private use (plane 15). Its line-break
 *  class resolves to AL, so a proxied word breaks only at the points the
 *  adapter hands `layoutRuns`. Plane 15 holds 65,534 characters before its two
 *  noncharacters; a longer tail falls back to the whole-word wrap. */
const PROXY0 = 0xf0000;
const PROXY_LIMIT = 0xfffd;

/** One drawn unit placed by the hyphenated wrap. */
interface PUnit {
  w: number; g: GlyphEvent; k: number; text: string; lead: number; width: number;
  hyphen?: number;
  /** A drawn hyphen glyph following this unit that rejoining removed (Task 4). */
  own?: GlyphEvent;
}

/**
 * The wrap with hyphenation (6y39). Every drawn unit is its own LayoutRun
 * holding one unique proxy code point, measured at exactly the unit's lead
 * plus advance, so `layoutRuns` — the one wrapping engine — decides breaks
 * and heads exactly as `AddTextBlock({ hyphenate })` does, and `segment.run`
 * names the unit directly.
 *
 * **Invariant:** a separator space is measured by the PRECEDING run's driver,
 * so every unit's driver measures `' '` as the gap after its word; with no
 * hyphenation point the result is the atomic path's, glyph for glyph.
 */
function wrapHyphenated(inp: WrapInput, hy: HyphenWrap): WrapResult | undefined {
  const p = inp.para;
  const L = p.words[inp.firstEdited].line;
  const targets = new Map<GlyphEvent, [number, number]>();
  const boxes = new Map<GlyphEvent, LineBox[]>();
  const breaks: WrapBreak[] = [];
  const suppressed: GlyphEvent[] = [];
  for (let w = 0; w < p.lines[L].first; w++) {
    for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1]]);
  }
  const leadOf = (g: GlyphEvent, i: number) => (i > 0 && inp.leadOf ? inp.leadOf(g) : 0);

  const SHY = '\u00AD';
  const owns: GlyphEvent[] = [];
  /** Whether word `w` (`next`) continues `head` across a line-end SOFT
   *  hyphen (6y39): `head` ends its line in a U+00AD that nothing else
   *  touches and `next` begins the following line with a lower-case letter.
   *
   *  **Invariant:** a drawn '-' never rejoins, whatever the patterns say. It
   *  may be an author's compound hyphen, and the patterns cannot tell — en
   *  breaks well|known, self|evident and co|operate — so removing one changes
   *  the word. A soft hyphen is a break by definition, in either mode. */
  const rejoins = (head: PUnit[], next: PUnit[], w: number): boolean => {
    if (head.length < 2) return false;
    const h = head[head.length - 1];
    const hw = h.w;
    if (h.k !== 0 || hy.unitsOf(h.g).length !== 1 || h.text !== SHY || !hy.canSuppress(h.g)) return false;
    if (p.lines[p.words[hw].line].last !== hw || p.words[w].line !== p.words[hw].line + 1 || p.lines[p.words[w].line].first !== w) return false;
    return /^\p{Ll}/u.test(next[0].text);
  };

  // Joined words from line L on: their units and the gap before each.
  const words: { units: PUnit[]; gap: number; first: number }[] = [];
  for (let w = p.lines[L].first; w < p.words.length; w++) {
    const units: PUnit[] = [];
    p.words[w].glyphs.forEach((g, i) => {
      hy.unitsOf(g).forEach((u, k) => units.push({ w, g, k, text: u.text, lead: k === 0 ? leadOf(g, i) : 0, width: u.width, hyphen: u.hyphen }));
    });
    if (units.length === 0 || units.reduce((s, u) => s + u.lead + u.width, 0) <= 0) continue;
    const prev = words[words.length - 1];
    if (prev && rejoins(prev.units, units, w)) {
      const h = prev.units.pop()!;
      prev.units[prev.units.length - 1].own = h.g;
      prev.units.push(...units);
      owns.push(h.g);
      continue;
    }
    words.push({ units, gap: p.gaps[w], first: w });
  }
  const all = words.flatMap((x) => x.units);
  if (all.length > PROXY_LIMIT) return undefined;

  const runs: LayoutRun[] = [];
  const unitOfRun: number[] = [];   // run -> index into `all`, -1 for a gap run
  let n = 0;
  words.forEach((wd, wi) => {
    const after = wi + 1 < words.length ? words[wi + 1].gap : 0;
    if (wi > 0) { runs.push({ text: ' ', driver: gapDriver(wd.gap), fontSize: p.size }); unitOfRun.push(-1); }
    for (const u of wd.units) {
      runs.push({ text: String.fromCodePoint(PROXY0 + n), driver: unitDriver(u, after), fontSize: p.size });
      unitOfRun.push(n);
      n++;
    }
  });
  const unitAt = (cp: number): PUnit => all[cp - PROXY0];
  const adapter: Hyphenator = {
    points(word) {
      const us = [...word].map((ch) => unitAt(ch.codePointAt(0)!));
      const real = us.map((u) => u.text).join('');
      const at = new Map<number, number>();   // real offset -> proxy code-unit offset
      let r = 0;
      us.forEach((u, i) => { r += u.text.length; if (!at.has(r)) at.set(r, (i + 1) * 2); });
      const out = new Set<number>();
      for (const q of hy.hyphenator.points(real)) {
        const b = at.get(q);
        if (b !== undefined && b < word.length) out.add(b);
      }
      us.forEach((u, i) => { if (u.own && i + 1 < us.length) out.add((i + 1) * 2); });
      return [...out].sort((a, b) => a - b);
    },
  };

  const boxLeft = p.align === 'right' || p.align === 'center'
    ? Math.min(...p.lines.map((l) => l.left))
    : p.lines.length >= 2 ? p.lines[1].left : p.lines[0].left;
  const boxRight = Math.max(...p.lines.map((l) => l.right));
  const indent = L === 0 ? p.indent : 0;
  const laid = layoutRuns(runs, boxRight - boxLeft + BOX_SLACK, 1e9, p.pitch, p.size, indent, adapter).lines;

  // Each laid line as its units, with the hyphen drawn after the last.
  type Ent = { u: PUnit; i: number; hyphen: boolean };
  /** A joined word's first unit -> the gap before that word. */
  const gapOf = new Map(words.map((wd) => [wd.units[0], wd.gap] as const));
  const firstOfWord = new Set(gapOf.keys());
  const lines: Ent[][] = laid.map((ln) => ln.segments
    .filter((s) => unitOfRun[s.run] >= 0)
    .map((s) => ({ u: all[unitOfRun[s.run]], i: unitOfRun[s.run], hyphen: s.text.includes('-') })));

  // Convergence: a line (after the first) starting at the first unit of a
  // joined word that begins an original line, past the last edit. A line
  // beginning mid-word is never one.
  let used = lines.length;
  let shift = lines.length - (p.lines.length - L);
  for (let k = 1; k < lines.length; k++) {
    const e = lines[k][0];
    if (!e || !firstOfWord.has(e.u) || e.u.w <= inp.lastEdited) continue;
    const j = p.lines.findIndex((l) => l.first === e.u.w);
    if (j > L) { used = k; shift = (L + k) - j; break; }
  }

  const riseOf = (g: GlyphEvent, w: number) => g.quad[1] - p.lines[p.words[w].line].baseline;
  const hyphenWidth = (u: PUnit) => (u.own ? u.own.quad[2] - u.own.quad[0] : u.hyphen ?? 0);
  const addBox = (g: GlyphEvent, x: number, y: number, width: number) => {
    const list = boxes.get(g);
    const last = list?.[list.length - 1];
    if (last && last.y === y) last.width = x + width - last.x;
    else if (list) list.push({ x, y, width }); else boxes.set(g, [{ x, y, width }]);
  };
  const baseY = p.lines[L].baseline;
  const placed = new Set<GlyphEvent>();
  for (let k = 0; k < used; k++) {
    const ents = lines[k];
    const y0 = baseY - k * p.pitch;
    const gapsBefore = (e: Ent, idx: number) => idx > 0 && firstOfWord.has(e.u);
    let lineWidth = 0;
    ents.forEach((e, idx) => {
      if (gapsBefore(e, idx)) lineWidth += gapOf.get(e.u)!;
      lineWidth += (idx > 0 ? e.u.lead : 0) + e.u.width + (e.hyphen ? hyphenWidth(e.u) : 0);
    });
    const left = boxLeft + (k === 0 ? indent : 0);
    const isLast = k === lines.length - 1 && used === lines.length;
    const gapCount = ents.filter((e, idx) => gapsBefore(e, idx)).length;
    let x = p.align === 'right' ? boxRight - lineWidth
      : p.align === 'center' ? (boxLeft + boxRight) / 2 - lineWidth / 2
      : left;
    const extra = p.align === 'justify' && !isLast && gapCount > 0 ? (boxRight - left - lineWidth) / gapCount : 0;
    ents.forEach((e, idx) => {
      const { u } = e;
      if (gapsBefore(e, idx)) x += gapOf.get(u)! + extra;
      if (idx > 0) x += u.lead;          // a kern does not survive a line start
      const y = y0 + riseOf(u.g, u.w);
      placed.add(u.g);
      if (u.k === 0) targets.set(u.g, [x, y]);
      else if (idx === 0) {
        for (let b = breaks.length - 1; b >= 0; b--) {
          if (breaks[b].glyph === u.g) { breaks[b].tail = [x, y]; break; }
        }
      }
      addBox(u.g, x, y, u.width);
      x += u.width;
      if (e.hyphen) {
        const hw = hyphenWidth(u);
        if (u.own) {
          targets.set(u.own, [x, y0 + riseOf(u.own, u.w)]);
          breaks.push({ glyph: u.g, unit: u.k, own: u.own });
        } else {
          breaks.push({ glyph: u.g, unit: u.k });
          addBox(u.g, x - u.width, y, u.width + hw);
        }
        x += hw;
      }
    });
  }
  for (const h of owns) {
    const before = all.find((u) => u.own === h)!;
    if (!targets.has(h) && placed.has(before.g)) suppressed.push(h);
  }
  // A joined pair cannot straddle the convergence line, which starts a joined
  // word; one wholly past it keeps its hyphen through the loop below.
  if (used < lines.length) {
    const j0 = p.lines.findIndex((l) => l.first === lines[used][0].u.w);
    for (let j = j0; j < p.lines.length; j++) {
      for (let w = p.lines[j].first; w <= p.lines[j].last; w++) {
        for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1] - shift * p.pitch]);
      }
    }
  }
  for (const w of p.words) for (const g of w.glyphs) if (!targets.has(g) && !suppressed.includes(g)) targets.set(g, [g.quad[0], g.quad[1]]);
  let lowest = Infinity;
  for (const [, [, y]] of targets) lowest = Math.min(lowest, y);
  return { targets, addedLines: shift, lowest, breaks, boxes, suppressed };
}

/** A unit's driver: its proxy measures the unit, `' '` the gap after its
 *  word, `'-'` the hyphen it would end with (absent: no face, so `probe`
 *  reports 0 and `layoutRuns` skips the point). */
const unitDriver = (u: PUnit, gapAfter: number): FontDriver => ({
  measure: (t) => {
    let w = 0;
    for (const ch of t) w += ch === ' ' ? gapAfter : ch === '-' ? (u.own ? u.own.quad[2] - u.own.quad[0] : u.hyphen ?? 0) : u.lead + u.width;
    return w;
  },
  encode: () => new Uint8Array(0),
  probe: (t) => (t === '-' ? (u.hyphen !== undefined || u.own ? 1 : 0) : t.length),
});
