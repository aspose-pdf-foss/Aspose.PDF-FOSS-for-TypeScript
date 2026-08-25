# SVG textPath Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `<textPath>` — text laid along a referenced or inline path — in `page.AddSVGObject`, covering all of SVG 2's textPath except `method="stretch"`.

**Architecture:** Glyphs are laid out on a straight baseline exactly as today, then a pure post-pass maps them onto an arc-length parameterization of the path. `flattenText` / `placeChars` / `applyTextLength` / `applyAnchors` are untouched except for one chunk rule, and glyphs stay real PDF text operators, so the text remains extractable.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

Design spec: `docs/superpowers/specs/2026-08-03-svg-textpath-design.md`
Issue: `aspose-pdf-foss-for-ts-1gg0.20` (epic `1gg0`).
Branch: `feat/svg-textpath`.

## Global Constraints

- **Zero runtime dependencies.** Do not add npm runtime deps. `node:zlib`, `node:crypto`, `node:fs` only.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { flattenCubic } from './strokegeom.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any task is considered done.
- **`svgtext.ts` and `svgtextpath.ts` stay `Document`-free.** They import no `Document` and allocate no PDF objects. Anything needing `e.ids` lives in `svgdraw.ts`.
- **Coordinates are y-down viewBox units** throughout the SVG stack. PDF text space is y-up, and `textMatrix` carries that flip — do not add a second one.
- **TDD.** Write the failing test, watch it fail for the right reason, then implement.
- **A passing new test is not evidence.** Per `CLAUDE.md`: break the code path it covers and confirm the suite goes red. Task 6 does this explicitly.
- **Reporting rule:** SVG-mandated outcomes are silent; fidelity losses add to `result.skipped`. Never report a case the spec says renders as nothing by design.

Run the full suite with `npm test`; a single file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: Rotation-aware text decoration

A prerequisite, not an extra. `decorationOps` builds an axis-aligned rect from `run[0].x`/`run[0].y` and ignores `rot`, even though its own run grouping *requires* equal `rot`. Every glyph on a path is rotated, so textPath cannot route around it.

Verified on the current tree: `<text rotate="45" text-decoration="underline">Hi</text>` emits `0 51.2 32 0.8 re` — byte-identical to the unrotated case — while the glyph `Tm` correctly carries the rotation.

**Files:**
- Modify: `src/svgtext.ts:576-581` (the `rule` closure inside `decorationOps`)
- Test: `test/svg-textpath.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no signature changes. `decorationOps(glyphs: PlacedGlyph[]) => { beneath: string[]; above: string[] }` is unchanged; only the operators it emits change, and only when `rot !== 0`.

- [ ] **Step 1: Write the failing test**

Create `test/svg-textpath.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import { ref } from '../src/types.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const VP = { minX: 0, minY: 0, w: 200, h: 200 };
const noStreams = () => { let n = 0; return { stream: () => ref(++n) }; };
const noImages = () => { let n = 100; return { image: () => ref(++n) }; };

const draw = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
    noStreams(), noImages());
const body = (svg: string) => draw(svg).content;

