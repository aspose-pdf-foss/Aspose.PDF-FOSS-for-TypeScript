// Stroke geometry: turning a stroked path into a filled outline. Pure geometry
// with no backend bias (cf. pagerender's baseMatrix), because both renderers
// need it — raster.ts fills the outline or accumulates it into a clip mask, and
// svgrender.ts emits it as a <clipPath> child. SVG 1.1 §14.3.5 excludes the
// `stroke` property from clipping paths, so a stroke-shaped clip has to be a
// real outlined region there, not a stroked zero-area line.
import { Matrix, apply } from './text.js';
import { Path, StrokeStyle } from './pagerender.js';
import type { PsBudget } from './psbudget.js';

export interface StrokeGeometryOptions {
  budget?: PsBudget;
  pixelSize?: number;
  tolerance?: number;
}

export const FLATTEN_TOL = 0.2;      // device-pixel flatness tolerance for Bézier subdivision
export const MAX_SUBDIV = 16;        // recursion cap per cubic

export type Poly = number[];         // flat [x,y,x,y,...] in device space

export function flattenCubic(
  out: Poly, x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number, depth: number, tol: number, budget?: PsBudget,
): void {
  budget?.work();
  if (depth >= MAX_SUBDIV) { budget?.allocate(16); budget?.items(out.length / 2 + 1); out.push(x3, y3); return; }
  // Flatness: max distance of control points from the chord.
  const dx = x3 - x0, dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  if ((d1 + d2) * (d1 + d2) <= tol * tol * (dx * dx + dy * dy)) {
    budget?.allocate(16);
    budget?.items(out.length / 2 + 1);
    out.push(x3, y3);
    return;
  }
  // de Casteljau split at t=0.5
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
  const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
  const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
  const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
  budget?.depth(depth + 1);
  flattenCubic(out, x0, y0, x01, y01, xa, ya, xm, ym, depth + 1, tol, budget);
  flattenCubic(out, xm, ym, xb, yb, x23, y23, x3, y3, depth + 1, tol, budget);
}

// ---------- Path flattening (user → device polylines) ----------

/** Flatten a structured path to device-space subpath polylines under `ctm`. */
export function flattenPath(path: Path, ctm: Matrix, tol = FLATTEN_TOL): Poly[] {
  const polys: Poly[] = [];
  let cur: Poly | undefined;
  let sx = 0, sy = 0;          // subpath start (device)
  let px = 0, py = 0;          // current point (device)
  const start = (dx: number, dy: number) => { cur = [dx, dy]; polys.push(cur); sx = px = dx; sy = py = dy; };
  for (const s of path) {
    if (s.op === 'M') {
      const [dx, dy] = apply(ctm, s.x, s.y);
      start(dx, dy);
    } else if (s.op === 'L') {
      if (!cur) start(...apply(ctm, s.x, s.y));
      else { const [dx, dy] = apply(ctm, s.x, s.y); cur.push(dx, dy); px = dx; py = dy; }
    } else if (s.op === 'C') {
      if (!cur) { const [dx, dy] = apply(ctm, s.x, s.y); start(dx, dy); continue; }
      const [c1x, c1y] = apply(ctm, s.x1, s.y1);
      const [c2x, c2y] = apply(ctm, s.x2, s.y2);
      const [ex, ey] = apply(ctm, s.x, s.y);
      flattenCubic(cur, px, py, c1x, c1y, c2x, c2y, ex, ey, 0, tol);
      px = ex; py = ey;
    } else {                    // Z
      if (cur) { cur.push(sx, sy); px = sx; py = sy; }
    }
  }
  return polys;
}

// ---------- Stroking (outline built in user space, filled nonzero after CTM) ----------

/** A subpath flattened in user space, with whether it was explicitly closed (`h`). */
interface UserSub { pts: number[]; closed: boolean; }

/** Flatten a structured path to user-space polylines. Bézier flatness is measured
 *  in user units scaled to the device tolerance so curves stay smooth after CTM. */
