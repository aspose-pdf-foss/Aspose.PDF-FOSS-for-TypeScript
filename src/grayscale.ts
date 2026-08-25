import type { ColorConverter } from './colorspace.js';

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

/** The single grey component for `comps` interpreted in `space`. */
export function grayOf(comps: readonly number[], space: GraySpace): number {
  switch (space.kind) {
    case 'gray':
      return clamp01(comps[0] ?? 0);
    case 'rgb':
      return luma(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0);
    case 'cmyk': {
      const c = comps[0] ?? 0, m = comps[1] ?? 0, y = comps[2] ?? 0, k = comps[3] ?? 0;
      return luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
    }
    case 'pattern':
      return space.base ? grayOf(comps, space.base) : 0;
    case 'other': {
      const [r, g, b] = space.converter.toRgb([...comps]);
      return luma(r / 255, g / 255, b / 255);
    }
  }
}

/** Round to 4 decimals; PDF numbers gain nothing from more. `pdfxcolor.ts`'s
 *  existing rule, and what makes an already-neutral colour survive greying
 *  byte-identically despite the weights summing 1 ulp shy of 1. */
export const grayNum = (v: number): number => Number(v.toFixed(4));
