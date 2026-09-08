import { encodeWinAnsi } from './encoding.js';
import { measure, StdFont } from './metrics.js';
import { lineBreakOpportunities, LBRK } from './linebreak.js';
import { lineBox, type LineItem } from './linebox.js';

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

/** A box occupying width in a line without contributing characters — an image.
 *  @internal */
export interface AtomicBox {
  width: number;
  height: number;
  /** `baseline` puts its bottom on the baseline; `top`/`bottom` align it to
   *  the line band. `middle` is deliberately absent — CSS defines it against
   *  half the x-height, which the AFM tables do not expose. */
  align: 'baseline' | 'top' | 'bottom';
}

/** One TEXT run as the layout engine sees it: already resolved to a driver and
 *  a size. layout.ts never learns what an AuthoringFont is — stamp.ts owns that
 *  resolution, and owning it in one place is what keeps a block from being
 *  measured one way and painted another.
 *  @internal */
export interface TextLayoutRun {
  text: string;
  driver: FontDriver;
  fontSize: number;
}

/** One atomic run — a box among the text. @internal */
export interface AtomicLayoutRun { atomic: AtomicBox }

export type LayoutRun = TextLayoutRun | AtomicLayoutRun;

/**
 * Runs and atomics interleaved into ONE list, in document order: every atomic
 * whose `beforeRun` is `i` comes before run `i`, and `runs.length` places one
 * at the end.
 *
 * **Invariant, and it is the whole reason this is a shared function rather
 * than ten lines written twice:** the ORDER is one rule. `stamp.ts` weaves to
 * paint a block and `tableauthor.ts` weaves to measure a cell, and a second
 * copy is how a cell comes to measure one way and paint another — the failure
 * the one-wrapping-engine rule exists to prevent. It lives here because
 * `layout.ts` is the leaf both reach.
 *
 * Generic over the element, because the two callers weave different things —
 * `stamp.ts` a `ResolvedRun` carrying font and colour, `tableauthor.ts` a bare
 * `LayoutRun`. `make` receives the index the atomic lands at, which is what
 * lets a caller record a woven-index map without a second walk.
 *
 * With no atomics it returns `runs` UNCHANGED — the same array, not a copy —
 * which is what keeps every existing caller's bytes identical.
 */
export function weaveByBeforeRun<R, A extends { beforeRun: number }>(
  runs: R[], atomics: readonly A[] | undefined, make: (a: A, wovenIndex: number) => R,
): R[] {
  if (atomics === undefined || atomics.length === 0) return runs;
  const woven: R[] = [];
  const at = (i: number): void => {
    for (const a of atomics) {
      if (a.beforeRun === i) woven.push(make(a, woven.length));
    }
  };
  for (let i = 0; i < runs.length; i++) { at(i); woven.push(runs[i] as R); }
  at(runs.length);
  return woven;
}

export function isAtomicRun(r: LayoutRun): r is AtomicLayoutRun {
  return (r as AtomicLayoutRun).atomic !== undefined;
}

/** The piece of one laid line contributed by one run.
 *  @internal */
