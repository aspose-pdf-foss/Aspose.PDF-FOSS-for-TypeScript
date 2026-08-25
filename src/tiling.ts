// The tiling-pattern model shared by the authoring layer: option validation,
// the lattice /Matrix, and the PatternType 1 dict. Pure — it builds a DIRECT
// PdfDict and touches no Document, exactly as gradient.ts does for colour
// stops, which is what keeps every rule here testable from numbers.
//
// Direction note: svgpattern.ts resolves an SVG <pattern>'s attributes into a
// tile rect for IMPORT. This is authoring, it starts from declared numbers, and
// the two share no code.
import { name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { mul, type Matrix } from './text.js';

/** Placement and repetition for a tiling pattern. */
export interface TilingPatternOptions {
  /** Horizontal repeat interval. > 0. Default: the tile width. Larger than the
   *  tile leaves gaps between cells; smaller makes them overlap. */
  xStep?: number;
  /** Vertical repeat interval. > 0. Default: the tile height. */
  yStep?: number;
  /** Lattice origin offset, in the parent stream's default user space.
   *  Default 0. */
  x?: number;
  /** Lattice origin offset. Default 0. */
  y?: number;
  /** Lattice rotation in DEGREES counter-clockwise about the pattern origin,
   *  applied before the offset. Default 0. Degrees rather than radians matches
   *  every author-facing rotation here (stamp.ts, decorate.ts); arc()'s radians
   *  is a geometry primitive, not a placement option. */
  rotation?: number;
  /** Emit an uncolored (PaintType 2) pattern: the tile carries shape only and
   *  the colour is supplied where the pattern is used, so one hatch serves
   *  every colour. Default false. */
  uncolored?: boolean;
}

/** A tiling pattern that carries its own colours. */
export interface ColoredTilingPattern {
  readonly ref: PdfRef;
  readonly paintType: 1;
}

/** A tiling pattern whose colour is supplied at use time. */
export interface UncoloredTilingPattern {
  readonly ref: PdfRef;
  readonly paintType: 2;
}

/** A handle returned by `Document.NewTilingPattern`. The two arms are distinct
 *  types so that `setFillPattern`'s overloads can make the colour argument
 *  required exactly when it is needed — a single optional colour would be
 *  required half the time and silently ignored the other half. */
export type TilingPattern = ColoredTilingPattern | UncoloredTilingPattern;

/** Validated, defaulted tiling geometry. */
export interface ResolvedTiling {
  width: number;
  height: number;
  xStep: number;
  yStep: number;
  matrix: Matrix;
  uncolored: boolean;
}

function positive(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
  return n;
}

function finite(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`${label} must be a finite number`);
  return n;
}

/** The pattern /Matrix for a lattice rotated `rotationDeg` about the pattern
 *  origin and then shifted by (`x`, `y`).
 *
 *  Order matters and the wrong one still looks like a rotated hatch:
 *  translate-then-rotate spins the offset as well, putting the lattice
 *  somewhere else entirely. `mul(m, n)` applies `m` first. */
export function patternMatrix(x: number, y: number, rotationDeg: number): Matrix {
  const t: Matrix = [1, 0, 0, 1, x, y];
  if (rotationDeg === 0) return t;
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return mul([c, s, -s, c, 0, 0], t);
}

/** Validate a tile's size and options, applying the defaults. Throws before the
 *  caller allocates anything, so a rejected call leaves the document
 *  byte-identical. */
export function resolveTiling(
  width: number, height: number, opts: TilingPatternOptions = {},
): ResolvedTiling {
  positive('tile width', width);
  positive('tile height', height);
  const xStep = opts.xStep === undefined ? width : positive('xStep', opts.xStep);
  const yStep = opts.yStep === undefined ? height : positive('yStep', opts.yStep);
  const x = opts.x === undefined ? 0 : finite('x', opts.x);
  const y = opts.y === undefined ? 0 : finite('y', opts.y);
  const rotation = opts.rotation === undefined ? 0 : finite('rotation', opts.rotation);
  if (opts.uncolored !== undefined && typeof opts.uncolored !== 'boolean')
    throw new TypeError('uncolored must be a boolean');
  return {
    width, height, xStep, yStep,
    matrix: patternMatrix(x, y, rotation),
    uncolored: opts.uncolored ?? false,
  };
}

/** The PatternType 1 stream dict for a resolved tile. `resources` becomes the
 *  pattern's own /Resources — required rather than optional, so a tile that
 *  registered nothing still carries an empty dict.
 *
 *  Content is clipped to /BBox, which is the tile box: a caller wanting spill
 *  sizes the tile larger and sets smaller steps. svgdraw.ts grows the box
 *  instead, but it can read `overflow: visible` off an attribute and measure
 *  the subtree's ink; an authoring call has neither. */
export function tilingPatternDict(r: ResolvedTiling, resources: PdfDict): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('Pattern')],
    ['PatternType', 1],
    ['PaintType', r.uncolored ? 2 : 1],
    ['TilingType', 1],
    ['BBox', [0, 0, r.width, r.height]],
    ['XStep', r.xStep],
    ['YStep', r.yStep],
    ['Resources', resources],
    ['Matrix', [...r.matrix]],
  ]);
}
