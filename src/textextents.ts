/** Max-content and min-content widths of a piece of text (zch2.10).
 *
 *  Invariant: a pure leaf. Extracted from tableauthor.ts because a CSS float's
 *  shrink-to-fit asks the same question a table column's auto-fit does, and two
 *  copies is two answers to "how wide does this content want to be".
 *
 *  Invariant: LINES rather than the whole string. A hard break means measuring
 *  across one would demand a box wide enough for every line at once.
 *
 *  Invariant: words are found on the CONCATENATED run text, because a word may
 *  span a run boundary (`**bold**text` is one word) — which is what layoutRuns
 *  does for break opportunities — while each piece is still measured at its own
 *  run's font. Only U+0020 and '\n' break, so the U+00A0 a code block paints
 *  for indentation keeps its line intact.
 *
 *  Note the DUPLICATED `measuringDriverFor`: tableauthor.ts keeps its own copy
 *  because it has two more callers there (its row-height walk). Six lines, and
 *  not a rule that can drift — a driver that measures like the real font and
 *  encodes nothing is those six lines in both places or it is broken in one,
 *  which its own callers show immediately. */

import type { AuthoringFont } from './stamp.js';
import { isTextRunList, type TextRun } from './textdecor.js';
import { winAnsiDriver, type FontDriver } from './layout.js';
import { EmbeddedFont } from './embeddedfont.js';

const EMPTY = new Uint8Array(0);

/** One piece of content with the font it measures at. */
interface Piece { text: string; driver: FontDriver; fontSize: number }

/** A driver that measures like the real font but records no glyph usage —
 *  `encode` returns empty bytes, which measurement ignores. Keeps measuring
 *  side-effect-free for embedded fonts. */
function measuringDriverFor(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => EMPTY };
}

/** Width of the concatenated pieces' [from, to) slice, measured piece by piece
 *  so each keeps its own font. Summing per piece agrees exactly with measuring
 *  the whole string for the WinAnsi and Identity-H drivers — a string's width
 *  is the sum of its glyph advances — which is the rule layoutRuns uses. */
function sliceWidth(pieces: Piece[], from: number, to: number): number {
  let w = 0;
  let at = 0;
  for (const p of pieces) {
    const s = Math.max(from, at);
    const e = Math.min(to, at + p.text.length);
    if (e > s) w += p.driver.measure(p.text.slice(s - at, e - at), p.fontSize);
    at += p.text.length;
  }
  return w;
}

/**
 * The widest single LINE (max-content) and widest single WORD (min-content) of
 * `text`, in points. A run's own `font`/`fontSize` win over the block's.
 *
 * `atomics` are boxes placed among the runs (`dsw8`) — a table cell's inline
 * images. They widen both answers, and the rule is deliberately APPROXIMATE in
 * the direction that is safe:
 *
 * - **max-content** adds every atomic's width, because a line holding all the
 *   text also holds all the boxes. Exact whenever the cell is one line, which
 *   is what max-content means.
 * - **min-content** takes the widest atomic as a floor. An atomic is U+FFFC to
 *   the wrapping engine, a non-space character, so `a<img>b` is really ONE
 *   unbreakable unit and the true min-content can be wider than this. Erring
 *   NARROW is the safe direction: `layoutRuns` clamps an atomic wider than its
 *   box, so the picture shrinks to fit a column rather than overflowing it.
 */
export function textExtents(
  text: string | TextRun[], font: AuthoringFont, fontSize: number,
  atomics?: readonly { width: number }[],
): { longestLine: number; longestWord: number } {
  const pieces: Piece[] = isTextRunList(text)
    ? text.map((r) => ({
      text: r.text,
      driver: measuringDriverFor(r.font ?? font),
      fontSize: r.fontSize ?? fontSize,
    }))
    : [{ text, driver: measuringDriverFor(font), fontSize }];
  const all = pieces.map((p) => p.text).join('');
  let longestLine = 0;
  let longestWord = 0;
  let lineStart = 0;
  let wordStart = 0;
  for (let i = 0; i <= all.length; i++) {
    const ch = i < all.length ? all[i] : '\n';
    if (ch !== '\n' && ch !== ' ') continue;
    if (i > wordStart) longestWord = Math.max(longestWord, sliceWidth(pieces, wordStart, i));
    wordStart = i + 1;
    if (ch === '\n') {
      longestLine = Math.max(longestLine, sliceWidth(pieces, lineStart, i));
      lineStart = i + 1;
    }
  }
  if (atomics !== undefined && atomics.length > 0) {
    for (const a of atomics) {
      longestLine += a.width;
      longestWord = Math.max(longestWord, a.width);
    }
  }
  return { longestLine, longestWord };
}
