// feTurbulence (issue 1gg0.10.4): the SVG 1.1 §15.7.20 Perlin generator, its
// own module because the lattice setup and the two accumulation rules would
// otherwise double svgfilterfx.ts.
//
// This is a transcription of the spec's published reference implementation, and
// deliberately keeps its names (uLatticeSelector, fGradient, s_curve, ...) so a
// reader can diff it against the spec line by line. It is EXACTLY the kind of
// port that cannot validate itself, which is why test/fixtures/svg-filter/
// holds browser-rendered goldens -- see that directory's PROVENANCE.md.

export interface TurbulenceParams {
  /** Per USER unit, not per pixel. */
  baseFreqX: number; baseFreqY: number;
  numOctaves: number;
  seed: number;
  /** type="fractalNoise" sums SIGNED noise; type="turbulence" sums |noise|. */
  fractalSum: boolean;
  stitch: boolean;
  /** The primitive subregion, in user units — the stitch tile. */
  tile: { x: number; y: number; w: number; h: number };
}

const BSize = 0x100;
const BM = 0xff;
const PerlinN = 0x1000;

const RAND_m = 2147483647;      // 2**31 - 1
const RAND_a = 16807;           // 7**5, a primitive root of m
const RAND_q = 127773;          // m / a
const RAND_r = 2836;            // m % a

function setupSeed(lSeed: number): number {
  let s = Math.floor(lSeed);
  if (s <= 0) s = -(s % (RAND_m - 1)) + 1;
  if (s > RAND_m - 1) s = RAND_m - 1;
  return s;
}

/** The spec's Park–Miller generator, written to avoid overflow past 2**31. */
function random(lSeed: number): number {
  const result = RAND_a * (lSeed % RAND_q) - RAND_r * Math.floor(lSeed / RAND_q);
  return result <= 0 ? result + RAND_m : result;
}

interface Lattice {
  uLatticeSelector: Int32Array;
  fGradient: Float64Array;
}

/** Flat index into fGradient[4][BSize+BSize+2][2]. */
const gi = (k: number, i: number, j: number): number =>
  (k * (BSize + BSize + 2) + i) * 2 + j;

function init(seed: number): Lattice {
  const uLatticeSelector = new Int32Array(BSize + BSize + 2);
  const fGradient = new Float64Array(4 * (BSize + BSize + 2) * 2);

  let lSeed = setupSeed(seed);
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < BSize; i++) {
      if (k === 0) uLatticeSelector[i] = i;
      let s = 0;
      const g: number[] = [];
      for (let j = 0; j < 2; j++) {
        lSeed = random(lSeed);
        const v = ((lSeed % (BSize + BSize)) - BSize) / BSize;
        g.push(v);
        s += v * v;
      }
      s = Math.sqrt(s);
      for (let j = 0; j < 2; j++) fGradient[gi(k, i, j)] = s === 0 ? 0 : g[j] / s;
    }
  }
  // Shuffle the lattice, then duplicate it so index + 1 never wraps.
  for (let i = BSize - 1; i > 0; i--) {
    lSeed = random(lSeed);
    const j = lSeed % BSize;
    const t = uLatticeSelector[i];
    uLatticeSelector[i] = uLatticeSelector[j];
    uLatticeSelector[j] = t;
  }
  for (let i = 0; i < BSize + 2; i++) {
    uLatticeSelector[BSize + i] = uLatticeSelector[i];
    for (let k = 0; k < 4; k++)
      for (let j = 0; j < 2; j++)
        fGradient[gi(k, BSize + i, j)] = fGradient[gi(k, i, j)];
  }
  return { uLatticeSelector, fGradient };
}

const sCurve = (t: number): number => t * t * (3 - 2 * t);
const lerp = (t: number, a: number, b: number): number => a + t * (b - a);

interface StitchInfo {
  /** Lattice cells per tile, per axis. */
  width: number; height: number;
  wrapX: number; wrapY: number;
}

