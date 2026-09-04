import type { ColorConverter } from './colorspace.js';

/**
 * Naive RGB -> CMYK with maximum black removal and no colour management.
 *
 * The result is **not** colorimetrically correct: without the destination
 * profile there is no way to know what ink these values produce. It exists so
 * a document can reach PDF/X-1a's structural requirements and so
 * `ConvertColors({ to: 'cmyk' })` has a transform at all -- not to produce
 * accurate print output. `85l8.3` is where a real profile arrives.
 *
 * It lives HERE, in the leaf, rather than in `pdfxcolor.ts` where it was
 * written, because two callers now need it and `pdfxcolor.ts` is not a leaf --
 * it imports `EditableContent`, so importing it from this module would drag
 * the whole page-content machinery into the one file every colour rule is
 * tested from. `pdfxcolor.ts` re-exports it, so its import path is unchanged.
 * One owner: two conversions disagreeing about one document is exactly what
 * that rule exists to prevent.
 */
/**
 * An RGB triple in 0..1 as CMYK in 0..1 — the one leg of a colour conversion
 * that cannot be got right without knowing the destination (85l8.3).
 *
 * `rgbToCmyk` below is the default and is naive. A caller who IS colour
 * managed — who has the destination profile and a CMS to apply it — passes one
 * of these to `ConvertColors({ to: 'cmyk' })` instead. That does not make this
 * library colour managed; it makes it possible for its caller to be.
 *
 * It replaces the RGB->CMYK leg ALONE, never the pivot: every source space
 * still reaches RGB through `rgbPivot`, so a transform sees the same triple
 * whatever the document declared, and a gray or rgb target never consults it.
 */
export type CmykTransform =
  (r: number, g: number, b: number) => readonly [number, number, number, number];

export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
}

/**
 * The greying rule, and its only owner.
 *
 * Rec. 601 luma on the *encoded* values -- what JPEG's own Y channel is, and
 * what Ghostscript and the rest of the PDF tooling emit, so a document
 * converted here matches the same document converted elsewhere. It is also
 * what keeps a coefficient-domain JPEG route available later: a baseline
 * JPEG's Y *is* this quantity, so dropping the chroma components in the DCT
 * domain would be an exact, generation-free greying. Rec. 709 would close that
 * door for a photometric argument no other tool acts on.
 */
export function luma(r: number, g: number, b: number): number {
  const v = 0.299 * r + 0.587 * g + 0.114 * b;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A colour space reduced to what greying needs.
 *
 * The three device families are held structurally and converted in float,
 * because they are the 99% case and `ColorConverter.toRgb` quantizes to 8-bit
 * on the way past. Everything else -- ICCBased, Indexed, Separation, DeviceN,
 * CalRGB, Lab -- arrives as `other` carrying the converter `resolveColorSpace`
 * already builds, which is why none of them needs a case here.
 */
export type GraySpace =
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'cmyk' }
  /** `/Pattern`, optionally `[/Pattern base]` for an uncoloured pattern.
   *  `resourceName` is the `/Resources /ColorSpace` key it was found under, so
   *  a caller can retarget that one array; undefined for a bare `/Pattern`. */
  | { kind: 'pattern'; base?: GraySpace; resourceName?: string }
  | { kind: 'other'; converter: ColorConverter };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How many numeric operands this space takes. A bare `/Pattern` takes none. */
export function componentsOf(space: GraySpace): number {
  switch (space.kind) {
    case 'gray': return 1;
    case 'rgb': return 3;
    case 'cmyk': return 4;
    case 'pattern': return space.base ? componentsOf(space.base) : 0;
    case 'other': return space.converter.components;
  }
}

/**
 * The device space a conversion targets.
 *
 * Three, not `GraySpace`: a target must be somewhere a colour can actually be
 * WRITTEN, and `other`/`pattern` are source-side readings. `85l8.3`'s ICC
 * destination profile rides on the options bag rather than widening this, so
 * this stays a name for "which of the three device spaces".
 */
export type TargetSpace = 'gray' | 'rgb' | 'cmyk';

/** How many operands a target takes. */
export function targetComponents(to: TargetSpace): number {
  return to === 'gray' ? 1 : to === 'rgb' ? 3 : 4;
}

