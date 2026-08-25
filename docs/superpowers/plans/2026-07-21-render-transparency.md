# Render Transparency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tiling patterns, ExtGState soft masks, blend modes, and transparency groups in `page.ToImage()` and `page.ToSvg()`, replacing today's mid-gray approximations.

**Architecture:** The content interpreter (`pagerender.ts`) stays the only place that reads PDF semantics; the sinks (`raster.ts`, `svgrender.ts`) stay the only place that know about buffers. One new mechanism spans both: a redirectable output target with a disposition on close (`beginOffscreen`/`endOffscreen`) — an offscreen `Canvas` in raster, buffered `<defs>` markup in SVG. Constant alpha and soft masks fold into the existing `ClipMask` coverage machinery rather than introducing compositing.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. No runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-21-render-transparency-design.md`
**Issue:** `aspose-pdf-foss-for-ts-a6i`

## Global Constraints

- **Zero runtime dependencies.** Only `node:zlib`, `node:crypto`, `node:fs`. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension: `import { Page } from './page.js'`.
- **`strict` TypeScript.** `npm run typecheck` must pass with zero errors before any task closes.
- **`npm test` must be green before any task closes.** Never close a task on a red suite.
- **Rendering never throws.** `renderPageToPng` / `renderPageToSvg` degrade on unsupported or malformed content. No task may introduce a throw that escapes to the caller.
- **ExtGState presence is tested with `dict.has(key)`, never `doc.resolve(d.get(key)) !== undefined`.** `doc.resolve(undefined)` returns `null`, making the latter true for *every absent key*. `/SMask` absent (inherit) and `/SMask /None` (clear) are different states.
- **Budget constants (fixed, not exposed as options):** offscreen nest depth `8`; tile blits per fill `65_536`; each offscreen allocated over the current clip bbox, not the full page.
- **Out of scope, document rather than implement:** knockout groups (`/K true`); backdrop removal for non-isolated groups.
- Use `bd` for task tracking. Do NOT use TodoWrite or markdown TODO lists.

---

## File Structure

**Modified:**
- `src/pagerender.ts` — `case 'gs'`, extended `GState`, `TilingPattern`, offscreen recursion for soft masks / tiles / groups. The interpreter.
- `src/raster.ts` — `BlendMode` application in `Canvas.blend`, the `Paint` coverage bundle, offscreen `Canvas` stack, tile blitting, group compositing.
- `src/svgrender.ts` — `setAlpha`/`setBlend`/`beginOffscreen`/`endOffscreen` emitting `<mask>`, `<pattern>`, `<g>`.
- `README.md` — the *Rendering (page → PNG)* bullet and the two limitation bullets.

**Created:**
- `src/blend.ts` — the sixteen ISO 32000 §11.3.5 blend functions and the `BlendMode` type. Pure arithmetic, no PDF knowledge, no imports. Kept separate because it is self-contained and `raster.ts` is already ~48 KB.
- `test/helpers/build-transparency-fixtures.ts` — fixture builders, mirroring `build-svg-fixtures.ts`.
- `test/raster-transparency.test.ts` — raster pixel-probe assertions.
- `test/svg-transparency.test.ts` — SVG structural markup assertions.

---

## Task 1: `Paint` coverage bundle and blend-mode plumbing (pure refactor)

Today every paint function takes `clip?: ClipMask` and calls `canvas.blend(x, y, color, cov)`. Alpha, soft mask, and blend mode all need to reach those same call sites. Threading three more parameters through five functions would be noisy and error-prone, so this task introduces one object that carries them — with **no behavior change**, proven by the existing suite staying green.

**Files:**
- Create: `src/blend.ts`
- Modify: `src/raster.ts` (`Canvas.blend`, `ClipMask` section, all five `rasterize*` functions, `RasterSink`)
- Test: existing suite is the regression test; plus `test/raster-transparency.test.ts` (created here)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `src/blend.ts`: `export type BlendMode = 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten' | 'ColorDodge' | 'ColorBurn' | 'HardLight' | 'SoftLight' | 'Difference' | 'Exclusion' | 'Hue' | 'Saturation' | 'Color' | 'Luminosity'` and `export function blendPixel(mode: BlendMode, cb: Rgb01, cs: Rgb01): Rgb01`, where `type Rgb01 = [number, number, number]` in 0..1.
  - `src/raster.ts`: `class Paint { constructor(clip?: ClipMask, softMask?: ClipMask, alpha?: number, blend?: BlendMode); at(px: number, py: number): number; readonly blend: BlendMode; bounds(w: number, h: number): { x0: number; y0: number; x1: number; y1: number } }`
  - `Canvas.blend(x: number, y: number, color: Rgb, cov: number, mode?: BlendMode): void`

- [ ] **Step 1: Create `src/blend.ts` with `Normal` only**

Only `Normal` is implemented here; Task 6 and Task 7 fill in the rest. This keeps the refactor a true no-op.

```ts
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

/** Blend backdrop `cb` with source `cs`, both 0..1. */
export function blendPixel(mode: BlendMode, cb: Rgb01, cs: Rgb01): Rgb01 {
  if (mode === 'Normal') return cs;
  return cs;   // Tasks 6 and 7 replace this line with the full dispatch.
}
```

- [ ] **Step 2: Add the `Paint` class to `src/raster.ts`**

Insert directly below the `ClipMask` class (after its closing brace, near line 215).

```ts
/** Everything that scales a paint operation's coverage, bundled so the five
 *  rasterize* entry points take one parameter instead of four: the clip, the
 *  soft mask (a separate slot — /SMask /None clears it without touching the
 *  clip), constant alpha (ca/CA), and the blend mode. */
class Paint {
  constructor(
    readonly clip?: ClipMask,
    readonly softMask?: ClipMask,
    readonly alpha: number = 1,
    readonly blend: BlendMode = 'Normal',
  ) {}

  /** Combined coverage multiplier at a device pixel: clip × softMask × alpha. */
  at(px: number, py: number): number {
    let v = this.alpha;
    if (v <= 0) return 0;
    if (this.clip) { v *= this.clip.at(px, py); if (v <= 0) return 0; }
    if (this.softMask) v *= this.softMask.at(px, py);
    return v;
  }

  /** Device region this paint can touch, clamped to a `w`×`h` canvas. */
  bounds(w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
    const c = this.clip;
    return {
      x0: Math.max(0, c ? c.x0 : 0), y0: Math.max(0, c ? c.y0 : 0),
      x1: Math.min(w, c ? c.x1 : w), y1: Math.min(h, c ? c.y1 : h),
    };
  }
}
```

Add the import at the top of `src/raster.ts`:

```ts
import { BlendMode, blendPixel } from './blend.js';
```

- [ ] **Step 3: Give `Canvas.blend` a mode parameter**

Replace the body of `Canvas.blend` (raster.ts ~line 45). The `Normal` fast path is byte-identical to today's code, so existing pixel assertions cannot move.

```ts
  /** Source-over composite `color` at coverage `cov` (0..1) onto pixel (x,y),
   *  through blend function `mode` (PDF 32000-1 §11.3.5). */
  blend(x: number, y: number, color: Rgb, cov: number, mode: BlendMode = 'Normal'): void {
    if (cov <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const sa = cov > 1 ? 1 : cov;
    const dr = d[i], dg = d[i + 1], db = d[i + 2], da = d[i + 3];
    const inv = 1 - sa;
    const oa = sa + da * inv;
    if (oa <= 0) return;
    let sr = color[0] / 255, sg = color[1] / 255, sb = color[2] / 255;
    if (mode !== 'Normal' && da > 0) {
      // Blend against the backdrop, weighted by backdrop alpha (§11.3.6):
      // where the backdrop is transparent the source shows through unblended.
      const [br, bg, bb] = blendPixel(mode, [dr, dg, db], [sr, sg, sb]);
      sr = sr * (1 - da) + br * da;
      sg = sg * (1 - da) + bg * da;
      sb = sb * (1 - da) + bb * da;
    }
    d[i]     = (sr * sa + dr * da * inv) / oa;
    d[i + 1] = (sg * sa + dg * da * inv) / oa;
    d[i + 2] = (sb * sa + db * da * inv) / oa;
    d[i + 3] = oa;
  }
```

- [ ] **Step 4: Replace `clip?: ClipMask` with `paint: Paint` in the five rasterize functions**

In `src/raster.ts`, change these signatures and every internal use:

