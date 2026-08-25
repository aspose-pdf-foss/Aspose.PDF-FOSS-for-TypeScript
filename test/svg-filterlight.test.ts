import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  surfaceNormal, lightingSurface, type LightingParams,
} from '../src/svgfilterlight.js';
import { makeSurface, type Surface } from '../src/svgfilterfx.js';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (a: number, b: number, d = 5) => expect(a).toBeCloseTo(b, d);

/** An alpha field with a constant gradient along x: A(x,y) = x / (w-1). */
function ramp(w: number, h: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = x / (w - 1);
  return a;
}

/** A field curved in BOTH axes: A(x,y) = ((x/(w-1))^2 + (y/(h-1))^2) / 2.
 *
 *  Two properties are needed to tell the nine kernels apart, and both were
 *  learned by watching the test fail:
 *
 *   * CURVATURE. On a linear ramp every kernel returns the same derivative —
 *     that is exactly what their differing normalisation factors are for — so a
 *     linear field cannot detect a missing edge case at all.
 *   * Curvature in BOTH axes. On a field varying only in x, the top-left corner
 *     kernel and the left-edge kernel produce identical `fx` (both reduce to
 *     2*(f1-f0)); only the y-derivative distinguishes them. */
function curve(w: number, h: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = x / (w - 1), u = y / (h - 1);
    a[y * w + x] = (t * t + u * u) / 2;
  }
  return a;
}

/** Squared distance between two normals — the corner/edge comparison needs the
 *  whole vector, since the two can agree on one component. */
const normalGap = (a: [number, number, number], b: [number, number, number]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const flat = (w: number, h: number, v = 0.5): Float32Array =>
  new Float32Array(w * h).fill(v);

describe('surfaceNormal', () => {
  it('is straight up on a flat surface', () => {
    const [nx, ny, nz] = surfaceNormal(flat(8, 8), 8, 8, 4, 4, 10);
    near(nx, 0); near(ny, 0); near(nz, 1);
  });

  it('tilts against an increasing-alpha gradient', () => {
    // Nx = -surfaceScale * dA/dx, so a surface rising to the right tilts left.
    const [nx, ny, nz] = surfaceNormal(ramp(8, 8), 8, 8, 4, 4, 10);
    expect(nx).toBeLessThan(0);
    near(ny, 0, 4);
    expect(nz).toBeGreaterThan(0);
  });

  it('is a unit vector everywhere, interior and border alike', () => {
    const a = ramp(8, 8);
    const spots: Array<[number, number]> = [
      [4, 4], [0, 0], [7, 0], [0, 7], [7, 7], [4, 0], [0, 4], [7, 4], [4, 7],
    ];
    for (const [x, y] of spots) {
      const [nx, ny, nz] = surfaceNormal(a, 8, 8, x, y, 6);
      near(Math.hypot(nx, ny, nz), 1, 5);
    }
  });

  it('matches the spec LEFT-EDGE kernel exactly, hand-computed', () => {
    // A 3x3 field whose middle COLUMN is 1 and outer columns 0.
    //
    // An "it differs from the interior value" assertion is not enough: the
    // interior kernel clamps its out-of-range samples at the border, which also
    // produces a different number. Only the exact value separates the two.
    //
    // SVG 1.1 §15.7.16, left column:
    //   fx = 1/2 * ((p(1,-1) + 2p(1,0) + p(1,1)) - (p(0,-1) + 2p(0,0) + p(0,1)))
    //      = 1/2 * ((1 + 2 + 1) - (0 + 0 + 0)) = 2
    // so with surfaceScale 1: N = normalize(-2, 0, 1).
    const a = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const [nx, ny, nz] = surfaceNormal(a, 3, 3, 0, 1, 1);
    const len = Math.hypot(2, 0, 1);
    near(nx, -2 / len, 5);
    near(ny, 0, 5);
    near(nz, 1 / len, 5);
    // The interior kernel with clamped sampling would give fx = 1, i.e.
    // nx = -1/sqrt(2) = -0.7071. Confirm we are NOT that.
    expect(Math.abs(nx + Math.SQRT1_2)).toBeGreaterThan(0.1);
  });

  it('matches the spec TOP-EDGE kernel exactly, hand-computed', () => {
    // The transpose of the case above: middle ROW 1, outer rows 0.
    //   fy = 1/2 * ((p(-1,1) + 2p(0,1) + p(1,1)) - (p(-1,0) + 2p(0,0) + p(1,0)))
    //      = 1/2 * ((1 + 2 + 1) - 0) = 2
    const a = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0]);
    const [nx, ny, nz] = surfaceNormal(a, 3, 3, 1, 0, 1);
    const len = Math.hypot(0, 2, 1);
    near(nx, 0, 5);
    near(ny, -2 / len, 5);
    near(nz, 1 / len, 5);
  });

  it('uses the CORNER kernels, not the edge ones', () => {
    // The whole vector, not just fx: on a field varying only in x the top-left
    // corner and the left edge agree on fx exactly, and differ only in fy.
    const a = curve(8, 8);
    const corner = surfaceNormal(a, 8, 8, 0, 0, 10);
    const edge = surfaceNormal(a, 8, 8, 0, 4, 10);
    expect(normalGap(corner, edge)).toBeGreaterThan(1e-6);
  });

  it('scales the tilt with surfaceScale', () => {
    const [a] = surfaceNormal(ramp(8, 8), 8, 8, 4, 4, 4);
    const [b] = surfaceNormal(ramp(8, 8), 8, 8, 4, 4, 16);
    expect(Math.abs(b)).toBeGreaterThan(Math.abs(a));
  });
});

