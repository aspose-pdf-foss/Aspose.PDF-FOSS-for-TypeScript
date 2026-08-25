# Tiling-Pattern Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller author a `PatternType 1` tiling pattern — `doc.NewTilingPattern(w, h, draw, opts?)` plus `setFillPattern`/`setStrokePattern` on the vector builder — closing the gap against a format this library already imports, renders and optimizes.

**Architecture:** A pure leaf `src/tiling.ts` owns the model (validation, the `/Matrix` composition, the pattern dict), exactly as `gradient.ts` does for colour stops. `pagecontent.ts` gains resource-target variants of its four `register*` helpers so a tile's registrations land in the tile's own `/Resources`. `graphics.ts` splits into a `VectorGraphics` base plus the page-bound `PageGraphics`, so a tile callback holds a builder with no `apply()` at all.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-20-tiling-pattern-authoring-design.md` — read it before Task 1 and keep it open; this plan argues from it.

**Issue:** `aspose-pdf-foss-for-ts-lucg.2` (beads). Claim it with `bd update aspose-pdf-foss-for-ts-lucg.2 --claim` before Task 1.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { patternMatrix } from './tiling.js'`.
- **`src/tiling.ts` touches no `Document` and no `Page`.** It may import from `types.js` and `text.js` only — the exact latitude `gradient.ts` takes (`import { name, type PdfDict, type PdfObject } from './types.js'`). It builds DIRECT `PdfDict`s and allocates nothing.
- **`PageGraphics`'s public surface must not change.** Every existing caller compiles untouched; `npm run typecheck` is the gate.
- **`rotation` is in degrees, counter-clockwise** — matching `stamp.ts` and `decorate.ts`. `arc()`'s radians is the deliberate counter-example.
- **Validation precedes allocation**, so a rejected call leaves the document byte-identical.
- **Errors are `TypeError` for argument validation**, thrown before anything is constructed.
- **`test/graphics-identity.test.ts` (created in Task 1) is a fence, not a golden.** If it moves after Task 1, the refactor changed a resource key or an allocation order — find out why rather than re-recording the hash.
- **Run before closing:** `npm run typecheck` and `npm test`, both green.
- **Commit style:** `feat(lucg.2): <subject>` / `test(lucg.2): …` / `docs(lucg.2): …`, ending with a `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Deviation from the spec, decided while planning

The spec says `pagecontent.ts`'s four `register*` helpers "take a resources `PdfDict` rather than a `Page`". Measured during planning: **`registerExtGState` has eight callers outside `graphics.ts`** — `stamp.ts` (5), `imageembed.ts` (2), `compose.ts`, `decorate.ts` and `barcodeplace.ts` (via `registerOcProperty`). Changing the signatures in place would churn six unrelated files for no behavioural reason.

So instead: **add `*In` variants that take the resources dict, and reduce each existing page-taking function to a one-line wrapper over its variant.** This preserves the spec's intent exactly — one owner for each registration, with the target redirectable — while leaving all eight external call sites untouched and making byte-identity true *by construction* rather than by inspection.

`registerSoftMaskExtGState` is the one that needs more than a target: it reads `page.MediaBox` for the mask `/BBox`. Its variant takes that box as a parameter, and the page wrapper passes `page.MediaBox`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `test/graphics-identity.test.ts` | **create (Task 1)** | The byte fence over `graphics.ts` + `pagecontent.ts` output. Written before anything moves. |
| `src/pagecontent.ts` | modify | Four `*In` variants taking a resources dict; the page-taking functions become wrappers. Plus `registerPatternRefIn` for an already-allocated pattern. |
| `src/tiling.ts` | **create** | Pure: `TilingPatternOptions`, the handle types, validation, `patternMatrix`, `tilingPatternDict`. |
| `test/tiling.test.ts` | **create** | The whole leaf from numbers. No PDF anywhere. |
| `src/graphics.ts` | modify | `VectorGraphics` base + `PageGraphics extends` it; `TileGraphics`; `buildTilingPattern`; `setFillPattern`/`setStrokePattern`. |
| `src/document.ts` | modify | `NewTilingPattern` overloads delegating to `buildTilingPattern`. |
| `test/tiling-pattern.test.ts` | **create** | End to end: operators, resource targeting, cross-page reuse, refusals, a pixel probe. |
| `src/index.ts` | modify | Export `VectorGraphics`, `TilingPattern`, `ColoredTilingPattern`, `UncoloredTilingPattern`, `TilingPatternOptions`. |
| `README.md` | modify | Tiling section under Vector graphics, plus the API-table row. |
| `CHANGELOG.md` | modify | One `### Added` entry under `## [Unreleased]`. |

---

## Task 1: The byte-identity fence

**Files:**
- Create: `test/graphics-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code. Every later task re-runs this file.

This task exists because **nothing currently checks `graphics.ts`'s emitted bytes.** `test/graphics.test.ts` and `test/gradient.test.ts` assert behaviour; every `createHash` fence in the suite covers tables, DOCX, rich runs, HTML or signing. Task 2's whole claim is "byte-identical for existing callers", and without this it is unverifiable.

- [ ] **Step 1: Write the fence with a placeholder hash**

Create `test/graphics-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { PageGraphics } from '../src/graphics.js';

/** A REGRESSION FENCE for lucg.2's resource-target refactor, not a feature
 *  test. `pagecontent.ts`'s four register* helpers move behind variants that
 *  take a resources dict instead of a Page, and `PageGraphics` splits into a
 *  base plus a page-bound subclass. Both are claimed byte-identical for
 *  existing callers, and before this file NOTHING in the suite checked that:
 *  test/graphics.test.ts and test/gradient.test.ts assert behaviour, and every
 *  other createHash fence covers tables, DOCX, rich runs, HTML or signing.
 *
 *  It exercises all four registration paths deliberately:
 *    setOpacity           -> registerExtGState        (/ExtGState)
 *    a varying-alpha ramp -> registerShadingPattern   (/Pattern)
 *                          + registerSoftMaskExtGState (/ExtGState with /SMask)
 *    BeginLayer           -> registerOcProperty       (/Properties)
 *
 *  The hash was recorded BEFORE the refactor. If it changes, the refactor moved
 *  a resource key or an allocation order: find out why rather than re-recording.
 */
const build = (): Document => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const layer = doc.OptionalContent.AddLayer('Fence');
  const g = new PageGraphics(doc, page);

  // /ExtGState via setOpacity.
  g.save().setOpacity(0.4).setFillColor([1, 0, 0]).drawRect(20, 700, 60, 40).fill().restore();

  // /Pattern + a soft-mask /ExtGState: stop alphas DIFFER, so the ramp cannot
  // fold into a single ca/CA and takes the luminosity-mask path.
  g.save().setFillGradient({
    kind: 'linear', x1: 20, y1: 600, x2: 200, y2: 600,
    stops: [
      { offset: 0, color: [0, 0, 1], opacity: 1 },
      { offset: 1, color: [0, 1, 0], opacity: 0.2 },
    ],
  }).drawRect(20, 580, 180, 40).fill().restore();

  // A uniform-alpha ramp: the OTHER gradient path, folding into one ca.
  g.save().setStrokeGradient({
    kind: 'radial', cx: 300, cy: 500, r: 50,
    stops: [
      { offset: 0, color: [1, 1, 0], opacity: 0.5 },
      { offset: 1, color: [1, 0, 1], opacity: 0.5 },
    ],
  }).setLineWidth(3).circle(300, 500, 40).stroke().restore();

  // /Properties via BeginLayer.
  g.BeginLayer(layer).setFillColor([0, 0, 0]).drawRect(20, 400, 30, 30).fill().EndLayer();

  g.apply();
  return doc;
};

const sha = (doc: Document): string =>
  createHash('sha256').update(doc.Save()).digest('hex').slice(0, 16);

