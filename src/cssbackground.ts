/** CSS backgrounds and corner radii (v9j3.4): the grammar of the nine new
 *  longhands and the splitting the three shorthands need.
 *
 *  **Invariant:** a PURE LEAF over cssvalue.js and the parser's token types —
 *  no Document, no PDF object, no `node:` import — and it never throws. A
 *  value its grammar refuses is `undefined`, which the cascade reports as an
 *  `unparsable-value`; that is how everything out of scope is reported
 *  (multiple layers, `repeating-*` and `conic` gradients, colour hints,
 *  `space`/`round`, `fixed`, a box keyword in the shorthand).
 *
 *  **Invariant:** lengths stay CSS px in the computed value, as every other
 *  length here does. The × 0.75 to points crosses in cssflow.ts alone. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import {
  trimWs, keywordOf, lengthOf, colorOf, type LengthPct, type LengthContext, type Color,
} from './cssvalue.js';

export type RadiusValue = [LengthPct, LengthPct];
export interface CssStop { color: Color; pos?: LengthPct }
export type RadialExtentKeyword = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner';
export type BgImageValue =
  | { kind: 'none' }
  | { kind: 'url'; url: string }
  | { kind: 'linear'; angle?: number; to?: [-1 | 0 | 1, -1 | 0 | 1]; stops: CssStop[] }
  | { kind: 'radial'; shape: 'circle' | 'ellipse'; extent: RadialExtentKeyword | [LengthPct, LengthPct];
      at: [LengthPct, LengthPct]; stops: CssStop[] };
export type BgSizeValue = 'cover' | 'contain' | [LengthPct | 'auto', LengthPct | 'auto'];
export type BgRepeatValue = ['repeat' | 'no-repeat', 'repeat' | 'no-repeat'];

const INITIAL: CssValue[] = [{ kind: 'ident', value: 'initial' } as CssToken];
const WS: CssValue = { kind: 'whitespace' } as CssToken;
const ident = (value: string): CssValue => ({ kind: 'ident', value } as CssToken);
const CENTER: CssValue[] = [ident('center')];
const EXTENTS = new Set(['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner']);

const isWs = (x: CssValue): boolean => (x as CssToken).kind === 'whitespace';
const isComma = (x: CssValue): boolean => (x as CssToken).kind === 'comma';
const isSlash = (x: CssValue): boolean => (x as CssToken).kind === 'delim' && (x as { value: string }).value === '/';

/** Whitespace-separated parts; a comma or a `/` is a part of its own. */
function parts(v: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [];
  for (const x of v) {
    if (isWs(x)) continue;
    out.push([x]);
  }
  return out;
}

/** Split at top-level commas. */
function commaGroups(v: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [[]];
  for (const x of v) {
    if (isComma(x)) out.push([]);
    else out[out.length - 1].push(x);
  }
  return out.map(trimWs);
}

const join = (ps: CssValue[][]): CssValue[] => ps.flatMap((p, i) => (i === 0 ? p : [WS, ...p]));
const kw = (p: CssValue[] | undefined): string | undefined => (p === undefined ? undefined : keywordOf(p));
const nonNeg = (l: LengthPct): boolean => 'expr' in l || (l.px >= 0 && l.pct >= 0);

// ---- radius ------------------------------------------------------------------

/** `<length-percentage>{1,2}`, non-negative; one value means both axes. */
export function computeRadius(v: CssValue[], c: LengthContext): RadiusValue | undefined {
  const p = parts(trimWs(v));
  if (p.length < 1 || p.length > 2) return undefined;
  const ls = p.map((x) => lengthOf(x, c));
  if (ls.some((l) => l === undefined || !nonNeg(l))) return undefined;
  return [ls[0]!, ls[1] ?? ls[0]!];
}

/** The 1-to-4-value box rule, as CSS applies it to corners (tl tr br bl). */
function corners<T>(xs: T[]): [T, T, T, T] | undefined {
  const [a, b, c, d] = xs;
  if (a === undefined || xs.length > 4) return undefined;
  if (b === undefined) return [a, a, a, a];
  if (c === undefined) return [a, b, a, b];
  if (d === undefined) return [a, b, c, b];
  return [a, b, c, d];
}

/** `border-radius`: horizontal radii, an optional `/` and vertical radii.
 *  Each corner's tokens are `h` or `h v`. */
