// The colour-stop model shared by every gradient producer: SVG import
// (svggradient.ts) and PageGraphics authoring (graphics.ts). Pure — it builds
// DIRECT PdfDicts and touches no Document, which is what lets the SVG path go on
// allocating no indirect objects. Direction note: svgrender.ts is PDF->SVG and
// shares nothing with this.
import { name, type PdfDict, type PdfObject } from './types.js';

/** One gradient stop. `offset` is in [0, 1]; `opacity` defaults to 1. */
export interface GradientStop {
  offset: number;
  color: [number, number, number];
  opacity?: number;
}

/** A stop's alpha, defaulting to fully opaque. Every reader must go through
 *  this: `opacity` is optional on the public type but always set by the SVG
 *  parser, and reading the field raw makes an authored stop `undefined`. */
export const stopOpacity = (s: GradientStop): number => s.opacity ?? 1;

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const dict = (entries: [string, PdfObject][]): PdfDict => new Map<string, PdfObject>(entries);

/** Prepare stops for a PDF function: offsets forced non-decreasing, then a stop
 *  added at 0 and at 1 when the list does not already reach them (repeating the
 *  adjacent colour). That makes /Domain [0 1] exact.
 *
 *  Doubled offsets are KEPT — they are what turns into a hard colour edge. The
 *  zero-width interval they create is dropped later, in stopsFunction, which is
 *  also what satisfies PDF's requirement that /Bounds be strictly increasing. */
export function normalizeStops(stops: GradientStop[]): GradientStop[] {
  if (stops.length < 2) return stops.map((s) => ({ ...s }));
  const out = stops.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].offset < out[i - 1].offset) out[i].offset = out[i - 1].offset;
  }
  if (out[0].offset > 0) out.unshift({ ...out[0], offset: 0 });
  const last = out[out.length - 1];
  if (last.offset < 1) out.push({ ...last, offset: 1 });
  return out;
}

/** How a stop projects onto a shading function's output vector. The colour
 *  shading and its grayscale alpha twin differ ONLY in this. */
export type StopPick = (s: GradientStop) => number[];

const RGB: StopPick = (s) => [...s.color];

/** The alpha ramp's projection: one /DeviceGray component, since the luminosity
 *  of a gray value g is g. */
export const ALPHA: StopPick = (s) => [stopOpacity(s)];

/** A type 2 exponential over [0, 1], linear (/N 1) between two colour vectors. */
function rampFunction(c0: number[], c1: number[]): PdfDict {
  return dict([
    ['FunctionType', 2],
    ['Domain', [0, 1]],
    ['C0', [...c0]],
    ['C1', [...c1]],
    ['N', 1],
  ]);
}

/** The function for a normalized stop list, over /Domain [0 1]. `pick` chooses
 *  what each stop contributes: its colour by default, its alpha for the mask's
 *  grayscale twin. Since only the OFFSETS decide the stitching, the two come out
 *  with identical /Bounds and /Encode — which is what makes a mask line up with
 *  the colour it masks.
 *
 *  One positive-width interval -> a bare type 2. More -> a type 3 stitching
 *  function over them. Zero-width intervals (a doubled offset, i.e. a hard colour
 *  edge) contribute NO sub-function, which is exactly what keeps /Bounds strictly
 *  increasing as PDF requires while still producing the edge.
 *
 *  Caller guarantees at least two stops and at least one positive-width interval;
 *  the degenerate cases are decided before this is reached. */
export function stopsFunction(stops: GradientStop[], pick: StopPick = RGB): PdfDict {
  const subs: PdfDict[] = [];
  const bounds: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if (!(stops[i + 1].offset > stops[i].offset)) continue;
    if (subs.length > 0) bounds.push(stops[i].offset);
    subs.push(rampFunction(pick(stops[i]), pick(stops[i + 1])));
  }
  if (subs.length === 1) return subs[0];
  const encode: number[] = [];
  for (let i = 0; i < subs.length; i++) encode.push(0, 1);
  return dict([
    ['FunctionType', 3],
    ['Domain', [0, 1]],
    ['Functions', subs],
    ['Bounds', bounds],
    ['Encode', encode],
  ]);
}

/** Every stop carrying the same alpha, else null. Uniform alpha folds exactly
 *  into /ca + /CA; a varying one needs a luminosity soft mask. */
export function uniformOpacity(stops: GradientStop[]): number | null {
  if (stops.length === 0) return 1;
  const a = stopOpacity(stops[0]);
  return stops.every((s) => Math.abs(stopOpacity(s) - a) < 1e-9) ? a : null;
}

/** An axial (linear) gradient: a colour ramp along the axis from (x1, y1) to
 *  (x2, y2), in the **default** user space of the content stream it paints into
 *  — see the /Matrix note on PageGraphics.setFillGradient. */
export interface LinearGradient {
  kind: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
  /** Whether to pad the ramp before the start and after the end. Default
   *  [true, true]. */
  extend?: [boolean, boolean];
}

/** A radial gradient: the ramp runs from the focal point out to the circle
 *  (cx, cy, r). `fx`/`fy` default to the centre. */
export interface RadialGradient {
  kind: 'radial';
  cx: number;
  cy: number;
  r: number;
  fx?: number;
  fy?: number;
  stops: GradientStop[];
  extend?: [boolean, boolean];
}

export type Gradient = LinearGradient | RadialGradient;

function checkNum(label: string, n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`gradient ${label} must be a finite number`);
  return n;
}

