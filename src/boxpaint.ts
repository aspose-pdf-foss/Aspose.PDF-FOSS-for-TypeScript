// src/boxpaint.ts
/** Box painting geometry (v9j3.4): radii, rounded paths, border wedges, and —
 *  below — the background layer's tile layout and gradient geometry.
 *
 *  **Invariant:** a pure LEAF importing NOTHING, so every rule is testable from
 *  numbers — the split floatstack.ts, cloudborder.ts and linebox.ts make. Both
 *  painters (cssframe.ts per slice, floatbox.ts whole) read it, so a FloatingBox
 *  and an HTML box cannot disagree about a corner.
 *
 *  **Invariant:** every length is POINTS and every rect is PDF space, `y` its
 *  BOTTOM. Background layout alone works top-down (CSS's own frame), and says
 *  so where it does. */

/** A length: `abs` points plus `frac` of a basis. A CSS percentage is a frac. */
export interface Len { abs: number; frac: number }
export interface Corner { rx: number; ry: number }
/** Top-left, top-right, bottom-right, bottom-left — CSS's order. */
export type Radii = [Corner, Corner, Corner, Corner];
export interface CornerSpec { x: Len; y: Len }
export interface Widths { top: number; right: number; bottom: number; left: number }
export type Seg = ['m', number, number] | ['l', number, number]
  | ['c', number, number, number, number, number, number] | ['h'];

const Z: Corner = { rx: 0, ry: 0 };
export const ZERO_RADII: Radii = [Z, Z, Z, Z];
/** The cubic control offset for a quarter ellipse. */
const K = 0.5522847498307936;

export const lenOf = (l: Len, basis: number): number => l.abs + l.frac * basis;

/** CSS Backgrounds 3 §5.5. Percentages resolve against the border box's
 *  width (rx) and height (ry). A corner with a zero component is square. When
 *  two adjacent radii add to more than their side, EVERY radius is multiplied
 *  by the smallest side factor, so a too-large radius makes a pill rather than
 *  a self-intersecting path. */
export function resolveRadii(spec: readonly CornerSpec[], w: number, h: number): Radii {
  if (spec.length !== 4) return ZERO_RADII;
  const raw = spec.map((c): Corner => {
    const rx = Math.max(0, lenOf(c.x, w)), ry = Math.max(0, lenOf(c.y, h));
    return rx > 0 && ry > 0 ? { rx, ry } : Z;
  });
  return fitRadii(raw as Radii, w, h);
}

/** CSS Backgrounds 3 §5.5's overlap rule: corners that would overlap scale
 *  down TOGETHER, by the smallest side's factor, so a radius larger than its
 *  box is a pill rather than a self-intersecting path. */
export function fitRadii(r: Radii, w: number, h: number): Radii {
  const [tl, tr, br, bl] = r;
  const f = Math.min(
    tl.rx + tr.rx > 0 ? w / (tl.rx + tr.rx) : Infinity,
    bl.rx + br.rx > 0 ? w / (bl.rx + br.rx) : Infinity,
    tl.ry + bl.ry > 0 ? h / (tl.ry + bl.ry) : Infinity,
    tr.ry + br.ry > 0 ? h / (tr.ry + br.ry) : Infinity,
  );
  if (!(f < 1)) return [tl, tr, br, bl];
  return r.map((c) => (c.rx > 0 && c.ry > 0 ? { rx: c.rx * f, ry: c.ry * f } : Z)) as Radii;
}

export const hasRadius = (r: Radii): boolean => r.some((c) => c.rx > 0 && c.ry > 0);

/** CSS `box-decoration-break: slice`: a slice rounds only the corners it
 *  really has — the top pair on the box's first slice, the bottom pair on its
 *  last. */
export function sliceRadii(r: Radii, first: boolean, last: boolean): Radii {
  return [first ? r[0] : Z, first ? r[1] : Z, last ? r[2] : Z, last ? r[3] : Z];
}

/** The padding box's radii: each outer radius less the adjoining border
 *  widths, floored at 0 (CSS Backgrounds 3 §5.2). */
export function innerRadii(r: Radii, b: Widths, w?: number, h?: number): Radii {
  const c = (o: Corner, bx: number, by: number): Corner => {
    const rx = Math.max(0, o.rx - bx), ry = Math.max(0, o.ry - by);
    return rx > 0 && ry > 0 ? { rx, ry } : Z;
  };
  const inner: Radii = [c(r[0], b.left, b.top), c(r[1], b.right, b.top), c(r[2], b.right, b.bottom), c(r[3], b.left, b.bottom)];
  // (v9j3.4 Fixed) Given the box, the inner path is a rounded rect of its
  // own and fits its own box: outer radius less border can exceed the INNER
  // side — a 44pt corner less a 2pt right border in a 27pt-wide padding box
  // — and drawn as written the inner path self-intersects.
  if (w === undefined || h === undefined) return inner;
  return fitRadii(inner, Math.max(0, w - b.left - b.right), Math.max(0, h - b.top - b.bottom));
}

