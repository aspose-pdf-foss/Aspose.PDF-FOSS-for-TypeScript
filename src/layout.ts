import { encodeWinAnsi } from './encoding.js';
import { measure, StdFont } from './metrics.js';
import { lineBreakOpportunities, LBRK } from './linebreak.js';

/** A font abstraction the layout/stamping engine measures and encodes through,
 *  letting one code path flow Standard-14 (1-byte WinAnsi) and embedded
 *  (2-byte Identity-H) text. `encode` may record used glyphs as a side effect,
 *  so it is only called for text that is actually drawn.
 *  @internal */
export interface FontDriver {
  /** Width of `text` in points at `fontSize` (unencodable chars dropped). */
  measure(text: string, fontSize: number): number;
  /** Show-string bytes for `text`; may record used glyphs (drawn text only). */
  encode(text: string): Uint8Array;
  /** Count of encodable units in `text`, WITHOUT recording any glyphs. Used to
   *  detect empty / fully-unencodable input before drawing. */
  probe(text: string): number;
}

/** A {@link FontDriver} over a Standard-14 face: WinAnsi bytes + AFM metrics. */
export function winAnsiDriver(font: StdFont): FontDriver {
  return {
    measure: (t, fs) => measure(font, encodeWinAnsi(t), fs),
    encode: (t) => encodeWinAnsi(t),
    probe: (t) => encodeWinAnsi(t).length,
  };
}

/** One run as the layout engine sees it: already resolved to a driver and a
 *  size. layout.ts never learns what an AuthoringFont is — stamp.ts owns that
 *  resolution, and owning it in one place is what keeps a block from being
 *  measured one way and painted another.
 *  @internal */
export interface LayoutRun {
  text: string;
  driver: FontDriver;
  fontSize: number;
}

/** The piece of one laid line contributed by one run.
 *  @internal */
export interface LaidSegment {
  /** Index into the `runs` array passed to {@link layoutRuns}. */
  run: number;
  text: string;
  width: number;
  bytes: Uint8Array;
}

/** A piece of unconsumed text, tagged with the run it came from.
 *  @internal */
export interface RunSlice { run: number; text: string }

/** A single positioned line produced by {@link layoutRuns}.
 *  @internal */
export interface LaidLine {
  /** The line's text (no trailing newline), all runs concatenated. */
  text: string;
  /** Measured width in points: the sum of the segment widths. */
  width: number;
  /** Encoded bytes for the whole line. Meaningful only for a single-run line;
   *  the emitter writes `segments`. */
  bytes: Uint8Array;
  /** True if this line ends a paragraph (an explicit `\n`) or is the last
   *  emitted line. Used to suppress justification on final/short lines. */
  hardBreak: boolean;
  /** The line split at run boundaries, in order. Never empty for a non-empty line. */
  segments: LaidSegment[];
  /** Largest `fontSize` among the runs with text on this line; the block's own
   *  size for a line with no text. The baseline sits this far below the line's
   *  band top, which is what keeps an oversized run inside the box. */
  maxFontSize: number;
  /** This line's band height: `max(leading, maxFontSize * leading / fontSize)`.
   *  The `max` collapses to `leading` for every line whose runs sit at or below
   *  the block size, which is what makes every existing caller byte-identical. */
  height: number;
}

/** Result of flowing text into a box.
 *  @internal */
export interface LayoutResult {
  /** Lines that fit within the box height. */
  lines: LaidLine[];
  /** Unconsumed text (`''` if everything fit), preserving spacing/newlines so a
   *  follow-on call re-flows the rest cleanly. */
  remainder: string;
}

/** Result of flowing runs into a box.
 *  @internal */
export interface RunLayoutResult {
  lines: LaidLine[];
  /** Unconsumed text as run slices (`[]` if everything fit). */
  remainder: RunSlice[];
}

// Tolerance so an exact n*leading box height fits n lines despite float drift.
const EPS = 1e-9;

/** One word: a half-open span [start, end) into the concatenated run text, plus
 *  whether a separator space precedes it on its line.
 *
 *  Lines are lists of these rather than one contiguous span, because the engine
 *  COLLAPSES runs of spaces — `a  b` lays out as `a b`. A span-based line would
 *  preserve the double space and move the bytes of every existing caller. */
interface Unit { start: number; end: number; spaceBefore: boolean }

interface WrappedLine {
  units: Unit[];
  /** Separator to restore AFTER this line when reflowing the remainder:
   *  `' '` a soft space wrap, `'\n'` a paragraph boundary, `''` a zero-width
   *  (UAX #14 / CJK) break inside an over-wide token. */
  sepAfter: ' ' | '' | '\n';
}

/** Split `word` (already known to exceed `boxWidth`) into pieces at UAX #14 break
 *  opportunities, each as wide as fits. Pieces join with `''` (no space). A piece
 *  with no interior opportunity that still overflows is emitted whole.
 *
 *  `measure` takes CHARACTER indices into `word` rather than a substring: an
 *  over-wide token may span several runs, and only its position says which font
 *  measures which part of it. */
