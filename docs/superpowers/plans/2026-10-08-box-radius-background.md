# Rounded Corners and Background Images on Boxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boxes get per-corner elliptical rounded corners and a background image, linear gradient or radial gradient — on `FloatingBox` and on every CSS box `AddHtml` renders — and a CSS box's background stops leaving holes between its children.

**Architecture:** A pure leaf, `src/boxpaint.ts`, owns every geometry rule (radii, overlap scaling, rounded paths, edge wedges, background size/position/tiling, gradient line and ending shape, stop placement). A second module, `src/boxdraw.ts`, is the one painter: it turns a `BoxPaintSpec` into content through `PageGraphics` (which gains internal `clipPath`, `placeImage` and a matrix-carrying gradient fill). `cssframe.ts` (per slice, with the gap fix and a whole-box natural height on `BoxRun`) and `floatbox.ts` (whole box) build specs and call it. The CSS grammar for the nine new longhands lives in a new pure leaf, `src/cssbackground.ts`, used by `cssprop.ts` and `cssshorthand.ts`; `cssflow.ts` maps computed values to points and resolves images.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest, no runtime dependencies. Oracle scripts use puppeteer installed with `--no-save`, as `scripts/gen-svg-goldens.ts` does.

**Spec:** `docs/superpowers/specs/2026-10-08-box-radius-background-design.md`

## Global Constraints

- **Opt-in.** A box with no radius, no image and no gradient paints with today's code, byte for byte — EXCEPT the gap fix (spec decision 5), which changes multi-child boxes that have a background or side borders.
- **Fences, unedited:** `rich-runs-identity`, `markdown-flow`, `flow-notes-identity`, `flow-table-notes-identity`, `reflow-hyphen-identity`, `docx-flow-identity`, the existing `test/floatbox*.test.ts`, the css-box corpus. `html-identity` may move ONLY through the gap fix; any moved hash is shown as a before/after PNG in the commit message's task notes, never silently re-recorded.
- **Units:** every length in `boxpaint.ts`, `boxdraw.ts`, `BoxFrame` and `FloatBoxOptions` is POINTS. CSS px → pt (× 0.75) crosses in `cssflow.ts` alone.
- **Decoration is `/Artifact`** in a tagged flow (both painters).
- **Validation before any work:** `TypeError` for a wrong kind (non-finite radius, unknown `fit`, bad stops), `RangeError` for a negative radius. Nothing is allocated before validation passes.
- **CSS reporting:** an unsupported background value (multiple layers, `repeating-*`, `conic-gradient`, `image-set()`, `cross-fade()`, `fixed`, `space`/`round`, colour hints, a box keyword in the shorthand) makes the declaration fail its grammar and is reported through the cascade's existing `unparsable-value` record. A `url()` that will not resolve is a `NotRendered` with `construct: 'image'`, `kind: 'dropped'`, `detail: 'background-image: <src>'`; `CONSTRUCTS` stays at 22.
- **Longhand count:** 43 → 52, asserted in `test/cssprop.test.ts`.
- **Errors:** every new `catch` calls `rethrowLimit(caught)` first.
- **CHANGELOG:** `### Added` entry ending `(v9j3.4)`, and a `### Fixed` entry for the gap.

## Review Focus

1. **A radius larger than the box** (`border-radius: 9999px` on a 100×20 box): overlap scaling makes a pill, never a self-intersecting path. (Task 1)
2. **A multi-child CSS box split across a column with a gradient**: the ramp is continuous — each slice is offset by the height already painted — and only the true top and bottom corners are rounded. (Task 5)
3. **`background: url(x.png)` whose src will not resolve**: the colour still paints, the image is reported once, nothing throws. (Task 7)
4. **A gradient stop list with positions outside 0–100%** (`linear-gradient(red -20%, blue 120%)`): the ramp extends the line rather than clamping colours. (Task 2)
5. **A transparent stop** (`linear-gradient(red, transparent)`): varying alpha uses `PageGraphics`' soft-mask path, and still works for an elliptical radial gradient under its matrix. (Task 3)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/boxpaint.ts` (new) | Pure leaf importing nothing: radii, overlap scaling, slice masking, rounded path segments, edge wedges, background tile size/origin, gradient line and radial extent, stop placement. |
| `src/boxdraw.ts` (new) | The one painter: `paintBox(doc, page, spec, artifact)` — clip, colour, image or gradient layer (single or tiled), border ring. |
| `src/graphics.ts` | Internal `clipPath(evenOdd)`, `placeImage(built, x, y, w, h)`, `setFillGradientMatrix(g, m)` on `VectorGraphics`. |
| `src/gradient.ts` | `shadingPattern(shading, matrix?)` — an optional `/Matrix`. |
| `src/imageembed.ts` | `registerBuiltImage(doc, resources, built)` extracted from `drawBuiltImage` (byte-identical). |
| `src/cssframe.ts` | `BoxFrame.radii` / `.layer`; the gap fix; `BoxRun.natural`; painting through `boxdraw.ts` when a radius or layer is present. |
| `src/cssbackground.ts` (new) | Pure CSS grammar: radius, image (url, linear, radial), size, repeat, position, the `background-position` split. |
| `src/cssprop.ts`, `src/cssshorthand.ts` | Nine rows; `border-radius`, `background-position`, extended `background`. |
| `src/cssflow.ts` | `frameOf(r, c)`: px→pt, image resolution and reporting. |
| `src/floatbox.ts` | `radius`, gradient `background`, `backgroundImage`. |
| `scripts/gen-box-paint-goldens.ts`, `test/helpers/box-paint-fixtures.ts`, `test/fixtures/box-paint/*` (new) | Chrome pixel oracle. |
| `scripts/gen-cascade-goldens.ts`, `test/helpers/cascade-goldens.ts` | Computed-value goldens for radius/size/repeat/position. |

---

### Task 1: `boxpaint.ts` — radii, paths and wedges

**Files:**
- Create: `src/boxpaint.ts`
- Test: `test/boxpaint-radius.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Len { abs: number; frac: number }          // abs points + frac × basis
  export interface Corner { rx: number; ry: number }
  export type Radii = [Corner, Corner, Corner, Corner];      // tl, tr, br, bl
  export interface CornerSpec { x: Len; y: Len }
  export interface Widths { top: number; right: number; bottom: number; left: number }
  export type Seg = ['m', number, number] | ['l', number, number]
    | ['c', number, number, number, number, number, number] | ['h'];
  export const ZERO_RADII: Radii;
  export const lenOf: (l: Len, basis: number) => number;
  export function resolveRadii(spec: readonly CornerSpec[], w: number, h: number): Radii;
  export function hasRadius(r: Radii): boolean;
  export function sliceRadii(r: Radii, first: boolean, last: boolean): Radii;
  export function innerRadii(r: Radii, b: Widths): Radii;
  export function roundedRect(x: number, y: number, w: number, h: number, r: Radii): Seg[];  // PDF space, y = bottom
  export function pathOps(segs: Seg[], fmt: (n: number) => string): string;
  export function edgeWedges(x: number, y: number, w: number, h: number, b: Widths):
    Record<keyof Widths, [number, number][]>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/boxpaint-radius.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveRadii, hasRadius, sliceRadii, innerRadii, roundedRect, pathOps, edgeWedges, ZERO_RADII, type CornerSpec,
} from '../src/boxpaint.js';

const pt = (abs: number, frac = 0) => ({ abs, frac });
const all = (x: number, y = x): CornerSpec[] => Array.from({ length: 4 }, () => ({ x: pt(x), y: pt(y) }));

describe('resolveRadii', () => {
  it('resolves percentages against width (rx) and height (ry)', () => {
    const r = resolveRadii(Array.from({ length: 4 }, () => ({ x: pt(0, 0.5), y: pt(0, 0.5) })), 200, 100);
    expect(r[0]).toEqual({ rx: 100, ry: 50 });                       // 50% is an ellipse on a non-square box
  });
  it('scales EVERY radius by the smallest side factor when adjacent radii overlap', () => {
    const r = resolveRadii(all(9999), 100, 20);                      // a pill
    expect(r[0].rx).toBeCloseTo(10, 9); expect(r[0].ry).toBeCloseTo(10, 9);
    expect(r[1].rx).toBeCloseTo(10, 9);
  });
  it('leaves radii that fit alone', () => {
    expect(resolveRadii(all(10, 5), 100, 50)[2]).toEqual({ rx: 10, ry: 5 });
  });
  it('a spec that is not four corners is square (an absent radius)', () => {
    expect(resolveRadii([], 50, 50)).toEqual(ZERO_RADII);
  });
  it('a corner with a zero component is square', () => {
    expect(hasRadius(resolveRadii([{ x: pt(10), y: pt(0) }, ...all(0).slice(1)], 50, 50))).toBe(false);
  });
});

describe('slices and inner radii', () => {
  it('a first slice keeps only its top corners, a last only its bottom', () => {
    const r = resolveRadii(all(8), 100, 100);
    expect(sliceRadii(r, true, false).map((c) => c.rx)).toEqual([8, 8, 0, 0]);
    expect(sliceRadii(r, false, true).map((c) => c.rx)).toEqual([0, 0, 8, 8]);
    expect(sliceRadii(r, false, false)).toEqual(ZERO_RADII);
  });
  it('inner radii subtract the adjoining border widths, floored at 0', () => {
    const r = resolveRadii(all(10), 100, 100);
    const i = innerRadii(r, { top: 4, right: 12, bottom: 0, left: 2 });
    expect(i[0]).toEqual({ rx: 8, ry: 6 });                           // tl: left 2, top 4
    expect(i[1]).toEqual({ rx: 0, ry: 6 });                           // tr: right 12 floors
  });
});

describe('paths', () => {
  it('a square rect is four lines and a close', () => {
    expect(roundedRect(0, 0, 10, 5, ZERO_RADII).map((s) => s[0])).toEqual(['m', 'l', 'l', 'l', 'h']);
  });
  it('a rounded corner is one cubic whose control points sit 0.5523 r in', () => {
    const r = resolveRadii(all(10), 100, 100);
    const segs = roundedRect(0, 0, 100, 100, r);
    expect(segs.filter((s) => s[0] === 'c')).toHaveLength(4);
    // start at top-left after its corner, walk clockwise (top edge first)
    expect(segs[0]).toEqual(['m', 10, 100]);
    const [, a, b, c, d, e, f] = segs.find((s) => s[0] === 'c') as ['c', number, number, number, number, number, number];
    expect(a).toBeCloseTo(90 + 10 * 0.5522847498, 6); expect(b).toBeCloseTo(100, 6);
    expect(c).toBeCloseTo(100, 6); expect(d).toBeCloseTo(90 + 10 * 0.5522847498, 6);
    expect(e).toBeCloseTo(100, 6); expect(f).toBeCloseTo(90, 6);
  });
  it('pathOps writes m/l/c/h operators with the given number format', () => {
    expect(pathOps([['m', 1, 2], ['l', 3, 4], ['h']], String)).toBe('1 2 m\n3 4 l\nh\n');
  });
});

describe('edge wedges', () => {
  it('each edge is the quad from its two outer corners to the inner ones', () => {
    const w = edgeWedges(0, 0, 100, 50, { top: 4, right: 6, bottom: 2, left: 8 });
    expect(w.top).toEqual([[0, 50], [100, 50], [94, 46], [8, 46]]);
    expect(w.left).toEqual([[0, 0], [0, 50], [8, 46], [8, 2]]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/boxpaint-radius.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/boxpaint.ts` (geometry half)**