function flattenPathUser(path: Path, tol: number, budget?: PsBudget): UserSub[] {
  const subs: UserSub[] = [];
  let cur: number[] | undefined;
  let closed = false;
  let sx = 0, sy = 0, px = 0, py = 0;
  const flush = () => {
    if (cur && cur.length >= 2) { budget?.allocate(32); budget?.items(subs.length + 1); subs.push({ pts: cur, closed }); }
  };
  const start = (x: number, y: number) => { flush(); budget?.allocate(16); cur = [x, y]; closed = false; sx = px = x; sy = py = y; };
  for (const s of path) {
    budget?.work();
    if (s.op === 'M') start(s.x, s.y);
    else if (s.op === 'L') { if (!cur) start(s.x, s.y); else { budget?.allocate(16); budget?.items(cur.length / 2 + 1); cur.push(s.x, s.y); px = s.x; py = s.y; } }
    else if (s.op === 'C') {
      if (!cur) { start(s.x, s.y); continue; }
      flattenCubic(cur, px, py, s.x1, s.y1, s.x2, s.y2, s.x, s.y, 0, tol, budget);
      px = s.x; py = s.y;
    } else if (cur) { budget?.allocate(16); cur.push(sx, sy); px = sx; py = sy; closed = true; }
  }
  flush();
  return subs;
}

/** Magnitude of CTM scale (geometric mean of axis lengths), for tolerances/hairlines. */
export function ctmScale(m: Matrix): number {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  const s = Math.sqrt(det);
  return Number.isFinite(s) && s > 1e-9 ? s : 1;
}

/** Split a user-space polyline by the dash pattern; returns open runs (each `[x,y,...]`).
 *  Zero-length "on" runs are kept as single points so round/square caps draw dots. */
function dashPolyline(pts: number[], dash: number[], phase: number, budget?: PsBudget): number[][] {
  budget?.allocate(dash.length * 24, 'dash pattern');
  budget?.work(dash.length, 'dash pattern');
  let pat = dash.filter((d) => d >= 0);
  if (pat.length === 0) return [pts];
  if (pat.length % 2 === 1) pat = pat.concat(pat);
  const total = pat.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return [pts];

  // Advance the phase into the pattern to find the starting gap/dash.
  let idx = 0, on = true, rem = pat[0];
  let ph = ((phase % total) + total) % total;
  while (ph > 0) {
    budget?.work();
    if (ph >= rem) { ph -= rem; idx = (idx + 1) % pat.length; rem = pat[idx]; on = !on; }
    else { rem -= ph; ph = 0; }
  }

  const runs: number[][] = [];
  budget?.allocate(16, 'dash run');
  let cur: number[] | undefined = on ? [pts[0], pts[1]] : undefined;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    budget?.work();
    let ax = pts[i], ay = pts[i + 1];
    const bx = pts[i + 2], by = pts[i + 3];
    let segLen = Math.hypot(bx - ax, by - ay);
    if (segLen === 0) continue;
    const ux = (bx - ax) / segLen, uy = (by - ay) / segLen;
    while (segLen > rem + 1e-9) {
      budget?.work();
      budget?.allocate(48, 'dash expansion');
      budget?.items(runs.length + 1, 'dash expansion');
      ax += ux * rem; ay += uy * rem; segLen -= rem;
      if (on && cur) { cur.push(ax, ay); runs.push(cur); cur = undefined; }
      idx = (idx + 1) % pat.length; rem = pat[idx]; on = !on;
      if (on) cur = [ax, ay];
    }
    rem -= segLen;
    budget?.allocate(16, 'dash endpoint');
    if (on && cur) cur.push(bx, by);
  }
  if (on && cur && cur.length >= 2) runs.push(cur);
  return runs;
}

/** Push a convex contour, normalizing to positive (CCW) orientation so that all
 *  emitted pieces share a winding sign and combine under the nonzero rule. */
function pushContour(out: number[][], c: number[], budget?: PsBudget): void {
  budget?.work(c.length / 2);
  budget?.allocate(c.length * 8 + 16, 'stroke contour');
  budget?.items(out.length + 1, 'stroke contours');
  let area = 0;
  for (let i = 0; i + 3 < c.length; i += 2) area += c[i] * c[i + 3] - c[i + 2] * c[i + 1];
  const n = c.length;
  area += c[n - 2] * c[1] - c[0] * c[n - 1];
  if (Math.abs(area) < 1e-12) return;
  if (area < 0) { const r: number[] = []; for (let i = n - 2; i >= 0; i -= 2) r.push(c[i], c[i + 1]); out.push(r); }
  else out.push(c);
}

