// SVG filter pixels (issue 1gg0.10.3): the Surface type, the colour-space edges
// of the pipeline, and the kernels. Pure -- no PDF, no SVG, no Document. Every
// kernel is a function from one or two Surfaces plus parameters to a new one.
//
// Surfaces hold PREMULTIPLIED LINEAR RGBA. SVG 1.1's
// color-interpolation-filters defaults to linearRGB, and a premultiplied value
// is not a colour: converting one through a transfer function directly is wrong
// wherever alpha < 1. convertSpace is the only place that conversion happens.
import { flate, imageStream, type BuiltImage } from './imageembed.js';
import { name } from './types.js';
import type { XmlNode } from './xml.js';
import { parseColor, type Rgb } from './svgstyle.js';
import { primInputs, primLength, type FilterPrim, type FilterSpec } from './svgfilter.js';
import type { SegBBox } from './svgpath.js';
import { turbulenceSurface, type TurbulenceParams } from './svgfilternoise.js';
import {
  lightingSurface, type LightingParams, type LightSource,
} from './svgfilterlight.js';
import type { ImageRgba } from './raster.js';

/** A window onto the filter region, in device pixels. Mirrors raster.ts's
 *  Canvas.originX/Y: x/y are the origin relative to the region's top-left, so a
 *  subregion surface is addressed in the same coordinates as the whole. */
export interface Surface {
  x: number; y: number;
  w: number; h: number;
  /** Premultiplied linear RGBA, 0..1, row-major. */
  data: Float32Array;
}

export function makeSurface(x: number, y: number, w: number, h: number): Surface {
  const cw = Math.max(0, Math.floor(w)), ch = Math.max(0, Math.floor(h));
  return { x, y, w: cw, h: ch, data: new Float32Array(cw * ch * 4) };
}

/** IEC 61966-2-1. The piecewise form, not a bare 2.2 power: the linear segment
 *  below the knee is what keeps near-black from crushing. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A 256-entry table for the byte-in direction: the only conversion that runs
 *  once per source pixel per channel, and the only one whose inputs are
 *  quantized to begin with. */
const SRGB8 = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB8[i] = srgbToLinear(i / 255);

/** Straight-alpha sRGB bytes from the rasterizer -> premultiplied linear. The
 *  surface is placed at the region origin; the caller owns any offset. */
export function toSurface(img: ImageRgba): Surface {
  const s = makeSurface(0, 0, img.w, img.h);
  const n = img.w * img.h;
  for (let p = 0; p < n; p++) {
    const a = img.data[p * 4 + 3] / 255;
    s.data[p * 4]     = SRGB8[img.data[p * 4]] * a;
    s.data[p * 4 + 1] = SRGB8[img.data[p * 4 + 1]] * a;
    s.data[p * 4 + 2] = SRGB8[img.data[p * 4 + 2]] * a;
    s.data[p * 4 + 3] = a;
  }
  return s;
}

/** Reverse the row order of a raster.
 *
 *  The y-down/y-up bridge, and the one place the two conventions meet. SVG
 *  content is emitted y-DOWN (see svgtransform.ts's placementMatrix), but
 *  rasterizeFormRgba renders it as ordinary y-UP PDF, so its row 0 is the SVG
 *  BOTTOM. Filters must run the other way up: `dy` is a downward offset, a
 *  subregion's y grows downward, and surfaceImage's output is placed top-down.
 *  Without this every vertical parameter is silently mirrored -- and a
 *  symmetric fixture cannot tell. */
export function flipRows(img: ImageRgba): ImageRgba {
  const out = new Uint8Array(img.data.length);
  const stride = img.w * 4;
  for (let y = 0; y < img.h; y++)
    out.set(img.data.subarray(y * stride, y * stride + stride), (img.h - 1 - y) * stride);
  return { w: img.w, h: img.h, data: out };
}

/** Reinterpret a surface's colour channels in the other transfer function.
 *  Alpha is untouched: it is not a colour and has no gamma. */
export function convertSpace(s: Surface, to: 'linearRGB' | 'sRGB'): Surface {
  const f = to === 'sRGB' ? linearToSrgb : srgbToLinear;
  const out = makeSurface(s.x, s.y, s.w, s.h);
  const n = s.w * s.h;
  for (let p = 0; p < n; p++) {
    const a = s.data[p * 4 + 3];
    out.data[p * 4 + 3] = a;
    if (a <= 0) continue;                 // fully transparent: nothing to convert
    for (let c = 0; c < 3; c++)
      out.data[p * 4 + c] = clamp01(f(clamp01(s.data[p * 4 + c] / a))) * a;
  }
  return out;
}

/** The pipeline's output end: premultiplied linear -> an Image XObject plus its
 *  /SMask, in sRGB straight-alpha bytes.
 *
 *  Built directly rather than PNG-encoded and re-parsed through
 *  buildImageXObject: imageembed.ts's decoders are for bytes we did not
 *  produce, and these are ours. */