describe('PageGraphics resource registration', () => {
  it('emits unchanged bytes across the resource-target refactor', () => {
    expect(sha(build())).toBe('RECORD_ME');
  });
});
```

- [ ] **Step 2: Run it to learn the real hash**

Run: `npx vitest run test/graphics-identity.test.ts`

Expected: FAIL, with a message of the form `expected 'abcd1234abcd1234' to be 'RECORD_ME'`. **Copy the actual 16-character hash from that message.**

If instead it fails to construct the document, the fixture is wrong — fix the fixture, not the assertion. (`Gradient`'s exact field names are in `src/gradient.ts`; `LinearGradient` uses `x1/y1/x2/y2` and `RadialGradient` uses `cx/cy/r`.)

- [ ] **Step 3: Record the hash**

Replace `'RECORD_ME'` with the hash from Step 2.

- [ ] **Step 4: Verify it passes, and that it is stable**

Run: `npx vitest run test/graphics-identity.test.ts` — twice.

Expected: PASS both times. If the two runs disagree, `Save()` is emitting something non-deterministic for this fixture and the fence is worthless — stop and report rather than continuing.

- [ ] **Step 5: Prove the fence is load-bearing**

In `src/graphics.ts`, change `setOpacity`'s emitted operator from `` `/${key} gs` `` to `` `/${key} gs ` `` (a trailing space). Run the file: it must FAIL. Restore, and confirm it passes again.

Expected: the fence detects a one-byte change. A fence that cannot is not a fence.

- [ ] **Step 6: Commit**

```bash
git add test/graphics-identity.test.ts
git commit -m "test(lucg.2): a byte fence over PageGraphics resource registration

Recorded from main BEFORE the resource-target refactor. Nothing in the suite
checked graphics.ts's emitted bytes: test/graphics.test.ts and gradient.test.ts
assert behaviour, and every other createHash fence covers tables, DOCX, rich
runs, HTML or signing. The refactor's central claim is byte-identity, so the
check comes first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Resource-target variants in `pagecontent.ts`

**Files:**
- Modify: `src/pagecontent.ts`
- Test: `test/graphics-identity.test.ts` (run only — do not edit)

**Interfaces:**
- Consumes: `ensureOwnResources`, `ensureOwnSubdict`, `freshKey` (already in the file).
- Produces:
  ```ts
  export function registerExtGStateIn(
    doc: Document, resources: PdfDict, opacity: number, channel?: AlphaChannel,
  ): string;
  export function registerSoftMaskExtGStateIn(
    doc: Document, resources: PdfDict, alphaPattern: PdfDict, matrix: Matrix,
    bbox: [number, number, number, number],
  ): string;
  export function registerShadingPatternIn(
    doc: Document, resources: PdfDict, pattern: PdfDict,
  ): string;
  export function registerOcPropertyIn(
    doc: Document, resources: PdfDict, ocg: PdfRef,
  ): string;
  export function registerPatternRefIn(
    doc: Document, resources: PdfDict, ref: PdfRef,
  ): string;
  ```
  The existing `registerExtGState` / `registerSoftMaskExtGState` / `registerShadingPattern` / `registerOcProperty` keep their exact signatures and become one-line wrappers. Task 4 calls the `*In` forms; Task 6 calls `registerPatternRefIn`.

- [ ] **Step 1: Write the failing test**

Append to `test/graphics.test.ts`:

```ts
describe('resource-target register* variants', () => {
  it('registers into the dict it is given, not the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const detached: PdfDict = new Map();
    const key = registerExtGStateIn(doc, detached, 0.5);

    // The entry landed in the detached dict...
    const gs = doc.resolve(detached.get('ExtGState'));
    expect(isDict(gs)).toBe(true);
    expect((gs as PdfDict).has(key)).toBe(true);
    // ...and the page's own resources gained no ExtGState at all.
    const pageRes = doc.resolve(page.Dict.get('Resources'));
    const pageGs = isDict(pageRes) ? doc.resolve((pageRes as PdfDict).get('ExtGState')) : undefined;
    expect(isDict(pageGs) && (pageGs as PdfDict).has(key)).toBe(false);
  });

  it('gives the page wrapper and the variant the same key', () => {
    // The wrapper is the variant applied to ensureOwnResources, so a page
    // caller cannot tell the refactor happened.
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(registerExtGState(doc, page, 0.5)).toBe('GS0');
    expect(registerExtGStateIn(doc, ensureOwnResources(doc, page), 0.5)).toBe('GS0');
  });

  it('reuses an existing key for the same pattern ref', () => {
    // Cross-page reuse of one tiling pattern depends on this, and so does
    // using the same pattern twice on one page.
    const doc = Document.Open(buildBlankPage());
    const res: PdfDict = new Map();
    const ref = doc.allocObject(new Map<string, PdfObject>([['PatternType', 1]]));
    const a = registerPatternRefIn(doc, res, ref);
    const b = registerPatternRefIn(doc, res, ref);
    expect(b).toBe(a);
    const pat = doc.resolve(res.get('Pattern')) as PdfDict;
    expect([...pat.keys()]).toEqual([a]);
  });
});
```

Extend that file's existing import from `../src/pagecontent.js` to include
`registerExtGStateIn`, `registerPatternRefIn` and `ensureOwnResources`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`

Expected: FAIL — `registerExtGStateIn` is not exported by `../src/pagecontent.js`.

- [ ] **Step 3: Convert the four helpers**

In `src/pagecontent.ts`, rename each existing function body to its `*In` form
taking `resources: PdfDict` in place of `page: Page`, replacing the
`const res = ensureOwnResources(doc, page);` line with a direct use of
`resources`. Then add the wrapper beneath each. For `registerExtGState`:

```ts
export function registerExtGStateIn(
  doc: Document, resources: PdfDict, opacity: number, channel: AlphaChannel = 'both',
): string {
  const wantCa = channel === 'stroke' ? undefined : opacity;
  const wantCA = channel === 'fill' ? undefined : opacity;
  const gs = ensureOwnSubdict(doc, resources, 'ExtGState');
  // ... the existing body verbatim from here down ...
}

/** The page-targeted form: {@link registerExtGStateIn} against the page's own
 *  /Resources. Every stamping caller uses this one. */
export function registerExtGState(
  doc: Document, page: Page, opacity: number, channel: AlphaChannel = 'both',
): string {
  return registerExtGStateIn(doc, ensureOwnResources(doc, page), opacity, channel);
}
```

Apply the identical shape to `registerShadingPattern` and `registerOcProperty`.
Keep every existing doc comment on the `*In` form — it is the one that carries
the behaviour — and give each wrapper the two-line comment above.

`registerSoftMaskExtGState` additionally takes the mask box:

```ts
export function registerSoftMaskExtGStateIn(
  doc: Document, resources: PdfDict, alphaPattern: PdfDict, matrix: Matrix,
  bbox: [number, number, number, number],
): string {
  const [x0, y0, x1, y1] = bbox;
  // ... existing body, using x0/y0/x1/y1 and `resources` ...
}

/** The page-targeted form, with the mask /BBox taken from the page's MediaBox.
 *  See {@link registerSoftMaskExtGStateIn} for why that box is the right one
 *  for a PageGraphics caller, which tracks no paths. */
