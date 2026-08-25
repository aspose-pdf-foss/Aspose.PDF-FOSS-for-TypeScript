import type { PagePath } from './paths.js';
import type { Rgb } from './colorspace.js';
import type { Rect } from './tablemodel.js';
import { apply, type Matrix } from './text.js';

/** One drawn axis-aligned edge, in page space. `pos` is the constant
 *  coordinate; `lo`..`hi` the span along the edge. */
export interface InkEdge { pos: number; lo: number; hi: number; width: number; color: Rgb }

/** A filled rectangle too fat to be a rule — a candidate cell or table
 *  background. */
export interface InkFill { rect: Rect; color: Rgb }

export interface PageInk { horiz: InkEdge[]; vert: InkEdge[]; fills: InkFill[] }

const AXIS_TOL = 0.6;   // matches table.ts: off-axis delta this small is axis-aligned

/** Flatten a path's subpaths to device-space line segments.
 *
 *  Cubics contribute only their endpoint: a rule is never a curve, and a
 *  curve's control points would widen the segment it is mistaken for. */
function deviceSegments(p: PagePath): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const ctm = p.ctm as Matrix;
  for (const sp of p.subpaths) {
    let cur: [number, number] | undefined;
    let start: [number, number] | undefined;
    for (const seg of sp.segments) {
      if (seg.op === 'move') {
        cur = apply(ctm, seg.pt[0], seg.pt[1]);
        start = cur;
        continue;
      }
      const to = apply(ctm, seg.pt[0], seg.pt[1]);
      if (seg.op === 'line' && cur) out.push([cur[0], cur[1], to[0], to[1]]);
      cur = to;
    }
    if (sp.closed && cur && start) out.push([cur[0], cur[1], start[0], start[1]]);
  }
  return out;
}

function pushAxis(
  segs: [number, number, number, number][], width: number, color: Rgb,
  minLen: number, horiz: InkEdge[], vert: InkEdge[],
): void {
  for (const [x0, y0, x1, y1] of segs) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= minLen) {
      horiz.push({ pos: (y0 + y1) / 2, lo: Math.min(x0, x1), hi: Math.max(x0, x1), width, color });
    } else if (dx <= AXIS_TOL && dy >= minLen) {
      vert.push({ pos: (x0 + x1) / 2, lo: Math.min(y0, y1), hi: Math.max(y0, y1), width, color });
    }
  }
}

/** Index a page's painted paths as axis-aligned edges and candidate background
 *  fills.
 *
 *  Pure: takes `PagePath[]` and the caller's tolerances, imports no PDF object
 *  module and touches no `Document`, so every rule here is testable without
 *  building a file — the split `floatstack.ts` and `docinfer.ts` already make.
 *
 *  **Invariant:** the tolerances are ARGUMENTS, not constants of this module.
 *  `table.ts` owns `MIN_RULE_LEN` and `MAX_RULE_THICK` and passes them in, so
 *  the detector and this index cannot drift about what counts as a rule — the
 *  drift would show up as a border on some edges and not others.
 *
 *  **Invariant:** a stroked edge comes from the path's SUBPATHS transformed
 *  through its own `ctm`, never from `bbox`. A grid drawn as one stroked path
 *  has a single bbox covering the whole table, which would yield one giant edge
 *  that borders everything.
 *
 *  **Invariant:** fills stay in CONTENT ORDER, so a later fill can win a tie
 *  against an earlier one — it is the one painted on top. */
export function collectPageInk(paths: PagePath[], minLen: number, maxThick: number): PageInk {
  const horiz: InkEdge[] = [], vert: InkEdge[] = [], fills: InkFill[] = [];
  for (const p of paths) {
    if (p.fill && !p.stroke) {
      const [x0, y0, x1, y1] = p.bbox;
      const w = x1 - x0, h = y1 - y0;
      // Thin means a rule, fat means shading — the same split rulesFromPath makes.
      if (Math.min(w, h) <= maxThick && Math.max(w, h) >= minLen) {
        const thick = Math.min(w, h);
        if (w >= h) horiz.push({ pos: (y0 + y1) / 2, lo: x0, hi: x1, width: thick, color: p.fill.rgb });
        else vert.push({ pos: (x0 + x1) / 2, lo: y0, hi: y1, width: thick, color: p.fill.rgb });
      } else if (w > 0 && h > 0) {
        fills.push({ rect: [x0, y0, x1, y1], color: p.fill.rgb });
      }
      continue;
    }
    if (p.stroke) {
      pushAxis(deviceSegments(p), p.lineWidth, p.stroke.rgb, minLen, horiz, vert);
    }
  }
  return { horiz, vert, fills };
}

/** The edge drawn along a cell side, or undefined when none is.
 *
 *  **Invariant:** the edge must SPAN the side, within `tol` — not merely
 *  overlap it. A short rule under one column does not border the cell beside
 *  it. This is the same test `coveredH`/`coveredV` already apply in the
 *  detector. */
export function edgeAt(
  ink: PageInk, axis: 'h' | 'v', pos: number, lo: number, hi: number, tol: number,
): InkEdge | undefined {
  const list = axis === 'h' ? ink.horiz : ink.vert;
  return list.find((e) =>
    Math.abs(e.pos - pos) <= tol && e.lo <= lo + tol && e.hi >= hi - tol);
}

/** The background fill of a cell rect, or undefined when none matches.
 *
 *  **Invariant:** a fill claims a cell only when EACH of its four edges is
 *  within `tol` of the cell's corresponding edge — never merely containing it.
 *  A page background, a full-table wash and a shaded header cell are all
 *  filled rectangles, and a containment test paints the whole table grey the
 *  moment a producer lays a background behind it.
 *
 *  **Invariant:** where several qualify, the LAST in content order wins: it is
 *  the one painted on top. */
export function fillUnder(ink: PageInk, rect: Rect, tol: number): InkFill | undefined {
  let hit: InkFill | undefined;
  for (const f of ink.fills) {
    if (f.rect.every((v, i) => Math.abs(v - rect[i]) <= tol)) hit = f;
  }
  return hit;
}
