# SVG `<filter>` — convolve, displacement, feImage, turbulence, lighting (phase 4 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete SVG 1.1's filter primitive set — `feConvolveMatrix`, `feDisplacementMap`, `feImage`, `feTurbulence`, and `feDiffuseLighting`/`feSpecularLighting` with all three light sources.

**Architecture:** Three of the five are ordinary pure kernels appended to `svgfilterfx.ts`'s existing switch. `feImage` is the only one needing new plumbing: it consumes pixels the pure side cannot produce, so the walker pre-rasterizes its reference and passes it in through a new `extras` map. `feTurbulence` and the lighting pair are large enough to earn their own modules, and are the only two validated against browser-rendered goldens.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies. Golden generation uses `tsx`, `puppeteer` and `@resvg/resvg-js` installed with `--no-save`, exactly as `scripts/gen-svg-goldens.ts` does.

**Spec:** `docs/superpowers/specs/2026-07-30-svg-masks-filters-markers-design.md` — section "3. `<filter>`" and "Phase 4 decisions (decided 2026-07-31)".

**Issue:** `aspose-pdf-foss-for-ts-1gg0.10.4` (phase 4 child of `1gg0.10`). Branch `feat/svg-filter-kernels`, already created off `main`.

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps. The golden generator's packages are installed `--no-save` and must never appear in `package.json` or `package-lock.json` — verify with `git status --short -- package.json package-lock.json` before committing.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must both be green before any task is considered done.
- `src/svgdraw.ts` and every `svgfilter*.ts` module allocate **nothing**. Rasters reach the walker through `SvgRasterSink`, implemented only in `src/svgembed.ts`.
- SVG content is emitted **y-DOWN**; `flipRows` in `svgfilterfx.ts` is the one bridge to the rasterizer's y-up output. Never add a second flip.
- Surfaces hold **premultiplied linear RGBA**. `feColorMatrix` and `feComponentTransfer` are the only kernels that unpremultiply; the ones in this plan are premultiplied except where noted (`feDisplacementMap` samples channels directly; lighting reads the **alpha** channel only).
- Errors: `TypeError` for rejected public options, before allocation. Anything unrenderable degrades and is reported through `result.skipped`. Never throw for bad SVG.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### Invariants carried forward from phase 3

1. **`SUPPORTED` in `svgfilter.ts` equals the kernel table in `svgfilterfx.ts`'s `runFilter` switch**, extended in the *same commit* as each kernel. A name listed before its kernel exists passes its input through untouched — plausible ink that is silently wrong.
2. **A filter chain is all-or-nothing.** Any unsupported primitive, unresolvable `in`, or failed pre-rasterization makes the element draw **unfiltered** and report. Partial evaluation produces confidently wrong ink.
3. **`flipRows` is load-bearing.** Vertical parameters mirror without it, and a vertically symmetric fixture cannot detect that.
4. **A subregion clip needs a full-raster kernel to test it.** `feFlood` only writes its own window, so it passes with `maskTo` deleted.

### Measured constraints on the goldens — do not re-litigate these

Both were measured on 2026-07-31 against Chrome 150 headless-shell and `@resvg/resvg-js` 2.6.2. They are why the fixtures look the way they do.

| Constraint | Evidence |
|---|---|
| Turbulence goldens use `baseFrequency ≤ 0.05` | Chrome-vs-resvg mean channel difference: **30.9**/255 at bf 0.5, **12.0** at 0.15, **3.8** at 0.05, **1.7** at 0.02. Same noise function, different sub-pixel sampling. High-frequency fixtures cannot be reconciled by any tolerance. |
| Lighting goldens are **Chrome-only** | resvg panics in `resvg/src/filter/lighting.rs:141` (`assertion failed: src.width == dest.width`) and the panic **aborts the process** — it cannot be caught. The generator must not invoke resvg for those fixtures. |
| Lighting fixture constants must stay discriminating | A white light at `specularExponent="20"` produced only **2 distinct output levels** — a golden that would pass against nearly any implementation. Choose constants that yield a visible gradient. |

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svgfilterfx.ts` | modify | `feConvolveMatrix`, `feDisplacementMap`, `feImage` kernels; `runFilter` gains `extras`. |
| `src/svgfilternoise.ts` | **create** | `feTurbulence` — the SVG 1.1 §15.7.20 Perlin generator. Self-contained. |
| `src/svgfilterlight.ts` | **create** | `feDiffuseLighting`/`feSpecularLighting`, the nine surface-normal kernels, the three light sources. |
| `src/svgfilter.ts` | modify | `SUPPORTED` grows per commit; `feImage` href-shape validation. |
| `src/svgdraw.ts` | modify | `emitFiltered` pre-rasterizes each `feImage` reference into the `extras` map. |
| `scripts/gen-filter-goldens.ts` | **create** | Renders the turbulence and lighting fixtures to `test/fixtures/svg-filter/`. Not run by `npm test`. |
| `test/fixtures/svg-filter/` | **create** | Committed golden PNGs + `PROVENANCE.md`. |
| `test/svg-filterfx.test.ts` | modify | Convolve, displacement, feImage kernels. |
| `test/svg-filternoise.test.ts` | **create** | Turbulence structure + the golden diff. |
| `test/svg-filterlight.test.ts` | **create** | Normals, light vectors + the golden diff. |
| `test/svg-filter-render.test.ts` | modify | `feImage` end-to-end through `Save`/`Open`/`ToImage`. |
| `README.md` | modify | The filter bullet gains the five primitives. |

## Shared Interfaces

```ts
// src/svgfilterfx.ts — the ONE signature change in this phase
export function runFilter(
  spec: FilterSpec, source: Surface, scale: number,
  /** Pre-rasterized inputs the pure side cannot produce, keyed by the
   *  primitive's `result`. Only feImage reads it. */
  extras?: Map<string, Surface>,
): Surface;
```

```ts
// src/svgfilternoise.ts
export interface TurbulenceParams {
  baseFreqX: number; baseFreqY: number;   // per USER unit
  numOctaves: number;
  seed: number;
  fractalSum: boolean;                    // type="fractalNoise"
  stitch: boolean;                        // stitchTiles="stitch"
  tile: { x: number; y: number; w: number; h: number };   // user units
}
/** Premultiplied linear RGBA over `win`, generated in user space. `scale` is
 *  device pixels per user unit; `originX/Y` are the region's user-space origin. */
export function turbulenceSurface(
  p: TurbulenceParams, win: { x: number; y: number; w: number; h: number },
  scale: number, originX: number, originY: number,
): Float32Array;
```

```ts
// src/svgfilterlight.ts
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
  /** lighting-color, 0..1 linear RGB. */
  color: [number, number, number];
  light: LightSource;
}

/** Surface normal at (x, y) from the alpha channel, per SVG 1.1 §15.7.16's
 *  NINE kernels — interior, four edges, four corners. Exported for its own
 *  test: the edge cases are where implementations quietly diverge. */
export function surfaceNormal(
  alpha: Float32Array, w: number, h: number, x: number, y: number, surfaceScale: number,
): [number, number, number];

export function lightingSurface(
  input: Surface, p: LightingParams, scale: number, originX: number, originY: number,
): Surface;
```

---
---

# Commit A — `feConvolveMatrix` and `feDisplacementMap`

Two ordinary pure kernels. Both have exactly enumerable results on a known input, so neither needs a golden.

---

## Task 1: `feConvolveMatrix`

**Files:**
- Modify: `src/svgfilterfx.ts`, `src/svgfilter.ts`
- Test: `test/svg-filterfx.test.ts` (append)

**Interfaces:**
- Consumes: `Surface`, `makeSurface`, `clamp01`, `FilterPrim`, `primLength`.
- Produces: no new export; a `feConvolveMatrix` case in `runFilter`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filterfx.test.ts`. `source()` is the existing 10×10 fixture with an opaque white 2×2 at the top-left.

```ts
describe('runFilter — feConvolveMatrix', () => {
  it('an identity kernel leaves the input alone', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" kernelMatrix="0 0 0  0 1 0  0 0 0"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);
    near(px(out, 1, 1)[3], 1, 5);
    near(px(out, 5, 5)[3], 0, 5);
  });

  it('a shift kernel translates by one pixel', () => {
    // kernelMatrix is applied ROTATED 180 degrees (SVG 1.1 15.7.5's formula
    // subtracts the kernel index), so a 1 in the top-left moves ink DOWN-RIGHT.
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" kernelMatrix="1 0 0  0 0 0  0 0 0"/>'), source(), 1);
    near(px(out, 2, 2)[3], 1, 5);
    near(px(out, 0, 0)[3], 0, 5);
  });

  it('divides by the kernel sum by default', () => {
    // A 3x3 box over a 2x2 opaque block: the centre of a fully covered
    // neighbourhood is impossible here, so take (0,0): its 3x3 window holds
    // exactly 4 opaque pixels of 9.
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 4 / 9, 4);
  });

  it('honours an explicit divisor', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" divisor="4" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 4);          // 4/4, clamped at 1
  });

  it('adds bias', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" bias="0.25" ' +
      'kernelMatrix="0 0 0  0 0 0  0 0 0"/>'), source(), 1);
    near(px(out, 5, 5)[3], 0.25, 4);
  });

  it('preserveAlpha=true leaves alpha untouched', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" preserveAlpha="true" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);          // original alpha survives
  });

  it('edgeMode=none treats outside as transparent black', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" edgeMode="none" divisor="1" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 4);          // 4 opaque neighbours, clamped
  });

  it('rejects a kernelMatrix whose length does not match order', () => {
    // A malformed kernel makes the whole chain refuse rather than guess.
    const r = resolveFilter(
      nodeOfFilter('<feConvolveMatrix order="3" kernelMatrix="1 2 3"/>'),
      { x: 0, y: 0, w: 10, h: 10 }, VP);
    expect(r.kind).toBe('skip');
  });
});
```