function breakOverwideWord(
  word: string, measure: (fromChar: number, toChar: number) => number, boxWidth: number,
): string[] {
  const chars = [...word];
  const codes = chars.map((c) => c.codePointAt(0)!);
  const brk = lineBreakOpportunities(codes); // brk[i] = boundary before chars[i]
  const pieces: string[] = [];
  let start = 0;      // index into chars
  let lastOpp = -1;   // last break-opportunity index seen since `start`
  for (let i = start + 1; i <= chars.length; i++) {
    const overflow = measure(start, i) > boxWidth;
    if (overflow && lastOpp > start) {
      pieces.push(chars.slice(start, lastOpp).join(''));
      start = lastOpp; lastOpp = -1; i = start; // restart the scan from the break
      continue;
    }
    if (i < chars.length && brk[i] !== LBRK.PROHIBITED) lastOpp = i;
  }
  pieces.push(chars.slice(start).join(''));
  return pieces;
}

/** Greedy word-wrap of `text` into lines no wider than `boxWidth`, honoring
 *  explicit `\n`. A single word wider than the box is emitted alone (it
 *  overflows horizontally — no hyphenation). Then keep only the lines whose
 *  baselines fit within `boxHeight` (each line consumes `leading`), returning
 *  the rest as a re-flowable `remainder`.
 *  @internal */
