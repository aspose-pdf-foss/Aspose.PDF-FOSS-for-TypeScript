// feDiffuseLighting / feSpecularLighting (issue 1gg0.10.4). Its own module: the
// nine surface-normal kernels plus the light model would double svgfilterfx.ts.
//
// The nine kernels come from SVG 1.1 §15.7.16, which gives DISTINCT
// coefficients and normalisation factors for the interior, the four edges and
// the four corners. The interior-kernel-everywhere shortcut is visibly wrong on
// the one-pixel border, which is exactly where a lit bevel is read.
import { makeSurface, type Surface } from './svgfilterfx.js';

/** Alpha at (x, y), clamped to the surface. */
function A(a: Float32Array, w: number, h: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
  const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
  return a[cy * w + cx];
}

/** The surface normal at (x, y), from the alpha channel read as a height field.
 *
 *  Exported for its own test: the eight border cases are where implementations
 *  quietly diverge, and they are invisible on any fixture whose lit shape does
 *  not reach the edge. */
export function surfaceNormal(
  alpha: Float32Array, w: number, h: number, x: number, y: number, surfaceScale: number,
): [number, number, number] {
  const p = (dx: number, dy: number): number => A(alpha, w, h, x + dx, y + dy);
  const left = x === 0, right = x === w - 1;
  const top = y === 0, bottom = y === h - 1;

  let fx: number, fy: number;
  // Corners must be tested BEFORE edges: a corner pixel satisfies both.
  if (top && left) {
    fx = (2 / 3) * ((2 * p(1, 0) + p(1, 1)) - (2 * p(0, 0) + p(0, 1)));
    fy = (2 / 3) * ((2 * p(0, 1) + p(1, 1)) - (2 * p(0, 0) + p(1, 0)));
  } else if (top && right) {
    fx = (2 / 3) * ((2 * p(0, 0) + p(0, 1)) - (2 * p(-1, 0) + p(-1, 1)));
    fy = (2 / 3) * ((2 * p(0, 1) + p(-1, 1)) - (2 * p(0, 0) + p(-1, 0)));
  } else if (bottom && left) {
    fx = (2 / 3) * ((2 * p(1, 0) + p(1, -1)) - (2 * p(0, 0) + p(0, -1)));
    fy = (2 / 3) * ((2 * p(0, 0) + p(1, 0)) - (2 * p(0, -1) + p(1, -1)));
  } else if (bottom && right) {
    fx = (2 / 3) * ((2 * p(0, 0) + p(0, -1)) - (2 * p(-1, 0) + p(-1, -1)));
    fy = (2 / 3) * ((2 * p(0, 0) + p(-1, 0)) - (2 * p(0, -1) + p(-1, -1)));
  } else if (top) {
    fx = (1 / 3) * ((2 * p(1, 0) + p(1, 1)) - (2 * p(-1, 0) + p(-1, 1)));
    fy = (1 / 2) * ((p(-1, 1) + 2 * p(0, 1) + p(1, 1))
                  - (p(-1, 0) + 2 * p(0, 0) + p(1, 0)));
  } else if (bottom) {
    fx = (1 / 3) * ((2 * p(1, 0) + p(1, -1)) - (2 * p(-1, 0) + p(-1, -1)));
    fy = (1 / 2) * ((p(-1, 0) + 2 * p(0, 0) + p(1, 0))
                  - (p(-1, -1) + 2 * p(0, -1) + p(1, -1)));
  } else if (left) {
    fx = (1 / 2) * ((p(1, -1) + 2 * p(1, 0) + p(1, 1))
                  - (p(0, -1) + 2 * p(0, 0) + p(0, 1)));
    fy = (1 / 3) * ((2 * p(0, 1) + p(1, 1)) - (2 * p(0, -1) + p(1, -1)));
  } else if (right) {
    fx = (1 / 2) * ((p(0, -1) + 2 * p(0, 0) + p(0, 1))
                  - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1)));
    fy = (1 / 3) * ((2 * p(0, 1) + p(-1, 1)) - (2 * p(0, -1) + p(-1, -1)));
  } else {
    // Interior: the familiar Sobel pair, factor 1/4.
    fx = (1 / 4) * ((p(1, -1) + 2 * p(1, 0) + p(1, 1))
                  - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1)));
    fy = (1 / 4) * ((p(-1, 1) + 2 * p(0, 1) + p(1, 1))
                  - (p(-1, -1) + 2 * p(0, -1) + p(1, -1)));
  }

  const nx = -surfaceScale * fx;
  const ny = -surfaceScale * fy;
  const len = Math.hypot(nx, ny, 1);
  return [nx / len, ny / len, 1 / len];
}