| Line (approx) | From | To |
|---|---|---|
| 310 | `rasterizeFill(canvas, polys, color, evenOdd, clip?: ClipMask)` | `rasterizeFill(canvas, polys, color, evenOdd, paint: Paint)` |
| 492 | `rasterizeStroke(canvas, path, ctm, color, style, clip?: ClipMask)` | `rasterizeStroke(canvas, path, ctm, color, style, paint: Paint)` |
| 679 | `rasterizeImage(canvas, img, ctm, clip?: ClipMask)` | `rasterizeImage(canvas, img, ctm, paint: Paint)` |
| 853 | `rasterizeGlyphRun(canvas, info, src, clip?: ClipMask)` | `rasterizeGlyphRun(canvas, info, src, paint: Paint)` |
| 957 | `rasterizeShading(canvas, doc, dict, ctm, clip?: ClipMask)` | `rasterizeShading(canvas, doc, dict, ctm, paint: Paint)` |

Inside each, apply these three mechanical edits:

1. `if (clip) { cov *= clip.at(x, y); ... }` → `cov *= paint.at(x, y);` followed by `if (cov <= 1e-4) continue;`
2. `canvas.blend(x, y, color, cov)` → `canvas.blend(x, y, color, cov, paint.blend)`
3. In `rasterizeShading`, replace the four clip-bbox lines (raster.ts ~963–966) with:

```ts
  const { x0: ix0, y0: iy0, x1: ix1, y1: iy1 } = paint.bounds(canvas.w, canvas.h);
```

`rasterizeFill` does not touch the canvas itself — it delegates to `Accumulator.composite(canvas, ox, oy, color, evenOdd, clip)`. That method carries the sixth `clip?: ClipMask` parameter too, so it changes with the others: take `paint: Paint`, multiply coverage by `paint.at(x, y)` instead of `clip.at(x, y)`, and pass `paint.blend` to `canvas.blend`. Missing this one is the likely cause if fills stop honoring alpha while strokes work.

- [ ] **Step 5: Hold the `Paint` in `RasterSink`**

Replace the `RasterSink` field and save/restore block (raster.ts ~1017–1030):

```ts
class RasterSink implements RenderSink {
  private paint = new Paint();
  private stack: Paint[] = [];
  private glyphSources = new Map<PdfDict, GlyphSource>();

  constructor(private doc: Document, private canvas: Canvas) {}

  save(): void { this.stack.push(this.paint); }
  restore(): void { if (this.stack.length) this.paint = this.stack.pop()!; }

  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void {
    const mask = rasterizeClip(path, ctm, evenOdd, this.canvas.w, this.canvas.h);
    const clip = this.paint.clip ? this.paint.clip.intersect(mask) : mask;
    this.paint = new Paint(clip, this.paint.softMask, this.paint.alpha, this.paint.blend);
  }
```

Then update the five paint methods to pass `this.paint` where they passed `this.clip`. Note `stroke` uses `strokeAlpha` from Task 2; for now every site passes `this.paint` unchanged.

- [ ] **Step 6: Run the full suite to prove the refactor is a no-op**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean; every test that passed before still passes. **If any raster pixel assertion moves, the refactor is wrong — fix it rather than updating the expectation.** That is the entire point of this task.

- [ ] **Step 7: Commit**

```bash
git add src/blend.ts src/raster.ts
git commit -m "refactor(raster): bundle clip/mask/alpha/blend into a Paint context

No behavior change. Threads one object through the five rasterize entry
points so alpha, soft masks and blend modes have a place to arrive.
Canvas.blend gains a mode parameter whose Normal path is byte-identical."
```

---

## Task 2: The `gs` operator and constant alpha (`ca` / `CA`)

Stage 1 of the spec. The `gs` operator has no `case` in the interpreter today, so `/ExtGState` is never read at all.

**Files:**
- Modify: `src/pagerender.ts` (GState, `RenderSink`, `initialState`, op switch), `src/raster.ts` (`RasterSink.setAlpha`/`setBlend`), `src/svgrender.ts` (`SvgSink.setAlpha`/`setBlend`)
- Create: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`, `test/svg-transparency.test.ts`

**Interfaces:**
- Consumes: `BlendMode`, `blendModeFromName` from `src/blend.ts` (Task 1).
- Produces:
  - `GState` fields `fillAlpha: number`, `strokeAlpha: number`, `blend: BlendMode`, `softMask?: SoftMaskRef`.
  - `RenderSink.setAlpha(fill: number, stroke: number): void` and `RenderSink.setBlend(mode: BlendMode): void`.
  - `test/helpers/build-transparency-fixtures.ts`: `export function constantAlphaPdf(): Uint8Array`.

- [ ] **Step 1: Write the failing tests**

Create `test/helpers/build-transparency-fixtures.ts`:

```ts
import { buildSvgPdf } from './build-svg-fixtures.js';

/** 200×200 page: an opaque red 100×100 square drawn at ca 0.5 over white.
 *  Expected composite over the white background: (255, 128, 128). */
export function constantAlphaPdf(): Uint8Array {
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /ExtGState << /GS0 << /Type /ExtGState /ca 0.5 /CA 0.5 >> >> >>',
    content: 'q /GS0 gs 1 0 0 rg 50 50 100 100 re f Q',
  });
}
```

Create `test/raster-transparency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { constantAlphaPdf } from './helpers/build-transparency-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 2) => Math.abs(v - target) <= tol;

