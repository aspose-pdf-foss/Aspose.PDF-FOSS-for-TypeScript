# XFA Fixed-Size Flow Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give XFA fields under `tb`, `lr-tb`, `table` and `row` containers real widgets, sized only from what the template states, so all 199 of IRS f1040's fields are placed exactly where Adobe placed them.

**Architecture:** `xfatemplate.ts` additionally builds a layout tree per page (containers, fields and draws). A new pure leaf, `xfaflow.ts`, lays that tree out once and returns a box or a named reason per field SOM name. `position` is one case of that engine, so positioned and flowed fields share one code path. `xfaconvert.ts` reads the box and applies the existing caption, margin and check-button rules (`xfageom.ts`'s new `editRegion` plus `buttonBox`).

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-xfa-flow-layout-design.md`. Every rule below is cited there to the XFA Specification 3.3 by page.

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins, and `xfaflow.ts` imports none of those either.
- `xfaflow.ts` is a pure leaf over `xfageom.js`. No `Document`, no PDF object, no `node:` import, and it never throws: every failure is a `{ reason }`.
- `xfageom.ts` stays a pure leaf importing nothing.
- Never an approximate rect. A shape the spec does not settle refuses with a reason, and the field converts bare.
- Import specifiers carry `.js`; type-only imports use `import type`.
- Every `catch` in `src/` calls `rethrowLimit(e)` first. This plan adds none.
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- Units are points, XFA frame (origin top-left, y downward), as `xfageom.ts` already uses.

## Review Focus

These input classes are implied by the spec but are not the point of any one rule. Each has a test added to the task named:

1. **A flowed page subform whose `pageArea` declares a `contentArea` with `w`/`h`.** Its fields must be placed, not merely refused. → Task 4 (`FLOWED_BOUNDED_TEMPLATE`).
2. **An unnamed field in a flow.** It produces no output but must still take up its space, so the named field after it sits below it. → Task 1 (engine) and Task 3 (template).
3. **A draw that cannot be sized in a `tb`.** Every later field must be refused, with a reason naming the draw. → Task 1.
4. **A table row with more cells than `columnWidths` has entries.** The extra columns are auto (`-1`) and sized from their single-column cells. → Task 2.
5. **A `presence="hidden"` field under a fully positioned page.** It now converts bare with a presence reason, where before it got a widget. → Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/xfaflow.ts` (new) | The layout engine: `LayoutNode` model, `layoutPage(root)`. Positioned, `tb`, `lr-tb`, `table`, `row`. |
| `src/xfatemplate.ts` (modify) | Builds `XfaTemplate.roots`: one layout tree per resolved page. Drops `XfaField.offsets` and `XfaField.geom` (Task 4). |
| `src/xfageom.ts` (modify) | Adds `editRegion`; removes `boxFor`, `accumulateOrigin`, `XfaOffset` (Task 4). |
| `src/xfaconvert.ts` (modify) | Lays out each page and reads field boxes from the result. |
| `test/xfaflow.test.ts` (new) | Engine rules from hand-built trees. |
| `test/xfatemplate.test.ts`, `test/xfageom.test.ts`, `test/xfadata.test.ts`, `test/xfaconvert.test.ts`, `test/xfa-real.test.ts`, `test/xfa-flow-oracle.test.ts`, `test/helpers/build-xfa-pdf.ts` (modify) | Migrated and extended assertions. |
| `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `test/fixtures/xfa/PROVENANCE.md` (modify) | Docs. |

---

### Task 1: The engine — model, positioned layout, `tb`, `lr-tb`, presence

**Files:**
- Create: `src/xfaflow.ts`
- Test: `test/xfaflow.test.ts`

**Interfaces:**
- Consumes: from `src/xfageom.ts`: `measureToPt(s)`, `anchorShift(anchor, w, h)`, `XFA_ANCHORS`, types `XfaBox`, `XfaMargin`, `XfaRawGeom` (all exist today).
- Produces (used by Tasks 2, 3, 4):
  ```ts
  export type LayoutKind = 'page' | 'subform' | 'exclGroup' | 'area' | 'field' | 'draw';
  export interface XfaMinMax { minW?: string; minH?: string; maxW?: string; maxH?: string }
  export interface LayoutNode {
    kind: LayoutKind; label: string; layout?: string; geom: XfaRawGeom;
    minMax?: XfaMinMax; colSpan?: string; hAlign?: string; presence?: string;
    margin?: XfaMargin; columnWidths?: string; field?: string; children: LayoutNode[];
  }
  export type Placed = { box: XfaBox } | { reason: string };
  export function layoutPage(root: LayoutNode): Map<string, Placed>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/xfaflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

/** A field leaf; its label doubles as its SOM name. */
const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const drw = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom, children: [], ...extra });
const sub = (
  label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[],
  extra: Partial<LayoutNode> = {},
): LayoutNode => ({ kind: 'subform', label, layout, geom, children, ...extra });
const page = (children: LayoutNode[], geom: XfaRawGeom = {}): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'position', geom, children });

const box = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (p === undefined) throw new Error(`${n}: no result`);
  if ('reason' in p) throw new Error(`${n}: ${p.reason}`);
  return p.box;
};
const why = (m: Map<string, Placed>, n: string): string => {
  const p = m.get(n);
  if (p === undefined) throw new Error(`${n}: no result`);
  if ('box' in p) throw new Error(`${n}: placed at ${JSON.stringify(p.box)}`);
  return p.reason;
};
const S = { w: '10pt', h: '10pt' };

describe('layoutPage: positioned layout', () => {
  // Three deep with a non-zero offset at EACH level: "accumulate the immediate
  // parent only" is invisible with fewer. Moved here from accumulateOrigin.
  it('sums every level of the chain, the contentArea included', () => {
    const m = layoutPage(page([
      sub('P', 'position', { x: '0.25in', y: '0.5in' }, [
        sub('A', 'position', { x: '1in', y: '2in' }, [
          fld('f', { x: '10pt', y: '20pt', w: '1in', h: '1in' }),
        ]),
      ]),
    ], { x: '5pt', y: '6pt' }));
    expect(box(m, 'f')).toEqual({ x: 105, y: 206, w: 72, h: 72 });
  });

  it('reads an absent x or y as zero, at the field and at a container', () => {
    const m = layoutPage(page([sub('P', 'position', { y: '1in' }, [fld('f', { w: '1in', h: '1in' })])]));
    expect(box(m, 'f')).toEqual({ x: 0, y: 72, w: 72, h: 72 });
  });

  // XFA 3.3 Appendix A (p. 1510): Px = Cx + Mx + Ox -- a container's margin
  // insets shift its positioned children.
  it('shifts positioned children by the container margin', () => {
    const m = layoutPage(page([sub('P', 'position', { x: '100pt', y: '100pt' }, [
      fld('f', { x: '1pt', y: '2pt', ...S }),
    ], { margin: { leftInset: '5pt', topInset: '7pt' } })]));
    expect(box(m, 'f')).toEqual({ x: 106, y: 109, w: 10, h: 10 });
  });

  it('applies the field anchor shift', () => {
    const m = layoutPage(page([fld('f', { x: '1in', y: '1in', w: '2in', h: '1in', anchorType: 'middleCenter' })]));
    expect(box(m, 'f')).toEqual({ x: 0, y: 36, w: 144, h: 72 });
  });

  // New with the engine: a CONTAINER's anchor is applied too, against its
  // stated size or, when growable, its content extent.
  it('applies a container anchor shift, sized or growable', () => {
    const fixed = layoutPage(page([sub('P', 'position',
      { x: '200pt', y: '100pt', w: '100pt', h: '50pt', anchorType: 'bottomRight' },
      [fld('f', { ...S })])]));
    expect(box(fixed, 'f')).toEqual({ x: 100, y: 50, w: 10, h: 10 });
    const grown = layoutPage(page([sub('P', 'position',
      { x: '100pt', y: '100pt', anchorType: 'middleCenter' },
      [fld('f', { w: '40pt', h: '20pt' })])]));
    expect(box(grown, 'f')).toEqual({ x: 80, y: 90, w: 40, h: 20 });
  });

  it('refuses a rotate, an unreadable measure, a bad anchor and an absent size, each by name', () => {
    const m = layoutPage(page([
      fld('rot', { ...S, rotate: '90' }),
      fld('px', { w: '1px', h: '10pt' }),
      fld('anc', { ...S, anchorType: 'centre' }),
      fld('noH', { w: '10pt' }),
      fld('noW', { h: '10pt' }),
      fld('emptyX', { x: '', ...S }),
    ]));
    expect(why(m, 'rot')).toMatch(/rotate="90"/);
    expect(why(m, 'px')).toMatch(/w="1px" could not be read/);
    expect(why(m, 'anc')).toMatch(/anchorType="centre"/);
    expect(why(m, 'noH')).toMatch(/states no h.*164g\.7/);
    expect(why(m, 'noW')).toMatch(/states no w.*164g\.7/);
    expect(why(m, 'emptyX')).toMatch(/x="" could not be read/);
  });

  it('accepts rotate="0", which is not a rotation', () => {
    expect(box(layoutPage(page([fld('f', { ...S, rotate: '0' })])), 'f'))
      .toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  // In positioned layout a failure is local: the sibling's place does not
  // depend on it.
  it('keeps a positioned failure to itself', () => {
    const m = layoutPage(page([fld('bad', { w: '10pt' }), fld('ok', { x: '5pt', ...S })]));
    expect(why(m, 'bad')).toBeTruthy();
    expect(box(m, 'ok')).toEqual({ x: 5, y: 0, w: 10, h: 10 });
  });

  it('refuses a repeating subform and an unknown layout', () => {
    const m = layoutPage(page([
      sub('R', 'occur', {}, [fld('a', S)]),
      sub('U', 'rl-tb', {}, [fld('b', S)]),
    ]));
    expect(why(m, 'a')).toMatch(/164g\.2/);
    expect(why(m, 'b')).toMatch(/layout="rl-tb" is not laid out/);
  });
});

describe('layoutPage: presence', () => {
  it('gives a hidden or inactive field no box, and an invisible one its place', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('h', S, { presence: 'hidden' }),
      fld('i', S, { presence: 'inactive' }),
      fld('v', S, { presence: 'invisible' }),
      fld('after', S),
    ])]));
    expect(why(m, 'h')).toBe('presence="hidden" takes no space in the layout');
    expect(why(m, 'i')).toBe('presence="inactive" takes no space in the layout');
    expect(box(m, 'v')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    // The hidden two took no space; the invisible one did.
    expect(box(m, 'after')).toEqual({ x: 0, y: 10, w: 10, h: 10 });
  });

  it('conceals everything inside a hidden container', () => {
    const m = layoutPage(page([sub('H', 'position', {}, [fld('f', S)], { presence: 'hidden' })]));
    expect(why(m, 'f')).toMatch(/presence="hidden"/);
  });
});