/** One octave of 2-D Perlin noise for one colour channel. */
function noise2(
  L: Lattice, nColorChannel: number, vx: number, vy: number, stitch: StitchInfo | null,
): number {
  const t0 = vx + PerlinN;
  let bx0 = Math.floor(t0);
  let bx1 = bx0 + 1;
  const rx0 = t0 - Math.floor(t0);
  const rx1 = rx0 - 1;

  const t1 = vy + PerlinN;
  let by0 = Math.floor(t1);
  let by1 = by0 + 1;
  const ry0 = t1 - Math.floor(t1);
  const ry1 = ry0 - 1;

  if (stitch) {
    // Wrap the lattice indices back into the tile so opposite edges agree.
    if (bx0 >= stitch.wrapX) bx0 -= stitch.width;
    if (bx1 >= stitch.wrapX) bx1 -= stitch.width;
    if (by0 >= stitch.wrapY) by0 -= stitch.height;
    if (by1 >= stitch.wrapY) by1 -= stitch.height;
  }
  bx0 &= BM; bx1 &= BM; by0 &= BM; by1 &= BM;

  const i = L.uLatticeSelector[bx0];
  const j = L.uLatticeSelector[bx1];
  const b00 = L.uLatticeSelector[i + by0];
  const b10 = L.uLatticeSelector[j + by0];
  const b01 = L.uLatticeSelector[i + by1];
  const b11 = L.uLatticeSelector[j + by1];

  const sx = sCurve(rx0);
  const sy = sCurve(ry0);
  const k = nColorChannel;

  let u = rx0 * L.fGradient[gi(k, b00, 0)] + ry0 * L.fGradient[gi(k, b00, 1)];
  let v = rx1 * L.fGradient[gi(k, b10, 0)] + ry0 * L.fGradient[gi(k, b10, 1)];
  const a = lerp(sx, u, v);
  u = rx0 * L.fGradient[gi(k, b01, 0)] + ry1 * L.fGradient[gi(k, b01, 1)];
  v = rx1 * L.fGradient[gi(k, b11, 0)] + ry1 * L.fGradient[gi(k, b11, 1)];
  const b = lerp(sx, u, v);
  return lerp(sy, a, b);
}

/** The base frequency adjusted so the tile holds a whole number of lattice
 *  cells. Without this the seam cannot line up, which is the whole point of
 *  stitchTiles. */
function stitchFreq(bf: number, span: number): number {
  if (bf === 0 || span <= 0) return bf;
  const lo = Math.floor(span * bf) / span;
  const hi = Math.ceil(span * bf) / span;
  if (lo === 0) return hi;
  return bf / lo < hi / bf ? lo : hi;
}

/** Sum the octaves at one point. Returns the spec's raw value: roughly -1..1
 *  for fractalSum, non-negative for turbulence. */
function turbulence(
  L: Lattice, nColorChannel: number, x: number, y: number, p: TurbulenceParams,
): number {
  let bfx = p.baseFreqX, bfy = p.baseFreqY;
  let stitch: StitchInfo | null = null;

  if (p.stitch) {
    bfx = stitchFreq(bfx, p.tile.w);
    bfy = stitchFreq(bfy, p.tile.h);
    const width = Math.round(p.tile.w * bfx);
    const height = Math.round(p.tile.h * bfy);
    stitch = {
      width, height,
      wrapX: Math.round(p.tile.x * bfx) + PerlinN + width,
      wrapY: Math.round(p.tile.y * bfy) + PerlinN + height,
    };
  }

  let sum = 0;
  let vx = x * bfx, vy = y * bfy;
  let ratio = 1;
  for (let o = 0; o < p.numOctaves; o++) {
    const n = noise2(L, nColorChannel, vx, vy, stitch);
    sum += (p.fractalSum ? n : Math.abs(n)) / ratio;
    vx *= 2; vy *= 2; ratio *= 2;
    if (stitch) {
      // Each octave doubles the lattice density, so the tile spans twice as
      // many cells and the wrap points move with it.
      stitch = {
        width: stitch.width * 2, height: stitch.height * 2,
        wrapX: 2 * stitch.wrapX - PerlinN,
        wrapY: 2 * stitch.wrapY - PerlinN,
      };
    }
  }
  return sum;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Generate premultiplied linear RGBA over `win`.
 *
 *  The noise is a function of USER-space coordinates, so the pixel grid is
 *  mapped back through `scale` and the region origin. Getting that wrong makes
 *  the field shift when filterScale changes. */
export function turbulenceSurface(
  p: TurbulenceParams, win: { x: number; y: number; w: number; h: number },
  scale: number, originX: number, originY: number,
): Float32Array {
  const L = init(p.seed);
  const out = new Float32Array(Math.max(0, win.w) * Math.max(0, win.h) * 4);
  const params: TurbulenceParams = {
    ...p, numOctaves: Math.max(0, Math.floor(p.numOctaves)),
  };

  for (let iy = 0; iy < win.h; iy++) {
    // Sample at pixel CENTRES: the half-pixel matters at high frequency, and it
    // is what the reference rasterizers do.
    const uy = originY + (win.y + iy + 0.5) / scale;
    for (let ix = 0; ix < win.w; ix++) {
      const ux = originX + (win.x + ix + 0.5) / scale;
      const o = (iy * win.w + ix) * 4;
      const ch: number[] = [];
      for (let c = 0; c < 4; c++) {
        const raw = turbulence(L, c, ux, uy, params);
        // fractalSum maps [-1,1] -> [0,1]; turbulence is already non-negative.
        ch.push(clamp01(params.fractalSum ? (raw + 1) / 2 : raw));
      }
      const a = ch[3];
      out[o] = ch[0] * a; out[o + 1] = ch[1] * a; out[o + 2] = ch[2] * a;
      out[o + 3] = a;
    }
  }
  return out;
}