/** A clockwise rounded rect, starting on the top edge after the top-left
 *  corner. A square corner is a plain vertex. */
export function roundedRect(x: number, y: number, w: number, h: number, r: Radii): Seg[] {
  const [tl, tr, br, bl] = r;
  const x1 = x + w, y1 = y + h;
  const s: Seg[] = [['m', x + tl.rx, y1], ['l', x1 - tr.rx, y1]];
  if (tr.rx > 0) s.push(['c', x1 - tr.rx + K * tr.rx, y1, x1, y1 - tr.ry + K * tr.ry, x1, y1 - tr.ry]);
  s.push(['l', x1, y + br.ry]);
  if (br.rx > 0) s.push(['c', x1, y + br.ry - K * br.ry, x1 - br.rx + K * br.rx, y, x1 - br.rx, y]);
  s.push(['l', x + bl.rx, y]);
  if (bl.rx > 0) s.push(['c', x + bl.rx - K * bl.rx, y, x, y + bl.ry - K * bl.ry, x, y + bl.ry]);
  s.push(['l', x, y1 - tl.ry]);
  if (tl.rx > 0) s.push(['c', x, y1 - tl.ry + K * tl.ry, x + tl.rx - K * tl.rx, y1, x + tl.rx, y1]);
  if (s[s.length - 1][0] === 'l' && tl.rx === 0) s.pop();           // back at the start vertex
  s.push(['h']);
  return s;
}

/** Content-stream operators for `segs`; `fmt` is the caller's number writer
 *  (pagecontent.ts's `num`), injected so this module stays a leaf. */
export function pathOps(segs: Seg[], fmt: (n: number) => string): string {
  let out = '';
  for (const s of segs) {
    if (s[0] === 'h') out += 'h\n';
    else out += `${s.slice(1).map((n) => fmt(n as number)).join(' ')} ${s[0]}\n`;
  }
  return out;
}

/** Each edge's share of the border, as a quad from its two OUTER corners
 *  through the two INNER (padding-box) corners — the diagonal colour join
 *  Chrome draws. Used as a clip when edges differ in colour.
 *
 *  (v9j3.4 Fixed) Rounded, the ring at a corner reaches INSIDE the inner
 *  rectangle — the inner arc curves away from its corner — so a join that
 *  stops at the inner rectangle corner leaves that part of the ring in no
 *  wedge, and it was never painted. Given the INNER radii, each join runs on
 *  along its own diagonal to where it meets the INNER ROUNDED PATH. That is
 *  exact, not a bound: the padding box is convex, so the quad of the four
 *  meeting points lies inside it, and adjacent inner radii sum to at most the
 *  inner side, so the meeting points stay in order and the four wedges tile
 *  the ring. A capped extension it replaced left up to 1.1% of an asymmetric
 *  ring unpainted (final review). With no inner radius the join ends at the
 *  inner rectangle corner, so square corners are the old quads exactly. */
export function edgeWedges(x: number, y: number, w: number, h: number, b: Widths, inner: Radii = ZERO_RADII):
  Record<keyof Widths, [number, number][]> {
  const x1 = x + w, y1 = y + h;
  const ix0 = x + b.left, ix1 = x1 - b.right, iy0 = y + b.bottom, iy1 = y1 - b.top;
  const [tl, tr, br, bl] = inner;
  // From the inner rectangle corner (ix, iy), along the outer-to-inner
  // diagonal d = (dx, dy), to the inner arc: the quarter ellipse of radii c
  // centred `sx * rx`, `sy * ry` from the corner. The corner is on the
  // ellipse's bounding box corner, so the nearer root is the meeting point.
  const meet = (ix: number, iy: number, dx: number, dy: number, sx: number, sy: number, c: Corner): [number, number] => {
    if (!(c.rx > 0 && c.ry > 0) || (dx === 0 && dy === 0)) return [ix, iy];
    const u = -sx, v = -sy;                                     // corner, in unit-ellipse coordinates
    const du = dx / c.rx, dv = dy / c.ry;
    const A = du * du + dv * dv, B = 2 * (u * du + v * dv), C = u * u + v * v - 1;
    const disc = B * B - 4 * A * C;
    const t = disc > 0 ? (-B - Math.sqrt(disc)) / (2 * A) : -B / (2 * A);
    return t > 0 ? [ix + t * dx, iy + t * dy] : [ix, iy];
  };
  const pTL = meet(ix0, iy1, b.left, -b.top, 1, -1, tl), pTR = meet(ix1, iy1, -b.right, -b.top, -1, -1, tr);
  const pBR = meet(ix1, iy0, -b.right, b.bottom, -1, 1, br), pBL = meet(ix0, iy0, b.left, b.bottom, 1, 1, bl);
  return {
    top: [[x, y1], [x1, y1], pTR, pTL],
    right: [[x1, y1], [x1, y], pBR, pTR],
    bottom: [[x1, y], [x, y], pBL, pBR],
    left: [[x, y], [x, y1], pTL, pBL],
  };
}