`nodeOfFilter` is a new helper — add it beside `specSized`:

```ts
/** The <filter> element of a fixture, for tests that assert a REFUSAL and so
 *  cannot go through specSized (which throws on anything but 'draw'). */
function nodeOfFilter(prims: string, size = 10): XmlNode {
  const root = parseXml(xmlBytes(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="${size}" height="${size}">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return f!;
}
```

Add `resolveFilter` to the existing import from `../src/svgfilter.js` if it is not already there (it is — `specSized` uses it).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: FAIL — `specOf` throws `expected draw, got skip`, because `feConvolveMatrix` is not in `SUPPORTED`.

- [ ] **Step 3: Write the implementation**

Add to `src/svgfilterfx.ts`, before the graph runner:

```ts
/** feConvolveMatrix's parsed parameters, or null when the element is malformed
 *  — a kernel whose length disagrees with `order` cannot be guessed at, and the
 *  chain refuses rather than inventing one. */
interface ConvolveParams {
  ox: number; oy: number;
  kernel: number[];
  divisor: number;
  bias: number;
  targetX: number; targetY: number;
  edgeMode: 'duplicate' | 'wrap' | 'none';
  preserveAlpha: boolean;
}

export function convolveParams(attrs: Map<string, string>): ConvolveParams | null {
  const ord = (attrs.get('order') ?? '3').trim().split(/[\s,]+/).map(Number);
  const ox = Math.floor(ord[0]);
  const oy = Math.floor(ord.length > 1 ? ord[1] : ord[0]);
  if (!(ox > 0) || !(oy > 0)) return null;
  const kernel = (attrs.get('kernelMatrix') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  if (kernel.length !== ox * oy) return null;

  const sum = kernel.reduce((a, b) => a + b, 0);
  const dRaw = parseFloat(attrs.get('divisor') ?? '');
  // SVG 1.1 §15.7.5: default is the kernel sum, or 1 when that sum is zero. An
  // explicit divisor of 0 is an error and falls back the same way.
  const divisor = Number.isFinite(dRaw) && dRaw !== 0 ? dRaw : (sum !== 0 ? sum : 1);

  const bRaw = parseFloat(attrs.get('bias') ?? '');
  const tX = parseFloat(attrs.get('targetX') ?? '');
  const tY = parseFloat(attrs.get('targetY') ?? '');
  // The default target is the kernel's centre, floored.
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

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const alpha = c.preserveAlpha
        ? input.data[o + 3]
        : clamp01(accumulate(3) / c.divisor + c.bias);
      for (let ch = 0; ch < 3; ch++) {
        const v = clamp01(accumulate(ch) / c.divisor + c.bias);
        // preserveAlpha convolved straight colour, so re-premultiply.
        out.data[o + ch] = c.preserveAlpha ? v * alpha : v;
      }
      out.data[o + 3] = alpha;

      function accumulate(ch: number): number {
        let sum = 0;
        for (let j = 0; j < c.oy; j++) {
          for (let i = 0; i < c.ox; i++) {
            sum += at(x - c.targetX + i, y - c.targetY + j, ch)
                 * c.kernel[(c.oy - j - 1) * c.ox + (c.ox - i - 1)];
          }
        }
        return sum;
      }
    }
  }
  return out;
}
```

Add the `switch` case in `runFilter`:

```ts
      case 'feConvolveMatrix': {
        const cp = convolveParams(p.attrs);
        // resolveFilter already refused a malformed kernel, so this is
        // unreachable — but a null here must not silently pass the input on.
        raw = cp ? convolveKernel(inSpace(p.in1), cp, W, H) : makeSurface(0, 0, W, H);
        break;
      }
```

In `src/svgfilter.ts`, add `'feConvolveMatrix'` to `SUPPORTED` **and** refuse a malformed one during resolution, so the all-or-nothing invariant holds. Add near the top:

```ts
import { convolveParams } from './svgfilterfx.js';
```

**Do not do that** — it would close an import cycle (`svgfilterfx.ts` already imports `svgfilter.ts`). Instead validate inline in `resolveFilter`'s primitive loop, right after the `SUPPORTED` check:

```ts
    // A malformed feConvolveMatrix cannot be guessed at: an order/kernelMatrix
    // mismatch, or a target outside the kernel, makes the whole chain refuse.
    if (k.name === 'feConvolveMatrix' && !validConvolve(k.attrs))
      return { kind: 'skip', report: ['feConvolveMatrix'] };
```

with, above `resolveFilter`:

