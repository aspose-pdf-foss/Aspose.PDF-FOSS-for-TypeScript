# Non-Isolated Transparency Group Backdrop Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ToImage` composite non-isolated transparency groups per ISO 32000-1 §11.4.6, and fix the live bug where a `/Group` form without an explicit `/I true` never gets an offscreen buffer at all.

**Architecture:** The buffering predicate in `pagerender.ts` stops requiring `/I true` and starts buffering any transparency group that must composite as a unit. Non-isolated groups whose contents blend additionally seed their buffer from the parent canvas and subtract the seed back out at composite time, using a parallel group-alpha plane on `Canvas` to recover `αgn`. Groups without an inner blend take the existing plain-buffer path, where seeding is provably a no-op.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-21-non-isolated-group-backdrop-removal-design.md`
**Issue:** `aspose-pdf-foss-for-ts-bbu`

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- Issue tracking is `bd` only — no TodoWrite, no markdown TODO lists.
- Fixture builders live in `test/helpers/` and document their correct *and*
  broken probe values in the doc comment, matching `isolatedGroupPdf` style.
- A golden that passes on the first run is not evidence — Task 4 is not optional.

## Reference values

Every expected number below is derived in the spec and reproduced here so no
task has to re-derive it.

**Fixture A** — two overlapping opaque red squares in a transparency group at
`ca 0.5` over white, no inner blend:

| | overlap (80,120) | non-overlap (30,170) |
|---|---|---|
| correct (buffered) | `255,128,128` | `255,128,128` |
| today (inline) | `255,64,64` | `255,128,128` |

**Fixture B** — two overlapping cyan `Multiply` squares in a group at `ca 0.5`
over yellow. Three pairwise-distinct answers at the overlap (100,100):

| | overlap (100,100) | non-overlap (60,140) |
|---|---|---|
| correct non-isolated (seed + remove) | `128,255,0` | `128,255,0` |
| today (inline) | `64,255,0` | `128,255,0` |
| isolated | `128,255,128` | `128,255,128` |

Red separates correct from inline; blue separates non-isolated from isolated.
Both gaps are saturated, so antialiasing cannot blur one into the other.

---

### Task 1: Buffer non-isolated groups (fixes the double-darkening bug)

Fixes the measured bug on its own, with no backdrop machinery: a non-isolated
group without an inner blend takes the plain-buffer path, where seeding is a
provable no-op.

**Files:**
- Modify: `src/pagerender.ts:632-675` (`drawForm`)
- Modify: `src/svgrender.ts:152-164` (`endOffscreen` group branch)
- Create fixture in: `test/helpers/build-transparency-fixtures.ts`
- Test: `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `nonIsolatedGroupPdf(iso?: 'true' | 'false' | 'absent'): Uint8Array`
  exported from `test/helpers/build-transparency-fixtures.ts`. The
  `OffscreenUse` `group` variant's existing `isolated: boolean` field becomes
  load-bearing (it was hardcoded `true`).

- [ ] **Step 1: Add the fixture builder**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 200×200 page: two overlapping opaque red squares inside a transparency
 *  group, drawn at ca 0.5 over white. `iso` selects the /I value; 'absent'
 *  omits the key entirely, which is the spec default (false) and the shape of
 *  an ordinary /Group form.
 *
 *  The group has no inner blend mode, so isolated and non-isolated agree:
 *    - correct (offscreen): overlap == non-overlap == (255, 128, 128)
 *    - broken  (inline):    the overlap composites twice → (255, 64, 64)
 */