export function registerSoftMaskExtGState(
  doc: Document, page: Page, alphaPattern: PdfDict, matrix: Matrix,
): string {
  const [a, b, c, d] = page.MediaBox;
  return registerSoftMaskExtGStateIn(doc, ensureOwnResources(doc, page), alphaPattern, matrix, [
    Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d),
  ]);
}
```

Note the normalization (`Math.min`/`Math.max`) moves into the wrapper: the
variant receives an already-normalized box, since a caller passing a tile's
`[0, 0, w, h]` has nothing to normalize.

- [ ] **Step 4: Add `registerPatternRefIn`**

```ts
/** Register (or reuse) an already-allocated pattern object under `resources`
 *  /Pattern and return its key (for `/Pattern cs` + `/<key> scn`).
 *
 *  Unlike {@link registerShadingPatternIn}, which allocates from a dict, this
 *  takes a ref that already exists — a tiling pattern is created once on the
 *  Document and used on many pages. Reusing an existing key that maps to the
 *  same ref is what makes that cheap, and mirrors registerOcPropertyIn, which
 *  reuses for the same reason. */
export function registerPatternRefIn(
  doc: Document, resources: PdfDict, ref: PdfRef,
): string {
  const pat = ensureOwnSubdict(doc, resources, 'Pattern');
  for (const [k, v] of pat) {
    if (isRef(v) && v.num === ref.num && v.gen === ref.gen) return k;
  }
  const key = freshKey(pat, 'P');
  pat.set(key, ref);
  return key;
}
```

Ensure `isRef` and `PdfRef` are imported in `pagecontent.ts` (`registerOcProperty` already uses `isRef`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/graphics.test.ts test/gradient.test.ts test/graphics-gradient-render.test.ts`

Expected: PASS.

- [ ] **Step 6: Check the fence**

Run: `npx vitest run test/graphics-identity.test.ts`

Expected: PASS, hash unchanged. **If it fails, stop.** The wrappers are meant to be byte-identical by construction; a failure means a key or an allocation order moved.

- [ ] **Step 7: Verify the eight external callers never moved**

Run: `git diff --stat src/`

Expected: `src/pagecontent.ts` is the ONLY file changed. `stamp.ts`, `imageembed.ts`, `compose.ts`, `decorate.ts` and `barcodeplace.ts` must show no diff — that is the whole point of the wrapper shape.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
npx vitest run test/stamp.test.ts test/decorate.test.ts test/compose.test.ts test/barcode.test.ts
git add src/pagecontent.ts test/graphics.test.ts
git commit -m "feat(lucg.2): resource-target variants for the register* helpers

Each register* helper's body moves to an *In form taking the resources dict,
and the page-taking function becomes a one-line wrapper over it. Byte-identity
is then true by construction rather than by inspection, and the eight callers
in stamp.ts, imageembed.ts, compose.ts, decorate.ts and barcodeplace.ts are
untouched.

registerPatternRefIn is new: a tiling pattern is allocated once on the Document
and reused across pages, so it registers a ref rather than allocating a dict.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The pure `tiling.ts` leaf

**Files:**
- Create: `src/tiling.ts`
- Test: `test/tiling.test.ts`

**Interfaces:**
- Consumes: `name`, `PdfDict`, `PdfObject`, `PdfRef` from `types.js`; `mul`, `Matrix` from `text.js`.
- Produces:
  ```ts
  export interface TilingPatternOptions {
    xStep?: number; yStep?: number;
    x?: number; y?: number; rotation?: number;
    uncolored?: boolean;
  }
  export interface ColoredTilingPattern { readonly ref: PdfRef; readonly paintType: 1 }
  export interface UncoloredTilingPattern { readonly ref: PdfRef; readonly paintType: 2 }
  export type TilingPattern = ColoredTilingPattern | UncoloredTilingPattern;
  export interface ResolvedTiling {
    width: number; height: number;
    xStep: number; yStep: number;
    matrix: Matrix; uncolored: boolean;
  }
  export function patternMatrix(x: number, y: number, rotationDeg: number): Matrix;
  export function resolveTiling(
    width: number, height: number, opts: TilingPatternOptions,
  ): ResolvedTiling;
  export function tilingPatternDict(r: ResolvedTiling, resources: PdfDict): PdfDict;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/tiling.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { patternMatrix, resolveTiling, tilingPatternDict } from '../src/tiling.js';
import { isName, type PdfDict } from '../src/types.js';

describe('patternMatrix', () => {
  it('is the identity with no placement', () => {
    // What makes the option provably free for a caller who ignores it.
    expect(patternMatrix(0, 0, 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('carries x alone', () => {
    expect(patternMatrix(7, 0, 0)).toEqual([1, 0, 0, 1, 7, 0]);
  });

  it('carries y alone', () => {
    // One vector at a time: a single combined case cannot tell an x/y
    // transposition from a correct build, the same trap CLAUDE.md records for
    // the JBIG2 halftone grid's cross terms.
    expect(patternMatrix(0, 7, 0)).toEqual([1, 0, 0, 1, 0, 7]);
  });

  it('carries rotation alone, counter-clockwise in degrees', () => {
    const m = patternMatrix(0, 0, 90);
    // 90 deg CCW takes +x to +y: [a b c d] = [0 1 -1 0].
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[1]).toBeCloseTo(1, 12);
    expect(m[2]).toBeCloseTo(-1, 12);
    expect(m[3]).toBeCloseTo(0, 12);
    expect(m[4]).toBeCloseTo(0, 12);
    expect(m[5]).toBeCloseTo(0, 12);
  });

  it('rotates about the origin and THEN translates', () => {
    // The composition order is the thing that reads as plausible when wrong:
    // translate-then-rotate spins the offset too, putting the lattice
    // somewhere entirely different while still looking like a rotated hatch.
    const m = patternMatrix(10, 0, 90);
    expect(m[4]).toBeCloseTo(10, 12);
    expect(m[5]).toBeCloseTo(0, 12);
  });
});

describe('resolveTiling', () => {
  it('defaults each step to the tile size', () => {
    const r = resolveTiling(20, 30, {});
    expect(r.xStep).toBe(20);
    expect(r.yStep).toBe(30);
    expect(r.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(r.uncolored).toBe(false);
  });

  it('takes an explicit step that differs from the tile size', () => {
    // Larger than the tile leaves gaps; smaller makes cells overlap.
    const r = resolveTiling(20, 20, { xStep: 30, yStep: 10 });
    expect(r.xStep).toBe(30);
    expect(r.yStep).toBe(10);
  });

  it('rejects a non-positive size, and accepts the adjacent legal value', () => {
    expect(() => resolveTiling(0, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(-1, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(10, 0, {})).toThrow(TypeError);
    expect(() => resolveTiling(Number.NaN, 10, {})).toThrow(TypeError);
    expect(() => resolveTiling(0.5, 0.5, {})).not.toThrow();
  });

  it('rejects a non-positive step, and accepts the adjacent legal value', () => {
    expect(() => resolveTiling(10, 10, { xStep: 0 })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { yStep: -5 })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { xStep: 0.5, yStep: 0.5 })).not.toThrow();
  });

  it('rejects a non-finite placement', () => {
    expect(() => resolveTiling(10, 10, { x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => resolveTiling(10, 10, { rotation: Number.NaN })).toThrow(TypeError);
  });
});

describe('tilingPatternDict', () => {
  const res: PdfDict = new Map();

  it('builds a colored tile', () => {
    const d = tilingPatternDict(resolveTiling(20, 30, {}), res);
    expect(isName(d.get('Type')) && (d.get('Type') as { name: string }).name).toBe('Pattern');
    expect(d.get('PatternType')).toBe(1);
    expect(d.get('PaintType')).toBe(1);
    expect(d.get('TilingType')).toBe(1);
    expect(d.get('BBox')).toEqual([0, 0, 20, 30]);
    expect(d.get('XStep')).toBe(20);
    expect(d.get('YStep')).toBe(30);
    expect(d.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('marks an uncolored tile PaintType 2', () => {
    const d = tilingPatternDict(resolveTiling(20, 20, { uncolored: true }), res);
    expect(d.get('PaintType')).toBe(2);
  });

  it('always carries a /Resources, even an empty one', () => {
    // /Resources is required in a tiling pattern stream dict, not optional.
    const d = tilingPatternDict(resolveTiling(10, 10, {}), new Map());
    expect(d.has('Resources')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiling.test.ts`