export function surfaceImage(s: Surface): BuiltImage {
  const n = s.w * s.h;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const a = s.data[p * 4 + 3];
    alpha[p] = Math.round(clamp01(a) * 255);
    if (a <= 0) continue;                 // rgb stays 0: no colour to recover
    for (let c = 0; c < 3; c++)
      rgb[p * 3 + c] = Math.round(clamp01(linearToSrgb(clamp01(s.data[p * 4 + c] / a))) * 255);
  }
  return {
    stream: imageStream(s.w, s.h, 8, name('DeviceRGB'), flate(rgb)),
    smask: imageStream(s.w, s.h, 8, name('DeviceGray'), flate(alpha)),
  };
}

// ---------- Kernels ----------

/** Copy `src` into `dst`, using each surface's own origin, clipped. The
 *  universal "place this result where it belongs" step: a kernel produces
 *  pixels over some window, and every result is stored over the whole raster. */
function place(src: Surface, dst: Surface): void {
  for (let y = 0; y < src.h; y++) {
    const dy = y + src.y - dst.y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = x + src.x - dst.x;
      if (dx < 0 || dx >= dst.w) continue;
      const si = (y * src.w + x) * 4, di = (dy * dst.w + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** Zero everything outside `win`. A primitive may not paint outside its
 *  subregion (SVG 1.1 §15.7.5), and a kernel that works over the whole raster
 *  (an offset, later a blur) would otherwise leak past it. */
function maskTo(s: Surface, win: PixelBox): void {
  for (let y = 0; y < s.h; y++) {
    const inRow = y >= win.y && y < win.y + win.h;
    for (let x = 0; x < s.w; x++) {
      if (inRow && x >= win.x && x < win.x + win.w) continue;
      s.data.fill(0, (y * s.w + x) * 4, (y * s.w + x) * 4 + 4);
    }
  }
}

/** A subregion measured in raster pixels rather than user units. */
interface PixelBox { x: number; y: number; w: number; h: number }

/** Black at the source's alpha. Premultiplied, so the colour channels are 0. */
function sourceAlpha(s: Surface): Surface {
  const out = makeSurface(s.x, s.y, s.w, s.h);
  for (let p = 0; p < s.w * s.h; p++) out.data[p * 4 + 3] = s.data[p * 4 + 3];
  return out;
}

/** SVG 1.1 §15.7.11. Whole pixels: a fractional shift would resample, and
 *  feOffset is defined as a pure translation. */
function offsetKernel(input: Surface, dx: number, dy: number): Surface {
  const out = makeSurface(input.x, input.y, input.w, input.h);
  const ox = Math.round(dx), oy = Math.round(dy);
  for (let y = 0; y < input.h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= out.h) continue;
    for (let x = 0; x < input.w; x++) {
      const tx = x + ox;
      if (tx < 0 || tx >= out.w) continue;
      const si = (y * input.w + x) * 4, di = (ty * out.w + tx) * 4;
      out.data[di] = input.data[si];
      out.data[di + 1] = input.data[si + 1];
      out.data[di + 2] = input.data[si + 2];
      out.data[di + 3] = input.data[si + 3];
    }
  }
  return out;
}

/** SVG 1.1 §15.7.10: flood-color x flood-opacity, in the primitive's own
 *  working space -- runFilter converts the result back to linear afterwards. */
function floodKernel(p: FilterPrim, win: PixelBox): Surface {
  const out = makeSurface(win.x, win.y, win.w, win.h);
  const c = parseColor(p.attrs.get('flood-color') ?? 'black');
  if (c === null || c === undefined) return out;     // 'none' floods nothing
  const oRaw = parseFloat(p.attrs.get('flood-opacity') ?? '1');
  const a = clamp01(Number.isFinite(oRaw) ? oRaw : 1);
  // parseColor already yields 0..1 sRGB components -- the range PDF's `rg`
  // operator takes, which is why svgdraw.ts can emit them unscaled.
  const conv = p.space === 'sRGB' ? (v: number) => v : srgbToLinear;
  const r = conv(c[0]) * a, g = conv(c[1]) * a, b = conv(c[2]) * a;
  for (let i = 0; i < win.w * win.h; i++) out.data.set([r, g, b, a], i * 4);
  return out;
}

/** Source-over composite of `src` onto `dst`, in place. Premultiplied, so this
 *  is the plain Porter-Duff form with no division. */
function over(dst: Surface, src: Surface): void {
  for (let p = 0; p < dst.w * dst.h; p++) {
    const inv = 1 - src.data[p * 4 + 3];
    for (let c = 0; c < 4; c++)
      dst.data[p * 4 + c] = src.data[p * 4 + c] + dst.data[p * 4 + c] * inv;
  }
}

/** Porter-Duff on PREMULTIPLIED values: the coefficient pair is all that
 *  distinguishes the operators, so the algebra is written once.
 *  [Fa constant, Fa*ab, Fb constant, Fb*aa] -> fa = c0 + c1*ab, fb = c2 + c3*aa. */
const PORTER_DUFF: Record<string, [number, number, number, number]> = {
  over: [1, 0, 1, -1],
  in:   [0, 1, 0, 0],
  out:  [1, -1, 0, 0],
  atop: [0, 1, 1, -1],
  xor:  [1, -1, 1, -1],
};

/** SVG 1.1 §15.7.3. */
function compositeKernel(
  a: Surface, b: Surface, p: FilterPrim, W: number, H: number,
): Surface {
  const out = makeSurface(0, 0, W, H);
  const op = p.attrs.get('operator') ?? 'over';
  if (op === 'arithmetic') {
    const k = (n: string): number => {
      const v = parseFloat(p.attrs.get(n) ?? '0');
      return Number.isFinite(v) ? v : 0;
    };
    const k1 = k('k1'), k2 = k('k2'), k3 = k('k3'), k4 = k('k4');
    for (let i = 0; i < W * H * 4; i++) {
      const i1 = a.data[i], i2 = b.data[i];
      out.data[i] = clamp01(k1 * i1 * i2 + k2 * i1 + k3 * i2 + k4);
    }
    return out;
  }
  const [c0, c1, c2, c3] = PORTER_DUFF[op] ?? PORTER_DUFF.over;
  for (let q = 0; q < W * H; q++) {
    const aa = a.data[q * 4 + 3], ab = b.data[q * 4 + 3];
    const fa = c0 + c1 * ab, fb = c2 + c3 * aa;
    for (let c = 0; c < 4; c++)
      out.data[q * 4 + c] = clamp01(a.data[q * 4 + c] * fa + b.data[q * 4 + c] * fb);
  }
  return out;
}

/** SVG 1.1 §15.7.4's five modes, written in the spec's own PREMULTIPLIED form
 *  rather than routed through blend.ts — that module takes non-premultiplied
 *  Rgb and returns the blend function alone, without the qa/qb weighting these
 *  formulas fold in. */
function blendKernel(a: Surface, b: Surface, mode: string, W: number, H: number): Surface {
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const qa = a.data[q * 4 + 3], qb = b.data[q * 4 + 3];
    out.data[q * 4 + 3] = clamp01(qa + qb - qa * qb);
    for (let c = 0; c < 3; c++) {
      const ca = a.data[q * 4 + c], cb = b.data[q * 4 + c];
      let v: number;
      switch (mode) {
        case 'multiply': v = ca * cb + ca * (1 - qb) + cb * (1 - qa); break;
        case 'screen':   v = ca + cb - ca * cb; break;
        case 'darken':   v = Math.min((1 - qb) * ca + cb, (1 - qa) * cb + ca); break;
        case 'lighten':  v = Math.max((1 - qb) * ca + cb, (1 - qa) * cb + ca); break;
        default:         v = ca + cb * (1 - qa); break;     // normal
      }
      out.data[q * 4 + c] = clamp01(v);
    }
  }
  return out;
}

/** SVG 1.1 §15.7.6's luminance coefficients — the Rec. 709 primaries. */
const LUM = [0.2126, 0.7152, 0.0722] as const;

/** The 20-value matrix a feColorMatrix `type` stands for. */
function colorMatrixValues(p: FilterPrim): number[] {
  const type = p.attrs.get('type') ?? 'matrix';
  const nums = (p.attrs.get('values') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  const ident = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  if (type === 'matrix') return nums.length === 20 ? nums : ident;
  if (type === 'saturate') {
    const s = nums.length >= 1 ? nums[0] : 1;
    const [r, g, b] = LUM;
    return [
      r + (1 - r) * s, g - g * s,       b - b * s,       0, 0,
      r - r * s,       g + (1 - g) * s, b - b * s,       0, 0,
      r - r * s,       g - g * s,       b + (1 - b) * s, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (type === 'hueRotate') {
    const deg = nums.length >= 1 ? nums[0] : 0;
    const c = Math.cos(deg * Math.PI / 180), n = Math.sin(deg * Math.PI / 180);
    // SVG 1.1 §15.7.6's published hueRotate matrix, term for term.
    return [
      0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715,
      0.072 - c * 0.072 + n * 0.928, 0, 0,
      0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.140,
      0.072 - c * 0.072 - n * 0.283, 0, 0,
      0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715,
      0.072 + c * 0.928 + n * 0.072, 0, 0,
      0, 0, 0, 1, 0,
    ];
  }
  if (type === 'luminanceToAlpha')
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, LUM[0], LUM[1], LUM[2], 0, 0];
  return ident;
}

/** SVG 1.1 §15.7.6: operates on NON-premultiplied values. Matrixing the stored
 *  premultiplied value instead is wrong wherever alpha < 1 — and invisible on
 *  the opaque fixtures that make up most of a suite. */
function colorMatrixKernel(input: Surface, p: FilterPrim, W: number, H: number): Surface {
  const m = colorMatrixValues(p);
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const a = input.data[q * 4 + 3];
    const r = a > 0 ? input.data[q * 4] / a : 0;
    const g = a > 0 ? input.data[q * 4 + 1] / a : 0;
    const b = a > 0 ? input.data[q * 4 + 2] / a : 0;
    const na = clamp01(m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19]);
    out.data[q * 4 + 3] = na;
    for (let c = 0; c < 3; c++) {
      const v = clamp01(m[c * 5] * r + m[c * 5 + 1] * g + m[c * 5 + 2] * b
                        + m[c * 5 + 3] * a + m[c * 5 + 4]);
      out.data[q * 4 + c] = v * na;
    }
  }
  return out;
}

/** One feFuncR/G/B/A as a 0..1 -> 0..1 function. SVG 1.1 §15.7.7. */
function transferFn(n: XmlNode | undefined): (c: number) => number {
  if (!n) return (c) => c;
  const num = (k: string, d: number): number => {
    const v = parseFloat(n.attrs.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const table = (n.attrs.get('tableValues') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((v) => Number.isFinite(v));
  switch (n.attrs.get('type')) {
    case 'table': {
      if (table.length === 0) return (c) => c;
      if (table.length === 1) return () => table[0];
      const n1 = table.length - 1;
      return (c) => {
        const k = Math.min(n1 - 1, Math.floor(c * n1));
        return table[k] + (c - k / n1) * n1 * (table[k + 1] - table[k]);
      };
    }
    case 'discrete': {
      if (table.length === 0) return (c) => c;
      return (c) => table[Math.min(table.length - 1, Math.floor(c * table.length))];
    }
    case 'linear': {
      const s = num('slope', 1), i = num('intercept', 0);
      return (c) => s * c + i;
    }
    case 'gamma': {
      const a = num('amplitude', 1), e = num('exponent', 1), o = num('offset', 0);
      return (c) => a * Math.pow(c, e) + o;
    }
    default:
      return (c) => c;
  }
}

/** SVG 1.1 §15.7.7: operates on NON-premultiplied values, like feColorMatrix. */
function componentTransferKernel(
  input: Surface, p: FilterPrim, W: number, H: number,
): Surface {
  const byName = new Map<string, XmlNode>();
  for (const c of p.node.children) if (!byName.has(c.name)) byName.set(c.name, c);
  const fns = [
    transferFn(byName.get('feFuncR')), transferFn(byName.get('feFuncG')),
    transferFn(byName.get('feFuncB')), transferFn(byName.get('feFuncA')),
  ];
  const out = makeSurface(0, 0, W, H);
  for (let q = 0; q < W * H; q++) {
    const a = input.data[q * 4 + 3];
    const na = clamp01(fns[3](a));
    out.data[q * 4 + 3] = na;
    for (let c = 0; c < 3; c++) {
      const straight = a > 0 ? input.data[q * 4 + c] / a : 0;
      out.data[q * 4 + c] = clamp01(fns[c](clamp01(straight))) * na;
    }
  }
  return out;
}

/** SVG 1.1 §15.17's box-size formula: d = floor(s * 3 * sqrt(2*PI) / 4 + 0.5). */
function boxSize(sigma: number): number {
  return Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
}

/** One horizontal or vertical box blur of width `d`, on premultiplied data. */
function boxBlur1D(
  src: Float32Array, dst: Float32Array, w: number, h: number, d: number,
  horizontal: boolean, shift: number,
): void {
  const half = Math.floor(d / 2);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < d; k++) {
          const j = i + k - half + shift;
          if (j < 0 || j >= len) continue;
          const idx = horizontal ? (l * w + j) : (j * w + l);
          acc += src[idx * 4 + c];
        }
        const o = horizontal ? (l * w + i) : (i * w + l);
        dst[o * 4 + c] = acc / d;
      }
    }
  }
}

