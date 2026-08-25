# Axial Gradient Fills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `PageGraphics.setFillGradient()` so callers can fill vector paths with an axial (linear) `ShadingType 2` gradient, on a colour-stop model shared with the existing SVG import path.

**Architecture:** The stop model and the type-2-ramps-stitched-into-a-type-3 function builder already exist inside `src/svggradient.ts`. Task 1 extracts them verbatim into a new pure `src/gradient.ts`; Task 2 adds the public types, validation and shading-dict builders there; Task 3 adds a page `/Pattern` resource registrar; Task 4 wires `setFillGradient`; Task 5 proves the chain end-to-end and mutation-checks it. No second stitching implementation is written.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-30-axial-gradient-fill-design.md`
Issue: `aspose-pdf-foss-for-ts-lqp5.1` (absorbs `lqp5.3`; `lqp5.4` is the deferred follow-up)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension, e.g. `import { stopsFunction } from './gradient.js'`.
- **`src/gradient.ts` must not import `Document`, `Page`, or any `svg*` module.** It builds direct `PdfDict`s only. This is what keeps the SVG path allocating no indirect objects.
- **Validation precedes allocation.** Every argument is checked before any object is allocated, so a rejected call leaves the document byte-identical (the `formcreate.ts` invariant).
- **Public errors only:** `TypeError` for bad arguments; `UnsupportedFeatureError` (from `src/errors.ts`) for the not-yet-built paths. No other error classes.
- **`npm run typecheck` and `npm test` must both be green before the issue closes.**
- Run a single file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: Extract the shared stop core into `src/gradient.ts`

A pure move. **No behaviour changes and no assertion edits** — the only edits to
existing test files are import paths. If an assertion has to change, the move
changed behaviour: stop and report it rather than editing the test.

**Files:**
- Create: `src/gradient.ts`
- Modify: `src/svggradient.ts` (delete the moved block, add an import)
- Modify: `test/svg-gradient.test.ts:3-6` (split the import across two modules)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `src/gradient.ts` exporting `GradientStop` (with `opacity` now **optional**), `stopOpacity(s: GradientStop): number`, `clamp01(n: number): number`, `normalizeStops(stops: GradientStop[]): GradientStop[]`, `StopPick = (s: GradientStop) => number[]`, `ALPHA: StopPick`, `stopsFunction(stops: GradientStop[], pick?: StopPick): PdfDict`, `uniformOpacity(stops: GradientStop[]): number | null`.

- [ ] **Step 1: Confirm the suite is green before touching anything**

Run: `npx vitest run test/svg-gradient.test.ts test/svg-gradient-render.test.ts`
Expected: PASS. This is the baseline the move must preserve — record the test count.

- [ ] **Step 2: Create `src/gradient.ts` with the moved code**

Create the file with exactly this content. The bodies of `normalizeStops`,
`rampFunction` and `stopsFunction` are copied verbatim from `src/svggradient.ts`;
only `ALPHA` changes, to read through `stopOpacity`.

```ts
// The colour-stop model shared by every gradient producer: SVG import
// (svggradient.ts) and PageGraphics authoring (graphics.ts). Pure — it builds
// DIRECT PdfDicts and touches no Document, which is what lets the SVG path go on
// allocating no indirect objects. Direction note: svgrender.ts is PDF->SVG and
// shares nothing with this.
import { type PdfDict, type PdfObject } from './types.js';

/** One gradient stop. `offset` is in [0, 1]; `opacity` defaults to 1. */
export interface GradientStop {
  offset: number;
  color: [number, number, number];
  opacity?: number;
}

/** A stop's alpha, defaulting to fully opaque. Every reader must go through
 *  this: `opacity` is optional on the public type but always set by the SVG
 *  parser, and reading the field raw makes an authored stop `undefined`. */
export const stopOpacity = (s: GradientStop): number => s.opacity ?? 1;

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const dict = (entries: [string, PdfObject][]): PdfDict => new Map<string, PdfObject>(entries);

/** Prepare stops for a PDF function: offsets forced non-decreasing, then a stop
 *  added at 0 and at 1 when the list does not already reach them (repeating the
 *  adjacent colour). That makes /Domain [0 1] exact.
 *
 *  Doubled offsets are KEPT — they are what turns into a hard colour edge. The
 *  zero-width interval they create is dropped later, in stopsFunction, which is
 *  also what satisfies PDF's requirement that /Bounds be strictly increasing. */
export function normalizeStops(stops: GradientStop[]): GradientStop[] {
  if (stops.length < 2) return stops.map((s) => ({ ...s }));
  const out = stops.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    if (out[i].offset < out[i - 1].offset) out[i].offset = out[i - 1].offset;
  }
  if (out[0].offset > 0) out.unshift({ ...out[0], offset: 0 });
  const last = out[out.length - 1];
  if (last.offset < 1) out.push({ ...last, offset: 1 });
  return out;
}

/** How a stop projects onto a shading function's output vector. The colour
 *  shading and its grayscale alpha twin differ ONLY in this. */
export type StopPick = (s: GradientStop) => number[];

const RGB: StopPick = (s) => [...s.color];

/** The alpha ramp's projection: one /DeviceGray component, since the luminosity
 *  of a gray value g is g. */
export const ALPHA: StopPick = (s) => [stopOpacity(s)];

/** A type 2 exponential over [0, 1], linear (/N 1) between two colour vectors. */
function rampFunction(c0: number[], c1: number[]): PdfDict {
  return dict([
    ['FunctionType', 2],
    ['Domain', [0, 1]],
    ['C0', [...c0]],
    ['C1', [...c1]],
    ['N', 1],
  ]);
}

