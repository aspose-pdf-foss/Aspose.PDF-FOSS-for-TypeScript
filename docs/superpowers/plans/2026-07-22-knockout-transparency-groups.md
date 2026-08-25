# Knockout Transparency Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `/Group /K true` (knockout) transparency groups faithfully in the raster backend (`ToImage`), for both isolated and non-isolated groups.

**Architecture:** A knockout group composites each top-level element against the group's *initial* backdrop (`B0`) rather than the accumulated result (ISO 32000-1 §11.4.6.2, §11.4.8). We implement this by bracketing each top-level painting op in the shared interpreter (`walk`), rendering each element into its own sub-buffer seeded with `B0`, and merging it into the group accumulator with a *shape-weighted replace* (lerp in premultiplied space). This reuses the existing backdrop-seeding and group-alpha machinery from the `bbu` work; the knockout merge is a sibling of `composeGroup`. SVG has no expression for knockout and is left as a documented limitation.

**Tech Stack:** TypeScript (ESM + NodeNext, strict), vitest, zero runtime deps. Design doc: `docs/superpowers/specs/2026-07-22-knockout-transparency-groups-design.md`.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: import specifiers carry the `.js` extension.
- Errors: throw `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` only.
- TDD: land each behavior with a vitest test and a fixture builder in `test/helpers/`, mirroring existing style.
- Fixtures for rendering are built programmatically and asserted against **hand-computed** pixel values; every new assertion must be **mutation-verified** (break the code path, watch it go red).
- Run `npm run typecheck` and `npm test` before closing the issue — both must be green.
- **Decisive fact:** only *semi-transparent* overlapping elements discriminate knockout from ordinary compositing. Opaque overlaps read the topmost element either way. Every load-bearing test therefore uses fractional alpha, which forces the implementation to separate an element's **shape** (geometric coverage, `f_j`) from its **opacity** (`ca`, `q_j`).

---

### Task 1: Isolated knockout groups end-to-end

Builds the whole isolated-knockout path: the sink interface additions (with an SVG no-op), the `/K` detection and buffering trigger, the per-op bracketing in `walk`, the `Canvas` shape channel, the element sub-buffer, and the shape-weighted merge. Gated by a semi-transparent isolated fixture whose overlap distinguishes knockout from ordinary compositing.

**Files:**
- Modify: `src/pagerender.ts` — `RenderSink` interface, `OffscreenUse`, `drawForm`, `drawFormBody`, `walk`.
- Modify: `src/svgrender.ts` — `SvgSink` no-op `beginKnockoutElement`/`endKnockoutElement`.
- Modify: `src/raster.ts` — `Canvas.shape`, `Paint.shapeAt`, `Canvas.blend` shape arg, `Accumulator.composite`, `RasterSink.beginOffscreen` (knockout snapshot), `RasterSink.beginKnockoutElement`/`endKnockoutElement`.
- Create: fixture in `test/helpers/build-transparency-fixtures.ts`.
- Test: `test/raster-transparency.test.ts`.

**Interfaces:**
- Produces (`RenderSink`): `beginKnockoutElement(): void`, `endKnockoutElement(): void`.
- Produces (`OffscreenUse` group variant): adds `knockout: boolean`.
- Produces (raster, private): `Canvas.shape?: Float32Array`, `Canvas.knockoutBackdrop?: Float32Array`, `Paint.shapeAt(px, py): number`, `Canvas.blend(x, y, color, cov, mode?, shapeCov?)`.
- Produces (fixture): `knockoutIsolatedPdf(knockout: boolean): Uint8Array` in `build-transparency-fixtures.ts`.

- [ ] **Step 1: Write the failing test**

Add to `test/raster-transparency.test.ts`. First add the import (append to the existing `build-transparency-fixtures.js` import list):

```ts
  isolatedBlendGroupPdf, nonIsolatedGroupPdf, nonIsolatedBlendGroupPdf,
  fractionalAlphaRemovalGroupPdf, knockoutIsolatedPdf,
} from './helpers/build-transparency-fixtures.js';
```

