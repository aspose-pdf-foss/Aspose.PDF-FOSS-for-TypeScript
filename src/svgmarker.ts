// SVG markers -> per-vertex Form XObject placements (issue 1gg0.10). Pure
// geometry: vertices and tangent angles from the flattened segment list, and the
// <marker> viewport mapping. Allocates nothing and knows no PDF — mirroring
// svgmask.ts's role for the other referenced definition.
import type { XmlNode } from './xml.js';
import type { SvgSeg, SegBBox } from './svgpath.js';
import { parseViewBox, viewBoxFitDown } from './svgtransform.js';
import { IDENTITY, mul, type Matrix } from './text.js';

/** One marker position: where, which way, and which of the three properties
 *  paints there. `angle` is in RADIANS, in the y-DOWN frame svgdraw.ts emits. */
export interface MarkerVertex {
  x: number;
  y: number;
  angle: number;
  kind: 'start' | 'mid' | 'end';
}

type Pt = [number, number];

const EPS = 1e-9;

/** The direction from `a` to `b` as a unit vector, or null when they coincide. */
function unit(a: Pt, b: Pt): Pt | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len < EPS ? null : [dx / len, dy / len];
}

/** A vertex with the tangents on either side, before kinds are assigned. */
interface Node {
  p: Pt;
  /** Direction arriving at `p`. Null at the very first vertex. */
  in: Pt | null;
  /** Direction leaving `p`. Null at the very last vertex. */
  out: Pt | null;
}

/** The vertices a path visits, with their in/out tangents.
 *
 *  A cubic's tangent comes from its first (or last) NON-DEGENERATE control leg —
 *  p0->p1, else p0->p2, else the chord — because a curve whose first control
 *  point coincides with its start point has no direction there. */
function nodes(segs: SvgSeg[]): Node[] {
  const out: Node[] = [];
  let cur: Pt | null = null;
  let subStart: Pt | null = null;
  let subStartIndex = -1;
  /** Z joins, as (closing vertex, subpath opener). Resolved after the seek
   *  passes below, so a wrap copies the opener's SOUGHT direction rather than
   *  the raw one — which is null when the subpath opens with a degenerate leg. */
  const wraps: [number, number][] = [];

  const push = (p: Pt): number => {
    out.push({ p, in: null, out: null });
    return out.length - 1;
  };
  /** Record a leg from the last vertex to `p`, whose direction leaving the last
   *  vertex is `dOut` and arriving at `p` is `dIn`. */
  const leg = (p: Pt, dOut: Pt | null, dIn: Pt | null): void => {
    const prev = out[out.length - 1];
    if (prev && prev.out === null) prev.out = dOut;
    const i = push(p);
    out[i].in = dIn;
  };

  for (const s of segs) {
    if (s.op === 'M') {
      cur = [s.args[0], s.args[1]];
      subStart = cur;
      subStartIndex = push(cur);
    } else if (s.op === 'L') {
      if (!cur) continue;
      const p: Pt = [s.args[0], s.args[1]];
      const d = unit(cur, p);
      leg(p, d, d);
      cur = p;
    } else if (s.op === 'C') {
      if (!cur) continue;
      const p1: Pt = [s.args[0], s.args[1]];
      const p2: Pt = [s.args[2], s.args[3]];
      const p3: Pt = [s.args[4], s.args[5]];
      const dOut = unit(cur, p1) ?? unit(cur, p2) ?? unit(cur, p3);
      const dIn = unit(p2, p3) ?? unit(p1, p3) ?? unit(cur, p3);
      leg(p3, dOut, dIn);
      cur = p3;
    } else {
      // Z: close back to the subpath start, appending it as a further vertex
      // whose outgoing tangent WRAPS to the subpath's initial direction.
      if (!cur || !subStart) continue;
      const d = unit(cur, subStart);
      leg([...subStart] as Pt, d, d);
      if (subStartIndex >= 0) wraps.push([out.length - 1, subStartIndex]);
      cur = [...subStart] as Pt;
    }
  }

  // A zero-length leg carries no direction, so a vertex beside one has no
  // tangent of its own. Seek through them: a vertex's outgoing tangent is the
  // first non-degenerate direction at or after it, its incoming tangent the last
  // at or before it. Without this an `M 0 0 L 0 0 L 10 10` start vertex reads as
  // angle 0 instead of following the segment that actually goes somewhere.
  for (let i = out.length - 2; i >= 0; i--)
    if (out[i].out === null) out[i].out = out[i + 1].out;
  // Wraps resolve between the two passes: the backward pass has settled every
  // opener's outgoing direction, and it never touches the last vertex, which is
  // the only one a wrap writes.
  for (const [at, from] of wraps) out[at].out = out[from].out;
  for (let i = 1; i < out.length; i++)
    if (out[i].in === null) out[i].in = out[i - 1].in;

  return out;
}

/** The bisector of two unit directions, as an angle in radians.
 *
 *  atan2 of the SUM, never the mean of two angles: averaging is discontinuous
 *  across +-180, which points a marker the wrong way at an obtuse corner. When
 *  the two cancel exactly there is no bisector, so the incoming direction wins. */
