// src/tabstops.ts
/** Tab stops (v9j3.1): the vocabulary `layout.ts` lays tabs out by, `stamp.ts`
 *  paints leaders by and `toc.ts` counts its dot leader by. A pure LEAF
 *  importing nothing, so every rule is testable from numbers.
 *
 *  **Invariant:** a stop is chosen STRICTLY past the pen. Past the last
 *  explicit stop, it is the next multiple of the interval. A custom stop
 *  clears every default stop to its left, which is Word's rule.
 *
 *  **Invariant:** `leaderFill` is the ONE owner of how many leader glyphs fit
 *  and where they start. TOC rows and tab leaders both call it, so a dot run
 *  cannot be counted two ways. */
export type TabAlign = 'left' | 'right' | 'center' | 'decimal';
export type TabLeader = 'none' | 'dot' | 'middleDot' | 'hyphen' | 'underscore' | 'line';

/** One tab stop. */
export interface TabStop {
  /** Points from the block's left text edge, before any indent. >= 0. */
  position: number;
  /** Default 'left'. */
  align?: TabAlign;
  /** What fills the gap the tab opens. Default 'none'. */
  leader?: TabLeader;
  /** 'decimal' stops: the character aligned on the stop. Default '.'. */
  decimalChar?: string;
}

/** @internal */
export interface ResolvedTabStop { position: number; align: TabAlign; leader: TabLeader; decimalChar: string }

/** What `layoutRuns` needs. `origin` is how far the box's left edge sits
 *  RIGHT of the tab origin (a paragraph's left indent). @internal */
export interface TabLayout { stops: readonly ResolvedTabStop[]; interval: number; origin: number }

const ALIGNS: readonly TabAlign[] = ['left', 'right', 'center', 'decimal'];
const LEADERS: readonly TabLeader[] = ['none', 'dot', 'middleDot', 'hyphen', 'underscore', 'line'];

/** Validate and normalize, before anything is drawn. @internal */
export function resolveTabStops(stops: unknown, interval: unknown): { stops: ResolvedTabStop[]; interval: number } {
  if (!Array.isArray(stops)) throw new TypeError('tabStops must be an array');
  const iv = interval ?? 36;
  if (typeof iv !== 'number' || !Number.isFinite(iv)) throw new TypeError('defaultTabInterval must be a finite number');
  if (iv <= 0) throw new RangeError('defaultTabInterval must be greater than 0');
  const out: ResolvedTabStop[] = stops.map((s: unknown, i) => {
    if (typeof s !== 'object' || s === null) throw new TypeError(`tab stop ${i} must be an object`);
    const t = s as TabStop;
    if (typeof t.position !== 'number' || !Number.isFinite(t.position)) throw new TypeError(`tab stop ${i}: position must be a finite number`);
    if (t.position < 0) throw new RangeError(`tab stop ${i}: position must be >= 0`);
    const align = t.align ?? 'left';
    if (!ALIGNS.includes(align)) throw new TypeError(`tab stop ${i}: align must be one of ${ALIGNS.join(', ')}`);
    const leader = t.leader ?? 'none';
    if (!LEADERS.includes(leader)) throw new TypeError(`tab stop ${i}: leader must be one of ${LEADERS.join(', ')}`);
    const decimalChar = t.decimalChar ?? '.';
    if (typeof decimalChar !== 'string' || [...decimalChar].length !== 1)
      throw new TypeError(`tab stop ${i}: decimalChar must be one character`);
    return { position: t.position, align, leader, decimalChar };
  });
  out.sort((a, b) => a.position - b.position);
  for (let i = 1; i < out.length; i++) {
    if (out[i].position === out[i - 1].position) throw new RangeError(`two tab stops at ${out[i].position}`);
  }
  return { stops: out, interval: iv };
}

/** The stop a tab at `pen` (from the tab origin) goes to, or undefined when
 *  it lies past `right`, the line's right edge in the same frame. @internal */
export function nextStop(t: TabLayout, pen: number, right: number): ResolvedTabStop | undefined {
  let s: ResolvedTabStop | undefined = t.stops.find((x) => x.position > pen + 1e-9);
  if (s === undefined) {
    const last = t.stops.length ? t.stops[t.stops.length - 1].position : 0;
    const from = Math.max(pen, last);
    const n = Math.floor(from / t.interval + 1e-9) + 1;
    s = { position: n * t.interval, align: 'left', leader: 'none', decimalChar: '.' };
  }
  return s.position <= right + 1e-9 ? s : undefined;
}

/** The glyph a leader repeats; undefined for 'line' (a rule) and 'none'. @internal */
export function leaderGlyph(l: TabLeader): string | undefined {
  switch (l) {
    case 'dot': return '.';
    case 'middleDot': return '\u00B7';
    case 'hyphen': return '-';
    case 'underscore': return '_';
    default: return undefined;
  }
}

/** How many `glyphWidth` glyphs fit in [gapStart + clear, gapEnd - clear],
 *  RIGHT-aligned so runs line up down a column, and where the first starts.
 *  @internal */
export function leaderFill(gapStart: number, gapEnd: number, glyphWidth: number, clear: number): { count: number; x: number } {
  const end = gapEnd - clear;
  const room = end - (gapStart + clear);
  const count = glyphWidth > 0 && room > 0 ? Math.floor(room / glyphWidth) : 0;
  return { count, x: end - count * glyphWidth };
}