/** A flat, fully opaque input: normals point straight up everywhere. */
function opaque(w: number, h: number): Surface {
  const s = makeSurface(0, 0, w, h);
  for (let p = 0; p < w * h; p++) s.data.set([0, 0, 0, 1], p * 4);
  return s;
}
const at = (s: Surface, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

const diffuse = (
  light: LightingParams['light'], over: Partial<LightingParams> = {},
): LightingParams => ({
  specular: false, surfaceScale: 1, constant: 1, specularExponent: 1,
  color: [1, 1, 1], light, ...over,
});

describe('lightingSurface — diffuse', () => {
  it('a distant light straight overhead gives kd * lightColor, fully opaque', () => {
    // Flat surface, N = (0,0,1); elevation 90 puts L = (0,0,1), so N.L = 1.
    const out = lightingSurface(
      opaque(8, 8), diffuse({ kind: 'distant', azimuth: 0, elevation: 90 }), 1, 0, 0);
    const p = at(out, 4, 4);
    expect(p[3]).toBeCloseTo(1, 5);        // diffuse output is always opaque
    expect(p[0]).toBeCloseTo(1, 4);
  });

  it('scales by diffuseConstant', () => {
    const out = lightingSurface(
      opaque(8, 8),
      diffuse({ kind: 'distant', azimuth: 0, elevation: 90 }, { constant: 0.25 }),
      1, 0, 0);
    expect(at(out, 4, 4)[0]).toBeCloseTo(0.25, 4);
  });

  it('a grazing light darkens the flat surface', () => {
    const out = lightingSurface(
      opaque(8, 8), diffuse({ kind: 'distant', azimuth: 0, elevation: 10 }), 1, 0, 0);
    expect(at(out, 4, 4)[0]).toBeLessThan(0.3);
  });

  it('clamps a negative N.L to zero rather than emitting negative light', () => {
    const out = lightingSurface(
      opaque(8, 8), diffuse({ kind: 'distant', azimuth: 0, elevation: -60 }), 1, 0, 0);
    expect(at(out, 4, 4)[0]).toBeCloseTo(0, 5);
  });

  it('multiplies by lighting-color per channel', () => {
    const out = lightingSurface(
      opaque(8, 8),
      diffuse({ kind: 'distant', azimuth: 0, elevation: 90 }, { color: [1, 0.5, 0] }),
      1, 0, 0);
    const p = at(out, 4, 4);
    expect(p[0]).toBeCloseTo(1, 4);
    expect(p[1]).toBeCloseTo(0.5, 4);
    expect(p[2]).toBeCloseTo(0, 4);
  });

  it('a point light is brightest directly beneath it', () => {
    const out = lightingSurface(
      opaque(16, 16), diffuse({ kind: 'point', x: 4, y: 4, z: 3 }), 1, 0, 0);
    expect(at(out, 4, 4)[0]).toBeGreaterThan(at(out, 14, 14)[0]);
  });
});

describe('lightingSurface — specular', () => {
  const spec = (over: Partial<LightingParams> = {}): LightingParams => ({
    specular: true, surfaceScale: 1, constant: 1, specularExponent: 2,
    color: [1, 1, 1], light: { kind: 'distant', azimuth: 0, elevation: 90 }, ...over,
  });

  it('alpha is max(r, g, b), not 1', () => {
    // The defining difference from diffuse: a specular result is transparent
    // where it is dark, so it composites as a highlight.
    const out = lightingSurface(opaque(8, 8), spec({ color: [1, 0.4, 0.2] }), 1, 0, 0);
    const p = at(out, 4, 4);
    // Stored premultiplied, so recover the straight components first.
    const a = p[3];
    expect(a).toBeGreaterThan(0);
    expect(a).toBeCloseTo(Math.max(p[0], p[1], p[2]) / a, 5);
  });

  it('a higher specularExponent narrows the highlight', () => {
    const wide = lightingSurface(
      opaque(16, 16),
      spec({ specularExponent: 1, light: { kind: 'point', x: 8, y: 8, z: 4 } }), 1, 0, 0);
    const tight = lightingSurface(
      opaque(16, 16),
      spec({ specularExponent: 32, light: { kind: 'point', x: 8, y: 8, z: 4 } }), 1, 0, 0);
    // Far from the highlight centre, the tight exponent must have fallen off more.
    expect(at(tight, 15, 15)[3]).toBeLessThan(at(wide, 15, 15)[3]);
  });

  it('a spot light outside its cone contributes nothing', () => {
    const out = lightingSurface(
      opaque(32, 32),
      spec({
        light: {
          kind: 'spot', x: 4, y: 4, z: 8,
          pointsAtX: 4, pointsAtY: 4, pointsAtZ: 0,
          specularExponent: 1, limitingConeAngle: 10,
        },
      }), 1, 0, 0);
    expect(at(out, 4, 4)[3]).toBeGreaterThan(0);
    expect(at(out, 30, 30)[3]).toBeCloseTo(0, 5);
  });
});

// ---------- Goldens ----------

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'svg-filter');