export type LightSource =
  | { kind: 'distant'; azimuth: number; elevation: number }
  | { kind: 'point'; x: number; y: number; z: number }
  | { kind: 'spot'; x: number; y: number; z: number;
      pointsAtX: number; pointsAtY: number; pointsAtZ: number;
      specularExponent: number; limitingConeAngle?: number };

export interface LightingParams {
  specular: boolean;
  surfaceScale: number;
  /** diffuseConstant (kd) or specularConstant (ks). */
  constant: number;
  /** Specular only. */
  specularExponent: number;
  /** lighting-color, 0..1 in the primitive's working space. */
  color: [number, number, number];
  light: LightSource;
}

const DEG = Math.PI / 180;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The light vector L at a surface point, and the light's own weight.
 *
 *  SVG 1.1 §15.7.15: a spot light attenuates by (-L·S)^specularExponent and is
 *  cut off entirely outside limitingConeAngle. */
function lightAt(
  l: LightSource, x: number, y: number, z: number,
): { L: [number, number, number]; weight: number } {
  if (l.kind === 'distant') {
    const az = l.azimuth * DEG, el = l.elevation * DEG;
    return {
      L: [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)],
      weight: 1,
    };
  }
  const dx = l.x - x, dy = l.y - y, dz = l.z - z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const L: [number, number, number] = [dx / len, dy / len, dz / len];
  if (l.kind === 'point') return { L, weight: 1 };

  const sx = l.pointsAtX - l.x, sy = l.pointsAtY - l.y, sz = l.pointsAtZ - l.z;
  const slen = Math.hypot(sx, sy, sz) || 1;
  const minusLdotS = -((L[0] * sx + L[1] * sy + L[2] * sz) / slen);
  if (minusLdotS <= 0) return { L, weight: 0 };
  if (l.limitingConeAngle !== undefined
      && minusLdotS < Math.cos(Math.abs(l.limitingConeAngle) * DEG))
    return { L, weight: 0 };
  return { L, weight: Math.pow(minusLdotS, l.specularExponent) };
}

/** SVG 1.1 §15.7.14 / §15.7.18.
 *
 *  Diffuse output is OPAQUE; specular output takes alpha = max(r, g, b), which
 *  is what makes a highlight composite as a highlight rather than as a wash. */
export function lightingSurface(
  input: Surface, p: LightingParams, scale: number, originX: number, originY: number,
): Surface {
  const W = input.w, H = input.h;
  const out = makeSurface(input.x, input.y, W, H);
  // The height field is the input's ALPHA channel; colour plays no part.
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = input.data[i * 4 + 3];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const N = surfaceNormal(alpha, W, H, x, y, p.surfaceScale);
      // A light's coordinates are USER units; the surface is in pixels.
      const ux = originX + x / scale, uy = originY + y / scale;
      const uz = p.surfaceScale * alpha[y * W + x];
      const { L, weight } = lightAt(p.light, ux, uy, uz);

      const o = (y * W + x) * 4;
      if (!p.specular) {
        const ndotl = N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
        const k = p.constant * Math.max(0, ndotl) * weight;
        // Opaque, so premultiplied and straight coincide.
        out.data[o] = clamp01(k * p.color[0]);
        out.data[o + 1] = clamp01(k * p.color[1]);
        out.data[o + 2] = clamp01(k * p.color[2]);
        out.data[o + 3] = 1;
      } else {
        // The halfway vector H = (L + eye)/|L + eye|, with the eye at +Z.
        const hx = L[0], hy = L[1], hz = L[2] + 1;
        const hl = Math.hypot(hx, hy, hz) || 1;
        const ndoth = (N[0] * hx + N[1] * hy + N[2] * hz) / hl;
        const k = p.constant * Math.pow(Math.max(0, ndoth), p.specularExponent) * weight;
        const r = clamp01(k * p.color[0]);
        const g = clamp01(k * p.color[1]);
        const b = clamp01(k * p.color[2]);
        // SVG 1.1 §15.7.18 sets Sa = max(Sr, Sg, Sb), which means the Sx ALREADY
        // satisfy the premultiplied invariant Sx <= Sa. Multiplying by alpha a
        // second time double-darkens the highlight — a systematic ~12/255 bias
        // against Chrome, and the brightest channel never reaches saturation.
        out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b;
        out.data[o + 3] = Math.max(r, g, b);
      }
    }
  }
  return out;
}