describe('text decoration follows the glyph rotation', () => {
  it('is unchanged at rot 0', () => {
    // The regression guard: existing output must stay byte-identical.
    const c = body('<svg><text x="0" y="50" text-decoration="underline">Hi</text></svg>');
    expect(c).toContain('0 51.2 32 0.8 re');
    expect(c).not.toContain('cm');
  });

  it('rotates the rule with the run', () => {
    const c = body(
      '<svg><text x="0" y="50" rotate="90" text-decoration="underline">Hi</text></svg>');
    // The rect is now emitted in the glyph frame, so it carries textMatrix as a
    // cm and the rect itself is local: x from 0, y at the underline offset.
    expect(c).toContain('0 1 1 0 0 50 cm');
    expect(c).toContain('0 -1.2 32 0.8 re');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-textpath.test.ts`

Expected: the first test PASSES (it describes today's behaviour), the second FAILS — no `cm` is emitted and the rect is the unrotated `0 51.2 32 0.8 re`.

- [ ] **Step 3: Emit the rule in the glyph frame**

In `src/svgtext.ts`, replace the `rule` closure inside `decorationOps`:

```ts
    const rule = (offsetEm: number, thickEm: number, into: string[]): void => {
      const t = thickEm * st.size;
      // Emitted in the GLYPH frame, so the rule turns with the text — on a
      // textPath every glyph is its own run at its own tangent angle, and an
      // axis-aligned rect would lie flat across a curve. textMatrix is the same
      // frame emitGlyphs uses for the Tm, so local +x runs along the baseline
      // and local +y is glyph-up: exactly the space the vmetrics offsets are
      // already expressed in, which is why no y-down sign flip appears here.
      // At rot 0 this reduces to the previous axis-aligned rect exactly.
      const ly = offsetEm * st.size - t / 2;
      into.push('q', `${rgb} rg`,
        `${textMatrix(run[0].x, run[0].y, run[0].rot).map(num).join(' ')} cm`,
        `0 ${num(ly)} ${num(w)} ${num(t)} re`, 'f', 'Q');
    };
```

`w` stays `run[run.length - 1].x + run[run.length - 1].adv - run[0].x`. That is already a local-frame width: `placeChars` advances the cursor along the unrotated baseline, so `x` is distance along the baseline whatever `rot` says, and on a path each run holds one glyph so `w` is simply its advance.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/svg-textpath.test.ts`
Expected: PASS, both.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`

Expected: green. `test/svg-text.test.ts` and `test/svg-text-render.test.ts` cover decoration; because rot 0 output is byte-identical they must not need edits. **If a rot-0 assertion fails, the local-frame arithmetic is wrong — fix the code, not the test.**

- [ ] **Step 6: Commit**

```bash
git add src/svgtext.ts test/svg-textpath.test.ts
git commit -m "fix(svg): text decoration follows the glyph rotation

decorationOps emitted an axis-aligned rect regardless of rot, so an
underline under rotate=\"45\" was byte-identical to an unrotated one
while the glyph Tm carried the rotation. The rule is now emitted in the
glyph frame via textMatrix; at rot 0 the geometry is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `svgtextpath.ts` — arc-length metrics

Pure geometry. No glyphs yet, no integration.

**Files:**
- Create: `src/svgtextpath.ts`
- Test: `test/svg-textpath.test.ts` (extend)

**Interfaces:**
- Consumes: `flattenCubic(out, x0,y0,x1,y1,x2,y2,x3,y3, depth, tol)` and `FLATTEN_TOL` from `src/strokegeom.js`; `SvgSeg` (`{ op: 'M'|'L'|'C'|'Z'; args: number[] }`) from `src/svgpath.js`.
- Produces:
  - `interface PathMetrics { pts: { x: number; y: number }[]; cum: number[]; total: number }`
  - `measurePath(segs: SvgSeg[]): PathMetrics`
  - `pointAt(m: PathMetrics, dist: number): { x: number; y: number; angle: number } | null` — `angle` in **degrees**
  - `reverseMetrics(m: PathMetrics): PathMetrics`

- [ ] **Step 1: Write the failing test**

Append to `test/svg-textpath.test.ts`:

```ts
import { measurePath, pointAt, reverseMetrics } from '../src/svgtextpath.js';
import { parsePath } from '../src/svgpath.js';

const segsOf = (d: string) => parsePath(d).segs;

describe('measurePath / pointAt', () => {
  it('measures a straight line', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    expect(m.total).toBeCloseTo(100, 9);
    expect(m.pts.length).toBe(2);
  });

  it('measures a polyline as the sum of its legs', () => {
    const m = measurePath(segsOf('M0 0 L30 0 L30 40'));
    expect(m.total).toBeCloseTo(70, 9);
  });

  it('drops zero-length legs rather than storing duplicate vertices', () => {
    const m = measurePath(segsOf('M0 0 L0 0 L10 0'));
    expect(m.total).toBeCloseTo(10, 9);
    expect(m.pts.length).toBe(2);
  });

  it('interpolates a point and its angle along a line', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    const p = pointAt(m, 25)!;
    expect(p.x).toBeCloseTo(25, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.angle).toBeCloseTo(0, 9);
  });

  it('reports 90 degrees on a downward line (y is down here)', () => {
    const m = measurePath(segsOf('M10 0 L10 50'));
    const p = pointAt(m, 20)!;
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(20, 9);
    expect(p.angle).toBeCloseTo(90, 9);
  });

  it('returns null past either end', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    expect(pointAt(m, -0.5)).toBeNull();
    expect(pointAt(m, 100.5)).toBeNull();
    expect(pointAt(m, 0)).not.toBeNull();
    expect(pointAt(m, 100)).not.toBeNull();
  });

  it('flattens a cubic close to its analytic length', () => {
    // A cubic approximation of a quarter circle of radius 100: arc length is
    // pi*100/2 ~ 157.08. The standard control offset is k = 0.5522847498.
    const k = 55.22847498;
    const m = measurePath(segsOf(`M0 0 C${k} 0 100 ${100 - k} 100 100`));
    expect(m.total).toBeGreaterThan(155);
    expect(m.total).toBeLessThan(159);
  });

  it('closes a subpath on Z', () => {
    const m = measurePath(segsOf('M0 0 L10 0 L10 10 Z'));
    // 10 + 10 + the closing leg back to the origin.
    expect(m.total).toBeCloseTo(10 + 10 + Math.hypot(10, 10), 9);
  });

  it('concatenates subpaths, the jump contributing no length', () => {
    const m = measurePath(segsOf('M0 0 L10 0 M50 0 L60 0'));
    expect(m.total).toBeCloseTo(20, 9);
    // Just past the first subpath the angle must come from real geometry, not
    // from the zero-length jump.
    expect(pointAt(m, 10)!.angle).toBeCloseTo(0, 9);
  });

  it('reverseMetrics walks the same geometry backwards', () => {
    const m = reverseMetrics(measurePath(segsOf('M0 0 L100 0')));
    expect(m.total).toBeCloseTo(100, 9);
    const p = pointAt(m, 25)!;
    expect(p.x).toBeCloseTo(75, 9);
    expect(Math.abs(p.angle)).toBeCloseTo(180, 9);
  });

  it('returns null for a path with no extent', () => {
    expect(pointAt(measurePath(segsOf('M5 5')), 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-textpath.test.ts`
Expected: FAIL — TypeScript cannot resolve `../src/svgtextpath.js`.

- [ ] **Step 3: Write the module**

Create `src/svgtextpath.ts`:

```ts
// SVG <textPath> geometry (issue 1gg0.20). Pure: imports no Document, allocates
// no PDF objects, and knows nothing about fonts. Coordinates are y-down viewBox
// units, like the rest of the SVG stack, so a downward tangent is +90 degrees.
import { flattenCubic, FLATTEN_TOL } from './strokegeom.js';
import type { SvgSeg } from './svgpath.js';

export interface Pt { x: number; y: number }

/** A path flattened to a polyline, with the cumulative arc length at each
 *  vertex. `cum[0]` is 0 and `cum[cum.length - 1]` is `total`. */
export interface PathMetrics {
  pts: Pt[];
  cum: number[];
  total: number;
}

/** Flatten `segs` to a polyline and accumulate its arc length.
 *
 *  Subpaths are CONCATENATED: a moveto after ink contributes a vertex but no
 *  length, so text crosses the gap without consuming any. That matches what
 *  browsers measure, and it is why `pointAt` has to step over zero-length
 *  segments when it takes an angle. */
export function measurePath(segs: SvgSeg[]): PathMetrics {
  const pts: Pt[] = [];
  const cum: number[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;

  const add = (x: number, y: number, jump: boolean): void => {
    if (pts.length === 0) { pts.push({ x, y }); cum.push(0); return; }
    const p = pts[pts.length - 1];
    const d = jump ? 0 : Math.hypot(x - p.x, y - p.y);
    // A zero-length leg that is not a subpath jump carries no information: it
    // would only add a vertex whose direction is undefined.
    if (d === 0 && !jump) return;
    pts.push({ x, y });
    cum.push(cum[cum.length - 1] + d);
  };

  for (const s of segs) {
    const a = s.args;
    if (s.op === 'M') {
      cx = sx = a[0]; cy = sy = a[1];
      add(cx, cy, true);
    } else if (s.op === 'L') {
      cx = a[0]; cy = a[1];
      add(cx, cy, false);
    } else if (s.op === 'C') {
      const flat: number[] = [];
      flattenCubic(flat, cx, cy, a[0], a[1], a[2], a[3], a[4], a[5], 0, FLATTEN_TOL);
      for (let i = 0; i + 1 < flat.length; i += 2) add(flat[i], flat[i + 1], false);
      cx = a[4]; cy = a[5];
    } else {
      // Z: back to the subpath start, which is a real leg with real length.
      cx = sx; cy = sy;
      add(cx, cy, false);
    }
  }
  return { pts, cum, total: cum.length > 0 ? cum[cum.length - 1] : 0 };
}

/** The point and tangent at `dist` along `m`, or null when `dist` falls outside
 *  [0, total] or the path has no extent. `angle` is in DEGREES, measured in
 *  y-down space, so a downward tangent is +90. */
export function pointAt(
  m: PathMetrics, dist: number,
): { x: number; y: number; angle: number } | null {
  if (m.pts.length < 2 || m.total <= 0) return null;
  if (dist < 0 || dist > m.total) return null;

  // Largest i with cum[i] <= dist.
  let lo = 0, hi = m.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (m.cum[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  let i = lo;
  // Step over zero-length segments — a subpath jump — so the angle comes from
  // geometry that actually has a direction.
  while (i + 1 < m.pts.length && m.cum[i + 1] === m.cum[i]) i++;
  if (i + 1 >= m.pts.length) i = m.pts.length - 2;

  const a = m.pts[i], b = m.pts[i + 1];
  const seg = m.cum[i + 1] - m.cum[i];
  const t = seg > 0 ? (dist - m.cum[i]) / seg : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/** The same geometry traversed backwards — what side="right" means. Reversing
 *  the polyline flips both the travel direction and the normal, so no other
 *  part of the mapping needs a side-specific case. */
export function reverseMetrics(m: PathMetrics): PathMetrics {
  const pts = [...m.pts].reverse();
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, total: cum.length > 0 ? cum[cum.length - 1] : 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run test/svg-textpath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgtextpath.ts test/svg-textpath.test.ts
git commit -m "feat(svg): arc-length metrics for textPath

measurePath flattens a path to a polyline with cumulative lengths via
strokegeom's flattenCubic — the shared flattener, so textPath adds no
second one. Subpaths concatenate with a zero-length jump, which pointAt
steps over when taking an angle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `mapGlyphsToPath`

The mapping itself, still pure — it takes `PlacedGlyph[]` and knows nothing about XML or PDF.

**Files:**
- Modify: `src/svgtextpath.ts` (add the mapper)
- Test: `test/svg-textpath.test.ts` (extend)

**Interfaces:**
- Consumes: `PathMetrics`, `pointAt`, `measurePath` from Task 2; `PlacedGlyph` from `src/svgtext.js` (fields used: `x`, `y`, `adv`, `rot`, `chain`).
- Produces: `mapGlyphsToPath(glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean, m: PathMetrics, startOffset: number): PlacedGlyph[]` — returns the surviving glyphs, mutating the mapped ones in place.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-textpath.test.ts`:

```ts
import { mapGlyphsToPath } from '../src/svgtextpath.js';
import type { PlacedGlyph, SvgTextStyle } from '../src/svgtext.js';

/** A minimal PlacedGlyph. Only x/y/adv/rot/chain matter to the mapper, so the
 *  style is a cast rather than a real face — building one would test the font
 *  provider, not the mapping. (`null as never` does not compile under strict;
 *  the double assertion is the spelling that does.) */
const g = (x: number, adv: number, y = 0): PlacedGlyph => ({
  ch: 'x', x, y, rot: 0, adv, chunk: 0, hscale: 1, chain: [0], owner: 0,
  style: undefined as unknown as SvgTextStyle,
});

describe('mapGlyphsToPath', () => {
  const line = measurePath(segsOf('M0 0 L100 0'));

  it('places a glyph by the MIDPOINT of its advance', () => {
    // Midpoint at 0 + 5 = 5, so the origin backs off 5 to land at x = 0.
    const [out] = mapGlyphsToPath([g(0, 10)], () => true, line, 0);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.rot).toBeCloseTo(0, 9);
  });

  it('adds startOffset along the path', () => {
    const [out] = mapGlyphsToPath([g(0, 10)], () => true, line, 20);
    expect(out.x).toBeCloseTo(20, 9);
  });

  it('rotates to the tangent and keeps y as a perpendicular offset', () => {
    const down = measurePath(segsOf('M10 0 L10 100'));
    // Midpoint at 5 -> point (10, 5); origin backs off 5 along the tangent to
    // (10, 0); y = 3 displaces along the normal (-sin, cos) = (-1, 0).
    const [out] = mapGlyphsToPath([g(0, 10, 3)], () => true, down, 0);
    expect(out.x).toBeCloseTo(7, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.rot).toBeCloseTo(90, 9);
  });

  it('drops a glyph whose midpoint runs off the end', () => {
    const out = mapGlyphsToPath([g(0, 10), g(200, 10)], () => true, line, 0);
    expect(out.length).toBe(1);
    expect(out[0].x).toBeCloseTo(0, 9);
  });

  it('drops a glyph pushed before the start by a negative offset', () => {
    const out = mapGlyphsToPath([g(0, 10)], () => true, line, -50);
    expect(out.length).toBe(0);
  });

  it('leaves non-member glyphs untouched and in place', () => {
    const off = g(70, 10);
    const out = mapGlyphsToPath([g(0, 10), off], (x) => x !== off, line, 0);
    expect(out.length).toBe(2);
    expect(out[1]).toBe(off);
    expect(off.x).toBe(70);
    expect(off.rot).toBe(0);
  });

  it('adds the tangent to any rotate= the author already applied', () => {
    const down = measurePath(segsOf('M10 0 L10 100'));
    const one = g(0, 10);
    one.rot = 15;
    const [out] = mapGlyphsToPath([one], () => true, down, 0);
    expect(out.rot).toBeCloseTo(105, 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-textpath.test.ts`
Expected: FAIL — `mapGlyphsToPath` is not exported.

- [ ] **Step 3: Write the mapper**

Append to `src/svgtextpath.ts`:

```ts
import type { PlacedGlyph } from './svgtext.js';

/** Map every glyph `onPath` accepts onto `m`, leaving the rest untouched.
 *
 *  Returns the SURVIVING glyphs rather than mutating in place: SVG 1.1
 *  §10.13.3 makes a glyph whose midpoint falls off the path not rendered at
 *  all, and dropping a glyph cannot be expressed by mutating it.
 *
 *  The distance is taken at the MIDPOINT of the glyph's advance, not at its
 *  origin — that is what centres a glyph on the curve rather than hanging it
 *  off the leading edge, and it is what SVG specifies. */
export function mapGlyphsToPath(
  glyphs: PlacedGlyph[], onPath: (g: PlacedGlyph) => boolean,
  m: PathMetrics, startOffset: number,
): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  for (const g of glyphs) {
    if (!onPath(g)) { out.push(g); continue; }
    const p = pointAt(m, startOffset + g.x + g.adv / 2);
    if (p === null) continue;                 // off the path: not rendered
    const rad = (p.angle * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const half = g.adv / 2;
    // Read y before either assignment: it is the perpendicular offset carrying
    // dy and baseline-shift, and the x line below consumes it.
    const gy = g.y;
    // Back off half the advance along the tangent (cos, sin) to recover the
    // ORIGIN from the midpoint, then displace along the normal (-sin, cos) —
    // which at angle 0 is (0, 1), so a positive y still means "further down the
    // page", exactly as in the unmapped layout.
    g.x = p.x - cos * half - sin * gy;
    g.y = p.y - sin * half + cos * gy;
    g.rot += p.angle;
    out.push(g);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run test/svg-textpath.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgtextpath.ts test/svg-textpath.test.ts
git commit -m "feat(svg): map laid-out glyphs onto a path

Each glyph is placed by the MIDPOINT of its advance, rotated to the
tangent, and displaced along the normal by its own y so dy and
baseline-shift still apply. Glyphs whose midpoint falls off the path are
dropped, which is why this returns a filtered array.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `<textPath>` reaches the layout, on the baseline

The element stops being discarded. It recurses like a `tspan`, records its attributes on the owner, and starts its own anchored chunk. No path geometry yet — so at the end of this task a `<textPath>` renders **on the baseline**, which is exactly the bad-href degradation the spec calls for.

**Files:**
- Modify: `src/svgtext.ts` — `OwnerSpec` (~line 160), `walkText`'s owner push (~line 282) and child dispatch (~line 302), `placeChars` (~line 393)
- Test: `test/svg-textpath.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Tasks 2-3.
- Produces:
  - `export interface TextPathSpec { href: string | null; inline: string | null; startOffset: string; side: 'left' | 'right'; stretch: boolean }`
  - `OwnerSpec` gains `path?: TextPathSpec`
  - `export function pathOwnerOf(chain: number[], owners: OwnerSpec[]): number | null`

- [ ] **Step 1: Write the failing test**

Append to `test/svg-textpath.test.ts`:

```ts
describe('<textPath> reaches the layout', () => {
  it('no longer discards the characters', () => {
    const r = draw('<svg><defs><path id="p" d="M0 0 L100 0"/></defs>' +
      '<text><textPath href="#p">Hi</textPath></text></svg>');
    expect(r.content).toContain('Tj');
  });

  it('no longer reports textPath merely for existing', () => {
    const r = draw('<svg><defs><path id="p" d="M0 0 L100 0"/></defs>' +
      '<text><textPath href="#p">Hi</textPath></text></svg>');
    expect(r.skipped).not.toContain('textPath');
  });

  it('still reports an unresolvable reference, and draws the text anyway', () => {
    const r = draw('<svg><text><textPath href="#nope">Hi</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
    expect(r.content).toContain('Tj');
  });

  it('gives the textPath its own anchored chunk', () => {
    // text-anchor=end on the <text> would, in one shared chunk, shift both runs
    // by the combined width. The textPath's own chunk must be measured alone.
    const shared = draw('<svg><defs><path id="p" d="M0 0 L500 0"/></defs>' +
      '<text x="0" y="10" text-anchor="end">AAAA' +
      '<textPath href="#p">BB</textPath></text></svg>').content;
    // fakeProvider makes every glyph 1 em wide, so at the default 16pt the
    // "AAAA" chunk is 64 wide and the "BB" chunk 32. Sharing a chunk would put
    // the first run's origin at -96 instead of -64.
    expect(shared).toContain('-64 ');
    expect(shared).not.toContain('-96 ');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-textpath.test.ts`

Expected: all four FAIL. The first two because the characters are discarded and `textPath` is unconditionally reported; the third because nothing is drawn; the fourth because there is no second chunk.

- [ ] **Step 3: Add `TextPathSpec` and extend `OwnerSpec`**

In `src/svgtext.ts`, replace the `OwnerSpec` declaration:

```ts
/** A `<textPath>`'s own attributes, recorded on its owner. Resolving `href` to
 *  geometry needs the element index, which lives in svgdraw.ts — this module
 *  stays Document-free, so it only carries the request. */
export interface TextPathSpec {
  /** Same-document id from href / xlink:href, '#' stripped. null when absent or
   *  when the value is not a local reference — this library performs no I/O. */
  href: string | null;
  /** SVG 2 inline path data. Wins over href when both are present. */
  inline: string | null;
  /** Raw attribute text, resolved against the path length at map time so a
   *  percentage does not need the geometry here. */
  startOffset: string;
  side: 'left' | 'right';
  /** method="stretch", which this stack renders as align and reports. */
  stretch: boolean;
}

export interface OwnerSpec {
  textLength?: number;
  spacingAndGlyphs: boolean;
  path?: TextPathSpec;
}

/** The innermost textPath owner in `chain`, or null when the character is not
 *  inside one. Innermost-first, so a textPath nested in a textPath wins. */
export function pathOwnerOf(chain: number[], owners: OwnerSpec[]): number | null {
  for (let i = chain.length - 1; i >= 0; i--)
    if (owners[chain[i]].path !== undefined) return chain[i];
  return null;
}

function textPathSpec(n: XmlNode): TextPathSpec {
  const raw = (n.attrs.get('href') ?? n.attrs.get('xlink:href') ?? '').trim();
  const inline = n.attrs.get('path');
  return {
    href: raw.startsWith('#') && raw.length > 1 ? raw.slice(1) : null,
    inline: inline !== undefined && inline.trim() !== '' ? inline : null,
    startOffset: n.attrs.get('startOffset') ?? '0',
    side: n.attrs.get('side') === 'right' ? 'right' : 'left',
    stretch: n.attrs.get('method') === 'stretch',
  };
}
```

- [ ] **Step 4: Record the spec and recurse into `textPath`**

In `walkText`, change the owner push to carry the spec:

```ts
  ctx.owners.push({
    textLength: Number.isFinite(tl) ? tl : undefined,
    spacingAndGlyphs: n.attrs.get('lengthAdjust') === 'spacingAndGlyphs',
    path: n.name === 'textPath' ? textPathSpec(n) : undefined,
  });
```

and the child dispatch to accept it:

```ts
    } else if (kid.name === 'tspan' || kid.name === 'textPath') {
      // A textPath recurses exactly like a tspan, so style inheritance, nested
      // tspans, the position lists and textLength all keep working. What makes
      // it different is recorded on its owner and applied after layout.
      walkText(ctx, kid, paint, style, ws, here);
    } else if (kid.name === 'title' || kid.name === 'desc' || kid.name === 'metadata') {
```

- [ ] **Step 5: Start a new chunk at a textPath boundary**

In `placeChars`, add the boundary check as the first statement of the loop body, before the existing absolute-x/y handling:

```ts
export function placeChars(f: FlatText): PlacedGlyph[] {
  const out: PlacedGlyph[] = [];
  let cx = 0, cy = 0, chunk = 0;
  let first = true;
  let prevPath: number | null = null;

  for (const c of f.chars) {
    // Entering or leaving a textPath starts a new anchored chunk and resets the
    // cursor: inside a textPath, x is distance ALONG THE PATH and y is the
    // perpendicular offset, so neither continues the enclosing <text>'s
    // position. Without this, "before<textPath>on path</textPath>" would anchor
    // both runs as one and start the path text dragged along by "before".
    const here = pathOwnerOf(c.chain, f.owners);
    if (here !== prevPath) {
      if (!first) chunk++;
      cx = 0; cy = 0;
      prevPath = here;
    }

    // An absolute x or y begins a new anchored chunk. The first character
    // always begins chunk 0, whether or not it carries one.
    if (c.x !== undefined || c.y !== undefined) {
```

The rest of the loop is unchanged.

- [ ] **Step 6: Report an unresolvable textPath**

Still in `walkText`, immediately after the `ctx.owners.push(...)` above:

```ts
  // Reported HERE only for the cases this module can see. svgdraw.ts reports
  // the rest — a dangling href, or path data that parses to nothing — because
  // only it can resolve an id. Both render on the baseline.
  if (n.name === 'textPath') {
    const spec = ctx.owners[owner].path!;
    if (spec.href === null && spec.inline === null) ctx.skipped.add('textPath');
    if (spec.stretch) ctx.skipped.add('textPath');
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/svg-textpath.test.ts`

Expected: the first, second and fourth PASS. The third (`still reports an unresolvable reference`) still FAILS — `href="#nope"` parses fine here, and only svgdraw can discover that no such element exists. Task 5 closes it. Leave the test failing and say so in the commit.

- [ ] **Step 8: Run the full suite**

Run: `npm test`

Expected: green apart from that one known failure. `test/svg-text.test.ts` must be untouched — a textPath now lays out where it previously vanished, but no existing fixture uses one.

- [ ] **Step 9: Commit**

```bash
git add src/svgtext.ts test/svg-textpath.test.ts
git commit -m "feat(svg): <textPath> reaches the text layout

It recurses like a tspan and records its attributes on the owner it
already allocates, and placeChars gives it its own anchored chunk with a
reset cursor — inside a textPath, x is distance along the path.

No geometry yet, so the characters render on the BASELINE. That is
already the degradation the spec asks for when a reference cannot be
resolved.

One test is knowingly red: reporting a dangling href needs the element
index, which only svgdraw can see. The next commit closes it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Resolve the path and apply the mapping

The feature lands.

**Files:**
- Modify: `src/svgdraw.ts` — imports (~lines 13-31), a new `applyTextPaths` helper, and the `<text>` branch of `walk` (~line 1236-1238)
- Test: `test/svg-textpath.test.ts` (extend)

**Interfaces:**
- Consumes: `measurePath`, `pointAt`, `reverseMetrics`, `mapGlyphsToPath`, `PathMetrics` from `src/svgtextpath.js`; `TextPathSpec`, `pathOwnerOf` (not needed here), `FlatText`, `PlacedGlyph` from `src/svgtext.js`; `parsePath` from `src/svgpath.js`.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-textpath.test.ts`:

```ts
/** Every `Tm` operand row in the content, as arrays of numbers.
 *
 *  The character class admits `e`/`E` and `+`: cos(90) is 6.1e-17 rather than a
 *  clean zero, and if `num` ever emits that in exponent form a stricter regex
 *  would silently match nothing and every assertion here would vacuously pass. */
function textMatrices(svg: string): number[][] {
  return [...body(svg).matchAll(/^([-+\d.eE ]+) Tm$/gm)]
    .map((m) => m[1].trim().split(/\s+/).map(Number));
}

const PATH = '<defs><path id="p" d="M0 0 L500 0"/></defs>';
const DOWN = '<defs><path id="p" d="M50 0 L50 500"/></defs>';

describe('textPath geometry', () => {
  it('emits one Tm per glyph, since each carries its own tangent', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p">abc</textPath></text></svg>');
    expect(m.length).toBe(3);
  });

  it('rotates the glyphs onto a downward path', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p">a</textPath></text></svg>');
    // textMatrix(x, y, 90) = [cos, sin, sin, -cos] = [0, 1, 1, 0].
    expect(m[0][0]).toBeCloseTo(0, 6);
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][4]).toBeCloseTo(50, 6);   // x pinned to the path
  });

  it('honours startOffset', () => {
    const at = (off: string) => textMatrices(`<svg>${DOWN}` +
      `<text><textPath href="#p" startOffset="${off}">a</textPath></text></svg>`)[0][5];
    expect(at('40') - at('0')).toBeCloseTo(40, 6);
  });

  it('reads startOffset as a percentage of path length', () => {
    const at = (off: string) => textMatrices(`<svg>${DOWN}` +
      `<text><textPath href="#p" startOffset="${off}">a</textPath></text></svg>`)[0][5];
    expect(at('10%')).toBeCloseTo(at('50'), 6);
  });

  it('accepts SVG 2 inline path data', () => {
    const m = textMatrices('<svg><text>' +
      '<textPath path="M50 0 L50 500">a</textPath></text></svg>');
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][4]).toBeCloseTo(50, 6);
  });

  it('walks the path backwards for side="right"', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p" side="right">a</textPath></text></svg>');
    // Reversed, the tangent is -90: textMatrix = [0, -1, -1, 0].
    expect(m[0][1]).toBeCloseTo(-1, 6);
  });

  it('drops glyphs that run off the end', () => {
    const short = '<defs><path id="s" d="M0 0 L20 0"/></defs>';
    // fakeProvider glyphs are 1 em = 16 wide, so only the first midpoint (8)
    // is on a 20-long path; the second (24) is past it.
    const m = textMatrices(`<svg>${short}` +
      '<text><textPath href="#s">abc</textPath></text></svg>');
    expect(m.length).toBe(1);
  });

  it('renders nothing for a path with no extent, and does not report it', () => {
    const r = draw('<svg><defs><path id="z" d="M5 5"/></defs>' +
      '<text><textPath href="#z">abc</textPath></text></svg>');
    expect(r.content).not.toContain('Tj');
    expect(r.skipped).not.toContain('textPath');
  });

  it('reports method="stretch" and renders it as align', () => {
    const r = draw(`<svg>${DOWN}` +
      '<text><textPath href="#p" method="stretch">a</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
    expect(r.content).toContain('Tj');
  });

  it('does not report spacing="auto"', () => {
    const r = draw(`<svg>${DOWN}` +
      '<text><textPath href="#p" spacing="auto">a</textPath></text></svg>');
    expect(r.skipped).not.toContain('textPath');
  });

  it('leaves text outside the textPath on the baseline', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text x="0" y="10">A<textPath href="#p">b</textPath></text></svg>');
    // The unmapped "A" keeps the upright matrix; the mapped "b" does not.
    expect(m.some((r) => r[0] === 1 && r[1] === 0)).toBe(true);
    expect(m.some((r) => Math.abs(r[1] - 1) < 1e-6)).toBe(true);
  });

  it('ignores the referenced path element own transform', () => {
    const shifted = '<defs><path id="t" d="M50 0 L50 500" transform="translate(90 0)"/></defs>';
    const m = textMatrices(`<svg>${shifted}` +
      '<text><textPath href="#t">a</textPath></text></svg>');
    expect(m[0][4]).toBeCloseTo(50, 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-textpath.test.ts`

Expected: the geometry tests FAIL — every glyph still lays out upright on the baseline, so `m[0][1]` is 0 rather than 1 and no glyph is dropped. `renders nothing for a path with no extent` and `does not report spacing` may already pass; that is fine, they are guards.

- [ ] **Step 3: Extend the svgdraw imports**

In `src/svgdraw.ts`, add `parsePath` to the existing `./svgpath.js` import:

```ts
import {
  attrNum, parsePath, segsBBox, shapeSegs, subtreeBBox,
  type SvgSeg, type SegBBox, type TextMeasure,
} from './svgpath.js';
```

extend the `./svgtext.js` import:

```ts
import {
  flattenText, layoutText, emitGlyphs, decorationOps, glyphsBBox,
  type SvgFontProvider, type FlatText, type PlacedGlyph, type TextPathSpec,
} from './svgtext.js';
```

and add the new module:

```ts
import {
  measurePath, reverseMetrics, mapGlyphsToPath,
} from './svgtextpath.js';
```

- [ ] **Step 4: Add the resolver and the mapping pass**

In `src/svgdraw.ts`, immediately before `function walk(`:

```ts
/** The path data a textPath asks for: inline first, else a same-document
 *  `<path>`. null when there is nothing usable to lay text on. */
function textPathSegs(e: Emitter, spec: TextPathSpec): SvgSeg[] | null {
  let d: string | undefined;
  if (spec.inline !== null) {
    d = spec.inline;
  } else if (spec.href !== null) {
    const node = e.ids.get(spec.href);
    // Only a <path>. SVG 2 allows a shape here, which this stack does not do —
    // the element's own `transform` is ignored either way, since SVG 1.1
    // §10.13.3 puts the data in the textPath's user space, not the path's.
    if (node && node.name === 'path') d = node.attrs.get('d');
  }
  if (d === undefined) return null;
  const { segs } = parsePath(d);
  return segs.length === 0 ? null : segs;
}

/** startOffset as a distance: a percentage of the path length, or a length. */
function startOffsetOf(raw: string, total: number): number {
  const s = raw.trim();
  const pct = s.endsWith('%');
  const n = parseFloat(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return 0;
  return pct ? (n / 100) * total : n;
}

/** Map each textPath owner's glyphs onto its own geometry, innermost-last.
 *
 *  Returns the surviving glyphs. An owner whose reference cannot be resolved is
 *  reported and left alone, so its text stays on the baseline — visible ink
 *  beats silently dropped content, the same way an unresolvable filter degrades
 *  to unfiltered. A path that resolves but has no extent renders nothing and is
 *  NOT reported: SVG mandates that outcome. */
function applyTextPaths(
  e: Emitter, flat: FlatText, glyphs: PlacedGlyph[],
): PlacedGlyph[] {
  let out = glyphs;
  for (let o = 0; o < flat.owners.length; o++) {
    const spec = flat.owners[o].path;
    if (spec === undefined) continue;
    const segs = textPathSegs(e, spec);
    if (segs === null) { e.skipped.add('textPath'); continue; }
    let m = measurePath(segs);
    if (spec.side === 'right') m = reverseMetrics(m);
    out = mapGlyphsToPath(
      out, (g) => g.chain.includes(o), m, startOffsetOf(spec.startOffset, m.total));
  }
  return out;
}
```

- [ ] **Step 5: Call it from the text branch**

In `walk`'s `<text>` branch, change the layout line from `const` to `let` and add the pass:

```ts
        let glyphs = layoutText(flat);
        glyphs = applyTextPaths(t, flat, glyphs);
        const dec = decorationOps(glyphs);
```

Everything after — `decorationOps`, `emitGlyphs`, `usedFonts`, `addInk` — is unchanged and now operates on the mapped glyphs, which is what makes decoration follow the curve and the ink box cover it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/svg-textpath.test.ts`

Expected: PASS, including `still reports an unresolvable reference` from Task 4, which this task closes.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: green. `test/svg-input-fixtures.test.ts` renders third-party SVGs — if any uses `<textPath>`, its output legitimately changes from "nothing" to "text on a curve". Confirm the new output is correct before touching a golden, and say so in the commit rather than regenerating quietly.

- [ ] **Step 8: Commit**

```bash
git add src/svgdraw.ts test/svg-textpath.test.ts
git commit -m "feat(svg): render <textPath> along its path

svgdraw resolves href or inline path= to segments, measures them, and
maps the laid-out glyphs on as a post-pass — so flatten/place/anchor are
untouched and the glyphs stay real text operators.

Covers startOffset (length and percentage), side, and spacing; reports
method=stretch and an unresolvable reference, both of which render on
the baseline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Prove it renders — pixels and mutation

Everything so far asserts content-stream structure. This asserts the marks on the page, then proves the assertions can fail.

**Files:**
- Create: `test/svg-textpath-render.test.ts`

**Interfaces:**
- Consumes: the whole feature. Uses `buildSvgPdf` from `test/helpers/build-svg-fixtures.js` and `decodePng` from `test/helpers/decode-png.js`, exactly as `test/svg-mask-render.test.ts` does.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `test/svg-textpath-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

/** Whether any pixel in the box is strongly red. Regions rather than exact
 *  pixels: the assertion is about WHERE the run went, and predicting a
 *  Standard-14 glyph's exact coverage would test the rasterizer instead. */
function anyRed(png: DecodedPng, x0: number, y0: number, x1: number, y1: number): boolean {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [r, g, b] = png.at(x, y);
    if (r > 150 && g < 100 && b < 100) return true;
  }
  return false;
}

/** A vertical path down the middle. The <text> also carries an x/y far from it,
 *  so the two outcomes are unmistakable: mapped, the run is a VERTICAL band at
 *  x~100; unmapped, it is a HORIZONTAL band at y~150 starting at x=10.
 *
 *  The geometry is predictable in closed form rather than compared against our
 *  own producer, which is what keeps this from cancelling out the way
 *  CLAUDE.md warns a differential test can. */
const VERTICAL =
  '<svg viewBox="0 0 200 200">' +
  '<defs><path id="p" d="M100 20 L100 180"/></defs>' +
  '<text x="10" y="150" font-size="20" fill="#ff0000">' +
  '<textPath href="#p">HHHHHHHH</textPath></text></svg>';

describe('AddSVGObject — textPath through Save/Open/ToImage', () => {
  it('lays the run along the path, not along the baseline', () => {
    const { png, skipped } = render(VERTICAL);
    expect(skipped).toEqual([]);
    expect(anyRed(png, 90, 30, 110, 170)).toBe(true);    // the vertical band
    expect(anyRed(png, 5, 140, 80, 160)).toBe(false);    // where unmapped text would sit
  });

  it('turns the run with the path', () => {
    // A semicircle: the run starts heading down-right and ends heading up-right,
    // so ink must appear on BOTH sides of the horizontal midline.
    const { png } = render(
      '<svg viewBox="0 0 200 200">' +
      '<defs><path id="c" d="M30 100 C30 30 170 30 170 100"/></defs>' +
      '<text font-size="18" fill="#ff0000">' +
      '<textPath href="#c">HHHHHHHHHHHH</textPath></text></svg>');
    expect(anyRed(png, 25, 55, 60, 100)).toBe(true);     // left limb
    expect(anyRed(png, 140, 55, 175, 100)).toBe(true);   // right limb
    expect(anyRed(png, 80, 30, 120, 70)).toBe(true);     // over the top
  });

  it('draws an underline that follows the curve rather than lying flat', () => {
    const { png } = render(VERTICAL.replace(
      'font-size="20"', 'font-size="20" text-decoration="underline"'));
    // The rule turns with the glyphs, so it runs vertically beside the stems.
    expect(anyRed(png, 108, 40, 118, 160)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/svg-textpath-render.test.ts`
Expected: PASS.

If the underline test fails, widen its x window by a few points before assuming a bug — the rule sits an em-fraction off the baseline, and Helvetica's underline offset places it just clear of the stems.

- [ ] **Step 3: Prove the mapping is load-bearing**

Passing on the first run is not evidence. In `src/svgdraw.ts`, temporarily make `applyTextPaths` match no glyph — a self-assignment at the call site would trip `noUnusedLocals` on the now-unused helper, and commenting the call out has the same problem:

```ts
    out = mapGlyphsToPath(out, () => false, m, startOffsetOf(spec.startOffset, m.total));
    //                          ^^^^^^^^^^ MUTATION TEST — was (g) => g.chain.includes(o)
```

Run: `npx vitest run test/svg-textpath-render.test.ts`

Expected: `lays the run along the path` FAILS on **both** assertions — no ink in the vertical band, and ink where the unmapped baseline run sits. If only one fails, the fixture is not discriminating; fix it before continuing.

- [ ] **Step 4: Prove the midpoint rule is load-bearing**

Revert Step 3. In `src/svgtextpath.ts`, drop the half-advance:

```ts
    const p = pointAt(m, startOffset + g.x);   // MUTATION TEST — was + g.adv / 2
```

Run: `npx vitest run test/svg-textpath.test.ts`

Expected: `places a glyph by the MIDPOINT of its advance` FAILS — `out.x` comes back 5 instead of 0. (This is a unit test rather than a pixel one: half an advance is a real error but too small to read reliably off a rasterized glyph.)

- [ ] **Step 5: Prove the decoration frame is load-bearing**

Revert Step 4. In `src/svgtext.ts`, restore the axis-aligned rule:

```ts
      const y = run[0].y - offsetEm * st.size - t / 2;
      into.push('q', `${rgb} rg`, `${num(x)} ${num(y)} ${num(w)} ${num(t)} re`, 'f', 'Q');
```

Run: `npx vitest run test/svg-textpath.test.ts test/svg-textpath-render.test.ts`

Expected: `rotates the rule with the run` (Task 1) and `draws an underline that follows the curve` both FAIL.

- [ ] **Step 6: Revert every mutation and confirm green**

Run: `git diff src/` — expect **no** diff from the Task 5 commit.
Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add test/svg-textpath-render.test.ts
git commit -m "test(svg): pixel assertions for text on a path

A vertical path with the <text> anchored far away, so mapped and
unmapped land in disjoint regions of the page — the assertion is on
geometry predictable in closed form, not a diff against our own output.

All three assertions verified load-bearing by mutation: neutering the
mapping, dropping the half-advance midpoint, and reverting the
decoration frame each turn a specific test red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, the stretch issue, and close

**Files:**
- Modify: `README.md` (the SVG embedding bullet), `src/page.ts:502` (the `AddSVGObject` doc comment)

**Interfaces:** none.

- [ ] **Step 1: Update the README**

The SVG embedding bullet currently ends with:

> `<textPath>` is **not** rendered — it is skipped and named in `result.skipped`.

Replace it with:

> **`<textPath>`** lays text along a path: `href`/`xlink:href` to a `<path>` or SVG 2's inline `path=`, with `startOffset` (a length or a percentage of path length), `side` and `spacing`. Glyphs are placed by the midpoint of their advance and rotated to the path's tangent, so they stay real text — extractable and searchable — and an underline turns with them. A glyph whose midpoint falls beyond either end of the path is not rendered, as SVG mandates, and neither is text on a path with no extent. `method="stretch"` would need the glyph outlines warped rather than the glyphs placed, so it renders as `align` and names `textPath` in `result.skipped`; a `href` that resolves to nothing does the same and draws the text on the baseline rather than dropping it.

- [ ] **Step 2: Update the page.ts doc comment**

`src/page.ts:502` carries the same claim in the `AddSVGObject` doc comment — it reads "textPath — is skipped and named in `result.skipped`". Read the surrounding sentence and edit it so it no longer lists `textPath` among the unsupported features, keeping the rest of that sentence intact.

- [ ] **Step 3: Verify everything**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Step 4: Commit the docs**

```bash
git add README.md src/page.ts
git commit -m "docs: <textPath> renders along its path

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: File the stretch issue**

```bash
bd create "SVG textPath method=\"stretch\"" -t feature -p 4 --parent aspose-pdf-foss-for-ts-1gg0 -d "1gg0.20 ships every other part of SVG 2's textPath; method=\"stretch\" renders as align and reports. Stretch deforms the glyph OUTLINES along the curve rather than placing upright glyphs at tangent angles, so it needs three things this stack does not have on the authoring side: an outline seam on SvgFace (whose FontDriver exposes only measure/encode/probe), outline warping, and vector-path emission instead of text operators. The last one is the real cost: stretched text would stop being extractable and searchable, which every other part of the SVG text path preserves. Outline extraction exists in raster.ts and sfnt.ts, but on the RENDERING side — a different seam from SVG authoring."
```

- [ ] **Step 6: Record the invariant and close**

```bash
bd remember --key svg-textpath-shipped "1gg0.20 shipped. src/svgtextpath.ts is pure: measurePath(segs)->PathMetrics{pts,cum,total} over strokegeom's flattenCubic, pointAt(m,dist)->{x,y,angle in DEGREES}|null, reverseMetrics (that is all side=right is), mapGlyphsToPath(glyphs,onPath,m,startOffset)->surviving glyphs. Architecture: textPath is a POST-PASS over laid-out PlacedGlyphs, not a new layout path — flatten/place/anchor are untouched, so the glyphs stay real text operators and remain extractable. Key rules: (1) a glyph is placed by the MIDPOINT of its advance, so the origin backs off adv/2 along the tangent; (2) the normal is (-sin,cos), which at angle 0 is (0,1) so a positive y still means further down the page; (3) placeChars opens a new anchored chunk AND resets cx/cy at a textPath boundary — inside one, x is distance along the path, so without the reset preceding text drags the run along; (4) applyAnchors runs BEFORE the mapping, which is why text-anchor needs no path-specific code: its x shift converts directly into a shift along the arc. Degradation: unresolvable href or path data with no segments renders on the BASELINE and reports (house rule beats SVG 1.1, which renders nothing); a path that parses but has zero extent renders nothing SILENTLY, as SVG mandates. Fixed in passing: decorationOps ignored rot entirely, so an underline under rotate= was axis-aligned while the glyph Tm rotated — it now emits in the textMatrix frame, and rot 0 output is byte-identical."

bd close aspose-pdf-foss-for-ts-1gg0.20
```

- [ ] **Step 7: Push**

```bash
git push -u origin feat/svg-textpath
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Where it plugs in (`TextPathSpec`, `OwnerSpec.path`) | Task 4 |
| 2. A textPath starts a new anchored chunk | Task 4, Step 5 |
| 3. `svgtextpath.ts` (`measurePath`/`pointAt`/`reverseMetrics`) | Task 2 |
| 4. The placement rule (midpoint, normal, `side`, negative offset) | Task 3, and `side`/`startOffset` in Task 5 |
| 5. Decoration must rotate with the run | Task 1 |
| 6. Where the path is resolved (ignoring the path's own transform) | Task 5 |
| Degradation table — bad href | Tasks 4-5 |
| Degradation table — inline `path=` with no segments | Task 5 (`textPathSegs` returns null on `segs.length === 0`) |
| Degradation table — `method="stretch"` | Task 4, Step 6 |
| Degradation table — glyph past the end | Task 3 |
| Degradation table — zero-length path | Task 5 (silent; asserted in Task 5, Step 1) |
| Degradation table — `spacing="auto"` | Task 5 (asserted; no code needed) |
| Multiple textPaths per `<text>`, mapped independently | Task 5 (`applyTextPaths` loops owners) |
| Testing: units and structure | Tasks 1-5 |
| Testing: load-bearing render assertions | Task 6 |
| Testing: proving them load-bearing | Task 6, Steps 3-5 |
| Docs | Task 7 |
| Out of scope: `method="stretch"` issue | Task 7, Step 5 |

**Placeholder scan:** no TBDs; every code step carries the actual code. Task 7 Step 2 describes an edit without quoting the target line, because the exact wording of that doc comment must be read first — the instruction is specific about what to change and what to preserve.

**Type consistency:** `PathMetrics` / `Pt` are defined in Task 2 and consumed in Tasks 3 and 5. `mapGlyphsToPath`'s signature is fixed in Task 3 and called with exactly those four arguments in Task 5. `TextPathSpec` is defined in Task 4 and imported by Task 5; its fields (`href`, `inline`, `startOffset`, `side`, `stretch`) are the ones `textPathSegs` and `applyTextPaths` read. `pathOwnerOf` is exported in Task 4 and used only inside `placeChars`.

**One known-red test is intentional:** Task 4 leaves `still reports an unresolvable reference` failing, and Task 5 closes it. This is called out in both tasks and in Task 4's commit message, so it cannot be mistaken for a regression.