```ts
// src/boxpaint.ts
/** Box painting geometry (v9j3.4): radii, rounded paths, border wedges, and —
 *  below — the background layer's tile layout and gradient geometry.
 *
 *  **Invariant:** a pure LEAF importing NOTHING, so every rule is testable from
 *  numbers — the split floatstack.ts, cloudborder.ts and linebox.ts make. Both
 *  painters (cssframe.ts per slice, floatbox.ts whole) read it, so a FloatingBox
 *  and an HTML box cannot disagree about a corner.
 *
 *  **Invariant:** every length is POINTS and every rect is PDF space, `y` its
 *  BOTTOM. Background layout alone works top-down (CSS's own frame), and says
 *  so where it does. */

/** A length: `abs` points plus `frac` of a basis. A CSS percentage is a frac. */
export interface Len { abs: number; frac: number }
export interface Corner { rx: number; ry: number }
/** Top-left, top-right, bottom-right, bottom-left — CSS's order. */
export type Radii = [Corner, Corner, Corner, Corner];
export interface CornerSpec { x: Len; y: Len }
export interface Widths { top: number; right: number; bottom: number; left: number }
export type Seg = ['m', number, number] | ['l', number, number]
  | ['c', number, number, number, number, number, number] | ['h'];

const Z: Corner = { rx: 0, ry: 0 };
export const ZERO_RADII: Radii = [Z, Z, Z, Z];
/** The cubic control offset for a quarter ellipse. */
const K = 0.5522847498307936;

export const lenOf = (l: Len, basis: number): number => l.abs + l.frac * basis;

/** CSS Backgrounds 3 §5.5. Percentages resolve against the border box's
 *  width (rx) and height (ry). A corner with a zero component is square. When
 *  two adjacent radii add to more than their side, EVERY radius is multiplied
 *  by the smallest side factor, so a too-large radius makes a pill rather than
 *  a self-intersecting path. */
export function resolveRadii(spec: readonly CornerSpec[], w: number, h: number): Radii {
  if (spec.length !== 4) return ZERO_RADII;
  const raw = spec.map((c): Corner => {
    const rx = Math.max(0, lenOf(c.x, w)), ry = Math.max(0, lenOf(c.y, h));
    return rx > 0 && ry > 0 ? { rx, ry } : Z;
  });
  const [tl, tr, br, bl] = raw as Radii;
  const f = Math.min(
    tl.rx + tr.rx > 0 ? w / (tl.rx + tr.rx) : Infinity,
    bl.rx + br.rx > 0 ? w / (bl.rx + br.rx) : Infinity,
    tl.ry + bl.ry > 0 ? h / (tl.ry + bl.ry) : Infinity,
    tr.ry + br.ry > 0 ? h / (tr.ry + br.ry) : Infinity,
  );
  if (!(f < 1)) return [tl, tr, br, bl];
  return raw.map((c) => (c === Z ? Z : { rx: c.rx * f, ry: c.ry * f })) as Radii;
}

export const hasRadius = (r: Radii): boolean => r.some((c) => c.rx > 0 && c.ry > 0);

/** CSS `box-decoration-break: slice`: a slice rounds only the corners it
 *  really has — the top pair on the box's first slice, the bottom pair on its
 *  last. */
export function sliceRadii(r: Radii, first: boolean, last: boolean): Radii {
  return [first ? r[0] : Z, first ? r[1] : Z, last ? r[2] : Z, last ? r[3] : Z];
}

/** The padding box's radii: each outer radius less the adjoining border
 *  widths, floored at 0 (CSS Backgrounds 3 §5.2). */
export function innerRadii(r: Radii, b: Widths): Radii {
  const c = (o: Corner, bx: number, by: number): Corner => {
    const rx = Math.max(0, o.rx - bx), ry = Math.max(0, o.ry - by);
    return rx > 0 && ry > 0 ? { rx, ry } : Z;
  };
  return [c(r[0], b.left, b.top), c(r[1], b.right, b.top), c(r[2], b.right, b.bottom), c(r[3], b.left, b.bottom)];
}

/** A clockwise rounded rect, starting on the top edge after the top-left
 *  corner. A square corner is a plain vertex. */
export function roundedRect(x: number, y: number, w: number, h: number, r: Radii): Seg[] {
  const [tl, tr, br, bl] = r;
  const x1 = x + w, y1 = y + h;
  const s: Seg[] = [['m', x + tl.rx, y1], ['l', x1 - tr.rx, y1]];
  if (tr.rx > 0) s.push(['c', x1 - tr.rx + K * tr.rx, y1, x1, y1 - tr.ry + K * tr.ry, x1, y1 - tr.ry]);
  s.push(['l', x1, y + br.ry]);
  if (br.rx > 0) s.push(['c', x1, y + br.ry - K * br.ry, x1 - br.rx + K * br.rx, y, x1 - br.rx, y]);
  s.push(['l', x + bl.rx, y]);
  if (bl.rx > 0) s.push(['c', x + bl.rx - K * bl.rx, y, x, y + bl.ry - K * bl.ry, x, y + bl.ry]);
  s.push(['l', x, y1 - tl.ry]);
  if (tl.rx > 0) s.push(['c', x, y1 - tl.ry + K * tl.ry, x + tl.rx - K * tl.rx, y1, x + tl.rx, y1]);
  if (s[s.length - 1][0] === 'l' && tl.rx === 0) s.pop();           // back at the start vertex
  s.push(['h']);
  return s;
}

/** Content-stream operators for `segs`; `fmt` is the caller's number writer
 *  (pagecontent.ts's `num`), injected so this module stays a leaf. */
export function pathOps(segs: Seg[], fmt: (n: number) => string): string {
  let out = '';
  for (const s of segs) {
    if (s[0] === 'h') out += 'h\n';
    else out += `${s.slice(1).map((n) => fmt(n as number)).join(' ')} ${s[0]}\n`;
  }
  return out;
}

/** Each edge's share of the border, as a quad from its two OUTER corners to
 *  the two INNER (padding-box) corners — the diagonal colour join Chrome
 *  draws. Used as a clip when edges differ in colour. */
export function edgeWedges(x: number, y: number, w: number, h: number, b: Widths):
  Record<keyof Widths, [number, number][]> {
  const x1 = x + w, y1 = y + h;
  const ix0 = x + b.left, ix1 = x1 - b.right, iy0 = y + b.bottom, iy1 = y1 - b.top;
  return {
    top: [[x, y1], [x1, y1], [ix1, iy1], [ix0, iy1]],
    right: [[x1, y1], [x1, y], [ix1, iy0], [ix1, iy1]],
    bottom: [[x1, y], [x, y], [ix0, iy0], [ix1, iy0]],
    left: [[x, y], [x, y1], [ix0, iy1], [ix0, iy0]],
  };
}
```


- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/boxpaint-radius.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boxpaint.ts test/boxpaint-radius.test.ts
git commit -m "feat(v9j3.4): boxpaint.ts — radii, overlap scaling, rounded paths, edge wedges"
```

---

### Task 2: `boxpaint.ts` — background layout and gradient geometry

**Files:**
- Modify: `src/boxpaint.ts` (append)
- Test: `test/boxpaint-layer.test.ts`

**Interfaces:**
- Consumes: `Len`, `lenOf` (Task 1).
- Produces:
  ```ts
  export type BgSize = 'cover' | 'contain' | [Len | 'auto', Len | 'auto'];
  export interface BgLayer { size: BgSize; posX: Len; posY: Len; repeatX: boolean; repeatY: boolean }
  export function tileSize(size: BgSize, aw: number, ah: number, natural?: { w: number; h: number }): { w: number; h: number };
  export function tileOrigin(l: BgLayer, aw: number, ah: number, tw: number, th: number): { x: number; y: number };  // from the area's TOP-LEFT, y DOWN
  export function cornerAngle(sx: -1 | 1 | 0, sy: -1 | 1 | 0, w: number, h: number): number;  // CSS degrees
  export function linearLine(angleDeg: number, w: number, h: number): { x1: number; y1: number; x2: number; y2: number }; // box-local, y DOWN
  export type RadialExtent = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | { rx: Len; ry: Len };
  export function radialRadii(shape: 'circle' | 'ellipse', e: RadialExtent, cx: number, cy: number, w: number, h: number): { rx: number; ry: number };
  export interface StopSpec { color: [number, number, number]; alpha: number; pos?: Len }
  export interface PlacedStop { t: number; color: [number, number, number]; alpha: number }
  export function placeStops(stops: readonly StopSpec[], length: number): PlacedStop[];
  export function fitStops(s: PlacedStop[]): { t0: number; t1: number; stops: { offset: number; color: [number, number, number]; opacity: number }[] };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/boxpaint-layer.test.ts
import { describe, it, expect } from 'vitest';
import {
  tileSize, tileOrigin, cornerAngle, linearLine, radialRadii, placeStops, fitStops, type BgLayer,
} from '../src/boxpaint.js';

const L = (abs: number, frac = 0) => ({ abs, frac });
const layer = (o: Partial<BgLayer> = {}): BgLayer =>
  ({ size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true, ...o });

describe('tileSize (CSS Backgrounds 3 §3.9)', () => {
  const nat = { w: 40, h: 20 };
  it('auto is the natural size; a gradient (no natural size) fills the area', () => {
    expect(tileSize(['auto', 'auto'], 200, 100, nat)).toEqual({ w: 40, h: 20 });
    expect(tileSize(['auto', 'auto'], 200, 100)).toEqual({ w: 200, h: 100 });
  });
  it('one auto keeps the aspect ratio', () => {
    expect(tileSize([L(80), 'auto'], 200, 100, nat)).toEqual({ w: 80, h: 40 });
    expect(tileSize(['auto', L(0, 0.5)], 200, 100, nat)).toEqual({ w: 100, h: 50 });
  });
  it('cover scales to cover the area, contain to fit it', () => {
    expect(tileSize('cover', 200, 300, nat)).toEqual({ w: 600, h: 300 });
    expect(tileSize('contain', 200, 300, nat)).toEqual({ w: 200, h: 100 });
  });
});

describe('tileOrigin', () => {
  it('a percentage places the tile p point on the area p point', () => {
    expect(tileOrigin(layer({ posX: L(0, 0.5), posY: L(0, 1) }), 200, 100, 40, 20)).toEqual({ x: 80, y: 80 });
  });
  it('the 4-value form `right 10px` is 100% less 10', () => {
    expect(tileOrigin(layer({ posX: L(-10, 1) }), 200, 100, 40, 20).x).toBe(150);
  });
});

describe('linear gradient geometry (CSS Images 3 §3.1)', () => {
  it('corner keywords take the box aspect', () => {
    expect(cornerAngle(1, -1, 100, 100)).toBeCloseTo(45, 9);                      // to top right, square
    expect(cornerAngle(1, 1, 200, 100)).toBeCloseTo(180 - Math.atan(100 / 200) * 180 / Math.PI, 9);
  });
  it('the line passes through the centre with length |w sin a| + |h cos a|', () => {
    const l = linearLine(180, 200, 100);                                          // to bottom
    expect(l).toEqual({ x1: 100, y1: 0, x2: 100, y2: 100 });
    const d = linearLine(45, 200, 100);
    const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
    expect(len).toBeCloseTo(200 * Math.sin(Math.PI / 4) + 100 * Math.cos(Math.PI / 4), 9);
  });
});

describe('radial extents (CSS Images 3 §3.2)', () => {
  it('circle closest-side / farthest-corner', () => {
    expect(radialRadii('circle', 'closest-side', 30, 20, 200, 100)).toEqual({ rx: 20, ry: 20 });
    const fc = radialRadii('circle', 'farthest-corner', 30, 20, 200, 100);
    expect(fc.rx).toBeCloseTo(Math.hypot(170, 80), 9);
  });
  it('ellipse farthest-corner keeps the farthest-side aspect and passes through the corner', () => {
    const e = radialRadii('ellipse', 'farthest-corner', 100, 50, 200, 100);
    expect(e.ry / e.rx).toBeCloseTo(50 / 100, 9);
    expect((100 / e.rx) ** 2 + (50 / e.ry) ** 2).toBeCloseTo(1, 9);
  });
  it('an explicit ellipse size resolves against the box', () => {
    expect(radialRadii('ellipse', { rx: L(0, 0.5), ry: L(10) }, 0, 0, 200, 100)).toEqual({ rx: 100, ry: 10 });
  });
});

