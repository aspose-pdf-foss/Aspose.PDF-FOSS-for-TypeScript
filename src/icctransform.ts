import { PdfParseError, UnsupportedFeatureError } from './errors.js';
import { parseIccProfile, iccTag } from './icc.js';
import { readLutTag, evalLut } from './icclut.js';
import type { CmykTransform } from './colorrule.js';

/**
 * sRGB → PCS → CMYK through an ICC destination profile (85l8.7.2).
 *
 * A pure leaf over `icc.ts`, `icclut.ts` and `errors.js`. It builds a
 * `CmykTransform` — `85l8.3`'s seam — so nothing in the colour walk changes.
 *
 * The SOURCE leg is written out rather than parsed: sRGB is defined by a
 * specification rather than by a file, so hard-coding its transfer function
 * and matrix keeps the whole feature dependent on exactly one profile, the
 * caller's destination.
 */

/** The sRGB → XYZ matrix already Bradford-adapted to D50 (IEC 61966-2.1 with
 *  the adaptation ICC mandates for the PCS). Rows are X, Y, Z. */
const SRGB_TO_XYZ_D50: readonly (readonly number[])[] = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];

/** D50, the ICC profile connection space illuminant. */
const D50: readonly [number, number, number] = [0.9642, 1.0, 0.8249];

/** The sRGB transfer function: a linear segment in the shadows and a 2.4
 *  power above it. NOT a plain 2.2 gamma — the two differ most exactly where
 *  a plain gamma looks nearly right. */
function srgbToLinear(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB 0..1 to D50-adapted CIE XYZ. */
export function srgbToXyzD50(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const m = SRGB_TO_XYZ_D50;
  const row = (i: number): number => {
    const w = m[i] as readonly number[];
    return (w[0] as number) * lr + (w[1] as number) * lg + (w[2] as number) * lb;
  };
  return [row(0), row(1), row(2)];
}

const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

const labF = (t: number): number =>
  (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);

/** D50 XYZ to CIE L*a*b*. */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / (D50[0] as number));
  const fy = labF(y / (D50[1] as number));
  const fz = labF(z / (D50[2] as number));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * L*a*b* to the fraction of the LUT's input range, 0..1.
 *
 * **L\* 100 maps to 1.0 — the FULL input range — not to 65280/65535.**
 *
 * This is the one rule here that was got wrong first, and it is recorded
 * because the wrong reading is the plausible one. ICC v2 stores Lab in a
 * legacy 16-bit encoding whose L\* 100 is 0xFF00 rather than 0xFFFF, so
 * feeding the CLUT `L/100 × 65280/65535` looks right; the LUT's input range,
 * though, is the whole 0..65535, and a CMS normalises onto it.
 *
 * Measured against Windows Color System, which is exactly what the oracle
 * exists for: the 0xFF00 reading put every colour's L\* 0.383% low — a
 * uniformly slightly-light image, invisible without a reference — and the
 * error was proportional to L\*, zero at black and worst at white, where WCS
 * reported an encoded 1.0 against our 0.99611.
 *
 * a\* and b\* use the legacy `(v + 128) × 256` encoding normalised over
 * 0..0xFFFF, so a\* 0 sits at 0x8000 — NOT `(v + 128) / 255`, which is the
 * other plausible reading and is off by 2×10⁻³ where this one matches WCS to
 * 1×10⁻⁴. Solved from the goldens rather than assumed, after the same mistake
 * had already been made once on L\*.
 *
 * The asymmetry between the two — L\* over its full range, a\* and b\* through
 * the ×256 convention — reads like an inconsistency and is what was measured.
 */
export function labToV2(l: number, a: number, b: number): [number, number, number] {
  const clamp = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ab = (v: number): number => clamp((v + 128) * 256 / 65535);
  return [clamp(l / 100), ab(a), ab(b)];
}

export interface IccTransformOptions {
  /** 0 perceptual (default), 1 media-relative colorimetric, 2 saturation. */
  intent?: 0 | 1 | 2;
}

/**
 * Build a `CmykTransform` from an ICC destination profile.
 *
 * Every refusal happens HERE, before any colour is converted, so a profile we
 * decline leaves the document byte-identical — `checkTarget`'s rule.
 *
 * What is declined rather than guessed at: a v4 profile (its `B2A` is an
 * `mBA ` with a different element order, and reading it as an `mft2` would
 * produce confident nonsense), absolute colorimetric (it is relative plus a
 * white-point adaptation and has no `B2A` tag of its own), a profile whose
 * device space is not CMYK, one whose PCS is not Lab, and one carrying no
 * `B2A` tag at all.
 */
export function iccCmykTransform(
  profile: Uint8Array, opts: IccTransformOptions = {},
): CmykTransform {
  const p = parseIccProfile(profile);
  if (p.header.version.major >= 4) {
    throw new UnsupportedFeatureError(
      `ICC profile is version ${p.header.version.major}; only version 2 `
      + 'profiles are supported (a v4 B2A is an "mBA " with a different '
      + 'element order)');
  }
  if (p.header.dataColorSpace !== 'CMYK') {
    throw new UnsupportedFeatureError(
      `ICC profile device space is ${JSON.stringify(p.header.dataColorSpace)}, `
      + 'expected "CMYK"');
  }
  if (p.header.pcs !== 'Lab ') {
    throw new UnsupportedFeatureError(
      `ICC profile connection space is ${JSON.stringify(p.header.pcs)}; `
      + 'only "Lab " is supported');
  }
  const intent = opts.intent ?? 0;
  if (intent !== 0 && intent !== 1 && intent !== 2) {
    throw new UnsupportedFeatureError(
      `ICC rendering intent ${String(intent)} has no B2A tag; `
      + 'expected 0 (perceptual), 1 (relative) or 2 (saturation)');
  }
  const tag = iccTag(p, `B2A${intent}`) ?? iccTag(p, 'B2A0');
  if (!tag) {
    throw new UnsupportedFeatureError(
      'ICC profile carries no B2A tag, so it cannot be a conversion destination');
  }
  const lut = readLutTag(p, tag);
  if (lut.inputChannels !== 3 || lut.outputChannels !== 4) {
    throw new PdfParseError(
      `ICC B2A tag is ${lut.inputChannels}-in/${lut.outputChannels}-out, `
      + 'expected 3-in/4-out for a Lab-to-CMYK transform');
  }
  return (r, g, b) => {
    const [x, y, z] = srgbToXyzD50(r, g, b);
    const [l, a, bb] = xyzToLab(x, y, z);
    const out = evalLut(lut, labToV2(l, a, bb));
    const at = (i: number): number => {
      const v = out[i] as number;
      return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    };
    return [at(0), at(1), at(2), at(3)];
  };
}
