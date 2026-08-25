// The whitespace ("stream") table detector: reconstruct a table from text
// geometry alone, for a table drawn with no ruling lines.
//
// Pure over TextFragment[] — no Document, no Page, no content walk — which is
// what lets every threshold be tested from hand-built fragments. Distinct from
// tablestruct.ts (tagged-tree extraction) and tableink.ts (border recovery);
// it imports neither.
import { Table } from './tablemodel.js';
import type { TableCell, TableRow } from './tablemodel.js';
import type { TextFragment } from './text.js';
import { buildCells, cellText, centroid, contains, rowBbox } from './tablegrid.js';

/** A candidate is prose unless EVERY column carries text in at least this
 *  fraction of its rows.
 *
 *  **Note, measured:** this is knife-edge. A 4-row table whose second column
 *  holds text in exactly 2 rows passes; one fewer and the whole table is
 *  rejected as prose. It is the precision/recall knob for the whole detector. */
const PROSE_FILL = 0.5;

const COL_GAP = 6;

/** Group fragments into text lines by baseline; returns lines top→bottom. */
export function groupLines(frags: TextFragment[]): TextFragment[][] {
  const sorted = [...frags].sort((a, b) => b.quad[1] - a.quad[1]);
  const lines: TextFragment[][] = [];
  let bucket: TextFragment[] = [];
  let y = sorted[0]?.quad[1] ?? 0;
  for (const f of sorted) {
    if (bucket.length && Math.abs(f.quad[1] - y) > Math.max(2, 0.5 * f.fontSize)) { lines.push(bucket); bucket = []; }
    if (!bucket.length) y = f.quad[1];
    bucket.push(f);
  }
  if (bucket.length) lines.push(bucket);
  return lines;
}

/** Column boundaries from vertical whitespace gaps present across all rows. */
export function columnCuts(lines: TextFragment[][], x0: number, x1: number): number[] {
  const STEP = 1;
  const n = Math.max(1, Math.ceil((x1 - x0) / STEP));
  // For each cell of the histogram, count rows whose text covers it.
  const cover = new Array(n).fill(0);
  for (const ln of lines) {
    const rowCov = new Array(n).fill(false);
    for (const f of ln) {
      const a = Math.max(0, Math.floor((f.quad[0] - x0) / STEP));
      const b = Math.min(n - 1, Math.ceil((f.quad[2] - x0) / STEP));
      for (let i = a; i <= b; i++) rowCov[i] = true;
    }
    for (let i = 0; i < n; i++) if (rowCov[i]) cover[i]++;
  }
  // A gap column = covered by no row. Find gap runs wider than COL_GAP that are interior.
  const cuts: number[] = [x0];
  let i = 0;
  while (i < n) {
    if (cover[i] === 0) {
      let j = i; while (j < n && cover[j] === 0) j++;
      const gapStart = x0 + i * STEP, gapEnd = x0 + j * STEP;
      if (gapStart > x0 + COL_GAP && gapEnd < x1 - COL_GAP && gapEnd - gapStart >= COL_GAP)
        cuts.push((gapStart + gapEnd) / 2);
      i = j;
    } else i++;
  }
  cuts.push(x1);
  return cuts;
}

/** The most common fragment-count among `lines`, ties resolving to the HIGHER
 *  count. 0 for no lines.
 *
 *  **Invariant:** ties go to the higher count because more fragments reveal more
 *  column boundaries. On the sparse shape — two rows of two and two rows of one
 *  — that keeps the reference rows the fully-populated ones, and so keeps the
 *  reference cuts identical to the all-rows cuts, which is why a sparse table
 *  sees no change at all. */
export function modalCount(lines: TextFragment[][]): number {
  const freq = new Map<number, number>();
  for (const ln of lines) freq.set(ln.length, (freq.get(ln.length) ?? 0) + 1);
  let best = 0, bestFreq = -1;
  // Descending by count, so the first of an equal-frequency pair is the higher.
  for (const [count, n] of [...freq].sort((a, b) => b[0] - a[0]))
    if (n > bestFreq) { bestFreq = n; best = count; }
  return best;
}

/** The reference cuts and the modal count behind them. */
export interface SpanRefs { cuts: number[]; modal: number }

/** Column cuts derived from the modal rows ALONE — the boundaries a spanning row
 *  has not distorted — or undefined when there is not enough majority structure
 *  to trust.
 *
 *  **Invariant:** these are a YARDSTICK and never the final grid. Building cells
 *  from them would change cell quads and text assignment for tables that detect
 *  correctly today, which is the one thing this feature must not do. */