describe('layoutPage: tb', () => {
  // XFA 3.3 p. 280: each child "immediately below the nominal extent of the
  // previous ... aligned with the left edge". A draw takes up space too.
  it('stacks children at the left edge, draws included', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { w: '50pt', h: '10pt' }),
      fld('b', { w: '30pt', h: '20pt' }),
      drw('d', { w: '10pt', h: '5pt' }),
      fld('c', { ...S }),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 0, y: 10, w: 30, h: 20 });
    expect(box(m, 'c')).toEqual({ x: 0, y: 35, w: 10, h: 10 });
  });

  // p. 280: a flowed child's x, y and anchor point are ignored.
  it('ignores a flowed child x, y and anchor', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { x: '100pt', y: '100pt', ...S, anchorType: 'bottomRight' }),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('starts inside the container margin', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [fld('a', S)],
      { margin: { leftInset: '3pt', topInset: '4pt' } })]));
    expect(box(m, 'a')).toEqual({ x: 3, y: 4, w: 10, h: 10 });
  });

  // Review Focus 3: an unsizable draw breaks the flow, and the reason names it.
  it('refuses an unsizable item and every later sibling, naming the cause', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', S), drw('d', { w: '10pt' }), fld('b', S), fld('c', S),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(why(m, 'b')).toMatch(/^an earlier item in its flow could not be laid out \(d: states no h/);
    expect(why(m, 'c')).toMatch(/\(d: states no h/);
  });

  // Review Focus 2: an unnamed field produces nothing but takes its space.
  it('lets an unnamed field take its space', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      { kind: 'field', label: '<field>', geom: { ...S }, children: [] },
      fld('b', S),
    ])]));
    expect(m.size).toBe(1);
    expect(box(m, 'b').y).toBe(10);
  });

  // p. 275-276: a growable container's extent is its content plus margins.
  it('sizes a growable container from its children plus its margins', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })],
        { margin: { topInset: '2pt', bottomInset: '3pt' } }),
      fld('b', S),
    ])]));
    expect(box(m, 'a').y).toBe(2);
    expect(box(m, 'b').y).toBe(35);
  });

  it('raises a growable extent to minH, honours maxH="0" as none, and refuses content past maxH', () => {
    const grown = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { minH: '50pt' } }),
      fld('b', S),
    ])]));
    expect(box(grown, 'b').y).toBe(50);
    const zero = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { maxH: '0' } }),
      fld('b', S),
    ])]));
    expect(box(zero, 'b').y).toBe(30);
    const clipped = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { maxH: '20pt' } }),
      fld('b', S),
    ])]));
    expect(why(clipped, 'b')).toMatch(/exceeds maxH/);
  });

  it('refuses a child that would not fit a fixed-height container', () => {
    const m = layoutPage(page([sub('T', 'tb', { h: '25pt' }, [fld('a', S), fld('b', S), fld('c', S)])]));
    expect(box(m, 'b').y).toBe(10);
    expect(why(m, 'c')).toMatch(/splitting \(164g\.3\)/);
  });

  it('refuses a flowed child that states a non-left hAlign, and a row outside a table', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [sub('R', 'tb', {}, [fld('a', S)], { hAlign: 'right' })]),
      sub('U', 'tb', {}, [sub('W', 'row', {}, [fld('b', S)])])]));
    expect(why(m, 'a')).toMatch(/hAlign="right"/);
    expect(why(m, 'b')).toMatch(/layout="row" outside a table/);
  });
});

describe('layoutPage: lr-tb', () => {
  it('lays a container with no stated w on one line', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect([box(m, 'a').x, box(m, 'b').x, box(m, 'c').x]).toEqual([0, 10, 30]);
    expect(box(m, 'c').y).toBe(0);
  });

  // p. 281: "immediately to the right ... or if this fails immediately below
  // it aligned with the left edge".
  it('wraps to the left edge when the next child does not fit', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect(box(m, 'c')).toEqual({ x: 0, y: 10, w: 30, h: 10 });
  });

  it('wraps against the width inside the container margins', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '40pt' }, [
      fld('a', { w: '20pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }),
    ], { margin: { leftInset: '2pt', rightInset: '2pt' } })]));
    expect(box(m, 'b')).toEqual({ x: 2, y: 10, w: 20, h: 10 });
  });

  it('puts an over-wide child alone on its own line', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '50pt', h: '10pt' }), fld('c', { w: '10pt', h: '10pt' }),
    ])]));
    expect(box(m, 'b')).toEqual({ x: 0, y: 10, w: 50, h: 10 });
    expect(box(m, 'c')).toEqual({ x: 0, y: 20, w: 10, h: 10 });
  });

  it('top-aligns a single line of mixed heights', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '10pt', h: '30pt' }),
    ])]));
    expect(box(m, 'a').y).toBe(0);
    expect(box(m, 'b').y).toBe(0);
  });

  // The spec's "immediately below it" does not say below what when the line's
  // heights differ, so that wrap refuses rather than picks.
  it('refuses a wrap after a line of mixed heights', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '20pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect(why(m, 'c')).toMatch(/mixed heights/);
  });

  it('sizes a growable lr-tb as its line: summed widths, tallest height', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('L', 'lr-tb', {}, [fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '15pt' })]),
      fld('c', S),
    ])]));
    expect(box(m, 'c').y).toBe(15);
  });
});

