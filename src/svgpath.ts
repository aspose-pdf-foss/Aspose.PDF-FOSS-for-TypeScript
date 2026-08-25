// SVG path data: the `d` grammar normalized to cubics (issue 1gg0.3). Pure —
// touches no PDF objects and imports only geometry and the XML node shape.
// Every command becomes M / L / C / Z, so the emitter in svgdraw.ts only ever
// has four cases to handle. It also owns the shape-element -> segments mapping
// (`shapeSegs`) and the subtree box walk built on it, which svgdraw.ts needs but
// cannot host without a cycle.
import type { XmlNode } from './xml.js';
import { parseTransform } from './svgtransform.js';
import { IDENTITY, mul, type Matrix } from './text.js';

/** One normalized path segment. `M`/`L` carry [x, y]; `C` carries
 *  [x1, y1, x2, y2, x, y]; `Z` carries nothing. */
export interface SvgSeg {
  op: 'M' | 'L' | 'C' | 'Z';
  args: number[];
}

const NUM = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/;
const IS_CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(): void {
    while (this.i < this.s.length && (this.s[this.i] === ',' || /\s/.test(this.s[this.i]))) this.i++;
  }
  eof(): boolean { this.ws(); return this.i >= this.s.length; }
  peek(): string { this.ws(); return this.s[this.i]; }
  num(): number | undefined {
    this.ws();
    const m = NUM.exec(this.s.slice(this.i));
    if (!m || m[0] === '' || m[0] === '.' || m[0] === '+' || m[0] === '-') return undefined;
    this.i += m[0].length;
    return parseFloat(m[0]);
  }
  /** An arc flag is a single '0' or '1' and may carry no separator at all
   *  ("a1 1 0 011 1"), so it cannot go through num(). */
  flag(): number | undefined {
    this.ws();
    const c = this.s[this.i];
    if (c !== '0' && c !== '1') return undefined;
    this.i++;
    return c === '1' ? 1 : 0;
  }
}

/** Convert an endpoint-parameterized elliptical arc to a list of cubics
 *  (SVG 1.1 F.6.5). Each entry is [x1, y1, x2, y2, x, y]. Returns [] when the
 *  endpoints coincide, which SVG defines as drawing nothing. Callers must
 *  handle rx or ry of 0 themselves — that degenerates to a straight line. */
export function arcToCubics(
  x0: number, y0: number, rx: number, ry: number, phiDeg: number,
  fa: number, fs: number, x: number, y: number,
): number[][] {
  if (x0 === x && y0 === y) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // F.6.6: scale the radii up when they cannot span the chord.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }

  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dtheta = ang(ux, uy, vx, vy);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fs && dtheta < 0) dtheta += 2 * Math.PI;

  // A cubic approximates at most a quarter turn well, so split first.
  const n = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  const out: number[][] = [];
  let th = theta1, px = x0, py = y0;
  for (let i = 0; i < n; i++) {
    const th2 = th + delta;
    const last = i === n - 1;
    const cos1 = Math.cos(th), sin1 = Math.sin(th);
    const cos2 = Math.cos(th2), sin2 = Math.sin(th2);
    // Snap the final on-curve point to the endpoint the path actually asked
    // for. Computing it from cos/sin lands within float epsilon instead
    // (6e-15, not 0), which leaves a hairline gap wherever the next segment
    // assumes it starts exactly here — and makes exact assertions impossible.
    const ex = last ? x : cosP * rx * cos2 - sinP * ry * sin2 + cx;
    const ey = last ? y : sinP * rx * cos2 + cosP * ry * sin2 + cy;
    const d1x = cosP * -rx * sin1 - sinP * ry * cos1;
    const d1y = sinP * -rx * sin1 + cosP * ry * cos1;
    const d2x = cosP * -rx * sin2 - sinP * ry * cos2;
    const d2y = sinP * -rx * sin2 + cosP * ry * cos2;
    out.push([px + k * d1x, py + k * d1y, ex - k * d2x, ey - k * d2y, ex, ey]);
    px = ex; py = ey; th = th2;
  }
  return out;
}