function checkStop(s: GradientStop, i: number): void {
  if (typeof s !== 'object' || s === null)
    throw new TypeError(`gradient stop ${i} must be an object`);
  checkNum(`stop ${i} offset`, s.offset);
  const c = s.color;
  if (!Array.isArray(c) || c.length !== 3 ||
      !c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))
    throw new TypeError(`gradient stop ${i} color must be [r, g, b] with each component in 0..1`);
  if (s.opacity !== undefined &&
      (typeof s.opacity !== 'number' || !Number.isFinite(s.opacity) ||
       s.opacity < 0 || s.opacity > 1))
    throw new TypeError(`gradient stop ${i} opacity must be in 0..1`);
}

function checkExtend(e: [boolean, boolean] | undefined): void {
  if (e === undefined) return;
  if (!Array.isArray(e) || e.length !== 2 || !e.every((v) => typeof v === 'boolean'))
    throw new TypeError('gradient extend must be [boolean, boolean]');
}

/** Validate a gradient completely, throwing TypeError on the first fault.
 *
 *  **Invariant:** this runs to completion before anything is allocated, so a
 *  rejected call leaves the document byte-identical — the same rule
 *  formcreate.ts follows for field creation. */
export function validateGradient(g: Gradient): void {
  if (typeof g !== 'object' || g === null)
    throw new TypeError('gradient must be an object');
  if (g.kind !== 'linear' && g.kind !== 'radial')
    throw new TypeError("gradient kind must be 'linear' or 'radial'");
  if (!Array.isArray(g.stops) || g.stops.length === 0)
    throw new TypeError('gradient stops must be a non-empty array');
  g.stops.forEach(checkStop);
  checkExtend(g.extend);
  if (g.kind === 'linear') {
    checkNum('x1', g.x1); checkNum('y1', g.y1);
    checkNum('x2', g.x2); checkNum('y2', g.y2);
    return;
  }
  checkNum('cx', g.cx); checkNum('cy', g.cy);
  if (checkNum('r', g.r) < 0) throw new TypeError('gradient r must be non-negative');
  if (g.fx !== undefined) checkNum('fx', g.fx);
  if (g.fy !== undefined) checkNum('fy', g.fy);
}

/** Which twin a shading builds: the DeviceRGB colour ramp, or the DeviceGray
 *  luminosity twin that masks it when the stop alphas differ. The two share
 *  every other entry — geometry, /Extend, and the stitching /Bounds — which is
 *  what makes the mask line up with the colour it masks. */
export type ShadingVariant = 'color' | 'alpha';

/** The colour space and stop projection for a variant, in one place so the twins
 *  cannot drift apart. */
function variantOf(v: ShadingVariant): [PdfObject, StopPick] {
  return v === 'alpha' ? [name('DeviceGray'), ALPHA] : [name('DeviceRGB'), RGB];
}

/** A ShadingType 2 over the gradient's axis. `stops` must already be normalized
 *  — the caller does that, because it also needs them for the degenerate-case
 *  decisions and for the alpha twin. */
export function axialShading(
  g: LinearGradient, stops: GradientStop[], variant: ShadingVariant = 'color',
): PdfDict {
  const [cs, pick] = variantOf(variant);
  return dict([
    ['ShadingType', 2],
    ['ColorSpace', cs],
    ['Coords', [g.x1, g.y1, g.x2, g.y2]],
    ['Function', stopsFunction(stops, pick)],
    ['Extend', [...(g.extend ?? [true, true])]],
  ]);
}

/** A ShadingType 3 running from the focal point out to the circle
 *  (cx, cy, r). `stops` must already be normalized, as for {@link axialShading}.
 *
 *  The inner circle is the focus at radius 0 and the outer one is the gradient
 *  circle, which is what makes PDF's two-circle model behave as the single-circle
 *  model SVG and CSS expose.
 *
 *  **Invariant:** the focus must lie strictly INSIDE the circle. A focus outside
 *  it is pulled onto the circle (SVG 1.1 §13.2.4), but landing exactly on the rim
 *  degenerates PDF's cone — the ramp collapses to a point and viewers disagree on
 *  what to paint — so the clamp stops 0.1% short, the inset other renderers use. */
export function radialShading(
  g: RadialGradient, stops: GradientStop[], variant: ShadingVariant = 'color',
): PdfDict {
  const [cs, pick] = variantOf(variant);
  let fx = g.fx ?? g.cx;
  let fy = g.fy ?? g.cy;
  const d = Math.hypot(fx - g.cx, fy - g.cy);
  if (d >= g.r && d > 0) {
    const k = (g.r * 0.999) / d;
    fx = g.cx + (fx - g.cx) * k;
    fy = g.cy + (fy - g.cy) * k;
  }
  return dict([
    ['ShadingType', 3],
    ['ColorSpace', cs],
    ['Coords', [fx, fy, 0, g.cx, g.cy, g.r]],
    ['Function', stopsFunction(stops, pick)],
    ['Extend', [...(g.extend ?? [true, true])]],
  ]);
}

/** Wrap a shading in a PatternType 2 shading pattern.
 *
 *  No /Matrix: it defaults to identity, and a pattern matrix maps pattern space
 *  to the DEFAULT space of the parent content stream (PDF 32000-1 §8.7.3.1).
 *  Gradient coordinates are already in that space, so any matrix here would
 *  double-transform them. */
export function shadingPattern(shading: PdfDict): PdfDict {
  return dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Shading', shading],
  ]);
}