/** The `/ColorSpace` name a target is written as. */
export function targetName(to: TargetSpace): string {
  return to === 'gray' ? 'DeviceGray' : to === 'rgb' ? 'DeviceRGB' : 'DeviceCMYK';
}

/** True when `space` already IS the target, so the conversion is a no-op. */
export function isTarget(space: GraySpace, to: TargetSpace): boolean {
  return space.kind === to;
}

/**
 * `comps` in `space` as an RGB triple, 0..1 -- the pivot every conversion goes
 * through, and NOT clamped.
 *
 * Leaving it unclamped is what keeps `grayOf` byte-identical: its RGB arm
 * passed raw operands to `luma`, which clamps the weighted SUM rather than its
 * inputs, so `luma(2, 0, 0)` is 0.598 where clamping first gives 0.299. Every
 * target that needs bounded input clamps on its own way out.
 */
function rgbPivot(comps: readonly number[], space: GraySpace): [number, number, number] {
  switch (space.kind) {
    case 'gray': {
      const g = clamp01(comps[0] ?? 0);
      return [g, g, g];
    }
    case 'rgb':
      return [comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0];
    case 'cmyk': {
      const c = comps[0] ?? 0, m = comps[1] ?? 0, y = comps[2] ?? 0, k = comps[3] ?? 0;
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    case 'pattern':
      return space.base ? rgbPivot(comps, space.base) : [0, 0, 0];
    case 'other': {
      const [r, g, b] = space.converter.toRgb([...comps]);
      return [r / 255, g / 255, b / 255];
    }
  }
}

/**
 * `comps`, read in `space`, expressed in `to`. The one conversion rule.
 *
 * It pivots through RGB, which is what `grayOf` already did -- its CMYK arm is
 * naive cmyk->rgb followed by luma, and its `other` arm goes through
 * `ColorConverter.toRgb`. The CMYK leg reuses `pdfxcolor.ts`'s `rgbToCmyk`
 * rather than deriving a second one, so a document converted here and a
 * document converted by PDF/X remediation cannot disagree.
 *
 * A source ALREADY in the target space is returned untouched, and that is the
 * byte-identity property rather than an optimization: the Rec. 601 weights sum
 * to 0.9999999999999999, so a grey pivoted through RGB comes back one ulp low
 * and every grey operand in the document is re-rounded. The cmyk arm matters
 * for the same reason by a different route, `rgbToCmyk` dividing by `1 - k`.
 *
 * **Note, measured, and it covers NOTHING:** the RGB arm of that short-circuit
 * is NOT load-bearing. `rgbPivot` returns an rgb source's components raw and
 * `clamp01` is the identity in range, so the two paths provably agree --
 * disabling the short-circuit for rgb alone reddens no test in the suite,
 * where disabling it outright reddens the gray and cmyk cases. It stays
 * because the rule is "a conversion to where you already are does nothing",
 * which should hold by construction rather than by an argument about clamping;
 * do not cite the green suite as covering it.
 */
export function convertComps(
  comps: readonly number[], from: GraySpace, to: TargetSpace,
  toCmyk: CmykTransform = rgbToCmyk,
): number[] {
  const src = from.kind === 'pattern' && from.base ? from.base : from;
  if (isTarget(src, to)) {
    const n = targetComponents(to);
    return Array.from({ length: n }, (_, i) => clamp01(comps[i] ?? 0));
  }
  const [r, g, b] = rgbPivot(comps, from);
  if (to === 'gray') return [luma(r, g, b)];
  if (to === 'rgb') return [clamp01(r), clamp01(g), clamp01(b)];
  return [...toCmyk(clamp01(r), clamp01(g), clamp01(b))];
}

/** The single grey component for `comps` interpreted in `space`.
 *  The gray specialization of `convertComps`, kept because it reads better at
 *  the many call sites that genuinely want one number. */
export function grayOf(comps: readonly number[], space: GraySpace): number {
  return convertComps(comps, space, 'gray')[0] ?? 0;
}

/** Round to 4 decimals; PDF numbers gain nothing from more. `pdfxcolor.ts`'s
 *  existing rule, and what makes an already-neutral colour survive greying
 *  byte-identically despite the weights summing 1 ulp shy of 1. */
export const grayNum = (v: number): number => Number(v.toFixed(4));
