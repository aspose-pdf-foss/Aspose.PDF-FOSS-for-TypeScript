import { apply, mul, type GlyphEvent, type Matrix, type Rect } from './text.js';

/** ~0.29°: below this, a page is treated as axis-aligned. */
export const ANGLE_EPS = 0.005;

export interface Seg { x0: number; y0: number; x1: number; y1: number; }

/** Rotation-about-origin matrix for angle `theta` (radians). */
export function rot(theta: number): Matrix {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, s, -s, c, 0, 0];
}

type Point = [number, number];

/** Corners in perimeter order, starting at the local lower left. */
export function boxCorners([x, y, u, v]: Rect, matrix: Matrix): Point[] {
  return [apply(matrix, x, y), apply(matrix, u, y), apply(matrix, u, v), apply(matrix, x, v)];
}

export function bounds(points: Point[]): Rect {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Separating axes for a transformed rectangle and an axis-aligned cell box.
 * Also accepts a segment represented by its two endpoints twice. */
export function touchesBox(points: Point[], box: Rect): boolean {
  const [x, y, u, v] = bounds(points);
  if (u < box[0] || x > box[2] || v < box[1] || y > box[3]) return false;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  for (const end of [points[1], points[3]]) {
    const nx = points[0][1] - end[1], ny = end[0] - points[0][0];
    const radius = (Math.abs(nx) * (box[2] - box[0]) + Math.abs(ny) * (box[3] - box[1])) / 2;
    const ds = points.map(([px, py]) => (px - cx) * nx + (py - cy) * ny);
    if (Math.min(...ds) > radius || Math.max(...ds) < -radius) return false;
  }
  return true;
}

/** A glyph's pen span and one-em height in the table's axes. The page-space
 * quad stores the baseline origin and only the x component of the pen end.
 * Transform the pen and the font basis before taking an enclosing rectangle. */
export function glyphCorners(g: GlyphEvent, frame: Matrix): Point[] {
  const m = mul(mul(g.tm, g.ctm), frame);
  const [u, v] = apply(frame, ...g.penEnd);
  if (g.vertical) {
    const startX = u - m[2] * g.advance * g.tfSize, startY = v - m[3] * g.advance * g.tfSize;
    const dx = m[0] * g.tfSize / 2, dy = m[1] * g.tfSize / 2;
    return [[startX - dx, startY - dy], [startX + dx, startY + dy], [u + dx, v + dy], [u - dx, v - dy]];
  }
  const [x, y] = apply(frame, g.quad[0], g.quad[1]);
  const dx = m[2] * g.tfSize, dy = m[3] * g.tfSize;
  return [[x, y], [u, v], [u + dx, v + dy], [x + dx, y + dy]];
}

export function glyphInFrame(g: GlyphEvent, frame: Matrix, angle: number, corners = glyphCorners(g, frame)): GlyphEvent {
  const delta = g.angle - angle;
  return { ...g, quad: bounds(corners), penEnd: apply(frame, ...g.penEnd),
    angle: Math.atan2(Math.sin(delta), Math.cos(delta)) };
}

/** Wrap `a` into (-period/2, period/2]. */
function normalize(a: number, period: number): number {
  let x = a % period;
  if (x < 0) x += period;
  if (x > period / 2) x -= period;
  return x;
}

/** Weighted modal angle over [0, period): 1° bins, then the weighted mean of the
 *  modal bin and its immediate neighbours, normalised to (-period/2, period/2]. */
function modeAngle(angles: number[], weights: number[], period: number): number {
  const binW = Math.PI / 180;
  const nbins = Math.max(1, Math.round(period / binW));
  const acc = new Array(nbins).fill(0);
  const norm = angles.map((a) => { let x = a % period; if (x < 0) x += period; return x; });
  const binOf = (x: number) => Math.min(nbins - 1, Math.floor((x / period) * nbins));
  norm.forEach((x, i) => { acc[binOf(x)] += weights[i]; });
  let best = 0;
  for (let b = 1; b < nbins; b++) if (acc[b] > acc[best]) best = b;
  let sw = 0, sa = 0;
  norm.forEach((x, i) => { if (Math.abs(binOf(x) - best) <= 1) { sw += weights[i]; sa += weights[i] * x; } });
  const mean = sw ? sa / sw : ((best + 0.5) * period) / nbins;
  return normalize(mean, period);
}

/** Dominant rotation angle (radians). Text-baseline-primary (full circle);
 *  falls back to rule direction mod 90°; 0 when neither is available. */
export function dominantAngle(segments: Seg[], glyphAngles: number[]): number {
  if (glyphAngles.length) return modeAngle(glyphAngles, glyphAngles.map(() => 1), 2 * Math.PI);
  const oriented = segments
    .map((s) => ({ a: Math.atan2(s.y1 - s.y0, s.x1 - s.x0), w: Math.hypot(s.x1 - s.x0, s.y1 - s.y0) }))
    .filter((o) => o.w > 0);
  if (!oriented.length) return 0;
  return modeAngle(oriented.map((o) => o.a), oriented.map((o) => o.w), Math.PI / 2);
}
