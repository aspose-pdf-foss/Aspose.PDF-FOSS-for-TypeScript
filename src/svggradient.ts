// SVG gradients -> PDF shading patterns (issue 1gg0.7). Pure: it builds DIRECT
// PdfDicts and touches no Document, so svgdraw.ts keeps allocating no indirect
// objects. Direction note: svgrender.ts is PDF->SVG and shares nothing with this.
import type { XmlNode } from './xml.js';
import {
  clamp01, normalizeStops, stopOpacity, stopsFunction, uniformOpacity, ALPHA,
  type GradientStop,
} from './gradient.js';
import { parseColor, styleGetter, type Rgb } from './svgstyle.js';
import type { CssMap } from './svgcss.js';
import { name, type PdfDict, type PdfObject } from './types.js';
import { IDENTITY, apply, invert, mul, type Matrix } from './text.js';
import { parseTransform, type ViewBox } from './svgtransform.js';
import type { SegBBox } from './svgpath.js';

export type { GradientStop } from './gradient.js';

/** A gradient element with its href chain already flattened. */
export interface ResolvedGradient {
  kind: 'linear' | 'radial';
  /** Own attributes, with anything unset filled in from the href chain. */
  attrs: Map<string, string>;
  /** Raw stops in document order, before normalization. */
  stops: GradientStop[];
}

const numOr = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

/** An `offset`: a number, or a percentage. Clamped into [0, 1] per SVG. */
function parseOffset(v: string | undefined): number {
  if (v === undefined) return 0;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return 0;
  return clamp01(t.endsWith('%') ? n / 100 : n);
}

/** The stops declared directly on one gradient element. */
function ownStops(node: XmlNode, css?: CssMap): GradientStop[] {
  const out: GradientStop[] = [];
  for (const c of node.children) {
    if (c.name !== 'stop') continue;
    const get = styleGetter(c.attrs, css?.get(c));
    const raw = get('stop-color');
    // `currentColor` resolves to black: the CSS default with no `color` property
    // in effect, and this stack does not track `color`. An unparseable or `none`
    // value is invalid for stop-color, which SVG also renders as black.
    const c0 = raw === undefined || raw.trim().toLowerCase() === 'currentcolor'
      ? undefined : parseColor(raw);
    out.push({
      offset: parseOffset(get('offset')),
      color: c0 ?? [0, 0, 0],
      opacity: clamp01(numOr(get('stop-opacity'), 1)),
    });
  }
  return out;
}

/** The attributes a gradient inherits through href, i.e. all of them: SVG lets a
 *  linearGradient inherit from a radialGradient, and the other type's geometry
 *  attributes are simply never read.
 *
 *  Note xml.ts strips namespace prefixes from ATTRIBUTE names as well as element
 *  names, so `xlink:href` has already arrived here as plain `href`. The explicit
 *  'xlink:href' lookups are belt-and-braces and cost nothing. */
const NOT_INHERITED = new Set(['id', 'href', 'xlink:href']);

/** Flatten a gradient's `href` / `xlink:href` chain: stops are inherited when the
 *  child declares none, and each attribute when unset on the child. A visited set
 *  breaks reference cycles, matching the guard <use> already has. */
export function resolveGradient(
  node: XmlNode, ids: Map<string, XmlNode>, css?: CssMap,
): ResolvedGradient {
  const kind: 'linear' | 'radial' = node.name === 'radialGradient' ? 'radial' : 'linear';
  const attrs = new Map(node.attrs);
  let stops = ownStops(node, css);
  const seen = new Set<string>();
  const selfId = node.attrs.get('id');
  if (selfId !== undefined) seen.add(selfId);

  let cur: XmlNode = node;
  for (;;) {
    const href = cur.attrs.get('href') ?? cur.attrs.get('xlink:href');
    if (href === undefined || href[0] !== '#') break;
    const id = href.slice(1);
    if (id === '' || seen.has(id)) break;
    seen.add(id);
    const next = ids.get(id);
    if (!next || (next.name !== 'linearGradient' && next.name !== 'radialGradient')) break;
    for (const [k, v] of next.attrs) {
      if (!NOT_INHERITED.has(k) && !attrs.has(k)) attrs.set(k, v);
    }
    if (stops.length === 0) stops = ownStops(next, css);
    cur = next;
  }
  return { kind, attrs, stops };
}

const dict = (entries: [string, PdfObject][]): PdfDict => new Map<string, PdfObject>(entries);

/** What a gradient reference resolves to for one shape.
 *  `report` true asks the caller to add the gradient element's name to its
 *  skipped list — a fidelity loss, never an SVG-mandated degeneracy.
 *
 *  `alphaPattern` is the grayscale twin of `pattern`, non-null exactly when the
 *  stops carry DIFFERING alphas: a uniform one folds into /ca + /CA instead. It
 *  is what the caller paints into a luminosity /SMask group. Its /Matrix omits
 *  the element CTM, because that group's space IS element user space. */