export function nonIsolatedGroupPdf(
  iso: 'true' | 'false' | 'absent' = 'absent',
): Uint8Array {
  const inner = flate('1 0 0 rg 20 20 80 80 re f 60 60 80 80 re f');
  const i = iso === 'absent' ? '' : `/I ${iso} `;
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency ${i}/CS /DeviceRGB >> `
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

- [ ] **Step 2: Write the failing test**

Add to `test/raster-transparency.test.ts`. Add `nonIsolatedGroupPdf` to the
existing import from `./helpers/build-transparency-fixtures.js`.

```ts
describe('Page.ToImage — non-isolated transparency groups', () => {
  // /I defaults to false, so 'absent' is the ordinary /Group form. All three
  // must buffer: the group composites as a unit at ca 0.5 regardless of /I.
  it.each(['absent', 'false', 'true'] as const)(
    'composites as a unit with /I %s, so the overlap does not double-darken',
    (iso) => {
      const p = decodePng(Document.Open(nonIsolatedGroupPdf(iso)).Pages[0].ToImage());
      // squares are user (20..100)² and (60..140)²; page is 200 tall, so
      // device y = 200 - user y. Overlap user (80,80) → device (80,120).
      expect(p.at(80, 120).slice(0, 3)).toEqual([255, 128, 128]);   // inline → 255,64,64
      // Single coverage, user (30,30) → device (30,170).
      expect(p.at(30, 170).slice(0, 3)).toEqual([255, 128, 128]);
    });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run test/raster-transparency.test.ts -t "double-darken"`

Expected: FAIL for `absent` and `false` — received `[255, 64, 64]`, expected
`[255, 128, 128]`. The `true` case already passes; that is correct and proves
the test discriminates rather than failing for an unrelated reason.

- [ ] **Step 4: Replace the buffering predicate**

In `src/pagerender.ts`, replace the comment block and predicate at lines
636-658 (from `// A transparency group needs its own buffer only when` through
`&& ctx.depth < MAX_OFFSCREEN_DEPTH;`) with:

```ts
  // A transparency group needs its own buffer when compositing it as a unit
  // differs from drawing it inline — i.e. when group alpha, a blend mode, or a
  // soft mask applies. At alpha 1 / Normal / no mask the two are identical,
  // which describes most /Group forms, so the expensive path stays rare.
  //
  // /I is NOT a precondition for buffering. It defaults to false, so gating on
  // `/I true` left the ordinary /Group form drawing inline at ca < 1, where its
  // overlaps composite twice. /I instead selects *how* the buffer composites
  // down: an isolated group's inner blends see its own transparent backdrop, a
  // non-isolated group's see the page.
  //
  // An inner blend forces a buffer only when isolated — that is the whole point
  // of isolation. Non-isolated inner blends against the page are exactly what
  // inline drawing already produces.
  const grp = ctx.doc.resolve(stream.dict.get('Group'));
  const isTransparencyGroup = isDict(grp)
    && (() => { const s = ctx.doc.resolve(grp.get('S')); return isName(s) && s.name === 'Transparency'; })();
  const isolated = isTransparencyGroup && ctx.doc.resolve(grp.get('I')) === true;
  // Memoized: the scan walks the resource tree, and the predicate below
  // short-circuits past it in the common case.
  let blendsMemo: boolean | undefined;
  const innerBlends = (): boolean =>
    (blendsMemo ??= groupContentBlends(ctx.doc, stream));
  const unitComposite = gs.fillAlpha < 1 || gs.blend !== 'Normal'
    || gs.softMask !== undefined;
  const needsBuffer = isTransparencyGroup
    && (unitComposite || (isolated && innerBlends()))
    && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

- [ ] **Step 5: Pass the real `isolated` flag to `endOffscreen`**

In the same function, change the `endOffscreen` call (was line 670) from
`isolated: true` to the computed flag:

```ts
      ctx.sink.endOffscreen({ kind: 'group', alpha: gs.fillAlpha, blend: gs.blend, isolated });
```

- [ ] **Step 6: Stop isolating non-isolated groups in SVG**

In `src/svgrender.ts`, replace the body of the `use.kind === 'group'` branch
(lines 152-164) with:

```ts
    if (use.kind === 'group') {
      // `isolation` must be a style property, not a presentation attribute:
      // CSS Compositing defines no presentation attribute for it, so
      // `isolation="isolate"` is an unknown attribute and is dropped — measured
      // in Chrome 150 and resvg 2.6.2, both of which ignore that form and both
      // of which honour this one. Merge with mix-blend-mode rather than
      // emitting a second `style`, which would discard one of the two.
      //
      // Only isolated groups get it. A non-isolated group's inner blends must
      // reach the page backdrop, which a stacking context would cut off.
      const style: string[] = [];
      if (use.isolated) style.push('isolation:isolate');
      if (use.blend !== 'Normal') style.push(`mix-blend-mode:${blendCss(use.blend)}`);
      const attrs = [`opacity="${fmt(use.alpha)}"`];
      if (style.length) attrs.push(`style="${style.join(';')}"`);
      attrs.push(...this.clipAttrs());
      this.w.emit(`<g ${attrs.join(' ')}>${inner}</g>`);
    }
```

- [ ] **Step 7: Run the test and verify it passes**

Run: `npx vitest run test/raster-transparency.test.ts -t "double-darken"`
Expected: PASS, all three cases.

- [ ] **Step 8: Run the full suite**

Run: `npm run typecheck && npm test`

Expected: green. If `test/svgrender.test.ts` asserts `isolation:isolate` on a
group that is now non-isolated, that assertion was encoding the bug — update it
to expect no `isolation` for non-isolated groups, and note it in the commit.
The SVG goldens are regenerated in Task 3, not here; if a golden fails now,
leave it and proceed — Task 3 owns it.

- [ ] **Step 9: Commit**

```bash
git add src/pagerender.ts src/svgrender.ts test/helpers/build-transparency-fixtures.ts test/raster-transparency.test.ts
git commit -m "fix(render): buffer transparency groups regardless of /I (bbu)

/I defaults to false, but the buffering predicate required /I true, so an
ordinary /Group form at ca 0.5 drew inline and its overlaps composited
twice — (255,64,64) where (255,128,128) is correct.

/I now selects how the buffer composites down rather than whether one is
allocated, and SVG emits isolation:isolate only for isolated groups.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backdrop seeding and §11.4.6 removal

**Files:**
- Modify: `src/raster.ts:42-105` (`Canvas`), `src/raster.ts:907-936`
  (`beginOffscreen`), `src/raster.ts:1043-1062` (`composeGroup`)
- Modify: `src/pagerender.ts:55-63` (`RenderSink.beginOffscreen` signature),
  `drawForm` (pass the new flag)
- Modify: `src/svgrender.ts:107` and `src/htmlfixed.ts:32` (signature only)
- Create fixture in: `test/helpers/build-transparency-fixtures.ts`
- Test: `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: `nonIsolatedGroupPdf` and the `isolated` flag wiring from Task 1.
- Produces:
  - `Canvas.groupAlpha?: Float32Array` (public field on the module-private class)
  - `RenderSink.beginOffscreen(region?, opts?: { backdrop?: boolean }): void`
  - `nonIsolatedBlendGroupPdf(isolated?: boolean): Uint8Array` from
    `test/helpers/build-transparency-fixtures.ts`

- [ ] **Step 1: Add the fixture builder**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 200×200 page: a yellow backdrop, then a transparency group at ca 0.5 whose
 *  contents Multiply TWO OVERLAPPING cyan squares over it.
 *
 *  The overlap is load-bearing. With a single square, unit compositing and
 *  inline drawing produce the same pixel, and the fixture would not
 *  discriminate — the group alpha would apply once either way.
 *
 *  At the overlap the three candidate answers are pairwise distinct:
 *    - correct non-isolated (seed + remove): (128, 255,   0)
 *    - inline (the pre-bbu bug):             ( 64, 255,   0)
 *    - isolated:                             (128, 255, 128)
 *  Red separates correct from inline; blue separates non-isolated from
 *  isolated. Both gaps are saturated, so antialiasing cannot blur them. */
export function nonIsolatedBlendGroupPdf(isolated = false): Uint8Array {
  const inner = flate('q /GSM gs 0 1 1 rg 40 40 80 80 re f 80 80 80 80 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I ${isolated} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GSM << /Type /ExtGState /BM /Multiply >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> /ExtGState << /GS0 << /ca 0.5 >> >> >>',
    content: '1 1 0 rg 0 0 200 200 re f q /GS0 gs /Fm0 Do Q',
    extra: { 5: form },
  });
}
```

- [ ] **Step 2: Write the failing tests**

Add `nonIsolatedBlendGroupPdf` to the import, then add to
`test/raster-transparency.test.ts` inside the describe block from Task 1:

```ts
  it('removes the seeded backdrop so an inner blend sees the page (§11.4.6)', () => {
    const p = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    // squares are user (40..120)² and (80..160)²; overlap is user (80..120)².
    // Page is 200 tall → device y = 200 - user y. user (100,100) → (100,100).
    // Inline would read (64,255,0); isolated would read (128,255,128).
    expect(p.at(100, 100).slice(0, 3)).toEqual([128, 255, 0]);
    // Single coverage, user (60,60) → device (60,140).
    expect(p.at(60, 140).slice(0, 3)).toEqual([128, 255, 0]);
  });

  it('differs from the isolated group on the same fixture', () => {
    const nonIso = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    const iso = decodePng(Document.Open(nonIsolatedBlendGroupPdf(true)).Pages[0].ToImage());
    // Isolated: the inner multiply sees the group's transparent backdrop and is
    // a no-op, so the group composites pure cyan down at 0.5 over yellow.
    expect(iso.at(100, 100).slice(0, 3)).toEqual([128, 255, 128]);
    // The two paths must not collapse into each other.
    expect(nonIso.at(100, 100).slice(0, 3)).not.toEqual(iso.at(100, 100).slice(0, 3));
  });

  it('produces no NaN or out-of-range channel anywhere on the page', () => {
    // Guards the αgn = 0 and α0 = 0 division cases in the removal formula.
    const p = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    for (let y = 0; y < 200; y += 7)
      for (let x = 0; x < 200; x += 7)
        for (const c of p.at(x, y))
          expect(Number.isInteger(c) && c >= 0 && c <= 255).toBe(true);
  });
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run test/raster-transparency.test.ts -t "11.4.6"`

Expected: FAIL — received `[128, 255, 128]`, expected `[128, 255, 0]`. After
Task 1 the group *is* buffered, but with no seeding it composites as isolated,
so the inner multiply never sees the yellow page.

- [ ] **Step 4: Add the group-alpha plane to `Canvas`**

In `src/raster.ts`, add the field to `Canvas` immediately after `originY = 0;`
(line 50):

```ts
  /** Group-only accumulated alpha. Allocated only for a non-isolated group's
   *  buffer, which is seeded with the backdrop: the alpha channel then holds
   *  the composite αn, and §11.4.6 backdrop removal needs the group's own αgn.
   *  It cannot be derived — αn = αgn + α0(1−αgn) inverts to
   *  (αn − α0)/(1 − α0), which is 0/0 wherever the backdrop is opaque, i.e.
   *  almost everywhere on a page rendered over white. */
  groupAlpha?: Float32Array;
```

Then in `blend()`, insert immediately after `const sa = cov > 1 ? 1 : cov;`
(line 69):

```ts
    if (this.groupAlpha !== undefined) {
      const gi = ly * this.w + lx;
      this.groupAlpha[gi] = sa + this.groupAlpha[gi] * (1 - sa);
    }
```

- [ ] **Step 5: Widen the `RenderSink.beginOffscreen` signature**

In `src/pagerender.ts`, replace the `beginOffscreen` declaration (line 59):

```ts
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean },
  ): void;
```

Extend the doc comment above it with:

```
 *  `opts.backdrop` seeds the buffer from the parent canvas and tracks the
 *  group's own alpha separately — for a non-isolated group, whose inner blends
 *  must see the backdrop (§11.4.6). Sinks that cannot express it may ignore it.
```

Update the two delegating sinks to match. `src/svgrender.ts` line 107:

```ts
  beginOffscreen(
    _region?: { x0: number; y0: number; x1: number; y1: number },
    _opts?: { backdrop?: boolean },
  ): void {
```

`src/htmlfixed.ts` line 32:

```ts
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean },
  ): void { this.svg.beginOffscreen(region, opts); }
```

- [ ] **Step 6: Seed the buffer in `RasterSink.beginOffscreen`**

In `src/raster.ts`, change the signature (line 907) to:

```ts
  beginOffscreen(
    region?: { x0: number; y0: number; x1: number; y1: number },
    opts?: { backdrop?: boolean },
  ): void {
```

Then insert after `sub.originX = b.x0; sub.originY = b.y0;` (line 927) and
before `this.offscreen.push(...)`:

```ts
    if (opts?.backdrop) {
      // Non-isolated group: seed with the backdrop so inner blend modes see the
      // page, and track group-only alpha so composeGroup can subtract the seed
      // back out (§11.4.6). `this.canvas` is still the parent here.
      sub.groupAlpha = new Float32Array(wantW * wantH);
      const par = this.canvas;
      for (let y = 0; y < wantH; y++) {
        const py = b.y0 + y - par.originY;
        if (py < 0 || py >= par.h) continue;
        for (let x = 0; x < wantW; x++) {
          const px = b.x0 + x - par.originX;
          if (px < 0 || px >= par.w) continue;
          const si = (py * par.w + px) * 4;
          const di = (y * wantW + x) * 4;
          sub.data[di]     = par.data[si];
          sub.data[di + 1] = par.data[si + 1];
          sub.data[di + 2] = par.data[si + 2];
          sub.data[di + 3] = par.data[si + 3];
        }
      }
    }
```

- [ ] **Step 7: Apply backdrop removal in `composeGroup`**

In `src/raster.ts`, replace `composeGroup` (lines 1043-1062) with:

```ts
  /** Composite an offscreen group down: one source-over of the already-flattened
   *  buffer, scaled by group alpha and through the group's blend mode.
   *  Compositing once is exactly what stops overlapping content inside the group
   *  from double-darkening.
   *
   *  A buffer carrying `groupAlpha` was seeded with the backdrop (non-isolated),
   *  so the seed is removed first (ISO 32000-1 §11.4.6):
   *      C = Cn + (Cn − C0)·(α0/αgn − α0)
   *  C0/α0 is read straight back out of the parent canvas, which is untouched
   *  while the group renders — no separate backdrop copy is kept. */
  private composeGroup(buf: Canvas, use: Extract<OffscreenUse, { kind: 'group' }>): void {
    const p = new Paint(this.paint.clip, this.paint.softMask, use.alpha, use.blend);
    const ga = buf.groupAlpha;
    const par = this.canvas;
    for (let y = 0; y < buf.h; y++) {
      const dy = buf.originY + y;
      for (let x = 0; x < buf.w; x++) {
        const dx = buf.originX + x;
        const i = (y * buf.w + x) * 4;
        let sa = buf.data[i + 3];
        let sr = buf.data[i], sg = buf.data[i + 1], sb = buf.data[i + 2];
        if (ga !== undefined) {
          const agn = ga[y * buf.w + x];
          if (agn <= 0) continue;                  // the group painted nothing here
          const px = dx - par.originX, py = dy - par.originY;
          if (px >= 0 && py >= 0 && px < par.w && py < par.h) {
            const bi = (py * par.w + px) * 4;
            const a0 = par.data[bi + 3];
            // α0 = 0 → k = 0 → C = Cn, which is the isolated answer. Correct:
            // there was no backdrop to remove.
            const k = a0 / agn - a0;
            if (k !== 0) {
              sr = clamp01(sr + (sr - par.data[bi]) * k);
              sg = clamp01(sg + (sg - par.data[bi + 1]) * k);
              sb = clamp01(sb + (sb - par.data[bi + 2]) * k);
            }
          }
          sa = agn;
        }
        if (sa <= 0) continue;
        const cov = sa * p.at(dx, dy);
        if (cov <= 1e-4) continue;
        this.canvas.blend(dx, dy, [sr * 255, sg * 255, sb * 255], cov, p.blend);
      }
    }
  }
```

Add this helper next to `composeGroup` (module scope, above the class is fine):

```ts
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
```

- [ ] **Step 8: Request seeding from `drawForm`**

In `src/pagerender.ts`, in `drawForm`, add after the `needsBuffer` declaration
from Task 1:

```ts
  // Seeding only changes the answer when the contents blend: with Normal inner
  // compositing, seeding and then removing the backdrop recovers exactly the
  // isolated result, so the plain path is both cheaper and equivalent.
  const needsBackdrop = needsBuffer && !isolated && innerBlends();
```

and change the `beginOffscreen` call (was line 661) to:

```ts
    ctx.sink.beginOffscreen(undefined, needsBackdrop ? { backdrop: true } : undefined);
```

- [ ] **Step 9: Run the tests and verify they pass**

Run: `npx vitest run test/raster-transparency.test.ts`
Expected: PASS, including the three new cases from Step 2.

- [ ] **Step 10: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: green apart from SVG goldens, which Task 3 regenerates.

- [ ] **Step 11: Commit**

```bash
git add src/raster.ts src/pagerender.ts src/svgrender.ts src/htmlfixed.ts test/helpers/build-transparency-fixtures.ts test/raster-transparency.test.ts
git commit -m "feat(render): backdrop removal for non-isolated groups (bbu)

Seed a non-isolated group's buffer from the parent canvas and subtract it
back out per ISO 32000-1 11.4.6, so inner blend modes see the page while
the group still composites as a unit.

Gated on the contents actually blending: with Normal inner compositing,
seed-then-remove provably recovers the isolated result, so the plain
buffer path stays equivalent and cheaper.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: SVG golden for the non-isolated unit composite

**Files:**
- Modify: `test/helpers/svg-golden-fixtures.ts`
- Regenerate: `test/fixtures/svg/non-isolated-group.png`
- Modify: `test/fixtures/svg/PROVENANCE.md`

**Interfaces:**
- Consumes: `nonIsolatedGroupPdf` from Task 1.
- Produces: a `non-isolated-group` entry in the golden fixture list.

Only the no-inner-blend case gets a golden. The inner-blend case is not
expressible in SVG — group `opacity` forces a stacking context — so it could
only land as a SKIP, and PROVENANCE Limits carries it better as prose.

- [ ] **Step 1: Register the golden**

In `test/helpers/svg-golden-fixtures.ts`, add `nonIsolatedGroupPdf` to the
import from `./build-transparency-fixtures.js`, then add this entry directly
after the `isolated-group` entry (line 111):

```ts
  {
    name: 'non-isolated-group',
    pdf: () => nonIsolatedGroupPdf('absent'),
    width: 200, height: 200,
    probes: [
      // /I absent is the spec default (false) and the ordinary /Group form.
      // Before bbu this drew inline and the overlap read (255,64,64).
      { x: 80, y: 120, rgb: [255, 128, 128], note: 'overlap — must not double-darken' },
      { x: 30, y: 170, rgb: [255, 128, 128], note: 'non-overlapping part' },
    ],
  },
```

- [ ] **Step 2: Regenerate the goldens**

Run: `npx tsx scripts/gen-svg-goldens.ts`

Expected: `non-isolated-group.png` created. Note which other goldens changed —
`isolated-group` and `isolated-blend-group` should be **byte-identical** (they
are isolated, so Task 1's SVG change does not touch them). If a previously
passing golden changed, stop and investigate before committing: that is a
regression, not a regeneration.

- [ ] **Step 3: Run the golden suite**

Run: `npx vitest run test/svg-golden.test.ts`
Expected: PASS, with `non-isolated-group` reported under both engines.

- [ ] **Step 4: Record provenance**

In `test/fixtures/svg/PROVENANCE.md`, add a row to the fixture table (next to
the `isolated-group` row at line 56) with the new file's dimensions and
SHA-256, matching the existing column format. Get the hash with:

```bash
sha256sum test/fixtures/svg/non-isolated-group.png
```

Then add to the "what these fixtures cover" list, near the `non-isolated-blend-group`
entry (line 181):

```markdown
- **Unit compositing of a default `/Group`** (`non-isolated-group`): that a
  transparency group with no `/I` key — the spec default, false — still gets an
  offscreen buffer at `ca 0.5`, so its overlapping contents composite once.
  Before `bbu` the buffering predicate required `/I true` and this drew inline,
  reading `(255,64,64)` at the overlap. Paired with `isolated-group`, which is
  the same geometry with `/I true`: the two must agree, which is what makes the
  gating insight (seeding is a no-op without an inner blend) checkable.
```

- [ ] **Step 5: Commit**

```bash
git add test/helpers/svg-golden-fixtures.ts test/fixtures/svg/non-isolated-group.png test/fixtures/svg/PROVENANCE.md
git commit -m "test(svg): golden for the default /Group unit composite (bbu)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mutation checks and documentation

A green first run is not evidence. Each mutation is applied, the suite re-run,
the result recorded, and the mutation reverted before the next.

**Files:**
- Modify: `test/fixtures/svg/PROVENANCE.md` (mutation table, Limits section)
- Modify: `CLAUDE.md` (the `svgrender.ts` invariant block)
- Modify: `README.md` (only if it documents rendering limitations)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: no code.

- [ ] **Step 1: Mutation — drop backdrop seeding**

In `src/raster.ts` `beginOffscreen`, comment out the seeding loop body from
Step 6 of Task 2, leaving the `groupAlpha` allocation in place.

Run: `npm test`
Expected: the `§11.4.6` test fails, reading `[128, 255, 128]` (the isolated
answer). Record the observed value. **Revert.**

- [ ] **Step 2: Mutation — drop the removal formula**

In `composeGroup`, change `const k = a0 / agn - a0;` to `const k = 0;`.

Run: `npm test`
Expected: the `§11.4.6` test fails. Record the observed value. **Revert.**

- [ ] **Step 3: Mutation — drop `groupAlpha` accumulation**

In `Canvas.blend()`, comment out the three-line `groupAlpha` update.

Run: `npm test`
Expected: the `§11.4.6` test fails — `αgn` stays 0, so every pixel hits the
`agn <= 0` continue and the group vanishes. Record the observed value.
**Revert.**

- [ ] **Step 4: Mutation — revert the predicate to `isolated &&`**

In `src/pagerender.ts`, change `needsBuffer`'s first conjunct from
`isTransparencyGroup` back to `isolated`.

Run: `npm test`
Expected: the double-darkening test fails for `absent` and `false` but passes
for `true`, and the `non-isolated-group` golden fails. Record which fail.
**Revert.**

- [ ] **Step 5: Verify all mutations are reverted**

Run: `git diff --stat && npm run typecheck && npm test`
Expected: no diff in `src/`, and a fully green suite. Do not proceed until
both hold.

- [ ] **Step 6: Record the mutation results**

Add four rows to the mutation table in `test/fixtures/svg/PROVENANCE.md`
(line 238), matching the existing `| Mutation | Result |` format and using the
values actually observed in Steps 1-4 — not the ones predicted here. If a
prediction did not hold, say so in the row; a mutation that was *not* caught is
the most valuable thing this table can record.

- [ ] **Step 7: Narrow the Limits entry**

In `test/fixtures/svg/PROVENANCE.md`, replace the "Backdrop removal" limit
(lines 217-221) with:

```markdown
- **Backdrop removal in SVG** for non-isolated groups (ISO 32000-1 §11.4.6).
  `ToImage` implements it (`bbu`); `ToSvg` cannot. Group `opacity` creates a
  stacking context and therefore forces isolation, so a non-isolated group that
  both composites as a unit *and* blends internally has no SVG expression. SVG
  is exact for every other combination, including the common
  `non-isolated-group` case. No golden covers the residue: both engines isolate
  it, so it could only be registered as a SKIP.
```

Also update the "Knockout groups" line to reference the split-out issue:

```markdown
- **Knockout groups** (`/K true`) — unimplemented in both backends
  (`aspose-pdf-foss-for-ts-076`).
```

- [ ] **Step 8: Update the CLAUDE.md invariant**

In `CLAUDE.md`, in the `svgrender.ts`/`raster.ts`/`pagerender.ts` bullet, add
after the existing isolated-group invariant paragraph:

```markdown
  **Invariant:** `/Group /I` selects how a transparency group composites, never
  whether it is buffered. `/I` defaults to *false*, so gating buffering on
  `/I true` silently drew the ordinary `/Group` form inline and double-composited
  its overlaps. Buffer whenever the group composites as a unit — group alpha, a
  blend mode, or a soft mask — and let `/I` choose the path. Seeding the backdrop
  is needed only when the contents also blend: with Normal inner compositing,
  seed-then-remove provably recovers the isolated result.
```

- [ ] **Step 9: Check README**

Run: `grep -nE "isolat|transparency group|knockout" README.md`

If the rendering limitations list mentions group isolation or transparency
groups, update it to match the shipped behaviour: `ToImage` implements
non-isolated groups; `ToSvg` is exact except for a non-isolated group that both
composites as a unit and blends internally; knockout (`/K true`) is
unimplemented in both. If there are no matches, make no change — do not invent
a new README section for this.

- [ ] **Step 10: Commit**

```bash
git add CLAUDE.md README.md test/fixtures/svg/PROVENANCE.md
git commit -m "docs(render): record bbu mutation checks and narrow the SVG limit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 11: Close the issue and push**

```bash
npm run typecheck && npm test
bd close aspose-pdf-foss-for-ts-bbu
git pull --rebase
git push
git status
```

Expected: suite green, and `git status` reporting up to date with origin.