Then add a new describe block at the end of the file:

```ts
describe('Page.ToImage — knockout transparency groups', () => {
  // Only semi-transparent overlaps discriminate knockout: each element
  // composites against the group's INITIAL (here transparent) backdrop, so in
  // the overlap the topmost element replaces the one beneath rather than
  // compositing over it. Squares are user (40..120)² (red) and (80..160)² (blue),
  // each at inner ca 0.5, in an isolated group over white. Page 200 tall →
  // device y = 200 − user y.
  it('replaces in the overlap instead of compositing over (isolated)', () => {
    const p = decodePng(Document.Open(knockoutIsolatedPdf(true)).Pages[0].ToImage());
    // Overlap user (100,100) → device (100,100): pure blue at 0.5 over white.
    expect(p.at(100, 100).slice(0, 3)).toEqual([128, 128, 255]);
    // Red-only user (60,60) → device (60,140): red at 0.5 over white.
    expect(p.at(60, 140).slice(0, 3)).toEqual([255, 128, 128]);
    // Blue-only user (140,140) → device (140,60): blue at 0.5 over white.
    expect(p.at(140, 60).slice(0, 3)).toEqual([128, 128, 255]);
  });

  it('differs from the same group drawn without knockout', () => {
    const ko = decodePng(Document.Open(knockoutIsolatedPdf(true)).Pages[0].ToImage());
    const no = decodePng(Document.Open(knockoutIsolatedPdf(false)).Pages[0].ToImage());
    // Non-knockout composites blue over red in the overlap → (128, 64, 191).
    expect(no.at(100, 100).slice(0, 3)).toEqual([128, 64, 191]);
    expect(ko.at(100, 100).slice(0, 3)).not.toEqual(no.at(100, 100).slice(0, 3));
  });
});
```

- [ ] **Step 2: Add the fixture builder**

In `test/helpers/build-transparency-fixtures.ts`, add after `fractionalAlphaRemovalGroupPdf`:

```ts
/** 200×200 white page: an isolated transparency group (/I true) with two
 *  overlapping semi-transparent squares — red (40..120)² then blue (80..160)²,
 *  each drawn at inner ca 0.5. `knockout` sets /K.
 *
 *  Knockout composites each element against the group's initial (transparent)
 *  backdrop, so in the overlap blue replaces red: (128,128,255). Without
 *  knockout blue composites over red: (128,64,191). Both gaps are in saturated
 *  channels. The elements MUST be semi-transparent — opaque squares read the
 *  topmost either way and would not discriminate knockout. */
export function knockoutIsolatedPdf(knockout: boolean): Uint8Array {
  const inner = flate(
    'q /GS1 gs 1 0 0 rg 40 40 80 80 re f Q '
    + 'q /GS1 gs 0 0 1 rg 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I true /K ${knockout} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GS1 << /ca 0.5 >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '/Fm0 Do',
    extra: { 5: form },
  });
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/raster-transparency.test.ts -t "knockout"`
Expected: FAIL — the overlap reads the non-knockout value `128,64,191` (or a buffering artifact), because `/K` is not read and no knockout merge exists yet.

- [ ] **Step 4: Add the sink interface methods and the `knockout` field on `OffscreenUse`**

In `src/pagerender.ts`, extend the `RenderSink` interface (after `endOffscreen`):

```ts
  endOffscreen(use: OffscreenUse): void;
  /** Bracket one top-level element of a knockout group: render it against the
   *  group's initial backdrop in a sub-buffer, then knockout-merge it into the
   *  group accumulator. Only called at the top level of a buffered knockout
   *  group; sinks that cannot express knockout may no-op. */
  beginKnockoutElement(): void;
  endKnockoutElement(): void;
```

Extend the `group` variant of `OffscreenUse`:

```ts
  | { kind: 'group'; alpha: number; blend: BlendMode; isolated: boolean; knockout: boolean };
```