Expected: FAIL — `Failed to resolve import "../src/tiling.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/tiling.ts`:

```ts
// The tiling-pattern model shared by the authoring layer: option validation,
// the lattice /Matrix, and the PatternType 1 dict. Pure — it builds a DIRECT
// PdfDict and touches no Document, exactly as gradient.ts does for colour
// stops, which is what keeps every rule here testable from numbers.
//
// Direction note: svgpattern.ts resolves an SVG <pattern>'s attributes into a
// tile rect for IMPORT. This is authoring, it starts from declared numbers, and
// the two share no code.
import { name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { mul, type Matrix } from './text.js';

/** Placement and repetition for a tiling pattern. */
export interface TilingPatternOptions {
  /** Horizontal repeat interval. > 0. Default: the tile width. Larger than the
   *  tile leaves gaps between cells; smaller makes them overlap. */
  xStep?: number;
  /** Vertical repeat interval. > 0. Default: the tile height. */
  yStep?: number;
  /** Lattice origin offset, in the parent stream's default user space.
   *  Default 0. */
  x?: number;
  /** Lattice origin offset. Default 0. */
  y?: number;
  /** Lattice rotation in DEGREES counter-clockwise about the pattern origin,
   *  applied before the offset. Default 0. Degrees rather than radians matches
   *  every author-facing rotation here (stamp.ts, decorate.ts); arc()'s radians
   *  is a geometry primitive, not a placement option. */
  rotation?: number;
  /** Emit an uncolored (PaintType 2) pattern: the tile carries shape only and
   *  the colour is supplied where the pattern is used, so one hatch serves
   *  every colour. Default false. */
  uncolored?: boolean;
}

/** A tiling pattern that carries its own colours. */
export interface ColoredTilingPattern {
  readonly ref: PdfRef;
  readonly paintType: 1;
}

/** A tiling pattern whose colour is supplied at use time. */
export interface UncoloredTilingPattern {
  readonly ref: PdfRef;
  readonly paintType: 2;
}

/** A handle returned by `Document.NewTilingPattern`. The two arms are distinct
 *  types so that `setFillPattern`'s overloads can make the colour argument
 *  required exactly when it is needed — a single optional colour would be
 *  required half the time and silently ignored the other half. */
export type TilingPattern = ColoredTilingPattern | UncoloredTilingPattern;

/** Validated, defaulted tiling geometry. */
export interface ResolvedTiling {
  width: number;
  height: number;
  xStep: number;
  yStep: number;
  matrix: Matrix;
  uncolored: boolean;
}

function positive(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
  return n;
}

function finite(label: string, n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new TypeError(`${label} must be a finite number`);
  return n;
}

/** The pattern /Matrix for a lattice rotated `rotationDeg` about the pattern
 *  origin and then shifted by (`x`, `y`).
 *
 *  Order matters and the wrong one still looks like a rotated hatch:
 *  translate-then-rotate spins the offset as well, putting the lattice
 *  somewhere else entirely. `mul(m, n)` applies `m` first. */
export function patternMatrix(x: number, y: number, rotationDeg: number): Matrix {
  const t: Matrix = [1, 0, 0, 1, x, y];
  if (rotationDeg === 0) return t;
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return mul([c, s, -s, c, 0, 0], t);
}

/** Validate a tile's size and options, applying the defaults. Throws before the
 *  caller allocates anything, so a rejected call leaves the document
 *  byte-identical. */
export function resolveTiling(
  width: number, height: number, opts: TilingPatternOptions = {},
): ResolvedTiling {
  positive('tile width', width);
  positive('tile height', height);
  const xStep = opts.xStep === undefined ? width : positive('xStep', opts.xStep);
  const yStep = opts.yStep === undefined ? height : positive('yStep', opts.yStep);
  const x = opts.x === undefined ? 0 : finite('x', opts.x);
  const y = opts.y === undefined ? 0 : finite('y', opts.y);
  const rotation = opts.rotation === undefined ? 0 : finite('rotation', opts.rotation);
  if (opts.uncolored !== undefined && typeof opts.uncolored !== 'boolean')
    throw new TypeError('uncolored must be a boolean');
  return {
    width, height, xStep, yStep,
    matrix: patternMatrix(x, y, rotation),
    uncolored: opts.uncolored ?? false,
  };
}

/** The PatternType 1 stream dict for a resolved tile. `resources` becomes the
 *  pattern's own /Resources — required rather than optional, so a tile that
 *  registered nothing still carries an empty dict.
 *
 *  Content is clipped to /BBox, which is the tile box: a caller wanting spill
 *  sizes the tile larger and sets smaller steps. svgdraw.ts grows the box
 *  instead, but it can read `overflow: visible` off an attribute and measure
 *  the subtree's ink; an authoring call has neither. */
export function tilingPatternDict(r: ResolvedTiling, resources: PdfDict): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('Pattern')],
    ['PatternType', 1],
    ['PaintType', r.uncolored ? 2 : 1],
    ['TilingType', 1],
    ['BBox', [0, 0, r.width, r.height]],
    ['XStep', r.xStep],
    ['YStep', r.yStep],
    ['Resources', resources],
    ['Matrix', [...r.matrix]],
  ]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tiling.test.ts`

Expected: PASS — 15 tests.

- [ ] **Step 5: Prove the composition order load-bearing**

Change `patternMatrix`'s return to `mul(t, [c, s, -s, c, 0, 0])` (translate first). Run the file:

- `rotates about the origin and THEN translates` must FAIL (`m[4]` becomes ~0 and `m[5]` ~10)
- `carries rotation alone, counter-clockwise in degrees` must stay GREEN — with no offset the two orders agree, which is exactly why a combined-only fixture cannot pin this

Restore. Then change the sign of `s` in both places (clockwise): `carries rotation alone` must FAIL.

- [ ] **Step 6: Prove the step defaults load-bearing**

Change `resolveTiling` so `xStep` defaults to `height` rather than `width`. Run: `defaults each step to the tile size` must FAIL. (The fixture uses `20 x 30` precisely so a width/height swap is visible; a square tile could not see it.) Restore.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/tiling.ts test/tiling.test.ts
git commit -m "feat(lucg.2): the pure tiling-pattern model

Validation, the lattice /Matrix and the PatternType 1 dict, in a leaf that
touches no Document — gradient.ts's division of labour. The matrix is tested
one vector at a time: a combined case cannot tell rotate-then-translate from
translate-then-rotate, and the wrong one still renders as a plausible rotated
hatch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The `VectorGraphics` base split

**Files:**
- Modify: `src/graphics.ts`
- Test: `test/graphics-identity.test.ts` (run only), `test/graphics.test.ts` (run only)

**Interfaces:**
- Consumes: the `*In` helpers from Task 2.
- Produces:
  ```ts
  export abstract class VectorGraphics {
    protected constructor(protected readonly doc: Document);
    protected abstract resources(): PdfDict;
    protected abstract maskBBox(): [number, number, number, number];
    protected readonly parts: string[];
    // every drawing primitive, the state stack, the CTM tracking
  }
  export class PageGraphics extends VectorGraphics {
    constructor(doc: Document, page: Page);
    readonly page: Page;
    apply(): void;
  }
  ```
  Task 5 subclasses `VectorGraphics`; Task 6 adds methods to it.

- [ ] **Step 1: Write the failing test**

Append to `test/graphics.test.ts`:

```ts
describe('VectorGraphics base', () => {
  it('is what PageGraphics extends', () => {
    const doc = Document.Open(buildBlankPage());
    const g = new PageGraphics(doc, doc.Pages[0]);
    expect(g).toBeInstanceOf(VectorGraphics);
  });

  it('keeps apply() and page off the base', () => {
    // The tile callback receives the BASE, so a tile builder cannot splice
    // itself into a page — the method does not exist on what it holds, which
    // makes the mistake unrepresentable rather than refused at runtime.
    expect('apply' in VectorGraphics.prototype).toBe(false);
    expect('page' in VectorGraphics.prototype).toBe(false);
    expect('drawRect' in VectorGraphics.prototype).toBe(true);
    expect('setFillGradient' in VectorGraphics.prototype).toBe(true);
    expect('BeginLayer' in VectorGraphics.prototype).toBe(true);
  });
});
```

Add `VectorGraphics` to that file's import from `../src/graphics.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`

Expected: FAIL — `VectorGraphics` is not exported by `../src/graphics.js`.

- [ ] **Step 3: Perform the split**

In `src/graphics.ts`, rename the existing `export class PageGraphics` to
`export abstract class VectorGraphics` and make these changes inside it:

1. Constructor becomes `protected constructor(protected readonly doc: Document) {}` — drop the `page` parameter.
2. `private readonly parts: string[] = []` becomes `protected readonly parts: string[] = []`.
3. Delete `apply()` entirely (it moves to the subclass).
4. Add the two abstract hooks:

```ts
  /** The /Resources dict this builder's registrations land in. A page builder
   *  answers with the page's own resources; a tile builder with the pattern's,
   *  which is the whole reason this is a hook rather than a field. */
  protected abstract resources(): PdfDict;

  /** The box a luminosity soft mask covers, in the space this builder's
   *  /Matrix establishes. A page builder answers with its MediaBox; a tile
   *  builder with its own cell. */
  protected abstract maskBBox(): [number, number, number, number];
```

5. Redirect the four registration call sites to the `*In` forms:

```ts
  setOpacity(alpha: number): this {
    const key = registerExtGStateIn(this.doc, this.resources(), checkAlpha(alpha));
    return this.op(`/${key} gs`);
  }
```

```ts
  private channelOpacity(alpha: number, ch: PaintChannel): void {
    const key = registerExtGStateIn(this.doc, this.resources(), alpha, ch);
    this.op(`/${escapeName(key)} gs`);
  }
```

```ts
  BeginLayer(layer: Layer): this {
    const key = registerOcPropertyIn(this.doc, this.resources(), layer.Ref);
    return this.op(`/OC /${escapeName(key)} BDC`);
  }
```

and inside `gradientPaint`:

```ts
    const key = registerShadingPatternIn(this.doc, this.resources(), shadingPattern(shade('color')));
```
```ts
      const gs = registerSoftMaskExtGStateIn(
        this.doc, this.resources(), shadingPattern(shade('alpha')),
        this.inverseCtm(), this.maskBBox());
```

Then add the subclass at the end of the class body's file position:

```ts
/** A buffered builder for drawing vector content onto a page. Operators are
 *  accumulated in memory and spliced into the page's /Contents on apply(). */
export class PageGraphics extends VectorGraphics {
  /** Belongs to apply() alone, which is why it is not on the base: a tile
   *  builder has nothing to commit to. */
  private applied = false;

  constructor(doc: Document, readonly page: Page) {
    super(doc);
  }

  protected resources(): PdfDict {
    return ensureOwnResources(this.doc, this.page);
  }

  protected maskBBox(): [number, number, number, number] {
    const [a, b, c, d] = this.page.MediaBox;
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }

  // ---- commit ----
  apply(): void {
    if (this.applied || this.parts.length === 0) return;
    const body = enc('q\n' + this.parts.join('\n') + '\nQ');
    appendContent(this.doc, this.page, body);
    this.parts.length = 0;
    this.applied = true;
  }
}
```

Update `graphics.ts`'s import from `./pagecontent.js` to bring in
`ensureOwnResources`, `registerExtGStateIn`, `registerOcPropertyIn`,
`registerShadingPatternIn` and `registerSoftMaskExtGStateIn`, and to drop the
four page-taking names it no longer uses. Import `PdfDict` from `./types.js`.

Move the `private applied = false;` declaration OFF the base — it belongs to
`apply()` alone.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/graphics.test.ts test/gradient.test.ts test/graphics-gradient-render.test.ts`

Expected: PASS.

- [ ] **Step 5: Check the fence**

Run: `npx vitest run test/graphics-identity.test.ts`

Expected: PASS, hash unchanged. **If it fails, stop** — the split moved emitted bytes, which it must not.

- [ ] **Step 6: Verify the public surface did not move**

Run: `npm run typecheck`

Expected: clean. Every existing `new PageGraphics(doc, page)` call site — `tablerender.ts`, `flow.ts`, `floatbox.ts`, `barcodeplace.ts`, `decorate.ts`, `redactapply.ts` and the rest — compiles untouched.

- [ ] **Step 7: Run the broader authoring suite**

Run: `npx vitest run test/table-slice-identity.test.ts test/flow.test.ts test/barcode.test.ts test/decorate.test.ts test/redact.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/graphics.ts test/graphics.test.ts
git commit -m "feat(lucg.2): split PageGraphics into VectorGraphics + the page-bound half

The base holds every primitive, the state stack and the CTM tracking, plus two
hooks for the resource target and the soft-mask box. PageGraphics adds exactly
apply() and page, so its public surface is unchanged.

The split rather than a flag is the point: a tile callback receives the base,
which has no apply(), so a tile builder cannot splice itself into a page —
unrepresentable rather than refused. The byte fence is unmoved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `TileGraphics` and `Document.NewTilingPattern`

**Files:**
- Modify: `src/graphics.ts` (append `TileGraphics` + `buildTilingPattern`)
- Modify: `src/document.ts` (`NewTilingPattern` overloads)
- Test: `test/tiling-pattern.test.ts` (create)

**Interfaces:**
- Consumes: `VectorGraphics` (Task 4); `resolveTiling`, `tilingPatternDict`, `TilingPattern` and friends (Task 3).
- Produces:
  ```ts
  // graphics.ts
  export function buildTilingPattern(
    doc: Document, width: number, height: number,
    draw: (g: VectorGraphics) => void, opts?: TilingPatternOptions,
  ): TilingPattern;

  // document.ts
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts?: TilingPatternOptions & { uncolored?: false },
  ): ColoredTilingPattern;
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts: TilingPatternOptions & { uncolored: true },
  ): UncoloredTilingPattern;
  ```
  Task 6 consumes the handle.

- [ ] **Step 1: Write the failing test**