export function splitRadius(p: CssValue[][]): [CssValue[], CssValue[], CssValue[], CssValue[]] | undefined {
  const slash = p.findIndex((x) => x.length === 1 && isSlash(x[0]));
  const h = corners(slash < 0 ? p : p.slice(0, slash));
  const vv = slash < 0 ? undefined : corners(p.slice(slash + 1));
  if (h === undefined || (slash >= 0 && vv === undefined)) return undefined;
  return h.map((x, i) => (vv ? join([x, vv[i]]) : x)) as [CssValue[], CssValue[], CssValue[], CssValue[]];
}

// ---- position ----------------------------------------------------------------

const X_EDGE: Record<string, number> = { left: 0, center: 50, right: 100 };
const Y_EDGE: Record<string, number> = { top: 0, center: 50, bottom: 100 };

/** One axis: a keyword, a length-percentage, or an edge and an offset from it
 *  (`right 10px` is 100% − 10px). */
export function computeBgPosition(axis: 'x' | 'y', v: CssValue[], c: LengthContext): LengthPct | undefined {
  const edges = axis === 'x' ? X_EDGE : Y_EDGE;
  const p = parts(trimWs(v));
  if (p.length === 1) {
    const k = kw(p[0]);
    if (k !== undefined) return k in edges && Object.prototype.hasOwnProperty.call(edges, k) ? { px: 0, pct: edges[k] } : undefined;
    return lengthOf(p[0], c);
  }
  if (p.length === 2) {
    const k = kw(p[0]);
    if (k === undefined || k === 'center' || !Object.prototype.hasOwnProperty.call(edges, k)) return undefined;
    const off = lengthOf(p[1], c);
    if (off === undefined || 'expr' in off) return undefined;
    return edges[k] === 100 ? { px: -off.px, pct: 100 - off.pct } : { px: off.px, pct: off.pct };
  }
  return undefined;
}

const isH = (k: string | undefined): boolean => k === 'left' || k === 'right';
const isV = (k: string | undefined): boolean => k === 'top' || k === 'bottom';

/** `background-position` (and a radial gradient's `at`) to each axis's tokens. */
export function splitPosition(p: CssValue[][]): [CssValue[], CssValue[]] | undefined {
  if (p.length === 1) return isV(kw(p[0])) ? [CENTER, p[0]] : [p[0], CENTER];
  if (p.length === 2) {
    const [a, b] = p;
    // `top center`, `center left`, `top left`: a vertical first or a
    // horizontal second means the pair is written y-then-x.
    if (isV(kw(a)) || isH(kw(b))) return [b, a];
    return [a, b];
  }
  if (p.length === 3 || p.length === 4) {
    // Edge-offset pairs: keyword then optional offset, twice.
    const groups: CssValue[][][] = [];
    for (const x of p) {
      const k = kw(x);
      if (k !== undefined) groups.push([x]);
      else if (groups.length > 0 && groups[groups.length - 1].length === 1) groups[groups.length - 1].push(x);
      else return undefined;
    }
    if (groups.length !== 2) return undefined;
    const [g0, g1] = groups;
    const k0 = kw(g0[0]), k1 = kw(g1[0]);
    if ((g0.length === 2 && k0 === 'center') || (g1.length === 2 && k1 === 'center')) return undefined;
    if (isV(k0) || isH(k1)) return [join(g1), join(g0)];
    return [join(g0), join(g1)];
  }
  return undefined;
}

// ---- size and repeat ---------------------------------------------------------