function circleContour(out: number[][], cx: number, cy: number, r: number, segs: number, budget?: PsBudget): void {
  budget?.items(segs, 'round stroke segments');
  budget?.work(segs, 'round stroke segments');
  budget?.allocate(segs * 16, 'round stroke segments');
  const c: number[] = [];
  for (let i = 0; i < segs; i++) { const a = (2 * Math.PI * i) / segs; c.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  pushContour(out, c, budget);
}

/** Build the filled stroke outline (user space) for one flattened, possibly-closed
 *  polyline. Emits per-segment quads plus join and cap pieces; the union is filled
 *  nonzero. `hw` is half the line width; `segs` sets round-arc tessellation. */
function strokePolyline(out: number[][], pts: number[], closed: boolean, hw: number, style: StrokeStyle, segs: number, budget?: PsBudget): void {
  budget?.allocate(pts.length * 8, 'stroke vertices');
  // Deduplicate coincident vertices.
  const v: number[] = [pts[0], pts[1]];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    budget?.work();
    if (Math.abs(pts[i] - v[v.length - 2]) > 1e-9 || Math.abs(pts[i + 1] - v[v.length - 1]) > 1e-9) v.push(pts[i], pts[i + 1]);
  }
  if (closed && v.length >= 4 &&
      Math.abs(v[0] - v[v.length - 2]) < 1e-9 && Math.abs(v[1] - v[v.length - 1]) < 1e-9) { v.pop(); v.pop(); }
  const nv = v.length / 2;

  if (nv < 2) {                                    // degenerate subpath → dot
    if (style.cap === 1) circleContour(out, v[0], v[1], hw, segs, budget);
    else if (style.cap === 2) pushContour(out, [v[0] - hw, v[1] - hw, v[0] + hw, v[1] - hw, v[0] + hw, v[1] + hw, v[0] - hw, v[1] + hw], budget);
    return;
  }

  const segCount = closed ? nv : nv - 1;
  const dirs: Array<[number, number]> = [];        // unit direction of each segment
  budget?.allocate(segCount * 32, 'stroke directions');
  for (let s = 0; s < segCount; s++) {
    budget?.work();
    const a = 2 * s, b = 2 * ((s + 1) % nv);
    const dx = v[b] - v[a], dy = v[b + 1] - v[a + 1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    dirs.push([ux, uy]);
    // Segment quad, offset by ±hw perpendicular (nx,ny)=(-uy,ux)*hw.
    const nx = -uy * hw, ny = ux * hw;
    pushContour(out, [v[a] + nx, v[a + 1] + ny, v[b] + nx, v[b + 1] + ny, v[b] - nx, v[b + 1] - ny, v[a] - nx, v[a + 1] - ny], budget);
  }

  // Joins at interior vertices (and the wrap vertex when closed).
  const joinFrom = closed ? 0 : 1;
  for (let s = joinFrom; s < segCount; s++) {
    const prev = dirs[(s - 1 + segCount) % segCount];
    const next = dirs[s];
    const jx = v[2 * s], jy = v[2 * s + 1];
    join(out, jx, jy, prev, next, hw, style, segs, budget);
  }

  if (!closed) {
    const d0 = dirs[0], dn = dirs[segCount - 1];
    cap(out, v[0], v[1], [-d0[0], -d0[1]], hw, style.cap, segs, budget);
    cap(out, v[2 * (nv - 1)], v[2 * (nv - 1) + 1], dn, hw, style.cap, segs, budget);
  }
}

function join(out: number[][], jx: number, jy: number, prev: [number, number], next: [number, number], hw: number, style: StrokeStyle, segs: number, budget?: PsBudget): void {
  if (style.join === 1) { circleContour(out, jx, jy, hw, segs, budget); return; }   // round covers any gap
  const n0x = -prev[1] * hw, n0y = prev[0] * hw;
  const n1x = -next[1] * hw, n1y = next[0] * hw;
  // Bevel: fill the wedge on both offset sides (inner overlaps existing quads harmlessly).
  pushContour(out, [jx, jy, jx + n0x, jy + n0y, jx + n1x, jy + n1y], budget);
  pushContour(out, [jx, jy, jx - n0x, jy - n0y, jx - n1x, jy - n1y], budget);
  if (style.join !== 0) return;                                             // bevel done
  // Miter: extend the two outer edges to their apex if within the miter limit.
  const cross = prev[0] * next[1] - prev[1] * next[0];
  if (Math.abs(cross) < 1e-9) return;                                       // collinear
  const so = cross > 0 ? -1 : 1;                                            // outer offset sign
  const a0x = jx + so * n0x, a0y = jy + so * n0y;
  const a1x = jx + so * n1x, a1y = jy + so * n1y;
  const t = ((a1x - a0x) * next[1] - (a1y - a0y) * next[0]) / cross;
  const mx = a0x + t * prev[0], my = a0y + t * prev[1];
  const ratio = Math.hypot(mx - jx, my - jy) / hw;
  if (ratio <= (style.miter || 10)) pushContour(out, [a0x, a0y, mx, my, a1x, a1y], budget);
}

function cap(out: number[][], ex: number, ey: number, dir: [number, number], hw: number, capStyle: number, segs: number, budget?: PsBudget): void {
  if (capStyle === 1) circleContour(out, ex, ey, hw, segs, budget);                 // round
  else if (capStyle === 2) {                                               // square: extend by hw
    const nx = -dir[1] * hw, ny = dir[0] * hw, ex2 = ex + dir[0] * hw, ey2 = ey + dir[1] * hw;
    pushContour(out, [ex + nx, ey + ny, ex2 + nx, ey2 + ny, ex2 - nx, ey2 - ny, ex - nx, ey - ny], budget);
  }
  // butt (0): nothing
}

/**
 * Outline already-flattened DEVICE-space polygons — the glyph case (`Tr` modes
 * 1, 2, 5 and 6).
 *
 * `strokeOutlinePolys` below is the path case: it flattens in user space and
 * transforms at the end, because a path's curves must be flattened to a
 * tolerance measured in device pixels. A glyph run arrives from the outliner
 * already flattened and already in device space, so there is nothing left to
 * transform — but the joins, caps and dashes are the same geometry, and
 * `strokePolyline` is the one owner of them. Two copies of that is how a glyph's
 * stroke comes to differ from a path's at the same width.
 *
 * `hw` is a DEVICE half-width: the line width is user-space and scales with the
 * CTM alone (32000-1 9.3.1) — never with the font size or `Tm`, which is what
 * makes a stroked glyph's outline the same weight as a stroked path's beside it.
 *
 * Each polygon is treated as CLOSED, which a glyph contour always is.
 */
export function strokePolysOutline(polys: Poly[], hw: number, style: StrokeStyle): Poly[] {
  if (!(hw > 0.5)) hw = 0.5;                       // hairlines render ~1 device pixel wide
  const segs = Math.max(8, Math.min(64, Math.ceil(hw)));
  const contours: number[][] = [];
  for (const p of polys) {
    if (p.length >= 4) strokePolyline(contours, p, true, hw, style, segs);
  }
  return contours;
}

/** Build the stroke outline as device-space polygons (the geometry half of
 *  stroking), so it can be either filled or turned into a clip mask. */
export function strokeOutlinePolys(path: Path, ctm: Matrix, style: StrokeStyle, options: StrokeGeometryOptions = {}): Poly[] {
  const budget = options.budget;
  const scale = ctmScale(ctm);
  const tol = (options.tolerance ?? FLATTEN_TOL) / scale;
  const subs = flattenPathUser(path, tol, budget);
  if (!subs.length) return [];

  let hw = style.width / 2;
  const minHw = (options.pixelSize ?? 1) / 2 / scale;
  if (options.pixelSize === undefined ? !(hw > minHw) : hw === 0) hw = minHw;

  const rDev = hw * scale;                          // device radius → round-arc segment count
  const needsRound = style.cap === 1 || style.join === 1;
  const segs = options.tolerance === undefined ? Math.max(8, Math.min(64, Math.ceil(rDev)))
    : needsRound ? Math.max(8, Math.ceil(Math.PI / Math.acos(1 - Math.min(1, options.tolerance / rDev)))) : 8;
  if (!Number.isSafeInteger(segs)) {
    budget?.work(Number.MAX_SAFE_INTEGER, 'round stroke segments');
    throw new RangeError('Stroke round-segment count exceeds numeric capacity');
  }
  const hasDash = style.dash.some((d) => d > 0);

  const contours: number[][] = [];
  for (const sub of subs) {
    if (hasDash) {
      for (const run of dashPolyline(sub.pts, style.dash, style.dashPhase, budget)) strokePolyline(contours, run, false, hw, style, segs, budget);
    } else {
      strokePolyline(contours, sub.pts, sub.closed, hw, style, segs, budget);
    }
  }
  if (!contours.length) return [];

  // Transform contours to device space (filled nonzero, as closed polys).
  return contours.map((c) => {
    budget?.allocate(c.length * 8, 'transformed stroke');
    budget?.work(c.length / 2, 'transformed stroke');
    const d: number[] = new Array(c.length);
    for (let i = 0; i < c.length; i += 2) { const [dx, dy] = apply(ctm, c[i], c[i + 1]); d[i] = dx; d[i + 1] = dy; }
    return d;
  });
}