export function referenceCuts(
  lines: TextFragment[][], x0: number, x1: number,
): SpanRefs | undefined {
  const modal = modalCount(lines);
  if (modal < 2) return undefined;              // one column: no boundary to span
  const refs = lines.filter((ln) => ln.length === modal);
  if (refs.length < 2) return undefined;        // no majority to trust
  return { cuts: columnCuts(refs, x0, x1), modal };
}

/** How far past a reference cut a fragment must reach to count as spanning it,
 *  as a fraction of the following REFERENCE column's width.
 *
 *  **Invariant:** this margin is the entire precision argument. A long wrapped
 *  cell in column 0 is geometrically indistinguishable from a spanning header —
 *  both are one wide fragment on a row with fewer fragments than its neighbours
 *  — and excluding such a row from the cuts moves the midpoint toward it, which
 *  is exactly how a false span arises. Measured: the canonical header clears the
 *  cut by 29% of the next column, a wrapped cell ending just past the midpoint
 *  by ~6%. A starting point to tune, not a derived figure. */
const SPAN_OVERHANG = 0.2;

/** A `vSep` matrix with `false` wherever a single-fragment, non-reference row's
 *  text clears a reference cut — or undefined when no span was found, so the
 *  caller keeps the grid it already built byte for byte.
 *
 *  **Invariant:** the two cut systems are joined by INDEX, never by position.
 *  Both must describe the same number of columns or this declines outright. They
 *  normally agree, because a spanning header moves a boundary rather than
 *  inventing a column; when they agree, reference-cut index `i` IS final
 *  interior index `i - 1`. On the canonical fixture the two cuts differ by 31pt,
 *  so no honest positional tolerance could join them.
 *
 *  **Invariant:** only a row with exactly ONE fragment is a candidate. That is
 *  what makes "the spanned columns are empty in this row" true by construction
 *  rather than by a separate check — and cardinality alone is NOT the signal:
 *  measured, a sparse row holds a single fragment too, and spanning it would
 *  make `toMarkdown` print `Bolt | Bolt`. Width decides. */
export function spanSeparators(
  lines: TextFragment[][], xcuts: number[], refs: SpanRefs,
): boolean[][] | undefined {
  const C = xcuts.length - 1;
  if (C < 2) return undefined;                    // no interior separator exists
  if (refs.cuts.length - 1 !== C) return undefined;

  const vSep = mat(lines.length, C - 1, true);
  let found = false;
  lines.forEach((ln, r) => {
    if (ln.length !== 1 || ln.length === refs.modal) return;
    // Reading ln[0] is safe ONLY because of the guard above: with more than one
    // fragment this would judge the row by its leftmost one and ignore the rest.
    const x0 = ln[0].quad[0], x1 = ln[0].quad[2];
    for (let i = 1; i < refs.cuts.length - 1; i++) {
      const cut = refs.cuts[i];
      const margin = SPAN_OVERHANG * (refs.cuts[i + 1] - cut);
      if (x0 < cut && x1 > cut + margin) { vSep[r][i - 1] = false; found = true; }
    }
  });
  return found ? vSep : undefined;
}

export function detectWhitespaceTable(frags: TextFragment[]): Table | undefined {
  if (frags.length < 2) return undefined;
  const lines = groupLines(frags);
  if (lines.length < 2) return undefined;
  const x0 = Math.min(...frags.map((f) => f.quad[0])) - 1;
  const x1 = Math.max(...frags.map((f) => f.quad[2])) + 1;
  const xcuts = columnCuts(lines, x0, x1);
  const C = xcuts.length - 1;
  if (C < 2) return undefined;   // need >=2 columns

  // Row boundaries: midpoints between adjacent baselines, padded top/bottom.
  const tops = lines.map((ln) => Math.max(...ln.map((f) => f.quad[3])));
  const bottoms = lines.map((ln) => Math.min(...ln.map((f) => f.quad[1])));
  const ycuts: number[] = [Math.max(...tops) + 2];
  for (let i = 1; i < lines.length; i++) ycuts.push((bottoms[i - 1] + tops[i]) / 2);
  ycuts.push(Math.min(...bottoms) - 2);
  const R = ycuts.length - 1;

  // Guard against ordinary prose: every column must carry text in most rows.
  const cells0 = buildCells(xcuts, ycuts, mat(R, C - 1, true), mat(C, R - 1, true));
  const colFill = new Array(C).fill(0);
  for (const c of cells0) {
    const has = frags.some((f) => contains(c.quad, ...centroid(f.quad)));
    if (has) colFill[c.col]++;
  }
  if (colFill.some((n) => n < Math.ceil(R * PROSE_FILL))) return undefined;

  // **Invariant:** the span pass runs AFTER the prose guard and cannot change
  // what the detector decided — the guard above ran on the all-true grid exactly
  // as it always has, and the final cuts are still the all-rows cuts.
  // decorateInk's rule, applied to the other detector.
  const refs = referenceCuts(lines, x0, x1);
  const vSep = refs ? spanSeparators(lines, xcuts, refs) : undefined;
  const grid = vSep ? buildCells(xcuts, ycuts, vSep, mat(C, R - 1, true)) : cells0;

  const cells: TableCell[] = grid.map((c) => {
    const mine = frags.filter((f) => contains(c.quad, ...centroid(f.quad)));
    return { ...c, text: cellText(mine) };
  });
  const rows: TableRow[] = [];
  for (let r = 0; r < R; r++) {
    const rc = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    rows.push({ cells: rc, quad: rowBbox(rc) });
  }
  return new Table([xcuts[0], ycuts[R], xcuts[C], ycuts[0]], R, C, rows);
}

