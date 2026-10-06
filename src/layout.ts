import { encodeWinAnsi } from './encoding.js';
import { measure, StdFont } from './metrics.js';
import { lineBreakPrefix, LBRK } from './linebreak.js';
import type { Hyphenator } from './hyphenate.js';
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
  /** Points this line starts right of the box's left edge — set on line 0
   *  alone, by a first-line or (negative) hanging indent (`m2fp.5`), and ABSENT
   *  otherwise, so every existing caller's lines are unchanged. */
  indent?: number;
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
interface Unit {
  start: number; end: number; spaceBefore: boolean;
  /** Ends at a hyphenation point: a '-' is drawn after it (v9j3.2). */
  hyphen?: boolean;
  /** The WHOLE word's hyphenation points, as positions in `text`, shared by
   *  the word's tails so a tail is never re-analysed as a word of its own. */
  word?: readonly number[];
}

interface WrappedLine {
  units: Unit[];
  /** Does an explicit `\n` end this line, as against a soft wrap? It decides
   *  `hardBreak`, which suppresses justification on a paragraph's last line.
   *
   *  It was the separator to RESTORE after the line — `' '`, `'\n'` or `''`
   *  for a zero-width break inside an over-wide token — back when `pl2h`
   *  rebuilt the remainder line by line. The remainder is cut from the input
   *  now, so those three collapsed to one question and the field says which
   *  one it answers rather than leaving a distinction nothing reads. */
  endsParagraph: boolean;
}

/** Split `word` (already known to exceed `boxWidth`) into pieces at UAX #14 break
 *  opportunities, each as wide as fits. Pieces join with `''` (no space). A piece
 *  with no interior opportunity that still overflows is emitted whole.
 *
 *  `measure` takes CODE UNIT offsets into `word` rather than a substring: an
 *  over-wide token may span several runs, and only its position says which font
 *  measures which part of it. Offsets rather than character indices since
 *  `lt63`, which is what let the caller's own index table go — it built one over
 *  the whole word on every page.
 *
 *  A GENERATOR, so the caller stops pulling the moment the box is full — the
 *  `pl2h` rule ("wrap and keep in one pass, never wrap it all then keep a
 *  prefix"), which that issue fixed for the word loop and did not reach here
 *  (`lqs1`). A word longer than a page is re-broken on every page as the
 *  remainder is re-flowed, so breaking it IN FULL each time is quadratic in the
 *  word: measured on `'[a]('.repeat(n)` at 5 lines a page, 4.3 M characters
 *  through the driver for 8 KB of word, growing 4x per doubling.
 *
 *  `lqs1` stopped the SPLIT and the over-wide TEST at the page; what it left was
 *  everything BEFORE them, which still ran over the whole remaining word each
 *  time — the code point array, the offset table and the UAX #14 analysis, 64%
 *  of the profile between them. All three are now grown ON DEMAND (`lt63`), so a
 *  page costs what it keeps and the word costs a small multiple of its own
 *  length across every page it spans. */
function* breakOverwideWord(
  word: string, measure: (fromUnit: number, toUnit: number) => number, boxWidth: number,
): Generator<string> {
  // `codes[k]` is the k-th code point and `off[k]` is where it begins in `word`,
  // so `off` is one longer and `off[codes.length]` is how far the pair reaches.
  // One `codePointAt` walk rather than `[...word]` plus `.map()`, both of which
  // materialized the whole word before a single piece was yielded.
  const codes: number[] = [];
  const off: number[] = [0];
  let unit = 0;     // how far into `word` the two arrays reach
  let total = -1;   // code point count, known once `unit` reaches the end

  /** Materialize code points until there are `want`, or the word runs out. */
  const supply = (want: number): void => {
    while (codes.length < want && unit < word.length) {
      const cp = word.codePointAt(unit)!;
      codes.push(cp);
      unit += cp > 0xffff ? 2 : 1;
      off.push(unit);
    }
    if (unit >= word.length) total = codes.length;
  };
  /** Whether the word has at least `k` code points, materializing that far to
   *  find out. It stands in for the `i <= chars.length` and `i < chars.length`
   *  tests the eager build could make against a length it already knew. */
  const atLeast = (k: number): boolean => { supply(k); return codes.length >= k; };

  let brk: Uint8Array = new Uint8Array(0);
  let final = 0;    // brk[0, final) is what the WHOLE word would answer

  /** The boundary before code point `i`. The analysed prefix DOUBLES until its
   *  answer at `i` is final, so re-analysis costs at most twice the prefix the
   *  page actually consumed — geometric, hence linear in the word overall. A
   *  prefix is only ever believed below `lineBreakPrefix`'s own horizon; past
   *  it the answer can still move, and believing it moves a line break. */
  const brkAt = (i: number): number => {
    while (i >= final) {
      supply(Math.max(64, codes.length * 2));
      const r = lineBreakPrefix(codes, codes.length === total);
      brk = r.brk;
      final = r.final;
    }
    return brk[i];
  };

  let start = 0;      // index into codes
  let lastOpp = -1;   // last break-opportunity index seen since `start`
  for (let i = start + 1; atLeast(i); i++) {
    // The measure is asked ONLY where there is somewhere to break (`lqs1`).
    // It used to run for every character and the answer was then used only as
    // `overflow && lastOpp > start` — so a word with NO break opportunity
    // ('*'*n, '['*n: AL x AL and OP x anything are both PROHIBITED) computed
    // and discarded every one of them, each O(i - start) because `spanWidth`
    // re-walks the prefix. Measured at n = 2,000: 2,001,000 characters through
    // the driver, exactly n(n+1)/2, and 3.7 s to render '*'.repeat(20000).
    // Identical by short-circuit — `measure` is `spanWidth`, which is pure.
    if (lastOpp > start && measure(off[start], off[i]) > boxWidth) {
      yield word.slice(off[start], off[lastOpp]);
      start = lastOpp; lastOpp = -1; i = start; // restart the scan from the break
      continue;
    }
    if (atLeast(i + 1) && brkAt(i) !== LBRK.PROHIBITED) lastOpp = i;
  }
  yield word.slice(off[start]);
}