// ---- background layer (CSS Backgrounds 3) — TOP-DOWN, from the area's top-left ----

export type BgSize = 'cover' | 'contain' | [Len | 'auto', Len | 'auto'];
export interface BgLayer { size: BgSize; posX: Len; posY: Len; repeatX: boolean; repeatY: boolean }

/** §3.9. `natural` absent means the image has no intrinsic size (a gradient):
 *  an `auto` dimension is then the area's. One `auto` beside a length keeps
 *  the natural aspect ratio. */
export function tileSize(size: BgSize, aw: number, ah: number, natural?: { w: number; h: number }): { w: number; h: number } {
  if (size === 'cover' || size === 'contain') {
    if (natural === undefined || !(natural.w > 0) || !(natural.h > 0)) return { w: aw, h: ah };
    const k = (size === 'cover' ? Math.max : Math.min)(aw / natural.w, ah / natural.h);
    return { w: natural.w * k, h: natural.h * k };
  }
  const [sx, sy] = size;
  const w = sx === 'auto' ? undefined : lenOf(sx, aw);
  const h = sy === 'auto' ? undefined : lenOf(sy, ah);
  if (natural === undefined) return { w: w ?? aw, h: h ?? ah };
  if (w !== undefined && h !== undefined) return { w, h };
  if (w !== undefined) return { w, h: natural.w > 0 ? w * natural.h / natural.w : natural.h };
  if (h !== undefined) return { w: natural.h > 0 ? h * natural.w / natural.h : natural.w, h };
  return { w: natural.w, h: natural.h };
}

/** A percentage places the tile's p point on the area's p point, so the frac
 *  of a position applies to (area − tile). */
export function tileOrigin(l: BgLayer, aw: number, ah: number, tw: number, th: number): { x: number; y: number } {
  return { x: lenOf(l.posX, aw - tw), y: lenOf(l.posY, ah - th) };
}

// ---- gradients (CSS Images 3) — box-local, TOP-DOWN ----

const DEG = Math.PI / 180;

/** `to <side-or-corner>` as a CSS angle (0 = up, clockwise). A corner keyword
 *  depends on the box's aspect: the 50% line joins the two other corners. */
export function cornerAngle(sx: -1 | 1 | 0, sy: -1 | 1 | 0, w: number, h: number): number {
  if (sx === 0) return sy < 0 ? 0 : 180;
  if (sy === 0) return sx > 0 ? 90 : 270;
  const a = Math.atan2(sx * h, -sy * w) / DEG;
  return a < 0 ? a + 360 : a;
}

/** The gradient line through the box centre, of length |w sin a| + |h cos a|,
 *  from the start (0%) to the end (100%). */
export function linearLine(angleDeg: number, w: number, h: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = angleDeg * DEG;
  const sin = Math.sin(a), cos = Math.cos(a);
  const half = (Math.abs(w * sin) + Math.abs(h * cos)) / 2;
  const cx = w / 2, cy = h / 2;
  const clean = (n: number): number => (Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) + 0 : n);   // + 0: never -0
  return {
    x1: clean(cx - sin * half), y1: clean(cy + cos * half),
    x2: clean(cx + sin * half), y2: clean(cy - cos * half),
  };
}

export type RadialExtent = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | { rx: Len; ry: Len };

/** The ending shape's radii. A corner extent for an ELLIPSE keeps the aspect
 *  the matching side extent would have and passes through that corner. */
export function radialRadii(shape: 'circle' | 'ellipse', e: RadialExtent, cx: number, cy: number, w: number, h: number): { rx: number; ry: number } {
  if (typeof e === 'object') {
    const rx = Math.max(0, lenOf(e.rx, w));
    return shape === 'circle' ? { rx, ry: rx } : { rx, ry: Math.max(0, lenOf(e.ry, h)) };
  }
  const dx = [Math.abs(cx), Math.abs(w - cx)], dy = [Math.abs(cy), Math.abs(h - cy)];
  const closest = e.startsWith('closest');
  const pick = closest ? Math.min : Math.max;
  if (e.endsWith('side')) {
    if (shape === 'circle') { const r = pick(...dx, ...dy); return { rx: r, ry: r }; }
    return { rx: pick(...dx), ry: pick(...dy) };
  }
  // corner
  const corners = dx.flatMap((x) => dy.map((y) => [x, y] as const));
  const dist = corners.map(([x, y]) => Math.hypot(x, y));
  const i = dist.indexOf(pick(...dist));
  if (shape === 'circle') return { rx: dist[i], ry: dist[i] };
  const sx = pick(...dx), sy = pick(...dy);
  if (!(sx > 0) || !(sy > 0)) return { rx: 0, ry: 0 };
  const k = sy / sx, [x, y] = corners[i];
  const rx = Math.sqrt(x * x + (y * y) / (k * k));
  return { rx, ry: rx * k };
}

