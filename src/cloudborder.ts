/** The outward Bézier scallops of a cloudy border (/BE /S /C, `v0tz.4`).
 *
 *  Invariant: it imports NOTHING and knows no PDF object. Points and a bulge
 *  height in, cubic Béziers out — the split floatstack.ts, meshtri.ts,
 *  linebox.ts and tablespan.ts each already make, and for the same reason:
 *  this is geometry that is silently wrong when REVERSED. An inward-bulging
 *  cloud renders perfectly well as the wrong picture, so the winding is
 *  measured rather than assumed and both directions are asserted.
 *
 *  Invariant: it never throws, and never emits a non-finite number. A
 *  repeated vertex is a real shape in a /Vertices array and its unit
 *  direction is 0/0; a NaN reaching a content stream is a CORRUPT FILE
 *  rather than a wrong picture, the direction colorconvert.ts's own clamp
 *  already records.
 *
 *  Note this is a UNIFORM scallop approximation and not a viewer-exact one —
 *  32000-1 12.5.4 names the effect and prescribes no drawing, the same
 *  posture the /LE line endings take. Scallops are equal-width per edge and
 *  the cusps land on the vertices, so a corner is where two scallops meet. */

/** One cubic Bézier of a cloud outline, in the coordinate space of the points
 *  handed in. The start point is the previous segment's end, or `CloudPath`'s
 *  own `x`/`y` for the first. */
export interface CloudSegment {
  c1x: number; c1y: number;
  c2x: number; c2y: number;
  x: number; y: number;
}

/** A closed cloud outline: a start point and the cubics that return to it. */
export interface CloudPath {
  x: number; y: number;
  segments: CloudSegment[];
}

/** Twice the signed area of the closed polygon `pts` (the shoelace sum).
 *  Positive is counter-clockwise. */
export function signedArea2(pts: number[]): number {
  let sum = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return sum;
}

/** The control-point offset that puts a cubic's midpoint exactly `h` off its
 *  chord: B(0.5) moves 3/4 of the way to a control offset applied to both. */
const MID_TO_CONTROL = 4 / 3;

/** The cloud outline of the closed polygon `pts` (a flat [x,y,…] ring), whose
 *  scallops bulge `h` outward at their midpoints. Each edge takes
 *  `round(len / 2h)` scallops of equal width, at least one, each a single
 *  cubic. A scallop is never taller than half its own width. */
export function cloudPath(pts: number[], h: number): CloudPath {
  const segments: CloudSegment[] = [];
  const n = pts.length / 2;
  // Outward is to the RIGHT of travel for a counter-clockwise ring, and to the
  // left for a clockwise one. /Vertices may wind either way, so it is measured
  // rather than assumed — reversed, the cloud bulges INWARD and still renders.
  const sign = signedArea2(pts) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const ax = pts[i * 2], ay = pts[i * 2 + 1];
    const j = (i + 1) % n;
    const bx = pts[j * 2], by = pts[j * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay);
    // A repeated vertex is a real shape in a /Vertices array, and its unit
    // direction is 0/0. Skipping it keeps NaN out of the content stream — a
    // NaN there is a corrupt file rather than a wrong picture.
    if (!(len > 0)) continue;
    const count = Math.max(1, Math.round(len / (2 * h)));
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const ox = uy * sign, oy = -ux * sign;     // unit outward normal
    const step = len / count;
    // At most a semicircle: an edge shorter than one nominal scallop would
    // otherwise get a bulge taller than it is wide — a spike, not a cloud.
    const bulge = MID_TO_CONTROL * Math.min(h, step / 2);
    for (let k = 1; k <= count; k++) {
      const s0 = (k - 1) * step, s1 = k * step;
      const p1 = s0 + step / 3, p2 = s0 + step * 2 / 3;
      segments.push({
        c1x: ax + ux * p1 + ox * bulge, c1y: ay + uy * p1 + oy * bulge,
        c2x: ax + ux * p2 + ox * bulge, c2y: ay + uy * p2 + oy * bulge,
        x: ax + ux * s1, y: ay + uy * s1,
      });
    }
  }
  return { x: pts[0], y: pts[1], segments };
}