Create `test/tiling-pattern.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isStream, type PdfDict } from '../src/types.js';

const doc2 = () => {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  return doc;
};

describe('Document.NewTilingPattern', () => {
  it('allocates one PatternType 1 stream carrying the tile ops', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(20, 30, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    });
    expect(pat.paintType).toBe(1);
    const obj = doc.resolve(pat.ref);
    expect(isStream(obj)).toBe(true);
    const s = obj as { dict: PdfDict; raw: Uint8Array };
    expect(s.dict.get('PatternType')).toBe(1);
    expect(s.dict.get('BBox')).toEqual([0, 0, 20, 30]);
    expect(new TextDecoder().decode(s.raw)).toContain('1 0 0 rg');
  });

  it('lands a tile registration in the TILE resources, not the page', () => {
    // The seam the whole VectorGraphics split exists for.
    const doc = doc2();
    const pat = doc.NewTilingPattern(20, 20, (t) => {
      t.setOpacity(0.5).drawRect(0, 0, 10, 10).fill();
    });
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    const res = doc.resolve(s.dict.get('Resources')) as PdfDict;
    expect(isDict(doc.resolve(res.get('ExtGState')))).toBe(true);

    const pageRes = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const pageGs = isDict(pageRes)
      ? doc.resolve((pageRes as PdfDict).get('ExtGState')) : undefined;
    expect(isDict(pageGs)).toBe(false);
  });

  it('carries an empty /Resources for a tile that registered nothing', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([0, 0, 0]).drawRect(0, 0, 5, 5).fill();
    });
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    expect(s.dict.has('Resources')).toBe(true);
  });

  it('refuses a tile whose callback draws nothing', () => {
    // An empty tile has no defensible ink, so it is refused at authoring time
    // rather than painting an invisible fill. This differs on purpose from
    // gradientPaint, whose degenerate cases collapse to a solid — one stop
    // still has a colour to paint.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, () => { /* nothing */ })).toThrow(TypeError);
  });

  it('allocates nothing when it refuses', () => {
    const doc = doc2();
    const before = doc.Save().length;
    expect(() => doc.NewTilingPattern(0, 10, () => { /* unreached */ })).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('marks an uncolored pattern PaintType 2', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true });
    expect(pat.paintType).toBe(2);
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    expect(s.dict.get('PaintType')).toBe(2);
  });

  it('refuses colour operators inside an uncolored tile', () => {
    // A viewer ignores every colour operator in a PaintType 2 tile, so
    // emitting them produces bytes nothing honours — which reads as a
    // rendering bug rather than a mistake.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true })).toThrow(TypeError);

    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setStrokeColor([1, 0, 0]).drawLine(0, 0, 5, 5).stroke();
    }, { uncolored: true })).toThrow(TypeError);

    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 10, y2: 0,
        stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] }],
      }).drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true })).toThrow(TypeError);
  });

  it('accepts those same calls in a COLORED tile', () => {
    // The companion: without it, "throws on setFillColor" is satisfied by a
    // build that throws on setFillColor everywhere.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 5, 5).fill();
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiling-pattern.test.ts`

Expected: FAIL — `doc.NewTilingPattern is not a function`.

- [ ] **Step 3: Add `TileGraphics` and `buildTilingPattern` to `graphics.ts`**

```ts
/** The builder a tiling pattern's callback draws into. Its registrations land
 *  in the pattern's own /Resources, and it has no apply(): a tile is committed
 *  by {@link buildTilingPattern}, never by the callback. @internal */
class TileGraphics extends VectorGraphics {
  /** The pattern's own /Resources, filled by whatever the callback registers. */
  readonly res: PdfDict = new Map();

  constructor(
    doc: Document,
    private readonly box: [number, number, number, number],
    private readonly uncolored: boolean,
  ) {
    super(doc);
  }

  protected resources(): PdfDict { return this.res; }
  protected maskBBox(): [number, number, number, number] { return this.box; }

  /** The buffered operators. No `q`/`Q` wrapper: a pattern cell is its own
   *  scope already, and PageGraphics.apply() wraps only because it splices into
   *  a stream that has other content in it. */
  ops(): string { return this.parts.join('\n'); }

  private refuseColor(what: string): never {
    throw new TypeError(
      `${what} is not allowed in an uncolored tiling pattern: a viewer ignores ` +
      'colour operators inside a PaintType 2 tile, and the colour is supplied ' +
      'where the pattern is used');
  }

  override setFillColor(rgb: [number, number, number]): this {
    if (this.uncolored) this.refuseColor('setFillColor');
    return super.setFillColor(rgb);
  }
  override setStrokeColor(rgb: [number, number, number]): this {
    if (this.uncolored) this.refuseColor('setStrokeColor');
    return super.setStrokeColor(rgb);
  }
  override setFillGradient(g: Gradient): this {
    if (this.uncolored) this.refuseColor('setFillGradient');
    return super.setFillGradient(g);
  }
  override setStrokeGradient(g: Gradient): this {
    if (this.uncolored) this.refuseColor('setStrokeGradient');
    return super.setStrokeGradient(g);
  }
}

/** Build a tiling pattern: validate, run `draw` into a tile-scoped builder, and
 *  allocate the pattern stream. Validation and the callback both run before the
 *  allocation, so a rejected call leaves the document byte-identical.
 *
 *  Behind `Document.NewTilingPattern`; see that method for the overloads that
 *  narrow the return type on `uncolored`. */
export function buildTilingPattern(
  doc: Document, width: number, height: number,
  draw: (g: VectorGraphics) => void, opts: TilingPatternOptions = {},
): TilingPattern {
  if (typeof draw !== 'function')
    throw new TypeError('draw must be a function');
  const r = resolveTiling(width, height, opts);
  const tile = new TileGraphics(doc, [0, 0, r.width, r.height], r.uncolored);
  draw(tile);
  const ops = tile.ops();
  // An empty tile has no defensible ink. Refusing beats allocating a pattern
  // that paints nothing wherever it is used.
  if (ops === '')
    throw new TypeError('a tiling pattern must draw something');
  const ref = doc.allocObject({
    kind: 'stream',
    dict: tilingPatternDict(r, tile.res),
    raw: enc(ops),
  });
  return { ref, paintType: r.uncolored ? 2 : 1 } as TilingPattern;
}
```

Add to `graphics.ts`'s imports:

```ts
import {
  resolveTiling, tilingPatternDict,
  type TilingPattern, type TilingPatternOptions,
} from './tiling.js';
```

and add `Gradient` to the existing `./gradient.js` type import if it is not
already there (it is — `graphics.ts` already imports `type Gradient`).

- [ ] **Step 4: Add `NewTilingPattern` to `document.ts`**

Place it beside `NewFloatingBox`:

```ts
  /** Create a reusable tiling pattern (PDF PatternType 1): `draw` paints one
   *  tile into a builder scoped to tile space, and the pattern repeats on an
   *  `xStep` x `yStep` lattice wherever it is used.
   *
   *  The pattern is page-independent and allocated once — use it on as many
   *  pages as you like via `setFillPattern` / `setStrokePattern`, and each page
   *  registers the same object.
   *
   *  The lattice is pinned to the page's DEFAULT user space and ignores the
   *  CTM (32000-1 §8.7.3.1), exactly as a gradient is, so a `transform()`
   *  before the fill moves the shape and not the tiling; `x`, `y` and
   *  `rotation` are how you place it instead.
   *
   *  With `{ uncolored: true }` the tile carries shape only and the colour is
   *  given where the pattern is used, so one hatch serves every colour. Colour
   *  operators inside such a tile throw, since a viewer ignores them. */
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts?: TilingPatternOptions & { uncolored?: false },
  ): ColoredTilingPattern;
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts: TilingPatternOptions & { uncolored: true },
  ): UncoloredTilingPattern;
  NewTilingPattern(
    width: number, height: number, draw: (g: VectorGraphics) => void,
    opts: TilingPatternOptions = {},
  ): TilingPattern {
    return buildTilingPattern(this, width, height, draw, opts);
  }
```

Import `buildTilingPattern` and `VectorGraphics` from `./graphics.js`, and the
handle/option types from `./tiling.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/tiling-pattern.test.ts test/tiling.test.ts`

Expected: PASS.

- [ ] **Step 6: Prove the resource target load-bearing**

In `TileGraphics`, change `resources()` to return
`ensureOwnResources(this.doc, this.doc.Pages[0])`. Run
`npx vitest run test/tiling-pattern.test.ts`: `lands a tile registration in the
TILE resources, not the page` must FAIL. Restore.

- [ ] **Step 7: Check the fence and typecheck**

```bash
npx vitest run test/graphics-identity.test.ts
npm run typecheck
```

Expected: PASS and clean.

- [ ] **Step 8: Commit**