```ts
/** Whether an feConvolveMatrix's order/kernelMatrix/target agree. Duplicated
 *  deliberately rather than imported from svgfilterfx.ts, which already imports
 *  THIS module — the alternative is an import cycle for six lines of arithmetic. */
function validConvolve(attrs: Map<string, string>): boolean {
  const ord = (attrs.get('order') ?? '3').trim().split(/[\s,]+/).map(Number);
  const ox = Math.floor(ord[0]);
  const oy = Math.floor(ord.length > 1 ? ord[1] : ord[0]);
  if (!(ox > 0) || !(oy > 0)) return false;
  const k = (attrs.get('kernelMatrix') ?? '').trim().split(/[\s,]+/)
    .map(Number).filter((n) => Number.isFinite(n));
  if (k.length !== ox * oy) return false;
  const tX = parseFloat(attrs.get('targetX') ?? '');
  const tY = parseFloat(attrs.get('targetY') ?? '');
  if (Number.isFinite(tX) && (tX < 0 || tX >= ox)) return false;
  if (Number.isFinite(tY) && (tY < 0 || tY >= oy)) return false;
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

---

## Task 2: `feDisplacementMap`

**Files:**
- Modify: `src/svgfilterfx.ts`, `src/svgfilter.ts`
- Test: `test/svg-filterfx.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
describe('runFilter — feDisplacementMap', () => {
  /** A displacement map flooded with a known constant, displacing the source. */
  const disp = (color: string, attrs: string) =>
    `<feFlood flood-color="${color}" result="d" ` +
    'color-interpolation-filters="sRGB"/>' +
    `<feDisplacementMap in="SourceGraphic" in2="d" ${attrs} ` +
    'color-interpolation-filters="sRGB"/>';

  it('a mid-grey map displaces nothing', () => {
    // SVG 1.1 15.7.9: the shift is scale * (C - 0.5), so C = 0.5 is neutral.
    const out = runFilter(specOf(
      disp('#808080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 1, 3);
    near(px(out, 4, 4)[3], 0, 3);
  });

  it('displaces by scale * (C - 0.5) along x', () => {
    // R = 1.0 -> +0.5 * scale = +4 px. Sampling moves the SOURCE left-to-right:
    // the output at (4,0) reads the source at (0,0).
    const out = runFilter(specOf(
      disp('#ff8080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 0, 3);
    near(px(out, 4, 0)[3], 1, 3);
  });

  it('selects the channel named by yChannelSelector', () => {
    // B = 1.0 drives y when yChannelSelector="B".
    const out = runFilter(specOf(
      disp('#8080ff', 'scale="8" xChannelSelector="R" yChannelSelector="B"')),
      source(), 1);
    near(px(out, 0, 4)[3], 1, 3);
  });

  it('defaults both selectors to A', () => {
    // An opaque flood has A = 1, so both axes shift by +scale/2.
    const out = runFilter(specOf(disp('#808080', 'scale="8"')), source(), 1);
    near(px(out, 4, 4)[3], 1, 3);
  });

  it('is the identity at scale 0', () => {
    const out = runFilter(specOf(
      disp('#ff0000', 'scale="0" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 1, 3);
  });

  it('samples outside the source as transparent black', () => {
    const out = runFilter(specOf(
      disp('#008080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    // R = 0 -> -4 px: every output pixel reads 4 to its right, so the 2x2 block
    // at the origin can only appear at negative x, i.e. nowhere.
    for (let x = 0; x < 10; x++) near(px(out, x, 0)[3], 0, 3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: FAIL — `expected draw, got skip`.

- [ ] **Step 3: Write the implementation**

```ts
const CHANNEL: Record<string, number> = { R: 0, G: 1, B: 2, A: 3 };

/** SVG 1.1 §15.7.9. The displacement map is read UNPREMULTIPLIED — it encodes
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
        c === 3 ? ma : (ma > 0 ? map.data[m + c] / ma : 0);
      const sx = Math.round(x + scalePx * (chan(xc) - 0.5));
      const sy = Math.round(y + scalePx * (chan(yc) - 0.5));
      const o = (y * W + x) * 4;
      if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;   // transparent black
      const s = (sy * W + sx) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = input.data[s + c];
    }
  }
  return out;
}
```

`switch` case:

```ts
      case 'feDisplacementMap':
        raw = displacementKernel(
          inSpace(p.in1), inSpace(p.in2 || 'SourceGraphic'), p,
          primLength(spec, p.attrs.get('scale'), 0, 'x') * scale, W, H);
        break;
```

Add `'feDisplacementMap'` to `SUPPORTED`.

- [ ] **Step 4: Run the tests to verify they pass**
- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Prove the assertions are load-bearing**

Break each, confirm red, revert:

1. In `convolveKernel`'s `accumulate`, index the kernel forwards (`j * c.ox + i`) instead of rotated → "a shift kernel translates by one pixel" must fail.
2. In `convolveParams`, default `divisor` to 1 instead of the kernel sum → "divides by the kernel sum by default" must fail.
3. In `displacementKernel`, drop the `- 0.5` → "a mid-grey map displaces nothing" must fail.
4. In `displacementKernel`, read the map premultiplied (`map.data[m + c]` with no divide) → "displaces by scale * (C - 0.5) along x" must fail (the flood is opaque, so make the fixture semi-transparent if it does not — note it and add `flood-opacity="0.5"`).

- [ ] **Step 7: Commit**

```bash
git add src/svgfilterfx.ts src/svgfilter.ts test/svg-filterfx.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): feConvolveMatrix and feDisplacementMap

Two pure kernels, both with exactly enumerable results on a known input, so
neither needs a golden.

feConvolveMatrix applies its kernel ROTATED 180 degrees -- SVG 1.1 15.7.5
subtracts the kernel index rather than adding it -- so a 1 in the top-left cell
translates ink down and right. A kernelMatrix whose length disagrees with
`order`, or a target outside the kernel, makes the whole chain refuse rather
than guess; that check is duplicated in svgfilter.ts rather than imported,
since svgfilterfx.ts already imports svgfilter.ts and the alternative is an
import cycle for six lines of arithmetic.

feDisplacementMap reads its MAP unpremultiplied -- the map encodes vectors, not
colour -- while the displaced input stays premultiplied.

Refs: aspose-pdf-foss-for-ts-1gg0.10.4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
---

# Commit B — `feImage`

The only primitive needing new plumbing. Both reference kinds are pre-rasterized by the walker and handed to the graph as ready-made surfaces.

---

## Task 3: The `extras` seam and the `feImage` kernel

**Files:**
- Modify: `src/svgfilterfx.ts` (`runFilter` signature, `feImage` case)
- Modify: `src/svgfilter.ts` (`SUPPORTED`, href-shape validation)
- Test: `test/svg-filterfx.test.ts` (append)

**Interfaces:**
- Produces: `runFilter(spec, source, scale, extras?)`.

- [ ] **Step 1: Write the failing test**

```ts
describe('runFilter — feImage', () => {
  /** A 4x4 opaque red surface, as the walker would have pre-rasterized it. */
  function redPatch(): Surface {
    const s = makeSurface(0, 0, 10, 10);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      s.data.set([1, 0, 0, 1], (y * 10 + x) * 4);
    return s;
  }

  it('places the surface the walker pre-rasterized for it', () => {
    const spec = specOf('<feImage href="#el"/>');
    const extras = new Map([[spec.prims[0].result, redPatch()]]);
    const out = runFilter(spec, source(), 1, extras);
    near(px(out, 1, 1)[0], 1, 4);
    near(px(out, 1, 1)[3], 1, 4);
    near(px(out, 8, 8)[3], 0, 4);
  });

  it('produces transparent black when the walker supplied nothing', () => {
    // Unreachable in practice: emitFiltered refuses the whole filter when a
    // reference cannot be rasterized. Asserted so a future caller cannot make
    // a missing extra look like deliberate emptiness.
    const out = runFilter(specOf('<feImage href="#el"/>'), source(), 1);
    near(px(out, 1, 1)[3], 0, 5);
  });

  it('is clipped to its own subregion', () => {
    const spec = specOf('<feImage href="#el" x="0" y="0" width="2" height="2"/>');
    const extras = new Map([[spec.prims[0].result, redPatch()]]);
    const out = runFilter(spec, source(), 1, extras);
    near(px(out, 1, 1)[3], 1, 4);
    near(px(out, 3, 3)[3], 0, 4);      // inside the patch, outside the subregion
  });
});

describe('resolveFilter — feImage href shapes', () => {
  const shape = (href: string) =>
    resolveFilter(nodeOfFilter(`<feImage href="${href}"/>`),
                  { x: 0, y: 0, w: 10, h: 10 }, VP).kind;

  it('accepts a same-document fragment reference', () => {
    expect(shape('#el')).toBe('draw');
  });

  it('accepts a data: URI', () => {
    expect(shape('data:image/png;base64,iVBORw0KGgo=')).toBe('draw');
  });

  it('refuses an external href: the library performs no I/O', () => {
    expect(shape('https://example.com/a.png')).toBe('skip');
    expect(shape('./a.png')).toBe('skip');
  });

  it('refuses an feImage with no href at all', () => {
    expect(resolveFilter(nodeOfFilter('<feImage/>'),
                         { x: 0, y: 0, w: 10, h: 10 }, VP).kind).toBe('skip');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filterfx.test.ts`
Expected: FAIL — `runFilter` takes three parameters and `feImage` is unsupported.

- [ ] **Step 3: Write the implementation**

In `src/svgfilterfx.ts`, widen `runFilter`:

```ts
export function runFilter(
  spec: FilterSpec, source: Surface, scale: number,
  extras?: Map<string, Surface>,
): Surface {
```

and add the case:

```ts
      case 'feImage':
        // The walker pre-rasterized this: svgfilterfx.ts allocates nothing and
        // rasterizes nothing, so an feImage's pixels must arrive from outside.
        // A missing extra is transparent black, never a pass-through of in1 --
        // that would silently substitute the wrong picture.
        raw = extras?.get(p.result) ?? makeSurface(0, 0, W, H);
        break;
```

In `src/svgfilter.ts`, add `'feImage'` to `SUPPORTED` and validate the href shape in the primitive loop, beside the `feConvolveMatrix` check:

```ts
    // feImage resolves a same-document fragment or a data: URI. An external
    // href is refused for the same reason <image> refuses one: the library
    // performs no I/O, so the bytes have to arrive inside the document.
    if (k.name === 'feImage' && !validImageHref(k.attrs))
      return { kind: 'skip', report: ['feImage'] };
```

with:

```ts
/** An feImage href this stack can resolve: '#id' or a data: URI. */
function validImageHref(attrs: Map<string, string>): boolean {
  const h = (attrs.get('href') ?? attrs.get('xlink:href') ?? '').trim();
  return h.startsWith('#') || /^data:/i.test(h);
}
```

- [ ] **Step 4: Run the tests to verify they pass**
- [ ] **Step 5: Typecheck**

---

## Task 4: Pre-rasterizing the reference in the walker

**Files:**
- Modify: `src/svgdraw.ts` (`emitFiltered`)
- Test: `test/svg-filter-render.test.ts` (append)

**Interfaces:**
- Consumes: `SvgRasterSink.rasterize`, `decodeImage`/`imageSize` from `svgimage.js`, `fitBox` from `svgtransform.js`, `toSurface`, `flipRows`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-filter-render.test.ts`:

```ts
/** A 2x2 red PNG as a data: URI. Built by hand so the test carries no fixture
 *  file: IHDR + IDAT + IEND, 8-bit RGB, no filtering. */
const RED_PNG_URI = (() => {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib');
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = new TextEncoder().encode(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t); body.set(data, t.length);
    const out = new Uint8Array(8 + data.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(8 + data.length - 4 + 4 - 4, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 2);
  new DataView(ihdr.buffer).setUint32(4, 2);
  ihdr[8] = 8; ihdr[9] = 2;                      // 8-bit, truecolour
  const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
})();

describe('AddSVGObject — feImage', () => {
  it('draws a same-document element reference', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<rect id="src" x="0" y="0" width="100" height="100" fill="#ff0000"/>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="#src"/></filter></defs>' +
      '<rect x="0" y="0" width="200" height="200" fill="#0000ff" ' +
      'filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    // The referenced red rect replaced the blue source entirely.
    expect(isRed(png, 50, 50)).toBe(true);
  });

  it('draws a data: URI raster', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      `<feImage href="${RED_PNG_URI}"/></filter></defs>` +
      '<rect width="200" height="200" fill="#0000ff" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    expect(isRed(png, 100, 100)).toBe(true);
  });

  it('draws unfiltered and reports an feImage whose target is missing', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="#gone"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual(['filter']);
    expect(isRed(png, 50, 50)).toBe(true);      // the source, unfiltered
  });

  it('draws unfiltered and reports an external href', () => {
    const { result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="https://example.com/a.png"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual(['feImage']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: FAIL — the element-reference and data-URI cases render the blue source, not red.

- [ ] **Step 3: Write the implementation**

In `src/svgdraw.ts`, add above `emitFiltered`:

```ts
/** Rasterize one feImage reference into a Surface over the region raster.
 *
 *  Both reference kinds go through the SAME sink the filtered subtree uses: an
 *  element reference by walking that subtree into a form, a data: URI by
 *  building a one-operator form that draws the decoded Image XObject. Returns
 *  null when the reference cannot be resolved, which makes the whole filter
 *  refuse — SVG has no partial-filter semantics, and a silently empty feImage
 *  would look deliberate. */
function rasterizeFeImage(
  e: Emitter, p: FilterPrim, region: SegBBox, px: number, W: number, H: number,
): Surface | null {
  if (!e.raster) return null;
  const href = (p.attrs.get('href') ?? p.attrs.get('xlink:href') ?? '').trim();
  const sub = p.sub;
  if (!(sub.w > 0) || !(sub.h > 0)) return null;
  const devW = Math.max(1, Math.round(sub.w * px));
  const devH = Math.max(1, Math.round(sub.h * px));

  const g = e.child();
  if (href.startsWith('#')) {
    const id = href.slice(1);
    const target = id === '' ? undefined : e.ids.get(id);
    if (!target || e.active.has(id)) return null;      // missing, or a cycle
    e.active.add(id);
    // The referenced element renders into the primitive's subregion, in the
    // filter's own user space — the same space `walk` is already emitting in.
    walk(g, target, INITIAL, false, [...IDENTITY]);
    e.active.delete(id);
  } else {
    const built = decodeImage(href);
    if (built === undefined) return null;
    const { w: iw, h: ih } = imageSize(built);
    if (!(iw > 0) || !(ih > 0)) return null;
    const ref = e.imageSink.image(built);
    const key = g.xobjKey(ref);
    // feImage honours preserveAspectRatio over its subregion, like <image>.
    const f = fitBox({ w: iw, h: ih }, { w: sub.w, h: sub.h },
                     p.attrs.get('preserveAspectRatio'));
    const bw = iw * f.sx, bh = ih * f.sy;
    const bx = sub.x + f.tx, by = sub.y + f.ty;
    // The local -bh cancels placementMatrix's flip; see imagePlacement.
    g.out.push('q');
    g.out.push(`${num(bw)} 0 0 ${num(-bh)} ${num(bx)} ${num(by + bh)} cm`);
    g.out.push(`/${key} Do`);
    g.out.push('Q');
  }
  if (g.out.length === 0) return null;

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [sub.x, sub.y, sub.x + sub.w, sub.y + sub.h]],
    ['Matrix', [...IDENTITY]],
    ['Group', new Map<string, PdfObject>([
      ['Type', name('Group')], ['S', name('Transparency')],
    ])],
    ['Resources', buildResources(g)],
  ]);
  const img = e.raster.rasterize(dict, g.out.join('\n'), devW, devH);
  if (img === null) return null;

  // Place the subregion raster into a full-region surface at its own offset:
  // runFilter addresses every result in region-raster coordinates.
  const patch = toSurface(flipRows(img));
  const out = makeSurface(0, 0, W, H);
  const ox = Math.round((sub.x - region.x) * px);
  const oy = Math.round((sub.y - region.y) * px);
  for (let y = 0; y < patch.h; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < patch.w; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= W) continue;
      for (let c = 0; c < 4; c++)
        out.data[(dy * W + dx) * 4 + c] = patch.data[(y * patch.w + x) * 4 + c];
    }
  }
  return out;
}
```

Import what it needs in `src/svgdraw.ts`:

```ts
import { flipRows, makeSurface, runFilter, toSurface, surfaceImage, type Surface } from './svgfilterfx.js';
import { fitBox, parseTransform, type ViewBox } from './svgtransform.js';
import type { FilterPrim } from './svgfilter.js';
```

(`decodeImage` and `imageSize` are already imported for `<image>`.)

Then, inside `emitFiltered`, after the source raster is obtained and before `runFilter`:

```ts
  // Pre-rasterize every feImage reference. A failure refuses the WHOLE filter:
  // SVG has no partial-filter semantics, and an feImage that silently rendered
  // nothing would be indistinguishable from one the author meant to be empty.
  let extras: Map<string, Surface> | undefined;
  for (const p of spec.prims) {
    if (p.name !== 'feImage') continue;
    const s = rasterizeFeImage(e, p, region, px, img.w, img.h);
    if (s === null) return false;
    (extras ??= new Map()).set(p.result, s);
  }

  const out = runFilter(spec, toSurface(flipRows(img)), px, extras);
```

(replacing the existing `const out = runFilter(...)` line).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test`

- [ ] **Step 6: Prove the assertions are load-bearing**

1. In `rasterizeFeImage`, return an empty surface instead of `null` for a missing target → "draws unfiltered and reports an feImage whose target is missing" must fail.
2. In `rasterizeFeImage`'s data-URI branch, emit `+bh` instead of `-bh` → the data-URI test must fail (the image lands off its subregion).
3. In `emitFiltered`, pass no `extras` → both positive feImage tests must fail.

- [ ] **Step 7: Commit**

```bash
git add src/svgdraw.ts src/svgfilterfx.ts src/svgfilter.ts \
        test/svg-filterfx.test.ts test/svg-filter-render.test.ts
git commit -m "$(cat <<'EOF'
feat(svg): feImage, for element references and data: URI rasters

runFilter gains an `extras` map of pre-rasterized inputs keyed by primitive
result, so svgfilterfx.ts still rasterizes nothing: an feImage's pixels arrive
from the impure side, where the walker produces them.

Both reference kinds reuse the EXISTING SvgRasterSink -- an element reference
by walking that subtree into a form, a data: URI by building a one-operator
form around the decoded Image XObject. One seam, two producers, no new sink
method.

A reference that cannot be resolved refuses the whole filter rather than
contributing an empty surface: SVG has no partial-filter semantics, and a
silently empty feImage is indistinguishable from one the author meant to be
empty. An external href is refused outright, for the same reason <image>
refuses one -- the library performs no I/O.

Refs: aspose-pdf-foss-for-ts-1gg0.10.4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
---

# Commit C — `feTurbulence`

The spec's Perlin generator, plus the golden machinery both this commit and commit D depend on.

---

## Task 5: The noise generator

**Files:**
- Create: `src/svgfilternoise.ts`
- Test: `test/svg-filternoise.test.ts` (create)

**Interfaces:**
- Produces: `TurbulenceParams`, `turbulenceSurface` from `src/svgfilternoise.ts`.

- [ ] **Step 1: Write the failing test**

These are the *structural* assertions. The absolute-value check against browsers arrives in Task 7 — structure alone cannot catch a wrong gradient table, which is exactly why the goldens exist.

Create `test/svg-filternoise.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { turbulenceSurface, type TurbulenceParams } from '../src/svgfilternoise.js';

const base: TurbulenceParams = {
  baseFreqX: 0.05, baseFreqY: 0.05, numOctaves: 1, seed: 1,
  fractalSum: false, stitch: false, tile: { x: 0, y: 0, w: 64, h: 64 },
};
const win = { x: 0, y: 0, w: 64, h: 64 };
const gen = (p: Partial<TurbulenceParams>) =>
  turbulenceSurface({ ...base, ...p }, win, 1, 0, 0);

describe('turbulenceSurface', () => {
  it('fills every channel of the window', () => {
    const d = gen({});
    expect(d.length).toBe(64 * 64 * 4);
  });

  it('stays within 0..1 in every channel', () => {
    for (const p of [{}, { fractalSum: true }, { numOctaves: 5 }]) {
      const d = gen(p);
      for (let i = 0; i < d.length; i++) {
        expect(d[i]).toBeGreaterThanOrEqual(0);
        expect(d[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic for a seed', () => {
    expect(Array.from(gen({ seed: 42 }))).toEqual(Array.from(gen({ seed: 42 })));
  });

  it('differs between seeds', () => {
    const a = gen({ seed: 1 }), b = gen({ seed: 2 });
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same).toBeLessThan(a.length / 2);
  });

  it('turbulence is non-negative before premultiplication; fractalNoise is centred', () => {
    // type="turbulence" sums |noise| so its mean sits low; fractalNoise sums
    // signed noise scaled to 0..1 so its mean sits near 0.5. This distinguishes
    // the two accumulation rules, which is the single most common port bug.
    const mean = (d: Float32Array): number => {
      let t = 0, n = 0;
      // Channel 3 is alpha; read it unpremultiplied by construction.
      for (let p = 0; p < 64 * 64; p++) { t += d[p * 4 + 3]; n++; }
      return t / n;
    };
    expect(mean(gen({ fractalSum: false }))).toBeLessThan(0.45);
    const f = mean(gen({ fractalSum: true }));
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  it('more octaves add detail without leaving the range', () => {
    const one = gen({ numOctaves: 1 }), four = gen({ numOctaves: 4 });
    let diff = 0;
    for (let i = 0; i < one.length; i++) diff += Math.abs(one[i] - four[i]);
    expect(diff).toBeGreaterThan(0);
  });

  it('a zero baseFrequency yields a constant field', () => {
    const d = gen({ baseFreqX: 0, baseFreqY: 0 });
    for (let p = 1; p < 64 * 64; p++) expect(d[p * 4 + 3]).toBeCloseTo(d[3], 6);
  });

  it('stitchTiles makes the field tile seamlessly across the tile width', () => {
    const d = turbulenceSurface(
      { ...base, stitch: true, baseFreqX: 0.0625, baseFreqY: 0.0625 },
      win, 1, 0, 0);
    // With stitching, the value one tile-width apart must match at the seam.
    const at = (x: number, y: number) => d[((y * 64) + x) * 4 + 3];
    expect(Math.abs(at(0, 10) - at(63, 10))).toBeLessThan(0.25);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filternoise.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/svgfilternoise.ts`. This is a transcription of SVG 1.1 §15.7.20's published reference C. Keep the spec's own names in the internals so a reader can diff them against the spec directly.

```ts
// feTurbulence (issue 1gg0.10.4): the SVG 1.1 §15.7.20 Perlin generator, its
// own module because the lattice setup and the two accumulation rules would
// otherwise double svgfilterfx.ts.
//
// This is a transcription of the spec's published reference implementation, and
// deliberately keeps its names (uLatticeSelector, fGradient, s_curve, ...) so a
// reader can diff it against the spec line by line. It is EXACTLY the kind of
// port that cannot validate itself, which is why test/fixtures/svg-filter/
// holds browser-rendered goldens — see that directory's PROVENANCE.md.

export interface TurbulenceParams {
  baseFreqX: number; baseFreqY: number;
  numOctaves: number;
  seed: number;
  fractalSum: boolean;
  stitch: boolean;
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
  uLatticeSelector: Int32Array;      // BSize + BSize + 2
  fGradient: Float64Array;           // 4 * (BSize + BSize + 2) * 2
}

function init(seed: number): Lattice {
  const uLatticeSelector = new Int32Array(BSize + BSize + 2);
  const fGradient = new Float64Array(4 * (BSize + BSize + 2) * 2);
  const gi = (k: number, i: number, j: number): number =>
    (k * (BSize + BSize + 2) + i) * 2 + j;

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

/** One octave of 2-D Perlin noise for one colour channel. */
function noise2(
  L: Lattice, nColorChannel: number, vx: number, vy: number,
  stitch: StitchInfo | null,
): number {
  const gi = (k: number, i: number, j: number): number =>
    (k * (BSize + BSize + 2) + i) * 2 + j;

  const t0 = vx + PerlinN;
  let bx0 = Math.floor(t0) & BM;
  let bx1 = (bx0 + 1) & BM;
  const rx0 = t0 - Math.floor(t0);
  const rx1 = rx0 - 1;

  const t1 = vy + PerlinN;
  let by0 = Math.floor(t1) & BM;
  let by1 = (by0 + 1) & BM;
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

interface StitchInfo {
  width: number; height: number;     // lattice cells per tile
  wrapX: number; wrapY: number;
}

/** Sum the octaves at one point. Returns the spec's raw value: signed and
 *  roughly -1..1 for fractalSum, non-negative for turbulence. */
function turbulence(
  L: Lattice, nColorChannel: number, x: number, y: number, p: TurbulenceParams,
): number {
  let stitch: StitchInfo | null = null;
  let bfx = p.baseFreqX, bfy = p.baseFreqY;

  if (p.stitch) {
    // Adjust the base frequency so the tile holds a whole number of lattice
    // cells; without this the seam cannot line up.
    if (bfx !== 0) {
      const lo = Math.floor(p.tile.w * bfx) / p.tile.w;
      const hi = Math.ceil(p.tile.w * bfx) / p.tile.w;
      bfx = bfx / lo < hi / bfx ? lo : hi;
    }
    if (bfy !== 0) {
      const lo = Math.floor(p.tile.h * bfy) / p.tile.h;
      const hi = Math.ceil(p.tile.h * bfy) / p.tile.h;
      bfy = bfy / lo < hi / bfy ? lo : hi;
    }
    const width = Math.round(p.tile.w * bfx);
    const height = Math.round(p.tile.h * bfy);
    stitch = {
      width, height,
      wrapX: (Math.round(p.tile.x * bfx) + PerlinN + width) % BSize || BSize,
      wrapY: (Math.round(p.tile.y * bfy) + PerlinN + height) % BSize || BSize,
    };
    // The spec keeps the un-modulo'd wrap values; recompute them plainly.
    stitch.wrapX = Math.round(p.tile.x * bfx) + PerlinN + width;
    stitch.wrapY = Math.round(p.tile.y * bfy) + PerlinN + height;
  }

  let sum = 0;
  let vx = x * bfx, vy = y * bfy;
  let ratio = 1;
  for (let o = 0; o < p.numOctaves; o++) {
    const n = noise2(L, nColorChannel, vx, vy, stitch);
    sum += (p.fractalSum ? n : Math.abs(n)) / ratio;
    vx *= 2; vy *= 2; ratio *= 2;
    if (stitch) {
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
 *  the field shift under filterScale, which the render test pins. */
export function turbulenceSurface(
  p: TurbulenceParams, win: { x: number; y: number; w: number; h: number },
  scale: number, originX: number, originY: number,
): Float32Array {
  const L = init(p.seed);
  const out = new Float32Array(win.w * win.h * 4);
  const oct = Math.max(0, Math.floor(p.numOctaves));
  const params = { ...p, numOctaves: oct };

  for (let iy = 0; iy < win.h; iy++) {
    // Sample at pixel CENTRES: the half-pixel matters at high frequency, and
    // it is what the reference rasterizers do.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filternoise.test.ts`
Expected: PASS. If the stitch assertion fails, fix `turbulence`'s stitch bookkeeping — do **not** relax the assertion; a stitch that does not tile is the whole point of the option.

- [ ] **Step 5: Typecheck**

---

## Task 6: Wire `feTurbulence` into the graph

**Files:**
- Modify: `src/svgfilterfx.ts`, `src/svgfilter.ts`
- Test: `test/svg-filterfx.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
describe('runFilter — feTurbulence', () => {
  it('fills its subregion with noise and ignores its input', () => {
    const out = runFilter(specOf(
      '<feTurbulence baseFrequency="0.1" numOctaves="2" seed="3"/>'), source(), 1);
    let varied = new Set<number>();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++)
      varied.add(Math.round(px(out, x, y)[3] * 255));
    expect(varied.size).toBeGreaterThan(3);
  });

  it('is clipped to its subregion', () => {
    const out = runFilter(specOf(
      '<feTurbulence baseFrequency="0.1" seed="3" x="0" y="0" width="4" height="4"/>'),
      source(), 1);
    near(px(out, 8, 8)[3], 0, 5);
  });

  it('takes two baseFrequency numbers as x and y', () => {
    const a = runFilter(specOf('<feTurbulence baseFrequency="0.3 0" seed="1"/>'), source(), 1);
    const b = runFilter(specOf('<feTurbulence baseFrequency="0.3" seed="1"/>'), source(), 1);
    let differs = false;
    for (let y = 0; y < 10 && !differs; y++) for (let x = 0; x < 10; x++)
      if (Math.abs(px(a, x, y)[3] - px(b, x, y)[3]) > 1e-6) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('a negative baseFrequency is ignored rather than inverting the field', () => {
    const out = runFilter(specOf('<feTurbulence baseFrequency="-1" seed="1"/>'), source(), 1);
    for (let p = 0; p < 4; p++) expect(out.data[p]).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Implement**

In `src/svgfilterfx.ts`:

```ts
import { turbulenceSurface, type TurbulenceParams } from './svgfilternoise.js';
```

```ts
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
```

`switch` case:

```ts
      case 'feTurbulence': {
        raw = makeSurface(win.x, win.y, win.w, win.h);
        raw.data.set(turbulenceSurface(
          turbulenceParams(spec, p), win, scale, spec.region.x, spec.region.y));
        break;
      }
```

Add `'feTurbulence'` to `SUPPORTED`.

- [ ] **Step 4: Run to verify it passes**
- [ ] **Step 5: Typecheck and run the whole suite**

---

## Task 7: The golden generator and the turbulence goldens

**Files:**
- Create: `scripts/gen-filter-goldens.ts`
- Create: `test/fixtures/svg-filter/PROVENANCE.md` + the golden PNGs
- Test: `test/svg-filternoise.test.ts` (append the golden diff)

**Interfaces:**
- Consumes: `puppeteer`, `@resvg/resvg-js`, `tsx` — installed `--no-save`, never in `package.json`.

- [ ] **Step 1: Read the existing generator first**

Read `scripts/gen-svg-goldens.ts` end to end and mirror its structure: the same Chrome flags (`--force-color-profile=srgb`, LCD text and subpixel positioning disabled), the same PNG-writing helper, the same PROVENANCE discipline. Do not invent a second house style.

- [ ] **Step 2: Write the generator**

Create `scripts/gen-filter-goldens.ts`. Fixtures are named and their SVG source is committed **in the script**, so a regeneration is reproducible.

```ts
// Golden generator for the SVG filter primitives that are ports of published
// reference implementations (issue 1gg0.10.4). NOT run by `npm test`.
//
//   npm i --no-save tsx puppeteer @resvg/resvg-js
//   npx tsx scripts/gen-filter-goldens.ts
//
// Two constraints are baked in and must not be relaxed without re-measuring —
// see test/fixtures/svg-filter/PROVENANCE.md:
//   * turbulence fixtures stay at baseFrequency <= 0.05, because Chrome and
//     resvg diverge on high-frequency noise by more than a tolerance can hold;
//   * lighting fixtures are Chrome-only, because resvg PANICS on them and the
//     panic aborts the process rather than raising.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { Resvg } from '@resvg/resvg-js';

const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'svg-filter');
const S = 64;

interface Fixture { name: string; body: string; crossCheck: boolean }

const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${body}</svg>`;

const region = `x="0" y="0" width="${S}" height="${S}"`;

const FIXTURES: Fixture[] = [
  {
    name: 'turbulence-fractal',
    crossCheck: true,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="3" seed="7"/>' +
      `</filter><rect width="${S}" height="${S}" filter="url(#f)"/>`,
  },
  {
    name: 'turbulence-turb',
    crossCheck: true,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feTurbulence type="turbulence" baseFrequency="0.05" numOctaves="2" seed="3"/>' +
      `</filter><rect width="${S}" height="${S}" filter="url(#f)"/>`,
  },
  // Lighting: Chrome only. resvg panics in filter/lighting.rs and the panic
  // aborts the process, so it must not even be constructed for these.
  {
    name: 'diffuse-distant',
    crossCheck: false,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feDiffuseLighting surfaceScale="8" diffuseConstant="0.9" lighting-color="#ffffff">' +
      '<feDistantLight azimuth="135" elevation="35"/>' +
      '</feDiffuseLighting></filter>' +
      `<circle cx="32" cy="32" r="22" filter="url(#f)"/>`,
  },
  {
    name: 'diffuse-point',
    crossCheck: false,
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feDiffuseLighting surfaceScale="8" diffuseConstant="0.9" lighting-color="#ffddaa">' +
      '<fePointLight x="20" y="20" z="24"/>' +
      '</feDiffuseLighting></filter>' +
      `<circle cx="32" cy="32" r="22" filter="url(#f)"/>`,
  },
  {
    name: 'specular-spot',
    crossCheck: false,
    // Constants chosen to keep a GRADIENT rather than a saturated blob: a
    // white light at specularExponent 20 collapsed to two output levels, which
    // would pass against nearly any implementation.
    body:
      `<filter id="f" color-interpolation-filters="sRGB" ${region}>` +
      '<feSpecularLighting surfaceScale="6" specularConstant="0.8" ' +
      'specularExponent="4" lighting-color="#ffffff">' +
      '<feSpotLight x="16" y="16" z="30" pointsAtX="32" pointsAtY="32" pointsAtZ="0" ' +
      'specularExponent="2" limitingConeAngle="45"/>' +
      '</feSpecularLighting></filter>' +
      `<circle cx="32" cy="32" r="22" filter="url(#f)"/>`,
  },
];

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--force-color-profile=srgb', '--disable-lcd-text',
         '--disable-font-subpixel-positioning'],
});

for (const f of FIXTURES) {
  const src = svg(f.body);
  const page = await browser.newPage();
  await page.setViewport({ width: S, height: S, deviceScaleFactor: 1 });
  await page.setContent(`<style>*{margin:0;padding:0}</style>${src}`);
  const shot = new Uint8Array(await page.screenshot({ omitBackground: true }));
  await page.close();

  if (f.crossCheck) {
    // Independence gate: two engines must agree before we trust either.
    const rz = new Resvg(src).render().asPng();
    const { decodePng } = await import('../test/helpers/decode-png.js');
    const a = decodePng(shot), b = decodePng(new Uint8Array(rz));
    let max = 0, sum = 0, n = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.at(x, y)[c] - b.at(x, y)[c]);
      max = Math.max(max, d); sum += d; n++;
    }
    const mean = sum / n;
    console.log(`${f.name}: chrome-vs-resvg max=${max} mean=${mean.toFixed(2)}`);
    if (mean > 6) throw new Error(
      `${f.name}: engines disagree (mean ${mean.toFixed(2)}). ` +
      'Lower baseFrequency or drop the cross-check — do not widen this gate.');
  }

  writeFileSync(join(OUT, `${f.name}.png`), shot);
  writeFileSync(join(OUT, `${f.name}.svg`), src);
  console.log(`wrote ${f.name}.png (${shot.length} bytes)`);
}

await browser.close();
```

- [ ] **Step 3: Generate the goldens**

```bash
npm i --no-save tsx puppeteer @resvg/resvg-js
npx tsx scripts/gen-filter-goldens.ts
git status --short -- package.json package-lock.json   # MUST be empty
```

Expected: five `.png` + five `.svg` files in `test/fixtures/svg-filter/`, and the two turbulence fixtures reporting a chrome-vs-resvg mean under 6.

If a turbulence fixture exceeds the gate, **lower its `baseFrequency`** — do not widen the threshold. The measurements in "Global Constraints" say 0.05 lands near mean 3.8, so there is headroom below.

- [ ] **Step 4: Write `PROVENANCE.md`**

Create `test/fixtures/svg-filter/PROVENANCE.md`, modelled on `test/fixtures/svg/PROVENANCE.md`:

```markdown
# SVG Filter Goldens — Provenance

Browser-rendered rasterizations of five filter fixtures. They exist because
`feTurbulence` and the lighting primitives are **ports of published reference
implementations**: asserting a port against values derived from the same
reference proves nothing, so the expectations must come from engines that share
no code with ours.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-filter-goldens.ts` (not run by `npm test`) |
| Committed bytes from | headless Chrome (see the version recorded below) |
| Cross-checked against | `@resvg/resvg-js` — **turbulence fixtures only** |
| Runner | tsx |

```bash
npm i --no-save tsx puppeteer @resvg/resvg-js
npx tsx scripts/gen-filter-goldens.ts
```

The packages are installed **without** being recorded in `package.json`, so the
library's dependency tree is unchanged.

## What these cover, and what they do not

| Fixture | Covers | Cross-checked |
|---|---|---|
| `turbulence-fractal` | `type="fractalNoise"`, 3 octaves, the signed accumulation and the [-1,1] → [0,1] remap | yes |
| `turbulence-turb` | `type="turbulence"`, 2 octaves, the absolute-value accumulation | yes |
| `diffuse-distant` | `feDiffuseLighting` + `feDistantLight`, surface normals over a curved alpha edge | **no** |
| `diffuse-point` | `fePointLight`, per-pixel light vector, coloured `lighting-color` | **no** |
| `specular-spot` | `feSpecularLighting` + `feSpotLight`, cone falloff, alpha = max(r,g,b) | **no** |

**Two limitations, both measured rather than assumed** (2026-07-31):

1. **Turbulence fixtures use a low `baseFrequency` (≤ 0.05) deliberately.**
   Chrome and resvg diverge sharply on high-frequency noise — mean channel
   difference 30.9/255 at `baseFrequency` 0.5, 12.0 at 0.15, 3.8 at 0.05, 1.7 at
   0.02. Both implement the same function; they sample it at different sub-pixel
   offsets, and high-frequency noise magnifies that. These fixtures therefore
   verify the lattice, the gradient table and both accumulation rules — the
   things a wrong port gets wrong — and do **not** verify sub-pixel sampling
   agreement with any particular engine.

2. **The lighting fixtures have no second engine.** resvg panics inside
   `resvg/src/filter/lighting.rs` (`assertion failed: src.width == dest.width`)
   on every lighting input tried, and the panic aborts the process rather than
   raising, so the generator does not invoke it for those three. Their goldens
   come from Chrome alone. That is a real reduction in independence and is
   recorded here rather than papered over.

Lighting constants are chosen to keep a visible gradient across the surface: an
earlier attempt at `specularExponent="20"` with a white light collapsed to two
distinct output levels, which would have passed against almost any
implementation.
```

Fill in the exact Chrome, resvg, tsx, Node and OS versions, plus the date and the SHA-256 of each committed PNG, exactly as the sibling PROVENANCE does.

- [ ] **Step 5: Write the golden-diff test**

Append to `test/svg-filternoise.test.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const FIX = join(import.meta.dirname, 'fixtures', 'svg-filter');

/** Render a committed fixture SVG through AddSVGObject -> ToImage at 1:1. */
function ours(name: string, size = 64) {
  const src = readFileSync(join(FIX, `${name}.svg`));
  const p = Document.Open(
    buildSvgPdf({ mediaBox: [0, 0, size, size], content: '' })).Pages[0];
  p.AddSVGObject(new Uint8Array(src), [0, 0, size, size], { fit: 'fill', filterScale: 1 });
  return decodePng(Document.Open(p.Document.Save()).Pages[0].ToImage());
}

/** Mean absolute channel difference against the golden, over opaque pixels. */
function meanDiff(name: string, size = 64): number {
  const gold = decodePng(new Uint8Array(readFileSync(join(FIX, `${name}.png`))));
  const got = ours(name, size);
  let sum = 0, n = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    for (let c = 0; c < 3; c++) { sum += Math.abs(gold.at(x, y)[c] - got.at(x, y)[c]); n++; }
  }
  return sum / n;
}

describe('feTurbulence — against browser goldens', () => {
  // The point of these: a wrong lattice, a wrong gradient table, or the wrong
  // accumulation rule changes the LARGE-SCALE structure, which no tolerance
  // this tight can absorb. See fixtures/svg-filter/PROVENANCE.md for why the
  // fixtures are low-frequency and what that does and does not prove.
  it('matches Chrome and resvg on fractalNoise', () => {
    expect(meanDiff('turbulence-fractal')).toBeLessThan(16);
  });

  it('matches Chrome and resvg on turbulence', () => {
    expect(meanDiff('turbulence-turb')).toBeLessThan(16);
  });
});
```

**Calibrate the threshold from the measured value, not the other way round.** Run the test, read the actual mean, and set the bound just above it — then confirm the bound still fails when the port is broken (Step 6). A bound of 16 is a starting guess; if the real figure is 3, use 6.

- [ ] **Step 6: Prove the goldens are load-bearing**

Break each, confirm the golden test goes red, revert:

1. In `svgfilternoise.ts`, change `RAND_a` from 16807 to 16809 → both turbulence goldens must fail.
2. Swap the `fractalSum` branch (`Math.abs(n)` vs `n`) → both must fail.
3. Drop the `sCurve` (use `t` directly) → both must fail.

If any of these still passes, the threshold is too loose. Tighten it.

- [ ] **Step 7: Commit**

```bash
git add src/svgfilternoise.ts src/svgfilterfx.ts src/svgfilter.ts \
        scripts/gen-filter-goldens.ts test/fixtures/svg-filter \
        test/svg-filternoise.test.ts test/svg-filterfx.test.ts
git status --short -- package.json package-lock.json   # MUST be empty
git commit -m "$(cat <<'EOF'
feat(svg): feTurbulence, validated against browser goldens

svgfilternoise.ts transcribes SVG 1.1 15.7.20's published Perlin generator,
keeping the spec's own names so a reader can diff it against the spec directly.

That is exactly the kind of port that cannot validate itself, so
test/fixtures/svg-filter/ holds Chrome-rendered goldens, gated on agreement
with resvg before they are committed.

The fixtures are deliberately LOW frequency. Chrome and resvg diverge on
high-frequency noise by far more than a tolerance can hold -- mean channel
difference 30.9/255 at baseFrequency 0.5, falling to 1.7 at 0.02 -- because
they sample the same function at different sub-pixel offsets. At baseFrequency
<= 0.05 the large-scale structure a wrong lattice or gradient table would
destroy is still fully exercised. PROVENANCE.md records what that does and
does not prove.

Refs: aspose-pdf-foss-for-ts-1gg0.10.4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---
---

# Commit D — lighting

---

## Task 8: Surface normals

**Files:**
- Create: `src/svgfilterlight.ts`
- Test: `test/svg-filterlight.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { surfaceNormal } from '../src/svgfilterlight.js';

/** An alpha field with a constant gradient along x: A(x,y) = x / (w-1). */
function ramp(w: number, h: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = x / (w - 1);
  return a;
}
const flat = (w: number, h: number, v = 0.5): Float32Array =>
  new Float32Array(w * h).fill(v);

const near = (a: number, b: number, d = 5) => expect(a).toBeCloseTo(b, d);

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

  it('is a unit vector everywhere, interior and edges alike', () => {
    const a = ramp(8, 8);
    for (const [x, y] of [[4, 4], [0, 0], [7, 0], [0, 7], [7, 7], [4, 0], [0, 4], [7, 4], [4, 7]]) {
      const [nx, ny, nz] = surfaceNormal(a, 8, 8, x, y, 6);
      near(Math.hypot(nx, ny, nz), 1, 5);
    }
  });

  it('uses the EDGE kernels, not the interior one, on the border', () => {
    // SVG 1.1 15.7.16 gives the left column its own coefficients with a
    // different normalisation factor. On a constant x-gradient the interior
    // kernel and the left-edge kernel disagree; if they agree here, the edge
    // kernels were never wired in.
    const a = ramp(8, 8);
    const [ex] = surfaceNormal(a, 8, 8, 0, 4, 10);
    const [ix] = surfaceNormal(a, 8, 8, 4, 4, 10);
    expect(Math.abs(ex - ix)).toBeGreaterThan(1e-6);
  });

  it('scales the tilt with surfaceScale', () => {
    const [a] = surfaceNormal(ramp(8, 8), 8, 8, 4, 4, 4);
    const [b] = surfaceNormal(ramp(8, 8), 8, 8, 4, 4, 16);
    expect(Math.abs(b)).toBeGreaterThan(Math.abs(a));
  });
});
```

- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Implement the normals**

Create `src/svgfilterlight.ts` with `surfaceNormal` implementing SVG 1.1 §15.7.16's nine cases. Transcribe the spec's tables; each region has its own 3×3 (or truncated) coefficient set and its own normalisation factor.

```ts
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

export function surfaceNormal(
  alpha: Float32Array, w: number, h: number, x: number, y: number, surfaceScale: number,
): [number, number, number] {
  const p = (dx: number, dy: number): number => A(alpha, w, h, x + dx, y + dy);
  const left = x === 0, right = x === w - 1;
  const top = y === 0, bottom = y === h - 1;

  let fx: number, fy: number;
  // Interior (§15.7.16's "Interior pixels"): the familiar Sobel, factor 1/4.
  if (!left && !right && !top && !bottom) {
    fx = (1 / 4) * ((p(1, -1) + 2 * p(1, 0) + p(1, 1))
                  - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1)));
    fy = (1 / 4) * ((p(-1, 1) + 2 * p(0, 1) + p(1, 1))
                  - (p(-1, -1) + 2 * p(0, -1) + p(1, -1)));
  } else if (top && left) {
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
    fx = (1 / 3) * ((p(1, 0) * 2 + p(1, 1)) - (p(-1, 0) * 2 + p(-1, 1)));
    fy = (1 / 2) * ((p(-1, 1) + 2 * p(0, 1) + p(1, 1))
                  - (p(-1, 0) + 2 * p(0, 0) + p(1, 0)));
  } else if (bottom) {
    fx = (1 / 3) * ((p(1, -1) + 2 * p(1, 0)) - (p(-1, -1) + 2 * p(-1, 0)));
    fy = (1 / 2) * ((p(-1, 0) + 2 * p(0, 0) + p(1, 0))
                  - (p(-1, -1) + 2 * p(0, -1) + p(1, -1)));
  } else if (left) {
    fx = (1 / 2) * ((p(1, -1) + 2 * p(1, 0) + p(1, 1))
                  - (p(0, -1) + 2 * p(0, 0) + p(0, 1)));
    fy = (1 / 3) * ((p(0, 1) * 2 + p(1, 1)) - (p(0, -1) * 2 + p(1, -1)));
  } else {  // right
    fx = (1 / 2) * ((p(0, -1) + 2 * p(0, 0) + p(0, 1))
                  - (p(-1, -1) + 2 * p(-1, 0) + p(-1, 1)));
    fy = (1 / 3) * ((p(-1, 1) + 2 * p(0, 1)) - (p(-1, -1) + 2 * p(0, -1)));
  }

  const nx = -surfaceScale * fx;
  const ny = -surfaceScale * fy;
  const len = Math.hypot(nx, ny, 1);
  return [nx / len, ny / len, 1 / len];
}
```

- [ ] **Step 4: Run to verify it passes**

If "uses the EDGE kernels" fails, the branch order is wrong — corners must be tested before edges.

- [ ] **Step 5: Typecheck**

---

## Task 9: The light model and the two primitives

**Files:**
- Modify: `src/svgfilterlight.ts`, `src/svgfilterfx.ts`, `src/svgfilter.ts`
- Test: `test/svg-filterlight.test.ts` (append), `test/svg-filterfx.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
import { lightingSurface, type LightingParams } from '../src/svgfilterlight.js';
import { makeSurface, type Surface } from '../src/svgfilterfx.js';

/** A flat, fully opaque input: normals point straight up everywhere. */
function opaque(w: number, h: number): Surface {
  const s = makeSurface(0, 0, w, h);
  for (let p = 0; p < w * h; p++) s.data.set([0, 0, 0, 1], p * 4);
  return s;
}
const at = (s: Surface, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

const diffuse = (light: LightingParams['light'], over: Partial<LightingParams> = {})
  : LightingParams => ({
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
    expect(p[3]).toBeCloseTo(Math.max(p[0], p[1], p[2]), 5);
    expect(p[3]).toBeGreaterThan(0);
  });

  it('a higher specularExponent narrows the highlight', () => {
    const wide = lightingSurface(
      opaque(16, 16),
      spec({ specularExponent: 1, light: { kind: 'point', x: 8, y: 8, z: 4 } }), 1, 0, 0);
    const tight = lightingSurface(
      opaque(16, 16),
      spec({ specularExponent: 32, light: { kind: 'point', x: 8, y: 8, z: 4 } }), 1, 0, 0);
    // Far from the highlight centre, the tight exponent must have fallen off more.
    expect(at(tight, 15, 15)[0]).toBeLessThan(at(wide, 15, 15)[0]);
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
    expect(at(out, 4, 4)[0]).toBeGreaterThan(0);
    expect(at(out, 30, 30)[0]).toBeCloseTo(0, 5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
- [ ] **Step 3: Implement**

Append to `src/svgfilterlight.ts`:

```ts
export type LightSource =
  | { kind: 'distant'; azimuth: number; elevation: number }
  | { kind: 'point'; x: number; y: number; z: number }
  | { kind: 'spot'; x: number; y: number; z: number;
      pointsAtX: number; pointsAtY: number; pointsAtZ: number;
      specularExponent: number; limitingConeAngle?: number };

export interface LightingParams {
  specular: boolean;
  surfaceScale: number;
  constant: number;
  specularExponent: number;
  color: [number, number, number];
  light: LightSource;
}

const DEG = Math.PI / 180;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The light vector L at a surface point, and the light's own colour weight.
 *  SVG 1.1 §15.7.15: a spot light attenuates by (-L . S)^specularExponent and
 *  is cut off outside limitingConeAngle. */
function lightAt(
  l: LightSource, x: number, y: number, z: number,
): { L: [number, number, number]; weight: number } {
  if (l.kind === 'distant') {
    const az = l.azimuth * DEG, el = l.elevation * DEG;
    return { L: [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)], weight: 1 };
  }
  const dx = l.x - x, dy = l.y - y, dz = l.z - z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const L: [number, number, number] = [dx / len, dy / len, dz / len];
  if (l.kind === 'point') return { L, weight: 1 };

  const sx = l.pointsAtX - l.x, sy = l.pointsAtY - l.y, sz = l.pointsAtZ - l.z;
  const slen = Math.hypot(sx, sy, sz) || 1;
  const S: [number, number, number] = [sx / slen, sy / slen, sz / slen];
  const minusLdotS = -(L[0] * S[0] + L[1] * S[1] + L[2] * S[2]);
  if (minusLdotS <= 0) return { L, weight: 0 };
  if (l.limitingConeAngle !== undefined
      && minusLdotS < Math.cos(Math.abs(l.limitingConeAngle) * DEG))
    return { L, weight: 0 };
  return { L, weight: Math.pow(minusLdotS, l.specularExponent) };
}

/** SVG 1.1 §15.7.14 / §15.7.18.
 *
 *  Diffuse output is opaque; SPECULAR output takes alpha = max(r, g, b), which
 *  is what makes a highlight composite as a highlight rather than as a wash. */
export function lightingSurface(
  input: Surface, p: LightingParams, scale: number, originX: number, originY: number,
): Surface {
  const { w: W, h: H } = input;
  const out = makeSurface(input.x, input.y, W, H);
  // Normals read the ALPHA channel only — the height field is the input's alpha.
  const alpha = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) alpha[i] = input.data[i * 4 + 3];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const N = surfaceNormal(alpha, W, H, x, y, p.surfaceScale);
      // The light's coordinates are USER units; the surface is in pixels.
      const ux = originX + x / scale, uy = originY + y / scale;
      const uz = p.surfaceScale * alpha[y * W + x];
      const { L, weight } = lightAt(p.light, ux, uy, uz);

      let r: number, g: number, b: number, a: number;
      if (!p.specular) {
        const ndotl = N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
        const k = p.constant * Math.max(0, ndotl) * weight;
        r = clamp01(k * p.color[0]); g = clamp01(k * p.color[1]); b = clamp01(k * p.color[2]);
        a = 1;
      } else {
        // The halfway vector H = (L + eye) / |L + eye|, with the eye at +Z.
        const hx = L[0], hy = L[1], hz = L[2] + 1;
        const hl = Math.hypot(hx, hy, hz) || 1;
        const ndoth = (N[0] * hx + N[1] * hy + N[2] * hz) / hl;
        const k = p.constant * Math.pow(Math.max(0, ndoth), p.specularExponent) * weight;
        r = clamp01(k * p.color[0]); g = clamp01(k * p.color[1]); b = clamp01(k * p.color[2]);
        a = Math.max(r, g, b);
      }
      const o = (y * W + x) * 4;
      // Premultiplied, like every other surface in the pipeline.
      out.data[o] = r * a; out.data[o + 1] = g * a; out.data[o + 2] = b * a;
      out.data[o + 3] = a;
    }
  }
  return out;
}
```

Wire into `src/svgfilterfx.ts`:

```ts
import { lightingSurface, type LightingParams, type LightSource } from './svgfilterlight.js';
```

```ts
/** The <feDistantLight>/<fePointLight>/<feSpotLight> child, if any. */
function lightSourceOf(p: FilterPrim, spec: FilterSpec): LightSource | null {
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
      return {
        kind: 'spot',
        x: n('x', 0, c), y: n('y', 0, c), z: n('z', 0, c),
        pointsAtX: n('pointsAtX', 0, c), pointsAtY: n('pointsAtY', 0, c),
        pointsAtZ: n('pointsAtZ', 0, c),
        specularExponent: n('specularExponent', 1, c),
        limitingConeAngle: cone !== undefined && Number.isFinite(parseFloat(cone))
          ? parseFloat(cone) : undefined,
      };
    }
  }
  return null;
}

function lightingParams(spec: FilterSpec, p: FilterPrim, specular: boolean): LightingParams | null {
  const light = lightSourceOf(p, spec);
  if (!light) return null;
  const num = (k: string, d: number): number => {
    const v = parseFloat(p.attrs.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const c = parseColor(p.attrs.get('lighting-color') ?? 'white');
  // lighting-color is a colour like any other: it arrives sRGB and the pipeline
  // works in the primitive's own space.
  const conv = p.space === 'sRGB' ? (v: number) => v : srgbToLinear;
  const col: [number, number, number] = c && c.length === 3
    ? [conv(c[0]), conv(c[1]), conv(c[2])] : [1, 1, 1];
  return {
    specular,
    surfaceScale: num('surfaceScale', 1),
    constant: specular ? num('specularConstant', 1) : num('diffuseConstant', 1),
    specularExponent: num('specularExponent', 1),
    color: col,
    light,
  };
}
```

`switch` cases:

```ts
      case 'feDiffuseLighting':
      case 'feSpecularLighting': {
        const lp = lightingParams(spec, p, p.name === 'feSpecularLighting');
        // A lighting primitive with no light source paints nothing. Unreachable:
        // resolveFilter refuses it.
        raw = lp
          ? lightingSurface(inSpace(p.in1), lp, scale, spec.region.x, spec.region.y)
          : makeSurface(0, 0, W, H);
        break;
      }
```

In `src/svgfilter.ts`, add `'feDiffuseLighting'` and `'feSpecularLighting'` to `SUPPORTED`, and refuse one with no light child:

```ts
    // A lighting primitive with no light source has no defined result.
    if ((k.name === 'feDiffuseLighting' || k.name === 'feSpecularLighting')
        && !k.children.some((c) => c.name === 'feDistantLight'
                                || c.name === 'fePointLight' || c.name === 'feSpotLight'))
      return { kind: 'skip', report: [k.name] };
```

- [ ] **Step 4: Run to verify it passes**
- [ ] **Step 5: Typecheck and run the whole suite**

---

## Task 10: Lighting goldens, docs, and close

**Files:**
- Test: `test/svg-filterlight.test.ts` (append the golden diff)
- Modify: `README.md`
- Modify: `test/fixtures/svg-filter/PROVENANCE.md` (SHA-256 of the new PNGs)

- [ ] **Step 1: Add the golden diff**

The three lighting fixtures were already generated in Task 7. Append to `test/svg-filterlight.test.ts` the same `meanDiff` harness used in `test/svg-filternoise.test.ts` (repeat it rather than sharing — the two files are read independently), and:

```ts
describe('lighting — against Chrome goldens', () => {
  // Chrome ONLY: resvg panics on these and aborts the process. See
  // fixtures/svg-filter/PROVENANCE.md — that is a stated gap in independence.
  it('matches Chrome on feDiffuseLighting + feDistantLight', () => {
    expect(meanDiff('diffuse-distant')).toBeLessThan(20);
  });

  it('matches Chrome on fePointLight with a coloured light', () => {
    expect(meanDiff('diffuse-point')).toBeLessThan(20);
  });

  it('matches Chrome on feSpecularLighting + feSpotLight', () => {
    expect(meanDiff('specular-spot')).toBeLessThan(20);
  });
});
```

**Calibrate each threshold from the measured value**, as in Task 7. Lighting is more forgiving than noise but the bound must still fail a broken port.

- [ ] **Step 2: Prove the lighting goldens are load-bearing**

Break each, confirm red, revert:

1. In `surfaceNormal`, use the interior kernel for every pixel → at least one golden must fail. **If none does, the fixtures do not exercise the border** — enlarge the lit shape so it meets the filter-region edge, regenerate, and try again.
2. In `lightingSurface`, set specular alpha to 1 instead of `max(r,g,b)` → `specular-spot` must fail.
3. Drop the spot cone cutoff (always `weight = 1`) → `specular-spot` must fail.

- [ ] **Step 3: Update `README.md`**

In the SVG embedding bullet, replace the filter primitive list and the refusal sentence:

```markdown
**Filters** — `filter="url(#…)"` covers **all of SVG 1.1's filter primitives**
plus `feDropShadow`: `feBlend`, `feColorMatrix`, `feComponentTransfer`,
`feComposite`, `feConvolveMatrix`, `feDiffuseLighting`, `feDisplacementMap`,
`feDropShadow`, `feFlood`, `feGaussianBlur`, `feImage`, `feMerge`,
`feMorphology`, `feOffset`, `feSpecularLighting`, `feTile` and `feTurbulence`,
with `feDistantLight`/`fePointLight`/`feSpotLight`, `filterUnits`/
`primitiveUnits`, per-primitive subregions, `in`/`result` wiring, and
`color-interpolation-filters` (linearRGB by default, `sRGB` opt-in). `feImage`
resolves a same-document element reference or a `data:` URI raster; an external
href is refused, since the library performs no I/O. PDF has no filter model, so
a filtered subtree is **rasterized**: it renders correctly but is
resolution-bound, and its text stops being extractable or searchable.
`opts.filterScale` (default 2, max 8) sets that resolution as a multiple of the
placed size, and every element flattened this way is named in the result's
**`rasterized`** array — distinct from `skipped`, which still means a fidelity
loss. An unresolvable `in`, a malformed `feConvolveMatrix` kernel, a lighting
primitive with no light source, or the `BackgroundImage`/`FillPaint`
pseudo-inputs make the element draw **unfiltered** and report — visible ink
beats silently dropped content. A filter region with no area renders the element
as nothing and is *not* reported, as SVG mandates.
```

Also update the API-overview table row for `page.AddSVGObject` to say the full primitive set is covered.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Also confirm: `git status --short -- package.json package-lock.json` is empty.

- [ ] **Step 5: Commit**

```bash
git add src/svgfilterlight.ts src/svgfilterfx.ts src/svgfilter.ts \
        test/svg-filterlight.test.ts test/fixtures/svg-filter README.md
git commit -m "$(cat <<'EOF'
feat(svg): feDiffuseLighting and feSpecularLighting

svgfilterlight.ts implements SVG 1.1 15.7.16's NINE surface-normal kernels --
interior, four edges, four corners -- rather than the interior-kernel-everywhere
shortcut, which is visibly wrong on the one-pixel border where a lit bevel is
actually read.

Specular output takes alpha = max(r, g, b), which is what makes a highlight
composite as a highlight rather than as a wash; diffuse output is opaque.

Goldens for these come from Chrome ALONE: resvg panics inside
filter/lighting.rs and the panic aborts the process rather than raising, so it
cannot serve as the second engine. PROVENANCE.md records that as a stated gap
in independence rather than papering over it.

This completes SVG 1.1's filter primitive set.

Closes: aspose-pdf-foss-for-ts-1gg0.10.4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Push**

```bash
git pull --rebase
git push -u origin feat/svg-filter-kernels
git status   # MUST show "up to date with origin"
```

- [ ] **Step 7: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.10.4
bd remember --key svg-filter-kernels-shipped "<what shipped, the two golden constraints, and the extras seam>"
```

---

## Self-Review

**Spec coverage** (design doc section 3 + "Phase 4 decisions"):

| Spec item | Task |
|---|---|
| `feConvolveMatrix` | 1 |
| `feDisplacementMap` | 2 |
| `feImage` — `extras` seam, both reference kinds, refusal on failure | 3, 4 |
| `feTurbulence` — `svgfilternoise.ts`, `fractalNoise` + `turbulence`, `stitchTiles` | 5, 6 |
| `feDiffuseLighting`/`feSpecularLighting` + three light sources — `svgfilterlight.ts` | 8, 9 |
| Nine surface-normal kernels | 8 |
| Browser goldens, low-frequency turbulence constraint | 7 |
| Lighting goldens Chrome-only, resvg panic recorded | 7, 10 |
| Discriminating lighting constants | 7 |
| `SUPPORTED` extended per commit with its kernel | 1, 2, 3, 6, 9 |
| Mutation check per commit | 2, 4, 7, 10 |
| README | 10 |

**Not covered, deliberately:** `kernelUnitLength` on `feConvolveMatrix` and the lighting primitives — SVG 1.1 makes it optional, no major engine implements it faithfully, and honouring it would mean resampling the whole surface. It is silently ignored, which matches every shipping implementation. `FillPaint`/`StrokePaint` remain issue `1gg0.10.6`.

**Type consistency:** `runFilter(spec, source, scale, extras?)` is widened once in Task 3 and used with that arity in Task 4 onward. `Surface`/`makeSurface` are imported by `svgfilterlight.ts` from `svgfilterfx.ts`, which does **not** import `svgfilterlight.ts` until Task 9 — check that direction when wiring, since `svgfilterfx.ts` importing `svgfilterlight.ts` while `svgfilterlight.ts` imports `Surface` from `svgfilterfx.ts` is a *type-only* cycle and is fine under NodeNext, but a value import in both directions would not be. `surfaceNormal` is exported from Task 8 and consumed by `lightingSurface` in Task 9. `turbulenceSurface` returns a bare `Float32Array` (not a `Surface`), and Task 6's caller wraps it — keep that asymmetry, it is what lets `svgfilternoise.ts` stay free of the `Surface` type entirely.