export interface LaidSegment {
  /** Index into the `runs` array passed to {@link layoutRuns}. */
  run: number;
  text: string;
  width: number;
  bytes: Uint8Array;
  /** Present for an atomic segment, whose `text` is '' and `bytes` empty. The
   *  emitter draws the box and advances the pen; every consumer that walks
   *  segments for GEOMETRY already advances by `width` and needs no change. */
  atomic?: AtomicBox;
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
  /** The line's ASCENT: how far below the band top its baseline sits, which is
   *  what keeps an oversized run inside the box. The largest font size among
   *  the runs with text, or a baseline-aligned atomic's height when that is
   *  larger; the block's own size for a line with neither.
   *
   *  Named `maxFontSize` from before zch2.11 gave it the second meaning. The
   *  name is KEPT because four modules read it and a rename is churn with no
   *  test behind it. */
  maxFontSize: number;
  /** This line's band height, from linebox.ts. Collapses to
   *  `max(leading, maxFontSize * leading / fontSize)` for every line with no
   *  atomic, which is what makes every existing caller byte-identical. */
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
  runs: readonly LayoutRun[], boxWidth: number, boxHeight: number,
  leading: number, blockFontSize: number,
): RunLayoutResult {
  // An atomic wider than the box scales BOTH dimensions down — the rule
  // flow.ts's image() already applies to a block image, so it is one rule
  // rather than two. It happens here because this is the only place that
  // knows boxWidth, and the CLAMPED height is what the band must see.
  //
  // A fresh array and fresh objects: stamp.ts reuses the same
  // ResolvedRun.layout objects for segmentBoxes and the painter, so writing
  // through would resize the image on every re-flow.
  const scaled: LayoutRun[] = runs.map((r) => {
    if (!isAtomicRun(r) || r.atomic.width <= boxWidth || r.atomic.width <= 0) return r;
    const k = boxWidth / r.atomic.width;
    return { atomic: { ...r.atomic, width: boxWidth, height: r.atomic.height * k } };
  });

  // U+FFFC OBJECT REPLACEMENT CHARACTER, which is what Unicode defines it for.
  // One character per atomic is what lets the whole index-based walk below —
  // units, the UAX #14 search, piecesOf and the remainder — work unchanged.
  const OBJ = '￼';

  // The concatenated run text, plus the run each character came from.
  let text = '';
  for (const r of scaled) text += isAtomicRun(r) ? OBJ : r.text;
  if (text === '') return { lines: [], remainder: [] };
  const owner = new Uint32Array(text.length);
  {
    let at = 0;
    for (let i = 0; i < scaled.length; i++) {
      const n = isAtomicRun(scaled[i]) ? 1 : (scaled[i] as TextLayoutRun).text.length;
      owner.fill(i, at, at + n);
      at += n;
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
      const run = scaled[r];
      w += isAtomicRun(run)
        ? run.atomic.width
        : run.driver.measure(text.slice(i, j), run.fontSize);
      i = j;
    }
    return w;
  };

  /** The run a separator space is emitted under, given the run that precedes
   *  it: that run when it is text, else the nearest TEXT run before it, else
   *  the nearest after. `-1` when the input is all atomics and no font is in
   *  force at all.
   *
   *  An atomic has no `Tf`, so a space attributed to one would be measured at
   *  no width AND merge into the atomic's own piece, swallowing it. ONE owner
   *  for that rule, because `spaceWidth` measures the space and `piecesOf`
   *  emits it, and the two must not disagree about which font it is in. */
  const spaceRun = (before: number): number => {
    for (let k = before; k >= 0; k--) if (!isAtomicRun(scaled[k])) return k;
    for (let k = before + 1; k < scaled.length; k++) if (!isAtomicRun(scaled[k])) return k;
    return -1;
  };

  /** Width of a separator space, measured in the run whose `Tf` is in force
   *  when that space is emitted. */
  const spaceWidth = (at: number): number => {
    const k = spaceRun(owner[at]);
    if (k < 0) return 0;
    const r = scaled[k] as TextLayoutRun;
    return r.driver.measure(' ', r.fontSize);
  };

  /** The items on a line, for linebox.ts. A text piece contributes its font
   *  size as its ascent — layout.ts's convention since before atomics — and an
   *  atomic contributes its box. The separator space belongs to the run that
   *  ends the preceding unit, which is already covered. */
  const itemsOf = (units: Unit[]): LineItem[] => {
    const items: LineItem[] = [];
    for (const u of units) {
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        let j = i;
        while (j < u.end && owner[j] === r) j++;
        const run = scaled[r];
        if (isAtomicRun(run)) {
          const a = run.atomic;
          items.push({
            ascent: a.align === 'baseline' ? a.height : 0,
            height: a.height,
            align: a.align,
          });
        } else {
          items.push({ ascent: run.fontSize, height: run.fontSize, align: 'baseline' });
        }
        i = j;
      }
    }
    return items;
  };

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
  const ascents: number[] = [];
  while (kept < wrapped.length) {
    const b = lineBox(itemsOf(wrapped[kept].units), leading, blockFontSize);
    if (used + b.height > boxHeight + EPS) break;
    used += b.height;
    heights.push(b.height);
    ascents.push(b.ascent);
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
      // The space is emitted under the preceding run's Tf, so it belongs to it
      // — and to the nearest TEXT run when that one is an atomic, which has no
      // Tf. Attributing it to the atomic would merge it into the atomic's own
      // piece, where the segment mapper discards the text and the space
      // vanishes from both the width and the page.
      if (u.spaceBefore && ui > 0) {
        const k = spaceRun(owner[units[ui - 1].end - 1]);
        if (k >= 0) push(k, ' ');
      }
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
    const segments: LaidSegment[] = piecesOf(wrapped[k].units).map((p) => {
      const run = scaled[p.run];
      // An atomic's piece is the U+FFFC placeholder, REPLACED by '' here —
      // which is what keeps it out of line.text and out of any encode call.
      if (isAtomicRun(run)) {
        return {
          run: p.run, text: '', width: run.atomic.width,
          bytes: new Uint8Array(0), atomic: run.atomic,
        };
      }
      return {
        run: p.run,
        text: p.text,
        width: run.driver.measure(p.text, run.fontSize),
        bytes: run.driver.encode(p.text),
      };
    });
    lines.push({
      text: segments.map((s) => s.text).join(''),
      width: segments.reduce((n, s) => n + s.width, 0),
      bytes: segments.length === 1 ? segments[0].bytes : concatBytes(segments),
      hardBreak: wrapped[k].sepAfter === '\n' || k === kept - 1,
      segments,
      maxFontSize: ascents[k],
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
      // The separator belongs to the run that ended the line — or the nearest
      // TEXT run, when that one is an atomic, exactly as piecesOf attributes
      // an interior space.
      const k2 = spaceRun(owner[units[units.length - 1].end - 1]);
      if (k2 >= 0) pushSlice(k2, wrapped[k].sepAfter);
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