/** A true Gaussian convolution, for the small sigmas where three box blurs are
 *  visibly boxy. SVG 1.1 prescribes the box approximation only for sigma >= 2. */
function gaussian1D(
  src: Float32Array, dst: Float32Array, w: number, h: number, sigma: number,
  horizontal: boolean,
): void {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r * 2 + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v; total += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= total;
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let j = -r; j <= r; j++) {
          const q = i + j;
          if (q < 0 || q >= len) continue;
          const idx = horizontal ? (l * w + q) : (q * w + l);
          acc += src[idx * 4 + c] * k[j + r];
        }
        const o = horizontal ? (l * w + i) : (i * w + l);
        dst[o * 4 + c] = acc;
      }
    }
  }
}

/** Blur one axis by `sigma` PIXELS. */
function blurAxis(s: Surface, sigma: number, horizontal: boolean): Surface {
  const out = makeSurface(s.x, s.y, s.w, s.h);
  if (!(sigma > 0)) { out.data.set(s.data); return out; }
  if (sigma < 2) {
    gaussian1D(s.data, out.data, s.w, s.h, sigma, horizontal);
    return out;
  }
  const d = boxSize(sigma);
  if (d < 1) { out.data.set(s.data); return out; }
  const a = new Float32Array(s.data.length);
  const b = new Float32Array(s.data.length);
  // SVG 1.1 §15.17: for an EVEN d the first two boxes are offset half a pixel
  // in opposite directions and the third is one wider, which is what keeps an
  // even-width blur centred. Three equal boxes drift by half a pixel.
  if (d % 2 === 1) {
    boxBlur1D(s.data, a, s.w, s.h, d, horizontal, 0);
    boxBlur1D(a, b, s.w, s.h, d, horizontal, 0);
    boxBlur1D(b, out.data, s.w, s.h, d, horizontal, 0);
  } else {
    boxBlur1D(s.data, a, s.w, s.h, d, horizontal, 0);
    boxBlur1D(a, b, s.w, s.h, d, horizontal, 1);
    boxBlur1D(b, out.data, s.w, s.h, d + 1, horizontal, 0);
  }
  return out;
}

