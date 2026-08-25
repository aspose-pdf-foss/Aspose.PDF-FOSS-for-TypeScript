// SVG <textPath> geometry (issue 1gg0.20). Pure: imports no Document, allocates
// no PDF objects, and knows nothing about fonts. Coordinates are y-down viewBox
// units, like the rest of the SVG stack, so a downward tangent is +90 degrees.
import { flattenCubic, FLATTEN_TOL } from './strokegeom.js';
import type { SvgSeg } from './svgpath.js';
import type { PlacedGlyph } from './svgtext.js';

export interface Pt { x: number; y: number }

/** A path flattened to a polyline, with the cumulative arc length at each
 *  vertex. `cum[0]` is 0 and `cum[cum.length - 1]` is `total`. */
export interface PathMetrics {
  pts: Pt[];
  cum: number[];
  total: number;
}

/** Flatten `segs` to a polyline and accumulate its arc length.
 *
 *  Subpaths are CONCATENATED: a moveto after ink contributes a vertex but no
 *  length, so text crosses the gap without consuming any. That matches what
 *  browsers measure, and it is why `pointAt` has to step over zero-length
 *  segments when it takes an angle. */
export function measurePath(segs: SvgSeg[]): PathMetrics {
  const pts: Pt[] = [];
  const cum: number[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;

  const add = (x: number, y: number, jump: boolean): void => {
    if (pts.length === 0) { pts.push({ x, y }); cum.push(0); return; }
    const p = pts[pts.length - 1];
    const d = jump ? 0 : Math.hypot(x - p.x, y - p.y);
    // A zero-length leg that is not a subpath jump carries no information: it
    // would only add a vertex whose direction is undefined.
    if (d === 0 && !jump) return;
    pts.push({ x, y });
    cum.push(cum[cum.length - 1] + d);
  };

  for (const s of segs) {
    const a = s.args;
    if (s.op === 'M') {
      cx = sx = a[0]; cy = sy = a[1];
      add(cx, cy, true);
    } else if (s.op === 'L') {
      cx = a[0]; cy = a[1];
      add(cx, cy, false);
    } else if (s.op === 'C') {
      const flat: number[] = [];
      flattenCubic(flat, cx, cy, a[0], a[1], a[2], a[3], a[4], a[5], 0, FLATTEN_TOL);
      for (let i = 0; i + 1 < flat.length; i += 2) add(flat[i], flat[i + 1], false);
      cx = a[4]; cy = a[5];
    } else {
      // Z: back to the subpath start, which is a real leg with real length.
      cx = sx; cy = sy;
      add(cx, cy, false);
    }
  }
  return { pts, cum, total: cum.length > 0 ? cum[cum.length - 1] : 0 };
}

/** The point and tangent at `dist` along `m`, or null when `dist` falls outside
 *  [0, total] or the path has no extent. `angle` is in DEGREES, measured in
 *  y-down space, so a downward tangent is +90. */
export function pointAt(
  m: PathMetrics, dist: number,
): { x: number; y: number; angle: number } | null {
  if (m.pts.length < 2 || m.total <= 0) return null;
  if (dist < 0 || dist > m.total) return null;

  // Largest i with cum[i] <= dist.
  let lo = 0, hi = m.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.cum[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  let i = lo;
  // Step over zero-length segments — a subpath jump — so the angle comes from
  // geometry that actually has a direction.
  while (i + 1 < m.pts.length && m.cum[i + 1] === m.cum[i]) i++;
  if (i + 1 >= m.pts.length) i = m.pts.length - 2;

  const a = m.pts[i], b = m.pts[i + 1];
  const seg = m.cum[i + 1] - m.cum[i];
  const t = seg > 0 ? (dist - m.cum[i]) / seg : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/** The same geometry traversed backwards — what side="right" means. Reversing
 *  the polyline flips both the travel direction and the normal, so no other
 *  part of the mapping needs a side-specific case. */
export function reverseMetrics(m: PathMetrics): PathMetrics {
  const pts = [...m.pts].reverse();
  const cum: number[] = [];
  for (let i = 0; i < pts.length; i++)
    cum.push(i === 0
      ? 0
      : cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, total: cum.length > 0 ? cum[cum.length - 1] : 0 };
}

/** The point at `d` along `m`, displaced `perp` along the normal — the whole of
 *  what "put something on this path" means here. `mapGlyphsToPath` places a
 *  glyph origin with it and svgtextstretch.ts places every outline vertex, so
 *  the two cannot drift apart. The normal is (-sin, cos), which at angle 0 is
 *  (0, 1): a positive `perp` still means "further down the page", exactly as in
 *  the unmapped layout. */
export function placeAt(
  m: PathMetrics, d: number, perp: number,
): { x: number; y: number; angle: number } | null {
  const p = pointAt(m, d);
  if (p === null) return null;
  const rad = (p.angle * Math.PI) / 180;
  return {
    x: p.x - Math.sin(rad) * perp,
    y: p.y + Math.cos(rad) * perp,
    angle: p.angle,
  };
}

/** Map every glyph `onPath` accepts onto `m`, leaving the rest untouched.
 *
 *  Returns the SURVIVING glyphs rather than mutating in place: SVG 1.1
 *  §10.13.3 makes a glyph whose midpoint falls off the path not rendered at
 *  all, and dropping a glyph cannot be expressed by mutating it.
 *
 *  The distance is taken at the MIDPOINT of the glyph's advance, not at its
 *  origin — that is what centres a glyph on the curve rather than hanging it
 *  off the leading edge, and it is what SVG specifies. */
export function mapGlyphsToPath(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number,
): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  for (const g of glyphs) {
    if (!onPath(g)) { out.push(g); continue; }
    // placeAt puts the glyph MIDPOINT on the curve, displaced along the normal
    // by g.y (the offset carrying dy and baseline-shift); backing off half the
    // advance along the tangent (cos, sin) then recovers the ORIGIN.
    const p = placeAt(m, startOffset + g.x + g.adv / 2, g.y);
    if (p === null) continue;                 // off the path: not rendered
    const rad = (p.angle * Math.PI) / 180;
    const half = g.adv / 2;
    g.x = p.x - Math.cos(rad) * half;
    g.y = p.y - Math.sin(rad) * half;
    g.rot += p.angle;
    out.push(g);
  }
  return out;
}
