import type { Matrix } from './text.js';

/** ~0.29°: below this, a page is treated as axis-aligned. */
export const ANGLE_EPS = 0.005;

export interface Seg { x0: number; y0: number; x1: number; y1: number; }

/** Rotation-about-origin matrix for angle `theta` (radians). */
export function rot(theta: number): Matrix {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, s, -s, c, 0, 0];
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