function blurKernel(input: Surface, sx: number, sy: number): Surface {
  return blurAxis(blurAxis(input, sx, true), sy, false);
}

/** The two stdDeviation numbers, already scaled to pixels. */
function stdDev(spec: FilterSpec, p: FilterPrim, scale: number): [number, number] {
  const raw = (p.attrs.get('stdDeviation') ?? '0').trim().split(/[\s,]+/);
  const x = primLength(spec, raw[0], 0, 'x') * scale;
  const y = primLength(spec, raw[1] ?? raw[0], 0, 'y') * scale;
  return [Math.max(0, x), Math.max(0, y)];
}

/** SVG 1.1 §15.7.13: per-channel min (erode) or max (dilate) over the kernel
 *  rectangle, on premultiplied values. */
function morphologyKernel(
  input: Surface, rx: number, ry: number, dilate: boolean, W: number, H: number,
): Surface {
  const out = makeSurface(0, 0, W, H);
  const ix = Math.floor(rx), iy = Math.floor(ry);
  if (ix <= 0 && iy <= 0) { out.data.set(input.data); return out; }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const best = dilate ? [0, 0, 0, 0] : [1, 1, 1, 1];
      for (let j = -iy; j <= iy; j++) {
        const yy = y + j;
        // Outside the surface counts as transparent black, so an erode at the
        // edge correctly clears rather than sampling nothing.
        if (yy < 0 || yy >= H) { if (!dilate) best.fill(0); continue; }
        for (let i = -ix; i <= ix; i++) {
          const xx = x + i;
          if (xx < 0 || xx >= W) { if (!dilate) best.fill(0); continue; }
          for (let c = 0; c < 4; c++) {
            const v = input.data[(yy * W + xx) * 4 + c];
            best[c] = dilate ? Math.max(best[c], v) : Math.min(best[c], v);
          }
        }
      }
      for (let c = 0; c < 4; c++) out.data[(y * W + x) * 4 + c] = best[c];
    }
  }
  return out;
}