export type GradientPaint =
  | { kind: 'pattern'; pattern: PdfDict; alphaPattern: PdfDict | null;
      opacity: number; report: boolean }
  | { kind: 'solid'; color: Rgb; opacity: number; report: boolean }
  | { kind: 'none'; report: boolean };

/** How a length attribute resolves: against the viewport width, height, or
 *  SVG's normalized diagonal. */
type Axis = 'x' | 'y' | 'd';

/** SVG's normalized diagonal, which a percentage `r` resolves against. */
const diagonal = (vp: ViewBox): number => Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2);

/** One gradient coordinate. Under objectBoundingBox a percentage is simply the
 *  fraction and a plain number is already one. Under userSpaceOnUse a percentage
 *  resolves against the viewport and a plain number is a user-space length. */
function coord(v: string | undefined, dflt: number, obb: boolean, axis: Axis,
               vp: ViewBox): number {
  if (v === undefined) return dflt;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return dflt;
  if (!t.endsWith('%')) return n;
  const f = n / 100;
  if (obb) return f;
  return f * (axis === 'x' ? vp.w : axis === 'y' ? vp.h : diagonal(vp));
}

/** The objectBoundingBox coordinate system: equivalent to
 *  translate(bx, by) scale(bw, bh). Identity under userSpaceOnUse. */
function bboxMatrix(obb: boolean, bbox: SegBBox | null): Matrix {
  return obb && bbox ? [bbox.w, 0, 0, bbox.h, bbox.x, bbox.y] : [...IDENTITY];
}

/** The pattern /Matrix: gradient space -> the Form XObject's default space.
 *  gradientTransform applies INSIDE the objectBoundingBox coordinate system, so
 *  it is the leftmost (first-applied) factor. Swapping the first two makes a
 *  rotated gradient rotate about the wrong origin — visible only on a non-square
 *  bbox, which is why the tests use one. */
function patternMatrix(gt: Matrix, obb: boolean, bbox: SegBBox | null, ctm: Matrix): Matrix {
  return mul(mul(gt, bboxMatrix(obb, bbox)), ctm);
}

/** Assemble the pattern dict around a shading dict. */
function patternOf(
  shadingEntries: [string, PdfObject][], matrix: Matrix, cs = 'DeviceRGB',
): PdfDict {
  return dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Matrix', [...matrix]],
    ['Shading', dict([
      ['ColorSpace', name(cs)],
      ...shadingEntries,
      ['Extend', [true, true]],
    ])],
  ]);
}

/** Map one gradient element onto a paint for one shape.
 *
 *  `bbox` is the shape's TIGHT geometry box in its own user space, stroke
 *  excluded (SVG's own rule); `viewport` resolves percentages under
 *  userSpaceOnUse; `ctm` is the walker's accumulated matrix at that shape. */
