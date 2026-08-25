// SVG geometry: transform lists, and the viewBox -> target-rect placement
// matrix that also carries the y-axis flip (issue 1gg0.3). Pure — imports only
// the shared affine helpers from text.ts, which owns the Matrix type.
import { IDENTITY, mul, type Matrix } from './text.js';

const NUMS = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

function numbers(s: string): number[] {
  return (s.match(NUMS) ?? []).map(parseFloat);
}

/** Parse a `transform` attribute into a single matrix.
 *
 *  SVG applies a list left to right as nested coordinate-system changes, so a
 *  point is transformed by the RIGHTMOST function first. `mul(m, n)` is
 *  "m followed by n", so the list folds right to left. Getting this backwards
 *  makes `translate(...) scale(...)` scale its own translation. */
export function parseTransform(s: string | undefined): Matrix {
  if (!s) return [...IDENTITY];
  const fns: Matrix[] = [];
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const a = numbers(m[2]);
    switch (m[1]) {
      case 'translate':
        fns.push([1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
        break;
      case 'scale': {
        const sx = a[0] ?? 1;
        fns.push([sx, 0, 0, a[1] ?? sx, 0, 0]);
        break;
      }
      case 'rotate': {
        const t = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(t), si = Math.sin(t);
        const rot: Matrix = [c, si, -si, c, 0, 0];
        if (a.length >= 3) {
          const [, cx, cy] = a;
          // translate(cx,cy) rotate() translate(-cx,-cy), folded right to left.
          fns.push(mul(mul([1, 0, 0, 1, -cx, -cy], rot), [1, 0, 0, 1, cx, cy]));
        } else fns.push(rot);
        break;
      }
      case 'skewX':
        fns.push([1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        fns.push([1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      case 'matrix':
        if (a.length >= 6) fns.push([a[0], a[1], a[2], a[3], a[4], a[5]]);
        break;
      default:
        break;   // unknown function: ignored, per SVG error handling
    }
  }
  let out: Matrix = [...IDENTITY];
  for (let i = fns.length - 1; i >= 0; i--) out = mul(out, fns[i]);
  return out;
}

/** A parsed `viewBox`. */
export interface ViewBox {
  minX: number;
  minY: number;
  w: number;
  h: number;
}

/** Parse a `viewBox`. Returns undefined when malformed or non-positive, so the
 *  caller can fall back to width/height and then to the target rect. */
export function parseViewBox(s: string | undefined): ViewBox | undefined {
  if (!s) return undefined;
  const a = numbers(s);
  if (a.length < 4) return undefined;
  const [minX, minY, w, h] = a;
  if (!(w > 0) || !(h > 0)) return undefined;
  return { minX, minY, w, h };
}

/** Resolve one length under SVG's two unit systems. Under objectBoundingBox a
 *  bare number is already a fraction of the box and a percentage becomes one;
 *  under userSpaceOnUse a percentage resolves against `span`.
 *
 *  Shared by <pattern> and <mask>, which take the identical rule for their
 *  x/y/width/height. svggradient.ts keeps its own: that one resolves gradient
 *  COORDINATES against a different rule, and merging them would mean a
 *  parameter with one caller per value. */
export function unitLength(
  v: string | undefined, dflt: number, obb: boolean, span: number,
): number {
  if (v === undefined) return dflt;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return dflt;
  if (t.endsWith('%')) return obb ? n / 100 : (n / 100) * span;
  return n;
}

/** The align fraction for one axis: 0 for Min, 0.5 for Mid, 1 for Max. */
function frac(align: string, axis: 'x' | 'Y'): number {
  const i = align.indexOf(axis);
  if (i < 0) return 0.5;
  const kind = align.slice(i + 1, i + 4);
  return kind === 'Min' ? 0 : kind === 'Max' ? 1 : 0.5;
}

/** How a source box maps onto a destination box under a preserveAspectRatio.
 *  `tx`/`ty` are offsets from the destination's top-left, `ty` measured DOWNWARD
 *  — the frame svgdraw.ts emits in, and the one placementMatrix composes its
 *  flip with. */
export interface BoxFit { sx: number; sy: number; tx: number; ty: number }

/** Fit `src` into `dest` under `par` (a preserveAspectRatio value) unless `fit`
 *  overrides it. Shared by the root placement below and <image> in svgimage.ts,
 *  so the two cannot drift; it carries no flip, which is placementMatrix's alone. */
export function fitBox(
  src: { w: number; h: number }, dest: { w: number; h: number },
  par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
): BoxFit {
  let align = 'xMidYMid';
  let slice = false;
  if (par) {
    const t = par.trim().split(/\s+/);
    const a = t[0] === 'defer' ? t[1] : t[0];
    if (a) align = a;
    slice = t[t.length - 1] === 'slice';
  }
  if (fit === 'fill') align = 'none';
  else if (fit === 'meet') { align = 'xMidYMid'; slice = false; }
  else if (fit === 'slice') { align = 'xMidYMid'; slice = true; }

  let sx = dest.w / src.w, sy = dest.h / src.h;
  if (align !== 'none') {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s; sy = s;
  }
  const tx = align === 'none' ? 0 : frac(align, 'x') * (dest.w - src.w * sx);
  const ty = align === 'none' ? 0 : frac(align, 'Y') * (dest.h - src.h * sy);
  return { sx, sy, tx, ty };
}

/** Map `vb` onto `rect` = [x, y, w, h], honouring `par` (a preserveAspectRatio
 *  value) unless `fit` overrides it, and flipping the y axis on the way.
 *
 *  Content is emitted in raw viewBox units with y pointing DOWN; this matrix is
 *  the only place that becomes PDF's y-up. */
export function placementMatrix(
  vb: ViewBox, rect: [number, number, number, number],
  par: string | undefined, fit?: 'meet' | 'slice' | 'fill',
): Matrix {
  const [rx, ry, rw, rh] = rect;
  const { sx, sy, tx, ty } = fitBox({ w: vb.w, h: vb.h }, { w: rw, h: rh }, par, fit);
  // ty is measured DOWNWARD from the rect's top edge, which is what lets it
  // compose with the flip below.
  return [sx, 0, 0, -sy, rx + tx - vb.minX * sx, ry + rh - ty + vb.minY * sy];
}

/** Map `vb` into a `w` x `h` box at the origin, in the y-DOWN frame svgdraw.ts
 *  emits in — the same fit as placementMatrix, without its y flip.
 *
 *  <pattern> tiles and <marker> viewports both need this. It is derived from
 *  fitBox directly rather than by negating placementMatrix, because `ty` is
 *  already measured downward: the mapping is simply
 *  x -> sx*(x - minX) + tx, y -> sy*(y - minY) + ty. */
export function viewBoxFitDown(
  vb: ViewBox, w: number, h: number, par: string | undefined,
): Matrix {
  const { sx, sy, tx, ty } = fitBox({ w: vb.w, h: vb.h }, { w, h }, par, undefined);
  return [sx, 0, 0, sy, tx - vb.minX * sx, ty - vb.minY * sy];
}