/** Parse SVG path data into normalized segments. Malformed data is not an
 *  error: SVG's own rule is to render the valid prefix and stop, which is what
 *  `truncated` reports so the caller can flag the degradation. */
export function parsePath(d: string): { segs: SvgSeg[]; truncated: boolean } {
  const r = new Reader(d ?? '');
  const segs: SvgSeg[] = [];
  let cmd = '';
  let cx = 0, cy = 0;      // current point
  let sx = 0, sy = 0;      // start of the current subpath
  let lastC: [number, number] | undefined;   // previous cubic control, for S
  let lastQ: [number, number] | undefined;   // previous quadratic control, for T

  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    segs.push({ op: 'C', args: [x1, y1, x2, y2, x, y] });
    cx = x; cy = y;
  };

  for (;;) {
    if (r.eof()) return { segs, truncated: false };
    const c = r.peek();
    if (/[A-Za-z]/.test(c)) {
      if (!IS_CMD.test(c)) return { segs, truncated: true };
      cmd = c; r.i++;
    } else if (cmd === '') {
      return { segs, truncated: true };     // numbers before any command
    } else if (cmd === 'M') { cmd = 'L'; }  // a repeated moveto is a lineto
    else if (cmd === 'm') { cmd = 'l'; }

    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;

    switch (cmd.toUpperCase()) {
      case 'Z':
        segs.push({ op: 'Z', args: [] });
        cx = sx; cy = sy; lastC = lastQ = undefined;
        continue;
      case 'M': {
        const x = r.num(), y = r.num();
        if (x === undefined || y === undefined) return { segs, truncated: true };
        cx = x + ox; cy = y + oy; sx = cx; sy = cy;
        segs.push({ op: 'M', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'L': {
        const x = r.num(), y = r.num();
        if (x === undefined || y === undefined) return { segs, truncated: true };
        cx = x + ox; cy = y + oy;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'H': {
        const x = r.num();
        if (x === undefined) return { segs, truncated: true };
        cx = x + ox;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'V': {
        const y = r.num();
        if (y === undefined) return { segs, truncated: true };
        cy = y + oy;
        segs.push({ op: 'L', args: [cx, cy] });
        lastC = lastQ = undefined;
        continue;
      }
      case 'C': {
        const a = [r.num(), r.num(), r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x1, y1, x2, y2, x, y] = a as number[];
        lastC = [x2 + ox, y2 + oy]; lastQ = undefined;
        cubic(x1 + ox, y1 + oy, x2 + ox, y2 + oy, x + ox, y + oy);
        continue;
      }
      case 'S': {
        const a = [r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x2, y2, x, y] = a as number[];
        const rx1 = lastC ? 2 * cx - lastC[0] : cx;
        const ry1 = lastC ? 2 * cy - lastC[1] : cy;
        lastC = [x2 + ox, y2 + oy]; lastQ = undefined;
        cubic(rx1, ry1, x2 + ox, y2 + oy, x + ox, y + oy);
        continue;
      }
      case 'Q': {
        const a = [r.num(), r.num(), r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [qx, qy, x, y] = a as number[];
        const ax = qx + ox, ay = qy + oy, ex = x + ox, ey = y + oy;
        lastQ = [ax, ay]; lastC = undefined;
        cubic(cx + (2 / 3) * (ax - cx), cy + (2 / 3) * (ay - cy),
              ex + (2 / 3) * (ax - ex), ey + (2 / 3) * (ay - ey), ex, ey);
        continue;
      }
      case 'T': {
        const a = [r.num(), r.num()];
        if (a.some((v) => v === undefined)) return { segs, truncated: true };
        const [x, y] = a as number[];
        const ax = lastQ ? 2 * cx - lastQ[0] : cx;
        const ay = lastQ ? 2 * cy - lastQ[1] : cy;
        const ex = x + ox, ey = y + oy;
        lastQ = [ax, ay]; lastC = undefined;
        cubic(cx + (2 / 3) * (ax - cx), cy + (2 / 3) * (ay - cy),
              ex + (2 / 3) * (ax - ex), ey + (2 / 3) * (ay - ey), ex, ey);
        continue;
      }
      case 'A': {
        const rx = r.num(), ry = r.num(), rot = r.num();
        const fa = r.flag(), fs = r.flag();
        const x = r.num(), y = r.num();
        if ([rx, ry, rot, fa, fs, x, y].some((v) => v === undefined))
          return { segs, truncated: true };
        const ex = (x as number) + ox, ey = (y as number) + oy;
        if (rx === 0 || ry === 0) {
          cx = ex; cy = ey;
          segs.push({ op: 'L', args: [cx, cy] });
        } else {
          for (const cu of arcToCubics(cx, cy, rx as number, ry as number,
                                       rot as number, fa as number, fs as number, ex, ey))
            segs.push({ op: 'C', args: cu });
          cx = ex; cy = ey;
        }
        lastC = lastQ = undefined;
        continue;
      }
      default:
        return { segs, truncated: true };
    }
  }
}

/** k for approximating a quarter ellipse with one cubic. */
const KAPPA = 0.5522847498307936;

/** A `<rect>` as segments. `rx`/`ry` may be NaN (absent): each defaults to the
 *  other, and both are clamped to half the corresponding side, per SVG 1.1. */
export function rectSegs(
  x: number, y: number, w: number, h: number, rx: number, ry: number,
): SvgSeg[] {
  if (!(w > 0) || !(h > 0)) return [];
  let a = Number.isFinite(rx) ? rx : (Number.isFinite(ry) ? ry : 0);
  let b = Number.isFinite(ry) ? ry : (Number.isFinite(rx) ? rx : 0);
  a = Math.min(Math.max(a, 0), w / 2);
  b = Math.min(Math.max(b, 0), h / 2);
  if (a === 0 || b === 0) {
    return [
      { op: 'M', args: [x, y] },
      { op: 'L', args: [x + w, y] },
      { op: 'L', args: [x + w, y + h] },
      { op: 'L', args: [x, y + h] },
      { op: 'Z', args: [] },
    ];
  }
  const ox = a * KAPPA, oy = b * KAPPA;
  return [
    { op: 'M', args: [x + a, y] },
    { op: 'L', args: [x + w - a, y] },
    { op: 'C', args: [x + w - a + ox, y, x + w, y + b - oy, x + w, y + b] },
    { op: 'L', args: [x + w, y + h - b] },
    { op: 'C', args: [x + w, y + h - b + oy, x + w - a + ox, y + h, x + w - a, y + h] },
    { op: 'L', args: [x + a, y + h] },
    { op: 'C', args: [x + a - ox, y + h, x, y + h - b + oy, x, y + h - b] },
    { op: 'L', args: [x, y + b] },
    { op: 'C', args: [x, y + b - oy, x + a - ox, y, x + a, y] },
    { op: 'Z', args: [] },
  ];
}

/** An `<ellipse>` (or `<circle>`, with rx === ry) as four cubics. */
export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): SvgSeg[] {
  if (!(rx > 0) || !(ry > 0)) return [];
  const ox = rx * KAPPA, oy = ry * KAPPA;
  return [
    { op: 'M', args: [cx + rx, cy] },
    { op: 'C', args: [cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry] },
    { op: 'C', args: [cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy] },
    { op: 'C', args: [cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry] },
    { op: 'C', args: [cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy] },
    { op: 'Z', args: [] },
  ];
}

/** A `<polyline>` (close false) or `<polygon>` (close true) from a flat
 *  [x0, y0, x1, y1, …] list. Fewer than two points draws nothing. */
export function polySegs(pts: number[], close: boolean): SvgSeg[] {
  if (pts.length < 4) return [];
  const segs: SvgSeg[] = [{ op: 'M', args: [pts[0], pts[1]] }];
  for (let i = 2; i + 1 < pts.length; i += 2) segs.push({ op: 'L', args: [pts[i], pts[i + 1]] });
  if (close) segs.push({ op: 'Z', args: [] });
  return segs;
}

/** Parse a `points` attribute. Separators are optional, so "1-2 3-4" is four
 *  numbers. A trailing unpaired coordinate is dropped, per SVG error handling. */
export function parsePoints(s: string): number[] {
  const r = new Reader(s ?? '');
  const out: number[] = [];
  for (;;) {
    const n = r.num();
    if (n === undefined) break;
    out.push(n);
  }
  if (out.length % 2 === 1) out.pop();
  return out;
}

/** An axis-aligned box in the coordinate system the segments are expressed in. */
export interface SegBBox { x: number; y: number; w: number; h: number }

/** The parameters in (0, 1) where a cubic's derivative vanishes on one axis.
 *  B'(t)/3 = a t^2 + b t + c with A = p1-p0, B = p2-p1, C = p3-p2:
 *  a = A - 2B + C, b = 2(B - A), c = A. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const A = p1 - p0, B = p2 - p1, C = p3 - p2;
  const a = A - 2 * B + C, b = 2 * (B - A), c = A;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      ts.push((-b + s) / (2 * a), (-b - s) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

/** The TIGHT bounding box of normalized segments, in their own coordinate system:
 *  endpoints plus each cubic's exact per-axis extrema. Returns null when the list
 *  contributes no points.
 *
 *  The control-point hull is NOT an acceptable substitute — it reports a larger
 *  box than the curve occupies, which would stretch every objectBoundingBox
 *  gradient on a curved shape. */
export function segsBBox(segs: SvgSeg[]): SegBBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  let cx = 0, cy = 0;
  for (const s of segs) {
    if (s.op === 'M' || s.op === 'L') {
      cx = s.args[0]; cy = s.args[1];
      add(cx, cy);
    } else if (s.op === 'C') {
      const [x1, y1, x2, y2, x3, y3] = s.args;
      add(x3, y3);
      // Each loop solves ONE axis; the other argument is a point already
      // included, so it cannot widen the box on the axis it is not solving.
      for (const t of cubicExtrema(cx, x1, x2, x3)) add(cubicAt(cx, x1, x2, x3, t), cy);
      for (const t of cubicExtrema(cy, y1, y2, y3)) add(cx, cubicAt(cy, y1, y2, y3, t));
      cx = x3; cy = y3;
    }
    // Z closes back to a point already included by its subpath's M.
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** One numeric attribute, falling back to `dflt` when absent or unparseable.
 *  Exported because svgdraw.ts's <use> shift is the one call site left outside
 *  this module after shapeSegs moved here — a second copy of the same four lines
 *  is what the move was meant to avoid. */
export const attrNum = (n: XmlNode, k: string, dflt = 0): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return dflt;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

const attrNumOrNaN = (n: XmlNode, k: string): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return NaN;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
};

/** The segments a shape element contributes, or [] when it draws nothing. */
export function shapeSegs(n: XmlNode): { segs: SvgSeg[]; truncated: boolean } {
  switch (n.name) {
    case 'path': {
      const { segs, truncated } = parsePath(n.attrs.get('d') ?? '');
      return { segs, truncated };
    }
    case 'rect':
      return {
        segs: rectSegs(attrNum(n, 'x'), attrNum(n, 'y'), attrNum(n, 'width'),
                       attrNum(n, 'height'), attrNumOrNaN(n, 'rx'), attrNumOrNaN(n, 'ry')),
        truncated: false,
      };
    case 'circle': {
      const r = attrNum(n, 'r');
      return { segs: ellipseSegs(attrNum(n, 'cx'), attrNum(n, 'cy'), r, r), truncated: false };
    }
    case 'ellipse':
      return {
        segs: ellipseSegs(attrNum(n, 'cx'), attrNum(n, 'cy'), attrNum(n, 'rx'), attrNum(n, 'ry')),
        truncated: false,
      };
    case 'line':
      return {
        segs: [
          { op: 'M', args: [attrNum(n, 'x1'), attrNum(n, 'y1')] },
          { op: 'L', args: [attrNum(n, 'x2'), attrNum(n, 'y2')] },
        ],
        truncated: false,
      };
    case 'polyline':
      return { segs: polySegs(parsePoints(n.attrs.get('points') ?? ''), false), truncated: false };
    case 'polygon':
      return { segs: polySegs(parsePoints(n.attrs.get('points') ?? ''), true), truncated: false };
    default:
      return { segs: [], truncated: false };
  }
}

/** Measure a <text> element's ink. Supplied by svgdraw.ts, which owns the font
 *  provider that svgtext.ts's layout needs; this module stays pure. */
export type TextMeasure = (n: XmlNode) => SegBBox | null;

/** Elements that define something for another element to reference. They render
 *  nothing where they sit and so contribute no ink. Mirrors svgdraw.ts's
 *  DEFINITION set, kept here so the box walk needs no import from it. */
const NO_INK = new Set([
  'defs', 'symbol', 'clipPath', 'mask', 'marker', 'filter', 'pattern',
  'linearGradient', 'radialGradient', 'title', 'desc', 'metadata', 'style',
]);

/** Fold `b`, mapped through `m`, into the running union. */
function foldBox(acc: SegBBox | null, b: SegBBox, m: Matrix): SegBBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [b.x, b.x + b.w]) for (const y of [b.y, b.y + b.h]) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  if (acc === null) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const nx = Math.min(acc.x, x0), ny = Math.min(acc.y, y0);
  return {
    x: nx, y: ny,
    w: Math.max(acc.x + acc.w, x1) - nx,
    h: Math.max(acc.y + acc.h, y1) - ny,
  };
}

/** An element's bounding box, for `objectBoundingBox` units.
 *
 *  In the element's OWN user space: a descendant's `transform` applies, `n`'s own
 *  does NOT — `walk` emits that as a `cm` before placing anything that uses this
 *  box, so including it would double-apply.
 *
 *  Fill geometry only, no stroke inflation, which is what objectBoundingBox means
 *  in SVG and what `segsBBox` already gives gradients.
 *
 *  `complete: false` means there is ink the box does not cover — an unresolvable
 *  `use`, or a `<text>` with no `measure`. Callers must degrade rather than
 *  silently use a box that is too small. */
export function subtreeBBox(
  n: XmlNode, ids: Map<string, XmlNode>, measure?: TextMeasure,
): { box: SegBBox | null; complete: boolean } {
  let acc: SegBBox | null = null;
  let complete = true;
  const active = new Set<string>();

  const visit = (node: XmlNode, m: Matrix, isRoot: boolean): void => {
    if (NO_INK.has(node.name)) return;
    // The root's own transform is excluded; a descendant's is not.
    const here = isRoot ? m : mul(parseTransform(node.attrs.get('transform')), m);

    if (node.name === 'text') {
      const b = measure?.(node);
      if (b) acc = foldBox(acc, b, here);
      else complete = false;
      return;
    }
    if (node.name === 'image') {
      const w = attrNum(node, 'width'), h = attrNum(node, 'height');
      if (w > 0 && h > 0)
        acc = foldBox(acc, { x: attrNum(node, 'x'), y: attrNum(node, 'y'), w, h }, here);
      return;
    }
    if (node.name === 'use') {
      const id = (node.attrs.get('href') ?? node.attrs.get('xlink:href') ?? '').replace(/^#/, '');
      const target = id === '' ? undefined : ids.get(id);
      if (!target || active.has(id)) { complete = false; return; }
      const dx = attrNum(node, 'x'), dy = attrNum(node, 'y');
      active.add(id);
      // The target is visited as a non-root: its own transform DOES apply here,
      // because <use> renders it as a child rather than as the referring element.
      visit(target, mul([1, 0, 0, 1, dx, dy], here), false);
      active.delete(id);
      return;
    }
    const { segs } = shapeSegs(node);
    if (segs.length > 0) {
      const b = segsBBox(segs);
      if (b) acc = foldBox(acc, b, here);
      return;
    }
    for (const c of node.children) visit(c, here, false);
  };

  visit(n, [...IDENTITY], true);
  return { box: acc, complete };
}