```bash
git add src/graphics.ts src/document.ts test/tiling-pattern.test.ts
git commit -m "feat(lucg.2): doc.NewTilingPattern and the tile-scoped builder

TileGraphics extends VectorGraphics with the pattern's own /Resources as its
registration target, so a setOpacity inside a tile lands in the tile. An
uncolored tile refuses colour operators outright rather than emitting bytes a
viewer ignores, and an empty tile is refused rather than allocated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: `setFillPattern` / `setStrokePattern`

**Files:**
- Modify: `src/graphics.ts` (methods on `VectorGraphics`)
- Modify: `src/index.ts` (exports)
- Test: `test/tiling-pattern.test.ts` (append)

**Interfaces:**
- Consumes: `TilingPattern` handles (Task 5), `registerPatternRefIn` (Task 2).
- Produces:
  ```ts
  setFillPattern(pattern: ColoredTilingPattern): this;
  setFillPattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  setStrokePattern(pattern: ColoredTilingPattern): this;
  setStrokePattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/tiling-pattern.test.ts`:

```ts
/** Concatenate the decoded content of page `i`. */
const contentOf = (doc: Document, i = 0): string =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('setFillPattern / setStrokePattern', () => {
  const hatch = (doc: Document) => doc.NewTilingPattern(10, 10, (t) => {
    t.setLineWidth(1).setStrokeColor([0, 0, 1]).drawLine(0, 0, 10, 10).stroke();
  });

  it('selects a colored pattern for fill', () => {
    const doc = doc2();
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(hatch(doc)).drawRect(0, 0, 50, 50).fill();
    g.apply();
    const c = contentOf(doc);
    expect(c).toContain('/Pattern cs');
    expect(c).toMatch(/\/P\d+ scn/);
  });

  it('uses the upper-case operators for stroke', () => {
    const doc = doc2();
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setStrokePattern(hatch(doc)).drawRect(0, 0, 50, 50).stroke();
    g.apply();
    const c = contentOf(doc);
    expect(c).toContain('/Pattern CS');
    expect(c).toMatch(/\/P\d+ SCN/);
  });

  it('emits the colour before the key for an uncolored pattern', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.setLineWidth(1).drawLine(0, 0, 10, 10).stroke();
    }, { uncolored: true });
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(pat, [1, 0, 0]).drawRect(0, 0, 50, 50).fill();
    g.apply();
    const c = contentOf(doc);
    // An uncolored pattern selects an underlying colour space.
    expect(c).toContain('/Pattern /DeviceRGB cs');
    expect(c).toMatch(/1 0 0 \/P\d+ scn/);
  });

  it('registers one pattern used on two pages as ONE object', () => {
    // The whole argument for Document-level creation: a hatch on forty pages
    // must be one stream, not forty.
    const doc = doc2();
    doc.AddPage(PageFormat.A4);
    const pat = hatch(doc);
    for (const page of doc.Pages) {
      const g = new PageGraphics(doc, page);
      g.setFillPattern(pat).drawRect(0, 0, 50, 50).fill();
      g.apply();
    }
    const reopened = Document.Open(doc.Save());
    let streams = 0;
    for (const [, obj] of reopened.objectEntries()) {
      const d = isStream(obj) ? obj.dict : undefined;
      if (d && reopened.resolve(d.get('PatternType')) === 1) streams++;
    }
    expect(streams).toBe(1);
  });

  it('reuses one resource key for the same pattern used twice on a page', () => {
    const doc = doc2();
    const pat = hatch(doc);
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(pat).drawRect(0, 0, 20, 20).fill();
    g.setFillPattern(pat).drawRect(30, 30, 20, 20).fill();
    g.apply();
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const pt = doc.resolve(res.get('Pattern')) as PdfDict;
    expect([...pt.keys()]).toHaveLength(1);
  });
});

describe('tiling acceptance', () => {
  it('repeats the tile on the lattice', () => {
    // A test asserting only that a /Pattern resource exists passes with the
    // steps, the matrix and the paint type all simultaneously wrong. Probe
    // pixels instead: one inside a painted module, one in the gap.
    //
    // Note ToImage is SYNCHRONOUS and returns a Uint8Array — no await.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.custom(100, 100));
    // A 20x20 tile whose ink is a 10x10 red square in its lower-left quarter,
    // so the lower-left of every cell is painted and the rest is not.
    const pat = doc.NewTilingPattern(20, 20, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    });
    const g = new PageGraphics(doc, page);
    g.setFillPattern(pat).drawRect(0, 0, 100, 100).fill();
    g.apply();

    const png = decodePng(page.ToImage({ scale: 1 }));
    // Device y runs DOWN from the top, user y runs up: user (45,45) on a
    // 100pt page is device (45, 55).
    // Cell (2,2)'s ink spans user x,y in [40,50) -> painted.
    expect(png.at(45, 55)).toEqual([255, 0, 0, 255]);
    // The gap in that same cell, user x,y in [50,60) -> unpainted white.
    expect(png.at(55, 45)).toEqual([255, 255, 255, 255]);
  });
});
```

Add to the file's imports: `PageGraphics` from `../src/graphics.js`, and
`decodePng` from `./helpers/decode-png.js` — the suite already has that helper
and `test/annotrender.test.ts` uses it exactly this way. Its `at(x, y)` returns
`[r, g, b, a]` with gray and RGB padded to opaque, so the default opaque-RGB
PNG that `ToImage` produces reads back as a four-tuple ending in 255.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tiling-pattern.test.ts`

Expected: FAIL — `g.setFillPattern is not a function`.

- [ ] **Step 3: Add the setters to `VectorGraphics`**

Place them beside `setFillGradient` / `setStrokeGradient`:

```ts
  /** Fill subsequent paths with `pattern`, a tiling pattern from
   *  {@link Document.NewTilingPattern}. An uncolored pattern additionally takes
   *  the colour to paint it in.
   *
   *  **Invariant:** the lattice is pinned to the parent stream's DEFAULT user
   *  space and ignores the CTM (32000-1 §8.7.3.1) — the same rule
   *  {@link setFillGradient} documents. A `transform()` earlier in this builder
   *  moves the path and not the tiling; place the lattice with the pattern's
   *  own `x` / `y` / `rotation` instead. */
  setFillPattern(pattern: ColoredTilingPattern): this;
  setFillPattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  setFillPattern(pattern: TilingPattern, color?: [number, number, number]): this {
    return this.patternPaint(pattern, color, 'fill');
  }

  /** Stroke subsequent paths with `pattern`. Symmetric with
   *  {@link setFillPattern}; see it for the invariants both share. */
  setStrokePattern(pattern: ColoredTilingPattern): this;
  setStrokePattern(pattern: UncoloredTilingPattern, color: [number, number, number]): this;
  setStrokePattern(pattern: TilingPattern, color?: [number, number, number]): this {
    return this.patternPaint(pattern, color, 'stroke');
  }

  /** The shared body. The two differ only in operator case, so there is one
   *  implementation — the reason gradientPaint is shared too. */
  private patternPaint(
    pattern: TilingPattern, color: [number, number, number] | undefined, ch: PaintChannel,
  ): this {
    if (pattern === null || typeof pattern !== 'object' ||
        typeof (pattern as { ref?: unknown }).ref !== 'object')
      throw new TypeError('pattern must come from Document.NewTilingPattern');
    // The overloads make this unreachable from TypeScript; it is here for a
    // JavaScript caller, and because silently painting an uncolored pattern
    // black is worse than refusing.
    if (pattern.paintType === 2 && color === undefined)
      throw new TypeError('an uncolored tiling pattern needs a color');
    if (pattern.paintType === 1 && color !== undefined)
      throw new TypeError('a colored tiling pattern takes no color');

    const key = registerPatternRefIn(this.doc, this.resources(), pattern.ref);
    const esc = escapeName(key);
    if (pattern.paintType === 2) {
      const [r, g, b] = checkColor(color!);
      return ch === 'fill'
        ? this.op(`/Pattern /DeviceRGB cs`).op(`${num(r)} ${num(g)} ${num(b)} /${esc} scn`)
        : this.op(`/Pattern /DeviceRGB CS`).op(`${num(r)} ${num(g)} ${num(b)} /${esc} SCN`);
    }
    return ch === 'fill'
      ? this.op(`/Pattern cs`).op(`/${esc} scn`)
      : this.op(`/Pattern CS`).op(`/${esc} SCN`);
  }
```

