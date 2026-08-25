// The adaptive merge behind DOCX textbox mode: which consecutive glyphs belong
// in one positioned frame. Pure — glyph events in, groups out — so every
// threshold is testable without building a PDF, the split docinfer.ts makes.
import type { GlyphEvent } from './text.js';
import type { Rgb } from './colorspace.js';

/** One frame's worth of text: the glyphs sharing a baseline, a size, an
 *  emphasis and a colour, with no gap wide enough to be a layout decision. */
export interface TextGroup {
  /** Page-space axis box [x0,y0,x1,y1] covering every glyph in the group. */
  quad: [number, number, number, number];
  fontSize: number;
  text: string;
  /** Absent when black — the fence `GlyphEvent.color` sets. */
  color?: Rgb;
  bold?: boolean;
  italic?: boolean;
  /** True when any contributing glyph was rotated or vertically set. A frame
   *  has no rotation to give it, so `docxtextbox.ts` reads this only to place
   *  the group unrotated and to count it for the limitation. */
  skewed?: boolean;
}

export interface GroupOptions {
  /** Gap that starts a new group, as a multiple of the font size. Default 0.6.
   *
   *  Bounded from opposite sides by the two cases that matter: a leader row
   *  (`Introduction ....... 3`) must split, and an ordinary inter-word space
   *  must not. A space is ~0.25em in the Latin Standard-14 faces, and a
   *  deliberate layout gap is a whole em or more. */
  gapEm?: number;
  /** Baseline difference tolerated within one group, as a multiple of the font
   *  size. Default 0.02 — enough for floating-point residue and a kerned pair,
   *  far below a line's leading. */
  baselineTol?: number;
}

const DEFAULT_GAP_EM = 0.6;
const DEFAULT_BASELINE_TOL = 0.02;

const sameColor = (a: Rgb | undefined, b: Rgb | undefined): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** True when `e` continues the group whose last glyph is `prev`.
 *
 *  **Invariant:** colour is part of the test. This is the whole reason the
 *  module groups GLYPHS rather than `TextFragment`s — fragments merge across
 *  colour changes by design, so grouping from them would paint a line the
 *  colour of its first word, and the boundary cannot be recovered once the
 *  fragment has dissolved it. */
function continues(prev: GlyphEvent, e: GlyphEvent, gapEm: number, tol: number): boolean {
  if (e.fontSize !== prev.fontSize) return false;
  if (!sameColor(e.color, prev.color)) return false;
  if (e.font?.bold !== prev.font?.bold || e.font?.italic !== prev.font?.italic) return false;
  if (Math.abs(e.quad[1] - prev.quad[1]) > prev.fontSize * tol) return false;
  // Measured from the previous glyph's right edge to this one's left, so a
  // negative value — an overlap from kerning, or a marker painted backwards —
  // is never a split.
  return e.quad[0] - prev.quad[2] <= prev.fontSize * gapEm;
}

const isSkewed = (e: GlyphEvent): boolean =>
  (e.angle !== undefined && Math.abs(e.angle) > 1e-6) || e.vertical === true;

/** Group consecutive glyphs into the runs a positioned frame will hold. */
export function groupGlyphs(glyphs: GlyphEvent[], opts: GroupOptions = {}): TextGroup[] {
  const gapEm = opts.gapEm ?? DEFAULT_GAP_EM;
  const tol = opts.baselineTol ?? DEFAULT_BASELINE_TOL;
  const out: TextGroup[] = [];
  let cur: TextGroup | undefined;
  let prev: GlyphEvent | undefined;

  for (const e of glyphs) {
    if (!cur || !prev || !continues(prev, e, gapEm, tol)) {
      cur = {
        quad: [e.quad[0], e.quad[1], e.quad[2], e.quad[3]],
        fontSize: e.fontSize,
        text: e.text,
        ...(e.color ? { color: e.color } : {}),
        ...(e.font?.bold ? { bold: true } : {}),
        ...(e.font?.italic ? { italic: true } : {}),
        ...(isSkewed(e) ? { skewed: true } : {}),
      };
      out.push(cur);
    } else {
      cur.text += e.text;
      cur.quad[0] = Math.min(cur.quad[0], e.quad[0]);
      cur.quad[1] = Math.min(cur.quad[1], e.quad[1]);
      cur.quad[2] = Math.max(cur.quad[2], e.quad[2]);
      cur.quad[3] = Math.max(cur.quad[3], e.quad[3]);
      if (isSkewed(e)) cur.skewed = true;
    }
    prev = e;
  }
  return out;
}
