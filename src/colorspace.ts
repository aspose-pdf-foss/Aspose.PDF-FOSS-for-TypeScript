import { PdfDict, PdfObject, isName, isArray, isString, isStream } from './types.js';
import { parseFunction, PdfFunction } from './pdffunction.js';

export type Rgb = [number, number, number];
type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/**
 * Which family a colour space belongs to, for the one rule that needs to know:
 * OVERPRINT is meaningful only in a device SUBTRACTIVE space (32000-1
 * 11.7.4.2), where a colorant the paint does not name is left on the plate.
 *
 * `'device-sub'` is DeviceGray, DeviceCMYK and any ICCBased space that
 * resolves to one; `'separation'` is Separation and DeviceN, which name a
 * SUBSET of the device's colorants and so preserve the rest whatever the
 * overprint mode says; `'other'` is DeviceRGB and the CIE-based spaces, where
 * the spec says overprint does not apply.
 */
export type ColorFamily = 'device-sub' | 'separation' | 'other';

export interface ColorConverter {
  components: number;
  /** **Required rather than optional on purpose.** An optional discriminator is
   *  silently missable at a construction site, and a converter that forgot it
   *  would quietly stop overprinting — the same class of trap as the bivariant
   *  sink method 4gtd.4 records, in another shape. Required makes `tsc` name
   *  every site instead. */
  family: ColorFamily;
  toRgb(c: number[]): Rgb;
  initial(): Rgb;
}

const b = (x: number): number => Math.max(0, Math.min(255, Math.round(x * 255)));

/** The DeviceGray converter: one component, replicated to R=G=B. */
export function deviceGray(): ColorConverter {
  return { components: 1, family: 'device-sub', toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; }, initial: () => [0, 0, 0] };
}

export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  return [b((1 - c) * (1 - k)), b((1 - m) * (1 - k)), b((1 - y) * (1 - k))];
}

export function rgbHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
}

const gray: ColorConverter = {
  components: 1,
  family: 'device-sub',
  toRgb: (c) => [b(c[0] ?? 0), b(c[0] ?? 0), b(c[0] ?? 0)],
  initial: () => [0, 0, 0],
};
const rgb: ColorConverter = {
  components: 3,
  family: 'other',
  toRgb: (c) => [b(c[0] ?? 0), b(c[1] ?? 0), b(c[2] ?? 0)],
  initial: () => [0, 0, 0],
};
const cmyk: ColorConverter = {
  components: 4,
  family: 'device-sub',
  toRgb: (c) => cmykToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0),
  initial: () => [0, 0, 0],
};

/** Resolve a /ColorSpace operand (name or array, possibly via /Resources) into a
 *  component→RGB converter. Never throws; unknown → gray. */
export function resolveColorSpace(cs: PdfObject, resolve: Resolve, inflate: Inflate): ColorConverter {
  const r = resolve(cs);
  if (isName(r)) {
    switch (r.name) {
      case 'DeviceGray': case 'G': case 'CalGray': return gray;
      case 'DeviceRGB': case 'RGB': case 'CalRGB': return rgb;
      case 'DeviceCMYK': case 'CMYK': return cmyk;
      case 'Pattern': return { ...gray, components: 1, family: 'other' };
      default: return gray;
    }
  }
  if (isArray(r) && r.length > 0) {
    const head = resolve(r[0]);
    const fam = isName(head) ? head.name : '';
    switch (fam) {
      case 'ICCBased': {
        const stream = resolve(r[1]);
        const n = isStream(stream) ? (resolve(stream.dict.get('N')) as number) : 3;
        const alt = isStream(stream) ? stream.dict.get('Alternate') : undefined;
        if (alt) return resolveColorSpace(alt, resolve, inflate);
        return n === 1 ? gray : n === 4 ? cmyk : rgb;
      }
      case 'CalGray': return gray;
      case 'CalRGB': case 'Lab': return fam === 'Lab' ? labConverter() : rgb;
      case 'Indexed': case 'I': return indexedConverter(r, resolve, inflate);
      case 'Separation': return separationConverter(r, 1, resolve, inflate);
      case 'DeviceN': {
        const names = resolve(r[1]);
        const cnt = isArray(names) ? names.length : 1;
        return separationConverter(r, cnt, resolve, inflate);
      }
      case 'Pattern':
        return r.length > 1 ? resolveColorSpace(r[1], resolve, inflate) : gray;
      default: return gray;
    }
  }
  return gray;
}

function indexedConverter(arr: PdfObject[], resolve: Resolve, inflate: Inflate): ColorConverter {
  const base = resolveColorSpace(arr[1], resolve, inflate);
  const lookupObj = resolve(arr[3]);
  let table: Uint8Array;
  if (isString(lookupObj)) table = lookupObj.bytes;
  else if (isStream(lookupObj)) table = inflate(lookupObj);
  else table = new Uint8Array(0);
  const nc = base.components;
  return {
    components: 1,
    // Indexed is not one of 11.7.4.2's overprint spaces whatever its base is.
    family: 'other',
    toRgb: (c) => {
      const i = Math.max(0, Math.round(c[0] ?? 0));
      const comps: number[] = [];
      for (let k = 0; k < nc; k++) comps.push((table[i * nc + k] ?? 0) / 255);
      return base.toRgb(comps);
    },
    initial: () => base.toRgb(new Array(nc).fill(0)),
  };
}

function separationConverter(arr: PdfObject[], n: number, resolve: Resolve, inflate: Inflate): ColorConverter {
  // [/Separation name alt tint] or [/DeviceN names alt tint]
  const altIdx = 2;
  const alt = resolveColorSpace(arr[altIdx], resolve, inflate);
  let tint: PdfFunction = (x) => new Array(alt.components).fill(x[0] ?? 0);
  const fnObj = arr[altIdx + 1];
  if (fnObj !== undefined) tint = parseFunction(fnObj, resolve, inflate);
  return {
    components: n,
    family: 'separation',
    toRgb: (c) => alt.toRgb(tint(c.length ? c : [1])),
    initial: () => alt.toRgb(tint(new Array(n).fill(1))),
  };
}

/** CIE L*a*b* → sRGB (D50 white). Approximate; adequate for preview. */
function labConverter(): ColorConverter {
  return {
    components: 3,
    family: 'other',
    toRgb: (c) => {
      const L = c[0] ?? 0, A = c[1] ?? 0, B = c[2] ?? 0;
      const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
      const g = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
      const xn = 0.9642, yn = 1.0, zn = 0.8249;
      const X = xn * g(fx), Y = yn * g(fy), Z = zn * g(fz);
      const R = 3.1338 * X - 1.6168 * Y - 0.4906 * Z;
      const G = -0.9787 * X + 1.9161 * Y + 0.0334 * Z;
      const Bl = 0.0719 * X - 0.2289 * Y + 1.4052 * Z;
      const gamma = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055);
      return [b(gamma(R)), b(gamma(G)), b(gamma(Bl))];
    },
    initial: () => [0, 0, 0],
  };
}