/** Mean absolute channel difference between our render of a committed fixture
 *  SVG and the browser-rendered golden beside it. Repeated from
 *  svg-filternoise.test.ts rather than shared: the two files are read
 *  independently and each should stand on its own. */
function meanDiff(name: string, size = 64): number {
  const src = readFileSync(join(FIX, `${name}.svg`));
  const p = Document.Open(
    buildSvgPdf({ mediaBox: [0, 0, size, size], content: '' })).Pages[0];
  p.AddSVGObject(new Uint8Array(src), [0, 0, size, size], { fit: 'fill', filterScale: 1 });
  const got = decodePng(Document.Open(p.Document.Save()).Pages[0].ToImage());
  const gold = decodePng(new Uint8Array(readFileSync(join(FIX, `${name}.png`))));
  let sum = 0, n = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    for (let c = 0; c < 3; c++) { sum += Math.abs(gold.at(x, y)[c] - got.at(x, y)[c]); n++; }
  return sum / n;
}

describe('lighting — against Chrome goldens', () => {
  // Chrome ONLY: resvg panics on these and aborts the process, so there is no
  // second engine. See fixtures/svg-filter/PROVENANCE.md — that is a stated
  // gap in independence, not an oversight.
  it('matches Chrome on feDiffuseLighting + feDistantLight', () => {
    expect(meanDiff('diffuse-distant')).toBeLessThan(12);
  });

  it('matches Chrome on fePointLight with a coloured light', () => {
    expect(meanDiff('diffuse-point')).toBeLessThan(12);
  });

  it('matches Chrome on feSpecularLighting + feSpotLight', () => {
    expect(meanDiff('specular-spot')).toBeLessThan(12);
  });
});
