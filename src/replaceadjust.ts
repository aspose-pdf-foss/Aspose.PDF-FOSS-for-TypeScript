// What the rest of a line does when a replacement changes its width (u3l5.4).
// Pure over glyph events and the edits `planReplace` decided: it reads no
// content stream and allocates nothing, and hands back the TJ kerns to insert.
import type { GlyphEvent } from './text.js';
import type { ContentAddr } from './editcontent.js';
import type { ReplaceAdjust, Run } from './replacefont.js';
import { driverFor } from './stamp.js';

/** One planned edit, as the adjustment sees it. */
export interface AdjustEdit {
  /** The edit's first glyph: its op, its text state, its line. */
  anchor: GlyphEvent;
  elementIndex: number;
  /** The byte range of the show string the edit replaces. */
  start: number;
  end: number;
  /** Where the pen ends up relative to before, in device units along the
   *  baseline: what the edit writes minus what it removes. */
  delta: number;
  /** [pos, endPos) in the page's assembled text: the characters it rewrote. */
  pos: number;
  endPos: number;
}

/** A TJ kern to insert before the glyph at `byteStart` of `elementIndex`. */
export interface KernInsert { addr: ContentAddr; elementIndex: number; byteStart: number; value: number }

/** The page's assembled text, as the adjustment needs it. */
export interface AdjustLayout {
  text: string;
  /** 1 where a match covers the position. */
  covered: Uint8Array;
  /** Each text glyph's first position in `text`. */
  posOf: Map<GlyphEvent, number>;
  /** Per position, the glyph that drew it (`undefined` where layout inserted). */
  refs: readonly (GlyphEvent | undefined)[];
}

/** The most of its width a word gap gives up under `'spaceWidth'`: half, so
 *  words never touch and layout still reads the gap as a word break. */
export const GAP_SHRINK = 0.5;

/** Device units the pen moves along the baseline for one glyph. */
export const glyphAdvance = (g: GlyphEvent): number => g.advance * g.hscale * g.fontSize;

/** Device units the pen moves for `runs` written in `anchor`'s text state.
 *  The same arithmetic `glyphDisplacement` applies, so a measured replacement
 *  ends where the pen will. */
export function runsAdvance(runs: readonly Run[], anchor: GlyphEvent): number {
  const tfs = Math.abs(anchor.tfSize);
  if (tfs === 0) return 0;
  const unit = (anchor.fontSize / tfs) * anchor.hscale;
  let total = 0;
  for (const r of runs) {
    const size = Math.abs(r.style?.size ?? anchor.tfSize);
    if (r.font === 'original') {
      for (const gl of anchor.font.decodeGlyphs(r.bytes)) {
        total += (gl.width * size + anchor.charSpacing + (gl.isWordSpace ? anchor.wordSpacing : 0)) * unit;
      }
    } else {
      // A Standard-14 face writes one byte a character, so its spaces take
      // `Tw`; an embedded face is written as Type0 2-byte codes, which do not.
      const chars = [...r.text];
      const spaces = typeof r.font === 'string' ? chars.filter((c) => c === ' ').length : 0;
      total += (driverFor(r.font).measure(r.text, size) + chars.length * anchor.charSpacing + spaces * anchor.wordSpacing) * unit;
    }
  }
  return total;
}

/**
 * The kerns that put the rest of each edited line where `mode` says it goes.
 *
 * **Invariant:** it compares two shifts per glyph. The NATURAL shift is what
 * the edits already do: a show operator's pen is relative, so everything after
 * an edit in its pen CHAIN — the same operator, or a later one with no
 * positioning operator between (`breaks`) — already moves by the edit's delta,
 * and a `Td`/`Tm`/`T*`/`BT` starts again from zero. The DESIRED shift is the
 * mode's. A kern is inserted only where the two differ, so text no edit
 * reaches is never touched, and a chain whose natural shift is already right
 * gets nothing.
 *
 * **Invariant:** the desired shift is decided in READING order on the layout
 * line, while the natural shift runs in CONTENT order. A line drawn out of
 * order — a word placed before an edit in the stream but after it on the page
 * — is shifted by where it reads, which is what "the rest of the line" means.
 */