/** Greedy word-wrap of `text` into lines no wider than `boxWidth`, honoring
 *  explicit `\n`. A single word wider than the box is emitted alone (it
 *  overflows horizontally — no hyphenation). Then keep only the lines whose
 *  baselines fit within `boxHeight` (each line consumes `leading`), returning
 *  the rest as a re-flowable `remainder`.
 *  @internal */
export function layoutRuns(
  runs: readonly LayoutRun[], boxWidth: number, boxHeight: number,
  leading: number, blockFontSize: number, firstLineIndent = 0,
  hyphenation?: Hyphenator,
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

  // A BOUNDARY table plus a search, rather than a character-indexed array of
  // owners (`pl2h`): that array was allocated and filled at the full text
  // length on every call, and a long paragraph calls this once per page over
  // a remainder that starts out as the whole text — 1 GB of `Uint32Array` for
  // a 200,000-word document. `runAt[r]` is where run `r` begins and the last
  // entry is the text length, so run `r` spans `[runAt[r], runAt[r + 1])` and
  // the end of a character's own run is a lookup rather than a scan.
  const runAt = new Uint32Array(scaled.length + 1);
  {
    let at = 0;
    for (let i = 0; i < scaled.length; i++) {
      at += isAtomicRun(scaled[i]) ? 1 : (scaled[i] as TextLayoutRun).text.length;
      runAt[i + 1] = at;
    }
  }
  /** The run owning character `i`. Nearly every block is ONE run, where this
   *  settles in a single comparison. */
  const owner = (i: number): number => {
    let lo = 0;
    let hi = scaled.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runAt[mid] <= i) lo = mid; else hi = mid - 1;
    }
    return lo;
  };

  // **Invariant (v9j3.2):** with hyphenation ON a soft hyphen has no width and
  // draws nothing; it stays in `text`, so the remainder carries it on. OFF,
  // `visible` is the identity and none of the hyphenation code below runs.
  const SHY = '­';
  const visible = (s: string): string =>
    hyphenation !== undefined && s.includes(SHY) ? s.split(SHY).join('') : s;

  /** Width of the joined text's [from, to) span, each part in its own run's size. */
  const spanWidth = (from: number, to: number): number => {
    let w = 0;
    let i = from;
    while (i < to) {
      const r = owner(i);
      // `Math.max` so the walk ALWAYS advances, whatever `owner` answers. The
      // character-by-character scan this replaced could not fail to move; a
      // boundary lookup can, and a wrong run index then HANGS rather than
      // drawing wrongly — measured, both mutations aimed at `owner` spin
      // instead of failing. It is the rule `lexer.ts` states for its own loop.
      const j = Math.max(i + 1, Math.min(to, runAt[r + 1]));
      const run = scaled[r];
      w += isAtomicRun(run)
        ? run.atomic.width
        : run.driver.measure(visible(text.slice(i, j)), run.fontSize);
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
    const k = spaceRun(owner(at));
    if (k < 0) return 0;
    const r = scaled[k] as TextLayoutRun;
    return r.driver.measure(' ', r.fontSize);
  };

  /** The run a hyphen after character `at - 1` is drawn in — that character's
   *  — or -1 when it is an atomic or its font cannot draw '-'. */
  const hyphenRun = (at: number): number => {
    const r = owner(at - 1);
    const run = scaled[r];
    return isAtomicRun(run) || run.driver.probe('-') === 0 ? -1 : r;
  };
  const hyphenWidth = (r: number): number => {
    const run = scaled[r] as TextLayoutRun;
    return run.driver.measure('-', run.fontSize);
  };
  /** A unit's width, its drawn hyphen included. */
  const unitWidth = (u: Unit): number =>
    spanWidth(u.start, u.end) + (u.hyphen ? hyphenWidth(hyphenRun(u.end)) : 0);
  /** The whole word's points, as positions in `text`, computed once per word. */
  const wordPoints = (u: Unit): readonly number[] =>
    u.word ?? hyphenation!.points(text.slice(u.start, u.end)).map((p) => u.start + p);
  /** The end of the longest head of `u` ending at a hyphenation point that
   *  fits `room` with its hyphen — the RIGHTMOST such point — or undefined.
   *
   *  **Invariant (v9j3.2 review):** the points are the WHOLE word's, carried
   *  on the unit, never the tail's own — a tail analysed as a word fires
   *  word-start patterns at a false boundary and draws breaks the word does
   *  not allow. And the scan is ASCENDING with the width accumulated piece by
   *  piece, stopping once past the room: width is monotonic in the prefix, so
   *  the cost is the head, not points x word — measured x7.9 per doubling and
   *  9 s at 8,000 characters before (the `lqs1` class). */
  const hyphenHead = (u: Unit, room: number, pts: readonly number[]): number | undefined => {
    let lo = 0, hi = pts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid] <= u.start) lo = mid + 1; else hi = mid; }
    let best: number | undefined;
    let w = 0;
    let from = u.start;
    for (let k = lo; k < pts.length && pts[k] < u.end; k++) {
      const at = pts[k];
      w += spanWidth(from, at);
      from = at;
      if (w > room) break;
      const r = hyphenRun(at);
      if (r >= 0 && w + hyphenWidth(r) <= room) best = at;
    }
    return best;
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
        const r = owner(i);
        const j = Math.max(i + 1, Math.min(u.end, runAt[r + 1]));
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

  // --- Wrap and keep in ONE pass, stopping at the height budget. ---
  //
  // Fused rather than "wrap the whole text, then keep a prefix" (`pl2h`). A
  // page of a long paragraph keeps a few dozen of the lines it wraps, and the
  // rest is handed on as a remainder and wrapped AGAIN on the next page — so
  // wrapping eagerly measured every word of the tail once per page, twice
  // over (the over-wide test and the greedy pack). Measured on 100,000 words:
  // 11.1 M characters through this function for 437 K of input, 139,135 lines
  // wrapped to keep 5,470. The work is now proportional to what the page
  // actually holds.
  const wrapped: WrappedLine[] = [];
  const heights: number[] = [];
  const ascents: number[] = [];
  // Cumulative rather than `kept * leading`: a line containing an oversized run
  // claims more of the budget than its neighbours.
  let used = 0;
  /** Where the first line that did NOT fit begins, or -1 when everything fit.
   *  A character index into `text`, which is what makes the remainder a slice
   *  rather than a rebuild. */
  let restAt = -1;

  // The FIRST line packs against its own width (m2fp.5): narrower for a
  // first-line indent, wider for a (negative) hanging one, whose extra room the
  // caller reserved to the left of the box. A positive indent never narrows
  // line 0 below 12pt — flowelement.ts's MIN_CONTENT_WIDTH, inlined because
  // importing it would reach back through stamp.ts to here. Every later line
  // packs against the box. Note an OVER-WIDE word on line 0 still splits
  // against `boxWidth`, so its first piece may pass the indented edge:
  // recorded, not fixed.
  const fi = firstLineIndent > 0
    ? Math.min(firstLineIndent, Math.max(0, boxWidth - Math.min(boxWidth, 12)))
    : firstLineIndent;
  const limit = (): number => (wrapped.length === 0 ? boxWidth - fi : boxWidth);

  /** Take one packed line, or report that the budget is spent — in which case
   *  `restAt` names where that line, and so the remainder, begins. */
  const keep = (units: Unit[], endsParagraph: boolean, startChar: number): boolean => {
    const b = lineBox(itemsOf(units), leading, blockFontSize);
    if (used + b.height > boxHeight + EPS) { restAt = startChar; return false; }
    used += b.height;
    wrapped.push({ units, endsParagraph });
    heights.push(b.height);
    ascents.push(b.ascent);
    return true;
  };

  /** Whether `[from, to)` is wider than `w`, answered from a growing PREFIX:
   *  a span's width is monotonic in its prefix, so a prefix already over `w`
   *  settles it. The over-wide test runs once per word per page and a word may
   *  be longer than the page, so measuring it in full was the other half of the
   *  quadratic `lqs1` fixed here — 880 K characters through the driver for an
   *  8 KB word at 5 lines a page, against 22 K with the probe.
   *
   *  It measures whole sub-spans through `spanWidth`, exactly as the pack loop
   *  already does, so it takes on no additivity assumption that function does
   *  not already make. A word shorter than the first probe pays nothing: the
   *  loop does not run and the single full measure is what it always was. */
  const spanWiderThan = (from: number, to: number, w: number): boolean => {
    for (let m = 64; from + m < to; m *= 2) {
      if (spanWidth(from, from + m) > w) return true;
    }
    return spanWidth(from, to) > w;
  };

  /** The over-wide word at `[i, j)` as a lazy sequence of one-line units. The
   *  measure is offset-based so each piece is measured at its real position, in
   *  whatever runs it actually spans.
   *
   *  The character-index table this used to build has gone (`lt63`): it walked
   *  `[...word]` in full before the first piece was yielded, on every page the
   *  word spanned, which is the cost the split was already lazy to avoid.
   *  `breakOverwideWord` grows the same table on demand and hands out offsets,
   *  so `text.slice` — O(1) in V8, a sliced string — is all that is left here. */
  function* overwideUnits(i: number, j: number, spaceBefore: boolean): Generator<Unit> {
    const word = text.slice(i, j);
    let at = i;
    let firstPiece = true;
    for (const pc of breakOverwideWord(word,
      (a, b) => spanWidth(i + a, i + b), boxWidth)) {
      yield { start: at, end: at + pc.length, spaceBefore: firstPiece ? spaceBefore : false };
      at += pc.length;
      firstPiece = false;
    }
  }

  let paraStart = 0;
  para: for (;;) {
    const nl = text.indexOf('\n', paraStart);
    const paraEnd = nl < 0 ? text.length : nl;

    // Words are maximal non-space spans of the joined text, so a word may cross
    // any number of run boundaries. Runs of spaces collapse to one separator,
    // exactly as the string engine did. An over-wide token (a space-less CJK run
    // is one token) expands into UAX #14 sub-pieces joined with ''.
    //
    // Greedy pack, interleaved with that scan so neither runs past the budget.
    // Widths accumulate per unit rather than by re-measuring the whole line:
    // for the WinAnsi and Identity-H drivers a string's width is the sum of its
    // glyph advances, so the two agree exactly.
    let cur: Unit[] = [];
    let curWidth = 0;
    let i = paraStart;
    let first = true;
    while (i < paraEnd) {
      while (i < paraEnd && text[i] === ' ') i++;
      if (i >= paraEnd) break;
      let j = i;
      while (j < paraEnd && text[j] !== ' ') j++;
      const spaceBefore = !first;
      first = false;
      // LAZY, so that `break para` below stops the split where it stands
      // (`lqs1`): an over-wide word may be longer than the page, and the
      // remainder is re-flowed, so materializing every piece re-splits the
      // whole word once per page.
      // With hyphenation the word stays ONE unit: the loop below splits it at
      // hyphenation points against the room actually left, and only what no
      // point can split goes through the plain split (v9j3.2). Pre-cutting it
      // here, against the whole box, strands the line before it and can put
      // two cut pieces on one line with a hyphen between them.
      const units: Iterable<Unit> = hyphenation === undefined && spanWiderThan(i, j, boxWidth)
        ? overwideUnits(i, j, spaceBefore)
        : [{ start: i, end: j, spaceBefore }];
      for (const u0 of units) {
        // A head that ends at a hyphenation point leaves a TAIL, which goes
        // through the same test on the next line (v9j3.2). Off, no unit
        // carries `hyphen`, `unitWidth` is `spanWidth` and `at` stays
        // undefined, so this is the loop it always was.
        let pending: Unit | undefined = u0;
        // The plain UAX #14 pieces of a word no hyphenation point could split,
        // pulled lazily so `break para` stops the split where it stands (`lqs1`).
        let plain: Iterator<Unit> | undefined;
        for (;;) {
          let u: Unit;
          let fromPlain = false;
          if (pending !== undefined) { u = pending; pending = undefined; }
          else if (plain !== undefined) {
            const n = plain.next();
            if (n.done) break;
            u = n.value;
            fromPlain = true;
          } else break;
          const hy = hyphenation !== undefined && !fromPlain;
          if (cur.length === 0) {
            if (hy && spanWiderThan(u.start, u.end, limit())) {
              const pts = wordPoints(u);
              const at = hyphenHead(u, limit(), pts);
              if (at !== undefined) {
                if (!keep([{ start: u.start, end: at, spaceBefore: u.spaceBefore, hyphen: true }], false, u.start)) break para;
                pending = { start: at, end: u.end, spaceBefore: false, word: pts };
                continue;
              }
              plain = overwideUnits(u.start, u.end, u.spaceBefore);
              continue;
            }
            cur = [u];
            curWidth = unitWidth(u);
            continue;
          }
          const sep = u.spaceBefore ? spaceWidth(cur[cur.length - 1].end - 1) : 0;
          const next = curWidth + sep + unitWidth(u);
          if (next <= limit()) { cur.push(u); curWidth = next; continue; }
          const pts = hy ? wordPoints(u) : undefined;
          const at = pts ? hyphenHead(u, limit() - curWidth - sep, pts) : undefined;
          if (at !== undefined) {
            cur.push({ start: u.start, end: at, spaceBefore: u.spaceBefore, hyphen: true });
            if (!keep(cur, false, cur[0].start)) break para;
            cur = [];
            curWidth = 0;
            pending = { start: at, end: u.end, spaceBefore: false, word: pts };
            continue;
          }
          if (!keep(cur, false, cur[0].start)) break para;
          // Off — and for a plain piece — the unit opens the next line, as it
          // always did. On, it is offered to the empty line, which may split it.
          if (!hy) { cur = [u]; curWidth = unitWidth(u); continue; }
          cur = [];
          curWidth = 0;
          pending = pts ? { ...u, word: pts } : u;
        }
      }
      i = j;
    }
    // The paragraph's final line, or the empty paragraph itself — which has no
    // unit to take a start from, so the remainder would begin at the paragraph.
    if (!keep(cur, true, cur.length > 0 ? cur[0].start : paraStart)) break para;

    if (nl < 0) break;
    paraStart = nl + 1;
  }
  const kept = wrapped.length;

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
        const k = spaceRun(owner(units[ui - 1].end - 1));
        if (k >= 0) push(k, ' ');
      }
      let i = u.start;
      while (i < u.end) {
        const r = owner(i);
        const j = Math.max(i + 1, Math.min(u.end, runAt[r + 1]));
        const t = visible(text.slice(i, j));
        if (t !== '') push(r, t);
        i = j;
      }
      if (u.hyphen) {
        const r = hyphenRun(u.end);
        if (r >= 0) push(r, '-');
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
      hardBreak: wrapped[k].endsParagraph || k === kept - 1,
      segments,
      maxFontSize: ascents[k],
      height: heights[k],
      // Line 0 alone, and only when non-zero, so every line of every existing
      // caller is unchanged object for object.
      ...(k === 0 && fi !== 0 ? { indent: fi } : {}),
    });
  }

  // The remainder is the RAW TAIL from where the first unkept line begins,
  // cut at run boundaries — one slice per run it spans, rather than rebuilt
  // line by line (`pl2h`). A cut is `String.prototype.slice`, so a
  // single-run block's remainder costs nothing whatever its length, where the
  // rebuild copied the whole tail on every page.
  //
  // It is also what this function's own contract says it returns —
  // "preserving spacing/newlines" — which the rebuild did NOT: it collapsed
  // runs of spaces and, since an empty paragraph has no unit to hang a
  // separator on, DROPPED blank lines between leftover paragraphs. Neither
  // moved a rendered page, because the next call collapses spaces again, but
  // a caller reading `AddTextBlock`'s remainder saw the damage.
  const remainder: RunSlice[] = [];
  if (restAt >= 0) {
    let at = 0;
    for (let r = 0; r < scaled.length; r++) {
      const run = scaled[r];
      const len = isAtomicRun(run) ? 1 : run.text.length;
      const from = Math.max(at, restAt);
      // An atomic's slice is its U+FFFC placeholder, which is what carries it
      // into the next flow — `sliceContent` reads the run index, not the text.
      if (from < at + len) remainder.push({ run: r, text: text.slice(from, at + len) });
      at += len;
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
  hyphenation?: Hyphenator,
): LayoutResult {
  const { lines, remainder } = layoutRuns(
    [{ text, driver, fontSize }], boxWidth, boxHeight, leading, fontSize, 0, hyphenation);
  return { lines, remainder: remainder.map((s) => s.text).join('') };
}