export interface StopSpec { color: [number, number, number]; alpha: number; pos?: Len }
export interface PlacedStop { t: number; color: [number, number, number]; alpha: number }

/** CSS Images 3 §3.4.3: an unpositioned first stop is 0 and last is 1; a
 *  position behind an earlier one is clamped up to it; runs of unpositioned
 *  stops spread evenly between their positioned neighbours. Positions may
 *  fall outside 0..1. */
export function placeStops(stops: readonly StopSpec[], length: number): PlacedStop[] {
  const t: (number | undefined)[] = stops.map((s) => (s.pos === undefined ? undefined : lenOf(s.pos, length) / (length || 1)));
  if (t.length > 0 && t[0] === undefined) t[0] = 0;
  if (t.length > 1 && t[t.length - 1] === undefined) t[t.length - 1] = 1;
  let max = -Infinity;
  for (let i = 0; i < t.length; i++) if (t[i] !== undefined) { max = Math.max(max, t[i]!); t[i] = max; }
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== undefined) continue;
    let j = i; while (t[j] === undefined) j++;
    const a = t[i - 1]!, b = t[j]!;
    for (let k = i; k < j; k++) t[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s, i) => ({ t: t[i]!, color: s.color, alpha: s.alpha }));
}

/** Renormalize to 0..1 for a PDF function, returning where on the CSS line
 *  the new 0 and 1 fall — the line is extended rather than colours clamped. */
export function fitStops(s: PlacedStop[]): { t0: number; t1: number; stops: { offset: number; color: [number, number, number]; opacity: number }[] } {
  const t0 = Math.min(0, s[0]?.t ?? 0), t1 = Math.max(1, s[s.length - 1]?.t ?? 1);
  const span = t1 - t0 || 1;
  return { t0, t1, stops: s.map((x) => ({ offset: (x.t - t0) / span, color: x.color, opacity: x.alpha })) };
}

/** CSS interpolates gradient colours PREMULTIPLIED (CSS Images 4 §3.4.3), so a
 *  stop that is fully transparent has no colour of its own: `red, transparent`
 *  fades red rather than darkening toward transparent's black. A PDF function
 *  interpolates colour and alpha separately, which matches premultiplied
 *  interpolation exactly when the transparent stop takes its neighbour's
 *  colour — split into two coincident stops when it has a neighbour on each
 *  side. A PARTIALLY transparent stop is left alone: separate interpolation
 *  is an approximation there, recorded rather than chased. */
export function premultiplyTransparent(s: PlacedStop[]): PlacedStop[] {
  const out: PlacedStop[] = [];
  s.forEach((x, i) => {
    if (x.alpha !== 0) { out.push(x); return; }
    const prev = s[i - 1], next = s[i + 1];
    if (prev !== undefined) out.push({ t: x.t, color: prev.color, alpha: 0 });
    if (next !== undefined) out.push({ t: x.t, color: next.color, alpha: 0 });
    if (prev === undefined && next === undefined) out.push(x);
  });
  return out;
}

/** A radial ramp starts at its centre, so a stop placed BEFORE it (a negative
 *  position) cannot be drawn: the colour at the centre is what the CSS line
 *  holds at 0 — INTERPOLATED between the stops either side — and everything
 *  before it is dropped (v9j3.4 final review). Clamping the stops to 0
 *  instead painted the first stop's colour at the centre. */
export function clipStopsAtZero(s: PlacedStop[]): PlacedStop[] {
  const i = s.findIndex((x) => x.t >= 0);
  if (i === 0) return s;
  if (i < 0) { const last = s[s.length - 1]; return last === undefined ? s : [{ ...last, t: 0 }]; }
  const a = s[i - 1], b = s[i];
  const k = b.t - a.t > 0 ? (0 - a.t) / (b.t - a.t) : 1;
  const mix = (p: number, q: number): number => p + (q - p) * k;
  const at0: PlacedStop = {
    t: 0, alpha: mix(a.alpha, b.alpha),
    color: [mix(a.color[0], b.color[0]), mix(a.color[1], b.color[1]), mix(a.color[2], b.color[2])],
  };
  return b.t === 0 ? s.slice(i) : [at0, ...s.slice(i)];
}