export function computeBgSize(v: CssValue[], c: LengthContext): BgSizeValue | undefined {
  const k = keywordOf(v);
  if (k === 'cover' || k === 'contain') return k;
  const p = parts(trimWs(v));
  if (p.length < 1 || p.length > 2) return undefined;
  const one = (x: CssValue[]): LengthPct | 'auto' | undefined => {
    if (kw(x) === 'auto') return 'auto';
    const l = lengthOf(x, c);
    return l !== undefined && nonNeg(l) ? l : undefined;
  };
  const a = one(p[0]), b = p[1] === undefined ? 'auto' : one(p[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

/** `space` and `round` are refused (out of scope), not approximated. */
export function computeBgRepeat(v: CssValue[]): BgRepeatValue | undefined {
  const k = keywordOf(v);
  if (k === 'repeat-x') return ['repeat', 'no-repeat'];
  if (k === 'repeat-y') return ['no-repeat', 'repeat'];
  const p = parts(trimWs(v)).map(kw);
  if (p.length < 1 || p.length > 2) return undefined;
  if (!p.every((x) => x === 'repeat' || x === 'no-repeat')) return undefined;
  return [p[0] as 'repeat' | 'no-repeat', (p[1] ?? p[0]) as 'repeat' | 'no-repeat'];
}

// ---- images ------------------------------------------------------------------

/** An angle in CSS degrees, normalized to [0, 360). A unitless 0 is 0deg. */
function angleOf(x: CssValue[]): number | undefined {
  const t = trimWs(x);
  if (t.length !== 1) return undefined;
  const tok = t[0] as CssToken;
  let deg: number | undefined;
  if (tok.kind === 'number' && tok.value === 0) deg = 0;
  if (tok.kind === 'dimension') {
    const u = tok.unit.toLowerCase();
    deg = u === 'deg' ? tok.value : u === 'grad' ? tok.value * 0.9 : u === 'rad' ? (tok.value * 180) / Math.PI
      : u === 'turn' ? tok.value * 360 : undefined;
  }
  if (deg === undefined) return undefined;
  return ((deg % 360) + 360) % 360;
}

/** `<color> <lp>? <lp>?`; two positions are two stops of one colour. A lone
 *  position (a colour hint) is refused, as is a list of fewer than two. */
function stopsOf(groups: CssValue[][], c: LengthContext, current: Color): CssStop[] | undefined {
  const out: CssStop[] = [];
  for (const g of groups) {
    const p = parts(g);
    if (p.length < 1 || p.length > 3) return undefined;
    const col = colorOf(p[0]);
    if (col === undefined) return undefined;
    const color = col === 'currentcolor' ? current : col;
    const pos = p.slice(1).map((x) => lengthOf(x, c));
    if (pos.some((l) => l === undefined)) return undefined;
    if (pos.length === 0) out.push({ color });
    else for (const l of pos) out.push({ color, pos: l! });
  }
  return out.length >= 2 ? out : undefined;
}

function linear(args: CssValue[], c: LengthContext, current: Color): BgImageValue | undefined {
  const groups = commaGroups(args);
  const first = parts(groups[0] ?? []);
  if (first.length > 0 && kw(first[0]) === 'to') {
    const ks = first.slice(1).map(kw);
    if (ks.length < 1 || ks.length > 2) return undefined;
    let sx: -1 | 0 | 1 = 0, sy: -1 | 0 | 1 = 0;
    for (const k of ks) {
      if (k === 'left' && sx === 0) sx = -1;
      else if (k === 'right' && sx === 0) sx = 1;
      else if (k === 'top' && sy === 0) sy = -1;
      else if (k === 'bottom' && sy === 0) sy = 1;
      else return undefined;
    }
    const stops = stopsOf(groups.slice(1), c, current);
    return stops && { kind: 'linear', to: [sx, sy], stops };
  }
  const angle = first.length === 1 ? angleOf(first[0]) : undefined;
  const stops = stopsOf(angle === undefined ? groups : groups.slice(1), c, current);
  if (stops === undefined) return undefined;
  return angle === undefined ? { kind: 'linear', stops } : { kind: 'linear', angle, stops };
}

function radial(args: CssValue[], c: LengthContext, current: Color): BgImageValue | undefined {
  const groups = commaGroups(args);
  const p = parts(groups[0] ?? []);
  let shape: 'circle' | 'ellipse' | undefined;
  let extent: RadialExtentKeyword | undefined;
  const sizes: LengthPct[] = [];
  let at: [LengthPct, LengthPct] = [{ px: 0, pct: 50 }, { px: 0, pct: 50 }];
  let prelude = false;
  for (let i = 0; i < p.length; i++) {
    const k = kw(p[i]);
    if (k === 'circle' || k === 'ellipse') { if (shape) return undefined; shape = k; prelude = true; continue; }
    if (k !== undefined && EXTENTS.has(k)) { if (extent) return undefined; extent = k as RadialExtentKeyword; prelude = true; continue; }
    if (k === 'at') {
      const xy = splitPosition(p.slice(i + 1));
      if (xy === undefined) return undefined;
      const x = computeBgPosition('x', xy[0], c), y = computeBgPosition('y', xy[1], c);
      if (x === undefined || y === undefined) return undefined;
      at = [x, y]; prelude = true; break;
    }
    const l = lengthOf(p[i], c);
    if (l !== undefined && i === sizes.length + (shape ? 1 : 0) + (extent ? 1 : 0)) {
      if (!nonNeg(l)) return undefined;
      sizes.push(l); prelude = true; continue;
    }
    if (prelude) return undefined;
    break;                                   // the first group is a colour stop
  }
  if (extent && sizes.length > 0) return undefined;
  if (sizes.length > 2) return undefined;
  const sh: 'circle' | 'ellipse' = shape ?? (sizes.length === 1 ? 'circle' : 'ellipse');
  if (sh === 'circle' && (sizes.length === 2 || (sizes[0] && !('expr' in sizes[0]) && sizes[0].pct !== 0))) return undefined;
  if (sh === 'ellipse' && sizes.length === 1) return undefined;
  const stops = stopsOf(prelude ? groups.slice(1) : groups, c, current);
  if (stops === undefined) return undefined;
  const ext: RadialExtentKeyword | [LengthPct, LengthPct] = sizes.length > 0
    ? [sizes[0], sizes[1] ?? sizes[0]] : extent ?? 'farthest-corner';
  return { kind: 'radial', shape: sh, extent: ext, at, stops };
}

/** One layer: `none`, a `url()`, `linear-gradient()` or `radial-gradient()`. */
export function computeBgImage(v: CssValue[], c: LengthContext, current: Color = { rgb: [0, 0, 0], a: 1 }): BgImageValue | undefined {
  const t = trimWs(v);
  if (keywordOf(t) === 'none') return { kind: 'none' };
  if (t.length !== 1) return undefined;
  const x = t[0];
  if ((x as CssToken).kind === 'url') return { kind: 'url', url: (x as { value: string }).value };
  if (x.kind !== 'function' || !('args' in x)) return undefined;
  const name = x.name.toLowerCase();
  if (name === 'url') {
    const a = trimWs(x.args);
    return a.length === 1 && (a[0] as CssToken).kind === 'string' ? { kind: 'url', url: (a[0] as { value: string }).value } : undefined;
  }
  if (name === 'linear-gradient') return linear(x.args, c, current);
  if (name === 'radial-gradient') return radial(x.args, c, current);
  return undefined;
}

// ---- the background shorthand ------------------------------------------------

const REPEAT_KW = new Set(['repeat', 'no-repeat', 'repeat-x', 'repeat-y']);
const POS_KW = new Set(['left', 'right', 'top', 'bottom', 'center']);

/** `background`: one layer of colour, image, position [/ size], repeat and
 *  `scroll`. Unmentioned longhands are reset (`initial`). Refused: a second
 *  layer, `fixed`/`local`, a box keyword (clip/origin are out of scope). */
export function splitBackground(v: CssValue[]): Record<string, CssValue[]> | undefined {
  const t = trimWs(v);
  if (t.some(isComma)) return undefined;
  const p = parts(t);
  let color: CssValue[] | undefined, image: CssValue[] | undefined;
  const repeat: CssValue[][] = [], pos: CssValue[][] = [], size: CssValue[][] = [];
  let afterSlash = false;
  for (const x of p) {
    if (x.length === 1 && isSlash(x[0])) { if (pos.length === 0 || afterSlash) return undefined; afterSlash = true; continue; }
    const k = kw(x);
    if (afterSlash) {
      if (size.length < 2 && (k === 'auto' || k === 'cover' || k === 'contain' || (k === undefined && lengthOf(x, { fontSize: 16, rootFontSize: 16 }) !== undefined))) {
        size.push(x); continue;
      }
      afterSlash = false;
    }
    if (k === 'scroll') continue;
    if (k === 'fixed' || k === 'local' || k === 'border-box' || k === 'padding-box' || k === 'content-box') return undefined;
    if (k !== undefined && REPEAT_KW.has(k)) { repeat.push(x); continue; }
    if (k !== undefined && POS_KW.has(k)) { pos.push(x); continue; }
    const tok = x[0];
    if (k === 'none' || (tok as CssToken).kind === 'url' || tok.kind === 'function' && /^(url|linear-gradient|radial-gradient|repeating-.*|conic-gradient|image-set|cross-fade)$/i.test(tok.name)) {
      if (image) return undefined;
      image = x; continue;
    }
    if (k === undefined && lengthOf(x, { fontSize: 16, rootFontSize: 16 }) !== undefined) { pos.push(x); continue; }
    if (colorOf(x) !== undefined) { if (color) return undefined; color = x; continue; }
    return undefined;
  }
  if (afterSlash && size.length === 0) return undefined;
  const xy = pos.length > 0 ? splitPosition(pos) : undefined;
  if (pos.length > 0 && xy === undefined) return undefined;
  return {
    'background-color': color ?? INITIAL,
    'background-image': image ?? INITIAL,
    'background-position-x': xy?.[0] ?? INITIAL,
    'background-position-y': xy?.[1] ?? INITIAL,
    'background-size': size.length > 0 ? join(size) : INITIAL,
    'background-repeat': repeat.length > 0 ? join(repeat) : INITIAL,
  };
}