function bisect(a: Pt, b: Pt): number {
  const sx = a[0] + b[0], sy = a[1] + b[1];
  if (Math.hypot(sx, sy) < EPS) return Math.atan2(a[1], a[0]);
  return Math.atan2(sy, sx);
}

/** Every marker position on a path, with tangent angles.
 *
 *  `kind` is positional over the WHOLE path, not per subpath: SVG 1.1 §11.6.2
 *  puts marker-start on "the first vertex of the given path element", so a
 *  two-subpath path gets exactly one start and the second subpath's opener is a
 *  mid. */
export function markerVertices(segs: SvgSeg[]): MarkerVertex[] {
  const ns = nodes(segs);
  return ns.map((n, i) => {
    const kind: MarkerVertex['kind'] =
      i === 0 ? 'start' : i === ns.length - 1 ? 'end' : 'mid';
    let angle = 0;
    if (n.in && n.out) angle = bisect(n.in, n.out);
    else if (n.out) angle = Math.atan2(n.out[1], n.out[0]);
    else if (n.in) angle = Math.atan2(n.in[1], n.in[0]);
    return { x: n.p[0], y: n.p[1], angle, kind };
  });
}

/** A resolved <marker>: its viewport, content fit, reference point and orient. */
export interface MarkerSpec {
  w: number;
  h: number;
  /** The viewBox -> viewport fit applied to the content; identity with none. */
  content: Matrix;
  /** The clip rect in the marker's own CONTENT space, or null under
   *  overflow: visible.
   *
   *  Content space, not viewport space, because `content` is composed INSIDE
   *  markerMatrix — the form's own coordinates are pre-fit. With a viewBox the
   *  two differ by the fit's scale, so a viewport rect would clip at the wrong
   *  size; the viewBox itself is the region the viewport shows. */
  clip: SegBBox | null;
  /** refX / refY, already mapped through `content` into viewport space. */
  refX: number;
  refY: number;
  scaleByStroke: boolean;
  /** A fixed angle in RADIANS, or one of the two auto modes. */
  orient: 'auto' | 'auto-start-reverse' | number;
}

const attrNum = (n: XmlNode, k: string, dflt: number): number => {
  const v = n.attrs.get(k);
  if (v === undefined) return dflt;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : dflt;
};

/** Resolve one `<marker>`. Returns null when its viewport has no area, which SVG
 *  treats as "not rendered" rather than as an error. */
export function resolveMarker(node: XmlNode): MarkerSpec | null {
  const w = attrNum(node, 'markerWidth', 3);
  const h = attrNum(node, 'markerHeight', 3);
  if (!(w > 0) || !(h > 0)) return null;

  const vb = parseViewBox(node.attrs.get('viewBox'));
  const content: Matrix = vb
    ? viewBoxFitDown(vb, w, h, node.attrs.get('preserveAspectRatio'))
    : [...IDENTITY];

  // refX/refY are authored in VIEWBOX coordinates, so they ride through the fit
  // -- translation included. Mapping them in viewport units instead offsets
  // every marker by the viewBox origin, scaled.
  const rx = attrNum(node, 'refX', 0);
  const ry = attrNum(node, 'refY', 0);
  const refX = content[0] * rx + content[2] * ry + content[4];
  const refY = content[1] * rx + content[3] * ry + content[5];

  const ov = (node.attrs.get('overflow') ?? '').trim();
  const clip = ov === 'visible' || ov === 'auto'
    ? null
    : vb
      ? { x: vb.minX, y: vb.minY, w: vb.w, h: vb.h }
      : { x: 0, y: 0, w, h };

  const or = (node.attrs.get('orient') ?? '').trim();
  let orient: MarkerSpec['orient'];
  if (or === 'auto') orient = 'auto';
  else if (or === 'auto-start-reverse') orient = 'auto-start-reverse';
  else {
    const a = parseFloat(or);
    orient = Number.isFinite(a) ? (a * Math.PI) / 180 : 0;
  }

  return {
    w, h, content, clip, refX, refY,
    scaleByStroke: (node.attrs.get('markerUnits') ?? 'strokeWidth') !== 'userSpaceOnUse',
    orient,
  };
}

/** The placement for one vertex, composing (in mul's "m followed by n" order):
 *
 *    content -> translate(-ref) -> scale(sw) -> rotate(theta) -> translate(vertex)
 *
 *  The ref translate comes BEFORE the rotation, so the marker turns about its
 *  reference point and that point stays pinned to the vertex at every angle. */
export function markerMatrix(
  spec: MarkerSpec, v: MarkerVertex, strokeWidth: number,
): Matrix {
  let theta: number;
  if (spec.orient === 'auto') theta = v.angle;
  else if (spec.orient === 'auto-start-reverse')
    theta = v.kind === 'start' ? v.angle + Math.PI : v.angle;
  else theta = spec.orient;

  const sw = spec.scaleByStroke ? strokeWidth : 1;
  const c = Math.cos(theta), s = Math.sin(theta);

  let m = mul(spec.content, [1, 0, 0, 1, -spec.refX, -spec.refY]);
  if (sw !== 1) m = mul(m, [sw, 0, 0, sw, 0, 0]);
  m = mul(m, [c, s, -s, c, 0, 0]);
  return mul(m, [1, 0, 0, 1, v.x, v.y]);
}