export function planAdjustment(
  mode: ReplaceAdjust, glyphs: readonly GlyphEvent[], edits: readonly AdjustEdit[],
  layout: AdjustLayout, breaks: (a: ContentAddr, b: ContentAddr) => boolean,
): KernInsert[] {
  if (mode === 'none' || edits.length === 0) return [];
  const { text, covered, posOf, refs } = layout;

  // Per position: the line it is on and how many word gaps precede it. A gap
  // is a RUN of spaces no match covers, drawn or inserted by layout between
  // runs, counted at its first space: two spaces are one gap, or each would
  // give half the pair and the words would touch.
  const lineEnd = new Int32Array(text.length + 1);
  for (let i = text.length - 1, end = text.length; i >= 0; i--) {
    if (text[i] === '\n') end = i;
    lineEnd[i] = end;
  }
  lineEnd[text.length] = text.length;
  const isGap = (i: number): boolean => text[i] === ' ' && !covered[i] && !(i > 0 && text[i - 1] === ' ');
  const gaps = new Int32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) gaps[i + 1] = gaps[i] + (isGap(i) ? 1 : 0);

  /** The width along the baseline of the gap starting at `i`: from where the
   *  glyph before it ends to where the glyph after its last space starts.
   *  Infinite where either is missing. */
  const gapWidth = (i: number): number => {
    const a = i - 1;
    let b = i + 1;
    while (b < text.length && text[b] === ' ') b++;
    const prev = refs[a], next = refs[b];
    if (!prev || !next) return Infinity;
    const cos = Math.cos(prev.angle), sin = Math.sin(prev.angle);
    const adv = glyphAdvance(next);
    const sx = next.penEnd[0] - adv * Math.cos(next.angle), sy = next.penEnd[1] - adv * Math.sin(next.angle);
    return (sx - prev.penEnd[0]) * cos + (sy - prev.penEnd[1]) * sin;
  };
  /** Per edit under `'spaceWidth'`: how much each gap after it gives. A
   *  narrower replacement widens the gaps freely; a wider one takes at most
   *  `GAP_SHRINK` of the narrowest, and what the gaps cannot absorb shifts the
   *  rest of the line as `'shiftRest'` would. */
  const perGap = new Map<AdjustEdit, number>();
  if (mode === 'spaceWidth') {
    for (const e of edits) {
      const n = gaps[lineEnd[e.endPos]] - gaps[e.endPos];
      if (n === 0) continue;
      // A negative share (a narrower replacement) passes the cap untouched.
      let narrowest = Infinity;
      for (let i = e.endPos; i < lineEnd[e.endPos]; i++) {
        if (isGap(i)) narrowest = Math.min(narrowest, gapWidth(i));
      }
      perGap.set(e, Math.min(e.delta / n, Math.max(0, narrowest * GAP_SHRINK)));
    }
  }

  /** The shift the mode wants for a glyph read at `p`: each earlier edit on
   *  its line, less what the gaps between them gave. */
  const desired = (p: number): number => {
    let s = 0;
    for (const e of edits) {
      if (e.pos >= p || lineEnd[e.pos] !== lineEnd[p]) continue;
      s += e.delta - (perGap.get(e) ?? 0) * Math.max(0, gaps[p] - gaps[e.endPos]);
    }
    return s;
  };

  // Which edit, if any, rewrote a given glyph: by its op, element and bytes.
  const opKey = (a: ContentAddr, el: number) => `${a.path.join('\0')}|${a.streamIndex}|${a.opIndex}|${el}`;
  const byOp = new Map<string, AdjustEdit[]>();
  for (const e of edits) {
    const k = opKey(e.anchor.addr, e.elementIndex);
    const l = byOp.get(k);
    if (l) l.push(e); else byOp.set(k, [e]);
  }
  const editOf = (g: GlyphEvent): AdjustEdit | undefined =>
    byOp.get(opKey(g.addr, g.elementIndex))?.find((e) => g.byteStart >= e.start && g.byteStart < e.end);

  const out: KernInsert[] = [];
  const seenEdit = new Set<AdjustEdit>();
  const placed = new Set<string>();
  // Per scope: the shift the pen carries and the last glyph seen there. A form
  // keeps its own chain, so its glyphs interleaved with the page's break none.
  const chain = new Map<string, { carried: number; last: GlyphEvent }>();
  const correct = (g: GlyphEvent, el: number, byte: number, want: number, st: { carried: number }) => {
    const c = want - st.carried;
    const per = g.fontSize * g.hscale;
    if (Math.abs(c) < 1e-6 || per === 0) return;
    const key = `${opKey(g.addr, el)}|${byte}`;
    // A form drawn twice is one stream: its first drawing decides.
    if (placed.has(key)) return;
    placed.add(key);
    out.push({ addr: g.addr, elementIndex: el, byteStart: byte, value: Math.round(-c * 1000 / per * 1000) / 1000 });
    st.carried = want;
  };
  for (const g of glyphs) {
    const scope = g.addr.path.join('\0');
    let st = chain.get(scope);
    if (!st || breaks(st.last.addr, g.addr)) st = { carried: 0, last: g };
    chain.set(scope, st);
    st.last = g;
    const e = editOf(g);
    if (e) {
      if (seenEdit.has(e)) continue;
      seenEdit.add(e);
      correct(e.anchor, e.elementIndex, e.start, desired(e.pos), st);
      st.carried += e.delta;
      continue;
    }
    const p = posOf.get(g);
    if (p === undefined) continue;   // draws no text: rides along with its chain
    correct(g, g.elementIndex, g.byteStart, desired(p), st);
  }
  return out;
}