- [ ] **Step 5: Add SVG no-ops**

In `src/svgrender.ts`, add to `SvgSink` (next to `clearSoftMask`):

```ts
  // SVG 1.1 has no expression for per-element knockout; documented limitation.
  beginKnockoutElement(): void { /* no-op */ }
  endKnockoutElement(): void { /* no-op */ }
```

Also update the existing `endOffscreen` group emit in `svgrender.ts` — the `OffscreenUse` group variant now carries `knockout`, but no code there reads it, so no change is required beyond it compiling. Confirm `npm run typecheck` passes after Steps 4–5 (before wiring raster), or defer the typecheck to Step 12.

- [ ] **Step 6: Detect `/K` and trigger buffering in `drawForm`**

In `src/pagerender.ts` `drawForm`, after the `isolated` line, add:

```ts
  const knockout = isTransparencyGroup && ctx.doc.resolve(grp.get('K')) === true;
```

Change `needsBuffer` to always buffer a knockout group:

```ts
  const needsBuffer = isTransparencyGroup
    && (unitComposite || (isolated && innerBlends()) || knockout)
    && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

Change `needsBackdrop` so non-isolated knockout also seeds (its elements composite over the page even without an inner blend):

```ts
  const needsBackdrop = needsBuffer && !isolated && (innerBlends() || knockout);
```

Pass `knockout` into the `beginOffscreen` opts and the `endOffscreen` use, and thread it into the body walk. Replace the `if (needsBuffer) { ... }` block body with:

```ts
  if (needsBuffer) {
    ctx.sink.beginOffscreen(undefined,
      (needsBackdrop || knockout) ? { backdrop: needsBackdrop, knockout } : undefined);
    const inner = clone(gs);
    inner.fillAlpha = 1; inner.strokeAlpha = 1; inner.blend = 'Normal';
    inner.softMask = undefined; inner.appliedMask = undefined;
    try {
      drawFormBody(ctx, inner, stream, knockout);
    } finally {
      ctx.sink.endOffscreen({ kind: 'group', alpha: gs.fillAlpha, blend: gs.blend, isolated, knockout });
    }
    return;
  }
  drawFormBody(ctx, gs, stream, false);
```

Update the `beginOffscreen` opts type on the `RenderSink` interface (Step 4 region) to carry `knockout`:

```ts
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean; knockout?: boolean },
  ): void;