export function gradientPaint(
  node: XmlNode, ids: Map<string, XmlNode>,
  bbox: SegBBox | null, viewport: ViewBox, ctm: Matrix, css?: CssMap,
): GradientPaint {
  const g = resolveGradient(node, ids, css);
  if (g.stops.length === 0) return { kind: 'none', report: false };

  const alpha = uniformOpacity(g.stops);
  const opacity = alpha ?? 1;
  const last = g.stops[g.stops.length - 1];

  // Every solid outcome below is exact, INCLUDING its alpha: it paints one
  // stop's colour, so it takes that stop's own opacity. Using `opacity` here
  // would silently paint a varying ramp's degenerate case fully opaque.
  if (g.stops.length === 1)
    return {
      kind: 'solid', color: g.stops[0].color, opacity: stopOpacity(g.stops[0]), report: false,
    };

  const obb = (g.attrs.get('gradientUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  // objectBoundingBox cannot position a gradient on a box with no area: SVG says
  // the element is not rendered by that paint. Its other paint still applies.
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0)))
    return { kind: 'none', report: false };

  const gt = parseTransform(g.attrs.get('gradientTransform'));
  const matrix = patternMatrix(gt, obb, bbox, ctm);
  // The mask group has an identity /Matrix and is rendered under the CTM that
  // was in force when its `gs` ran — the element CTM. So its pattern space is
  // element user space and the CTM factor must NOT appear here. The same
  // cancellation spreadRange relies on.
  const alphaMatrix = patternMatrix(gt, obb, bbox, [...IDENTITY]);
  const stops = normalizeStops(g.stops);

  /** The colour pattern plus, when the ramp varies, its grayscale twin. */
  const pair = (entries: [string, PdfObject][], fnStops: GradientStop[]) => ({
    pattern: patternOf([...entries, ['Function', stopsFunction(fnStops)]], matrix),
    alphaPattern: alpha !== null ? null
      : patternOf([...entries, ['Function', stopsFunction(fnStops, ALPHA)]],
                  alphaMatrix, 'DeviceGray'),
  });

  if (g.kind === 'radial') {
    const cx = coord(g.attrs.get('cx'), obb ? 0.5 : 0.5 * viewport.w, obb, 'x', viewport);
    const cy = coord(g.attrs.get('cy'), obb ? 0.5 : 0.5 * viewport.h, obb, 'y', viewport);
    const r = coord(g.attrs.get('r'), obb ? 0.5 : 0.5 * diagonal(viewport), obb, 'd', viewport);
    if (!(r > 0))
      return { kind: 'solid', color: last.color, opacity: stopOpacity(last), report: false };
    let fx = coord(g.attrs.get('fx'), cx, obb, 'x', viewport);
    let fy = coord(g.attrs.get('fy'), cy, obb, 'y', viewport);
    // SVG 1.1: a focus outside the circle moves onto it. Landing exactly on the
    // edge makes PDF's cone degenerate, so stop just inside — the same 0.1%
    // inset other renderers use.
    const d = Math.hypot(fx - cx, fy - cy);
    if (d > r) {
      const k = (r * 0.999) / d;
      fx = cx + (fx - cx) * k;
      fy = cy + (fy - cy) * k;
    }
    // Everything below runs AFTER that clamp, which is what guarantees |d| < r
    // and so makes the range math valid.
    const spread = g.attrs.get('spreadMethod');
    let coords = [fx, fy, 0, cx, cy, r];
    let fnStops = stops;
    if (spread === 'reflect' || spread === 'repeat') {
      // PDF interpolates a ShadingType 3's centre AND radius linearly, exactly
      // as SVG's radial model does, so pushing the outer circle out to parameter
      // k and packing k ramp copies into the function IS the tiled gradient —
      // no stitched rings and no tiling pattern. k0 is always 0, because
      // r(t) = t*r is meaningful only for t >= 0.
      const k = radialSpreadRange([fx, fy], [cx, cy], r,
        mul(gt, bboxMatrix(obb, bbox)), bbox);
      if (k !== null) {
        coords = [fx, fy, 0, fx + k * (cx - fx), fy + k * (cy - fy), k * r];
        fnStops = tileStops(stops, 0, k, spread === 'reflect');
      }
      // k === null: over the cap or uncomputable. /Extend [true true] pads, a
      // visible but bounded degradation — the same call the linear path makes.
    }
    return {
      kind: 'pattern',
      ...pair([['ShadingType', 3], ['Coords', coords]], fnStops),
      opacity,
      report: false,
    };
  }

  const x1 = coord(g.attrs.get('x1'), 0, obb, 'x', viewport);
  const y1 = coord(g.attrs.get('y1'), 0, obb, 'y', viewport);
  const x2 = coord(g.attrs.get('x2'), obb ? 1 : viewport.w, obb, 'x', viewport);
  const y2 = coord(g.attrs.get('y2'), 0, obb, 'y', viewport);
  if (x1 === x2 && y1 === y2)
    return { kind: 'solid', color: last.color, opacity: stopOpacity(last), report: false };

  let coords = [x1, y1, x2, y2];
  let fnStops = stops;
  const spread = g.attrs.get('spreadMethod');
  if (spread === 'reflect' || spread === 'repeat') {
    // The pattern matrix WITHOUT the element CTM: the box is in element space,
    // so the CTM cancels out of the projection.
    const range = spreadRange([x1, y1], [x2, y2],
      mul(gt, bboxMatrix(obb, bbox)), bbox);
    if (range) {
      const [k0, k1] = range;
      coords = [
        x1 + k0 * (x2 - x1), y1 + k0 * (y2 - y1),
        x1 + k1 * (x2 - x1), y1 + k1 * (y2 - y1),
      ];
      fnStops = tileStops(stops, k0, k1 - k0, spread === 'reflect');
    }
    // range === null: over the cap or uncomputable. /Extend [true true] pads,
    // which is a visible but bounded degradation and not worth reporting.
  }

  return {
    kind: 'pattern',
    ...pair([['ShadingType', 2], ['Coords', coords]], fnStops),
    opacity,
    report: false,
  };
}

/** The bbox's four corners mapped into gradient space, or null when the box is
 *  absent or `m` is singular.
 *
 *  `m` is mul(gradientTransform, bboxMatrix) — WITHOUT the element CTM. The box
 *  is in element user space and the pattern /Matrix carries the same CTM factor,
 *  so the CTM cancels out of the projection. That cancellation is shared by both
 *  spread ranges, and it is the check that the /Matrix composition is right. */