describe('Page.ToImage — ExtGState constant alpha', () => {
  it('composites a ca 0.5 red fill over white as (255, 128, 128)', () => {
    const p = decodePng(Document.Open(constantAlphaPdf()).Pages[0].ToImage());
    // User (50..150)² → device (50..150)² after the Y-flip (square is centered).
    const [r, g, b] = p.at(100, 100);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
    // Outside the square: untouched white.
    expect(p.at(10, 10)).toEqual([255, 255, 255, 255]);
  });
});
```

Create `test/svg-transparency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { constantAlphaPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToSvg — ExtGState constant alpha', () => {
  it('emits fill-opacity for ca', () => {
    const svg = Document.Open(constantAlphaPdf()).Pages[0].ToSvg();
    expect(svg).toMatch(/fill-opacity="0\.5"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run test/raster-transparency.test.ts test/svg-transparency.test.ts
```

Expected: FAIL. The raster probe reports `(255, 0, 0)` — fully opaque red, because `gs` is ignored. The SVG test finds no `fill-opacity`.

- [ ] **Step 3: Extend `GState` and `RenderSink` in `src/pagerender.ts`**

Add to the `GState` interface (after `fillPattern`):

```ts
  /** ExtGState constant alpha (ca / CA) and blend mode (BM). */
  fillAlpha: number; strokeAlpha: number; blend: BlendMode;
  /** Active ExtGState /SMask: the mask dict plus the CTM in force when `gs` ran. */
  softMask?: SoftMaskRef;
```

Add above it:

```ts
/** An ExtGState /SMask awaiting realization: the mask dict and the CTM that was
 *  current when the `gs` that set it executed (the mask's /G is rendered in that
 *  space, not the space of whatever paints through it later). */
export interface SoftMaskRef { dict: PdfDict; ctm: Matrix; }
```

Add to `initialState`'s returned object:

```ts
    fillAlpha: 1, strokeAlpha: 1, blend: 'Normal',
```

Add to the `RenderSink` interface:

```ts
  setAlpha(fill: number, stroke: number): void;
  setBlend(mode: BlendMode): void;
```

Import at the top: `import { BlendMode, blendModeFromName } from './blend.js';`

- [ ] **Step 4: Implement the `gs` operator**

Add this helper next to `resolveShadingPattern` in `src/pagerender.ts`:

```ts
/** Apply a named /ExtGState resource to `gs` (PDF 32000-1 §8.4.5, table 58).
 *  Presence is tested with `has`, never with a resolved value: doc.resolve of an
 *  absent key returns null, which is indistinguishable from a present null — and
 *  /SMask absent (inherit) must not be confused with /SMask /None (clear). */
function applyExtGState(ctx: RenderCtx, gs: GState, name: string): void {
  const egs = resDict(ctx, 'ExtGState');
  if (!egs) return;
  const d = ctx.doc.resolve(egs.get(name));
  if (!isDict(d)) return;
  const R = (k: string) => ctx.doc.resolve(d.get(k));

  if (d.has('ca')) { const v = R('ca'); if (typeof v === 'number') gs.fillAlpha = clamp01(v); }
  if (d.has('CA')) { const v = R('CA'); if (typeof v === 'number') gs.strokeAlpha = clamp01(v); }
  if (d.has('LW')) { const v = R('LW'); if (typeof v === 'number') gs.lineWidth = v; }
  if (d.has('BM')) {
    // /BM is a name, or an array of names with the first recognized one winning
    // (Illustrator emits the array form).
    const v = R('BM');
    if (isName(v)) gs.blend = blendModeFromName(v.name);
    else if (isArray(v)) {
      const first = v.map((x) => ctx.doc.resolve(x)).find((x) => isName(x));
      gs.blend = isName(first) ? blendModeFromName(first.name) : 'Normal';
    }
  }
  if (d.has('SMask')) {
    const v = R('SMask');
    // /None (or anything not a dict) clears; a dict sets, captured at this CTM.
    gs.softMask = isDict(v) ? { dict: v, ctm: gs.ctm } : undefined;
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
```

Add the case to the op switch, next to the other state operators (after `case 'd':`):

```ts
      case 'gs': {
        const gn = o[0];
        if (isName(gn)) { applyExtGState(ctx, gs, gn.name); syncPaintState(ctx, gs); }
        break;
      }
```

- [ ] **Step 5: Push alpha and blend to the sink at every paint**

The sink's alpha differs between fill and stroke, so it is set per operation rather than only on `gs`. Add this helper to `src/pagerender.ts`:

```ts
/** Push the gstate's alpha and blend mode to the sink. Called after `gs` and
 *  before each paint, since fill and stroke draw different alphas from ca/CA. */
function syncPaintState(ctx: RenderCtx, gs: GState): void {
  ctx.sink.setAlpha(gs.fillAlpha, gs.strokeAlpha);
  ctx.sink.setBlend(gs.blend);
}
```

In `walk`, call it at the top of `doFill` and `doStroke` (after `flushClip()`), and inside `case 'Do'` before `sink.image(...)`.

- [ ] **Step 6: Implement `setAlpha` / `setBlend` in both sinks**

`src/raster.ts`, in `RasterSink` — note fill and stroke alpha are held separately and selected per operation:

```ts
  private fillAlpha = 1;
  private strokeAlpha = 1;

  setAlpha(fill: number, stroke: number): void { this.fillAlpha = fill; this.strokeAlpha = stroke; }
  setBlend(mode: BlendMode): void {
    this.paint = new Paint(this.paint.clip, this.paint.softMask, this.paint.alpha, mode);
  }

  /** The Paint for one operation, with the right alpha selected. */
  private paintFor(kind: 'fill' | 'stroke'): Paint {
    const a = kind === 'fill' ? this.fillAlpha : this.strokeAlpha;
    return new Paint(this.paint.clip, this.paint.softMask, a, this.paint.blend);
  }
```

`save()`/`restore()` must also carry the two alphas — push and pop `{ paint, fillAlpha, strokeAlpha }` rather than `paint` alone:

```ts
  private stack: { paint: Paint; fillAlpha: number; strokeAlpha: number }[] = [];
  save(): void { this.stack.push({ paint: this.paint, fillAlpha: this.fillAlpha, strokeAlpha: this.strokeAlpha }); }
  restore(): void {
    const s = this.stack.pop();
    if (s) { this.paint = s.paint; this.fillAlpha = s.fillAlpha; this.strokeAlpha = s.strokeAlpha; }
  }
```

Then each paint method passes the right one: `fill`, `image`, `glyphRun`, `shading` use `this.paintFor('fill')`; `stroke` uses `this.paintFor('stroke')`.

`src/svgrender.ts`, in `SvgSink`:

```ts
  private fillAlpha = 1;
  private strokeAlpha = 1;
  private blend: BlendMode = 'Normal';

  setAlpha(fill: number, stroke: number): void { this.fillAlpha = fill; this.strokeAlpha = stroke; }
  setBlend(mode: BlendMode): void { this.blend = mode; }

  /** Presentation attributes shared by every painted element. */
  private paintAttrs(kind: 'fill' | 'stroke'): string[] {
    const a: string[] = [];
    const o = kind === 'fill' ? this.fillAlpha : this.strokeAlpha;
    if (o < 1) a.push(`${kind}-opacity="${fmt(o)}"`);
    if (this.blend !== 'Normal') a.push(`style="mix-blend-mode:${blendCss(this.blend)}"`);
    return a;
  }
```

Add the CSS name mapper near `fmt` in `svgrender.ts` — CSS uses lowercase-hyphenated names, PDF uses CamelCase:

```ts
/** PDF /BM name → CSS mix-blend-mode keyword. */
export function blendCss(mode: BlendMode): string {
  return mode.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
```

Push `...this.paintAttrs('fill')` into the `attrs` array in `fill()`, `glyphRun()`, and `image()`; `...this.paintAttrs('stroke')` in `stroke()`. Import `BlendMode` from `./blend.js`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/raster-transparency.test.ts test/svg-transparency.test.ts
```

Expected: PASS.

- [ ] **Step 8: Prove the assertion is load-bearing**

Temporarily change `applyExtGState` so `gs.fillAlpha` is never assigned (comment out the `ca` line). Re-run:

```bash
npx vitest run test/raster-transparency.test.ts
```

Expected: FAIL, with green reported as `0` instead of `128`. Restore the line and confirm PASS. Per CLAUDE.md, a fixture passing on first run is not evidence.

- [ ] **Step 9: Run the full suite and commit**

```bash
npm run typecheck && npm test
git add src/pagerender.ts src/raster.ts src/svgrender.ts test/
git commit -m "feat(render): implement the gs operator and constant alpha

The ExtGState operator had no case in the interpreter, so ca/CA/BM/SMask
were all silently ignored. Adds the operator, the gstate fields, and
alpha compositing in both sinks. ExtGState keys are read through has(),
since resolve() of an absent key returns null."
```

---

## Task 3: Offscreen infrastructure and soft masks

Stage 2 of the spec. This task builds the `beginOffscreen`/`endOffscreen` mechanism that Tasks 4 and 8 also consume, with soft masks as its first consumer.

**Files:**
- Modify: `src/pagerender.ts` (`RenderSink`, `OffscreenUse`, soft-mask realization), `src/raster.ts` (offscreen `Canvas` stack), `src/svgrender.ts` (buffered `<defs>`)
- Test: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`, `test/svg-transparency.test.ts`

**Interfaces:**
- Consumes: `Paint`, `Canvas` (Task 1); `SoftMaskRef`, `syncPaintState` (Task 2).
- Produces:
  - `RenderSink.beginOffscreen(): void` and `RenderSink.endOffscreen(use: OffscreenUse): void`.
  - `export type OffscreenUse = { kind: 'softmask'; luminosity: boolean; backdrop?: Rgb } | { kind: 'tile'; bbox: number[]; xstep: number; ystep: number; matrix: Matrix } | { kind: 'group'; alpha: number; blend: BlendMode; isolated: boolean }` in `src/pagerender.ts`.
  - `MAX_OFFSCREEN_DEPTH = 8` in `src/pagerender.ts`.
  - `test/helpers/build-transparency-fixtures.ts`: `export function luminositySoftMaskPdf(): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
import { flate } from './build-svg-fixtures.js';

/** 200×200 page. A luminosity soft mask whose group paints white over the left
 *  half (user x 0..100) and black over the right half, then a red 200×200 fill
 *  through it. White luminance = 1 → fully painted; black = 0 → fully masked.
 *  Expected: left half red (255,0,0), right half untouched white. */
export function luminositySoftMaskPdf(): Uint8Array {
  const groupContent = flate('1 g 0 0 100 200 re f 0 g 100 0 100 200 re f');
  const group = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /CS /DeviceGray >> /Filter /FlateDecode /Length ${groupContent.length} >>`,
    raw: groupContent,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /ExtGState << /GS0 << /Type /ExtGState /SMask << /S /Luminosity /G 5 0 R >> >> >> >>',
    content: 'q /GS0 gs 1 0 0 rg 0 0 200 200 re f Q',
    extra: { 5: group },
  });
}
```

Append to `test/raster-transparency.test.ts`:

```ts
import { luminositySoftMaskPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToImage — ExtGState luminosity soft mask', () => {
  it('paints where the mask is white and masks out where it is black', () => {
    const p = decodePng(Document.Open(luminositySoftMaskPdf()).Pages[0].ToImage());
    expect(p.at(50, 100).slice(0, 3)).toEqual([255, 0, 0]);        // under white mask
    expect(p.at(150, 100)).toEqual([255, 255, 255, 255]);          // under black mask
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "soft mask"
```

Expected: FAIL — the right half reports `(255, 0, 0)`, because the mask is ignored and the red fill covers the whole page.

- [ ] **Step 3: Add the sink methods and `OffscreenUse` to `src/pagerender.ts`**

```ts
/** What the sink should do with the offscreen buffer being closed. */
export type OffscreenUse =
  | { kind: 'softmask'; luminosity: boolean; backdrop?: Rgb }
  | { kind: 'tile'; bbox: number[]; xstep: number; ystep: number; matrix: Matrix }
  | { kind: 'group'; alpha: number; blend: BlendMode; isolated: boolean };

/** Max nesting of offscreen buffers (groups, masks, tiles). Beyond this the
 *  construct degrades to inline drawing rather than allocating further. */
export const MAX_OFFSCREEN_DEPTH = 8;
```

Add to `RenderSink`:

```ts
  beginOffscreen(): void;
  endOffscreen(use: OffscreenUse): void;
```

- [ ] **Step 4: Realize the soft mask in the interpreter**

Add to `src/pagerender.ts`:

```ts
/** Render an ExtGState /SMask's /G group into an offscreen buffer and hand it to
 *  the sink as a coverage mask (PDF 32000-1 §11.6.5). The group is drawn in the
 *  CTM that was current when the `gs` executed, which is why SoftMaskRef carries
 *  it. A malformed mask degrades to no mask — never to a throw. */
function realizeSoftMask(ctx: RenderCtx, ref: SoftMaskRef): void {
  if (ctx.depth >= MAX_OFFSCREEN_DEPTH) return;
  const g = ctx.doc.resolve(ref.dict.get('G'));
  if (!isStream(g)) return;

  const s = ctx.doc.resolve(ref.dict.get('S'));
  const luminosity = isName(s) && s.name === 'Luminosity';

  // /BC is in the group's own colorspace; only its use as a luminosity backdrop
  // matters here, and only for luminosity masks (§11.6.5.2).
  let backdrop: Rgb | undefined;
  if (luminosity && ref.dict.has('BC')) {
    const grp = ctx.doc.resolve(g.dict.get('Group'));
    const csObj = isDict(grp) ? grp.get('CS') : undefined;
    const cs = csObj !== undefined ? resolveColorSpace(csObj, r(ctx), inf(ctx)) : deviceGray();
    backdrop = cs.toRgb(arrNums(ctx.doc, ref.dict.get('BC')));
  }

  try {
    ctx.sink.beginOffscreen();
    const st = initialState(ref.ctm);
    drawForm({ ...ctx, depth: ctx.depth + 1 }, st, g);
    ctx.sink.endOffscreen({ kind: 'softmask', luminosity, backdrop });
  } catch {
    // Degrade: the offscreen is closed by endOffscreen in the happy path; on a
    // throw the sink discards it (see RasterSink.endOffscreen's guard).
    ctx.sink.endOffscreen({ kind: 'softmask', luminosity: false });
  }
}
```

Call it from `syncPaintState` so a mask set by `gs` is realized before the next paint. Replace the Task 2 version:

```ts
function syncPaintState(ctx: RenderCtx, gs: GState): void {
  ctx.sink.setAlpha(gs.fillAlpha, gs.strokeAlpha);
  ctx.sink.setBlend(gs.blend);
  if (gs.softMask !== gs.appliedMask) {
    if (gs.softMask) realizeSoftMask(ctx, gs.softMask);
    else ctx.sink.clearSoftMask();
    gs.appliedMask = gs.softMask;
  }
}
```

Add `appliedMask?: SoftMaskRef` to `GState` (tracks which mask the sink currently holds, so a mask is rendered once per `gs`, not once per paint), and `clearSoftMask(): void` to `RenderSink`.

- [ ] **Step 5: Implement the offscreen stack in `RasterSink`**

```ts
  private offscreen: { canvas: Canvas; saved: Canvas }[] = [];

  beginOffscreen(): void {
    if (this.offscreen.length >= MAX_OFFSCREEN_DEPTH) { this.offscreen.push({ canvas: this.canvas, saved: this.canvas }); return; }
    // Allocate over the clip bbox, not the page: a small masked logo costs a few
    // KB rather than the ~30 MB a full-page Float32Array takes at scale 4.
    const b = this.paint.bounds(this.canvas.w, this.canvas.h);
    const sub = new Canvas(Math.max(1, b.x1 - b.x0), Math.max(1, b.y1 - b.y0), false);
    sub.originX = b.x0; sub.originY = b.y0;
    this.offscreen.push({ canvas: sub, saved: this.canvas });
    this.canvas = sub;
  }

  endOffscreen(use: OffscreenUse): void {
    const top = this.offscreen.pop();
    if (!top) return;
    const buf = this.canvas;
    this.canvas = top.saved;
    if (buf === top.saved) return;                 // depth cap hit: nothing buffered
    if (use.kind === 'softmask') this.applySoftMask(buf, use);
    else if (use.kind === 'tile') this.blitTile(buf, use);       // Task 4
    else this.composeGroup(buf, use);                            // Task 8
  }

  /** Convert an offscreen buffer to a coverage mask and install it in the Paint. */
  private applySoftMask(buf: Canvas, use: Extract<OffscreenUse, { kind: 'softmask' }>): void {
    const data = new Float32Array(buf.w * buf.h);
    const bd = use.backdrop ? (0.3 * use.backdrop[0] + 0.59 * use.backdrop[1] + 0.11 * use.backdrop[2]) / 255 : 0;
    for (let i = 0; i < buf.w * buf.h; i++) {
      const a = buf.data[i * 4 + 3];
      if (use.luminosity) {
        // Luminance over the backdrop where the group is not fully opaque.
        const l = 0.3 * buf.data[i * 4] + 0.59 * buf.data[i * 4 + 1] + 0.11 * buf.data[i * 4 + 2];
        data[i] = l * a + bd * (1 - a);
      } else {
        data[i] = a;                              // /S /Alpha
      }
    }
    const mask = new ClipMask(buf.originX, buf.originY, buf.originX + buf.w, buf.originY + buf.h, data);
    this.paint = new Paint(this.paint.clip, mask, this.paint.alpha, this.paint.blend);
  }

  clearSoftMask(): void {
    this.paint = new Paint(this.paint.clip, undefined, this.paint.alpha, this.paint.blend);
  }
```

Add mutable `originX`/`originY` fields to `Canvas` (default `0`), used to place a sub-canvas back in device space:

```ts
  originX = 0;
  originY = 0;
```

- [ ] **Step 6: Implement the SVG side**

`SvgWriter` needs a redirect target. Add to `src/svgrender.ts`:

```ts
  /** Redirect emitted body markup into a buffer (for <mask>/<pattern>/<g> defs). */
  private redirect: string[][] = [];
  beginCapture(): void { this.redirect.push([]); }
  endCapture(): string {
    const b = this.redirect.pop();
    return b ? b.join('') : '';
  }
  emit(s: string): void {
    const top = this.redirect[this.redirect.length - 1];
    if (top) top.push(s); else this.body.push(s);
  }
```

Then in `SvgSink`:

```ts
  private maskId: string | undefined;

  beginOffscreen(): void { this.w.beginCapture(); }

  endOffscreen(use: OffscreenUse): void {
    const inner = this.w.endCapture();
    if (use.kind === 'softmask') {
      const id = this.w.nextId('mask');
      const type = use.luminosity ? 'luminance' : 'alpha';
      this.w.addDef(`<mask id="${id}" maskUnits="userSpaceOnUse" style="mask-type:${type}">${inner}</mask>`);
      this.maskId = id;
      this.w.emit(`<g mask="url(#${id})">`);
      this.groupDepth++;
    }
    // 'tile' → Task 4; 'group' → Task 8.
  }

  clearSoftMask(): void {
    if (this.maskId) { this.w.emit('</g>'); this.groupDepth--; this.maskId = undefined; }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/raster-transparency.test.ts
```

Expected: PASS — left half `(255,0,0)`, right half white.

- [ ] **Step 8: Prove the assertion is load-bearing**

Temporarily make `applySoftMask` return without installing the mask. Re-run: expect FAIL with the right half reporting `(255,0,0)`. Restore.

- [ ] **Step 9: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/ test/
git commit -m "feat(render): offscreen buffers and ExtGState soft masks

Adds beginOffscreen/endOffscreen (offscreen Canvas in raster, captured
<defs> markup in SVG) and its first consumer, /SMask luminosity and alpha
masks. The mask occupies a slot separate from the clip so /SMask /None
clears it without discarding the clip. Offscreens allocate over the clip
bbox, not the page."
```

---

## Task 4: Tiling patterns (PatternType 1)

Stage 3 of the spec, fill side. `resolveShadingPattern` currently rejects `PatternType 1` and the caller falls back to mid-gray.

**Files:**
- Modify: `src/pagerender.ts` (`TilingPattern`, `resolvePattern`, `doFill`), `src/raster.ts` (`blitTile`), `src/svgrender.ts` (`<pattern>`)
- Test: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`, `test/svg-transparency.test.ts`

**Interfaces:**
- Consumes: `beginOffscreen`/`endOffscreen`, `OffscreenUse` (Task 3).
- Produces:
  - `interface TilingPattern { stream: PdfStream; matrix: Matrix; bbox: number[]; xstep: number; ystep: number; paintType: number; resources?: PdfDict }` in `src/pagerender.ts`.
  - `MAX_TILE_BLITS = 65_536` in `src/pagerender.ts`.
  - `test/helpers/build-transparency-fixtures.ts`: `export function tilingPatternPdf(): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 100×100 page filled with a 20×20 tiling pattern whose cell paints a blue
 *  10×10 square at the cell origin. User (5,5) lands inside a blue square;
 *  user (15,15) lands in the gap. */
export function tilingPatternPdf(): Uint8Array {
  const cell = flate('0 0 1 rg 0 0 10 10 re f');
  const pattern = {
    dict: `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << >> /Filter /FlateDecode /Length ${cell.length} >>`,
    raw: cell,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern cs /P0 scn 0 0 100 100 re f',
    extra: { 5: pattern },
  });
}
```

Append to `test/raster-transparency.test.ts`:

```ts
import { tilingPatternPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToImage — tiling pattern', () => {
  it('tiles the cell across the filled path', () => {
    const p = decodePng(Document.Open(tilingPatternPdf()).Pages[0].ToImage());
    // Page is 100 tall, so device y = 100 - user y.
    expect(p.at(5, 95).slice(0, 3)).toEqual([0, 0, 255]);      // user (5,5) → in-cell
    expect(p.at(15, 85).slice(0, 3)).toEqual([255, 255, 255]); // user (15,15) → gap
    expect(p.at(45, 55).slice(0, 3)).toEqual([0, 0, 255]);     // user (45,45) → 3rd tile
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "tiling"
```

Expected: FAIL — every probe reports `(128, 128, 128)`, the mid-gray fallback.

- [ ] **Step 3: Resolve tiling patterns in the interpreter**

In `src/pagerender.ts`, add the type and widen the gstate field:

```ts
/** A resolved PatternType 1 (tiling) pattern. */
export interface TilingPattern {
  kind: 'tiling';
  stream: PdfStream; matrix: Matrix;
  bbox: number[]; xstep: number; ystep: number;
  paintType: number;                 // 1 = colored, 2 = uncolored (uses current fill color)
  resources?: PdfDict;
}

export const MAX_TILE_BLITS = 65_536;
```

Tag `ShadingPattern` with `kind: 'shading'` and change `GState.fillPattern` to `ShadingPattern | TilingPattern`. Replace `resolveShadingPattern` with:

```ts
/** Resolve a named pattern to either a shading (type 2) or tiling (type 1)
 *  pattern. Unresolvable names return undefined (caller keeps the gray fallback). */
function resolvePattern(ctx: RenderCtx, name: string): ShadingPattern | TilingPattern | undefined {
  const patDict = resDict(ctx, 'Pattern');
  if (!patDict) return undefined;
  const p = ctx.doc.resolve(patDict.get(name));
  const pd = isStream(p) ? p.dict : isDict(p) ? p : undefined;
  if (!pd) return undefined;
  const mat = arrNums(ctx.doc, pd.get('Matrix'));
  const matrix = mat.length === 6 ? (mat as Matrix) : IDENTITY;
  const type = num(ctx.doc.resolve(pd.get('PatternType')));

  if (type === 2) {
    const sh = ctx.doc.resolve(pd.get('Shading'));
    const shading = isStream(sh) ? sh.dict : isDict(sh) ? sh : undefined;
    return shading ? { kind: 'shading', shading, matrix } : undefined;
  }
  if (type === 1 && isStream(p)) {
    const bbox = arrNums(ctx.doc, pd.get('BBox'));
    if (bbox.length !== 4) return undefined;
    // Degenerate or missing steps fall back to the BBox extent (§8.7.3.1).
    const rawX = num(ctx.doc.resolve(pd.get('XStep')));
    const rawY = num(ctx.doc.resolve(pd.get('YStep')));
    const xstep = Number.isFinite(rawX) && Math.abs(rawX) > 1e-6 ? Math.abs(rawX) : Math.abs(bbox[2] - bbox[0]);
    const ystep = Number.isFinite(rawY) && Math.abs(rawY) > 1e-6 ? Math.abs(rawY) : Math.abs(bbox[3] - bbox[1]);
    if (xstep <= 0 || ystep <= 0) return undefined;
    const res = ctx.doc.resolve(pd.get('Resources'));
    return {
      kind: 'tiling', stream: p, matrix, bbox, xstep, ystep,
      paintType: num(ctx.doc.resolve(pd.get('PaintType'))) === 2 ? 2 : 1,
      resources: isDict(res) ? res : undefined,
    };
  }
  return undefined;
}
```

Update `case 'scn'` to call `resolvePattern` instead of `resolveShadingPattern`.

- [ ] **Step 4: Paint tiling fills**

Replace the `gs.fillPattern` branch of `doFill` in `walk`:

```ts
    if (gs.fillPattern) {
      sink.save();
      sink.addClip(path, gs.ctm, evenOdd);
      if (gs.fillPattern.kind === 'shading') {
        sink.shading(gs.fillPattern.shading, mul(gs.fillPattern.matrix, baseCtm));
      } else {
        paintTiling(ctx, gs, gs.fillPattern, baseCtm);
      }
      sink.restore();
    } else {
      sink.fill(path, gs.ctm, gs.fill, evenOdd);
    }
```

Add:

```ts
/** Paint a tiling pattern over the active clip: interpret the cell exactly once
 *  into an offscreen, then let the sink replicate it on the XStep/YStep lattice.
 *  One interpretation regardless of tile count — a 2pt cell over a letter page is
 *  ~300k tiles, which as replays would be unaffordable. */
function paintTiling(ctx: RenderCtx, gs: GState, pat: TilingPattern, baseCtm: Matrix): void {
  if (ctx.depth >= MAX_OFFSCREEN_DEPTH || ctx.seen.has(pat.stream.dict)) return;
  const patCtm = mul(pat.matrix, baseCtm);
  let bytes: Uint8Array;
  try { bytes = inflateStream(pat.stream as Parameters<typeof inflateStream>[0]); } catch { return; }

  ctx.sink.beginOffscreen();
  try {
    const st = initialState(mul(translate(pat.bbox[0], pat.bbox[1]), patCtm));
    // PaintType 2 (uncolored): the cell's colour operators are ignored and
    // everything paints in the current fill colour (§8.7.3.1).
    if (pat.paintType === 2) { st.fill = gs.fill; st.stroke = gs.fill; }
    ctx.seen.add(pat.stream.dict);
    walk({ ...ctx, resources: pat.resources ?? ctx.resources, depth: ctx.depth + 1 }, bytes, st);
    ctx.seen.delete(pat.stream.dict);
  } catch {
    // Degrade: whatever the cell drew before failing still tiles.
  }
  ctx.sink.endOffscreen({
    kind: 'tile', bbox: pat.bbox, xstep: pat.xstep, ystep: pat.ystep, matrix: patCtm,
  });
}
```

- [ ] **Step 5: Blit the tile in `RasterSink`**

```ts
  /** Replicate an offscreen cell across the clip bbox on the pattern lattice.
   *  Past MAX_TILE_BLITS the fill degrades to the cell's mean colour — strictly
   *  better than the mid-gray it replaces, and bounded. */
  private blitTile(buf: Canvas, use: Extract<OffscreenUse, { kind: 'tile' }>): void {
    const p = this.paintFor('fill');
    const b = p.bounds(this.canvas.w, this.canvas.h);
    if (b.x1 <= b.x0 || b.y1 <= b.y0) return;

    // Device-space step vectors: the pattern lattice under the pattern matrix.
    const [a, bb, c, d] = use.matrix;
    const sxx = a * use.xstep, sxy = bb * use.xstep;   // one XStep in device space
    const syx = c * use.ystep, syy = d * use.ystep;    // one YStep in device space
    const stepX = Math.hypot(sxx, sxy), stepY = Math.hypot(syx, syy);
    if (stepX < 0.5 || stepY < 0.5) { this.fillMean(buf, p, b); return; }

    const cols = Math.ceil((b.x1 - b.x0) / stepX) + 2;
    const rows = Math.ceil((b.y1 - b.y0) / stepY) + 2;
    if (cols * rows > MAX_TILE_BLITS) { this.fillMean(buf, p, b); return; }

    // The cell origin in device space, then walked back to before the bbox.
    const i0 = Math.floor((b.x0 - buf.originX) / stepX) - 1;
    const j0 = Math.floor((b.y0 - buf.originY) / stepY) - 1;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const ox = Math.round(buf.originX + (i0 + i) * sxx + (j0 + j) * syx);
        const oy = Math.round(buf.originY + (i0 + i) * sxy + (j0 + j) * syy);
        this.blitAt(buf, ox, oy, p, b);
      }
    }
  }

  /** Source-over one offscreen cell at a device offset, through `p`. */
  private blitAt(buf: Canvas, ox: number, oy: number, p: Paint, b: { x0: number; y0: number; x1: number; y1: number }): void {
    for (let y = 0; y < buf.h; y++) {
      const dy = oy + y;
      if (dy < b.y0 || dy >= b.y1) continue;
      for (let x = 0; x < buf.w; x++) {
        const dx = ox + x;
        if (dx < b.x0 || dx >= b.x1) continue;
        const i = (y * buf.w + x) * 4;
        const sa = buf.data[i + 3];
        if (sa <= 0) continue;
        const cov = sa * p.at(dx, dy);
        if (cov <= 1e-4) continue;
        const col: Rgb = [buf.data[i] * 255, buf.data[i + 1] * 255, buf.data[i + 2] * 255];
        this.canvas.blend(dx, dy, col, cov, p.blend);
      }
    }
  }

  /** Budget fallback: flat fill with the cell's alpha-weighted mean colour. */
  private fillMean(buf: Canvas, p: Paint, b: { x0: number; y0: number; x1: number; y1: number }): void {
    let r = 0, g = 0, bl = 0, aw = 0;
    for (let i = 0; i < buf.w * buf.h; i++) {
      const a = buf.data[i * 4 + 3];
      r += buf.data[i * 4] * a; g += buf.data[i * 4 + 1] * a; bl += buf.data[i * 4 + 2] * a; aw += a;
    }
    if (aw <= 0) return;
    const col: Rgb = [(r / aw) * 255, (g / aw) * 255, (bl / aw) * 255];
    const cov = aw / (buf.w * buf.h);
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) {
        const c = cov * p.at(x, y);
        if (c > 1e-4) this.canvas.blend(x, y, col, c, p.blend);
      }
  }
```

- [ ] **Step 6: Emit `<pattern>` in `SvgSink`**

In `endOffscreen`, add the `tile` branch:

```ts
    if (use.kind === 'tile') {
      const id = this.w.nextId('tile');
      this.w.addDef(
        `<pattern id="${id}" patternUnits="userSpaceOnUse" `
        + `x="${fmt(use.bbox[0])}" y="${fmt(use.bbox[1])}" `
        + `width="${fmt(use.xstep)}" height="${fmt(use.ystep)}" `
        + `patternTransform="${matrixAttr(use.matrix)}">${inner}</pattern>`);
      this.pendingPaint = `url(#${id})`;
      return;
    }
```

Add `private pendingPaint: string | undefined;` and have `fill()` prefer it over `rgbHex(color)` when set, clearing it after use.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/raster-transparency.test.ts -t "tiling"
```

Expected: PASS.

- [ ] **Step 8: Prove the assertion is load-bearing**

Temporarily make `resolvePattern` return `undefined` for `type === 1`. Re-run: expect FAIL with all probes reporting `(128,128,128)`. Restore.

- [ ] **Step 9: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/ test/
git commit -m "feat(render): tiling patterns (PatternType 1)

Colored and uncolored cells, interpreted once into an offscreen and
blitted across the clip bbox on the XStep/YStep lattice. Past 65536 tiles
the fill degrades to the cell's mean colour rather than the mid-gray it
replaces. Degenerate steps fall back to the BBox extent."
```

---

## Task 5: `SCN` stroke patterns

Stage 3, stroke side. Cheap because the rasterizer already outlines strokes in user space and fills the outline, so a stroke pattern is the same blit against the outline path.

**Files:**
- Modify: `src/pagerender.ts` (`case 'SCN'`, `doStroke`)
- Test: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: `resolvePattern`, `paintTiling`, `TilingPattern` (Task 4).
- Produces: `GState.strokePattern?: ShadingPattern | TilingPattern`; `test/helpers/build-transparency-fixtures.ts`: `export function strokePatternPdf(): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 100×100 page: a 20-unit-wide stroked horizontal line at user y=50, painted
 *  through a solid-blue tiling pattern. The stroke band spans user y 40..60. */
export function strokePatternPdf(): Uint8Array {
  const cell = flate('0 0 1 rg 0 0 10 10 re f');
  const pattern = {
    dict: `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Filter /FlateDecode /Length ${cell.length} >>`,
    raw: cell,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: '<< /Pattern << /P0 5 0 R >> >>',
    content: '/Pattern CS /P0 SCN 20 w 0 50 m 100 50 l S',
    extra: { 5: pattern },
  });
}
```

Append to `test/raster-transparency.test.ts`:

```ts
import { strokePatternPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToImage — SCN stroke pattern', () => {
  it('paints the stroke band through the pattern', () => {
    const p = decodePng(Document.Open(strokePatternPdf()).Pages[0].ToImage());
    expect(p.at(50, 50).slice(0, 3)).toEqual([0, 0, 255]);      // inside the band
    expect(p.at(50, 10).slice(0, 3)).toEqual([255, 255, 255]);  // above it
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "stroke pattern"
```

Expected: FAIL — the band reports `(128,128,128)`.

- [ ] **Step 3: Implement**

Add `strokePattern?: ShadingPattern | TilingPattern;` to `GState`. Replace `case 'SCN'`:

```ts
      case 'SCN': {
        const last = o[o.length - 1];
        gs.strokePattern = undefined;
        if (isName(last)) { gs.strokePattern = resolvePattern(ctx, last.name); gs.stroke = [128, 128, 128]; }
        else gs.stroke = gs.strokeCs.toRgb(numbers(o));
        break;
      }
```

Clear `gs.strokePattern = undefined` in `CS`, `G`, `RG`, `K`, and `SC` alongside their existing assignments — mirroring how `scn`'s siblings clear `fillPattern`.

Replace `doStroke`:

```ts
  const doStroke = () => {
    flushClip();
    if (!path.length) return;
    syncPaintState(ctx, gs);
    if (gs.strokePattern) {
      // Clip to the stroke's outline, then paint the pattern through it. The
      // rasterizer already outlines strokes in user space, so this reuses that.
      sink.save();
      sink.clipToStroke(path, gs.ctm, strokeStyle(gs));
      if (gs.strokePattern.kind === 'shading') {
        sink.shading(gs.strokePattern.shading, mul(gs.strokePattern.matrix, baseCtm));
      } else {
        paintTiling(ctx, gs, gs.strokePattern, baseCtm);
      }
      sink.restore();
    } else {
      sink.stroke(path, gs.ctm, gs.stroke, strokeStyle(gs));
    }
  };
```

Add `clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void` to `RenderSink`.

In `src/raster.ts`, `rasterizeStroke` already builds the device-space outline and hands it to `rasterizeFill` at its last two statements. Split that seam so the outline can also become a mask. Extract everything from `const scale = ctmScale(ctm);` down to the `const polys: Poly[] = contours.map(...)` block into:

```ts
/** Build the stroke outline as device-space polygons (the geometry half of
 *  rasterizeStroke), so it can be either filled or turned into a clip mask. */
function strokeOutlinePolys(path: Path, ctm: Matrix, style: StrokeStyle): Poly[] {
  // ...body moved verbatim from rasterizeStroke, ending with:
  return contours.map((c) => {
    const d: number[] = new Array(c.length);
    for (let i = 0; i < c.length; i += 2) { const [dx, dy] = apply(ctm, c[i], c[i + 1]); d[i] = dx; d[i + 1] = dy; }
    return d;
  });
}
```

`rasterizeStroke` then becomes:

```ts
function rasterizeStroke(canvas: Canvas, path: Path, ctm: Matrix, color: Rgb, style: StrokeStyle, paint: Paint): void {
  const polys = strokeOutlinePolys(path, ctm, style);
  if (polys.length) rasterizeFill(canvas, polys, color, false, paint);
}
```

and the mask builder mirrors `rasterizeClip` (raster.ts ~317), which already turns polys into a `ClipMask` through `accumulatePolys`:

```ts
/** The stroke outline as a coverage mask — rasterizeClip, but for a stroke. */
function strokeClipMask(path: Path, ctm: Matrix, style: StrokeStyle, w: number, h: number): ClipMask {
  const r = accumulatePolys(strokeOutlinePolys(path, ctm, style), w, h);
  if (!r) return new ClipMask(0, 0, 0, 0, new Float32Array(0));
  return new ClipMask(r.ox, r.oy, r.ox + r.acc.w, r.oy + r.acc.h, r.acc.coverage(false));
}
```

`RasterSink.clipToStroke` then intersects exactly as `addClip` does:

```ts
  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void {
    const mask = strokeClipMask(path, ctm, style, this.canvas.w, this.canvas.h);
    const clip = this.paint.clip ? this.paint.clip.intersect(mask) : mask;
    this.paint = new Paint(clip, this.paint.softMask, this.paint.alpha, this.paint.blend);
  }
```

In `SvgSink`, emit a `<clipPath>` whose child is the path stroked rather than filled:

```ts
  clipToStroke(path: Path, ctm: Matrix, style: StrokeStyle): void {
    const d = pathToD(path);
    if (!d) return;
    const id = this.w.nextId('sclip');
    this.w.addDef(`<clipPath id="${id}"><path d="${d}" transform="${matrixAttr(ctm)}" `
      + `fill="none" stroke="#000" stroke-width="${fmt(style.width)}"/></clipPath>`);
    this.w.emit(`<g clip-path="url(#${id})">`);
    this.groupDepth++;
  }
```

- [ ] **Step 4: Run to verify it passes, then prove it load-bearing**

```bash
npx vitest run test/raster-transparency.test.ts -t "stroke pattern"
```

Expected: PASS. Then temporarily drop the `gs.strokePattern` branch in `doStroke`; expect FAIL reporting `(128,128,128)`. Restore.

- [ ] **Step 5: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/ test/
git commit -m "feat(render): SCN stroke patterns

Clips to the stroke outline and paints the pattern through it, reusing
the user-space stroke outlining the rasterizer already does."
```

---

## Task 6: Separable blend modes

Stage 4, first half. Task 1 already routed a `BlendMode` into `Canvas.blend`; this fills in the twelve separable functions.

**Files:**
- Modify: `src/blend.ts`
- Test: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`, `test/svg-transparency.test.ts`

**Interfaces:**
- Consumes: `blendPixel`, `BlendMode` (Task 1); `applyExtGState` `/BM` handling (Task 2).
- Produces: `test/helpers/build-transparency-fixtures.ts`: `export function blendModePdf(mode: string): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 100×100 page: a 50% gray backdrop, then an opaque pure-red square over it
 *  through blend mode `mode`. Both fills are opaque, so the probe reads the
 *  blend function's output directly. */
export function blendModePdf(mode: string): Uint8Array {
  return buildSvgPdf({
    mediaBox: [0, 0, 100, 100],
    resources: `<< /ExtGState << /GS0 << /Type /ExtGState /BM /${mode} >> >> >>`,
    content: '0.5 g 0 0 100 100 re f q /GS0 gs 1 0 0 rg 20 20 60 60 re f Q',
  });
}
```

Append to `test/raster-transparency.test.ts`:

```ts
import { blendModePdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToImage — separable blend modes', () => {
  // Backdrop cb = 0.5 everywhere; source cs = (1, 0, 0).
  const cases: [string, [number, number, number]][] = [
    ['Multiply',   [128,   0,   0]],   // cb*cs
    ['Screen',     [255, 128, 128]],   // cb + cs - cb*cs
    ['Darken',     [128,   0,   0]],   // min
    ['Lighten',    [255, 128, 128]],   // max
    ['Difference', [128, 128, 128]],   // |cb - cs|
    ['Exclusion',  [128, 128, 128]],   // cb + cs - 2*cb*cs
  ];
  for (const [mode, expected] of cases) {
    it(`applies ${mode}`, () => {
      const p = decodePng(Document.Open(blendModePdf(mode)).Pages[0].ToImage());
      const [r, g, b] = p.at(50, 50);
      expect([r, g, b].map((v) => Math.round(v / 8) * 8))
        .toEqual(expected.map((v) => Math.round(v / 8) * 8));
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "blend"
```

Expected: FAIL — every mode reports `(255, 0, 0)`, since `blendPixel` still returns `cs`.

- [ ] **Step 3: Implement the twelve separable functions in `src/blend.ts`**

```ts
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
    case 'HardLight':  return cs <= 0.5 ? cb * (2 * cs) : (cb + (2 * cs - 1) - cb * (2 * cs - 1));
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
```

Replace `blendPixel`'s body:

```ts
export function blendPixel(mode: BlendMode, cb: Rgb01, cs: Rgb01): Rgb01 {
  if (mode === 'Normal') return cs;
  if (SEPARABLE.has(mode)) {
    return [
      separable(mode, cb[0], cs[0]),
      separable(mode, cb[1], cs[1]),
      separable(mode, cb[2], cs[2]),
    ];
  }
  return cs;   // Non-separable modes land in Task 7.
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/raster-transparency.test.ts -t "blend"
```

Expected: PASS, all six cases.

- [ ] **Step 5: Add the SVG structural assertion**

Append to `test/svg-transparency.test.ts`:

```ts
import { blendModePdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToSvg — blend modes', () => {
  it('emits mix-blend-mode with the CSS spelling', () => {
    const svg = Document.Open(blendModePdf('ColorDodge')).Pages[0].ToSvg();
    expect(svg).toContain('mix-blend-mode:color-dodge');
  });
});
```

Run: `npx vitest run test/svg-transparency.test.ts`. Expected: PASS (Task 2 added `blendCss`).

- [ ] **Step 6: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/blend.ts test/
git commit -m "feat(render): separable blend modes

The twelve separable functions of ISO 32000-1 11.3.5.2, verified against
hand-computed composites of a known backdrop and source."
```

---

## Task 7: Non-separable blend modes

Stage 4, second half: Hue, Saturation, Color, Luminosity. These need whole-pixel RGB rather than per-component math.

**Files:**
- Modify: `src/blend.ts`
- Test: `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: `blendPixel`, `separable`, `Rgb01` (Tasks 1, 6).
- Produces: nothing new — completes `blendPixel`.

- [ ] **Step 1: Write the failing test**

Append to `test/raster-transparency.test.ts`:

```ts
describe('Page.ToImage — non-separable blend modes', () => {
  it('applies Luminosity: source luminance, backdrop hue', () => {
    // Backdrop is neutral gray 0.5 (no hue), source is pure red (lum 0.3).
    // Luminosity keeps the backdrop's (absent) hue and takes the source's
    // luminance → neutral gray at 0.3 → 77.
    const p = decodePng(Document.Open(blendModePdf('Luminosity')).Pages[0].ToImage());
    const [r, g, b] = p.at(50, 50);
    for (const v of [r, g, b]) expect(Math.abs(v - 77)).toBeLessThanOrEqual(4);
  });

  it('applies Color: source hue, backdrop luminance', () => {
    // Source red at backdrop luminance 0.5. ClipColor scales red toward its
    // luminance 0.3, so the result is a light red, not pure red — the green and
    // blue channels must be well above zero.
    const p = decodePng(Document.Open(blendModePdf('Color')).Pages[0].ToImage());
    const [r, g, b] = p.at(50, 50);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(20);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(4);   // red hue keeps G == B
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "non-separable"
```

Expected: FAIL — both report `(255, 0, 0)`.

- [ ] **Step 3: Implement §11.3.5.3 in `src/blend.ts`**

```ts
// ---- Non-separable modes (§11.3.5.3) ----

function lum(c: Rgb01): number { return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; }

/** Clip a colour back into [0,1] about its luminosity, preserving hue. */
function clipColor(c: Rgb01): Rgb01 {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb01;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb01;
  return out;
}

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
```

Replace the `return cs;` fallthrough in `blendPixel`:

```ts
  switch (mode) {
    case 'Hue':        return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'Saturation': return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'Color':      return setLum(cs, lum(cb));
    case 'Luminosity': return setLum(cb, lum(cs));
    default:           return cs;
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run test/raster-transparency.test.ts -t "non-separable"
```

Expected: PASS.

- [ ] **Step 5: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/blend.ts test/
git commit -m "feat(render): non-separable blend modes

Hue, Saturation, Color and Luminosity per ISO 32000-1 11.3.5.3,
completing the sixteen-mode set."
```

---

## Task 8: Transparency groups

Stage 5. The only feature needing a true offscreen *colour* composite rather than a coverage mask.

**Files:**
- Modify: `src/pagerender.ts` (`drawForm`), `src/raster.ts` (`composeGroup`), `src/svgrender.ts` (`<g opacity>`)
- Test: `test/helpers/build-transparency-fixtures.ts`, `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: `beginOffscreen`/`endOffscreen`, `OffscreenUse` (Task 3).
- Produces: `test/helpers/build-transparency-fixtures.ts`: `export function isolatedGroupPdf(): Uint8Array`.

- [ ] **Step 1: Write the failing test — the load-bearing one**

This is the only assertion in the suite that distinguishes a real offscreen composite from inline drawing. Two overlapping opaque squares inside a group at `ca 0.5`: drawn inline the overlap composites twice and reads `(255, 64, 64)`; composited through an offscreen the group is flattened first and the overlap reads `(255, 128, 128)`, the same as the non-overlapping part.

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 200×200 page: an isolated transparency group containing two overlapping
 *  opaque red squares, drawn at ca 0.5 over white.
 *    - correct (offscreen): overlap == non-overlap == (255, 128, 128)
 *    - broken  (inline):    overlap double-composites to (255, 64, 64) */
export function isolatedGroupPdf(): Uint8Array {
  const inner = flate('1 0 0 rg 20 20 80 80 re f 60 60 80 80 re f');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I true /CS /DeviceRGB >> `
      + `/Resources << >> /Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: 'q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}
```

Append to `test/raster-transparency.test.ts`:

```ts
import { isolatedGroupPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToImage — isolated transparency group', () => {
  it('composites the group once, so the overlap does not double-darken', () => {
    const p = decodePng(Document.Open(isolatedGroupPdf()).Pages[0].ToImage());
    // Overlap of the two squares: user (60..100)² → device y = 200 - user y.
    const [or_, og, ob] = p.at(80, 120);
    // Non-overlapping part of the first square.
    const [nr, ng, nb] = p.at(30, 170);
    for (const [a, b] of [[or_, nr], [og, ng], [ob, nb]]) {
      expect(Math.abs(a - b)).toBeLessThanOrEqual(2);   // identical: group flattened first
    }
    expect(Math.abs(og - 128)).toBeLessThanOrEqual(3);   // not 64
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run test/raster-transparency.test.ts -t "transparency group"
```

Expected: FAIL — overlap green reads ~64 against the non-overlap's ~128, because `drawForm` draws inline.

- [ ] **Step 3: Route isolated groups through an offscreen in `drawForm`**

Insert at the top of `drawForm`, after the depth/cycle guard:

```ts
  // A transparency group needs its own buffer only when compositing it as a unit
  // differs from drawing it inline — i.e. when group alpha, a blend mode, or a
  // soft mask applies. At alpha 1 / Normal / no mask the results are identical,
  // which describes most /Group forms, so the expensive path stays rare.
  const grp = ctx.doc.resolve(stream.dict.get('Group'));
  const isTransparency = isDict(grp)
    && (() => { const s = ctx.doc.resolve(grp.get('S')); return isName(s) && s.name === 'Transparency'; })();
  const iso = isTransparency && ctx.doc.resolve(grp.get('I')) === true;
  const needsBuffer = iso
    && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined)
    && ctx.depth < MAX_OFFSCREEN_DEPTH;

  if (needsBuffer) {
    ctx.sink.beginOffscreen();
    const innerState = clone(gs);
    // Contents draw at full strength into the buffer; alpha and blend apply once
    // when the buffer composites down.
    innerState.fillAlpha = 1; innerState.strokeAlpha = 1; innerState.blend = 'Normal';
    innerState.softMask = undefined; innerState.appliedMask = undefined;
    try {
      drawFormBody(ctx, innerState, stream);
    } finally {
      ctx.sink.endOffscreen({ kind: 'group', alpha: gs.fillAlpha, blend: gs.blend, isolated: true });
    }
    return;
  }
```

Rename the existing body of `drawForm` (from `const bytes = inflateStream(...)` to the closing `ctx.sink.restore()`) into a new `drawFormBody(ctx, gs, stream)`, and have `drawForm` call it in the non-buffered path. This keeps the BBox-clip and resource logic in one place.

- [ ] **Step 4: Composite the buffer in `RasterSink`**

```ts
  /** Composite an offscreen group down: one source-over of the flattened buffer,
   *  scaled by group alpha and through the group's blend mode. Compositing once
   *  is exactly what stops overlapping contents inside the group from
   *  double-darkening. */
  private composeGroup(buf: Canvas, use: Extract<OffscreenUse, { kind: 'group' }>): void {
    const p = new Paint(this.paint.clip, this.paint.softMask, use.alpha, use.blend);
    for (let y = 0; y < buf.h; y++) {
      const dy = buf.originY + y;
      if (dy < 0 || dy >= this.canvas.h) continue;
      for (let x = 0; x < buf.w; x++) {
        const dx = buf.originX + x;
        if (dx < 0 || dx >= this.canvas.w) continue;
        const i = (y * buf.w + x) * 4;
        const sa = buf.data[i + 3];
        if (sa <= 0) continue;
        const cov = sa * p.at(dx, dy);
        if (cov <= 1e-4) continue;
        const col: Rgb = [buf.data[i] * 255, buf.data[i + 1] * 255, buf.data[i + 2] * 255];
        this.canvas.blend(dx, dy, col, cov, p.blend);
      }
    }
  }
```

- [ ] **Step 5: Emit a group in `SvgSink`**

In `endOffscreen`, add:

```ts
    if (use.kind === 'group') {
      const attrs = [`opacity="${fmt(use.alpha)}"`, 'isolation="isolate"'];
      if (use.blend !== 'Normal') attrs.push(`style="mix-blend-mode:${blendCss(use.blend)}"`);
      this.w.emit(`<g ${attrs.join(' ')}>${inner}</g>`);
      return;
    }
```

- [ ] **Step 6: Run to verify it passes**

```bash
npx vitest run test/raster-transparency.test.ts -t "transparency group"
```

Expected: PASS — overlap and non-overlap now agree, both at green ≈ 128.

- [ ] **Step 7: Prove the assertion is load-bearing**

Temporarily force `needsBuffer = false`. Re-run: expect FAIL, overlap green ≈ 64 against non-overlap ≈ 128. Restore and confirm PASS. **This is the single most important mutation check in the plan** — without it, a no-op `composeGroup` would pass every other test in the suite.

- [ ] **Step 8: Full suite and commit**

```bash
npm run typecheck && npm test
git add src/ test/
git commit -m "feat(render): isolated transparency groups

Isolated groups with group alpha, a blend mode, or an active soft mask
render to an offscreen and composite once, so overlapping contents no
longer double-darken. Non-isolated groups keep drawing inline (exact at
alpha 1 / Normal); knockout groups are not implemented."
```

---

## Task 9: Documentation and issue closure

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the *Rendering (page → PNG)* bullet**

Find the sentence ending "...other shading types degrade to a mid-gray fill." and add after it:

> Tiling patterns (PatternType 1, colored and uncolored) are rendered by interpreting the pattern cell once into an offscreen buffer and replicating it across the `/XStep`/`/YStep` lattice, as fills and as `SCN` stroke patterns; past 65,536 tiles a fill degrades to the cell's mean color. `/ExtGState` constant alpha (`ca`/`CA`), all sixteen blend modes (`/BM`, ISO 32000-1 §11.3.5, including the four non-separable modes), and `/SMask` soft masks (`/Luminosity` and `/Alpha`, honoring `/BC` and `/TR`) composite per the spec. Isolated transparency groups carrying group alpha, a blend mode, or an active soft mask render to an offscreen and composite as a unit, so overlapping content inside a group does not double-darken.

- [ ] **Step 2: Replace the SVG limitation bullet**

Rewrite the clause "but tiling patterns, `SCN` stroke patterns, blend modes, soft masks, and transparency groups are approximated (mid-gray / BBox clip only)" as:

> Tiling patterns emit `<pattern>`, soft masks `<mask>`, blend modes `mix-blend-mode`, and transparency groups an isolated `<g opacity>`. **This output is verified structurally only** — the test suite asserts that the expected markup is emitted, not that a browser paints it as Acrobat would, since rasterizing our own SVG would require a runtime dependency the library does not take. Exact transparency rendering is therefore viewer-dependent; `page.ToImage()` is the reference.

- [ ] **Step 3: Add the group limitations**

Append a new bullet to the Limitations section:

> - **Transparency groups are isolated-only** — a group with `/I true` that carries group alpha, a blend mode, or a soft mask composites through an offscreen buffer. Non-isolated groups draw inline, which is exact at alpha 1 with Normal blend and an approximation otherwise; correcting it requires initializing the buffer with the page backdrop and subtracting it back out at composite time. Knockout groups (`/K true`) are not implemented. Offscreen nesting is capped at 8 deep, beyond which a group draws inline.

- [ ] **Step 4: Verify the whole suite and typecheck**

```bash
npm run typecheck && npm test && npm run build
```

Expected: all green, `dist/` builds clean.

- [ ] **Step 5: Commit, close the issue, and push**

```bash
git add README.md
git commit -m "docs(render): document transparency, patterns and blend modes

Records what ToImage now renders exactly, that SVG transparency output is
verified structurally rather than against a real renderer, and the
isolated-only group limitation."
bd close aspose-pdf-foss-for-ts-a6i
git pull --rebase
git push
git status    # MUST show "up to date with origin"
```

---

## Self-Review Notes

**Spec coverage.** Stage 1 → Task 2. Stage 2 → Task 3. Stage 3 → Tasks 4 (fill) and 5 (stroke). Stage 4 → Tasks 6 (separable) and 7 (non-separable). Stage 5 → Task 8. Budgets: depth cap in Task 3, tile cap in Task 4, clip-bbox extent in Task 3. Documentation → Task 9. Task 1 is plumbing the spec implies but does not name.

**Deviation from the spec worth flagging at review.** The spec's stage ordering puts blend modes (stage 4) after tiling (stage 3); this plan keeps that order, so Tasks 6–7 land after Tasks 4–5. But `Canvas.blend` gains its mode parameter in **Task 1**, well before the blend functions exist, because threading it later would mean re-touching all five paint sites. `blendPixel` returns `cs` until Task 6, keeping Task 1 a true no-op.

**Known gap carried deliberately.** Between Tasks 6 and 8 a blend mode inside an isolated group blends against the page rather than a transparent backdrop. The spec calls this out; Task 9's README wording is written for the post-Task-8 state, so **do not land the README blend-mode claim before Task 8 is green.**