/** The function for a normalized stop list, over /Domain [0 1]. `pick` chooses
 *  what each stop contributes: its colour by default, its alpha for the mask's
 *  grayscale twin. Since only the OFFSETS decide the stitching, the two come out
 *  with identical /Bounds and /Encode — which is what makes a mask line up with
 *  the colour it masks.
 *
 *  One positive-width interval -> a bare type 2. More -> a type 3 stitching
 *  function over them. Zero-width intervals (a doubled offset, i.e. a hard colour
 *  edge) contribute NO sub-function, which is exactly what keeps /Bounds strictly
 *  increasing as PDF requires while still producing the edge.
 *
 *  Caller guarantees at least two stops and at least one positive-width interval;
 *  the degenerate cases are decided before this is reached. */
export function stopsFunction(stops: GradientStop[], pick: StopPick = RGB): PdfDict {
  const subs: PdfDict[] = [];
  const bounds: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    if (!(stops[i + 1].offset > stops[i].offset)) continue;
    if (subs.length > 0) bounds.push(stops[i].offset);
    subs.push(rampFunction(pick(stops[i]), pick(stops[i + 1])));
  }
  if (subs.length === 1) return subs[0];
  const encode: number[] = [];
  for (let i = 0; i < subs.length; i++) encode.push(0, 1);
  return dict([
    ['FunctionType', 3],
    ['Domain', [0, 1]],
    ['Functions', subs],
    ['Bounds', bounds],
    ['Encode', encode],
  ]);
}

/** Every stop carrying the same alpha, else null. Uniform alpha folds exactly
 *  into /ca + /CA; a varying one needs a luminosity soft mask. */
export function uniformOpacity(stops: GradientStop[]): number | null {
  if (stops.length === 0) return 1;
  const a = stopOpacity(stops[0]);
  return stops.every((s) => Math.abs(stopOpacity(s) - a) < 1e-9) ? a : null;
}
```

- [ ] **Step 3: Delete the moved block from `src/svggradient.ts`**

Delete these declarations, which now live in `gradient.ts`:
`GradientStop` (lines 12-17), `clamp01` (line 28), `normalizeStops` (lines
106-123), `StopPick` (line 129), `RGB` (line 131), `ALPHA` (line 135),
`rampFunction` (lines 137-146), `stopsFunction` (lines 148-179), and
`uniformOpacity` (lines 217-223).

**Keep** the local `const dict = ...` on line 125 — `patternOf` still uses it,
and a one-line `new Map(entries)` alias is not worth an import coupling.

- [ ] **Step 4: Add the import to `src/svggradient.ts`**

Immediately after the existing `import type { XmlNode } from './xml.js';` line, add:

```ts
import {
  clamp01, normalizeStops, stopsFunction, uniformOpacity, ALPHA,
  type GradientStop,
} from './gradient.js';
```

Then re-export the stop type so `ResolvedGradient` consumers keep compiling:

```ts
export type { GradientStop } from './gradient.js';
```

- [ ] **Step 5: Typecheck and fix the optional-`opacity` read sites**

Run: `npm run typecheck`
Expected: FAIL, if any site still reads `.opacity` directly. `ownStops` *writes*
`opacity` (fine — a required field satisfies an optional one). The failures, if
any, are readers. Fix each by calling `stopOpacity(s)` instead of `s.opacity`,
adding `stopOpacity` to the Step 4 import.

Re-run `npm run typecheck` until clean.

- [ ] **Step 6: Update the test's import path**

In `test/svg-gradient.test.ts`, replace lines 3-6 with:

```ts
import {
  resolveGradient, gradientPaint, spreadRange, tileStops, radialSpreadRange,
} from '../src/svggradient.js';
import {
  normalizeStops, stopsFunction, ALPHA, type GradientStop,
} from '../src/gradient.js';
```

Change nothing else in the file. No assertion edits.

- [ ] **Step 7: Verify the move is lossless**

Run: `npx vitest run test/svg-gradient.test.ts test/svg-gradient-render.test.ts`
Expected: PASS, with the same test count as Step 1.

Then run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/gradient.ts src/svggradient.ts test/svg-gradient.test.ts
git commit -m "refactor(gradient): extract the shared stop core from svggradient

Pure move: GradientStop, normalizeStops, stopsFunction, StopPick/ALPHA and
uniformOpacity go to a new dependency-free src/gradient.ts so PageGraphics
can reach them without dragging the SVG parser behind. opacity becomes
optional on the stop, read through stopOpacity(). No assertion changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Public gradient types, validation, and shading builders

**Files:**
- Modify: `src/gradient.ts` (append)
- Test: `test/gradient.test.ts` (create)

**Interfaces:**
- Consumes: from Task 1 — `GradientStop`, `stopOpacity`, `clamp01`, `normalizeStops`, `stopsFunction`, `uniformOpacity`.
- Produces: `LinearGradient`, `RadialGradient`, `Gradient` (the union), `validateGradient(g: Gradient): void`, `axialShading(g: LinearGradient, stops: GradientStop[]): PdfDict`, `shadingPattern(shading: PdfDict): PdfDict`.

- [ ] **Step 1: Write the failing test**

Create `test/gradient.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeStops, stopsFunction, validateGradient, axialShading, shadingPattern,
  ALPHA, uniformOpacity,
  type GradientStop, type LinearGradient, type Gradient,
} from '../src/gradient.js';
import { isDict, isName, type PdfDict } from '../src/types.js';