function gradientSpaceCorners(m: Matrix, bbox: SegBBox | null): [number, number][] | null {
  if (!bbox) return null;
  let inv: Matrix;
  try { inv = invert(m); } catch { return null; }
  return ([
    [bbox.x, bbox.y], [bbox.x + bbox.w, bbox.y],
    [bbox.x, bbox.y + bbox.h], [bbox.x + bbox.w, bbox.y + bbox.h],
  ] as [number, number][]).map(([cx, cy]) => apply(inv, cx, cy));
}

/** The integer repetition range [k0, k1] a linear gradient's axis must span to
 *  cover `bbox`, in gradient space. The corners are projected onto the axis; see
 *  gradientSpaceCorners for why `m` carries no element CTM.
 *
 *  Returns null when the range cannot be computed or exceeds `cap` repetitions,
 *  in which case the caller falls back to pad rather than inflating the stream. */
export function spreadRange(
  p1: [number, number], p2: [number, number], m: Matrix, bbox: SegBBox | null,
  cap = 64,
): [number, number] | null {
  const corners = gradientSpaceCorners(m, bbox);
  if (!corners) return null;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const len2 = dx * dx + dy * dy;
  if (!(len2 > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const [gx, gy] of corners) {
    const t = ((gx - p1[0]) * dx + (gy - p1[1]) * dy) / len2;
    if (!Number.isFinite(t)) return null;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const k0 = Math.floor(lo);
  const k1 = Math.max(Math.ceil(hi), k0 + 1);
  if (k1 - k0 > cap) return null;
  return [k0, k1];
}

/** The number of ramp repetitions `k` a radial gradient needs to cover `bbox`.
 *
 *  Unlike the linear case there is no lower bound to compute: r(t) = t*r is only
 *  meaningful for t >= 0, and SVG's spread applies outward from t = 1, so the
 *  range is always [0, k].
 *
 *  For each corner p, the parameter t whose circle passes through it solves
 *      t^2*(|d|^2 - r^2) - 2t*(d . (p - f)) + |p - f|^2 = 0,   d = c - f
 *  and the expression below is ALWAYS its non-negative root: disc = b^2 - 4ag
 *  is >= b^2 because -4ag >= 0, so sqrt(disc) >= |b| makes the numerator <= 0
 *  while the denominator is < 0. No root selection, and no branch to get wrong.
 *
 *  Four corners suffice: with the focus strictly inside the circle the family
 *  t -> (f + t*d, t*r) is strictly nested and expanding, so t(p)'s level sets are
 *  nested convex curves and the maximum over a convex polygon sits at a vertex.
 *
 *  Returns null when the range cannot be computed or exceeds `cap`, in which case
 *  the caller falls back to pad rather than inflating the stream. */
export function radialSpreadRange(
  f: [number, number], c: [number, number], r: number,
  m: Matrix, bbox: SegBBox | null, cap = 64,
): number | null {
  const corners = gradientSpaceCorners(m, bbox);
  if (!corners || !(r > 0)) return null;
  const dx = c[0] - f[0], dy = c[1] - f[1];
  const a = dx * dx + dy * dy - r * r;
  // The focus must be strictly inside the circle. gradientPaint's 0.999 clamp
  // guarantees it; the guard keeps this function total for any other caller.
  if (!(a < 0)) return null;
  let hi = 0;
  for (const [px, py] of corners) {
    const ex = px - f[0], ey = py - f[1];
    const b = -2 * (dx * ex + dy * ey);
    const g = ex * ex + ey * ey;
    const disc = b * b - 4 * a * g;
    if (!(disc >= 0)) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (!Number.isFinite(t)) return null;
    if (t > hi) hi = t;
  }
  const k = Math.max(1, Math.ceil(hi));
  return k > cap ? null : k;
}

/** n copies of a normalized stop list packed into [0, 1]. Copy i covers the
 *  gradient-space interval [k0+i, k0+i+1] and is mirrored when `reflect` and that
 *  integer is odd — reflect mirrors about every integer boundary and [0, 1] is
 *  forward. The seams produce duplicate offsets, which stopsFunction turns into
 *  the hard edge `repeat` needs and drops as a zero-width interval. */
export function tileStops(
  stops: GradientStop[], k0: number, n: number, reflect: boolean,
): GradientStop[] {
  const odd = (k: number): boolean => (((k % 2) + 2) % 2) === 1;
  if (n <= 1 && !(reflect && odd(k0))) return stops.map((s) => ({ ...s }));
  const out: GradientStop[] = [];
  for (let i = 0; i < n; i++) {
    const src = reflect && odd(k0 + i)
      ? [...stops].reverse().map((s) => ({ ...s, offset: 1 - s.offset }))
      : stops;
    for (const s of src) out.push({ ...s, offset: (i + s.offset) / n });
  }
  return out;
}