describe('stops', () => {
  const red: [number, number, number] = [1, 0, 0], blue: [number, number, number] = [0, 0, 1];
  it('first defaults to 0, last to 1, the rest spread evenly; a stop behind an earlier one is clamped up', () => {
    const s = placeStops([{ color: red, alpha: 1 }, { color: red, alpha: 1 }, { color: blue, alpha: 1, pos: L(0, 0.9) },
      { color: blue, alpha: 1, pos: L(0, 0.2) }, { color: red, alpha: 1 }], 100);
    expect(s.map((x) => x.t)).toEqual([0, 0.45, 0.9, 0.9, 1]);
  });
  it('fitStops renormalizes stops outside 0..1 and returns the line extent', () => {
    const f = fitStops([{ t: -0.2, color: red, alpha: 1 }, { t: 1.2, color: blue, alpha: 0 }]);
    expect(f.t0).toBeCloseTo(-0.2, 9); expect(f.t1).toBeCloseTo(1.2, 9);
    expect(f.stops.map((x) => x.offset)).toEqual([0, 1]);
    expect(f.stops[1].opacity).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/boxpaint-layer.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement (append to `src/boxpaint.ts`)**

```ts
// ---- background layer (CSS Backgrounds 3) — TOP-DOWN, from the area's top-left ----

export type BgSize = 'cover' | 'contain' | [Len | 'auto', Len | 'auto'];
export interface BgLayer { size: BgSize; posX: Len; posY: Len; repeatX: boolean; repeatY: boolean }

/** §3.9. `natural` absent means the image has no intrinsic size (a gradient):
 *  an `auto` dimension is then the area's. One `auto` beside a length keeps
 *  the natural aspect ratio. */
export function tileSize(size: BgSize, aw: number, ah: number, natural?: { w: number; h: number }): { w: number; h: number } {
  if (size === 'cover' || size === 'contain') {
    if (natural === undefined || !(natural.w > 0) || !(natural.h > 0)) return { w: aw, h: ah };
    const k = (size === 'cover' ? Math.max : Math.min)(aw / natural.w, ah / natural.h);
    return { w: natural.w * k, h: natural.h * k };
  }
  const [sx, sy] = size;
  const w = sx === 'auto' ? undefined : lenOf(sx, aw);
  const h = sy === 'auto' ? undefined : lenOf(sy, ah);
  if (natural === undefined) return { w: w ?? aw, h: h ?? ah };
  if (w !== undefined && h !== undefined) return { w, h };
  if (w !== undefined) return { w, h: natural.w > 0 ? w * natural.h / natural.w : natural.h };
  if (h !== undefined) return { w: natural.h > 0 ? h * natural.w / natural.h : natural.w, h };
  return { w: natural.w, h: natural.h };
}

/** A percentage places the tile's p point on the area's p point, so the frac
 *  of a position applies to (area − tile). */
export function tileOrigin(l: BgLayer, aw: number, ah: number, tw: number, th: number): { x: number; y: number } {
  return { x: lenOf(l.posX, aw - tw), y: lenOf(l.posY, ah - th) };
}

// ---- gradients (CSS Images 3) — box-local, TOP-DOWN ----

const DEG = Math.PI / 180;

/** `to <side-or-corner>` as a CSS angle (0 = up, clockwise). A corner keyword
 *  depends on the box's aspect: the 50% line joins the two other corners. */
export function cornerAngle(sx: -1 | 1 | 0, sy: -1 | 1 | 0, w: number, h: number): number {
  if (sx === 0) return sy < 0 ? 0 : 180;
  if (sy === 0) return sx > 0 ? 90 : 270;
  const a = Math.atan2(sx * h, -sy * w) / DEG;
  return a < 0 ? a + 360 : a;
}

/** The gradient line through the box centre, of length |w sin a| + |h cos a|,
 *  from the start (0%) to the end (100%). */
export function linearLine(angleDeg: number, w: number, h: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = angleDeg * DEG;
  const sin = Math.sin(a), cos = Math.cos(a);
  const half = (Math.abs(w * sin) + Math.abs(h * cos)) / 2;
  const cx = w / 2, cy = h / 2;
  const clean = (n: number): number => (Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : n);
  return {
    x1: clean(cx - sin * half), y1: clean(cy + cos * half),
    x2: clean(cx + sin * half), y2: clean(cy - cos * half),
  };
}

export type RadialExtent = 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | { rx: Len; ry: Len };

/** The ending shape's radii. A corner extent for an ELLIPSE keeps the aspect
 *  the matching side extent would have and passes through that corner. */
export function radialRadii(shape: 'circle' | 'ellipse', e: RadialExtent, cx: number, cy: number, w: number, h: number): { rx: number; ry: number } {
  if (typeof e === 'object') {
    const rx = Math.max(0, lenOf(e.rx, w));
    return shape === 'circle' ? { rx, ry: rx } : { rx, ry: Math.max(0, lenOf(e.ry, h)) };
  }
  const dx = [Math.abs(cx), Math.abs(w - cx)], dy = [Math.abs(cy), Math.abs(h - cy)];
  const closest = e.startsWith('closest');
  const pick = closest ? Math.min : Math.max;
  if (e.endsWith('side')) {
    if (shape === 'circle') { const r = pick(...dx, ...dy); return { rx: r, ry: r }; }
    return { rx: pick(...dx), ry: pick(...dy) };
  }
  // corner
  const corners = dx.flatMap((x) => dy.map((y) => [x, y] as const));
  const dist = corners.map(([x, y]) => Math.hypot(x, y));
  const i = dist.indexOf(pick(...dist));
  if (shape === 'circle') return { rx: dist[i], ry: dist[i] };
  const sx = pick(...dx), sy = pick(...dy);
  if (!(sx > 0) || !(sy > 0)) return { rx: 0, ry: 0 };
  const k = sy / sx, [x, y] = corners[i];
  const rx = Math.sqrt(x * x + (y * y) / (k * k));
  return { rx, ry: rx * k };
}

export interface StopSpec { color: [number, number, number]; alpha: number; pos?: Len }
export interface PlacedStop { t: number; color: [number, number, number]; alpha: number }

/** CSS Images 3 §3.4.3: an unpositioned first stop is 0 and last is 1; a
 *  position behind an earlier one is clamped up to it; runs of unpositioned
 *  stops spread evenly between their positioned neighbours. Positions may
 *  fall outside 0..1. */
export function placeStops(stops: readonly StopSpec[], length: number): PlacedStop[] {
  const t: (number | undefined)[] = stops.map((s) => (s.pos === undefined ? undefined : lenOf(s.pos, length) / (length || 1)));
  if (t.length > 0 && t[0] === undefined) t[0] = 0;
  if (t.length > 1 && t[t.length - 1] === undefined) t[t.length - 1] = 1;
  let max = -Infinity;
  for (let i = 0; i < t.length; i++) if (t[i] !== undefined) { max = Math.max(max, t[i]!); t[i] = max; }
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== undefined) continue;
    let j = i; while (t[j] === undefined) j++;
    const a = t[i - 1]!, b = t[j]!;
    for (let k = i; k < j; k++) t[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s, i) => ({ t: t[i]!, color: s.color, alpha: s.alpha }));
}

/** Renormalize to 0..1 for a PDF function, returning where on the CSS line
 *  the new 0 and 1 fall — the line is extended rather than colours clamped. */
export function fitStops(s: PlacedStop[]): { t0: number; t1: number; stops: { offset: number; color: [number, number, number]; opacity: number }[] } {
  const t0 = Math.min(0, s[0]?.t ?? 0), t1 = Math.max(1, s[s.length - 1]?.t ?? 1);
  const span = t1 - t0 || 1;
  return { t0, t1, stops: s.map((x) => ({ offset: (x.t - t0) / span, color: x.color, opacity: x.alpha })) };
}
```

Check the `placeStops` expectation `[0, 0.45, 0.9, 0.9, 1]`: stop 1 is unpositioned between 0 and 0.9 → 0.45; stop 3 at 20% is clamped up to 0.9. `fitStops` on `[-0.2, 1.2]` gives t0 −0.2, t1 1.2 and offsets 0 and 1. Verify `GradientStop` in `src/gradient.ts` names its fields `offset`, `color`, `opacity`; if it differs, rename the output fields to match `GradientStop` exactly (the painter passes them straight through).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/boxpaint-layer.test.ts test/boxpaint-radius.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boxpaint.ts test/boxpaint-layer.test.ts
git commit -m "feat(v9j3.4): boxpaint.ts — background tile layout, gradient line, radial extents, stop placement"
```

---

### Task 3: drawing primitives — `clipPath`, `placeImage`, matrix gradients, `registerBuiltImage`

**Files:**
- Modify: `src/graphics.ts` (`VectorGraphics`)
- Modify: `src/gradient.ts` (`shadingPattern`)
- Modify: `src/imageembed.ts` (extract `registerBuiltImage`)
- Test: `test/graphics-box-primitives.test.ts`

**Interfaces:**
- Produces (all `@internal`, not exported from `index.ts`):
  - `VectorGraphics.clipPath(evenOdd?: boolean): this` — emits `W n` / `W* n`.
  - `VectorGraphics.placeImage(built: BuiltImage, x: number, y: number, w: number, h: number): this` — registers in `this.resources()` and emits `q w 0 0 h x y cm /ImN Do Q`.
  - `VectorGraphics.setFillGradientMatrix(g: Gradient, m: Matrix): this` — as `setFillGradient`, with a pattern `/Matrix` on the colour pattern AND its alpha twin.
  - `shadingPattern(shading: PdfDict, matrix?: Matrix): PdfDict` — `/Matrix` only when given.
  - `registerBuiltImage(doc: Document, resources: PdfDict, built: BuiltImage): string` — allocates the stream (and `/SMask`), registers it under a fresh `Im` key, returns the key.

- [ ] **Step 1: Write the failing tests**

```ts
// test/graphics-box-primitives.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageGraphics } from '../src/graphics.js';
import { buildImageXObject } from '../src/imageembed.js';
import { solidPng } from './helpers/solid-png.js';
import { decodePng } from './helpers/decode-png.js';

const page = () => { const d = Document.New(); return { d, p: d.Pages[0] }; };
const content = (d: Document) => new TextDecoder().decode(d.Pages[0].Contents);

describe('VectorGraphics internal primitives (v9j3.4)', () => {
  it('clipPath writes W n, and W* n for even-odd', () => {
    const { d, p } = page();
    new PageGraphics(d, p).rect(0, 0, 10, 10).clipPath().rect(0, 0, 5, 5).clipPath(true).apply();
    expect(content(d)).toMatch(/re\nW n\n[\s\S]*re\nW\* n/);
  });
  it('placeImage registers the image once per call and draws it into the rect', () => {
    const { d, p } = page();
    const built = buildImageXObject(solidPng(2, 2, [255, 0, 0]));
    new PageGraphics(d, p).placeImage(built, 10, 20, 30, 40).apply();
    expect(content(d)).toMatch(/30 0 0 40 10 20 cm\n\/Im\d* Do/);
    const png = decodePng(Document.Open(d.Save()).Pages[0].ToImage({ dpi: 72 }));
    const h = png.height;
    expect(png.at(25, h - 40)).toEqual([255, 0, 0, 255]);
  });
  it('setFillGradientMatrix puts the matrix on the pattern, and on the alpha twin', () => {
    const { d, p } = page();
    new PageGraphics(d, p).setFillGradientMatrix({ kind: 'radial', cx: 0, cy: 0, r: 10,
      stops: [{ offset: 0, color: [1, 0, 0], opacity: 1 }, { offset: 1, color: [0, 0, 1], opacity: 0 }] },
      [2, 0, 0, 1, 50, 50]).rect(0, 0, 100, 100).fill().apply();
    const saved = new TextDecoder('latin1').decode(d.Save());
    expect((saved.match(/\/Matrix \[2 0 0 1 50 50\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
```

Add the helper the v9j3.4 tests share (`makePng()` in `test/helpers/make-png.ts` takes no arguments):

```ts
// test/helpers/solid-png.ts
import { encodePng } from '../../src/pngencode.js';
/** A w×h PNG of one RGB colour; a `quadrants` second colour fills the
 *  bottom-right quarter, so position and tiling errors are visible. */
export function solidPng(w: number, h: number, rgb: [number, number, number], quadrants?: [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = quadrants && x >= w / 2 && y >= h / 2 ? quadrants : rgb;
    px.set(c, (y * w + x) * 3);
  }
  return encodePng(w, h, px, 'rgb');
}
```

Check `PngKind`'s spelling of the RGB kind in `src/pngencode.ts` and use it.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/graphics-box-primitives.test.ts`
Expected: FAIL — `clipPath` is not a function.

- [ ] **Step 3: Implement**

3a. `src/gradient.ts`:

```ts
export function shadingPattern(shading: PdfDict, matrix?: readonly number[]): PdfDict {
  const d = dict([
    ['Type', name('Pattern')],
    ['PatternType', 2],
    ['Shading', shading],
  ]);
  // (v9j3.4) Only when given, so every existing caller is byte-identical.
  if (matrix !== undefined) d.set('Matrix', [...matrix]);
  return d;
}
```

3b. `src/imageembed.ts` — extract the allocation half of `drawBuiltImage` verbatim:

```ts
/** Allocate `built` (and its `/SMask`) and register it under a fresh `Im` key
 *  in `resources`. ONE owner, shared by drawBuiltImage and the box painter
 *  (v9j3.4). @internal */
export function registerBuiltImage(doc: Document, resources: PdfDict, built: BuiltImage): string {
  const stream: PdfStream = { ...built.stream, dict: new Map(built.stream.dict) };
  if (built.smask) {
    const smask: PdfStream = { ...built.smask, dict: new Map(built.smask.dict) };
    stream.dict.set('SMask', doc.allocObject(smask));
  }
  const xobjs = ensureOwnSubdict(doc, resources, 'XObject');
  const key = freshKey(xobjs, 'Im');
  xobjs.set(key, doc.allocObject(stream));
  return key;
}
```

and in `drawBuiltImage` replace those lines with `const key = registerBuiltImage(doc, ensureOwnResources(doc, page), built);`. The allocation ORDER (SMask, then stream) is unchanged, which is what keeps output byte-identical.

3c. `src/graphics.ts` — on `VectorGraphics`:

```ts
  /** @internal Clip to the current path and end it (`W n`, even-odd `W* n`).
   *  For the box painter (v9j3.4); not public API. */
  clipPath(evenOdd = false): this {
    this.hasCurrentPoint = false;
    return this.op(evenOdd ? 'W* n' : 'W n');
  }

  /** @internal Draw an image XObject into [x, y, w, h], registering it in this
   *  builder's own resources — a page's, or a tile's. */
  placeImage(built: BuiltImage, x: number, y: number, w: number, h: number): this {
    const key = registerBuiltImage(this.doc, this.resources(), built);
    return this.op(`q\n${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm\n/${key} Do\nQ`);
  }

  /** @internal setFillGradient with a pattern /Matrix (v9j3.4): an elliptical
   *  CSS radial gradient is a circle under a scaling, and a PDF radial shading
   *  is circular. The matrix rides the colour pattern AND the alpha twin. */
  setFillGradientMatrix(g: Gradient, m: Matrix): this { return this.gradientPaint(g, 'fill', m); }
```

Thread an optional `m?: Matrix` through `gradientPaint`: pass it to BOTH `shadingPattern(shade('color'), m)` and `shadingPattern(shade('alpha'), m)`. `setFillGradient` and `setStrokeGradient` pass nothing. Check the name of the current-point flag in `VectorGraphics` (`hasCurrentPoint`) and of the number writer (`num` from `pagecontent.js`), and import `registerBuiltImage`/`BuiltImage` from `imageembed.js` — confirm that import closes no cycle by running `npx vitest run test/import-cycles.test.ts`. If it does, move `registerBuiltImage` into `pagecontent.ts` instead and import it from there in both places.

- [ ] **Step 4: Run the tests and the fences**

Run: `npx vitest run test/graphics-box-primitives.test.ts test/import-cycles.test.ts test/html-identity.test.ts test/graphics.test.ts test/image.test.ts`
Expected: PASS, with `html-identity` unedited.

- [ ] **Step 5: Commit**

```bash
git add src/graphics.ts src/gradient.ts src/imageembed.ts test/graphics-box-primitives.test.ts
git commit -m "feat(v9j3.4): internal clipPath, placeImage, matrix gradient fill; registerBuiltImage extracted"
```

---

### Task 4: `boxdraw.ts` — the one painter

**Files:**
- Create: `src/boxdraw.ts`
- Test: `test/boxdraw.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  export interface EdgePaint { width: number; color: [number, number, number] }
  export type GradientSpec =
    | { kind: 'linear'; angle?: number; to?: [-1 | 0 | 1, -1 | 0 | 1]; stops: StopSpec[] }
    | { kind: 'radial'; shape: 'circle' | 'ellipse'; extent: RadialExtent; at: [Len, Len]; stops: StopSpec[] };
  export type LayerSource =
    | { kind: 'image'; built: BuiltImage; width: number; height: number }   // natural size, POINTS
    | { kind: 'gradient'; g: GradientSpec };
  export interface LayerPaint {
    source: LayerSource; layer: BgLayer;
    /** The WHOLE box's positioning area (padding box), PDF space: left x, TOP y. */
    area: { x: number; top: number; w: number; h: number };
  }
  export interface BoxPaintSpec {
    x: number; y: number; w: number; h: number;             // this slice's border box, y = bottom
    radii: Radii;                                           // already sliced
    color?: [number, number, number];
    edges: { top?: EdgePaint; right?: EdgePaint; bottom?: EdgePaint; left?: EdgePaint };
    layer?: LayerPaint;
  }
  export function paintBox(doc: Document, page: Page, s: BoxPaintSpec, artifact: boolean): void;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/boxdraw.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paintBox, type BoxPaintSpec } from '../src/boxdraw.js';
import { resolveRadii, ZERO_RADII } from '../src/boxpaint.js';
import { buildImageXObject } from '../src/imageembed.js';
import { solidPng } from './helpers/solid-png.js';
import { decodePng } from './helpers/decode-png.js';

const L = (abs: number, frac = 0) => ({ abs, frac });
const r8 = resolveRadii(Array.from({ length: 4 }, () => ({ x: L(20), y: L(20) })), 100, 100);
const render = (spec: Partial<BoxPaintSpec>, artifact = false) => {
  const d = Document.New(); const p = d.Pages[0];
  paintBox(d, p, { x: 100, y: 500, w: 100, h: 100, radii: ZERO_RADII, edges: {}, ...spec }, artifact);
  const png = decodePng(Document.Open(d.Save()).Pages[0].ToImage({ dpi: 72 }));
  return { d, at: (x: number, y: number) => png.at(x, png.height - y) };
};
const RED: [number, number, number] = [1, 0, 0];

describe('paintBox (v9j3.4)', () => {
  it('a rounded box leaves its corner unpainted and its middle filled', () => {
    const { at } = render({ radii: r8, color: RED });
    expect(at(150, 550)).toEqual([255, 0, 0, 255]);
    expect(at(101, 599)).toEqual([255, 255, 255, 255]);              // inside the bbox, outside the curve
  });
  it('a uniform rounded border is one even-odd ring: the curve is inked, the middle is not', () => {
    const { at } = render({ radii: r8, edges: { top: { width: 4, color: RED }, right: { width: 4, color: RED },
      bottom: { width: 4, color: RED }, left: { width: 4, color: RED } } });
    expect(at(150, 598)).toEqual([255, 0, 0, 255]);
    expect(at(150, 550)).toEqual([255, 255, 255, 255]);
  });
  it('differing edge colours meet on the diagonal', () => {
    const { at } = render({ radii: r8, edges: { top: { width: 10, color: RED }, left: { width: 10, color: [0, 0, 1] },
      right: { width: 10, color: RED }, bottom: { width: 10, color: RED } } });
    expect(at(150, 596)[0]).toBe(255);                              // top: red
    expect(at(103, 550)[2]).toBe(255);                              // left: blue
  });
  it('a no-repeat image draws once at its tile; repeat fills the clip', () => {
    const built = buildImageXObject(solidPng(2, 2, [0, 255, 0]));
    const one = render({ layer: { source: { kind: 'image', built, width: 20, height: 20 },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: false, repeatY: false },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(one.at(110, 590)).toEqual([0, 255, 0, 255]);
    expect(one.at(150, 550)).toEqual([255, 255, 255, 255]);
    const tiled = render({ layer: { source: { kind: 'image', built, width: 20, height: 20 },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(tiled.at(150, 550)).toEqual([0, 255, 0, 255]);
  });
  it('a linear gradient to the right runs red to blue across the box', () => {
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1 }, { color: [0, 0, 1], alpha: 1 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(at(102, 550)[0]).toBeGreaterThan(240);
    expect(at(198, 550)[2]).toBeGreaterThan(240);
  });
  it('an ellipse radial gradient is wider than tall', () => {
    const { at } = render({ w: 200, layer: { source: { kind: 'gradient', g: { kind: 'radial', shape: 'ellipse',
      extent: 'closest-side', at: [L(0, 0.5), L(0, 0.5)],
      stops: [{ color: RED, alpha: 1 }, { color: [1, 1, 1], alpha: 1 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 200, h: 100 } } });
    // 40pt right of centre is redder than 40pt above it: the ellipse is 2:1.
    expect(at(240, 550)[1]).toBeLessThan(at(200, 590)[1]);
  });
  it('wraps everything in an /Artifact when asked', () => {
    const { d } = render({ color: RED, radii: r8 }, true);
    expect(new TextDecoder().decode(d.Pages[0].Contents)).toMatch(/\/Artifact BMC/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/boxdraw.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/boxdraw.ts`**

```ts
// src/boxdraw.ts
/** The box painter (v9j3.4): one slice of a box (or a whole FloatingBox) to
 *  content. Geometry comes from boxpaint.ts; this module only emits, through
 *  PageGraphics, so gradients get its alpha soft-mask handling and patterns its
 *  resource registration.
 *
 *  **Invariant:** CSS paint order — clip to the rounded border box; the colour;
 *  the image layer; the border ring. The background clip is the BORDER box
 *  (CSS's initial background-clip); the positioning area is the padding box
 *  (initial background-origin), which `LayerPaint.area` carries.
 *
 *  **Invariant:** the layer is laid out against the WHOLE box (`area`) and only
 *  clipped to this slice, which is what keeps an image or gradient continuous
 *  across a column break. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PageGraphics, type VectorGraphics } from './graphics.js';
import type { BuiltImage } from './imageembed.js';
import {
  roundedRect, innerRadii, edgeWedges, hasRadius, tileSize, tileOrigin, cornerAngle, linearLine,
  radialRadii, placeStops, fitStops, lenOf,
  type Radii, type Seg, type BgLayer, type RadialExtent, type StopSpec, type Len,
} from './boxpaint.js';
import type { Gradient } from './gradient.js';

export interface EdgePaint { width: number; color: [number, number, number] }
export type GradientSpec =
  | { kind: 'linear'; angle?: number; to?: [-1 | 0 | 1, -1 | 0 | 1]; stops: StopSpec[] }
  | { kind: 'radial'; shape: 'circle' | 'ellipse'; extent: RadialExtent; at: [Len, Len]; stops: StopSpec[] };
export type LayerSource =
  | { kind: 'image'; built: BuiltImage; width: number; height: number }
  | { kind: 'gradient'; g: GradientSpec };
export interface LayerPaint { source: LayerSource; layer: BgLayer; area: { x: number; top: number; w: number; h: number } }
export interface BoxPaintSpec {
  x: number; y: number; w: number; h: number; radii: Radii;
  color?: [number, number, number];
  edges: { top?: EdgePaint; right?: EdgePaint; bottom?: EdgePaint; left?: EdgePaint };
  layer?: LayerPaint;
}

function path(g: VectorGraphics, segs: Seg[]): VectorGraphics {
  for (const s of segs) {
    if (s[0] === 'm') g.moveTo(s[1], s[2]);
    else if (s[0] === 'l') g.lineTo(s[1], s[2]);
    else if (s[0] === 'c') g.curveTo(s[1], s[2], s[3], s[4], s[5], s[6]);
    else g.close();
  }
  return g;
}

/** A gradient in TILE-local PDF space (origin the tile's bottom-left), and the
 *  pattern matrix an ellipse needs. */
function pdfGradient(spec: GradientSpec, tw: number, th: number, ox: number, oy: number):
  { g: Gradient; m?: number[] } {
  if (spec.kind === 'linear') {
    const angle = spec.to ? cornerAngle(spec.to[0], spec.to[1], tw, th) : spec.angle ?? 180;
    const l = linearLine(angle, tw, th);                 // top-down, tile-local
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const f = fitStops(placeStops(spec.stops, len));
    const at = (t: number) => [l.x1 + (l.x2 - l.x1) * t, l.y1 + (l.y2 - l.y1) * t] as const;
    const [ax, ay] = at(f.t0), [bx, by] = at(f.t1);
    return { g: { kind: 'linear', x1: ox + ax, y1: oy + th - ay, x2: ox + bx, y2: oy + th - by, stops: f.stops } };
  }
  const cx = lenOf(spec.at[0], tw), cy = lenOf(spec.at[1], th);
  const { rx, ry } = radialRadii(spec.shape, spec.extent, cx, cy, tw, th);
  // A radial ramp starts at the centre: a negative stop is clamped there, so
  // the PDF function runs over [0, t1] of the CSS ray, and r is scaled to t1.
  const stops = placeStops(spec.stops, rx).map((x) => ({ ...x, t: Math.max(0, x.t) }));
  const fr = fitStops(stops);
  const pcx = ox + cx, pcy = oy + th - cy;
  const r = rx * fr.t1;
  if (spec.shape === 'circle' || rx === ry || !(rx > 0)) return { g: { kind: 'radial', cx: pcx, cy: pcy, r, stops: fr.stops } };
  const k = ry / rx;                                   // scale y about the centre
  return { g: { kind: 'radial', cx: 0, cy: 0, r, stops: fr.stops }, m: [1, 0, 0, k, pcx, pcy] };
}

export function paintBox(doc: Document, page: Page, s: BoxPaintSpec, artifact: boolean): void {
  const g = new PageGraphics(doc, page);
  if (artifact) g.BeginArtifact();
  const outer = roundedRect(s.x, s.y, s.w, s.h, s.radii);

  if (s.color !== undefined || s.layer !== undefined) {
    g.save();
    path(g, outer).clipPath();
    if (s.color !== undefined) g.setFillColor(s.color).rect(s.x, s.y, s.w, s.h).fill();
    if (s.layer !== undefined) paintLayer(doc, g, s.layer);
    g.restore();
  }

  const e = s.edges;
  const b = { top: e.top?.width ?? 0, right: e.right?.width ?? 0, bottom: e.bottom?.width ?? 0, left: e.left?.width ?? 0 };
  if (b.top + b.right + b.bottom + b.left > 0) {
    const inner = roundedRect(s.x + b.left, s.y + b.bottom, s.w - b.left - b.right, s.h - b.top - b.bottom,
      innerRadii(s.radii, b));
    const colors = (['top', 'right', 'bottom', 'left'] as const).filter((k) => b[k] > 0).map((k) => e[k]!.color.join(','));
    if (new Set(colors).size <= 1) {
      const c = (e.top ?? e.right ?? e.bottom ?? e.left)!.color;
      path(path(g, outer), inner).setFillColor(c).fillEvenOdd();
    } else {
      const w = edgeWedges(s.x, s.y, s.w, s.h, b);
      for (const k of ['top', 'right', 'bottom', 'left'] as const) {
        if (!(b[k] > 0)) continue;
        g.save();
        g.polygon(w[k]).clipPath();
        path(path(g, outer), inner).setFillColor(e[k]!.color).fillEvenOdd();
        g.restore();
      }
    }
  }
  if (artifact) g.EndMarkedContent();
  g.apply();
}

function paintLayer(doc: Document, g: PageGraphics, lp: LayerPaint): void {
  const { area, layer, source } = lp;
  const natural = source.kind === 'image' ? { w: source.width, h: source.height } : undefined;
  const t = tileSize(layer.size, area.w, area.h, natural);
  if (!(t.w > 0) || !(t.h > 0)) return;
  const o = tileOrigin(layer, area.w, area.h, t.w, t.h);
  // Tile's bottom-left in PDF space.
  const tx = area.x + o.x, ty = area.top - o.y - t.h;

  const drawTile = (dst: VectorGraphics, x: number, y: number): void => {
    if (source.kind === 'image') { dst.placeImage(source.built, x, y, t.w, t.h); return; }
    const { g: grad, m } = pdfGradient(source.g, t.w, t.h, x, y);
    dst.save().rect(x, y, t.w, t.h).clipPath();
    if (m) dst.setFillGradientMatrix(grad, m); else dst.setFillGradient(grad);
    dst.rect(x, y, t.w, t.h).fill().restore();
  };

  if (!layer.repeatX && !layer.repeatY) { drawTile(g, tx, ty); return; }
  // One axis only: a band through the tile, clipped, then the pattern fills it.
  g.save();
  if (!layer.repeatX) g.rect(tx, area.top - area.h - 1e5, t.w, area.h + 2e5).clipPath();
  if (!layer.repeatY) g.rect(area.x - 1e5, ty, area.w + 2e5, t.h).clipPath();
  const pat = doc.NewTilingPattern(t.w, t.h, (tg) => drawTile(tg, 0, 0), { x: tx, y: ty });
  g.setFillPattern(pat).rect(area.x - 1e5, area.top - area.h - 1e5, area.w + 2e5, area.h + 2e5).fill();
  g.restore();
}
```

Notes the implementer must check, not guess:
- `PageGraphics.polygon(points)` exists (`graphics.ts:416`) and builds a closed path; confirm it does not itself paint.
- `VectorGraphics.save()`/`restore()` exist and return `this`; `BeginArtifact`/`EndMarkedContent` are `PageGraphics` methods (`graphics.ts:341`, `:346`).
- The 1e5 band margins only need to exceed the clip; the clip already bounds the paint.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/boxdraw.test.ts`
Expected: PASS. Add the Review-Focus case now:

```ts
  it('stops outside 0..100% extend the line rather than clamping colours', () => {
    const L2 = (abs: number, frac = 0) => ({ abs, frac });
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1, pos: L2(0, -0.2) }, { color: [0, 0, 1], alpha: 1, pos: L2(0, 1.2) }] } },
      layer: { size: ['auto', 'auto'], posX: L2(0), posY: L2(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    // At the box's left edge the ramp is already 20/140 of the way to blue.
    const [r, , b] = at(101, 550);
    expect(r).toBeLessThan(250); expect(b).toBeGreaterThan(10);
  });
  it('a transparent stop fades to the page (soft mask)', () => {
    const { at } = render({ layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 90,
      stops: [{ color: RED, alpha: 1 }, { color: RED, alpha: 0 }] } },
      layer: { size: ['auto', 'auto'], posX: L(0), posY: L(0), repeatX: true, repeatY: true },
      area: { x: 100, top: 600, w: 100, h: 100 } } });
    expect(at(198, 550)).toEqual([255, 255, 255, 255].map((v) => expect.closeTo(v, -1.5)));
  });
```

(If the `closeTo` array form fails to type-check, assert `g` and `b` channels `> 240` instead.)

- [ ] **Step 5: Commit**

```bash
git add src/boxdraw.ts test/boxdraw.test.ts
git commit -m "feat(v9j3.4): boxdraw.ts — clip, colour, image or gradient layer, rounded border ring"
```

---

### Task 5: `cssframe.ts` — the gap fix, `BoxRun.natural`, rounded and layered slices

**Files:**
- Modify: `src/cssframe.ts`
- Test: `test/cssframe-gap.test.ts`, `test/cssframe-slices.test.ts`

**Interfaces:**
- Consumes: `paintBox`, `BoxPaintSpec`, `LayerSource`, `GradientSpec` (Task 4); `CornerSpec`, `resolveRadii`, `sliceRadii`, `hasRadius`, `BgLayer` (Tasks 1–2).
- Produces:
  - `BoxFrame.radii?: CornerSpec[]` (4, POINTS/frac) and `BoxFrame.layer?: { source: LayerSource; layer: BgLayer }`.
  - `BoxRun` becomes `{ used: number; natural?: (width: number) => number }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/cssframe-gap.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';

const column = (html: string, x = 100) => {
  const d = Document.New(); d.AddHtml(html);
  const png = decodePng(d.Pages[d.Pages.length - 1].ToImage({ dpi: 72 }));
  let s = '';
  for (let y = 0; y < 200; y++) { const [r, g] = png.at(x, y); s += r > 200 && g < 80 ? 'R' : r > 200 ? '.' : '#'; }
  return s;
};

describe('a box background covers the gaps between its children (v9j3.4 Fixed)', () => {
  it('one unbroken red run from the first paragraph to the last', () => {
    const s = column('<div style="background:#ff0000;font-family:Helvetica"><p style="margin:20px 0">AAA</p><p style="margin:20px 0">BBB</p></div>');
    const first = s.indexOf('R'), last = s.lastIndexOf('R');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(s.slice(first, last + 1)).not.toContain('.');               // no white hole
  });
  it('the side borders run through the gap too', () => {
    const s = column('<div style="border-left:6px solid #ff0000;font-family:Helvetica"><p style="margin:20px 0">AAA</p><p style="margin:20px 0">BBB</p></div>', 2);
    const first = s.indexOf('R'), last = s.lastIndexOf('R');
    expect(s.slice(first, last + 1)).not.toContain('.');
  });
});
```

```ts
// test/cssframe-slices.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';

const PARAS = Array.from({ length: 60 }, (_, i) => `<p style="margin:0">line ${i}</p>`).join('');
describe('rounded, layered slices (v9j3.4)', () => {
  it('only the true top and bottom corners are rounded across a page break', () => {
    const d = Document.New();
    d.AddHtml(`<div style="background:#ff0000;border-radius:30px;font-family:Helvetica;font-size:24px">${PARAS}</div>`);
    expect(d.Pages.length).toBeGreaterThan(1);
    const pngs = d.Pages.map((p) => decodePng(p.ToImage({ dpi: 72 })));
    const red = (png: ReturnType<typeof decodePng>, x: number, y: number) => { const [r, g] = png.at(x, y); return r > 200 && g < 80; };
    // page 1: top-left corner cut, bottom-left corner (at the page break) square
    const first = pngs[0];
    const topRow = [...Array(first.height).keys()].find((y) => red(first, 200, y))!;
    expect(red(first, 73, topRow + 1)).toBe(false);
    const bottomRow = [...Array(first.height).keys()].reverse().find((y) => red(first, 200, y))!;
    expect(red(first, 73, bottomRow - 1)).toBe(true);
    // last page: bottom-left corner cut
    const last = pngs[pngs.length - 1];
    const lastBottom = [...Array(last.height).keys()].reverse().find((y) => red(last, 200, y))!;
    expect(red(last, 73, lastBottom - 1)).toBe(false);
  });
  it('a gradient continues across the break: page 2 starts where page 1 ended', () => {
    const d = Document.New();
    d.AddHtml(`<div style="background:linear-gradient(#ff0000, #0000ff);font-family:Helvetica;font-size:24px">${PARAS}</div>`);
    const pngs = d.Pages.map((p) => decodePng(p.ToImage({ dpi: 72 })));
    const blueAt = (png: ReturnType<typeof decodePng>, y: number) => png.at(200, y)[2];
    const p1 = pngs[0];
    const p1Bottom = [...Array(p1.height).keys()].reverse().find((y) => p1.at(200, y)[1] < 80)!;
    const p2 = pngs[1];
    const p2Top = [...Array(p2.height).keys()].find((y) => p2.at(200, y)[1] < 80)!;
    expect(Math.abs(blueAt(p2, p2Top) - blueAt(p1, p1Bottom))).toBeLessThan(12);
  });
});
```

The second file needs Task 6/7 (CSS `border-radius`, `linear-gradient`) to run end to end. Commit it in this task as `it.todo`-free but **skip it here** with `describe.skip` and a comment `// enabled in Task 7`; Task 7 removes the `.skip`. For this task add a direct unit case instead, driving `frameBoxes` with a hand-built `BoxFrame`:

```ts
// append to test/cssframe-slices.test.ts
import { frameBoxes } from '../src/cssframe.js';
import { Flow } from '../src/flow.js';
import { paragraph } from '../src/flow.js';
it('frameBoxes paints a rounded colour box from a hand-built frame', () => {
  const d = Document.New();
  const els = frameBoxes(paragraph('x', { font: 'Helvetica', fontSize: 40 }), {
    marginLeft: 0, marginRight: 0, insetLeft: 0, insetRight: 0, insetTop: 0, insetBottom: 0,
    background: [1, 0, 0], minHeight: 0,
    radii: Array.from({ length: 4 }, () => ({ x: { abs: 20, frac: 0 }, y: { abs: 20, frac: 0 } })),
  });
  d.NewFlow({ marginLeft: 72, marginTop: 72 }).AddElements(els).Render();
  const png = decodePng(d.Pages[d.Pages.length - 1].ToImage({ dpi: 72 }));
  const topRow = [...Array(png.height).keys()].find((y) => png.at(300, y)[1] < 80)!;
  expect(png.at(73, topRow + 1)[1]).toBeGreaterThan(200);           // corner cut: not red
});
```

(Check `Flow`'s option names for margins in `normalizeFlowOptions`; adjust `marginLeft`/`marginTop` to the real ones.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cssframe-gap.test.ts test/cssframe-slices.test.ts`
Expected: FAIL — the gap test finds a hole; the frame test has no `radii`.

- [ ] **Step 3: Implement**

3a. **`BoxFrame`** gains:

```ts
  /** (v9j3.4) Per-corner radii, tl tr br bl, in POINTS (+ frac of the box). */
  radii?: CornerSpec[];
  /** (v9j3.4) One background layer: an image or a gradient. */
  layer?: { source: LayerSource; layer: BgLayer };
```

3b. **The gap fix.** `frameBoxes` computes, per wrapped element `i` that is not last, `gapAfter_i = (el_i.spaceAfter ?? 0) + (el_{i+1}.spaceBefore ?? 0)` over the FLOW elements (floats excluded), and passes it to `BoxElement` as a new constructor argument `gapAfter: number` (0 for the last). A continuation keeps `this.gapAfter`. In `place`, compute

```ts
    // (v9j3.4, Fixed) A non-last slice that fits paints on over the gap that
    // follows it — QuotedElement.paintBar's rule — or a box's background and
    // side borders leave a hole between every pair of children. Bounded by the
    // column bottom; nothing when this slice splits, since nothing follows it here.
    const extend = !this.last && probe.fits
      ? Math.min(this.gapAfter + (ctx.paragraphSpacing ?? 0), avail - probe.usedHeight - pad)
      : 0;
```

paint with `used + Math.max(0, extend)` instead of `used`, and add the same `extend` to `this.run.used`. The RETURNED `usedHeight` stays `used` — the engine still owns the gap.

3c. **`BoxRun.natural`.** In `frameBoxes`, set

```ts
  const flowEls = flow;   // the wrapped inner elements, in order
  run.natural = (innerWidth: number): number => {
    let h = frame.insetTop + frame.insetBottom;
    flowEls.forEach((el, i) => {
      h += el.measure?.({ width: innerWidth, availHeight: OVERFLOW_PROBE }).usedHeight ?? 0;
      if (i < flowEls.length - 1) h += (el.spaceAfter ?? 0) + (flowEls[i + 1].spaceBefore ?? 0);
    });
    return Math.max(h, frame.minHeight);
  };
```

with `const OVERFLOW_PROBE = 1e6;` (flow.ts's value — copy the constant and say so in a comment; do not import flow.ts, which this module must not).

3d. **Painting.** In `paint(ctx, used)` keep the existing body as the path taken when `!hasRadius(...)` AND `f.layer === undefined`. Otherwise:

```ts
    const H = this.first && this.last ? used : (this.run.natural?.(this.geo(ctx.width).width) ?? used);
    const radii = sliceRadii(resolveRadii(f.radii ?? [], bw, H), this.first, this.last);
    const before = this.run.used;           // height painted ABOVE this slice
    const edges = {
      left: f.borderLeft, right: f.borderRight,
      top: this.first ? f.borderTop : undefined, bottom: this.last ? f.borderBottom : undefined,
    };
    const borderTopW = f.borderTop?.width ?? 0, borderLeftW = f.borderLeft?.width ?? 0;
    const area = f.layer && {
      x: bx + borderLeftW, top: ctx.top + before - borderTopW,
      w: bw - borderLeftW - (f.borderRight?.width ?? 0),
      h: H - borderTopW - (f.borderBottom?.width ?? 0),
    };
    paintBox(ctx.doc, ctx.page, {
      x: bx, y: bottom, w: bw, h: used, radii, color: f.background, edges,
      ...(f.layer && area ? { layer: { ...f.layer, area } } : {}),
    }, ctx.structParent !== undefined);
```

`resolveRadii([], …)` returns `ZERO_RADII` (Task 1). `hasRadius` is asked of `resolveRadii(f.radii ?? [], bw, H)` before choosing the path.

- [ ] **Step 4: Run the tests and the fences**

Run: `npx vitest run test/cssframe-gap.test.ts test/cssframe-slices.test.ts test/cssframe.test.ts test/html-identity.test.ts test/css-box.test.ts test/flow-narrow-nesting.test.ts`
Expected: the new tests PASS. `html-identity`: if a hash moves, render the fixture before and after (`git stash` the change), confirm the ONLY difference is filled gaps inside a coloured or bordered box, and update that hash with a test comment `// v9j3.4 gap fix: <fixture> fills the gap between its children`. Any other difference is a bug.

- [ ] **Step 5: Commit**

```bash
git add src/cssframe.ts test/cssframe-gap.test.ts test/cssframe-slices.test.ts test/html-identity.test.ts
git commit -m "fix(v9j3.4): a box background covers the gaps between its children; rounded and layered slices"
```

---

### Task 6: CSS grammar — `cssbackground.ts`, nine longhands, three shorthands

**Files:**
- Create: `src/cssbackground.ts`
- Modify: `src/cssprop.ts` (`ComputedStyle`, nine rows), `src/cssshorthand.ts`
- Modify: `test/cssprop.test.ts` (43 → 52)
- Test: `test/cssbackground.test.ts`

**Interfaces:**
- Produces, in `cssbackground.ts` (pure leaf over `cssvalue.js`/`cssparse.js`/`csstoken.js` types):
  ```ts
  export type RadiusValue = [LengthPct, LengthPct];
  export interface CssStop { color: Color; pos?: LengthPct }
  export type BgImageValue =
    | { kind: 'none' } | { kind: 'url'; url: string }
    | { kind: 'linear'; angle?: number; to?: [-1 | 0 | 1, -1 | 0 | 1]; stops: CssStop[] }
    | { kind: 'radial'; shape: 'circle' | 'ellipse';
        extent: 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner' | [LengthPct, LengthPct];
        at: [LengthPct, LengthPct]; stops: CssStop[] };
  export type BgSizeValue = 'cover' | 'contain' | [LengthPct | 'auto', LengthPct | 'auto'];
  export type BgRepeatValue = ['repeat' | 'no-repeat', 'repeat' | 'no-repeat'];
  export function computeRadius(v: CssValue[], c: LengthContext): RadiusValue | undefined;
  export function computeBgImage(v: CssValue[], c: LengthContext): BgImageValue | undefined;
  export function computeBgSize(v: CssValue[], c: LengthContext): BgSizeValue | undefined;
  export function computeBgRepeat(v: CssValue[]): BgRepeatValue | undefined;
  export function computeBgPosition(axis: 'x' | 'y', v: CssValue[], c: LengthContext): LengthPct | undefined;
  export function splitPosition(parts: CssValue[][]): [CssValue[], CssValue[]] | undefined;
  export function splitRadius(parts: CssValue[][]): [CssValue[], CssValue[], CssValue[], CssValue[]] | undefined;
  export function splitBackground(v: CssValue[]): Record<string, CssValue[]> | undefined;
  ```
- `ComputedStyle` gains `borderTopLeftRadius`, `borderTopRightRadius`, `borderBottomRightRadius`, `borderBottomLeftRadius: RadiusValue`; `backgroundImage: BgImageValue`; `backgroundSize: BgSizeValue`; `backgroundRepeat: BgRepeatValue`; `backgroundPositionX`, `backgroundPositionY: LengthPct`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/cssbackground.test.ts
import { describe, it, expect } from 'vitest';
import { cascadeStyleOf } from './helpers/css-style.js';

describe('CSS backgrounds and radii (v9j3.4)', () => {
  const s = (decl: string) => cascadeStyleOf(`<div style="${decl}"></div>`, 'div');

  it('border-radius: 1 to 4 values and the slash form', () => {
    const a = s('border-radius: 10px 20px / 5px');
    expect(a.borderTopLeftRadius).toEqual([{ px: 10, pct: 0 }, { px: 5, pct: 0 }]);
    expect(a.borderTopRightRadius).toEqual([{ px: 20, pct: 0 }, { px: 5, pct: 0 }]);
    expect(a.borderBottomRightRadius[0]).toEqual({ px: 10, pct: 0 });
    expect(s('border-top-left-radius: 50%').borderTopLeftRadius).toEqual([{ px: 0, pct: 50 }, { px: 0, pct: 50 }]);
  });
  it('a negative radius is invalid', () => {
    expect(s('border-radius: -4px').borderTopLeftRadius).toEqual([{ px: 0, pct: 0 }, { px: 0, pct: 0 }]);
  });
  it('background-image: url, linear and radial', () => {
    expect(s('background-image: url(x.png)').backgroundImage).toEqual({ kind: 'url', url: 'x.png' });
    expect(s('background-image: url("y.png")').backgroundImage).toEqual({ kind: 'url', url: 'y.png' });
    const lin = s('background-image: linear-gradient(to top right, red, blue 80%)').backgroundImage;
    expect(lin).toMatchObject({ kind: 'linear', to: [1, -1] });
    expect((lin as { stops: unknown[] }).stops).toHaveLength(2);
    expect(s('background-image: linear-gradient(0.25turn, red, blue)').backgroundImage).toMatchObject({ angle: 90 });
    expect(s('background-image: radial-gradient(circle closest-side at 10px 50%, red, blue)').backgroundImage)
      .toMatchObject({ kind: 'radial', shape: 'circle', extent: 'closest-side', at: [{ px: 10, pct: 0 }, { px: 0, pct: 50 }] });
    expect(s('background-image: radial-gradient(red, blue)').backgroundImage)
      .toMatchObject({ shape: 'ellipse', extent: 'farthest-corner', at: [{ pct: 50 }, { pct: 50 }] });
  });
  it('refuses what is out of scope: layers, repeating, conic, colour hints', () => {
    for (const v of ['url(a.png), url(b.png)', 'repeating-linear-gradient(red, blue)', 'conic-gradient(red, blue)',
      'linear-gradient(red, 30%, blue)'])
      expect(s(`background-image: ${v}`).backgroundImage).toEqual({ kind: 'none' });
  });
  it('size, repeat and position', () => {
    expect(s('background-size: cover').backgroundSize).toBe('cover');
    expect(s('background-size: 50% auto').backgroundSize).toEqual([{ px: 0, pct: 50 }, 'auto']);
    expect(s('background-repeat: repeat-x').backgroundRepeat).toEqual(['repeat', 'no-repeat']);
    expect(s('background-repeat: space').backgroundRepeat).toEqual(['repeat', 'repeat']);   // refused -> initial
    const p = s('background-position: right 10px bottom');
    expect(p.backgroundPositionX).toEqual({ px: -10, pct: 100 });
    expect(p.backgroundPositionY).toEqual({ px: 0, pct: 100 });
    expect(s('background-position: center').backgroundPositionX).toEqual({ px: 0, pct: 50 });
  });
  it('the background shorthand carries colour, image, position / size and repeat', () => {
    const b = s('background: #00ff00 url(x.png) center / contain no-repeat');
    expect(b.backgroundColor.rgb).toEqual([0, 1, 0]);
    expect(b.backgroundImage).toEqual({ kind: 'url', url: 'x.png' });
    expect(b.backgroundSize).toBe('contain');
    expect(b.backgroundRepeat).toEqual(['no-repeat', 'no-repeat']);
    expect(b.backgroundPositionY).toEqual({ px: 0, pct: 50 });
  });
  it('the shorthand resets what it does not mention', () => {
    const b = cascadeStyleOf('<div style="background-size: cover; background: red"></div>', 'div');
    expect(b.backgroundSize).toEqual(['auto', 'auto']);
  });
});
```

`cascadeStyleOf(html, tag)` — check `test/helpers/` for the existing way cascade tests get an element's `ComputedStyle` (grep `computeStyles(` in `test/css*.test.ts`) and either reuse it or add this helper in `test/helpers/css-style.ts` built from the same calls.

Update `test/cssprop.test.ts`: `holds exactly 52 longhands` / `toBe(52)`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cssbackground.test.ts test/cssprop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

3a. **`src/cssbackground.ts`.** Write the grammar with these rules (each is a test above):
- Angles: `deg`, `grad` (× 0.9), `rad` (× 180/π), `turn` (× 360); a unitless `0` is 0deg. Normalize into [0, 360).
- `to` + 1 or 2 of `top|bottom|left|right` → `to: [sx, sy]` with left −1, right 1, top −1, bottom 1, unmentioned 0.
- A stop is `<color> <lp>? <lp>?`; two positions emit two stops of the same colour. A lone `<lp>` between stops (a colour hint) → `undefined`. At least two stops, or `undefined`.
- Radial prefix: `circle`/`ellipse` and an extent keyword in either order, or explicit sizes (`<length>` for a circle, two `<lp>` for an ellipse); then `at <position>` parsed by the SAME position grammar as `background-position` (reuse `splitPosition` + `computeBgPosition`). Default `ellipse farthest-corner at 50% 50%`; a lone length with no shape keyword means `circle`.
- `url` arrives as a `url` token or as a function `url` holding one string; both give `{ kind: 'url', url }`.
- `computeBgImage` refuses (returns `undefined`) on a top-level comma (multiple layers), any function name other than `url`/`linear-gradient`/`radial-gradient`; `none` → `{ kind: 'none' }`.
- Size: `cover`, `contain`, or one or two of `auto | <lp>`; one value means the second is `auto`; negatives refused.
- Repeat: `repeat-x` → `['repeat','no-repeat']`, `repeat-y` → reverse, one or two of `repeat|no-repeat`; `space`/`round` → `undefined` (the cascade then reports it and keeps the initial `['repeat','repeat']`).
- Position axis: `left|center|right` (x) or `top|center|bottom` (y) → `{px: 0, pct: 0|50|100}`, a `<lp>`, or edge + offset: `right 10px` → `{px: -10, pct: 100}`, `left 10px` → `{px: 10, pct: 0}`.
- `splitPosition(parts)`: 1 value → (v, center) unless it is `top`/`bottom` → (center, v); 2 values → (x, y) unless the first is `top`/`bottom` or the second `left`/`right`, which swaps; 3–4 values → edge-offset pairs. Return the token lists each longhand will re-parse.
- `splitBackground(v)`: refuse a top-level comma; walk the parts, assigning a colour (`colorOf`), an image (`url`, gradient function, `none`), repeat keywords, `scroll` (accepted, ignored), `fixed`/`local`/a box keyword (→ `undefined`), and position tokens up to an optional `/` followed by size tokens. Return `{ 'background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat' }`, each the tokens found or `INITIAL`.

3b. **`src/cssprop.ts`** — add the eight `ComputedStyle` fields and the nine rows, none inherited:

```ts
  ['border-top-left-radius', def('borderTopLeftRadius', false, [ZERO_LENGTH, ZERO_LENGTH], (v, c) => computeRadius(v, lc(c)))],
  ['border-top-right-radius', def('borderTopRightRadius', false, [ZERO_LENGTH, ZERO_LENGTH], (v, c) => computeRadius(v, lc(c)))],
  ['border-bottom-right-radius', def('borderBottomRightRadius', false, [ZERO_LENGTH, ZERO_LENGTH], (v, c) => computeRadius(v, lc(c)))],
  ['border-bottom-left-radius', def('borderBottomLeftRadius', false, [ZERO_LENGTH, ZERO_LENGTH], (v, c) => computeRadius(v, lc(c)))],
  ['background-image', def('backgroundImage', false, { kind: 'none' }, (v, c) => computeBgImage(v, lc(c)))],
  ['background-size', def('backgroundSize', false, ['auto', 'auto'], (v, c) => computeBgSize(v, lc(c)))],
  ['background-repeat', def('backgroundRepeat', false, ['repeat', 'repeat'], (v) => computeBgRepeat(v))],
  ['background-position-x', def('backgroundPositionX', false, ZERO_LENGTH, (v, c) => computeBgPosition('x', v, lc(c)))],
  ['background-position-y', def('backgroundPositionY', false, ZERO_LENGTH, (v, c) => computeBgPosition('y', v, lc(c)))],
```

with `const lc = (c: PropContext) => ({ fontSize: c.fontSize, rootFontSize: c.rootFontSize });`. `computeBgImage` resolves stop colours with `colorOf`, and `currentcolor` against `c.color` — pass `c.color` through a third argument. Update the "43 rows" comment.

3c. **`src/cssshorthand.ts`**: add `'border-radius'` and `'background-position'` to `SHORTHANDS`; `GOVERNS` gains `'border-radius'` (the four), `'background-position'` (x, y), and `background` becomes the six longhands. Cases:

```ts
    case 'border-radius': {
      const r = splitRadius(p);   // [tl, tr, br, bl], each `h v` tokens or `h`
      return r === undefined ? undefined
        : (['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const).map((k, i) => [`border-${k}-radius`, r[i]]);
    }
    case 'background-position': {
      const xy = splitPosition(p);
      return xy === undefined ? undefined : [['background-position-x', xy[0]], ['background-position-y', xy[1]]];
    }
    case 'background': {
      const m = splitBackground(trimWs(v));
      return m === undefined ? undefined : Object.entries(m) as [string, CssValue[]][];
    }
```

`splitRadius(parts)` splits at a `/` delim into horizontal and vertical lists, applies the 1-to-4 box rule to each, and joins each corner's `h` and `v` (or `h` alone, which `computeRadius` reads as `h h`). Replace the comment above the old `background` case: an image is now IN scope; what is still refused is what `splitBackground` refuses.

- [ ] **Step 4: Run the tests and the CSS suites**

Run: `npx vitest run test/cssbackground.test.ts test/cssprop.test.ts test/cssshorthand.test.ts test/csscascade.test.ts test/cssvar.test.ts test/css-cascade-goldens.test.ts`
Expected: PASS. A pre-existing case asserting `background: red url(x.png)` is REFUSED must now be updated to assert it is ACCEPTED — that is this issue's intended change; say so in the test comment.

- [ ] **Step 5: Commit**

```bash
git add src/cssbackground.ts src/cssprop.ts src/cssshorthand.ts test/cssbackground.test.ts test/cssprop.test.ts test/
git commit -m "feat(v9j3.4): CSS border-radius, background-image (url, linear, radial), size, repeat, position"
```

---

### Task 7: `cssflow.ts` — computed values to a frame, image resolution and reporting

**Files:**
- Modify: `src/cssflow.ts` (`frameOf(r, c)` and its five call sites)
- Modify: `test/cssframe-slices.test.ts` (remove the `.skip`)
- Test: `test/html-background.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces: `BoxFrame.radii` / `BoxFrame.layer` filled from `ComputedStyle`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/html-background.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { solidPng } from './helpers/solid-png.js';

const PNG = solidPng(4, 4, [0, 200, 0]);
const uri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const shot = (html: string, o: object = {}) => {
  const d = Document.New(); const r = d.AddHtml(html, o);
  return { r, png: decodePng(d.Pages[d.Pages.length - 1].ToImage({ dpi: 72 })) };
};

describe('HTML backgrounds (v9j3.4)', () => {
  it('a data: URI background tiles over the box', () => {
    const { png } = shot(`<div style="width:200px;height:100px;background:url(${uri})"></div>`);
    expect(png.at(100, 60)[1]).toBeGreaterThan(150);
  });
  it('resolveImage supplies a relative src', () => {
    const { png } = shot('<div style="width:200px;height:100px;background-image:url(tile.png)"></div>',
      { resolveImage: (src: string) => (src === 'tile.png' ? PNG : undefined) });
    expect(png.at(100, 60)[1]).toBeGreaterThan(150);
  });
  it('an unresolvable image is reported once and the colour still paints', () => {
    const { r, png } = shot('<div style="width:200px;height:100px;background:#ff0000 url(missing.png)"></div>');
    expect(png.at(100, 60)).toEqual([255, 0, 0, 255]);
    const recs = r.skipped.filter((s) => s.construct === 'image' && s.detail === 'background-image: missing.png');
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe('dropped');
  });
  it('border-radius in px is converted to points', () => {
    const { png } = shot('<div style="width:200px;height:100px;background:#ff0000;border-radius:40px"></div>');
    // 40px = 30pt: 4pt into the corner diagonal is outside the curve
    const top = [...Array(png.height).keys()].find((y) => png.at(150, y)[1] < 80)!;
    expect(png.at(76, top + 4)[1]).toBeGreaterThan(200);
  });
});
```

Check `AddHtml`'s return and `skipped` record shape (`r.skipped`, `NotRendered.detail`) in `src/document.ts`; adapt the accessors, not the assertions.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/html-background.test.ts`
Expected: FAIL — no image painted.

- [ ] **Step 3: Implement in `src/cssflow.ts`**

```ts
const PT = 0.75;
/** A computed LengthPct to boxpaint's Len, crossing px -> pt here. A math
 *  expression is sampled at basis 0 and 100 — exact for calc(), an
 *  approximation for min()/max() (recorded in CLAUDE.md). */
function lenPt(v: LengthPct): Len {
  if (!('expr' in v)) return { abs: v.px * PT, frac: v.pct / 100 };
  const a = resolveLengthPct(v, 0), b = resolveLengthPct(v, 100);
  return { abs: a * PT, frac: (b - a) / 100 };
}

function radiiOf(s: ComputedStyle): CornerSpec[] | undefined {
  const c = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
  if (c.every(([h, v]) => fixedPx(h) === 0 || fixedPx(v) === 0)) return undefined;
  return c.map(([h, v]) => ({ x: lenPt(h), y: lenPt(v) }));
}

function layerOf(s: ComputedStyle, el: HtmlElement, c: MapCtx): BoxFrame['layer'] {
  const img = s.backgroundImage;
  if (img.kind === 'none') return undefined;
  const layer: BgLayer = {
    size: s.backgroundSize === 'cover' || s.backgroundSize === 'contain' ? s.backgroundSize
      : [s.backgroundSize[0] === 'auto' ? 'auto' : lenPt(s.backgroundSize[0]),
         s.backgroundSize[1] === 'auto' ? 'auto' : lenPt(s.backgroundSize[1])],
    posX: lenPt(s.backgroundPositionX), posY: lenPt(s.backgroundPositionY),
    repeatX: s.backgroundRepeat[0] === 'repeat', repeatY: s.backgroundRepeat[1] === 'repeat',
  };
  if (img.kind === 'url') {
    const data = decodeDataUri(img.url) ?? c.resolveImage?.(img.url, '');
    let built: BuiltImage | undefined;
    if (data !== undefined) {
      try { built = buildImageXObject(data); } catch (caught) { rethrowLimit(caught); }
    }
    if (built === undefined) {
      c.skipped.push({ el, kind: 'dropped', construct: 'image', detail: `background-image: ${img.url}` });
      return undefined;
    }
    const w = built.stream.dict.get('Width'), h = built.stream.dict.get('Height');
    if (typeof w !== 'number' || typeof h !== 'number') return undefined;
    return { source: { kind: 'image', built, width: w * PT, height: h * PT }, layer };
  }
  const stops = img.stops.map((st) => ({ color: st.color.rgb, alpha: st.color.a, ...(st.pos ? { pos: lenPt(st.pos) } : {}) }));
  const g: GradientSpec = img.kind === 'linear'
    ? { kind: 'linear', ...(img.to ? { to: img.to } : { angle: img.angle ?? 180 }), stops }
    : { kind: 'radial', shape: img.shape,
        extent: Array.isArray(img.extent) ? { rx: lenPt(img.extent[0]), ry: lenPt(img.extent[1]) } : img.extent,
        at: [lenPt(img.at[0]), lenPt(img.at[1])], stops };
  return { source: { kind: 'gradient', g }, layer };
}
```

`frameOf(r)` becomes `frameOf(r, c)` and adds `radii: radiiOf(s)` and `layer: layerOf(s, r.box.el, c)` (spread only when defined, so a plain box's frame object is unchanged). `MapCtx` is the existing mapper context type holding `skipped` and `resolveImage` — use its real name. `r.box.el` may be `null` for an anonymous box: an anonymous box carries its parent's style, so pass `undefined` for the layer there (CSS paints a background on the element's own box, not on anonymous wrappers).

Then remove `describe.skip` from `test/cssframe-slices.test.ts`.

- [ ] **Step 4: Run the tests and the fences**

Run: `npx vitest run test/html-background.test.ts test/cssframe-slices.test.ts test/html-identity.test.ts test/htmlreport-render.test.ts test/cssflow.test.ts`
Expected: PASS, `html-identity` unchanged from Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/cssflow.ts test/html-background.test.ts test/cssframe-slices.test.ts
git commit -m "feat(v9j3.4): HTML boxes paint border-radius and background-image layers"
```

---

### Task 8: `FloatingBox` — `radius`, gradient `background`, `backgroundImage`

**Files:**
- Modify: `src/floatbox.ts`
- Modify: `src/index.ts` (export `BoxGradient`, `FloatBoxRadius`, `FloatBoxBackgroundImage` types)
- Test: `test/floatbox-decor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FloatBoxCorner = number | [number, number];
  export type FloatBoxRadius = number | { topLeft?: FloatBoxCorner; topRight?: FloatBoxCorner; bottomRight?: FloatBoxCorner; bottomLeft?: FloatBoxCorner };
  export type BoxGradient =
    | { kind: 'linear'; angle?: number; stops: GradientStop[] }
    | { kind: 'radial'; shape?: 'circle' | 'ellipse';
        size?: 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner'; at?: [number, number]; stops: GradientStop[] };
  export interface FloatBoxBackgroundImage { data: Uint8Array; fit?: 'stretch' | 'cover' | 'contain' | 'tile' | 'none'; format?: 'jpeg' | 'png' | 'bmp' | 'tiff' }
  // FloatBoxOptions gains: radius?: FloatBoxRadius; background?: [number, number, number] | BoxGradient; backgroundImage?: FloatBoxBackgroundImage
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/floatbox-decor.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { solidPng } from './helpers/solid-png.js';

const place = (opts: object) => {
  const d = Document.New();
  const box = d.NewFloatingBox({ width: 200, padding: 10, ...opts });
  box.AddParagraph(' ');
  box.paintAt(d.Pages[0], 100, 700);
  return { d, png: decodePng(Document.Open(d.Save()).Pages[0].ToImage({ dpi: 72 })) };
};
const at = (png: ReturnType<typeof decodePng>, x: number, y: number) => png.at(x, png.height - y);

describe('FloatingBox decoration (v9j3.4)', () => {
  it('radius rounds the background', () => {
    const { png } = place({ background: [1, 0, 0], radius: 15 });
    expect(at(png, 200, 690)).toEqual([255, 0, 0, 255]);
    expect(at(png, 101, 699)).toEqual([255, 255, 255, 255]);
  });
  it('per-corner and [rx, ry] corners', () => {
    const { png } = place({ background: [1, 0, 0], radius: { topLeft: 0, topRight: [30, 10] } });
    expect(at(png, 101, 699)).toEqual([255, 0, 0, 255]);              // square top-left
  });
  it('a box-relative linear gradient, 180deg runs top to bottom', () => {
    const { png } = place({ background: { kind: 'linear', angle: 180,
      stops: [{ offset: 0, color: [1, 0, 0], opacity: 1 }, { offset: 1, color: [0, 0, 1], opacity: 1 }] } });
    const top = at(png, 200, 698), bottom = at(png, 200, 682);
    expect(top[0]).toBeGreaterThan(bottom[0]);
  });
  it('backgroundImage stretches by default', () => {
    const { png } = place({ backgroundImage: { data: solidPng(2, 2, [0, 200, 0]) } });
    expect(at(png, 290, 682)[1]).toBeGreaterThan(150);
  });
  it('validates before drawing', () => {
    const d = Document.New();
    expect(() => d.NewFloatingBox({ width: 100, radius: -1 })).toThrow(RangeError);
    expect(() => d.NewFloatingBox({ width: 100, radius: Number.NaN })).toThrow(TypeError);
    expect(() => d.NewFloatingBox({ width: 100, backgroundImage: { data: solidPng(1, 1, [0, 0, 0]), fit: 'x' as never } })).toThrow(TypeError);
    expect(() => d.NewFloatingBox({ width: 100, backgroundImage: { data: new Uint8Array([1, 2, 3]) } })).toThrow();
  });
  it('a box with none of these options paints byte-identically to before', () => {
    const d1 = Document.New(); const b1 = d1.NewFloatingBox({ width: 100, background: [1, 0, 0], border: { width: 1, color: [0, 0, 0] } });
    b1.AddParagraph('x'); b1.paintAt(d1.Pages[0], 100, 700);
    expect(new TextDecoder().decode(d1.Pages[0].Contents)).toMatch(/1 0 0 rg\n[\d. ]+ re\nf/);
  });
});
```

(The last case pins the old `PageGraphics` path is still taken; the existing `test/floatbox*.test.ts` files are the byte fence.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/floatbox-decor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Validate in the constructor: a radius corner is a finite number or a pair of finite numbers (`TypeError` otherwise), each `>= 0` (`RangeError`); `fit` in the five names (`TypeError`); a gradient through `validateGradient`-equivalent checks on `stops` (each `offset` in 0..1, `color` valid, ≥ 2 stops; `TypeError`); `angle` finite; `size` among the four keywords; `at` two finite numbers. Build the image with `buildImageXObject(data, format)` in the constructor so bad bytes throw before anything is drawn.
- Store `this.radii?: CornerSpec[]` (`{x:{abs:rx,frac:0}, y:{abs:ry,frac:0}}`), `this.gradient?: GradientSpec`, `this.image?: { built, width, height }` (natural size = pixels × 0.75, as `<img>`), `this.fit`.
- `fit` presets (one rule, the CSS one): `stretch` → size `[{abs:0,frac:1},{abs:0,frac:1}]`, no-repeat; `cover`/`contain` → that size, position 50%/50%, no-repeat; `tile` → `['auto','auto']`, repeat both, position 0; `none` → `['auto','auto']`, no-repeat, position 0.
- A `BoxGradient` lowers to `GradientSpec`: linear `{ kind:'linear', angle: g.angle ?? 180, stops }`; radial `{ kind:'radial', shape: g.shape ?? 'ellipse', extent: g.size ?? 'farthest-corner', at: [{abs:0,frac:at[0]},{abs:0,frac:at[1]}] (default 0.5, 0.5) }`; each stop `{ color, alpha: opacity ?? 1, pos: { abs: 0, frac: offset } }`.
- In `paintAt`: if none of `radii` (with a positive corner), `gradient`, `image` is present, run the existing chrome code unchanged. Otherwise call `paintBox(doc, page, spec, structParent !== undefined)` with the whole box (`first`/`last` both true, so no slicing), `edges` from `border` and `sides` (a side not drawn is `undefined`), `color` when `background` is an RGB triple, and `layer` with `area` = the padding box (border box inset by `borderWidth`) for the image, OR for the gradient (a box with both: the image is the layer and the gradient is ignored — reject both together in validation with a `TypeError`, "background gradient and backgroundImage are exclusive", since one layer is in scope).

- [ ] **Step 4: Run the tests and the fence**

Run: `npx vitest run test/floatbox-decor.test.ts test/floatbox.test.ts test/flow-floats.test.ts`
Expected: PASS, existing FloatingBox tests unedited.

- [ ] **Step 5: Commit**

```bash
git add src/floatbox.ts src/index.ts test/floatbox-decor.test.ts
git commit -m "feat(v9j3.4): FloatingBox radius, gradient background and backgroundImage"
```

---

### Task 9: the Chrome oracles — pixels and computed values

**Files:**
- Create: `test/helpers/box-paint-fixtures.ts`, `scripts/gen-box-paint-goldens.ts`, `test/box-paint-oracle.test.ts`, `test/fixtures/box-paint/PROVENANCE.md`, `test/fixtures/box-paint/*.png`
- Modify: `scripts/gen-cascade-goldens.ts` (new cases), `test/helpers/cascade-goldens.ts` (`KEY_OF` and comparison for the new properties), `test/fixtures/css-cascade/goldens.json` (regenerated)

- [ ] **Step 1: The fixtures.** `test/helpers/box-paint-fixtures.ts` exports `BOX_PAINT_FIXTURES: { id: string; html: string; width: number; height: number }[]`, each a TEXT-FREE page body (`<div>`s only, `margin:0` on `html`/`body`, explicit `width`/`height` in px, no fonts involved):
  `radius-uniform`, `radius-per-corner`, `radius-elliptical-slash`, `radius-50pct-nonsquare`, `radius-overlap-pill`, `border-widths-rounded`, `border-colors-rounded`, `image-no-repeat`, `image-repeat-x`, `image-cover`, `image-contain-center`, `image-position-right-bottom`, `linear-to-right`, `linear-to-top-right-nonsquare`, `linear-angle-stops-outside`, `radial-ellipse-default`, `radial-circle-closest-side-at`, `gradient-transparent-stop`. Images are `data:` URIs of small PNGs built with `solidPng(4, 4, rgb, quadrants)` (non-uniform pixels, so position and tiling errors show).

- [ ] **Step 2: The generator.** `scripts/gen-box-paint-goldens.ts` follows `scripts/gen-svg-goldens.ts`: `npm i --no-save tsx puppeteer`, the same `CHROME_ARGS`, `setViewport({ width, height, deviceScaleFactor: 1 })`, `page.setContent('<!doctype html><style>html,body{margin:0;padding:0;background:#fff}</style>' + html)`, screenshot the clip, write `test/fixtures/box-paint/<id>.png`, print SHA-256s.

- [ ] **Step 3: Run it** (on a machine with Chrome): `npx tsx scripts/gen-box-paint-goldens.ts`. Commit the PNGs.

- [ ] **Step 4: The test.**

```ts
// test/box-paint-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { diffImages } from './helpers/compare-image.js';
import { BOX_PAINT_FIXTURES } from './helpers/box-paint-fixtures.js';

// Chrome renders CSS px at 1 device pixel; our page is points, so the PDF is
// rendered at 96 dpi to land on the same grid. A box's origin is the page's
// top-left with zero margins, which AddHtml's own margins must be set to.
describe('box painting matches Chrome (v9j3.4 oracle)', () => {
  for (const fx of BOX_PAINT_FIXTURES) {
    it(fx.id, () => {
      const d = Document.New();
      d.AddHtml(fx.html, { format: { width: fx.width * 0.75, height: fx.height * 0.75 }, margin: 0 } as never);
      const ours = decodePng(d.Pages[d.Pages.length - 1].ToImage({ dpi: 96 }));
      const chrome = decodePng(readFileSync(join(__dirname, 'fixtures', 'box-paint', `${fx.id}.png`)));
      const diff = diffImages(ours, chrome);
      // Antialiasing differs along curves; the bound is on the FRACTION of
      // pixels off by more than DIFF_PIXEL_TOL, measured and recorded in PROVENANCE.
      expect(diff.failFraction).toBeLessThan(0.01);
    });
  }
});
```

Check `diffImages`' result field names in `test/helpers/compare-image.ts` and the real `AddHtml` options for page size and margins (`HtmlFlowOptions & FlowOptions`); use those names. If our page cannot be sized to exactly the fixture, crop `ours` to `fx.width × fx.height` before diffing (write the crop as a small helper in the test).

Run once and record each fixture's measured `failFraction` in `PROVENANCE.md`. A fixture above 1% is a finding: investigate before loosening anything.

- [ ] **Step 5: Cascade goldens.** Add cases to `scripts/gen-cascade-goldens.ts`:
  `{ id: 'border-radius', html: '<div style="border-radius:10px 20px / 5px"></div><p style="border-top-left-radius:50%"></p>', props: ['border-top-left-radius', 'border-top-right-radius'] }`,
  `{ id: 'background-longhands', html: '<div style="background: red center / contain no-repeat"></div>', props: ['background-size', 'background-repeat', 'background-position-x', 'background-position-y'] }`.
  In `test/helpers/cascade-goldens.ts` add the six names to `KEY_OF` and a comparison: Chrome reports `10px 5px` (or `10px` when equal) for a radius, `contain`/`auto`/`50% auto` for size, `no-repeat`/`repeat no-repeat` for repeat (Chrome serializes `repeat-x` as `repeat-x` — compare by expanding Chrome's string to the pair), `50%`/`calc(100% - 10px)`/`0%` for a position. A percentage-bearing value is compared by its serialized form, not resolved. Regenerate with `npx tsx scripts/gen-cascade-goldens.ts` and run `npx vitest run test/css-cascade-goldens.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-box-paint-goldens.ts scripts/gen-cascade-goldens.ts test/helpers/box-paint-fixtures.ts test/helpers/cascade-goldens.ts test/box-paint-oracle.test.ts test/fixtures/box-paint test/fixtures/css-cascade
git commit -m "test(v9j3.4): Chrome pixel oracle for box painting; cascade goldens for the new longhands"
```

---

### Task 10: documentation, tagging check, mutation sweep, full gates

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- Test: `test/box-paint-tagged.test.ts`

- [ ] **Step 1: Tagging.**

```ts
// test/box-paint-tagged.test.ts
import { it, expect } from 'vitest';
import { Document } from '../src/document.js';
it('a tagged flow with rounded, layered boxes still passes ValidatePdfUa', () => {
  const d = Document.New();
  d.AddHtml('<div style="background:linear-gradient(red,blue);border-radius:12px;border:2px solid black;font-family:Helvetica"><p>One</p><p>Two</p></div>', { tagged: true, title: 'T', lang: 'en' } as never);
  const r = Document.Open(d.Save()).ValidatePdfUa();
  expect(r.Errors.filter((e) => e.Rule === 'UntaggedContent')).toEqual([]);
});
```

(Check `ValidatePdfUa`'s report field names and `AddHtml`'s tagged option names.)

- [ ] **Step 2: README.** A Key Capabilities line beside Floating boxes; an example under the FloatingBox section and one under HTML:

```ts
doc.NewFloatingBox({ width: 220, padding: 10, radius: 12,
  border: { width: 1, color: [0.7, 0.7, 0.8] },
  background: { kind: 'linear', angle: 180, stops: [
    { offset: 0, color: [1, 1, 1] }, { offset: 1, color: [0.9, 0.92, 1] }] } });

doc.AddHtml('<div style="border-radius:8px; background:#fff url(logo.png) right 8px top 8px / 48px no-repeat">…</div>',
  { resolveImage: (src) => readFileSync(src) });
```

API rows for `BoxGradient`, `FloatBoxRadius`, `FloatBoxCorner`, `FloatBoxBackgroundImage`; run `npx vitest run test/readme-api.test.ts` and copy the counts. Limitations: one background layer; no `repeating-*`/`conic` gradients, `space`/`round`, `background-clip`/`origin`/`attachment`; a dashed/dotted border with a radius draws solid; a FloatingBox takes an image OR a gradient.

- [ ] **Step 3: CHANGELOG.** `### Added`: rounded corners and background images/gradients on FloatingBox and HTML boxes — what it does, `box-decoration-break: slice`, the Chrome oracle and its measured agreement — `(v9j3.4)`. `### Fixed`: a CSS box's background and side borders left a white gap between consecutive children (any `<div>` with a background holding margined paragraphs), because each child painted only its own height — `(v9j3.4)`.

- [ ] **Step 4: CLAUDE.md.** Entries for `boxpaint.ts`, `boxdraw.ts`, `cssbackground.ts` in the Source list (invariants: pure leaf; one geometry owner; paint order; whole-box layer clipped per slice; percentages against border box; overlap scaling; the gap rule and why the returned `usedHeight` is unchanged; `BoxRun.natural`; `lenPt`'s calc sampling); under `cssframe.ts` the gap fix; under `gradient.ts`/`graphics.ts` the internal matrix path. Run the module sweep from Conventions and confirm it prints nothing.

- [ ] **Step 5: Mutation sweep.** A node script in the scratchpad (the v9j3.1 harness shape: apply, run, restore; ERROR on a load failure, TIMEOUT on a timeout) over at least: overlap factor `min`→`max`; `sliceRadii` keeps all corners; `innerRadii` drops the floor; even-odd ring → nonzero fill; wedge clip skipped when colours differ; `tileSize` cover↔contain; `tileOrigin` frac applied to the area not `area − tile`; `cornerAngle` sign; `linearLine` length `|w cos|+|h sin|`; `placeStops` drops the clamp; `fitStops` clamps instead of extending; ellipse matrix omitted; gap `extend` dropped; `extend` not added to `run.used`; `natural` ignores gaps; `lenPt` drops ×0.75; image report missing; `splitPosition` swap rule dropped; `repeat-x` mapped to both. Each GREEN result gets a case or a CLAUDE.md note saying why it is equivalent.

- [ ] **Step 6: Full gates, commit, push, close.**

```bash
npm run typecheck && npm test
git add README.md CHANGELOG.md CLAUDE.md test/box-paint-tagged.test.ts
git commit -m "docs(v9j3.4): rounded corners and background images — README, CHANGELOG, CLAUDE.md"
git pull --rebase --autostash && git push
bd close aspose-pdf-foss-for-ts-v9j3.4
```