const RED: [number, number, number] = [1, 0, 0];
const BLUE: [number, number, number] = [0, 0, 1];
const GREEN: [number, number, number] = [0, 1, 0];

const linear = (stops: GradientStop[], over: Partial<LinearGradient> = {}): LinearGradient =>
  ({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops, ...over });

/** A dict entry, typed loosely for assertions. */
const at = (d: PdfDict, k: string): any => d.get(k);

describe('normalizeStops', () => {
  it('pads the list out to 0 and 1 by repeating the adjacent colour', () => {
    const out = normalizeStops([
      { offset: 0.25, color: RED }, { offset: 0.75, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.25, 0.75, 1]);
    expect(out[0].color).toEqual(RED);
    expect(out[3].color).toEqual(BLUE);
  });

  it('forces offsets non-decreasing', () => {
    const out = normalizeStops([
      { offset: 0, color: RED }, { offset: 0.8, color: GREEN }, { offset: 0.3, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.8, 0.8, 1]);
  });

  it('keeps a doubled offset, which is the hard colour edge', () => {
    const out = normalizeStops([
      { offset: 0, color: RED }, { offset: 0.5, color: RED },
      { offset: 0.5, color: BLUE }, { offset: 1, color: BLUE },
    ]);
    expect(out.map((s) => s.offset)).toEqual([0, 0.5, 0.5, 1]);
  });

  it('leaves a list of fewer than two stops alone, but copies it', () => {
    const input = [{ offset: 0.5, color: RED }];
    const out = normalizeStops(input);
    expect(out).toEqual(input);
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('stopsFunction', () => {
  it('emits a bare type 2 for a single interval', () => {
    const fn = stopsFunction([{ offset: 0, color: RED }, { offset: 1, color: BLUE }]);
    expect(at(fn, 'FunctionType')).toBe(2);
    expect(at(fn, 'Domain')).toEqual([0, 1]);
    expect(at(fn, 'C0')).toEqual(RED);
    expect(at(fn, 'C1')).toEqual(BLUE);
    expect(at(fn, 'N')).toBe(1);
  });

  it('stitches multiple intervals into a type 3 with strictly increasing bounds', () => {
    const fn = stopsFunction([
      { offset: 0, color: RED }, { offset: 0.4, color: GREEN }, { offset: 1, color: BLUE },
    ]);
    expect(at(fn, 'FunctionType')).toBe(3);
    expect(at(fn, 'Bounds')).toEqual([0.4]);
    expect(at(fn, 'Encode')).toEqual([0, 1, 0, 1]);
    expect(at(fn, 'Functions')).toHaveLength(2);
    const bounds: number[] = at(fn, 'Bounds');
    for (let i = 1; i < bounds.length; i++) expect(bounds[i]).toBeGreaterThan(bounds[i - 1]);
  });

  it('contributes no sub-function for a zero-width interval', () => {
    // Four stops, three intervals, but the middle one has zero width.
    const fn = stopsFunction([
      { offset: 0, color: RED }, { offset: 0.5, color: RED },
      { offset: 0.5, color: BLUE }, { offset: 1, color: BLUE },
    ]);
    expect(at(fn, 'FunctionType')).toBe(3);
    expect(at(fn, 'Functions')).toHaveLength(2);   // not 3
    expect(at(fn, 'Bounds')).toEqual([0.5]);
  });

  it('gives the ALPHA twin identical Bounds and Encode', () => {
    const stops: GradientStop[] = [
      { offset: 0, color: RED, opacity: 0.2 },
      { offset: 0.4, color: GREEN, opacity: 0.6 },
      { offset: 1, color: BLUE, opacity: 1 },
    ];
    const rgb = stopsFunction(stops);
    const gray = stopsFunction(stops, ALPHA);
    expect(at(gray, 'Bounds')).toEqual(at(rgb, 'Bounds'));
    expect(at(gray, 'Encode')).toEqual(at(rgb, 'Encode'));
    const first: PdfDict = at(gray, 'Functions')[0];
    expect(at(first, 'C0')).toEqual([0.2]);        // one DeviceGray component
    expect(at(first, 'C1')).toEqual([0.6]);
  });

  it('defaults a stop with no opacity to fully opaque in the ALPHA twin', () => {
    const fn = stopsFunction([{ offset: 0, color: RED }, { offset: 1, color: BLUE }], ALPHA);
    expect(at(fn, 'C0')).toEqual([1]);
    expect(at(fn, 'C1')).toEqual([1]);
  });
});

describe('uniformOpacity', () => {
  it('reports the shared alpha, treating an absent opacity as 1', () => {
    expect(uniformOpacity([{ offset: 0, color: RED }, { offset: 1, color: BLUE }])).toBe(1);
    expect(uniformOpacity([
      { offset: 0, color: RED, opacity: 0.5 }, { offset: 1, color: BLUE, opacity: 0.5 },
    ])).toBe(0.5);
  });

  it('returns null when the stops disagree', () => {
    expect(uniformOpacity([
      { offset: 0, color: RED, opacity: 0.5 }, { offset: 1, color: BLUE },
    ])).toBeNull();
  });
});

describe('validateGradient', () => {
  const ok: GradientStop[] = [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  it('accepts a well-formed linear gradient', () => {
    expect(() => validateGradient(linear(ok))).not.toThrow();
    expect(() => validateGradient(linear(ok, { extend: [false, true] }))).not.toThrow();
  });

  it('accepts a well-formed radial gradient', () => {
    expect(() => validateGradient({
      kind: 'radial', cx: 50, cy: 50, r: 25, stops: ok,
    })).not.toThrow();
    expect(() => validateGradient({
      kind: 'radial', cx: 50, cy: 50, r: 25, fx: 40, fy: 60, stops: ok,
    })).not.toThrow();
  });

  it('rejects an empty stop list', () => {
    expect(() => validateGradient(linear([]))).toThrow(TypeError);
  });

  it('rejects a non-array stop list', () => {
    expect(() => validateGradient(linear(undefined as unknown as GradientStop[])))
      .toThrow(TypeError);
  });

  it('rejects an unknown kind', () => {
    expect(() => validateGradient({ kind: 'conic', stops: ok } as unknown as Gradient))
      .toThrow(TypeError);
  });

  it('rejects a non-finite offset', () => {
    expect(() => validateGradient(linear([{ offset: NaN, color: RED }, { offset: 1, color: BLUE }])))
      .toThrow(TypeError);
  });

  it('rejects a malformed colour', () => {
    expect(() => validateGradient(linear([{ offset: 0, color: [1, 0] as never }, ...ok])))
      .toThrow(TypeError);
    expect(() => validateGradient(linear([{ offset: 0, color: [1, 0, 2] }, ...ok])))
      .toThrow(TypeError);
  });

  it('rejects an out-of-range opacity', () => {
    expect(() => validateGradient(linear([{ offset: 0, color: RED, opacity: 1.5 }, ...ok])))
      .toThrow(TypeError);
  });

  it('rejects non-finite geometry', () => {
    expect(() => validateGradient(linear(ok, { x2: Infinity }))).toThrow(TypeError);
    expect(() => validateGradient({ kind: 'radial', cx: 0, cy: 0, r: NaN, stops: ok }))
      .toThrow(TypeError);
  });

  it('rejects a negative radius', () => {
    expect(() => validateGradient({ kind: 'radial', cx: 0, cy: 0, r: -1, stops: ok }))
      .toThrow(TypeError);
  });

  it('rejects a malformed extend', () => {
    expect(() => validateGradient(linear(ok, { extend: [true] as never }))).toThrow(TypeError);
    expect(() => validateGradient(linear(ok, { extend: [1, 0] as never }))).toThrow(TypeError);
  });
});

describe('axialShading', () => {
  it('builds a DeviceRGB ShadingType 2 over the gradient axis', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
                     { x1: 10, y1: 20, x2: 110, y2: 20 });
    const sh = axialShading(g, normalizeStops(g.stops));
    expect(at(sh, 'ShadingType')).toBe(2);
    expect(isName(at(sh, 'ColorSpace')) && at(sh, 'ColorSpace').name).toBe('DeviceRGB');
    expect(at(sh, 'Coords')).toEqual([10, 20, 110, 20]);
    expect(at(sh, 'Extend')).toEqual([true, true]);
    expect(isDict(at(sh, 'Function'))).toBe(true);
  });

  it('honours an explicit extend', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
                     { extend: [false, false] });
    expect(at(axialShading(g, normalizeStops(g.stops)), 'Extend')).toEqual([false, false]);
  });
});

describe('shadingPattern', () => {
  it('wraps a shading in a PatternType 2 with no /Matrix', () => {
    const g = linear([{ offset: 0, color: RED }, { offset: 1, color: BLUE }]);
    const p = shadingPattern(axialShading(g, normalizeStops(g.stops)));
    expect(isName(at(p, 'Type')) && at(p, 'Type').name).toBe('Pattern');
    expect(at(p, 'PatternType')).toBe(2);
    expect(isDict(at(p, 'Shading'))).toBe(true);
    // Identity is the default; an explicit /Matrix here would be a bug, since
    // gradient coords are already in the parent stream's default space.
    expect(p.has('Matrix')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gradient.test.ts`
Expected: FAIL — the `normalizeStops` / `stopsFunction` / `uniformOpacity`
blocks PASS (Task 1 shipped them), and every `validateGradient`, `axialShading`
and `shadingPattern` test fails with the import not resolving.

- [ ] **Step 3: Append the implementation to `src/gradient.ts`**

Add `name` to the existing `types.js` import, so the first line reads:

```ts
import { name, type PdfDict, type PdfObject } from './types.js';
```

Then append:

```ts
/** An axial (linear) gradient: a colour ramp along the axis from (x1, y1) to
 *  (x2, y2), in the **default** user space of the content stream it paints into
 *  — see the /Matrix note on PageGraphics.setFillGradient. */
export interface LinearGradient {
  kind: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: GradientStop[];
  /** Whether to pad the ramp before the start and after the end. Default
   *  [true, true]. */
  extend?: [boolean, boolean];
}

/** A radial gradient: the ramp runs from the focal point out to the circle
 *  (cx, cy, r). `fx`/`fy` default to the centre. */
export interface RadialGradient {
  kind: 'radial';
  cx: number;
  cy: number;
  r: number;
  fx?: number;
  fy?: number;
  stops: GradientStop[];
  extend?: [boolean, boolean];
}

export type Gradient = LinearGradient | RadialGradient;

function checkNum(label: string, n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`gradient ${label} must be a finite number`);
  return n;
}

function checkStop(s: GradientStop, i: number): void {
  if (typeof s !== 'object' || s === null)
    throw new TypeError(`gradient stop ${i} must be an object`);
  checkNum(`stop ${i} offset`, s.offset);
  const c = s.color;
  if (!Array.isArray(c) || c.length !== 3 ||
      !c.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))
    throw new TypeError(`gradient stop ${i} color must be [r, g, b] with each component in 0..1`);
  if (s.opacity !== undefined &&
      (typeof s.opacity !== 'number' || !Number.isFinite(s.opacity) ||
       s.opacity < 0 || s.opacity > 1))
    throw new TypeError(`gradient stop ${i} opacity must be in 0..1`);
}

function checkExtend(e: [boolean, boolean] | undefined): void {
  if (e === undefined) return;
  if (!Array.isArray(e) || e.length !== 2 || !e.every((v) => typeof v === 'boolean'))
    throw new TypeError('gradient extend must be [boolean, boolean]');
}

/** Validate a gradient completely, throwing TypeError on the first fault.
 *
 *  **Invariant:** this runs to completion before anything is allocated, so a
 *  rejected call leaves the document byte-identical — the same rule
 *  formcreate.ts follows for field creation. */
export function validateGradient(g: Gradient): void {
  if (typeof g !== 'object' || g === null)
    throw new TypeError('gradient must be an object');
  if (g.kind !== 'linear' && g.kind !== 'radial')
    throw new TypeError("gradient kind must be 'linear' or 'radial'");
  if (!Array.isArray(g.stops) || g.stops.length === 0)
    throw new TypeError('gradient stops must be a non-empty array');
  g.stops.forEach(checkStop);
  checkExtend(g.extend);
  if (g.kind === 'linear') {
    checkNum('x1', g.x1); checkNum('y1', g.y1);
    checkNum('x2', g.x2); checkNum('y2', g.y2);
    return;
  }
  checkNum('cx', g.cx); checkNum('cy', g.cy);
  if (checkNum('r', g.r) < 0) throw new TypeError('gradient r must be non-negative');
  if (g.fx !== undefined) checkNum('fx', g.fx);
  if (g.fy !== undefined) checkNum('fy', g.fy);
}

/** A DeviceRGB ShadingType 2 over the gradient's axis. `stops` must already be
 *  normalized — the caller does that, because it also needs them for the
 *  degenerate-case decisions and for the alpha twin. */
export function axialShading(g: LinearGradient, stops: GradientStop[]): PdfDict {
  return dict([
    ['ShadingType', 2],
    ['ColorSpace', name('DeviceRGB')],
    ['Coords', [g.x1, g.y1, g.x2, g.y2]],
    ['Function', stopsFunction(stops)],
    ['Extend', [...(g.extend ?? [true, true])]],
  ]);
}

/** Wrap a shading in a PatternType 2 shading pattern.
 *
 *  No /Matrix: it defaults to identity, and a pattern matrix maps pattern space
 *  to the DEFAULT space of the parent content stream (PDF 32000-1 §8.7.3.1).
 *  Gradient coordinates are already in that space, so any matrix here would
 *  double-transform them. */
export function shadingPattern(shading: PdfDict): PdfDict {
  return dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Shading', shading],
  ]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/gradient.test.ts && npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gradient.ts test/gradient.test.ts
git commit -m "feat(gradient): public gradient types, validation and shading builders

LinearGradient/RadialGradient/Gradient, validateGradient (complete before
any allocation), axialShading and shadingPattern. shadingPattern emits no
/Matrix: pattern space is the parent stream's default space, which is the
space gradient coords are already given in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `registerShadingPattern` page-resource helper

**Files:**
- Modify: `src/pagecontent.ts` (append after `registerExtGState`, around line 94)
- Test: `test/graphics.test.ts` (append a describe block)

**Interfaces:**
- Consumes: from Task 2 — `axialShading`, `shadingPattern`.
- Produces: `registerShadingPattern(doc: Document, page: Page, pattern: PdfDict): string` — the `/Resources /Pattern` key, without the leading slash.

- [ ] **Step 1: Write the failing test**

Append to `test/graphics.test.ts` (the file's existing imports of `Document` and
`buildStampTarget` are reused; add the new imports at the top):

```ts
import { registerShadingPattern } from '../src/pagecontent.js';
import {
  axialShading, shadingPattern, normalizeStops,
  type GradientStop, type LinearGradient,
} from '../src/gradient.js';
import { isDict, isRef, type PdfDict } from '../src/types.js';
```

```ts
describe('registerShadingPattern', () => {
  const STOPS: GradientStop[] = [
    { offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] },
  ];
  const LINEAR: LinearGradient = { kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: STOPS };
  const pattern = () => shadingPattern(axialShading(LINEAR, normalizeStops(STOPS)));

  /** Resolve `key` in `d` and assert it is a dict. */
  function subDict(doc: Document, d: PdfDict, key: string): PdfDict {
    const v = doc.resolve(d.get(key));
    if (!isDict(v)) throw new Error(`/${key} is not a dict`);
    return v;
  }

  /** The page's own /Resources. */
  function resources(doc: Document): PdfDict {
    const r = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(r)) throw new Error('page has no /Resources dict');
    return r;
  }

  it('registers the pattern under the page /Resources /Pattern and returns its key', () => {
    const doc = Document.Open(buildStampTarget());
    const key = registerShadingPattern(doc, doc.Pages[0], pattern());
    expect(key).toBe('P0');

    const pat = subDict(doc, resources(doc), 'Pattern');
    expect(isRef(pat.get('P0'))).toBe(true);       // allocated as an indirect object
    expect(subDict(doc, pat, 'P0').get('PatternType')).toBe(2);
  });

  it('allocates a fresh key per call rather than deduplicating', () => {
    const doc = Document.Open(buildStampTarget());
    expect(registerShadingPattern(doc, doc.Pages[0], pattern())).toBe('P0');
    expect(registerShadingPattern(doc, doc.Pages[0], pattern())).toBe('P1');
  });

  it('does not disturb an existing resource sub-dict', () => {
    const doc = Document.Open(buildStampTarget());
    registerShadingPattern(doc, doc.Pages[0], pattern());
    // buildStampTarget's page has a /Font /F0 the existing content depends on.
    expect(subDict(doc, resources(doc), 'Font').has('F0')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`
Expected: FAIL — `registerShadingPattern` is not exported from `pagecontent.js`.

- [ ] **Step 3: Write the implementation**

Append to `src/pagecontent.ts`, directly after `registerExtGState`:

```ts
/** Register `pattern` under the page's /Resources /Pattern and return its
 *  resource key (for `/Pattern cs` + `/<key> scn`).
 *
 *  Unlike registerExtGState beside it, this does NOT deduplicate: it allocates a
 *  fresh key per call. A shading pattern nests three dicts deep, and svgdraw.ts
 *  reaches the same conclusion — a field-by-field compare would cost more than
 *  the duplication. Optimize()'s content-hashed dedup is the general answer. */
export function registerShadingPattern(doc: Document, page: Page, pattern: PdfDict): string {
  const res = ensureOwnResources(doc, page);
  const pat = ensureOwnSubdict(doc, res, 'Pattern');
  const key = freshKey(pat, 'P');
  pat.set(key, doc.allocObject(pattern));
  return key;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/graphics.test.ts && npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pagecontent.ts test/graphics.test.ts
git commit -m "feat(pagecontent): registerShadingPattern page-resource helper

Mirrors registerExtGState, but allocates a fresh key per call instead of
deduplicating: a shading pattern nests three dicts deep, so a structural
compare would cost more than the duplication.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `PageGraphics.setFillGradient`

**Files:**
- Modify: `src/graphics.ts` (imports; new method after `setFillColor`, line 57)
- Modify: `src/index.ts` (public type exports, near line 95)
- Modify: `README.md` (feature bullet line 17; "Vector drawing" section ~line 549; API table line 1374)
- Test: `test/graphics.test.ts` (append a describe block)

**Interfaces:**
- Consumes: from Task 2 — `validateGradient`, `normalizeStops`, `uniformOpacity`, `stopOpacity`, `axialShading`, `shadingPattern`, `Gradient`, `LinearGradient`, `GradientStop`. From Task 3 — `registerShadingPattern`.
- Produces: `PageGraphics.setFillGradient(g: Gradient): this`.

- [ ] **Step 1: Write the failing test**

Append to `test/graphics.test.ts`. Add `UnsupportedFeatureError` to the imports:

```ts
import { UnsupportedFeatureError } from '../src/errors.js';
```

```ts
describe('PageGraphics.setFillGradient', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];
  const ramp = (): GradientStop[] => [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  /** The page's /Resources /Pattern sub-dict, or undefined when none was made. */
  function patterns(doc: Document): PdfDict | undefined {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(res)) return undefined;
    const p = doc.resolve(res.get('Pattern'));
    return isDict(p) ? p : undefined;
  }

  it('selects a registered shading pattern as the fill colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: ramp() })
     .rect(10, 10, 100, 50).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('/Pattern cs');
    expect(text).toContain('/P0 scn');

    const pat = patterns(doc);
    expect(pat).toBeDefined();
    const d = doc.resolve(pat!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.get('PatternType')).toBe(2);
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('collapses a single-stop gradient to a solid fill and allocates no pattern', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED }] });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    expect(pageContentText(doc)).toContain('1 0 0 rg');
    expect(pageContentText(doc)).not.toContain('/Pattern cs');
    expect(patterns(doc)).toBeUndefined();
  });

  it('collapses a zero-length axis to the last stop colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 50, y1: 50, x2: 50, y2: 50, stops: ramp() });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    expect(pageContentText(doc)).toContain('0 0 1 rg');     // BLUE, the last stop
    expect(patterns(doc)).toBeUndefined();
  });

  it('folds a uniform stop alpha into an /ExtGState', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                { offset: 1, color: BLUE, opacity: 0.5 }] });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toMatch(/\/GS\d+ gs/);
    expect(text).toContain('/Pattern cs');
  });

  it('rejects varying stop alpha as unsupported, allocating nothing', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setFillGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects a radial gradient as not yet painted, allocating nothing', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setFillGradient({ kind: 'radial', cx: 50, cy: 50, r: 25, stops: ramp() }))
      .toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('leaves the document byte-identical when validation rejects', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setFillGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [],
    })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });
});
```

Add `GradientStop` to the test file's imports from `../src/gradient.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`
Expected: FAIL — `setFillGradient` is not a function on `PageGraphics`.

- [ ] **Step 3: Write the implementation**

In `src/graphics.ts`, extend the imports:

```ts
import { num, appendContent, registerExtGState, registerOcProperty,
         registerShadingPattern } from './pagecontent.js';