/** Median of a numeric list (0 for empty). */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Largest gap in 1-D coverage of the given intervals (undefined if none). */
function largestGap(intervals: [number, number][]): { lo: number; hi: number; size: number } | undefined {
  if (intervals.length < 2) return undefined;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let cover = sorted[0][1];
  let best: { lo: number; hi: number; size: number } | undefined;
  for (let i = 1; i < sorted.length; i++) {
    const [lo, hi] = sorted[i];
    if (lo > cover) {
      const size = lo - cover;
      if (!best || size > best.size) best = { lo: cover, hi: lo, size };
    }
    cover = Math.max(cover, hi);
  }
  return best;
}

const VGAP_MULT = 2.0;   // stacked separator must exceed this * median font size
const HGAP_MULT = 2.5;   // side-by-side separator must exceed this * median font size

/** Candidate splits on each axis whose largest full-span whitespace band exceeds
 *  its threshold, ordered by how much it exceeds it (most-exceeding first). A gap
 *  in the Y projection is a full-width horizontal band (separates stacked tables);
 *  a gap in the X projection is a full-height vertical band (separates side-by-side
 *  tables). Both are returned so a caller can try the next axis when the first
 *  split fails validation — critical when a full-height inter-column gap competes
 *  with the true stacked separator. */
function candidateSplits(frags: TextFragment[]): [TextFragment[], TextFragment[]][] {
  const fs = median(frags.map((f) => f.fontSize)) || 1;
  const build = (axis: 'y' | 'x', mult: number) => {
    const gap = axis === 'y'
      ? largestGap(frags.map((f) => [f.quad[1], f.quad[3]] as [number, number]))
      : largestGap(frags.map((f) => [f.quad[0], f.quad[2]] as [number, number]));
    if (!gap || gap.size < mult * fs) return undefined;
    const mid = (gap.lo + gap.hi) / 2;
    const A: TextFragment[] = [], B: TextFragment[] = [];
    for (const f of frags) {
      const c = axis === 'y' ? (f.quad[1] + f.quad[3]) / 2 : (f.quad[0] + f.quad[2]) / 2;
      (c > mid ? A : B).push(f);
    }
    if (!A.length || !B.length) return undefined;
    return { ratio: gap.size / (mult * fs), split: [A, B] as [TextFragment[], TextFragment[]] };
  };
  const cs = [build('y', VGAP_MULT), build('x', HGAP_MULT)]
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => b.ratio - a.ratio);
  return cs.map((c) => c.split);
}

/** Recursively XY-cut fragments into spatially-separated blocks, detecting one
 *  whitespace table per leaf. Each axis's split is tried in most-exceeding order;
 *  a split is accepted only when it yields >= 2 valid tables, so a single sparse
 *  table is not wrongly halved (splitting it on an inter-column gap produces
 *  single-column halves that fail detection). Otherwise the whole block is a
 *  single candidate. */
export function segmentBlocks(frags: TextFragment[]): Table[] {
  if (frags.length < 2) return [];
  for (const [A, B] of candidateSplits(frags)) {
    const left = segmentBlocks(A);
    const right = segmentBlocks(B);
    if (left.length + right.length >= 2) return [...left, ...right];
  }
  const t = detectWhitespaceTable(frags);
  return t ? [t] : [];
}

export const mat = (rows: number, cols: number, v: boolean): boolean[][] =>
  Array.from({ length: rows }, () => new Array(Math.max(0, cols)).fill(v));
