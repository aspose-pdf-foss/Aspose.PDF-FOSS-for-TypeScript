/** Separable and non-separable blend functions (PDF 32000-1 §11.3.5).
 *  Pure arithmetic over 0..1 components; no PDF or canvas knowledge. */

export type BlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten'
  | 'ColorDodge' | 'ColorBurn' | 'HardLight' | 'SoftLight' | 'Difference' | 'Exclusion'
  | 'Hue' | 'Saturation' | 'Color' | 'Luminosity';

export type Rgb01 = [number, number, number];

const NAMES = new Set<string>([
  'Normal', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]);

/** Map a PDF /BM name to a BlendMode. `/Compatible` is a synonym for Normal
 *  (§11.3.5); anything unrecognized degrades to Normal. */
export function blendModeFromName(name: string): BlendMode {
  if (name === 'Compatible') return 'Normal';
  return NAMES.has(name) ? (name as BlendMode) : 'Normal';
}

/** The separable blend functions B(cb, cs) of §11.3.5.2, per component. */
function separable(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'Multiply':   return cb * cs;
    case 'Screen':     return cb + cs - cb * cs;
    case 'Overlay':    return separable('HardLight', cs, cb);
    case 'Darken':     return Math.min(cb, cs);
    case 'Lighten':    return Math.max(cb, cs);
    case 'ColorDodge': return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case 'ColorBurn':  return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case 'HardLight':  return cs <= 0.5 ? cb * (2 * cs) : cb + (2 * cs - 1) - cb * (2 * cs - 1);
    case 'SoftLight': {
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb);
    }
    case 'Difference': return Math.abs(cb - cs);
    case 'Exclusion':  return cb + cs - 2 * cb * cs;
    default:           return cs;
  }
}

const SEPARABLE = new Set<BlendMode>([
  'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
]);

// ---- Non-separable modes (§11.3.5.3) ----

function lum(c: Rgb01): number { return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }

/** Clip a color back into [0,1] about its luminosity, preserving hue. */
function clipColor(c: Rgb01): Rgb01 {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  // The guards are exactly the spec's: clip only when the color has actually
  // left the gamut. The extra epsilon tests only avoid dividing by zero on a
  // fully desaturated color, where the scale factor is undefined.
  if (n < 0 && l - n > 1e-12) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb01;
  if (x > 1 && x - l > 1e-12) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb01;
  return out;
}

/** Shift `c` to luminosity `l`, then clip back into gamut. */
function setLum(c: Rgb01, l: number): Rgb01 {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: Rgb01): number { return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }

/** Set saturation to `s`, preserving the relative ordering of components. */
function setSat(c: Rgb01, s: number): Rgb01 {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [mn, md, mx] = idx;
  const out: Rgb01 = [0, 0, 0];
  if (c[mx] > c[mn]) {
    out[md] = ((c[md] - c[mn]) * s) / (c[mx] - c[mn]);
    out[mx] = s;
  }
  out[mn] = 0;
  return out;
}

/** Blend backdrop `cb` with source `cs`, both 0..1. */
export function blendPixel(mode: BlendMode, cb: Rgb01, cs: Rgb01): Rgb01 {
  if (mode === 'Normal') return cs;
  if (SEPARABLE.has(mode)) {
    return [
      separable(mode, cb[0], cs[0]),
      separable(mode, cb[1], cs[1]),
      separable(mode, cb[2], cs[2]),
    ];
  }
  switch (mode) {
    case 'Hue':        return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'Saturation': return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'Color':      return setLum(cs, lum(cb));
    case 'Luminosity': return setLum(cb, lum(cs));
    default:           return cs;
  }
}