import {
  validateGradient, normalizeStops, uniformOpacity, stopOpacity,
  axialShading, shadingPattern, type Gradient,
} from './gradient.js';
import { UnsupportedFeatureError } from './errors.js';
```

Add the method directly after `setFillColor`:

```ts
  /** Fill subsequent paths with an axial gradient. Symmetric with
   *  {@link setFillColor}: this sets the fill paint, and the next `fill()` /
   *  `fillEvenOdd()` / `fillStroke()` uses it.
   *
   *  **Invariant:** gradient coordinates are in the page's DEFAULT user space
   *  and ignore the CTM. A pattern /Matrix maps pattern space to the default
   *  space of the parent content stream (PDF 32000-1 §8.7.3.1), not to the CTM
   *  in force when the pattern is selected — so a `transform()` earlier in this
   *  builder moves the path and not the ramp. The upside is that apply()'s q/Q
   *  wrapping and appendContent's stream nesting can never shift a gradient.
   *
   *  A gradient with fewer than two stops, or a zero-length axis, collapses to a
   *  solid `setFillColor` and allocates no pattern. A uniform stop opacity folds
   *  into an /ExtGState — which sets both `ca` and `CA`, so it OVERRIDES any
   *  earlier {@link setOpacity} rather than multiplying with it.
   *
   *  Throws UnsupportedFeatureError for a radial gradient (issue lqp5.2) or
   *  stops carrying differing opacity (issue lqp5.4). */
  setFillGradient(g: Gradient): this {
    validateGradient(g);
    if (g.kind === 'radial')
      throw new UnsupportedFeatureError(
        'radial gradient fills are not supported yet; use kind: "linear"');

    // Degenerate cases collapse to a solid, matching svggradient.ts's rules.
    // Each paints ONE stop, so it takes that stop's own opacity: using the
    // gradient-wide alpha here would paint a varying ramp's degenerate case
    // fully opaque.
    const solid = g.stops.length < 2 || (g.x1 === g.x2 && g.y1 === g.y2);
    if (solid) {
      const s = g.stops[g.stops.length - 1];
      const a = stopOpacity(s);
      if (a < 1) this.setOpacity(a);
      return this.setFillColor(s.color);
    }

    const stops = normalizeStops(g.stops);
    const alpha = uniformOpacity(stops);
    // Thrown BEFORE registering, so a rejected call allocates nothing.
    if (alpha === null)
      throw new UnsupportedFeatureError(
        'gradient stops with differing opacity are not supported yet; ' +
        'use a uniform stop opacity or setOpacity()');

    const key = registerShadingPattern(
      this.doc, this.page, shadingPattern(axialShading(g, stops)));
    if (alpha < 1) this.setOpacity(alpha);
    return this.op(`/Pattern cs /${escapeName(key)} scn`);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/graphics.test.ts && npm run typecheck`
Expected: both PASS.

- [ ] **Step 5: Export the public types**

In `src/index.ts`, beside the existing `export { PageGraphics } from './graphics.js';` (line 95), add:

```ts
export type { GradientStop, LinearGradient, RadialGradient, Gradient } from './gradient.js';
```

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Update the README**

Three edits, per CLAUDE.md's rule that the README stays in sync with public API.

In the feature bullet on line 17, replace `(color, line width/cap/join/dash, constant opacity)` with:

```
(color, axial gradient fill, line width/cap/join/dash, constant opacity)
```

In the "Vector drawing" section, after the existing code block and its
"Operators buffer in memory…" paragraph, add:

````markdown
`setFillGradient` fills with an axial (linear) `ShadingType 2` ramp:

```ts
g.setFillGradient({
  kind: 'linear',
  x1: 50, y1: 0, x2: 250, y2: 0,          // page user space
  stops: [
    { offset: 0, color: [1, 0, 0] },
    { offset: 1, color: [0, 0, 1] },
  ],
});
g.rect(50, 500, 200, 100).fill();
```

Gradient coordinates are in the page's **default** user space and are not
affected by `transform()` — a PDF pattern matrix is relative to the content
stream's default space, not the CTM. `extend` (default `[true, true]`) pads the
ramp beyond its endpoints, and a uniform stop `opacity` folds into the graphics
state. A gradient with one stop, or a zero-length axis, is drawn as a solid
fill. Radial gradients and stops with *differing* opacity are not supported yet
and throw `UnsupportedFeatureError`.
````

In the API table, replace the `page.Graphics()` row (line 1374) with:

```
| `page.Graphics()` | Buffered `PageGraphics` builder for vector drawing (solid or axial-gradient fills) |
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/graphics.ts src/index.ts test/graphics.test.ts README.md
git commit -m "feat(graphics): axial gradient fills via setFillGradient

Sets a PatternType 2 shading pattern as the fill paint, symmetric with
setFillColor. Coordinates are page default user space and ignore the CTM,
which is inherent to pattern /Matrix semantics and is documented on the
method. One stop or a zero-length axis collapses to a solid; uniform stop
alpha folds into an /ExtGState; radial (lqp5.2) and varying alpha (lqp5.4)
throw UnsupportedFeatureError.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end render proof and mutation check

The unit tests assert on dicts we built ourselves. This task asserts against the
**rasterizer**, an independently written reader of shadings — the only test in
the plan that proves the whole chain, and the one that catches a wrong
`/Coords`, a missing registration, or a spurious `/Matrix`.

**Files:**
- Test: `test/graphics-gradient-render.test.ts` (create)

**Interfaces:**
- Consumes: from Task 4 — `PageGraphics.setFillGradient`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Create `test/graphics-gradient-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PageGraphics } from '../src/graphics.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 14) => Math.abs(v - target) <= tol;

/** Draw on a blank 200x200 page, save, reopen, rasterize at 1 px per point — so
 *  a device pixel (x, y) is user (x, 200 - y).
 *
 *  raster.ts is an independently written READER of shading patterns, so these
 *  assertions are not a round trip through one body of code. */
function render(draw: (g: PageGraphics) => void) {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
  const g = doc.Pages[0].Graphics();
  draw(g);
  g.apply();
  const rt = Document.Open(doc.Save());
  return decodePng(rt.Pages[0].ToImage());
}

const RED: [number, number, number] = [1, 0, 0];
const BLUE: [number, number, number] = [0, 0, 1];

describe('setFillGradient through Save/Open/ToImage', () => {
  it('ramps red → blue left to right across the filled rect', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [lr, , lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);
    expect(lb).toBeLessThan(45);
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    const [cr, cg, cb] = png.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('runs a vertical gradient the right way up', () => {
    // y increases UPWARD in user space, so y1=0 is the BOTTOM of the page,
    // which is the bottom row of device pixels.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 0, y2: 200,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });
    expect(png.at(100, 196)[0]).toBeGreaterThan(215);   // bottom is red
    expect(png.at(100, 4)[2]).toBeGreaterThan(215);     // top is blue
  });

  it('extends the ramp past its endpoints by default', () => {
    // The axis spans only the middle 100pt; /Extend [true true] pads the rest.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 50, y1: 0, x2: 150, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });
    expect(png.at(10, 100)[0]).toBeGreaterThan(215);    // padded red
    expect(png.at(190, 100)[2]).toBeGreaterThan(215);   // padded blue
  });

  it('applies the CTM to the path but not to the gradient', () => {
    // The invariant from the spec, made visible. Under a 2x scale the rect
    // covers x=0..200 in device space, but the ramp still spans x=0..200 in
    // DEFAULT space — so the midpoint of the painted area is the ramp midpoint.
    const png = render((g) => {
      g.transform(2, 0, 0, 2, 0, 0);
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 100, 100).fill();
    });
    // Path scaled to 200x200 device: the far edge is painted at all.
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    // And the ramp was NOT scaled with it: x=100 is still the midpoint.
    const [cr, , cb] = png.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('paints a uniform stop alpha as constant transparency', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                { offset: 1, color: RED, opacity: 0.5 }],
      }).rect(0, 0, 200, 200).fill();
    });
    // Half-strength red over a white page: r stays high, g and b lift to ~128.
    const [r, gg, b] = png.at(100, 100);
    expect(r).toBeGreaterThan(215);
    expect(near(gg, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/graphics-gradient-render.test.ts`
Expected: PASS, since Task 4 shipped the feature.

**If any case fails, that is a real defect in Task 4, not a test to relax.**
The likely causes, in order: a `/Matrix` emitted on the pattern (would break the
CTM case), swapped `/Coords`, or `/Extend` not defaulting to `[true, true]`.

- [ ] **Step 3: Mutation check — prove the assertions are load-bearing**

CLAUDE.md: a fixture usually passes on the first run, and that is not evidence.
Break each path in turn, confirm RED, then revert. Run
`npx vitest run test/graphics-gradient-render.test.ts test/graphics.test.ts test/gradient.test.ts`
after each.

| # | Mutation | Must fail |
|---|---|---|
| 1 | In `axialShading`, swap `/Coords` to `[g.x2, g.y2, g.x1, g.y1]` | the red→blue and vertical render cases |
| 2 | In `axialShading`, hard-code `['Extend', [false, false]]` | the extend render case |
| 3 | In `shadingPattern`, add `['Matrix', [2, 0, 0, 2, 0, 0]]` | the CTM render case |
| 4 | In `stopsFunction`, drop the `if (!(stops[i+1].offset > stops[i].offset)) continue;` guard | the zero-width-interval unit test |
| 5 | In `setFillGradient`, skip `registerShadingPattern` and emit `/P0 scn` against no resource | the graphics.test.ts pattern-resource case |
| 6 | In `setFillGradient`, drop the `alpha === null` throw | the varying-alpha case |

Each mutation must produce a RED run. **A mutation that stays green means the
path is untested** — add the missing assertion before moving on, and say so.

- [ ] **Step 4: Confirm every mutation is reverted**

Run: `git diff --stat`
Expected: only `test/graphics-gradient-render.test.ts` is new; no `src/` changes.

Then run: `npm test && npm run typecheck`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add test/graphics-gradient-render.test.ts
git commit -m "test(graphics): render gradient fills through Save/Open/ToImage

Asserts against raster.ts, an independently written reader of shading
patterns, so the chain is not validated through the code that built it.
Covers the ramp direction, the y-axis orientation, /Extend padding, the
uniform-alpha fold, and the invariant that the CTM moves the path but not
the ramp. Mutation-checked: six deliberate breaks each go red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Closing out

- [ ] Run `npm test && npm run typecheck` one final time; both must be green.
- [ ] `bd close aspose-pdf-foss-for-ts-lqp5.1`
- [ ] Confirm `bd ready` now lists `lqp5.2` (radial) and `lqp5.4` (soft mask) as unblocked.
- [ ] `git pull --rebase && git push && git status` — per CLAUDE.md, work is not complete until the push succeeds.

## Self-review notes

Spec coverage checked section by section: module boundaries (Tasks 1, 3, 4),
public types (Task 2), `setFillGradient` steps 1-4 (Task 4), the fresh-key
registration decision (Task 3), the CTM invariant (Task 4 doc comment + Task 5
render case), the alpha table (Task 4, all three rows), the deferred soft mask
(`UnsupportedFeatureError` in Task 4, issue `lqp5.4` already filed), and the four
testing requirements (Tasks 1, 2, 4, 5 plus the mutation table).

`RadialGradient` is declared in Task 2 and rejected at the paint site in Task 4 —
deliberate, so `lqp5.2` adds no public type churn.