/** SVG 1.1 §15.7.19: repeat the INPUT primitive's subregion across this
 *  primitive's. `inSub` is the input's window, in raster pixels. */
function tileKernel(input: Surface, inSub: PixelBox, W: number, H: number): Surface {
  const out = makeSurface(0, 0, W, H);
  if (inSub.w <= 0 || inSub.h <= 0) return out;
  for (let y = 0; y < H; y++) {
    const sy = inSub.y + ((((y - inSub.y) % inSub.h) + inSub.h) % inSub.h);
    if (sy < 0 || sy >= H) continue;
    for (let x = 0; x < W; x++) {
      const sx = inSub.x + ((((x - inSub.x) % inSub.w) + inSub.w) % inSub.w);
      if (sx < 0 || sx >= W) continue;
      for (let c = 0; c < 4; c++)
        out.data[(y * W + x) * 4 + c] = input.data[(sy * W + sx) * 4 + c];
    }
  }
  return out;
}

/** feConvolveMatrix's parsed parameters, or null when the element is malformed
 *  — a kernel whose length disagrees with `order` cannot be guessed at. */
interface ConvolveParams {
  ox: number; oy: number;
  kernel: number[];
  divisor: number;
  bias: number;
  targetX: number; targetY: number;
  edgeMode: 'duplicate' | 'wrap' | 'none';
  preserveAlpha: boolean;
}

function convolveParams(attrs: Map<string, string>): ConvolveParams | null {
  const ord = (attrs.get('order') ?? '3').trim().split(/[\s,]+/).map(Number);
  const ox = Math.floor(ord[0]);
  const oy = Math.floor(ord.length > 1 ? ord[1] : ord[0]);
  if (!(ox > 0) || !(oy > 0)) return null;
  const kernel = (attrs.get('kernelMatrix') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  if (kernel.length !== ox * oy) return null;

  const sum = kernel.reduce((a, b) => a + b, 0);
  const dRaw = parseFloat(attrs.get('divisor') ?? '');
  // SVG 1.1 §15.7.5: the default is the kernel sum, or 1 when that sum is zero.
  // An explicit divisor of 0 is an error and falls back the same way.
  const divisor = Number.isFinite(dRaw) && dRaw !== 0 ? dRaw : (sum !== 0 ? sum : 1);

  const bRaw = parseFloat(attrs.get('bias') ?? '');
  const tX = parseFloat(attrs.get('targetX') ?? '');
  const tY = parseFloat(attrs.get('targetY') ?? '');
  const targetX = Number.isFinite(tX) ? Math.floor(tX) : Math.floor(ox / 2);
  const targetY = Number.isFinite(tY) ? Math.floor(tY) : Math.floor(oy / 2);
  if (targetX < 0 || targetX >= ox || targetY < 0 || targetY >= oy) return null;

  const em = attrs.get('edgeMode');
  return {
    ox, oy, kernel, divisor,
    bias: Number.isFinite(bRaw) ? bRaw : 0,
    targetX, targetY,
    edgeMode: em === 'wrap' ? 'wrap' : em === 'none' ? 'none' : 'duplicate',
    preserveAlpha: (attrs.get('preserveAlpha') ?? '').trim() === 'true',
  };
}

/** SVG 1.1 §15.7.5. The kernel is applied ROTATED 180° — the formula subtracts
 *  the kernel index rather than adding it — which is what makes a 1 in the
 *  top-left cell translate ink DOWN and RIGHT.
 *
 *  preserveAlpha="true" convolves UNPREMULTIPLIED colour and leaves alpha
 *  alone; the default convolves premultiplied values including alpha. */
function convolveKernel(input: Surface, c: ConvolveParams, W: number, H: number): Surface {
  const out = makeSurface(0, 0, W, H);
  const at = (x: number, y: number, ch: number): number => {
    let sx = x, sy = y;
    if (c.edgeMode === 'wrap') {
      sx = ((x % W) + W) % W; sy = ((y % H) + H) % H;
    } else if (c.edgeMode === 'duplicate') {
      sx = x < 0 ? 0 : x >= W ? W - 1 : x;
      sy = y < 0 ? 0 : y >= H ? H - 1 : y;
    } else if (x < 0 || x >= W || y < 0 || y >= H) {
      return 0;
    }
    const v = input.data[(sy * W + sx) * 4 + ch];
    if (!c.preserveAlpha || ch === 3) return v;
    const a = input.data[(sy * W + sx) * 4 + 3];
    return a > 0 ? v / a : 0;
  };
  const accumulate = (x: number, y: number, ch: number): number => {
    let sum = 0;
    for (let j = 0; j < c.oy; j++) {
      for (let i = 0; i < c.ox; i++) {
        sum += at(x - c.targetX + i, y - c.targetY + j, ch)
             * c.kernel[(c.oy - j - 1) * c.ox + (c.ox - i - 1)];
      }
    }
    return sum;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const alpha = c.preserveAlpha
        ? input.data[o + 3]
        : clamp01(accumulate(x, y, 3) / c.divisor + c.bias);
      for (let ch = 0; ch < 3; ch++) {
        const v = clamp01(accumulate(x, y, ch) / c.divisor + c.bias);
        // preserveAlpha convolved straight colour, so re-premultiply.
        out.data[o + ch] = c.preserveAlpha ? v * alpha : v;
      }
      out.data[o + 3] = alpha;
    }
  }
  return out;
}