Add `registerPatternRefIn` to the `./pagecontent.js` import, and
`ColoredTilingPattern`, `UncoloredTilingPattern` to the `./tiling.js` type
import.

- [ ] **Step 4: Add the exports**

In `src/index.ts`, beside the existing graphics exports:

```ts
export { PageGraphics, VectorGraphics } from './graphics.js';
export type {
  TilingPattern, ColoredTilingPattern, UncoloredTilingPattern, TilingPatternOptions,
} from './tiling.js';
```

(`PageGraphics` may already be exported — extend that line rather than
duplicating it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/tiling-pattern.test.ts`

Expected: PASS.

- [ ] **Step 6: Prove the acceptance probe load-bearing**

Change `tilingPatternDict` to emit `['XStep', r.xStep * 2]`. Run
`npx vitest run test/tiling-pattern.test.ts`: `repeats the tile on the lattice`
must FAIL, while every operator-shape case stays GREEN — which is the point of
having a pixel probe at all. Restore.

- [ ] **Step 7: Typecheck, fence, commit**

```bash
npm run typecheck
npx vitest run test/graphics-identity.test.ts
git add src/graphics.ts src/index.ts test/tiling-pattern.test.ts
git commit -m "feat(lucg.2): setFillPattern and setStrokePattern

Overloaded so the colour is required exactly when the pattern is uncolored and
rejected when it is not — a single optional argument would be required half the
time and silently ignored the other half. One pattern used on many pages is one
object, and one resource key per page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Documentation and the full verification pass

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Document it in the README**

Find the vector-graphics section (search for `setFillGradient`) and add after
the gradient prose:

````markdown
A **tiling pattern** repeats a tile of vector content across whatever you fill
or stroke. Create it once on the document — it is page-independent, so the same
hatch on forty pages is one object — and use it from any page's builder:

```ts
const hatch = doc.NewTilingPattern(20, 20, (t) => {
  t.setLineWidth(1).setStrokeColor([0.2, 0.2, 0.6])
   .drawLine(0, 0, 20, 20).stroke();
}, { rotation: 45 });

const g = new PageGraphics(doc, page);
g.setFillPattern(hatch).drawRect(72, 600, 200, 100).fill();
g.apply();
```

Options are `{ xStep, yStep, x, y, rotation, uncolored }`. The steps default to
the tile's size — larger leaves gaps between cells, smaller makes them overlap.
`x`, `y` and `rotation` (degrees counter-clockwise) place the lattice.

Like a gradient, the lattice is pinned to the page's **default** user space and
ignores the CTM, so a `transform()` before the fill moves the shape and not the
tiling; that is what `x`/`y`/`rotation` are for. Tile content is clipped to the
tile box, so content that should overhang needs a larger tile with smaller steps.

With `{ uncolored: true }` the tile carries shape only and the colour is given
where the pattern is used, so one hatch serves every colour:

```ts
const dots = doc.NewTilingPattern(8, 8, (t) => {
  t.circle(4, 4, 2).fill();
}, { uncolored: true });

g.setFillPattern(dots, [0.8, 0.1, 0.1]).drawRect(72, 500, 200, 60).fill();
```

Colour operators inside an uncolored tile throw, since a viewer ignores them.
````

- [ ] **Step 2: Update the API table**

Add these rows next to the existing `PageGraphics` row:

```markdown
| `doc.NewTilingPattern(w, h, draw, opts?)` | Create a reusable `PatternType 1` tiling pattern; `draw` paints one tile into a `VectorGraphics`. `opts`: `xStep`/`yStep` (default the tile size), `x`/`y`/`rotation` (degrees CCW) to place the lattice, `uncolored` for a `PaintType 2` tile whose colour is given at use time |
| `g.setFillPattern(pattern[, color])` / `g.setStrokePattern(pattern[, color])` | Fill or stroke with a tiling pattern; `color` is required for an uncolored pattern and rejected for a colored one. The lattice is pinned to default user space and ignores the CTM, as a gradient is |
```

- [ ] **Step 3: Add the CHANGELOG entry**

As the **first** bullet under `## [Unreleased]` → `### Added`:

```markdown
- **Tiling patterns can be authored** — `doc.NewTilingPattern(w, h, draw, opts?)` plus `setFillPattern`/`setStrokePattern`, closing a gap that ran one way through the whole stack: `svgdraw.ts` has always *built* a `PatternType 1` dict for SVG import, both renderers read one (colored and uncolored alike), and `glyphusage.ts`/`imageopt.ts` scan them — while `graphics.ts` could register a shading pattern and nothing else. The tile is painted by a callback into a builder scoped to tile space, so every existing vector primitive works inside it unchanged. Options are `xStep`/`yStep` (defaulting to the tile size, so larger leaves gaps and smaller overlaps) and `x`/`y`/`rotation` to place the lattice, which is pinned to the page's default user space and ignores the CTM exactly as a gradient's ramp is — a `transform()` moves the shape, not the tiling. `{ uncolored: true }` emits a `PaintType 2` tile carrying shape only, so one hatch serves every colour. Two decisions are worth naming. Colored and uncolored are **distinct types**, so the overloads make the colour argument required exactly when it is needed and rejected when it is not; a single optional argument would have been required half the time and silently ignored the other half. And an uncolored tile **throws** on colour operators rather than emitting bytes a viewer ignores — a silent no-op there reads as a rendering bug rather than a mistake. Underneath, `pagecontent.ts`'s four `register*` helpers gained resource-target variants so a registration inside a tile lands in the tile's own `/Resources`, and `PageGraphics` split into a `VectorGraphics` base plus the page-bound half: a tile callback holds the base, which has no `apply()`, so a tile builder cannot splice itself into a page. That refactor claimed byte-identity for existing callers and **nothing in the suite checked it**, which is why `test/graphics-identity.test.ts` was written and recorded first. (`lucg.2`)
```

- [ ] **Step 4: Run the full suite and the typecheck**

```bash
npm run typecheck
npm test
```

Expected: both green, and `test/graphics-identity.test.ts` still reports the hash recorded in Task 1.

- [ ] **Step 5: Re-run the fenced and new files together**

```bash
npx vitest run test/graphics-identity.test.ts test/tiling.test.ts test/tiling-pattern.test.ts test/graphics.test.ts test/gradient.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(lucg.2): tiling-pattern authoring in the README and the changelog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-lucg.2
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the executor

**The fence is the safety net for the whole first half.** Tasks 2 and 4 both
claim byte-identity for existing callers, and before Task 1 nothing in this
repo checked `graphics.ts`'s output. If `test/graphics-identity.test.ts` moves
after Task 1, stop and find out which key or allocation order changed — do not
re-record the hash.

**`registerExtGState` keeps its signature on purpose.** The spec says the
helpers "take a resources `PdfDict` rather than a `Page`"; the plan implements
that as `*In` variants plus wrappers, because the page-taking form has eight
callers in five unrelated files. Task 2 Step 7 asserts those files show no
diff.

**Out of scope, per the spec.** Preset generators (hatch, stripes, dots,
checkerboard) — each is a few lines over the primitive, left until someone
asks. A raw `matrix` escape hatch — recorded as deferred, not rejected; it
would compose into the same `/Matrix` slot. Automatic `/BBox` growth for
overrunning tile content — `svgdraw.ts` can infer that intent from an
attribute, an authoring call cannot.

**Recorded as deliberately unpinned.** `TilingType` is always 1 (constant
spacing). PDF defines 2 (no distortion) and 3 (faster tiling), which are
rendering hints rather than semantics; no option exposes them and no test
covers the difference.