describe('layoutPage: the page root', () => {
  it('bounds a flowed page subform by the contentArea height', () => {
    const fits = layoutPage(page([sub('P', 'tb', {}, [fld('a', S), fld('b', S)])],
      { x: '36pt', y: '36pt', w: '540pt', h: '20pt' }));
    expect(box(fits, 'b')).toEqual({ x: 36, y: 46, w: 10, h: 10 });
    const over = layoutPage(page([sub('P', 'tb', {}, [fld('a', S), fld('b', S)])],
      { w: '540pt', h: '15pt' }));
    expect(why(over, 'a')).toMatch(/overflows its contentArea.*164g\.3/);
  });

  it('refuses a flowed page subform when the contentArea states no height', () => {
    const m = layoutPage(page([sub('P', 'tb', {}, [fld('a', S)])]));
    expect(why(m, 'a')).toMatch(/uses layout="tb" and its pageArea declares no contentArea height/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xfaflow.test.ts`
Expected: FAIL. The suite cannot load: `Failed to resolve import "../src/xfaflow.js"`.

- [ ] **Step 3: Write the engine**

Create `src/xfaflow.ts`:

```ts
/**
 * XFA layout: a page's layout tree to a box per field, or a named reason
 * (`164g.1`).
 *
 * **Invariant: a pure leaf over `xfageom.js`.** No `Document`, no PDF object,
 * no `node:` import -- every rule is drivable from a hand-built tree.
 *
 * **Invariant: it never throws.** A node that cannot be laid out is a
 * `{ reason }`, which the caller turns into a geometry-less field.
 *
 * **Invariant: never an approximate position.** Every rule is transcribed from
 * the XFA Specification 3.3, cited by page; a shape the spec does not settle
 * refuses.
 *
 * `position` is one case of the same walk, so a positioned field and a flowed
 * one cannot be placed by two disagreeing rules. IRS f1040's 159 positioned
 * rects (`test/xfa-real.test.ts`) are the fence for that unification.
 */
import {
  XFA_ANCHORS, anchorShift, measureToPt,
  type XfaBox, type XfaMargin, type XfaRawGeom,
} from './xfageom.js';

export type LayoutKind = 'page' | 'subform' | 'exclGroup' | 'area' | 'field' | 'draw';

export interface XfaMinMax { minW?: string; minH?: string; maxW?: string; maxH?: string }

/** One node of a page's layout tree, as the template states it. */
export interface LayoutNode {
  kind: LayoutKind;
  /** The node's indexed name, or `<kind>` when unnamed. Used in reasons. */
  label: string;
  /** Containers only: `position` (default), `tb`, `lr-tb`, `table`, `row`,
   *  the synthetic `occur`, or anything else (refused). */
  layout?: string;
  geom: XfaRawGeom;
  minMax?: XfaMinMax;
  colSpan?: string;
  hAlign?: string;
  presence?: string;
  /** A CONTAINER's own `<margin>`, which insets its content. A field's margin
   *  is its edit-region inset and stays on `XfaField`, not here. */
  margin?: XfaMargin;
  columnWidths?: string;
  /** The field's SOM name; absent on draws and unnamed fields. */
  field?: string;
  children: LayoutNode[];
}

export type Placed = { box: XfaBox } | { reason: string };

/** The layouts this engine places. An allowlist: anything else refuses. */
const LAID_OUT: ReadonlySet<string> = new Set(['position', 'tb', 'lr-tb']);

/** Tolerance for comparing summed measurements: mm-to-pt conversions leave
 *  ulps of residue, and `17.78mm + 20.32mm` must fit a `38.1mm` column. */
const EPS = 1e-6;

interface Size { w: number; h: number }
interface Fail { reason: string; cause?: string }
interface Slot { x: number; y: number; size?: Size }
interface Insets { l: number; r: number; t: number; b: number }
type Slots = Map<LayoutNode, Slot | Fail>;

const isFail = (v: object): v is Fail => 'reason' in v;
const isLeaf = (n: LayoutNode): boolean => n.kind === 'field' || n.kind === 'draw';

/** XFA 3.3 p. 67-68: `hidden` and `inactive` are absent from layout;
 *  `invisible` takes up space. Inheritance is structural: a concealed
 *  container is never descended. */
function concealed(n: LayoutNode): string | undefined {
  return n.presence === 'hidden' || n.presence === 'inactive'
    ? `presence="${n.presence}" takes no space in the layout` : undefined;
}

/** The reason a flow's later siblings carry: their positions depend on the one
 *  that failed, so they name it rather than guessing past it. */
function after(f: Fail): Fail {
  const cause = f.cause ?? f.reason;
  return { reason: `an earlier item in its flow could not be laid out (${cause})`, cause };
}

/** A stated measurement: a number, `undefined` when the attribute is absent,
 *  or a failure when it is present and unreadable. */
function stated(n: LayoutNode, k: 'x' | 'y' | 'w' | 'h'): number | undefined | Fail {
  const s = n.geom[k];
  if (s === undefined) return undefined;
  const v = measureToPt(s);
  return v === undefined
    ? { reason: `${n.label}: ${k}="${s}" could not be read as a measurement` } : v;
}

function insetsOf(n: LayoutNode): Insets | Fail {
  const m = n.margin ?? {};
  const out: number[] = [];
  for (const k of ['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const) {
    const s = m[k];
    if (s === undefined) { out.push(0); continue; }
    const v = measureToPt(s);
    if (v === undefined)
      return { reason: `${n.label}: margin ${k}="${s}" could not be read as a measurement` };
    out.push(v);
  }
  return { l: out[0], r: out[1], t: out[2], b: out[3] };
}

/** Why this node cannot be laid out at all, whatever its parent. */
function refusalOf(n: LayoutNode): string | undefined {
  if (n.geom.rotate !== undefined && measureToPt(n.geom.rotate) !== 0)
    return `${n.label}: rotate="${n.geom.rotate}" is not supported`;
  if (isLeaf(n)) return undefined;
  const lay = n.layout ?? 'position';
  if (lay === 'occur')
    return `${n.label}: a repeating <occur> subform needs repetition, which is not laid out (164g.2)`;
  if (!LAID_OUT.has(lay)) return `${n.label}: layout="${lay}" is not laid out`;
  return undefined;
}

/** XFA 3.3 p. 282: `row` outside a table is an inappropriate layout strategy. */
const ROW_OUTSIDE = (c: LayoutNode) => `${c.label}: layout="row" outside a table is not laid out`;

/** Why a child cannot take part in a flow. XFA 3.3 p. 282 gives `left` as the
 *  default `hAlign` for left-to-right layouts and shows the others only as
 *  examples, so any other value refuses. */
function flowRefusal(c: LayoutNode): string | undefined {
  if (c.layout === 'row') return ROW_OUTSIDE(c);
  if (c.hAlign !== undefined && c.hAlign !== 'left')
    return `${c.label}: hAlign="${c.hAlign}" in a flowing layout is not laid out`;
  return undefined;
}

class Engine {
  private readonly sizes = new Map<LayoutNode, Size | Fail>();
  private readonly slots = new Map<LayoutNode, Slots>();
  /** A table's content size, set by `table()` when every row placed. */
  private readonly tables = new Map<LayoutNode, Size>();

  /** A node's nominal extent. */
  extent(n: LayoutNode): Size | Fail {
    let s = this.sizes.get(n);
    if (s === undefined) { s = this.measure(n); this.sizes.set(n, s); }
    return s;
  }

  private measure(n: LayoutNode): Size | Fail {
    const no = refusalOf(n);
    if (no !== undefined) return { reason: no };
    const w = stated(n, 'w');
    const h = stated(n, 'h');
    if (typeof w === 'object') return w;
    if (typeof h === 'object') return h;
    if (isLeaf(n)) {
      if (w === undefined || h === undefined)
        return {
          reason: `${n.label}: states no ${w === undefined ? 'w' : 'h'}, so its size comes `
            + 'from its content, which needs text measurement (164g.7)',
        };
      return { w, h };
    }
    // XFA 3.3 p. 276: with both stated, min*/max* are ignored.
    if (w !== undefined && h !== undefined) return { w, h };
    // p. 275: a growable container works inside-out -- a content region from
    // its contents, then its margins applied.
    const m = insetsOf(n);
    if (isFail(m)) return m;
    const c = this.contentExtent(n, m);
    if (isFail(c)) return c;
    const width = this.grow(n, 'minW', 'maxW', w, c.w + m.l + m.r);
    if (isFail(width)) return width;
    const height = this.grow(n, 'minH', 'maxH', h, c.h + m.t + m.b);
    if (isFail(height)) return height;
    return { w: width, h: height };
  }

  /** One axis of a growable extent. `max*="0"` means absent (p. 277). Content
   *  past a stated maximum would be clipped, which is not modelled. */
  private grow(
    n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH',
    fixed: number | undefined, content: number,
  ): number | Fail {
    if (fixed !== undefined) return fixed;
    const mm = n.minMax ?? {};
    let v = content;
    const min = mm[minKey];
    if (min !== undefined) {
      const p = measureToPt(min);
      if (p === undefined)
        return { reason: `${n.label}: ${minKey}="${min}" could not be read as a measurement` };
      v = Math.max(v, p);
    }
    const max = mm[maxKey];
    if (max !== undefined) {
      const p = measureToPt(max);
      if (p === undefined)
        return { reason: `${n.label}: ${maxKey}="${max}" could not be read as a measurement` };
      if (p > 0 && v > p + EPS)
        return { reason: `${n.label}: its content exceeds ${maxKey}, and clipping is not laid out` };
    }
    return v;
  }

  /** The content region a growable container's children span, from its
   *  content origin. */
  private contentExtent(n: LayoutNode, m: Insets): Size | Fail {
    const slots = this.arrange(n);
    const t = this.tables.get(n);
    if (t !== undefined) return t;
    let w = 0;
    let h = 0;
    for (const c of n.children) {
      if (concealed(c) !== undefined) continue;
      const s = slots.get(c);
      if (s === undefined) continue;
      if (isFail(s)) return s;
      const size = s.size ?? this.extent(c);
      if (isFail(size)) return size;
      const x = s.x - m.l;
      const y = s.y - m.t;
      if (x < -EPS || y < -EPS)
        return { reason: `${c.label}: sits at a negative coordinate, so the extent of ${n.label} is not defined` };
      w = Math.max(w, x + size.w);
      h = Math.max(h, y + size.h);
    }
    return { w, h };
  }

  /** Each present child's top-left relative to `n`'s own top-left (margins
   *  included), or why it has none. */
  arrange(n: LayoutNode): Slots {
    const known = this.slots.get(n);
    if (known !== undefined) return known;
    const out: Slots = new Map();
    this.slots.set(n, out);
    const kids = n.children.filter((c) => concealed(c) === undefined);
    const failAll = (reason: string): Slots => {
      for (const c of kids) out.set(c, { reason });
      return out;
    };
    const no = refusalOf(n);
    if (no !== undefined) return failAll(no);
    const m = insetsOf(n);
    if (isFail(m)) return failAll(m.reason);
    switch (n.layout ?? 'position') {
      case 'tb': this.flowTb(n, kids, m, out); break;
      case 'lr-tb': this.flowLrTb(n, kids, m, out); break;
      default: for (const c of kids) out.set(c, this.positionOne(n, c, m));
    }
    return out;
  }

  /** XFA 3.3 p. 608 (`x`/`y`) and Appendix A p. 1510: a child's anchor point
   *  is relative to the parent's content region, and the top-left corner is
   *  found from the anchor by moving back over the child's own extent. */
  private positionOne(n: LayoutNode, c: LayoutNode, m: Insets): Slot | Fail {
    if (c.layout === 'row') return { reason: ROW_OUTSIDE(c) };
    const x = stated(c, 'x');
    const y = stated(c, 'y');
    if (typeof x === 'object') return x;
    if (typeof y === 'object') return y;
    const anchor = c.geom.anchorType;
    if (anchor !== undefined && !(XFA_ANCHORS as readonly string[]).includes(anchor))
      return { reason: `${c.label}: anchorType="${anchor}" is not one of the nine` };
    let dx = 0;
    let dy = 0;
    if (anchor !== undefined && anchor !== 'topLeft') {
      const s = this.extent(c);
      if (isFail(s)) return s;
      const sh = anchorShift(anchor, s.w, s.h);
      if (sh === undefined) return { reason: `${c.label}: anchorType="${anchor}" is not one of the nine` };
      dx = sh.dx;
      dy = sh.dy;
    }
    const slot: Slot = { x: m.l + (x ?? 0) + dx, y: m.t + (y ?? 0) + dy };
    if (n.kind === 'page' && (c.layout ?? 'position') !== 'position') return this.bounded(n, c, slot);
    return slot;
  }

  /** A flowed page subform must fit its contentArea; past it is page breaking
   *  (164g.3). Without a stated height nothing bounds the flow. */
  private bounded(page: LayoutNode, c: LayoutNode, slot: Slot): Slot | Fail {
    const h = stated(page, 'h');
    if (typeof h !== 'number')
      return {
        reason: `${c.label}: uses layout="${c.layout ?? ''}" and its pageArea declares no `
          + 'contentArea height, so the flow cannot be bounded',
      };
    const s = this.extent(c);
    if (isFail(s)) return s;
    if (slot.y + s.h > h + EPS)
      return { reason: `${c.label}: overflows its contentArea, which needs page breaking (164g.3)` };
    return slot;
  }

  /** The height a fixed-height flowed container offers its children. */
  private available(n: LayoutNode, m: Insets): number | undefined {
    const h = stated(n, 'h');
    return typeof h === 'number' ? h - m.t - m.b : undefined;
  }

  private flowSize(c: LayoutNode): Size | Fail {
    const no = flowRefusal(c);
    return no !== undefined ? { reason: no } : this.extent(c);
  }

  private splitFail(n: LayoutNode, c: LayoutNode): Fail {
    return { reason: `${c.label}: does not fit the remaining height of ${n.label}, which needs splitting (164g.3)` };
  }

  /** XFA 3.3 p. 280: each child "immediately below the nominal extent of the
   *  previous contained object and aligned with the left edge". */
  private flowTb(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const avail = this.available(n, m);
    let y = 0;
    let broken: Fail | undefined;
    for (const c of kids) {
      if (broken) { out.set(c, after(broken)); continue; }
      const size = this.flowSize(c);
      if (isFail(size)) { out.set(c, size); broken = size; continue; }
      if (avail !== undefined && y + size.h > avail + EPS) {
        const f = this.splitFail(n, c);
        out.set(c, f);
        broken = f;
        continue;
      }
      out.set(c, { x: m.l, y: m.t + y });
      y += size.h;
    }
  }

  /** XFA 3.3 p. 281: each child "immediately to the right of the nominal extent
   *  of the previous object, or if this fails immediately below it aligned with
   *  the left edge". A child on the same line keeps the line's top. With no
   *  stated `w` the container is growable in width and never wraps. */
  private flowLrTb(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const sw = stated(n, 'w');
    const width = typeof sw === 'number' ? sw - m.l - m.r : Infinity;
    const avail = this.available(n, m);
    let x = 0;
    let y = 0;
    let lineH = 0;
    let line: number[] = [];
    let broken: Fail | undefined;
    for (const c of kids) {
      if (broken) { out.set(c, after(broken)); continue; }
      const size = this.flowSize(c);
      if (isFail(size)) { out.set(c, size); broken = size; continue; }
      if (x > 0 && x + size.w > width + EPS) {
        // "immediately below it" does not say below WHAT once the line's
        // heights differ, so that wrap refuses rather than picks.
        if (line.some((v) => Math.abs(v - line[0]) > EPS)) {
          const f: Fail = {
            reason: `${c.label}: wraps after a line of mixed heights, where the specification `
              + 'does not say how far below it goes',
          };
          out.set(c, f);
          broken = f;
          continue;
        }
        y += lineH;
        x = 0;
        lineH = 0;
        line = [];
      }
      if (avail !== undefined && y + size.h > avail + EPS) {
        const f = this.splitFail(n, c);
        out.set(c, f);
        broken = f;
        continue;
      }
      out.set(c, { x: m.l + x, y: m.t + y });
      x += size.w;
      lineH = Math.max(lineH, size.h);
      line.push(size.h);
    }
  }

  /** Walk top-down, recording every field's box or reason. `forced` is a table
   *  cell's expanded size, which replaces a leaf's own. */
  emit(n: LayoutNode, x: number, y: number, forced: Size | undefined, out: Map<string, Placed>): void {
    const hid = concealed(n);
    if (hid !== undefined) { assignAll(n, hid, out); return; }
    if (isLeaf(n)) {
      if (n.field === undefined) return;
      const size = forced ?? this.extent(n);
      out.set(n.field, isFail(size)
        ? { reason: size.reason }
        : { box: { x, y, w: size.w, h: size.h } });
      return;
    }
    const slots = this.arrange(n);
    for (const c of n.children) {
      const hidden = concealed(c);
      if (hidden !== undefined) { assignAll(c, hidden, out); continue; }
      const s = slots.get(c);
      if (s === undefined) continue;
      if (isFail(s)) assignAll(c, s.reason, out);
      else this.emit(c, x + s.x, y + s.y, s.size, out);
    }
  }
}

/** Give every field under `n` the same reason. */
function assignAll(n: LayoutNode, reason: string, out: Map<string, Placed>): void {
  if (n.field !== undefined) out.set(n.field, { reason });
  for (const c of n.children) assignAll(c, reason, out);
}

/**
 * Lay out one page. `root` is the page's `contentArea`, positioned at its own
 * stated `x`/`y`. The result maps every field SOM name under it to a box in
 * the page's XFA frame, or the reason it has none.
 */
export function layoutPage(root: LayoutNode): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const x = stated(root, 'x');
  const y = stated(root, 'y');
  if (typeof x === 'object') { assignAll(root, x.reason, out); return out; }
  if (typeof y === 'object') { assignAll(root, y.reason, out); return out; }
  new Engine().emit(root, x ?? 0, y ?? 0, undefined, out);
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/xfaflow.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts test/xfaflow.test.ts
git commit -m "feat(164g.1): XFA layout engine for position, tb and lr-tb

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tables and rows

**Files:**
- Modify: `src/xfaflow.ts`
- Test: `test/xfaflow.test.ts`

**Interfaces:**
- Consumes: Task 1's `Engine`, `LayoutNode`, `stated`, `insetsOf`, `refusalOf`, `flowRefusal`, `after`, `concealed`, `isLeaf`, `EPS`.
- Produces: `layout: 'table'` and `layout: 'row'` are placed by `layoutPage`; there is no new export.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfaflow.test.ts`:

```ts
/** A row of cells. */
const row = (label: string, cells: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  sub(label, 'row', {}, cells, extra);
const table = (cols: string | undefined, rows: LayoutNode[], geom: XfaRawGeom = {}): LayoutNode =>
  sub('T', 'table', geom, rows, cols === undefined ? {} : { columnWidths: cols });
const H = (h: number, extra: XfaRawGeom = {}): XfaRawGeom => ({ h: `${String(h)}pt`, ...extra });

describe('layoutPage: tables', () => {
  // XFA 3.3 p. 329: rows stacked top to bottom, each cell expanded to its
  // column's designated width.
  it('places cells by column width and rows top to bottom', () => {
    const m = layoutPage(page([table('20pt 30pt', [
      row('r1', [fld('a', H(10)), fld('b', H(10))]),
      row('r2', [fld('c', H(12)), fld('d', H(12))]),
    ], { x: '100pt', y: '50pt' })]));
    expect(box(m, 'a')).toEqual({ x: 100, y: 50, w: 20, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 120, y: 50, w: 30, h: 10 });
    expect(box(m, 'c')).toEqual({ x: 100, y: 60, w: 20, h: 12 });
    expect(box(m, 'd')).toEqual({ x: 120, y: 60, w: 30, h: 12 });
  });

  it('ignores a cell own stated width', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', H(10, { w: '5pt' }))])])]));
    expect(box(m, 'a').w).toBe(20);
  });

  // p. 329: "For each row it expands the cells vertically to the height of the
  // tallest cell in the row."
  it('expands every cell in a row to its tallest cell', () => {
    const m = layoutPage(page([table('20pt 20pt', [row('r', [fld('a', H(10)), fld('b', H(16))])])]));
    expect(box(m, 'a').h).toBe(16);
  });

  it('keeps a positioned cell subform children at their offsets inside the cell', () => {
    const m = layoutPage(page([table('20pt 30pt', [row('r', [
      drw('d', H(10)),
      sub('C', 'position', H(10), [fld('f', { x: '2pt', y: '3pt', w: '5pt', h: '5pt' })]),
    ])])]));
    expect(box(m, 'f')).toEqual({ x: 22, y: 3, w: 5, h: 5 });
  });

  it('sizes a -1 column to its widest single-column cell', () => {
    const m = layoutPage(page([table('-1 30pt', [
      row('r1', [fld('a', H(10, { w: '15pt' })), fld('b', H(10))]),
      row('r2', [fld('c', H(10, { w: '25pt' })), fld('d', H(10))]),
    ])]));
    expect(box(m, 'a').w).toBe(25);
    expect(box(m, 'b').x).toBe(25);
  });

  // Review Focus 4: columns past the list default to -1 (p. 327).
  it('auto-sizes the columns past the end of columnWidths', () => {
    const m = layoutPage(page([table('20pt', [
      row('r1', [fld('a', H(10)), fld('b', H(10, { w: '40pt' }))]),
      row('r2', [fld('c', H(10)), fld('d', H(10, { w: '50pt' }))]),
    ])]));
    expect(box(m, 'b')).toEqual({ x: 20, y: 0, w: 50, h: 10 });
  });

  it('refuses a -1 column that no single-column cell with a stated width can size', () => {
    const m = layoutPage(page([table('-1', [row('r', [fld('a', H(10))])])]));
    expect(why(m, 'a')).toMatch(/column 1 has width -1/);
  });

  // p. 330: colSpan sums columns; -1 spans the rest and later cells are not
  // displayed; 0 is not allowed.
  it('spans columns', () => {
    const m = layoutPage(page([table('10pt 20pt 30pt', [row('r', [
      fld('a', H(10, { }), { colSpan: '2' }), fld('b', H(10)),
    ])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 30, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 30, y: 0, w: 30, h: 10 });
  });

  it('spans the rest for colSpan="-1" and does not display the cells after it', () => {
    const m = layoutPage(page([table('10pt 20pt 30pt', [row('r', [
      fld('a', H(10)), fld('b', H(10), { colSpan: '-1' }), fld('c', H(10)),
    ])])]));
    expect(box(m, 'b')).toEqual({ x: 10, y: 0, w: 50, h: 10 });
    expect(why(m, 'c')).toMatch(/follows a colSpan="-1" cell/);
  });

  it('refuses colSpan="0" and every later row', () => {
    const m = layoutPage(page([table('10pt', [
      row('r1', [fld('a', H(10), { colSpan: '0' })]),
      row('r2', [fld('b', H(10))]),
    ])]));
    expect(why(m, 'a')).toMatch(/colSpan="0"/);
    expect(why(m, 'b')).toMatch(/an earlier item/);
  });

  // p. 329: a short row leaves an empty region on its right; the table is as
  // wide as all its columns.
  it('gives a short row only its own cells and the table its full width', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      table('10pt 20pt', [row('r1', [fld('a', H(10)), fld('b', H(10))]), row('r2', [fld('c', H(5))])]),
      fld('after', H(10, { w: '10pt' })),
    ])]));
    expect(box(m, 'c')).toEqual({ x: 0, y: 10, w: 10, h: 5 });
    expect(box(m, 'after').x).toBe(30);
  });

  it('sizes a growable table as the sum of its rows', () => {
    const m = layoutPage(page([sub('S', 'tb', {}, [
      table('10pt', [row('r1', [fld('a', H(10))]), row('r2', [fld('b', H(7))])]),
      fld('after', H(10, { w: '10pt' })),
    ])]));
    expect(box(m, 'after').y).toBe(17);
  });

  it('refuses a table child that is not a row, and the rows after it', () => {
    const m = layoutPage(page([table('10pt', [
      row('r1', [fld('a', H(10))]),
      sub('X', 'position', {}, [fld('b', H(10, { w: '10pt' }))]),
      row('r3', [fld('c', H(10))]),
    ])]));
    expect(box(m, 'a').y).toBe(0);
    expect(why(m, 'b')).toMatch(/not a row/);
    expect(why(m, 'c')).toMatch(/an earlier item/);
  });

  it('refuses a row that states its own size or a margin', () => {
    const sized = layoutPage(page([table('10pt', [sub('r', 'row', { h: '20pt' }, [fld('a', H(10))])])]));
    expect(why(sized, 'a')).toMatch(/own size or margin/);
    const margined = layoutPage(page([table('10pt', [row('r', [fld('a', H(10))],
      { margin: { topInset: '1pt' } })])]));
    expect(why(margined, 'a')).toMatch(/own size or margin/);
  });

  it('refuses a cell that states no height', () => {
    const m = layoutPage(page([table('10pt', [row('r', [fld('a', {})])])]));
    expect(why(m, 'a')).toMatch(/states no h.*164g\.7/);
  });

  // The f1040 Row6 shape: a growable lr-tb cell whose single line exactly fills
  // its column; and the refusal when it would not.
  it('lays an lr-tb cell on one line when it fits its column, and refuses when it does not', () => {
    const fits = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '20pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(box(fits, 'b')).toEqual({ x: 20, y: 0, w: 30, h: 10 });
    const over = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '30pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(why(over, 'a')).toMatch(/one line wider than its column/);
  });

  it('refuses a column width it cannot read', () => {
    const m = layoutPage(page([table('10px', [row('r', [fld('a', H(10))])])]));
    expect(why(m, 'a')).toMatch(/columnWidths entry "10px"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xfaflow.test.ts -t tables`
Expected: FAIL. Most cases report `layout="table" is not laid out`.

- [ ] **Step 3: Implement tables**

In `src/xfaflow.ts`, change the allowlist:

```ts
/** The layouts this engine places. An allowlist: anything else refuses. */
const LAID_OUT: ReadonlySet<string> = new Set(['position', 'tb', 'lr-tb', 'table', 'row']);
```

Add the cell model after the `Slots` type:

```ts
/** One table cell at its natural size (XFA 3.3 p. 329). `w` is undefined for a
 *  leaf that states none, which only a stated column may then size. */
interface Cell {
  node: LayoutNode;
  /** Positive, or -1 until resolved against the column count. */
  span: number;
  w: number | undefined;
  h: number;
  /** A growable lr-tb cell: it lays out on one line at its natural width. */
  oneLine: boolean;
  /** After a `colSpan="-1"` cell: not displayed. */
  dropped: boolean;
}
interface Row { node: LayoutNode; cells: Cell[] }

/** XFA 3.3 p. 327: a measurement or `-1` per column. */
function columnsOf(n: LayoutNode): Array<number | 'auto'> | Fail {
  const toks = (n.columnWidths ?? '').split(/\s+/).filter((t) => t !== '');
  const out: Array<number | 'auto'> = [];
  for (const t of toks) {
    if (t === '-1') { out.push('auto'); continue; }
    const v = measureToPt(t);
    if (v === undefined || v < 0)
      return { reason: `${n.label}: columnWidths entry "${t}" could not be read as a measurement` };
    out.push(v);
  }
  return out;
}

/** XFA 3.3 p. 330: a positive count or -1; default 1; never 0. */
function spanOf(c: LayoutNode): number | Fail {
  if (c.colSpan === undefined) return 1;
  if (c.colSpan === '-1') return -1;
  if (/^\d+$/.test(c.colSpan) && Number(c.colSpan) > 0) return Number(c.colSpan);
  return { reason: `${c.label}: colSpan="${c.colSpan}" is not a positive count or -1` };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
```

In `arrange`, add two cases to the `switch` before `default`:

```ts
      case 'table': this.table(n, kids, m, out); break;
      // A row reached here was not arranged by a table: `table()` fills a
      // row's slots before anything asks for them.
      case 'row': return failAll(ROW_OUTSIDE(n));
```

Add these methods to `Engine` after `flowLrTb`:

```ts
  /** A row's cells at their natural sizes, or why the row cannot be laid out. */
  private rowCells(r: LayoutNode): Row | Fail {
    if (r.layout !== 'row')
      return { reason: `${r.label}: a table child that is not a row is not laid out` };
    const no = refusalOf(r) ?? flowRefusal({ ...r, layout: undefined });
    if (no !== undefined) return { reason: no };
    const ri = insetsOf(r);
    if (isFail(ri)) return ri;
    if (r.geom.w !== undefined || r.geom.h !== undefined
      || ri.l !== 0 || ri.r !== 0 || ri.t !== 0 || ri.b !== 0)
      return { reason: `${r.label}: a row that states its own size or margin is not laid out` };
    const cells: Cell[] = [];
    let dropping = false;
    for (const c of r.children) {
      if (concealed(c) !== undefined) continue;
      if (dropping) {
        cells.push({ node: c, span: 0, w: undefined, h: 0, oneLine: false, dropped: true });
        continue;
      }
      const span = spanOf(c);
      if (typeof span === 'object') return span;
      const cr = flowRefusal(c);
      if (cr !== undefined) return { reason: cr };
      let w: number | undefined;
      let h: number;
      let oneLine = false;
      if (isLeaf(c)) {
        const lr = refusalOf(c);
        if (lr !== undefined) return { reason: lr };
        const sw = stated(c, 'w');
        const sh = stated(c, 'h');
        if (typeof sw === 'object') return sw;
        if (typeof sh === 'object') return sh;
        if (sh === undefined)
          return {
            reason: `${c.label}: states no h, so its size comes from its content, which needs `
              + 'text measurement (164g.7)',
          };
        w = sw;
        h = sh;
      } else {
        const e = this.extent(c);
        if (isFail(e)) return e;
        w = e.w;
        h = e.h;
        oneLine = c.layout === 'lr-tb' && c.geom.w === undefined;
      }
      cells.push({ node: c, span, w, h, oneLine, dropped: false });
      if (span === -1) dropping = true;
    }
    return { node: r, cells };
  }

  /** XFA 3.3 p. 327-331: cells at natural size, rows expanded to their tallest
   *  cell, rows stacked top to bottom, cells expanded to their columns. */
  private table(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const cols = columnsOf(n);
    if (isFail(cols)) { for (const c of kids) out.set(c, cols); return; }

    const rows: Row[] = [];
    let broken: Fail | undefined;
    for (const r of kids) {
      if (broken) { out.set(r, after(broken)); continue; }
      const row = this.rowCells(r);
      if (isFail(row)) { out.set(r, row); broken = row; continue; }
      rows.push(row);
    }

    // The column count is the longest row or the declared list; a -1 span then
    // takes whatever columns remain after it.
    let ncols = cols.length;
    for (const row of rows) {
      let k = 0;
      for (const c of row.cells) if (!c.dropped) k += c.span === -1 ? 1 : c.span;
      ncols = Math.max(ncols, k);
    }
    for (const row of rows) {
      let k = 0;
      for (const c of row.cells) {
        if (c.dropped) continue;
        if (c.span === -1) c.span = Math.max(1, ncols - k);
        k += c.span;
      }
    }

    // A -1 column is its widest cell -- from cells spanning exactly that one
    // column, each of which must state a width. Columns are sized from EVERY
    // row, so a row that failed leaves an auto column unknowable.
    const widths: number[] = [];
    for (let j = 0; j < ncols; j++) {
      const tok = cols[j] ?? 'auto';
      if (tok !== 'auto') { widths.push(tok); continue; }
      let widest: number | undefined;
      let unsized = false;
      for (const row of rows) {
        let k = 0;
        for (const c of row.cells) {
          if (c.dropped) continue;
          if (k === j && c.span === 1) {
            if (c.w === undefined) unsized = true;
            else widest = Math.max(widest ?? 0, c.w);
          }
          k += c.span;
        }
      }
      if (broken || unsized || widest === undefined) {
        const f: Fail = {
          reason: broken
            ? `${n.label}: column ${String(j + 1)} is sized by its widest cell, and a row could `
              + `not be laid out (${broken.cause ?? broken.reason})`
            : `${n.label}: column ${String(j + 1)} has width -1 and no single-column cell with a `
              + 'stated width to size it',
        };
        for (const row of rows) out.set(row.node, f);
        return;
      }
      widths.push(widest);
    }

    const tableW = sum(widths);
    const avail = this.available(n, m);
    let y = 0;
    let stop: Fail | undefined;
    for (const row of rows) {
      if (stop) { out.set(row.node, after(stop)); continue; }
      const rowH = row.cells.reduce((a, c) => (c.dropped ? a : Math.max(a, c.h)), 0);
      const cellSlots: Slots = new Map();
      let bad: Fail | undefined;
      let k = 0;
      for (const c of row.cells) {
        if (c.dropped) {
          cellSlots.set(c.node, { reason: `${c.node.label}: follows a colSpan="-1" cell, so it is not displayed` });
          continue;
        }
        const w = sum(widths.slice(k, k + c.span));
        if (c.oneLine && c.w !== undefined && c.w > w + EPS)
          bad ??= {
            reason: `${c.node.label}: lays out on one line wider than its column, and wrapping it `
              + 'to the column is not laid out',
          };
        cellSlots.set(c.node, { x: sum(widths.slice(0, k)), y: 0, size: { w, h: rowH } });
        k += c.span;
      }
      if (bad) { out.set(row.node, bad); stop = bad; continue; }
      if (avail !== undefined && y + rowH > avail + EPS) {
        const f = this.splitFail(n, row.node);
        out.set(row.node, f);
        stop = f;
        continue;
      }
      this.slots.set(row.node, cellSlots);
      out.set(row.node, { x: m.l, y: m.t + y, size: { w: tableW, h: rowH } });
      y += rowH;
    }
    if (!broken && !stop) this.tables.set(n, { w: tableW, h: y });
  }
```

Note that `flowRefusal({ ...r, layout: undefined })` checks the row's `hAlign` without tripping the row-outside-a-table rule, which does not apply to a row inside a table.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/xfaflow.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts test/xfaflow.test.ts
git commit -m "feat(164g.1): XFA table and row layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The template builds the layout tree

**Files:**
- Modify: `src/xfatemplate.ts`
- Test: `test/xfatemplate.test.ts`

**Interfaces:**
- Consumes: `LayoutKind`, `LayoutNode`, `XfaMinMax` (types) from `src/xfaflow.ts`.
- Produces (used by Task 4):
  ```ts
  export interface XfaLayoutRoot { pageIndex: number; node: LayoutNode }
  export interface XfaTemplate { fields: XfaField[]; pages: XfaPageArea[]; roots: XfaLayoutRoot[] }
  ```
  Each root is a `kind: 'page'` node: `label: 'contentArea'`, `layout: 'position'`, `geom` = the `pageArea`'s `<contentArea>` x/y/w/h (empty when absent), and one child, the page subform's node.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfatemplate.test.ts`:

```ts
describe('parseXfaTemplate: the layout tree', () => {
  const PAGE = `<subform name="form1" layout="tb">
    <pageSet><pageArea name="P1">
      <contentArea x="0.25in" y="0.5in" w="8in" h="10in"/>
      <medium short="8.5in" long="11in"/></pageArea></pageSet>`;

  it('roots each resolved page at its contentArea, with the page subform as its child', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position" x="1pt">
      <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(t.roots).toHaveLength(1);
    const r = t.roots[0];
    expect(r.pageIndex).toBe(0);
    expect(r.node).toMatchObject({
      kind: 'page', label: 'contentArea', layout: 'position',
      geom: { x: '0.25in', y: '0.5in', w: '8in', h: '10in' },
    });
    expect(r.node.children).toHaveLength(1);
    expect(r.node.children[0]).toMatchObject({
      kind: 'subform', label: 'Page1[0]', layout: 'position', geom: { x: '1pt' },
    });
    expect(r.node.children[0].children[0]).toMatchObject({
      kind: 'field', label: 'a[0]', field: 'form1[0].Page1[0].a[0]',
      geom: { x: '0', y: '0', w: '1in', h: '1in' },
    });
  });

  // Draws take up space in a flow, so they are in the tree, in document order.
  // Review Focus 2: an unnamed field is there too, with no SOM name.
  it('keeps draws and unnamed fields in document order', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="tb">
      <draw name="d" h="5pt" w="1in"/>
      <field h="10pt" w="1in"><ui><textEdit/></ui></field>
      <field name="b" h="10pt" w="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const kids = t.roots[0].node.children[0].children;
    expect(kids.map((k) => [k.kind, k.label, k.field])).toEqual([
      ['draw', 'd', undefined],
      ['field', '<field>', undefined],
      ['field', 'b[0]', 'form1[0].Page1[0].b[0]'],
    ]);
  });

  it('carries the layout attributes a container states', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position">
      <subform name="T" layout="table" columnWidths="1in -1" minH="2in" maxW="3in"
               presence="invisible" hAlign="left">
        <margin leftInset="1pt" topInset="2pt"/>
        <subform name="R" layout="row">
          <field name="c" colSpan="2" h="10pt"><ui><textEdit/></ui>
            <margin leftInset="9pt"/></field>
        </subform></subform></subform></subform>`);
    const T = t.roots[0].node.children[0].children[0];
    expect(T).toMatchObject({
      kind: 'subform', layout: 'table', columnWidths: '1in -1',
      minMax: { minH: '2in', maxW: '3in' }, presence: 'invisible', hAlign: 'left',
      margin: { leftInset: '1pt', topInset: '2pt' },
    });
    const c = T.children[0].children[0];
    expect(c).toMatchObject({ kind: 'field', colSpan: '2' });
    // A FIELD's margin is its edit-region inset, applied by xfageom, not a
    // container inset: it stays off the layout node.
    expect(c.margin).toBeUndefined();
  });

  it('marks a repeating subform occur, and an exclGroup with its own kind', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position">
      <subform name="R"><occur max="3"/></subform>
      <exclGroup name="G"><field name="o" w="1pt" h="1pt"><ui><checkButton/></ui></field></exclGroup>
      </subform></subform>`);
    const kids = t.roots[0].node.children[0].children;
    expect(kids[0]).toMatchObject({ kind: 'subform', layout: 'occur' });
    expect(kids[1]).toMatchObject({ kind: 'exclGroup', layout: 'position' });
    expect(kids[1].children[0].field).toBe('form1[0].Page1[0].G[0].o[0]');
  });

  it('roots no page whose pageArea cannot be resolved', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea name="P1"/></pageSet>
      <subform name="Page1"><breakBefore target="Nowhere"/></subform></subform>`);
    expect(t.roots).toEqual([]);
  });

  it('gives a pageArea with no contentArea an empty root geometry', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea name="P1"/></pageSet>
      <subform name="Page1"/></subform>`);
    expect(t.roots[0].node.geom).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xfatemplate.test.ts -t "layout tree"`
Expected: FAIL with `Cannot read properties of undefined (reading 'length')` / `'0'`, because `roots` does not exist.

- [ ] **Step 3: Build the tree**

In `src/xfatemplate.ts`:

1. Add the import below the existing `xfageom.js` type import:

```ts
import type { LayoutKind, LayoutNode, XfaMinMax } from './xfaflow.js';
```

2. Replace `export interface XfaTemplate { fields: XfaField[]; pages: XfaPageArea[] }` with:

```ts
/** One page's layout tree, rooted at its `contentArea`. */
export interface XfaLayoutRoot { pageIndex: number; node: LayoutNode }

export interface XfaTemplate {
  fields: XfaField[];
  pages: XfaPageArea[];
  /** One tree per page subform whose `pageArea` resolved, for `xfaflow.ts`. */
  roots: XfaLayoutRoot[];
}
```

3. Extract the `<margin>` read out of `fieldOf` into a helper placed above `fieldOf`, and make `fieldOf` call it. Replace the block in `fieldOf` that begins `const marEl = child(el, 'margin');` and ends `) as XfaMargin : undefined;` with:

```ts
  const margin = marginOf(el);
```

and add above `fieldOf`:

```ts
/** An element's OWN `<margin>` insets, absent ones omitted. `child` searches
 *  DIRECT children only, which is what keeps the `<ui><textEdit><margin>` a
 *  real LiveCycle field also carries out of it -- reading that one instead
 *  drops every inset in the form. */
function marginOf(el: XmlNode): XfaMargin | undefined {
  const marEl = child(el, 'margin');
  return marEl ? Object.fromEntries(
    (['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const)
      .flatMap((k) => {
        const v = marEl.attrs.get(k);
        return v === undefined ? [] : [[k, v] as const];
      }),
  ) as XfaMargin : undefined;
}
```

4. Add after `layoutOf`:

```ts
/** One template element to its layout node. A container carries its layout,
 *  its own margin and a table's column widths; a field or draw carries only
 *  what positions it in its parent. */
function nodeOf(el: XmlNode, kind: LayoutKind, label: string, field?: string): LayoutNode {
  const n: LayoutNode = { kind, label, geom: geomOf(el), children: [] };
  if (kind !== 'field' && kind !== 'draw') {
    n.layout = layoutOf(el);
    const m = marginOf(el);
    if (m) n.margin = m;
    const cw = el.attrs.get('columnWidths');
    if (cw !== undefined) n.columnWidths = cw;
  }
  const mm: XfaMinMax = {};
  for (const k of ['minW', 'minH', 'maxW', 'maxH'] as const) {
    const v = el.attrs.get(k);
    if (v !== undefined) mm[k] = v;
  }
  if (Object.keys(mm).length > 0) n.minMax = mm;
  const colSpan = el.attrs.get('colSpan');
  if (colSpan !== undefined) n.colSpan = colSpan;
  const hAlign = el.attrs.get('hAlign');
  if (hAlign !== undefined) n.hAlign = hAlign;
  const presence = el.attrs.get('presence');
  if (presence !== undefined) n.presence = presence;
  if (field !== undefined) n.field = field;
  return n;
}

/** A page's root: its `contentArea`, which always uses positioned layout
 *  (XFA 3.3 p. 280), holding the page subform. */
function pageRootOf(pageArea: XmlNode, page: LayoutNode): LayoutNode {
  const ca = pageArea.children.find((c) => c.name === 'contentArea');
  return {
    kind: 'page', label: 'contentArea', layout: 'position',
    geom: ca ? geomOf(ca) : {}, children: [page],
  };
}
```

5. Change `walk`'s signature and body. The new signature is:

```ts
function walk(
  el: XmlNode, path: readonly string[], group: string | undefined,
  ctx: ChainCtx, pages: readonly XmlNode[], out: XfaField[],
  parent: LayoutNode | undefined, roots: XfaLayoutRoot[],
): void {
```

Inside the `for (const c of el.children)` loop, replace the `if (c.name === 'field') { ... continue; }` block with:

```ts
    if (c.name === 'draw') {
      if (parent) {
        parent.children.push(
          nodeOf(c, 'draw', partial === undefined || partial === '' ? '<draw>' : partial),
        );
      }
      continue;
    }
    if (c.name === 'field') {
      const sub = partial === undefined || partial === ''
        ? path : [...path, indexed(partial)];
      const f = fieldOf(c, sub, group);
      if (f) {
        f.geom = geomOf(c);
        f.layouts = [...ctx.layouts];
        f.offsets = [...ctx.offsets];
        if (ctx.pageIndex !== undefined) f.pageIndex = ctx.pageIndex;
        out.push(f);
      }
      // An unnamed field still takes up its space in a flow, so it joins the
      // tree with no SOM name.
      if (parent)
        parent.children.push(nodeOf(c, 'field', sub === path ? '<field>' : sub[sub.length - 1], f?.name));
      continue;
    }
```

After `const sub = partial === undefined || partial === '' ? path : [...path, indexed(partial)];` (the container one), add:

```ts
    const node = nodeOf(c, c.name as LayoutKind, sub === path ? `<${c.name}>` : sub[sub.length - 1]);
```

Inside the `if (carriesPageSet) { ... }` branch, after `const ca = ...` and before `next = {`, add:

```ts
      if (idx !== undefined) roots.push({ pageIndex: idx, node: pageRootOf(pages[idx], node) });
```

In the final `else { next = { ... } }` branch (the one for `ctx.inPage`), add before `next = {`:

```ts
      parent?.children.push(node);
```

Replace the recursive call `walk(c, sub, c.name === 'exclGroup' ? somName(sub) : group, next, pages, out);` with:

```ts
    walk(
      c, sub, c.name === 'exclGroup' ? somName(sub) : group, next, pages, out,
      next.inPage ? node : undefined, roots,
    );
```

6. In `parseXfaTemplate`, replace the walk call and the return:

```ts
  const fields: XfaField[] = [];
  const roots: XfaLayoutRoot[] = [];
  walk(root, [], undefined, { layouts: [], offsets: [], inPage: false }, pageEls, fields, undefined, roots);
  return { fields, pages: pageEls.map(pageAreaOf), roots };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/xfatemplate.test.ts test/xfaconvert.test.ts && npm run typecheck`
Expected: PASS. The converter does not read `roots` yet, so its tests are untouched.

- [ ] **Step 5: Commit**

```bash
git add src/xfatemplate.ts test/xfatemplate.test.ts
git commit -m "feat(164g.1): XFA template builds a layout tree per page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the engine into the converter; retire the chain arithmetic

**Files:**
- Modify: `src/xfageom.ts`, `src/xfatemplate.ts`, `src/xfaconvert.ts`
- Modify: `test/xfageom.test.ts`, `test/xfatemplate.test.ts`, `test/xfadata.test.ts`, `test/xfaconvert.test.ts`, `test/helpers/build-xfa-pdf.ts`, `test/xfa-real.test.ts`, `test/xfa-flow-oracle.test.ts`

**Interfaces:**
- Consumes: `layoutPage`, `Placed` (Task 1); `XfaTemplate.roots` (Task 3).
- Produces: `export function editRegion(box: XfaBox, caption?: XfaCaption, margin?: XfaMargin): XfaBox | { reason: string }` in `xfageom.ts`. Removes `boxFor`, `accumulateOrigin`, `XfaOffset` from `xfageom.ts`, and `geom`/`offsets` from `XfaField`.

- [ ] **Step 1: Write the failing tests**

Add two templates to `test/helpers/build-xfa-pdf.ts`, after `FLOWED_TEMPLATE`:

```ts
/** Review Focus 1: a flowed page subform whose contentArea states its size,
 *  so the flow is bounded and its fields are placed. */
export const FLOWED_BOUNDED_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1">
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/>
    <medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="tb">
    <field name="a" w="3in" h="20pt"><ui><textEdit/></ui></field>
    <field name="b" w="3in" h="20pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;

/** Review Focus 5: a hidden field on a fully positioned page. */
export const HIDDEN_POSITIONED_TEMPLATE = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="h" presence="hidden" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
  </subform></subform></template>`;
```

Add them to the import in `test/xfaconvert.test.ts`, and add this `describe` block after `describe('buildXfaPlan: classification', ...)`:

```ts
describe('buildXfaPlan: flow layout', () => {
  it('places the fields of a flowed page whose contentArea bounds it', () => {
    const p = planOf(buildXfaPdf({ template: FLOWED_BOUNDED_TEMPLATE }));
    expect(p.report.fields.map((f) => f.route)).toEqual(['positioned', 'positioned']);
    expect(p.report.skipped).toEqual([]);
    // contentArea at 0.5in; b sits 20pt below a. y-flipped against 792.
    expect(p.entries[0].rect).toEqual([36, 736, 252, 756]);
    expect(p.entries[1].rect).toEqual([36, 716, 252, 736]);
  });

  it('converts a hidden positioned field bare, saying why', () => {
    const p = planOf(buildXfaPdf({ template: HIDDEN_POSITIONED_TEMPLATE }));
    expect(p.report.fields[0].route).toBe('bare');
    expect(p.report.skipped[0].reason).toMatch(/presence="hidden" takes no space/);
  });
});
```

In `test/xfa-real.test.ts`, in `reproduces every placed rect Adobe wrote`, replace the comment and assertion

```ts
    // Pinned EXACTLY: 151 positioned-chain fields plus the eight that omit x.
    // The other 40 of f1040's 199 are flow-laid -- test/xfa-flow-oracle.test.ts.
    expect(compared).toBe(159);
```

with:

```ts
    // Pinned EXACTLY: every one of f1040's 199 fields. 151 positioned-chain
    // fields, the eight that omit x (b1xv), and the 40 flow-laid ones in
    // Table_Dependents (164g.1) -- table, row, and lr-tb.
    expect(compared).toBe(199);
```

and append to that test's JSDoc:

```ts
   *
   * 159 became 199 with `164g.1`: the 40 fields of `Table_Dependents` are
   * laid out by the flow engine, and each lands exactly on Adobe's rect.
```

Replace the test `degrades the table-laid fields to geometry-less and says so` with:

```ts
  // The table-laid fields used to degrade to geometry-less. With the flow
  // engine (164g.1) none is left bare.
  it('leaves no field of f1040 without a widget', () => {
    const { report } = converted();
    expect(report.fields.filter((f) => f.route === 'bare')).toEqual([]);
    expect(report.skipped.filter((s) => s.what === 'field')).toEqual([]);
    expect(report.dataOnly).toBe(false);
  });
```

In `test/xfa-flow-oracle.test.ts`, replace the test `is exactly the set the converter leaves without a widget` with:

```ts
  // What the oracle is for: every flowed field placed, and placed where Adobe's
  // layout engine put it, to a hundredth of a point.
  it('is reproduced exactly by the flow engine, all 40 fields', () => {
    const doc = Document.Open(
      new Uint8Array(readFileSync(new URL('./fixtures/xfa/irs-f1040.pdf', import.meta.url))),
    );
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    if (isDict(acro)) acro.set('Fields', []);
    for (const p of doc.Pages) p.Dict.delete('Annots');
    const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
    const route = new Map(report.fields.map((f) => [f.name, f]));
    let worst = 0;
    for (const e of oracle.flowed) {
      expect(route.get(e.name)?.route).toBe('positioned');
      expect(route.get(e.name)?.page).toBe(e.page);
      const got = doc.resolve(doc.Form.Get(e.name)!.Dict.get('Rect')) as number[];
      worst = Math.max(worst, ...[0, 1, 2, 3].map((i) => Math.abs(got[i] - e.adobe[i])));
    }
    expect(worst).toBeLessThanOrEqual(0.01);
  });
```

Update the `describe` JSDoc at the top of that file. Replace `` `164g.1` lays out flowed subforms and is checked against this; until it lands, these cases pin what the oracle contains and that the converter leaves exactly these fields unplaced. `` with:

```
`164g.1` lays out flowed subforms, and these cases pin both what the oracle contains and that the engine reproduces it exactly.
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xfaconvert.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts`
Expected: FAIL. `FLOWED_BOUNDED_TEMPLATE` reports `bare`, the hidden field is `positioned`, `compared` is 159 against 199, the bare list is non-empty, and the oracle fields are `bare`.

- [ ] **Step 3: Implement**

**`src/xfageom.ts`:**

1. Delete `XfaOffset`, `accumulateOrigin`, and `boxFor`, together with the misplaced JSDoc above `XfaCaption`. That JSDoc begins `A field's box in the page's XFA frame, or a reason naming why it has none.` and currently sits between `XfaRawGeom` and `XfaCaption`.
2. Keep `XfaRawGeom`, but update its JSDoc to: `/** A node's own geometry attributes, verbatim from the template. */`.
3. Add at the end of the file:

```ts
/**
 * A field's EDIT region -- its laid-out box minus its caption reserve and its
 * own `<margin>` insets. This is what a widget covers.
 *
 * Their ORDER is not load-bearing and the corpus provably cannot discriminate
 * it: both subtract fixed amounts from named edges, so the resulting rect is
 * the same either way, and f1040 never pairs a caption with an inset on the
 * SAME edge. Only the two refusal guards differ, each testing the room left at
 * its own step, which is the safe direction for both.
 */
export function editRegion(
  box: XfaBox, caption?: XfaCaption, margin?: XfaMargin,
): XfaBox | { reason: string } {
  const edit = applyCaption(box, caption);
  if ('reason' in edit) return edit;
  return applyMargin(edit, margin);
}
```

4. Update the `XFA_FLOW_LAYOUTS` JSDoc. Replace `Anything not `'position'` degrades, so this list is documentation rather than the test.` with:

```
Since `164g.1` the first four are laid out by `xfaflow.ts`; `occur` still refuses (164g.2). `chainIsPositioned` is kept for the flow oracle, which classifies fields by it.
```

**`src/xfatemplate.ts`:**

1. Remove the `geom`, `layouts` and `offsets` JSDoc'd members from `XfaField` except `layouts`. Delete:

```ts
  /** Filled by the geometry pass. */
  geom: XfaRawGeom;
```

and

```ts
  /** Each of those containers' own x/y, in the same order. */
  offsets: XfaOffset[];
```

2. In `fieldOf`'s returned object, delete `geom: {},` and `offsets: [],`.
3. In the walk's field branch, delete `f.geom = geomOf(c);` and `f.offsets = [...ctx.offsets];`.
4. Remove `offsets` from `ChainCtx` and from every `next = { ... }` and the initial `{ layouts: [], offsets: [], inPage: false }`. In the page branch, `next` becomes:

```ts
      next = {
        layouts: [...(ca ? ['position'] : []), layoutOf(c)],
        ...(idx !== undefined ? { pageIndex: idx } : {}),
        inPage: true,
      };
```

`ca` there is now only a presence test, so replace `const ca = idx === undefined ? undefined : contentAreaOffset(pages[idx]);` with:

```ts
      const ca = idx === undefined
        ? undefined : pages[idx].children.find((p) => p.name === 'contentArea');
```

5. Delete `offsetOf` and `contentAreaOffset`.
6. Change the type import to `import type { XfaMargin, XfaMedium, XfaRawGeom } from './xfageom.js';`.

**`src/xfaconvert.ts`:**

1. Replace the `xfageom.js` import with:

```ts
import { buttonBox, editRegion, mediumAgrees, rectFromBox } from './xfageom.js';
import { layoutPage, type Placed } from './xfaflow.js';
```

2. After step 4 of `buildXfaPlan` (the per-page medium loop), add:

```ts
  // 4b. Lay out every page that may carry geometry, once. The result is keyed
  //     by field SOM name; a field the walk did not reach has no entry.
  const placed = new Map<string, Placed>();
  if (!noGeometry) {
    for (const r of tpl.roots) {
      if (badPages.has(r.pageIndex)) continue;
      for (const [k, v] of layoutPage(r.node)) placed.set(k, v);
    }
  }
```

3. Change the call to `geometryFor(f, entry, doc, noGeometry, badPages, placed)`, and replace `geometryFor` with:

```ts
/**
 * Give `entry` its `page` and `rect`, or return the reason it has none.
 *
 * `''` means "already reported" -- the page-level refusals, whose one entry
 * names the cause for every field on that page.
 */
function geometryFor(
  f: XfaField, entry: PlanEntry, doc: Document,
  noGeometry: boolean, badPages: ReadonlySet<number>,
  placed: ReadonlyMap<string, Placed>,
): string | undefined {
  if (noGeometry) return '';
  if (f.pageIndex === undefined)
    return 'the field could not be traced to a pageArea, so it carries no geometry';
  if (badPages.has(f.pageIndex)) return '';
  const p = placed.get(f.name);
  if (p === undefined)
    return 'the field is not in its page layout tree, so it carries no geometry';
  if ('reason' in p) return `${p.reason}, so the field carries no geometry`;
  const box = editRegion(p.box, f.caption, f.margin);
  if ('reason' in box) return `${box.reason}, so the field carries no geometry`;
  // A check button's widget is the BUTTON, not the edit region it sits in. Only
  // this UI kind states a size of its own, so every other field takes the box
  // unchanged.
  const button = f.ui === 'checkButton'
    ? buttonBox(box, {
      ...(f.buttonSize !== undefined ? { size: f.buttonSize } : {}),
      ...(f.para?.hAlign !== undefined ? { hAlign: f.para.hAlign } : {}),
      ...(f.para?.vAlign !== undefined ? { vAlign: f.para.vAlign } : {}),
      ...(f.caption?.placement !== undefined
        ? { captionPlacement: f.caption.placement } : {}),
    })
    : box;
  if ('reason' in button) return `${button.reason}, so the field carries no geometry`;
  entry.page = f.pageIndex + 1;
  entry.rect = rectFromBox(button, doc.Pages[f.pageIndex].CropBox);
  return undefined;
}
```

4. In the module JSDoc's "never an approximate rect" paragraph, replace `-- an unknown unit, a flowed ancestor, a medium mismatch, a `rotate`, an unresolvable page --` with `-- an unknown unit, a flow the engine refuses, a medium mismatch, a `rotate`, an unresolvable page --`.

**Migrate `test/xfageom.test.ts`:**

1. Change the import to:

```ts
import {
  measureToPt, anchorShift, rectFromBox, XFA_ANCHORS,
  mediumSizePt, mediumAgrees, chainIsPositioned, editRegion,
  MEDIUM_TOLERANCE_PT, buttonBox,
} from '../src/xfageom.js';
```

2. Delete `describe('accumulateOrigin', ...)` and `describe('boxFor', ...)` entirely. Their rules now live in `test/xfaflow.test.ts`: "sums every level of the chain", "reads an absent x or y as zero", "applies the field anchor shift", "refuses a rotate…", and "accepts rotate=\"0\"".
3. Replace `describe('boxFor: the caption reserve', ...)` and `describe('boxFor: the margin insets', ...)` with:

```ts
const mm = (v: number) => (v * 72) / 25.4;

describe('editRegion: the caption reserve', () => {
  // The rule the f1040 oracle found, in miniature. A field's box includes its
  // LABEL; the widget covers only the edit region. f1_01 is the real case:
  // 280.8pt wide with a 192.8pt reserve, and Adobe's widget is exactly 88pt.
  it('eats the reserve from the left by default', () => {
    expect(editRegion({ x: 0, y: 0, w: 280.8, h: 12 }, { reserve: '192.8pt' }))
      .toEqual({ x: 192.8, y: 0, w: 88, h: 12 });
  });

  it('eats it from whichever edge placement names', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(editRegion(box, { reserve: '20pt', placement: 'right' }))
      .toEqual({ x: 0, y: 0, w: 80, h: 50 });
    // XFA's y runs DOWNWARD, so a top caption pushes the edit region down.
    expect(editRegion(box, { reserve: '20pt', placement: 'top' }))
      .toEqual({ x: 0, y: 20, w: 100, h: 30 });
    expect(editRegion(box, { reserve: '20pt', placement: 'bottom' }))
      .toEqual({ x: 0, y: 0, w: 100, h: 30 });
  });

  // presence="hidden" means the caption occupies NO space; "invisible" is
  // undrawn but still reserved, so it still eats.
  it('reserves nothing for a hidden caption and still reserves for an invisible one', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(editRegion(box, { reserve: '20pt', presence: 'hidden' }))
      .toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(editRegion(box, { reserve: '20pt', presence: 'invisible' }))
      .toEqual({ x: 20, y: 0, w: 80, h: 50 });
  });

  it('leaves a captionless field alone', () => {
    expect(editRegion({ x: 0, y: 0, w: 100, h: 50 }, {}))
      .toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  // Never an approximate rect: a reserve that swallows the field, an unreadable
  // one, and a placement outside the four each degrade rather than guess.
  it('degrades rather than emitting a rect it cannot justify', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    for (const cap of [
      { reserve: '100pt' },
      { reserve: '120pt' },
      { reserve: '3px' },
      { reserve: '20pt', placement: 'inline' },
    ]) expect(editRegion(box, cap)).toHaveProperty('reason');
  });
});

describe('editRegion: the margin insets', () => {
  // The second rule the f1040 oracle found, and it corrects the guess this bug
  // was filed on: the residue is the <margin>, not the <border>. Measured over
  // all 54 distinct textEdit declaration shapes in that form, our width error
  // was leftInset+rightInset and our height error topInset+bottomInset, EXACTLY
  // and with no exception -- while the border edge thickness varied
  // independently across those same rows and moved nothing.
  it('insets the edit region by all four', () => {
    expect(editRegion(
      { x: 0, y: 0, w: 100, h: 50 }, undefined,
      { leftInset: '1pt', rightInset: '2pt', topInset: '4pt', bottomInset: '8pt' },
    )).toEqual({ x: 1, y: 4, w: 97, h: 38 });
  });

  it('treats an absent inset as zero and an absent margin as none', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(editRegion(box, undefined, { rightInset: '10pt' }))
      .toEqual({ x: 0, y: 0, w: 90, h: 50 });
    expect(editRegion(box, undefined, {})).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(editRegion(box, undefined, undefined)).toEqual({ x: 0, y: 0, w: 100, h: 50 });
  });

  // f1040's f1_03, whole: a 36x12 field with a 15pt left caption reserve and
  // rightInset="1.4111mm" topInset=bottomInset="0.1764mm". Adobe's widget is
  // [468.6 732.502 485.6 743.501] -- 17 x 10.999 -- against a field x of
  // 160.02mm. Both rules at once, on the numbers that found them.
  it('reproduces f1_03: the caption reserve and the insets together', () => {
    const b = editRegion(
      { x: mm(160.02), y: mm(16.933), w: mm(12.7), h: mm(4.233) },
      { reserve: '5.2917mm' },
      { rightInset: '1.4111mm', topInset: '0.1764mm', bottomInset: '0.1764mm' },
    ) as { x: number; y: number; w: number; h: number };
    expect(b.x).toBeCloseTo(468.6, 2);
    expect(b.w).toBeCloseTo(17, 2);
    expect(b.h).toBeCloseTo(11, 2);
    // XFA's y runs DOWNWARD, so the top inset pushes the edit region down.
    expect(b.y).toBeCloseTo(48.5, 2);
  });

  it('degrades on an inset it cannot read, by name', () => {
    const r = editRegion({ x: 0, y: 0, w: 100, h: 50 }, undefined, { leftInset: '3px' });
    expect(r).toHaveProperty('reason');
    expect((r as { reason: string }).reason).toContain('leftInset');
  });

  // Never an approximate rect: insets that leave no edit region degrade rather
  // than emitting a zero-or-negative one, exactly as the caption reserve does.
  it('degrades when the insets leave no edit region', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(editRegion(box, undefined, { leftInset: '60pt', rightInset: '40pt' }))
      .toHaveProperty('reason');
    expect(editRegion(box, undefined, { topInset: '50pt' })).toHaveProperty('reason');
  });
});
```

**Migrate `test/xfadata.test.ts`:** on line 13, replace `geom: {}, layouts: [], offsets: [], ...extra,` with `layouts: [], ...extra,`.

**Migrate `test/xfatemplate.test.ts`:**

1. Replace `describe('parseXfaTemplate: geometry', ...)` with:

```ts
describe('parseXfaTemplate: geometry', () => {
  const PAGE = `<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>`;
  const leafOf = (t: ReturnType<typeof tpl>) => t.roots[0].node.children[0].children[0];

  it('carries the field own geometry attributes verbatim on its layout node', () => {
    const t = tpl(`${PAGE}<subform name="f" layout="position">
      <field name="a" x="1in" y="2in" w="3in" h="0.25in"
             anchorType="middleCenter" rotate="90"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(leafOf(t).geom).toEqual({
      x: '1in', y: '2in', w: '3in', h: '0.25in',
      anchorType: 'middleCenter', rotate: '90',
    });
  });

  it('omits an absent attribute rather than storing an empty string', () => {
    const t = tpl(`${PAGE}<subform name="f" layout="position">
      <field name="a" x="1in"><ui><textEdit/></ui></field></subform></subform>`);
    expect(leafOf(t).geom).toEqual({ x: '1in' });
  });
});
```

2. In `excludes the pageSet-carrying subform from the chain`, replace `expect(a.offsets).toEqual([{ x: '0in', y: '0in' }]);` with:

```ts
    expect(t.roots[0].node.children[0].geom).toEqual({ x: '0in', y: '0in' });
```

3. In `records every container below the page origin, outermost first`, replace `expect(a.offsets).toEqual([{ x: '1in', y: '2in' }, { x: '3pt' }]);` with:

```ts
    const P = t.roots[0].node.children[0];
    expect(P.geom).toEqual({ x: '1in', y: '2in' });
    expect(P.children[0].geom).toEqual({ x: '3pt' });
```

4. In `adds a contentArea origin when the chain passes through one`, rename the test to `roots the chain at the contentArea and records it as position`, and replace `expect(a.offsets[0]).toEqual({ x: '0.25in', y: '0.5in' });` with:

```ts
    expect(t.roots[0].node.geom).toMatchObject({ x: '0.25in', y: '0.5in' });
```

- [ ] **Step 4: Run the XFA tests and the fence**

Run: `npx vitest run test/xfaflow.test.ts test/xfageom.test.ts test/xfatemplate.test.ts test/xfaconvert.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts test/xfa-public-api.test.ts test/xfadata.test.ts test/xfapacket.test.ts && npm run typecheck`
Expected: PASS, including `compared` = 199, `exact` = 199 and `worst` ≤ 0.01.

If the 199 equality fails with fewer than 199 exact, the unification moved a positioned rect. The two candidates are (a) a container margin, now applied (spec p. 1510) where the chain arithmetic ignored it, and (b) a container `anchorType`, now applied. Diagnose with:

```bash
npx vitest run test/xfa-real.test.ts -t "every placed rect" 2>&1 | tail -30
```

Then print the first mismatching name, its rect and Adobe's, and inspect that field's ancestors in the template. Do **not** loosen the bound.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/xfageom.ts src/xfatemplate.ts src/xfaconvert.ts test/xfageom.test.ts test/xfatemplate.test.ts test/xfadata.test.ts test/xfaconvert.test.ts test/helpers/build-xfa-pdf.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts
git commit -m "feat(164g.1): place flowed XFA fields; all 199 f1040 rects exact

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mutation sweep and documentation

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`, `test/fixtures/xfa/PROVENANCE.md`

**Interfaces:**
- Consumes: everything above. Produces nothing new in code.

- [ ] **Step 1: Run the mutation sweep**

For each mutation:
1. Apply it with the Edit tool.
2. Run `git diff --stat src/` and confirm it actually changed the file. A no-op mutation reports green and looks like a coverage gap.
3. Run `npx vitest run test/xfaflow.test.ts test/xfa-real.test.ts test/xfa-flow-oracle.test.ts`.
4. Record which cases went red.
5. Restore with `git checkout -- src/xfaflow.ts src/xfaconvert.ts`.

A hung run leaves vitest workers spinning. If a run exceeds two minutes, kill the `node` processes started after the run began before trusting the next one.

| # | Mutation (in `src/xfaflow.ts` unless noted) | Must redden |
|---|---|---|
| 1 | `table()`: `size: { w, h: rowH }` → `size: { w, h: c.h }` (no row-height expansion) | "expands every cell in a row" |
| 2 | `table()`: `if (tok !== 'auto') { widths.push(tok); continue; }` → `if (tok !== 'auto') { widths.push(10); continue; }` | "places cells by column width"; the oracle |
| 3 | `table()`: `const w = sum(widths.slice(k, k + c.span));` → `const w = widths[k];` | "spans columns" |
| 4 | `flowTb`: `y += size.h;` deleted | "stacks children" |
| 5 | `flowLrTb`: `if (x > 0 && x + size.w > width + EPS)` → `if (false)` | "wraps to the left edge" |
| 6 | `flowLrTb`: the mixed-heights `if` → `if (false)` | "refuses a wrap after a line of mixed heights" |
| 7 | `positionOne`: `x: m.l + (x ?? 0) + dx` → `x: (x ?? 0) + dx` | "shifts positioned children by the container margin" |
| 8 | `measure`: the growable branch returns `{ w: w ?? 0, h: h ?? 0 }` | "sizes a growable container from its children" |
| 9 | `concealed`: always returns `undefined` | presence cases |
| 10 | `flowTb`: `if (broken) { out.set(c, after(broken)); continue; }` deleted | "refuses an unsizable item and every later sibling" |
| 11 | `positionOne`: `if (anchor !== undefined && anchor !== 'topLeft')` → `if (false)` | both anchor cases |
| 12 | `flowLrTb`: `out.set(c, { x: m.l + x, y: m.t + y })` → `{ x: m.l + x, y: m.t }` | "wraps to the left edge" |
| 13 | `src/xfaconvert.ts`: `editRegion(p.box, f.caption, f.margin)` → `p.box` (wrapped to keep the type) | the 199 equality |

Every row must redden. A row that stays green is either a missing test, which you add and then re-run, or an equivalent mutant, which you record in CLAUDE.md with the reason. Record the result count for Step 3.

- [ ] **Step 2: Update CHANGELOG.md**

Under `## [Unreleased]` → `### Added` (create the heading if absent), add:

```markdown
- **XFA fields under flowed subforms now get widgets.** `ConvertXfaToAcroForm` used to place a field only when every container above it used `layout="position"`, so a field inside a `tb`, `lr-tb` or `table` subform converted as a fillable dict that nothing drew. It now lays those containers out from the sizes the template states — each field's `w`/`h`, a table's `columnWidths`, and the extent a container takes from its children — following the XFA 3.3 specification's flowing-layout and table rules, cited by page in the source. Checked against the rects Adobe's own layout engine wrote into IRS f1040: the 40 table cells of its dependents section, previously unplaced, now land exactly on Adobe's rects, so all 199 of that form's fields have widgets. Shapes the specification does not settle, and anything whose size depends on text measurement, repetition or page breaking, still convert without a widget and are reported with a reason; positioned layout is now the same engine, which also applies a container's margin and `anchorType` as the specification says. A field with `presence="hidden"` or `"inactive"` now converts without a widget even on a positioned page, since it takes no space in the layout. (164g.1)
```

- [ ] **Step 3: Update README.md**

In the XFA bullet under **Scope and Limitations** (it begins `- **XFA converts to AcroForm, but there is no dynamic layout engine**`), replace the bold lead-in and the three sentences from `What it does **not** do is compute layout:` through `nothing draws it.` with:

```markdown
- **XFA converts to AcroForm, with flow layout for stated sizes only** — `doc.ConvertXfaToAcroForm()` reads an `/AcroForm /XFA` packet (single-stream XDP or the alternating name/stream array), models the `template` packet's field set, binds values out of `datasets`, and emits a real `/AcroForm` field tree; `/XFA` and the catalog's `/NeedsRendering` are then removed by default. Fields are laid out under `position`, `tb`, `lr-tb`, `table` and `row` containers following the XFA 3.3 specification's rules, but only from sizes the template **states**: each field's and draw's `w`/`h`, a table's `columnWidths`, and the extent a container takes from its children. There is no text measurement, no repetition (`<occur>`) and no page breaking, so a field or draw whose size comes from its content (an absent `w`/`h`, or `minH`/`maxH`/`minW`/`maxW`), a repeating subform, content that overflows its `contentArea`, `rl-tb`/`rl-row`, a non-left `hAlign` in a flow, and an `lr-tb` that would wrap after a line of mixed heights each leave the affected fields — and, in a flow, every field after them — as **geometry-less field dicts**: `doc.Form` finds them, fills them and exports them, and nothing draws them. A field with `presence="hidden"` or `"inactive"` takes no space and converts the same way.
```

In the same bullet, replace `all 199 of f1040's field names reproduce exactly, and so do **all 159 of its placed rects**` with `all 199 of f1040's field names reproduce exactly, and so do **all 199 of its rects**, the 40 table-laid ones included`.

- [ ] **Step 4: Update CLAUDE.md**

1. In the XFA entry's module list line (begins `- **xfapacket.ts**, **xfatemplate.ts**, **xfadata.ts**, **xfageom.ts**,`), add `**xfaflow.ts**` after `**xfageom.ts**,`.
2. Append to that entry, after the `**Note (`164g.5`), the FLOW oracle...` paragraph:

```markdown
  **Invariant (`164g.1`):** `xfaflow.ts` is the ONE layout engine, and
  `position` is a case of it -- a positioned field and a flowed one cannot be
  placed by two rules. It is a pure leaf over `xfageom.js` and never throws;
  `layoutPage(root)` maps each field SOM name to a box or a reason.
  `xfatemplate.ts` builds the tree (`XfaTemplate.roots`, one per resolved page,
  rooted at the `contentArea`), and DRAWS are in it because they take up space
  in a flow. `boxFor`/`accumulateOrigin` are gone; `editRegion` is what is left
  of them in `xfageom.ts`.
  **Invariant:** every rule is transcribed from the XFA Specification 3.3
  (not vendored; SHA-256 and pages in the design doc and in the source), and a
  shape it leaves open REFUSES: a non-left `hAlign` in a flow, an `lr-tb` wrap
  after a line of mixed heights, a `-1` column no single-column cell sizes, a
  row stating its own size or margin. Text-sized items refuse to `164g.7`,
  `<occur>` to `164g.2`, overflow to `164g.3`.
  **Invariant:** in a flow a failure fails every LATER sibling, named
  `an earlier item in its flow could not be laid out (<cause>)`; in `position`
  it fails only itself, since nothing else's place depends on it.
  **Invariant, and the old chain arithmetic got it wrong silently:** a
  container's margin shifts its positioned children (Appendix A, p. 1510:
  `Px = Cx + Mx + Ox`) and a container's `anchorType` is applied. f1040 has
  neither on a positioned container, so the fence could not have seen the old
  omission.
  **Note on the oracle:** f1040's 40 flowed fields cover `table`, `row` and a
  one-line `lr-tb` cell. The `tb` stacking, the `lr-tb` wrap, `colSpan`, `-1`
  columns and every refusal rest on `test/xfaflow.test.ts` alone.
  **Note, measured:** <N> of 13 mutations redden (fill in from Task 5 Step 1,
  naming any equivalent mutant and why).
```

Replace `<N>` and the parenthetical with the actual result from Step 1 before committing.

3. In the `xfageom.ts` invariant that reads `**Invariant (`b1xv`):** a field's OWN absent `x`/`y` is 0, the rule `accumulateOrigin` already applied to every ancestor;`, replace `the rule `accumulateOrigin` already applied to every ancestor` with `the rule the layout engine applies to every node`.

4. Run the module sweep and confirm it prints nothing:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 5: Update test/fixtures/xfa/PROVENANCE.md**

In `## The flow oracle (`164g.5`)`, after the bullet list, add:

```markdown
Since `164g.1` the oracle is asserted for **correctness**, not only for what it
contains: all 40 flowed fields are laid out by `src/xfaflow.ts` and land on
Adobe's rects to 0.01pt (`test/xfa-flow-oracle.test.ts`), and
`test/xfa-real.test.ts`'s equality covers all 199 fields. What the oracle cannot
see, because f1040 does not contain it: `tb` stacking, an `lr-tb` that wraps,
`colSpan`, `-1` columns, short rows, `presence`, growable containers with
margins, and every refusal. Those rest on hand-built cases.
```

In `## What it does NOT cover`, replace `all 159 placed rects reproduce Adobe's` with `all 199 rects reproduce Adobe's`.

- [ ] **Step 6: Run the quality gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit, close, push**

```bash
git add CHANGELOG.md README.md CLAUDE.md test/fixtures/xfa/PROVENANCE.md
git commit -m "docs(164g.1): XFA flow layout in README, CHANGELOG, CLAUDE.md, PROVENANCE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-164g.1
git pull --rebase && git push && git status
```