export function layoutRuns(
  runs: LayoutRun[], boxWidth: number, boxHeight: number,
  leading: number, blockFontSize: number,
): RunLayoutResult {
  // The concatenated run text, plus the run each character came from.
  let text = '';
  for (const r of runs) text += r.text;
  if (text === '') return { lines: [], remainder: [] };
  const owner = new Uint32Array(text.length);
  {
    let at = 0;
    for (let i = 0; i < runs.length; i++) {
      owner.fill(i, at, at + runs[i].text.length);
      at += runs[i].text.length;
    }
  }

  /** Width of the joined text's [from, to) span, each part in its own run's size. */
  const spanWidth = (from: number, to: number): number => {
    let w = 0;
    let i = from;
    while (i < to) {
      const r = owner[i];
      let j = i;
      while (j < to && owner[j] === r) j++;
      w += runs[r].driver.measure(text.slice(i, j), runs[r].fontSize);
      i = j;
    }
    return w;
  };

  /** Width of a separator space, measured in the run that precedes it — the run
   *  whose `Tf` is in force when that space is emitted. */
  const spaceWidth = (at: number): number => {
    const r = runs[owner[at]];
    return r.driver.measure(' ', r.fontSize);
  };

  /** Largest run size with text in `units`; the block's size when there is
   *  none, so a blank line keeps ordinary leading. The separator space belongs
   *  to the run that ends the preceding unit, which is already covered. */
  const maxSizeOf = (units: Unit[]): number => {
    let m = 0;
    for (const u of units) {
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        m = Math.max(m, runs[r].fontSize);
        while (i < u.end && owner[i] === r) i++;
      }
    }
    return m > 0 ? m : blockFontSize;
  };

  /** A line's band height. `blockFontSize` is validated positive by every entry
   *  point, so the ratio is finite; a caller who asked for `leading: 0` still
   *  gets 0. */
  const heightOf = (maxSize: number): number =>
    Math.max(leading, (maxSize * leading) / blockFontSize);

  // --- Phase A: wrap every paragraph into lines (ignoring height). ---
  const wrapped: WrappedLine[] = [];
  let paraStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', paraStart);
    const paraEnd = nl < 0 ? text.length : nl;

    // Words are maximal non-space spans of the joined text, so a word may cross
    // any number of run boundaries. Runs of spaces collapse to one separator,
    // exactly as the string engine did. An over-wide token (a space-less CJK run
    // is one token) expands into UAX #14 sub-pieces joined with ''.
    const units: Unit[] = [];
    let i = paraStart;
    let first = true;
    while (i < paraEnd) {
      while (i < paraEnd && text[i] === ' ') i++;
      if (i >= paraEnd) break;
      let j = i;
      while (j < paraEnd && text[j] !== ' ') j++;
      const spaceBefore = !first;
      first = false;
      if (spanWidth(i, j) > boxWidth) {
        // The measure is index-based so each piece is measured at its real
        // position, in whatever runs it actually spans.
        const word = text.slice(i, j);
        const off: number[] = [0];
        for (const c of [...word]) off.push(off[off.length - 1] + c.length);
        const pieces = breakOverwideWord(word,
          (a, b) => spanWidth(i + off[a], i + off[b]), boxWidth);
        let at = i;
        pieces.forEach((pc, pi) => {
          units.push({ start: at, end: at + pc.length, spaceBefore: pi === 0 ? spaceBefore : false });
          at += pc.length;
        });
      } else {
        units.push({ start: i, end: j, spaceBefore });
      }
      i = j;
    }

    // Greedy pack. Widths accumulate per unit rather than by re-measuring the
    // whole line: for the WinAnsi and Identity-H drivers a string's width is the
    // sum of its glyph advances, so the two agree exactly.
    const paraLines: { units: Unit[]; sepAfter: ' ' | '' }[] = [];
    let cur: Unit[] = [];
    let curWidth = 0;
    for (const u of units) {
      if (cur.length === 0) { cur = [u]; curWidth = spanWidth(u.start, u.end); continue; }
      const sep = u.spaceBefore ? spaceWidth(cur[cur.length - 1].end - 1) : 0;
      const next = curWidth + sep + spanWidth(u.start, u.end);
      if (next <= boxWidth) { cur.push(u); curWidth = next; continue; }
      paraLines.push({ units: cur, sepAfter: u.spaceBefore ? ' ' : '' });
      cur = [u];
      curWidth = spanWidth(u.start, u.end);
    }
    paraLines.push({ units: cur, sepAfter: '' }); // final line, or an empty paragraph

    for (let k = 0; k < paraLines.length; k++) {
      wrapped.push({
        units: paraLines[k].units,
        sepAfter: k === paraLines.length - 1 ? '\n' : paraLines[k].sepAfter,
      });
    }

    if (nl < 0) break;
    paraStart = nl + 1;
  }

  // --- Phase B: keep the lines whose bands fit the box height. ---
  // Cumulative rather than `kept * leading`: a line containing an oversized run
  // claims more of the budget than its neighbours.
  let used = 0;
  let kept = 0;
  const heights: number[] = [];
  while (kept < wrapped.length) {
    const h = heightOf(maxSizeOf(wrapped[kept].units));
    if (used + h > boxHeight + EPS) break;
    used += h;
    heights.push(h);
    kept++;
  }

  /** Walk a line's units into run-tagged pieces, inserting one separator space
   *  before each unit that had one. Adjacent pieces from the same run merge, so a
   *  single-run line yields exactly ONE piece holding the whole line — which is
   *  what makes its measurement and its emitted bytes identical to the string
   *  engine's. */
  const piecesOf = (units: Unit[]): RunSlice[] => {
    const out: RunSlice[] = [];
    const push = (run: number, t: string): void => {
      const last = out[out.length - 1];
      if (last !== undefined && last.run === run) { last.text += t; return; }
      out.push({ run, text: t });
    };
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui];
      // The space is emitted under the preceding run's Tf, so it belongs to it.
      if (u.spaceBefore && ui > 0) push(owner[units[ui - 1].end - 1], ' ');
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        let j = i;
        while (j < u.end && owner[j] === r) j++;
        push(r, text.slice(i, j));
        i = j;
      }
    }
    return out;
  };

  const lines: LaidLine[] = [];
  for (let k = 0; k < kept; k++) {
    const segments: LaidSegment[] = piecesOf(wrapped[k].units).map((p) => ({
      run: p.run,
      text: p.text,
      width: runs[p.run].driver.measure(p.text, runs[p.run].fontSize),
      bytes: runs[p.run].driver.encode(p.text),
    }));
    lines.push({
      text: segments.map((s) => s.text).join(''),
      width: segments.reduce((n, s) => n + s.width, 0),
      bytes: segments.length === 1 ? segments[0].bytes : concatBytes(segments),
      hardBreak: wrapped[k].sepAfter === '\n' || k === kept - 1,
      segments,
      maxFontSize: maxSizeOf(wrapped[k].units),
      height: heights[k],
    });
  }

  // Reconstruct the remainder from the leftover lines, restoring each line's
  // separator (paragraph end -> '\n', soft wrap -> ' ', zero-width break -> '').
  const remainder: RunSlice[] = [];
  const pushSlice = (run: number, t: string): void => {
    const last = remainder[remainder.length - 1];
    if (last !== undefined && last.run === run) { last.text += t; return; }
    remainder.push({ run, text: t });
  };
  for (let k = kept; k < wrapped.length; k++) {
    for (const p of piecesOf(wrapped[k].units)) pushSlice(p.run, p.text);
    const units = wrapped[k].units;
    if (k < wrapped.length - 1 && wrapped[k].sepAfter !== '' && units.length > 0) {
      // The separator belongs to the run that ended the line.
      pushSlice(owner[units[units.length - 1].end - 1], wrapped[k].sepAfter);
    }
  }

  return { lines, remainder };
}

function concatBytes(segments: LaidSegment[]): Uint8Array {
  let n = 0;
  for (const s of segments) n += s.bytes.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const s of segments) { out.set(s.bytes, at); at += s.bytes.length; }
  return out;
}

/** One run through {@link layoutRuns}, which is the only wrapping code in this
 *  module. Four callers measure and paint through it and must not disagree.
 *  @internal */
export function layoutText(
  text: string, driver: FontDriver, fontSize: number,
  boxWidth: number, boxHeight: number, leading: number,
): LayoutResult {
  const { lines, remainder } = layoutRuns(
    [{ text, driver, fontSize }], boxWidth, boxHeight, leading, fontSize);
  return { lines, remainder: remainder.map((s) => s.text).join('') };
}