```

- [ ] **Step 7: Thread the `knockout` flag through `drawFormBody` and `walk`**

In `src/pagerender.ts`, change `drawFormBody`'s signature and its `walk` call:

```ts
function drawFormBody(ctx: RenderCtx, gs: GState, stream: PdfStream, knockout = false): void {
```

and

```ts
  walk(childCtx, bytes, childState, knockout);
```

Change `walk`'s signature:

```ts
function walk(ctx: RenderCtx, bytes: Uint8Array, initial: GState, knockout = false): void {
```

Add an `element` helper inside `walk`, after the `doStroke` definition (before the `for (const op of ops)` loop):

```ts
  // Bracket one top-level element of a knockout group so it composites against
  // the group's initial backdrop (§11.4.8). No-op outside a knockout group.
  const element = (paint: () => void) => {
    if (!knockout) { paint(); return; }
    sink.beginKnockoutElement();
    try { paint(); } finally { sink.endKnockoutElement(); }
  };
```

- [ ] **Step 8: Wrap the painting operators in `walk`**

In `src/pagerender.ts` `walk`'s operator switch, wrap each painting op with `element(...)`. Replace the painting/text/image/shading cases as follows:

```ts
      // painting
      case 'S': case 's': element(() => doStroke()); resetPath(); break;
      case 'f': case 'F': element(() => doFill(false)); resetPath(); break;
      case 'f*': element(() => doFill(true)); resetPath(); break;
      case 'B': case 'b': element(() => { doFill(false); doStroke(); }); resetPath(); break;
      case 'B*': case 'b*': element(() => { doFill(true); doStroke(); }); resetPath(); break;
      case 'n': flushClip(); resetPath(); break;
```

```ts
      case 'Tj': element(() => showText(ctx, gs, o[0])); break;
      case 'TJ': element(() => showArray(ctx, gs, o[0])); break;
      case "'": textMove(gs, 0, -gs.leading); element(() => showText(ctx, gs, o[0])); break;
      case '"': gs.wordSp = num(o[0]); gs.charSp = num(o[1]); textMove(gs, 0, -gs.leading); element(() => showText(ctx, gs, o[2])); break;
```

```ts
      case 'BI':
        if (op.inlineImage) {
          const img = op.inlineImage;
          element(() => {
            syncPaintState(ctx, gs);
            sink.image({ kind: 'stream', dict: img.dict, raw: img.data } as PdfStream, gs.ctm, gs.fill);
          });
        }
        break;
      case 'Do': {
        const xn = o[0];
        const xobjs = resDict(ctx, 'XObject');
        if (!isName(xn) || !xobjs) break;
        const xo = ctx.doc.resolve(xobjs.get(xn.name));
        if (!isStream(xo)) break;
        const sub = ctx.doc.resolve(xo.dict.get('Subtype'));
        element(() => {
          if (isName(sub) && sub.name === 'Image') { syncPaintState(ctx, gs); sink.image(xo, gs.ctm, gs.fill); }
          else drawForm(ctx, gs, xo);
        });
        break;
      }
```

```ts
      case 'sh': {
        const shDict = resDict(ctx, 'Shading');
        const sn = o[0];
        if (isName(sn) && shDict) {
          const sh = ctx.doc.resolve(shDict.get(sn.name));
          const dict = isStream(sh) ? sh.dict : isDict(sh) ? sh : undefined;
          if (dict) { flushClip(); element(() => sink.shading(dict, gs.ctm)); }
        }
        break;
      }
```

Note: nested forms reached through `Do` run `drawForm` → `drawFormBody(..., false)`, so a nested group is one element and is not itself re-bracketed.

- [ ] **Step 9: Add the shape channel and knockout backdrop to `Canvas` (raster.ts)**

In `src/raster.ts`, in the `Canvas` class, after the `groupAlpha` field add:

```ts
  /** Geometric coverage (shape f_j, §11.4.8), before constant alpha (ca). Present
   *  only on a knockout element buffer, where the merge weight is the element's
   *  shape — not shape×ca — so a semi-transparent element still fully knocks out
   *  the elements beneath it within its footprint. */
  shape?: Float32Array;

  /** Frozen initial backdrop B0 of a knockout group (RGBA, straight alpha).
   *  Present only on a knockout group's accumulator: transparent when isolated,
   *  the page seed when non-isolated. Each element sub-buffer is seeded from it. */
  knockoutBackdrop?: Float32Array;
```

- [ ] **Step 10: Record shape in `Canvas.blend`; add `Paint.shapeAt`; thread shape through the fill path**

In `src/raster.ts` `Canvas.blend`, change the signature and add the shape update. Replace the signature line and the `groupAlpha` block:

```ts
  blend(x: number, y: number, color: Rgb, cov: number, mode: BlendMode = 'Normal', shapeCov = cov): void {
    if (cov <= 0) return;
    const lx = x - this.originX, ly = y - this.originY;
    if (lx < 0 || ly < 0 || lx >= this.w || ly >= this.h) return;
    const i = (ly * this.w + lx) * 4;
    const d = this.data;
    const sa = cov > 1 ? 1 : cov;
    if (this.groupAlpha !== undefined) {
      const gi = ly * this.w + lx;
      this.groupAlpha[gi] = sa + this.groupAlpha[gi] * (1 - sa);
    }
    if (this.shape !== undefined) {
      const gi = ly * this.w + lx;
      const s = shapeCov > 1 ? 1 : shapeCov < 0 ? 0 : shapeCov;
      this.shape[gi] = s + this.shape[gi] * (1 - s);
    }
```

(The rest of `blend` — the color composite — is unchanged.)

Add `shapeAt` to the `Paint` class, right after `at`:

```ts
  /** Coverage multiplier WITHOUT constant alpha: clip × softMask. This is the
   *  §11.4.8 shape, used to weight the knockout merge. */
  shapeAt(px: number, py: number): number {
    let v = 1;
    if (this.clip) { v *= this.clip.at(px, py); if (v <= 0) return 0; }
    if (this.softMask) v *= this.softMask.at(px, py);
    return v;
  }
```

In `Accumulator.composite`, pass the pre-`ca` shape when the target canvas tracks it:

```ts
  composite(canvas: Canvas, ox: number, oy: number, color: Rgb, evenOdd: boolean, paint: Paint): void {
    this.sweep(evenOdd, (x, y, cov) => {
      const px = ox + x, py = oy + y;
      const c = cov * paint.at(px, py);
      if (c <= 1e-4) return;
      const shp = canvas.shape !== undefined ? cov * paint.shapeAt(px, py) : c;
      canvas.blend(px, py, color, c, paint.blend, shp);
    });
  }
```

(Fills, strokes, and glyphs all route through `composite`, so this one change covers them. Images and shadings are handled in Task 2's non-isolated fixtures if needed; the isolated fixture uses fills only.)

- [ ] **Step 11: Snapshot `B0` in `beginOffscreen`; add `beginKnockoutElement`/`endKnockoutElement`**

In `src/raster.ts` `RasterSink.beginOffscreen`, change the opts type and, after the seeding block, snapshot the knockout backdrop. Change the signature:

```ts
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean; knockout?: boolean },
  ): void {
```

At the end of the method, just before `this.offscreen.push({ canvas: sub, ...frame });`, add:

```ts
    if (opts?.knockout) {
      // Freeze the group's initial backdrop: transparent (zeros) when isolated,
      // the page seed when non-isolated. Each element sub-buffer is seeded from
      // this, and — non-isolated — the group also needs its own αgn for removal.
      sub.knockoutBackdrop = sub.data.slice();
      if (opts.backdrop && sub.groupAlpha === undefined) sub.groupAlpha = new Float32Array(sub.w * sub.h);
    }
```

(When `opts.backdrop` is set the seeding block already allocated `sub.groupAlpha`; the guard is defensive.)

Add the knockout stack field to `RasterSink` (near the `offscreen` field declaration):

```ts
  private knockoutStack: ({ E: Canvas; G: Canvas } | null)[] = [];
```

Add the two methods (place them right after `endOffscreen`):

```ts
  beginKnockoutElement(): void {
    const G = this.canvas;
    if (G.knockoutBackdrop === undefined) { this.knockoutStack.push(null); return; }
    // A sub-buffer congruent to the group accumulator, seeded with B0. It tracks
    // element-only alpha (groupAlpha) and geometric shape. The current paint
    // (clip / soft mask / ca) is kept: the element draws in the group's state.
    const E = new Canvas(G.w, G.h, false);
    E.originX = G.originX; E.originY = G.originY;
    E.data.set(G.knockoutBackdrop);
    E.groupAlpha = new Float32Array(G.w * G.h);
    E.shape = new Float32Array(G.w * G.h);
    this.knockoutStack.push({ E, G });
    this.canvas = E;
  }

  endKnockoutElement(): void {
    const top = this.knockoutStack.pop();
    if (!top) return;
    const { E, G } = top;
    this.canvas = G;
    // Knockout merge (§11.4.8): where the element has shape f, replace the
    // accumulator with the element's result over B0; elsewhere leave it. Worked
    // in premultiplied space so differing alphas compose correctly.
    const shp = E.shape!;
    const n = G.w * G.h;
    for (let i = 0; i < n; i++) {
      const f = shp[i];
      if (f <= 0) continue;
      const gi = i * 4;
      const ea = E.data[gi + 3], ga = G.data[gi + 3];
      const na = (1 - f) * ga + f * ea;
      G.data[gi + 3] = na;
      if (na > 0) {
        G.data[gi]     = ((1 - f) * G.data[gi]     * ga + f * E.data[gi]     * ea) / na;
        G.data[gi + 1] = ((1 - f) * G.data[gi + 1] * ga + f * E.data[gi + 1] * ea) / na;
        G.data[gi + 2] = ((1 - f) * G.data[gi + 2] * ga + f * E.data[gi + 2] * ea) / na;
      }
      if (G.groupAlpha !== undefined) {
        G.groupAlpha[i] = (1 - f) * G.groupAlpha[i] + f * E.groupAlpha![i];
      }
    }
  }
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run test/raster-transparency.test.ts -t "knockout"`
Expected: PASS — overlap `128,128,255`, red-only `255,128,128`, blue-only `128,128,255`, and the non-knockout render reads `128,64,191` and differs.

- [ ] **Step 13: Run the full raster suite and typecheck (regression)**

Run: `npx vitest run test/raster-transparency.test.ts && npm run typecheck`
Expected: all green. If any existing transparency test regressed, the shape/blend change altered a non-knockout path — the shape arg defaults to `cov`, so the common path must be byte-identical; investigate before proceeding.

- [ ] **Step 14: Commit**

```bash
git add src/pagerender.ts src/svgrender.ts src/raster.ts test/helpers/build-transparency-fixtures.ts test/raster-transparency.test.ts
git commit -m "feat(render): isolated knockout transparency groups (076)"
```

---

### Task 2: Non-isolated knockout groups

Verifies knockout over a seeded page backdrop, combined with the existing §11.4.6 removal at group-composite time. The Task 1 code already seeds and allocates `groupAlpha` for non-isolated knockout (Steps 6 and 11); this task proves it with a fixture and, if needed, threads shape through the image/shading blend sites.

**Files:**
- Modify: `src/raster.ts` — shape at the image and shading blend sites (only if a fixture needs it; the fill fixture below does not).
- Modify: `test/helpers/build-transparency-fixtures.ts` — non-isolated knockout fixture.
- Test: `test/raster-transparency.test.ts`.

**Interfaces:**
- Consumes: everything from Task 1.
- Produces (fixture): `knockoutNonIsolatedPdf(knockout: boolean): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Add to the knockout `describe` block in `test/raster-transparency.test.ts`:

```ts
  it('knocks out over the seeded page backdrop, then removes it (non-isolated)', () => {
    // Yellow page; non-isolated /K group, red (40..120)² then blue (80..160)²,
    // each inner ca 0.5, Normal. Elements composite over the page (B0 = yellow);
    // in the overlap blue knocks out red. Overlap user (100,100) → device (100,100).
    const ko = decodePng(Document.Open(knockoutNonIsolatedPdf(true)).Pages[0].ToImage());
    const no = decodePng(Document.Open(knockoutNonIsolatedPdf(false)).Pages[0].ToImage());
    expect(ko.at(100, 100).slice(0, 3)).toEqual([128, 128, 128]);
    // Without knockout blue composites over red over yellow → (128, 64, 128).
    expect(no.at(100, 100).slice(0, 3)).toEqual([128, 64, 128]);
    expect(ko.at(100, 100).slice(0, 3)).not.toEqual(no.at(100, 100).slice(0, 3));
  });
```

Add `knockoutNonIsolatedPdf` to the import list alongside `knockoutIsolatedPdf`.

- [ ] **Step 2: Add the fixture builder**

In `test/helpers/build-transparency-fixtures.ts`, after `knockoutIsolatedPdf`:

```ts
/** 200×200 yellow page: a NON-isolated transparency group (/I false) with two
 *  overlapping semi-transparent squares — red (40..120)² then blue (80..160)²,
 *  each at inner ca 0.5, Normal. `knockout` sets /K.
 *
 *  Non-isolated → each element composites against the page (B0 = yellow). With
 *  knockout, blue replaces red in the overlap and the §11.4.6 removal subtracts
 *  the seed, giving (128,128,128); without it blue composites over red over
 *  yellow → (128,64,128). Exercises knockout accumulation feeding the removal
 *  path — and needsBackdrop for non-isolated knockout WITHOUT an inner blend. */
export function knockoutNonIsolatedPdf(knockout: boolean): Uint8Array {
  const inner = flate(
    'q /GS1 gs 1 0 0 rg 40 40 80 80 re f Q '
    + 'q /GS1 gs 0 0 1 rg 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I false /K ${knockout} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GS1 << /ca 0.5 >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '1 1 0 rg 0 0 200 200 re f /Fm0 Do',
    extra: { 5: form },
  });
}
```

- [ ] **Step 3: Run the test to verify it fails, then passes**

Run: `npx vitest run test/raster-transparency.test.ts -t "non-isolated"`
Expected initially: the new case is added to already-working code from Task 1. If the non-isolated `/K true` case is correct, it PASSES immediately — that is the expected outcome, since Task 1 already wired non-isolated knockout seeding and removal. If it FAILS (e.g. overlap ≠ `128,128,128`), debug: confirm `needsBackdrop` is true for non-isolated knockout without an inner blend (Step 6, Task 1), and that `beginOffscreen` allocated `sub.groupAlpha` (Step 11, Task 1).

Because this task's code was landed in Task 1, the test acts as verification rather than driving new code. If it passes on the first run, that is acceptable here — the discrimination against the non-knockout render (`128,64,128`) proves it is not vacuous.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run test/raster-transparency.test.ts && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/raster.ts test/helpers/build-transparency-fixtures.ts test/raster-transparency.test.ts
git commit -m "test(render): non-isolated knockout over seeded backdrop (076)"
```

---

### Task 3: Mutation verification, documentation, and close

Proves the new probes are load-bearing (per project convention), records the mutation table, documents the SVG limitation, and closes the issue.

**Files:**
- Modify: `test/fixtures/svg/PROVENANCE.md` — mutation table rows + SVG limitation.
- Modify: `README.md` — knockout in the rendering limitations.
- No source changes (unless a mutation reveals a gap).

**Interfaces:** none.

- [ ] **Step 1: Mutation A — drop the per-op reset**

In `src/raster.ts` `beginKnockoutElement`, temporarily force the no-op path by adding `this.knockoutStack.push(null); return;` as the first two statements (elements then accumulate into G directly instead of knocking out).

Run: `npx vitest run test/raster-transparency.test.ts -t "knockout"`
Expected: the isolated overlap probe goes red — reads `128,64,191` (source-over) instead of `128,128,255`.
Record the observed value, then **revert** the mutation.

- [ ] **Step 2: Mutation B — collapse shape to shape×ca**

In `src/raster.ts` `endKnockoutElement`, temporarily change the merge weight from shape to element alpha: replace `const shp = E.shape!;` with `const shp = E.groupAlpha!;`.

Run: `npx vitest run test/raster-transparency.test.ts -t "knockout"`
Expected: the isolated overlap goes red — the semi-transparent element no longer fully knocks out (reads `191,128,191`, neither knockout nor non-knockout). This is the shape-vs-opacity guard.
Record the observed value, then **revert** the mutation.

- [ ] **Step 3: Mutation C — drop knockout from `needsBuffer`**

In `src/pagerender.ts` `drawForm`, temporarily remove `|| knockout` from `needsBuffer`.

Run: `npx vitest run test/raster-transparency.test.ts -t "knockout"`
Expected: the group draws inline; the isolated overlap goes red (the group no longer buffers as a unit). Record the observed value, then **revert** the mutation.

- [ ] **Step 4: Run the full suite to confirm all reverts are clean**

Run: `npm run typecheck && npx vitest run test/raster-transparency.test.ts`
Expected: all green.

- [ ] **Step 5: Record the mutation table in PROVENANCE.md**

In `test/fixtures/svg/PROVENANCE.md`, append to the raster-side mutation table (the one below the "four rows below are `bbu`" note) — use the values you recorded:

```markdown
| Per-op reset dropped in `RasterSink.beginKnockoutElement` (elements accumulate into the group buffer) | **caught** — isolated knockout overlap reads `128,64,191` (source-over: blue over red) instead of `128,128,255` (`076`) |
| Knockout merge weight collapsed from `E.shape` to `E.groupAlpha` (shape → shape×ca) in `endKnockoutElement` | **caught** — the semi-transparent element no longer fully knocks out; overlap reads `191,128,191`, neither knockout nor source-over. This is the shape-vs-opacity split of §11.4.8 (`076`) |
| `knockout` removed from `needsBuffer` in `drawForm` | **caught** — the group draws inline and does not knock out; isolated knockout overlap goes red (`076`) |
```

- [ ] **Step 6: Document the SVG limitation**

In `test/fixtures/svg/PROVENANCE.md`, next to the existing "Backdrop removal in SVG" limitation bullet, add:

```markdown
- **Knockout groups in SVG** (`/K true`) — SVG 1.1 has no expression for
  per-element backdrop reset (§11.4.6.2). `ToImage` implements knockout (`076`);
  `ToSvg` renders a knockout group as an ordinary group.
```

In `README.md`, find the rendering (`ToSvg` / `ToImage`) limitations section and add a matching one-line entry: `Knockout transparency groups (/K) render correctly in ToImage but as ordinary groups in ToSvg.`

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/svg/PROVENANCE.md README.md
git commit -m "docs(render): record knockout mutation checks and SVG limitation (076)"
```

- [ ] **Step 8: Close the issue**

Run:
```bash
bd close aspose-pdf-foss-for-ts-076 --reason "Faithful /K true in raster backend for isolated and non-isolated groups: per-element sub-buffers over the group initial backdrop, shape-weighted knockout merge (§11.4.8), reusing bbu seeding + removal. SVG documented as unsupported. Mutation-verified (per-op reset, shape-vs-ca weight, needsBuffer trigger)."
```

- [ ] **Step 9: Session completion — push**

```bash
git pull --rebase
git push
git status   # MUST show up to date with origin
bd dolt push
```

---

## Self-Review

**Spec coverage:**
- Detection & dispatch (`/K`, needsBuffer, needsBackdrop, walk bracketing) → Task 1 Steps 6–8. ✓
- Shape channel → Task 1 Steps 9–10. ✓
- Element buffer & knockout merge → Task 1 Step 11. ✓
- Group composite unchanged (isolated no-removal, non-isolated removal) → verified by Task 1 (isolated) and Task 2 (non-isolated). ✓
- SVG documented limitation → Task 1 Step 5 (no-ops) + Task 3 Step 6 (docs). ✓
- Testing (isolated, discrimination, non-isolated, shape-vs-opacity guard, mutation table) → Task 1 tests, Task 2 test, Task 3 mutations. ✓
- Scope non-goals (SVG faithful, per-glyph, `/K` only on `/Group`) → respected; `/K` read only from `/Group` in Task 1 Step 6. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✓

**Type consistency:** `beginKnockoutElement`/`endKnockoutElement` (both sinks), `Canvas.shape`/`Canvas.knockoutBackdrop`, `Paint.shapeAt`, `blend(..., shapeCov)`, `OffscreenUse` group `knockout`, `beginOffscreen` opts `{ backdrop?, knockout? }`, `knockoutIsolatedPdf`/`knockoutNonIsolatedPdf` — names used consistently across tasks. ✓

**Note on Task 2:** its code lands in Task 1, so its test verifies rather than drives. This is called out explicitly in Task 2 Step 3 and is acceptable because the non-vacuousness is proven by discrimination against the non-knockout render.