/** feTurbulence's parameters, in USER units — the generator maps back to user
 *  space itself, so nothing here is scaled to pixels. */
function turbulenceParams(spec: FilterSpec, p: FilterPrim): TurbulenceParams {
  const bf = (p.attrs.get('baseFrequency') ?? '0').trim().split(/[\s,]+/);
  const fx = primLength(spec, bf[0], 0, 'x');
  const fy = primLength(spec, bf[1] ?? bf[0], 0, 'y');
  const oct = parseFloat(p.attrs.get('numOctaves') ?? '1');
  const seed = parseFloat(p.attrs.get('seed') ?? '0');
  return {
    // A negative frequency is meaningless and the spec calls it an error; treat
    // it as zero rather than mirroring the lattice.
    baseFreqX: fx > 0 ? fx : 0,
    baseFreqY: fy > 0 ? fy : 0,
    numOctaves: Number.isFinite(oct) ? Math.max(0, Math.floor(oct)) : 1,
    seed: Number.isFinite(seed) ? seed : 0,
    fractalSum: p.attrs.get('type') === 'fractalNoise',
    stitch: p.attrs.get('stitchTiles') === 'stitch',
    tile: p.sub,
  };
}

/** The <feDistantLight>/<fePointLight>/<feSpotLight> child, if any. */
function lightSourceOf(p: FilterPrim): LightSource | null {
  const n = (k: string, d: number, node: XmlNode): number => {
    const v = parseFloat(node.attrs.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  for (const c of p.node.children) {
    if (c.name === 'feDistantLight')
      return { kind: 'distant', azimuth: n('azimuth', 0, c), elevation: n('elevation', 0, c) };
    if (c.name === 'fePointLight')
      return { kind: 'point', x: n('x', 0, c), y: n('y', 0, c), z: n('z', 0, c) };
    if (c.name === 'feSpotLight') {
      const cone = c.attrs.get('limitingConeAngle');
      const coneN = parseFloat(cone ?? '');
      return {
        kind: 'spot',
        x: n('x', 0, c), y: n('y', 0, c), z: n('z', 0, c),
        pointsAtX: n('pointsAtX', 0, c), pointsAtY: n('pointsAtY', 0, c),
        pointsAtZ: n('pointsAtZ', 0, c),
        specularExponent: n('specularExponent', 1, c),
        limitingConeAngle: Number.isFinite(coneN) ? coneN : undefined,
      };
    }
  }
  return null;
}

function lightingParams(p: FilterPrim, specular: boolean): LightingParams | null {
  const light = lightSourceOf(p);
  if (!light) return null;
  const num = (k: string, d: number): number => {
    const v = parseFloat(p.attrs.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const c = parseColor(p.attrs.get('lighting-color') ?? 'white');
  // lighting-color arrives as sRGB 0..1; the kernel works in the primitive's
  // own space, which runFilter converts back out of afterwards.
  const conv = p.space === 'sRGB' ? (v: number) => v : srgbToLinear;
  const color: [number, number, number] = c
    ? [conv(c[0]), conv(c[1]), conv(c[2])]
    : [1, 1, 1];
  return {
    specular,
    surfaceScale: num('surfaceScale', 1),
    constant: specular ? num('specularConstant', 1) : num('diffuseConstant', 1),
    specularExponent: num('specularExponent', 1),
    color,
    light,
  };
}

const CHANNEL: Record<string, number> = { R: 0, G: 1, B: 2, A: 3 };

/** SVG 1.1 §15.7.9. The displacement MAP is read UNPREMULTIPLIED — it encodes
 *  vectors, not colour — while the displaced input stays premultiplied.
 *
 *  P'(x,y) <- P(x + scale*(XC(x,y) - 0.5), y + scale*(YC(x,y) - 0.5)). */
function displacementKernel(
  input: Surface, map: Surface, p: FilterPrim, scalePx: number, W: number, H: number,
): Surface {
  const out = makeSurface(0, 0, W, H);
  const xc = CHANNEL[p.attrs.get('xChannelSelector') ?? 'A'] ?? 3;
  const yc = CHANNEL[p.attrs.get('yChannelSelector') ?? 'A'] ?? 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = (y * W + x) * 4;
      const ma = map.data[m + 3];
      const chan = (c: number): number =>
        (c === 3 ? ma : (ma > 0 ? map.data[m + c] / ma : 0));
      const sx = Math.round(x + scalePx * (chan(xc) - 0.5));
      const sy = Math.round(y + scalePx * (chan(yc) - 0.5));
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;   // transparent black
      const o = (y * W + x) * 4, s = (sy * W + sx) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = input.data[s + c];
    }
  }
  return out;
}

// ---------- The graph runner ----------

/** An infinite plane of one solid colour (SVG 1.1 15.7.3), as a full-region
 *  surface. `null` is the `none` paint: transparent black everywhere.
 *
 *  Seeded LINEAR and premultiplied, which is the OPPOSITE convention from
 *  floodKernel above. A flood is a primitive OUTPUT, built in that primitive's
 *  own working space and converted back by runFilter; a plane is a graph INPUT,
 *  and `results` holds linear surfaces that inSpace converts on demand.
 *  Building this one in sRGB would ship silently wrong gamma -- and no
 *  saturated primary could catch it, since srgbToLinear fixes 0 and 1. */
function planeSurface(c: Rgb | null, w: number, h: number): Surface {
  const s = makeSurface(0, 0, w, h);
  if (c === null) return s;
  const r = srgbToLinear(c[0]), g = srgbToLinear(c[1]), b = srgbToLinear(c[2]);
  // Opaque, so premultiplying by alpha = 1 is the identity.
  for (let i = 0; i < w * h; i++) s.data.set([r, g, b, 1], i * 4);
  return s;
}

/** Evaluate the primitive graph over a rasterized source.
 *
 *  `scale` is device pixels per user unit: every length-valued parameter
 *  arrives in user units and is multiplied by it here, so a kernel never sees a
 *  user unit and the raster's resolution never leaks into one.
 *
 *  Always RETURNS premultiplied linear RGBA over the whole filter region,
 *  whatever colour space individual primitives asked to work in. */
export function runFilter(
  spec: FilterSpec, source: Surface, scale: number,
  /** Pre-rasterized inputs the pure side cannot produce, keyed by the
   *  primitive's `result`. Only feImage reads it: this module rasterizes
   *  nothing, so an feImage's pixels must arrive from the walker. */
  extras?: Map<string, Surface>,
): Surface {
  const W = source.w, H = source.h;
  const results = new Map<string, Surface>();
  results.set('SourceGraphic', source);
  results.set('SourceAlpha', sourceAlpha(source));
  // Each result's own subregion, in pixels. Only feTile reads it — it repeats
  // its INPUT's subregion, which no other primitive needs to know.
  const whole: PixelBox = { x: 0, y: 0, w: W, h: H };
  const windows = new Map<string, PixelBox>();
  windows.set('SourceGraphic', whole);
  windows.set('SourceAlpha', whole);

  // FillPaint/StrokePaint: infinite planes of the element's own paint. Seeded
  // only when the chain names one -- a plane is W*H*4 floats, around 2.5 MB at
  // 400x400, which is not worth allocating for the chains that never ask.
  //
  // Deliberately NOT added to `windows`. A plane has infinite extent, so its
  // window is the whole region, which is already what feTile's `?? whole`
  // fallback gives it -- an explicit entry would be unreachable code that no
  // test can distinguish. Confirmed by mutation: deleting it changed nothing.
  if (spec.paint !== undefined) {
    const named = new Set<string>();
    for (const p of spec.prims) for (const v of primInputs(p)) named.add(v);
    if (named.has('FillPaint'))
      results.set('FillPaint', planeSurface(spec.paint.fill, W, H));
    if (named.has('StrokePaint'))
      results.set('StrokePaint', planeSurface(spec.paint.stroke, W, H));
  }

  /** A subregion in user space -> its pixel window inside the region raster. */
  const window = (sub: SegBBox): PixelBox => {
    const x = Math.round((sub.x - spec.region.x) * scale);
    const y = Math.round((sub.y - spec.region.y) * scale);
    return {
      x, y,
      w: Math.min(W - x, Math.round(sub.w * scale)),
      h: Math.min(H - y, Math.round(sub.h * scale)),
    };
  };

  let last: Surface = source;
  for (const p of spec.prims) {
    const inSpace = (key: string): Surface => {
      const s = results.get(key) ?? makeSurface(0, 0, W, H);
      return p.space === 'sRGB' ? convertSpace(s, 'sRGB') : s;
    };
    const win = window(p.sub);
    let raw: Surface;
    switch (p.name) {
      case 'feOffset':
        raw = offsetKernel(
          inSpace(p.in1),
          primLength(spec, p.attrs.get('dx'), 0, 'x') * scale,
          primLength(spec, p.attrs.get('dy'), 0, 'y') * scale);
        break;
      case 'feFlood':
        raw = floodKernel(p, win);
        break;
      case 'feMerge':
        raw = makeSurface(0, 0, W, H);
        for (const c of p.node.children) {
          if (c.name !== 'feMergeNode') continue;
          // An feMergeNode with no `in` takes SourceGraphic, not the previous
          // result: it is not a primitive and joins no implicit chain.
          over(raw, inSpace(c.attrs.get('in') ?? 'SourceGraphic'));
        }
        break;
      case 'feComposite':
        raw = compositeKernel(inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'), p, W, H);
        break;
      case 'feBlend':
        raw = blendKernel(
          inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'),
          p.attrs.get('mode') ?? 'normal', W, H);
        break;
      case 'feColorMatrix':
        raw = colorMatrixKernel(inSpace(p.in1), p, W, H);
        break;
      case 'feComponentTransfer':
        raw = componentTransferKernel(inSpace(p.in1), p, W, H);
        break;
      case 'feGaussianBlur': {
        const [sx, sy] = stdDev(spec, p, scale);
        raw = blurKernel(inSpace(p.in1), sx, sy);
        break;
      }
      case 'feDropShadow': {
        // Filter Effects 1 §9.6's shorthand: blur(offset(SourceAlpha)),
        // coloured by flood-*, with the source composited over it.
        const src = inSpace(p.in1);
        const [sx, sy] = stdDev(spec, p, scale);
        const shadow = offsetKernel(
          blurKernel(sourceAlpha(src), sx, sy),
          primLength(spec, p.attrs.get('dx'), 2, 'x') * scale,
          primLength(spec, p.attrs.get('dy'), 2, 'y') * scale);
        const tint = floodKernel(p, { x: 0, y: 0, w: W, h: H });
        // The tint cut to the shadow's alpha -- 'in' with the shadow as in2.
        raw = makeSurface(0, 0, W, H);
        for (let q = 0; q < W * H; q++) {
          const a = shadow.data[q * 4 + 3];
          for (let c = 0; c < 4; c++) raw.data[q * 4 + c] = tint.data[q * 4 + c] * a;
        }
        over(raw, src);
        break;
      }
      case 'feMorphology': {
        const rr = (p.attrs.get('radius') ?? '0').trim().split(/[\s,]+/);
        raw = morphologyKernel(
          inSpace(p.in1),
          primLength(spec, rr[0], 0, 'x') * scale,
          primLength(spec, rr[1] ?? rr[0], 0, 'y') * scale,
          p.attrs.get('operator') === 'dilate', W, H);
        break;
      }
      case 'feTile':
        raw = tileKernel(inSpace(p.in1), windows.get(p.in1) ?? whole, W, H);
        break;
      case 'feConvolveMatrix': {
        const cp = convolveParams(p.attrs);
        // resolveFilter already refused a malformed kernel, so the null branch
        // is unreachable -- but it must not silently pass the input through.
        raw = cp ? convolveKernel(inSpace(p.in1), cp, W, H) : makeSurface(0, 0, W, H);
        break;
      }
      case 'feTurbulence': {
        raw = makeSurface(win.x, win.y, win.w, win.h);
        raw.data.set(turbulenceSurface(
          turbulenceParams(spec, p), win, scale, spec.region.x, spec.region.y));
        break;
      }
      case 'feDiffuseLighting':
      case 'feSpecularLighting': {
        const lp = lightingParams(p, p.name === 'feSpecularLighting');
        // Unreachable: resolveFilter refuses a lighting primitive with no
        // light child, which has no defined result.
        raw = lp
          ? lightingSurface(inSpace(p.in1), lp, scale, spec.region.x, spec.region.y)
          : makeSurface(0, 0, W, H);
        break;
      }
      case 'feImage':
        // A missing extra is transparent black, never a pass-through of in1:
        // that would silently substitute the wrong picture. In practice
        // emitFiltered refuses the whole filter before reaching here.
        raw = extras?.get(p.result) ?? makeSurface(0, 0, W, H);
        break;
      case 'feDisplacementMap':
        raw = displacementKernel(
          inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'), p,
          primLength(spec, p.attrs.get('scale'), 0, 'x') * scale, W, H);
        break;
      default:
        // Unreachable: SUPPORTED in svgfilter.ts IS this switch's case list, so
        // a chain holding anything else never reaches a runner.
        raw = inSpace(p.in1);
    }
    // Place the kernel's output over the whole raster, clip it to the
    // primitive's subregion, then bring it back to the pipeline's linear space:
    // a later primitive may ask for either, and storing every result in one
    // space is what keeps the graph composable.
    const clipped = makeSurface(0, 0, W, H);
    place(raw, clipped);
    maskTo(clipped, win);
    last = p.space === 'sRGB' ? convertSpace(clipped, 'linearRGB') : clipped;
    results.set(p.result, last);
    windows.set(p.result, win);
  }
  return last;
}
