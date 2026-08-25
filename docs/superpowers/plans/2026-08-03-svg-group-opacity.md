# SVG Group Opacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `opacity` on an SVG element composite its subtree as a unit through a PDF transparency group, instead of folding the alpha into each child's paint — which double-darkens wherever the subtree overlaps itself.

**Architecture:** `resolveStyle` stops multiplying `opacity` into `fillOpacity`/`strokeOpacity` (which inherit, making the group alpha unrecoverable) and returns it separately. `walk` then decides per element: fold it — exact whenever the element performs exactly one paint operation — or wrap the element in a `/Group /S /Transparency` Form XObject drawn under an ExtGState `ca`. The renderers need no change; `pagerender.ts` already buffers a transparency group when `ca < 1`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

Design spec: `docs/superpowers/specs/2026-08-03-svg-group-opacity-design.md`
Issue: `aspose-pdf-foss-for-ts-1gg0.12` (epic `1gg0`).

## Global Constraints

- **Zero runtime dependencies.** Do not add npm runtime deps. `node:zlib`, `node:crypto`, `node:fs` only.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { invert } from './text.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any task is considered done.
- **TDD.** Write the failing test, watch it fail for the right reason, then implement.
- **A passing new test is not evidence.** Per `CLAUDE.md`: break the code path the test covers and confirm the suite goes red. Task 5 does this explicitly.
- **Errors** are `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `errors.ts`. This plan introduces none — every degradation is a silent, documented fallback.
- **Do not regenerate goldens to make a test pass.** If `test/svg-input-fixtures.test.ts` churns, report it (Task 6) rather than accepting the new bytes.

Run the full suite with `npm test`; a single file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: Stop `<text>` re-resolving its own style

A pre-existing bug, fixed first because the opacity work sits directly on top of it. `walk` resolves the `<text>` node's style into `paint`, then hands that same node to `flattenText`, whose `walkText` resolves the node's own attributes *again* on top of the already-resolved paint. Every own-element paint property is applied twice.

Measured on the current tree:

| SVG | current `ca` | correct |
|---|---|---|
| `<text opacity=".5">` | 0.25 | 0.5 |
| `<text fill-opacity=".5">` | 0.25 | 0.5 |
| `<text opacity=".5" fill-opacity=".5">` | 0.0625 | 0.25 |

`<g opacity=".5"><text>` is already correct (0.5) — the squaring needs an own attribute on the `<text>` element itself, which is why it went unnoticed.

**Files:**
- Modify: `src/svgtext.ts:236-242` (`walkText` signature and its first lines), `src/svgtext.ts:344` (the `flattenText` call)
- Test: `test/svg-opacity.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `walkText(ctx, n, parentPaint, parentStyle, preserve, chain, isRoot = false)` — one added trailing optional boolean. `flattenText`'s public signature is **unchanged**; callers (`svgdraw.ts:1151` and `textMeasure` at `svgdraw.ts:579`) keep passing the element's resolved paint.

- [ ] **Step 1: Write the failing test**

Create `test/svg-opacity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import { ref, isDict, type PdfDict } from '../src/types.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const VP = { minX: 0, minY: 0, w: 100, h: 100 };
const noStreams = () => { let n = 0; return { stream: () => ref(++n) }; };
const noImages = () => { let n = 100; return { image: () => ref(++n) }; };

const draw = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
    noStreams(), noImages());

/** Every `ca` value the drawing registered, so a test can assert the set of
 *  constant alphas without depending on resource-key numbering. */
function alphas(svg: string): number[] {
  const eg = draw(svg).resources.get('ExtGState');
  if (!isDict(eg)) return [];
  const out: number[] = [];
  for (const v of eg.values()) {
    if (!isDict(v)) continue;
    const ca = (v as PdfDict).get('ca');
    if (typeof ca === 'number') out.push(ca);
  }
  return out.sort((a, b) => a - b);
}

describe('<text> resolves its own style exactly once', () => {
  it('does not square fill-opacity on the text element', () => {
    expect(alphas('<svg><text x="0" y="10" fill-opacity="0.5">Hi</text></svg>'))
      .toEqual([0.5]);
  });

  it('does not square opacity on the text element', () => {
    expect(alphas('<svg><text x="0" y="10" opacity="0.5">Hi</text></svg>'))
      .toEqual([0.5]);
  });

  it('combines opacity and fill-opacity once each', () => {
    expect(alphas(
      '<svg><text x="0" y="10" opacity="0.5" fill-opacity="0.5">Hi</text></svg>'))
      .toEqual([0.25]);
  });

  it('still applies an ancestor group opacity to text', () => {
    expect(alphas('<svg><g opacity="0.5"><text x="0" y="10">Hi</text></g></svg>'))
      .toEqual([0.5]);
  });

  it('still applies opacity on a tspan', () => {
    expect(alphas(
      '<svg><text x="0" y="10"><tspan opacity="0.5">Hi</tspan></text></svg>'))
      .toEqual([0.5]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-opacity.test.ts`

Expected: the first three tests FAIL — received `[0.25]`, `[0.25]` and `[0.0625]` against expected `[0.5]`, `[0.5]` and `[0.25]`. The last two PASS already; they are the regression guard proving the fix does not overshoot.

- [ ] **Step 3: Add the `isRoot` parameter to `walkText`**

In `src/svgtext.ts`, change the signature at line 236 and the first lines of the body:

```ts
function walkText(
  ctx: FlattenCtx, n: XmlNode, parentPaint: Paint, parentStyle: SvgTextStyle,
  preserve: boolean, chain: number[], isRoot = false,
): void {
  const css = ctx.css?.get(n);
  const get = styleGetter(n.attrs, css);
  // The ROOT <text> element's paint was already resolved by svgdraw's walk and
  // handed in as `parentPaint`. Resolving it a second time here would apply
  // every own-element paint property twice — squaring fill-opacity and
  // stroke-opacity, and (before it moved to a transparency group) opacity.
  // A tspan is a genuine descendant and does resolve.
  const paint = isRoot ? parentPaint : resolveStyle(parentPaint, n.attrs, css).paint;
```

Leave the rest of the body alone. `get` is still used below for the font properties, which are not part of `Paint` and are read from the node either way.

- [ ] **Step 4: Pass `isRoot` from `flattenText`**

At `src/svgtext.ts:344`:

```ts
  walkText(ctx, node, parent, seed, false, [], true);
```

The recursive call at line 292 (`walkText(ctx, kid, paint, style, ws, here)`) is left untouched — it omits the argument, so children default to `false`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/svg-opacity.test.ts`
Expected: PASS, all five.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`

Expected: green. If `test/svg-text.test.ts` or `test/svg-text-render.test.ts` fails, read the failure before changing anything — a test that encoded the squared value is a test that needs updating with a note, but a test about *inheritance* failing means `isRoot` is being passed on a recursive call by mistake.

- [ ] **Step 7: Commit**

```bash
git add src/svgtext.ts test/svg-opacity.test.ts
git commit -m "fix(svg): <text> no longer resolves its own style twice

walk resolves the <text> node's paint and hands the same node to
flattenText, whose walkText resolved its own attributes again on top —
squaring every own-element paint property. fill-opacity=.5 came out at
0.25, and opacity=.5 fill-opacity=.5 at 0.0625.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Unfold group opacity in the cascade

Behaviour-preserving refactor. `resolveStyle` stops multiplying `opacity` into the two alphas and returns it; both call sites fold it back in themselves, so output is byte-identical. This is the seam every later task needs.

**Files:**
- Modify: `src/svgstyle.ts:203-209` (signature and doc comment), `src/svgstyle.ts:260-265` (the fold)
- Modify: `src/svgdraw.ts:1095` (call site)
- Modify: `src/svgtext.ts:242` (call site — the non-root branch from Task 1)
- Test: `test/svg-opacity.test.ts` (extend)

**Interfaces:**
- Consumes: `walkText(..., isRoot)` from Task 1.
- Produces: `resolveStyle(parent, attrs, css?) => { paint: Paint; refs: string[]; groupOpacity: number }`. `groupOpacity` is the clamped own-element `opacity`, default `1`, **not** multiplied into `paint`. `Paint` gains no field and `INITIAL` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-opacity.test.ts`:

```ts
import { resolveStyle, INITIAL } from '../src/svgstyle.js';

describe('resolveStyle — group opacity is returned, not folded', () => {
  const of = (attrs: Record<string, string>) =>
    resolveStyle(INITIAL, new Map(Object.entries(attrs)));

  it('returns opacity separately and leaves the paint alphas alone', () => {
    const r = of({ opacity: '0.5' });
    expect(r.groupOpacity).toBe(0.5);
    expect(r.paint.fillOpacity).toBe(1);
    expect(r.paint.strokeOpacity).toBe(1);
  });

  it('defaults groupOpacity to 1 and clamps out of range', () => {
    expect(of({}).groupOpacity).toBe(1);
    expect(of({ opacity: '-2' }).groupOpacity).toBe(0);
    expect(of({ opacity: '7' }).groupOpacity).toBe(1);
  });

  it('still folds fill-opacity and stroke-opacity into the paint', () => {
    const r = of({ 'fill-opacity': '0.5', 'stroke-opacity': '0.25' });
    expect(r.paint.fillOpacity).toBe(0.5);
    expect(r.paint.strokeOpacity).toBe(0.25);
    expect(r.groupOpacity).toBe(1);
  });

  it('does not inherit opacity to a child', () => {
    const parent = of({ opacity: '0.5' });
    expect(of({}).groupOpacity).toBe(1);
    expect(resolveStyle(parent.paint, new Map()).groupOpacity).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-opacity.test.ts`
Expected: FAIL — TypeScript reports `groupOpacity` does not exist on the return type, and at runtime `paint.fillOpacity` is `0.5` rather than `1` in the first test.

- [ ] **Step 3: Change `resolveStyle`**

In `src/svgstyle.ts`, extend the doc comment and the return type at lines 203-209:

```ts
/** Resolve one element's paint over its parent's. Presentation attributes are
 *  read first, then inline `style=` overrides them (CSS beats attributes).
 *  `refs` collects the ids of any url() paints, which the caller resolves to
 *  element names for its skipped list.
 *
 *  `groupOpacity` is the element's own `opacity` and is deliberately NOT folded
 *  into the two alphas. Folding it made it inherit through fillOpacity, which
 *  both hid the fact that it applies to the subtree as a UNIT and made it
 *  unrecoverable — see the group-opacity design spec. The caller decides: a
 *  transparency group, or a fold where the element paints exactly once. */
export function resolveStyle(
  parent: Paint, attrs: Map<string, string>, css?: CssDecls,
): { paint: Paint; refs: string[]; groupOpacity: number } {
```

Then replace lines 260-265:

```ts
  const groupOpacity = clamp01(numOr(get('opacity'), 1));
  p.fillOpacity = clamp01(numOr(get('fill-opacity'), 1)) * parent.fillOpacity;
  p.strokeOpacity = clamp01(numOr(get('stroke-opacity'), 1)) * parent.strokeOpacity;
```

and change the `return` at line 283 from `return { paint: p, refs };` to:

```ts
  return { paint: p, refs, groupOpacity };
```

- [ ] **Step 4: Fold at the svgdraw call site**

At `src/svgdraw.ts:1095`, keep behaviour identical for now — Task 3 replaces this:

```ts
  const { paint, refs, groupOpacity } = resolveStyle(parent, n.attrs, e.css.get(n));
  // Temporary: Task 3 replaces this with the group-or-fold decision. Folding
  // unconditionally here is exactly what resolveStyle used to do.
  if (groupOpacity < 1) {
    paint.fillOpacity *= groupOpacity;
    paint.strokeOpacity *= groupOpacity;
  }
```

Mutating `paint` in place is safe: `resolveStyle` builds a fresh object (`{ ...parent }`), so the parent's paint is untouched.

- [ ] **Step 5: Fold at the svgtext call site**

At `src/svgtext.ts`, in the non-root branch from Task 1:

```ts
  // A tspan cannot get its own transparency group: it lives inside the single
  // BT/ET run svgdraw emits for the whole <text>. Folding is what this module
  // has always done and is exact for one span; the <text> element as a whole
  // gets the real group from svgdraw's walk.
  let paint: Paint;
  if (isRoot) {
    paint = parentPaint;
  } else {
    const r = resolveStyle(parentPaint, n.attrs, css);
    paint = r.paint;
    if (r.groupOpacity < 1) {
      paint.fillOpacity *= r.groupOpacity;
      paint.strokeOpacity *= r.groupOpacity;
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/svg-opacity.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite — this refactor must change nothing**

Run: `npm test`

Expected: green, with **no** test needing an update. This step is the whole point of splitting Task 2 out: any failure here is a behaviour change that should not exist yet, so debug rather than update the test.

- [ ] **Step 8: Commit**

```bash
git add src/svgstyle.ts src/svgdraw.ts src/svgtext.ts test/svg-opacity.test.ts
git commit -m "refactor(svg): return group opacity from resolveStyle instead of folding it

Folding opacity into fillOpacity/strokeOpacity made it inherit, so the
group alpha could not be told apart from a child's own alpha. Both call
sites fold it back themselves, so output is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Emit the transparency group

The behaviour change. `walk` decides per element whether to fold or to wrap the subtree in a `/Group /S /Transparency` form under an ExtGState `ca`.

**Files:**
- Modify: `src/svgdraw.ts:12` (imports), `src/svgdraw.ts:1095` (replace Task 2's temporary fold), `src/svgdraw.ts:1119-1129` (the decision, after `here` is known), `src/svgdraw.ts:1273-1281` (the emission)
- Modify: `src/svgdraw.ts` — add `viewportBox` and `needsOpacityGroup` near `groupForm` (around line 509)
- Test: `test/svg-opacity.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveStyle(...) => { paint, refs, groupOpacity }` from Task 2.
- Produces: `viewportBox(e: Emitter, ctm: Matrix): SegBBox | null` and `needsOpacityGroup(n: XmlNode, p: Paint): boolean`, both module-private to `svgdraw.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-opacity.test.ts`:

```ts
import { isName } from '../src/types.js';

/** The Form XObjects the drawing registered, as their stream dicts are not
 *  reachable from here — count the /Fm keys in /XObject instead. */
function formCount(svg: string): number {
  const xo = draw(svg).resources.get('XObject');
  if (!isDict(xo)) return 0;
  return [...xo.keys()].filter((k) => k.startsWith('Fm')).length;
}

describe('group opacity — when a transparency group is emitted', () => {
  it('wraps a <g> and applies the alpha once, not per child', () => {
    const svg = '<svg><g opacity="0.5">' +
      '<rect width="10" height="10" fill="red"/>' +
      '<rect x="5" width="10" height="10" fill="blue"/></g></svg>';
    expect(formCount(svg)).toBe(1);
    expect(alphas(svg)).toEqual([0.5]);
  });

  it('folds for a fill-only shape rather than allocating a form', () => {
    const svg = '<svg><rect width="10" height="10" fill="red" opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(0);
    expect(alphas(svg)).toEqual([0.5]);
  });

  it('folds for a stroke-only shape', () => {
    const svg = '<svg><rect width="10" height="10" fill="none" stroke="red" ' +
      'opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(0);
  });

  it('groups a shape that both fills and strokes', () => {
    const svg = '<svg><rect width="10" height="10" fill="red" stroke="blue" ' +
      'opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(1);
  });

  it('groups a shape carrying markers', () => {
    const svg = '<svg><defs><marker id="m" markerWidth="4" markerHeight="4">' +
      '<rect width="4" height="4" fill="red"/></marker></defs>' +
      '<path d="M0 0 L10 10" stroke="black" marker-end="url(#m)" opacity="0.5"/></svg>';
    expect(formCount(svg)).toBeGreaterThanOrEqual(1);
  });

  it('groups a <text>, whose glyphs can overlap each other', () => {
    expect(formCount('<svg><text x="0" y="10" opacity="0.5">Hi</text></svg>')).toBe(1);
  });

  it('emits no group and no alpha at opacity 1', () => {
    const svg = '<svg><g opacity="1"><rect width="10" height="10"/></g></svg>';
    expect(formCount(svg)).toBe(0);
    expect(alphas(svg)).toEqual([]);
  });

  it('marks the group as a transparency group', () => {
    const svg = '<svg><g opacity="0.5"><rect width="10" height="10"/>' +
      '<rect x="5" width="10" height="10"/></g></svg>';
    // The form's dict is not reachable through /Resources, so assert through
    // the sink: every stream this drawing allocated is captured here.
    const dicts: PdfDict[] = [];
    drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
      { stream: (d: PdfDict) => { dicts.push(d); return ref(dicts.length); } },
      noImages());
    const groups = dicts.filter((d) => {
      const g = d.get('Group');
      if (!isDict(g)) return false;
      const s = g.get('S');
      return isName(s) && s.name === 'Transparency';
    });
    expect(groups.length).toBe(1);
    const sub = groups[0].get('Subtype');
    expect(isName(sub) && sub.name).toBe('Form');
  });

  it('does not throw on a singular transform', () => {
    expect(() => draw('<svg><g opacity="0.5" transform="scale(0)">' +
      '<rect width="10" height="10"/></g></svg>')).not.toThrow();
  });

  it('nests two groups for nested opacity', () => {
    const svg = '<svg><g opacity="0.5"><g opacity="0.5">' +
      '<rect width="10" height="10"/><rect x="5" width="10" height="10"/>' +
      '</g></g></svg>';
    expect(formCount(svg)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-opacity.test.ts`

Expected: the grouping tests FAIL with `formCount` returning `0` where a group is expected. The fold tests and the opacity-1 test PASS already — they are the guard that this task does not over-group.

- [ ] **Step 3: Extend the text.js import**

At `src/svgdraw.ts:12`:

```ts
import { IDENTITY, mul, invert, apply, type Matrix } from './text.js';
```

- [ ] **Step 4: Add the two helpers**

In `src/svgdraw.ts`, immediately after `groupForm` (which ends at line 525):

```ts
/** The viewport rectangle in the element's OWN user space: the viewport corners
 *  mapped back through `ctm`, axis-aligned. This is the /BBox for an opacity
 *  group.
 *
 *  It never crops. svgembed.ts already sets the outer form's /BBox to the
 *  viewport, so ink outside this box is invisible whatever the box says. The
 *  tempting alternative — subtreeBBox inflated by the stroke width — is
 *  fill-geometry-only and can report `complete: false`, and markers, filter
 *  regions and miter joins all paint outside it; every future primitive that
 *  paints past the fill box would become a silent cropping bug, and a crop
 *  inside an opacity group is invisible until someone builds the right fixture.
 *  The cost of the loose box is a larger offscreen buffer at RENDER time, not a
 *  larger file: a /BBox is four numbers.
 *
 *  null when `ctm` is singular — the content has collapsed to no area, so the
 *  caller folds and nothing is visible either way. */
function viewportBox(e: Emitter, ctm: Matrix): SegBBox | null {
  let inv: Matrix;
  try { inv = invert(ctm); } catch { return null; }
  const vb = e.viewport;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const x of [vb.minX, vb.minX + vb.w]) for (const y of [vb.minY, vb.minY + vb.h]) {
    const [px, py] = apply(inv, x, y);
    x0 = Math.min(x0, px); x1 = Math.max(x1, px);
    y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)
      || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether `opacity` on this element must go through a transparency group.
 *
 *  Folding the alpha into the element's own paints is exact whenever it
 *  performs exactly ONE paint operation: with one operation there is nothing
 *  for the reduced alpha to composite against twice. Everything else overlaps
 *  itself somewhere — a container's children with each other, a stroke with its
 *  own fill along the boundary, a marker with the path it sits on, a glyph with
 *  its neighbour and with its own decoration.
 *
 *  Keeping the fold for the single-operation cases is not just cheaper: it is
 *  what stops every ordinary faded shape in every SVG allocating a Form XObject.
 *
 *  The fill-and-stroke test over-approximates on purpose. Answering "both" when
 *  only one channel paints costs a redundant group and looks identical;
 *  answering "one" when both paint is a wrong pixel. Any future paint channel
 *  belongs on the conservative side of that asymmetry. */
function needsOpacityGroup(n: XmlNode, p: Paint): boolean {
  if (n.name === 'image') return false;         // one Do — the fold is exact
  if (n.name === 'text') return true;           // glyphs and decoration overlap
  if (!SHAPES.has(n.name)) return true;         // g / svg / use / symbol
  // Markers apply to these four only (SVG 1.1 §11.6.2); mirroring walk's own
  // rule keeps a faded <rect> from grouping over an inherited marker- property.
  if ((n.name === 'path' || n.name === 'line'
       || n.name === 'polyline' || n.name === 'polygon')
      && (p.markerStart !== null || p.markerMid !== null || p.markerEnd !== null))
    return true;
  // `fill` does not apply to <line> (SVG 1.1 §11.3), which is why walk paints it
  // with fill forced off. Reading the inherited black here would group every
  // faded line for a fill it never draws.
  const fills = n.name !== 'line' && (p.fill !== null || p.fillRef !== null);
  const strokes = (p.stroke !== null || p.strokeRef !== null) && p.strokeWidth > 0;
  return fills && strokes;
}
```

- [ ] **Step 5: Replace Task 2's temporary fold with the decision**

At `src/svgdraw.ts:1095`, drop the temporary fold added in Task 2 and leave only:

```ts
  const { paint, refs, groupOpacity } = resolveStyle(parent, n.attrs, e.css.get(n));
```

Then, immediately after the transform block (after line 1125, `if (hasTf) { ... }`) and **before** `paintInto` is defined:

```ts
  // Decided here, before anything reads `paint`: an element that gets a
  // transparency group must NOT also fold the alpha into its own paints, and
  // one that does not must. This sits after the transform rather than beside
  // resolveStyle because viewportBox needs `here`.
  const opacityBox =
    groupOpacity < 1 && !inDefs && !DEFINITION.has(n.name) && needsOpacityGroup(n, paint)
      ? viewportBox(e, here)
      : null;
  if (opacityBox === null && groupOpacity < 1) {
    paint.fillOpacity *= groupOpacity;
    paint.strokeOpacity *= groupOpacity;
  }
```

- [ ] **Step 6: Wrap the emission**

Replace `src/svgdraw.ts:1273-1281` (the `if (group && spec) { ... } else { painted(e); }` block) with:

```ts
  // The mask wrapper, factored into a callable so the opacity group can contain
  // it. SVG's order is filter -> clip-path -> mask -> opacity, so opacity is
  // outermost of the four and the mask must be inside it.
  // Copied into consts first: `group` and `spec` are `let`, and TypeScript does
  // not carry a narrowing on a mutable binding into a closure.
  const mg = group, ms = spec;
  const masked: (t: Emitter) => void = (mg !== null && ms !== null)
    ? (t: Emitter): void => {
        const body = groupForm(t, ms.region, painted);
        t.out.push('q');
        t.out.push(`/${t.gsKey(1, 1, mg, ms.type)} gs`);
        t.out.push(`/${t.xobjKey(body, 'Fm')} Do`);
        t.out.push('Q');
      }
    : painted;

  if (opacityBox !== null) {
    // Inside the element's own `transform` q/Q rather than outside it, which is
    // equivalent — fading a whole group commutes with an enclosing affine and
    // with an enclosing clip — and it keeps groupForm's contract that /Matrix is
    // identity and the box is in the element's own user space.
    const form = groupForm(e, opacityBox, masked);
    e.out.push('q');
    e.out.push(`/${e.gsKey(groupOpacity, groupOpacity)} gs`);
    e.out.push(`/${e.xobjKey(form, 'Fm')} Do`);
    e.out.push('Q');
  } else {
    masked(e);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/svg-opacity.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`

Expected: `test/svg-opacity.test.ts` green. Other SVG tests **may** fail where a fixture has `opacity` on a container — that is this task's intended behaviour change. For each failure, confirm the new value is the SVG-correct one before updating the test, and note the change in the commit message. Do not touch `test/svg-input-fixtures.test.ts` here; Task 6 handles it.

- [ ] **Step 9: Commit**

```bash
git add src/svgdraw.ts test/svg-opacity.test.ts
git commit -m "feat(svg): composite group opacity through a transparency group

An element whose opacity < 1 and which paints more than once now draws
into a /Group /S /Transparency form under an ExtGState ca, so the subtree
composites as a unit. Folding is kept where the element paints exactly
once, which is exact and avoids a Form XObject per faded shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `<image>` takes group opacity only

`drawImage` pushes `p.fillOpacity`, which carried both `fill-opacity` and group `opacity`. SVG says `fill-opacity` does not apply to an image. After Task 2 the two are separable, so the image takes `groupOpacity` alone — and needs no transparency group, being a single `Do`.

**Files:**
- Modify: `src/svgdraw.ts:830` (`drawImage` signature), `src/svgdraw.ts:849-852` (the alpha push), `src/svgdraw.ts:1173` (the call site)
- Test: `test/svg-opacity.test.ts` (extend)

**Interfaces:**
- Consumes: `groupOpacity` from Task 2, `needsOpacityGroup` from Task 3 (which already returns `false` for `image`).
- Produces: `drawImage(e, n, p, ctm, groupOpacity)` — one added trailing `number` parameter.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-opacity.test.ts`:

```ts
// A 1x1 PNG, so the element has real bytes to embed.
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf' +
  'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('<image> — group opacity only', () => {
  const img = (attrs: string) =>
    `<svg><image width="10" height="10" href="${PX}" ${attrs}/></svg>`;

  it('applies group opacity', () => {
    expect(alphas(img('opacity="0.5"'))).toEqual([0.5]);
  });

  it('ignores fill-opacity, which SVG does not apply to an image', () => {
    expect(alphas(img('fill-opacity="0.5"'))).toEqual([]);
  });

  it('does not multiply the two together', () => {
    expect(alphas(img('opacity="0.5" fill-opacity="0.5"'))).toEqual([0.5]);
  });

  it('needs no transparency group — an image is one paint operation', () => {
    expect(formCount(img('opacity="0.5"'))).toBe(0);
  });

  it('still inherits an ancestor group opacity through the group', () => {
    const svg = `<svg><g opacity="0.5"><image width="10" height="10" ` +
      `href="${PX}"/></g></svg>`;
    expect(alphas(svg)).toEqual([0.5]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-opacity.test.ts`

Expected: FAIL — `ignores fill-opacity` receives `[0.5]` instead of `[]`, and `does not multiply the two together` receives `[0.25]` instead of `[0.5]`.

- [ ] **Step 3: Take the group opacity as a parameter**

At `src/svgdraw.ts:830`:

```ts
function drawImage(
  e: Emitter, n: XmlNode, p: Paint, ctm: Matrix, groupOpacity: number,
): void {
```

- [ ] **Step 4: Push the group opacity, not the fill opacity**

Replace `src/svgdraw.ts:849-852`:

```ts
  // Group `opacity` ONLY. SVG 1.1 §11.3 does not apply fill-opacity to an
  // image, and an image is a single Do, so the fold into `ca` is exact and no
  // transparency group is needed. These two used to be one number, which is why
  // fill-opacity used to darken an image it should not have touched.
  if (groupOpacity < 1) e.out.push(`/${e.gsKey(groupOpacity, 1)} gs`);
```

- [ ] **Step 5: Update the call site**

At `src/svgdraw.ts:1173`:

```ts
      if (!inDefs) drawImage(t, n, paint, here, groupOpacity);
```

`groupOpacity` is in scope — `paintInto` closes over `walk`'s locals. `needsOpacityGroup` already returns `false` for `image`, so `opacityBox` is `null` and the alpha was not folded into `paint` either; there is no double application.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/svg-opacity.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`

Expected: green, except possibly `test/svg-image.test.ts` if it asserted the conflated alpha. If so, the new value is the SVG-correct one — update it and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git add src/svgdraw.ts test/svg-opacity.test.ts
git commit -m "fix(svg): <image> no longer applies fill-opacity

SVG does not apply fill-opacity to an image, but the group-opacity fold
had made the two one number. An image is a single Do, so group opacity
folds into ca exactly and needs no transparency group.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Prove it composites — render tests and the mutation check

The load-bearing task. Everything so far asserts *structure*; this asserts the pixels are right, and then proves the assertion can fail.

**Files:**
- Create: `test/svg-opacity-render.test.ts`

**Interfaces:**
- Consumes: the whole feature from Tasks 1-4. Uses `buildSvgPdf` from `test/helpers/build-svg-fixtures.js` and `decodePng` from `test/helpers/decode-png.js`, exactly as `test/svg-mask-render.test.ts` does.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the test**

Create `test/svg-opacity-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts resolves transparency groups with its own logic, so these
 *  assertions do not round-trip through the code that produced them — the
 *  writer-versus-reader check CLAUDE.md's differential rule asks for. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const near = (png: DecodedPng, x: number, y: number, rgb: [number, number, number]) => {
  const [r, g, b] = png.at(x, y);
  expect(Math.abs(r - rgb[0])).toBeLessThanOrEqual(3);
  expect(Math.abs(g - rgb[1])).toBeLessThanOrEqual(3);
  expect(Math.abs(b - rgb[2])).toBeLessThanOrEqual(3);
};

/** A red bar and a blue bar overlapping between x=80 and x=120, inside a group
 *  at half opacity. Blue is painted second, so INSIDE the group it fully covers
 *  red in the overlap — the group is flat blue there, and fading the group once
 *  must give the same pixel as the blue-only region.
 *
 *  That is an INTERNAL identity (overlap equals blue-only), not a diff against
 *  our own producer, so it cannot cancel out the way CLAUDE.md warns a
 *  differential test can. Folding the alpha into each child instead composites
 *  blue-at-50% over red-at-50% and lands near (128, 64, 191). */
const OVERLAP =
  '<svg viewBox="0 0 200 200"><g opacity="0.5">' +
  '<rect x="0" y="0" width="120" height="200" fill="#ff0000"/>' +
  '<rect x="80" y="0" width="120" height="200" fill="#0000ff"/>' +
  '</g></svg>';

describe('AddSVGObject — group opacity through Save/Open/ToImage', () => {
  it('composites the subtree as a unit, so the overlap is not darkened', () => {
    const { png, skipped } = render(OVERLAP);
    expect(skipped).toEqual([]);
    // Blue over white at 50%.
    near(png, 160, 100, [128, 128, 255]);
    // The overlap must be the SAME pixel, not blue over faded red.
    near(png, 100, 100, [128, 128, 255]);
    // And red-only stays red over white at 50%.
    near(png, 40, 100, [255, 128, 128]);
  });

  it('multiplies nested group opacities', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><g opacity="0.5"><g opacity="0.5">' +
      '<rect x="0" y="0" width="120" height="200" fill="#000000"/>' +
      '<rect x="80" y="0" width="120" height="200" fill="#000000"/>' +
      '</g></g></svg>');
    // Black at 0.25 over white.
    near(png, 100, 100, [191, 191, 191]);
    near(png, 160, 100, [191, 191, 191]);
  });

  it('keeps a fill-only shape identical to the folded result', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200">' +
      '<rect x="0" y="0" width="200" height="200" fill="#ff0000" opacity="0.5"/></svg>');
    near(png, 100, 100, [255, 128, 128]);
  });

  it('does not crop the group at its /BBox under a transform', () => {
    // The group sits inside a translate, so a /BBox computed in the wrong space
    // would cut the bar off. It must still cover the full 200 units.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><g transform="translate(50 0)">' +
      '<g opacity="0.5">' +
      '<rect x="0" y="0" width="100" height="200" fill="#ff0000"/>' +
      '<rect x="50" y="0" width="100" height="200" fill="#ff0000"/>' +
      '</g></g></svg>');
    near(png, 60, 100, [255, 128, 128]);    // near the left edge of the bar
    near(png, 190, 100, [255, 128, 128]);   // near the right edge, past the shift
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/svg-opacity-render.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove the overlap test is load-bearing**

Passing on the first run is not evidence. Temporarily force the old behaviour by making `needsOpacityGroup` in `src/svgdraw.ts` return `false` for containers:

```ts
  if (!SHAPES.has(n.name)) return false;    // TEMPORARY — revert after checking
```

Run: `npx vitest run test/svg-opacity-render.test.ts`

Expected: the first test FAILS at the overlap assertion, receiving roughly `(128, 64, 191)` instead of `(128, 128, 255)`. If it still passes, the test is not exercising what it claims — fix the test before continuing.

- [ ] **Step 4: Prove the BBox test is load-bearing**

Revert Step 3. Now make `viewportBox` ignore the CTM, returning the raw viewport rect:

```ts
  return { x: vb.minX, y: vb.minY, w: vb.w, h: vb.h };   // TEMPORARY
```

Run: `npx vitest run test/svg-opacity-render.test.ts`

Expected: `does not crop the group at its /BBox under a transform` FAILS — the pixel at x=190 is white, because the box stopped 50 units short. If it passes, the fixture's transform is not large enough to expose the crop; increase the translate until it does.

- [ ] **Step 5: Revert both mutations and confirm green**

Run: `git diff src/svgdraw.ts` — expect **no** diff from the Task 4 commit.
Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add test/svg-opacity-render.test.ts
git commit -m "test(svg): pixel assertions for group opacity compositing

The overlap of two shapes inside a faded group must equal the top
shape's own pixel — an internal identity rather than a diff against our
own producer. Both assertions were verified load-bearing by reverting
the grouping and the CTM-aware /BBox in turn.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Fixture churn, docs, and close the issue

**Files:**
- Check: `test/svg-input-fixtures.test.ts`, `test/fixtures/svg-input/PROVENANCE.md`
- Modify: `README.md` (the SVG embedding bullet, around line 19)

**Interfaces:**
- Consumes: the finished feature. Produces nothing.

- [ ] **Step 1: Check the third-party fixtures for `opacity`**

Run:

```bash
grep -rn "opacity" test/fixtures/svg-input/ | head -20
npx vitest run test/svg-input-fixtures.test.ts
```

Expected: green. If it fails, do **not** regenerate the golden. Read the diff, confirm the new output is the SVG-correct one, and record what changed and why in the commit message and in `test/fixtures/svg-input/PROVENANCE.md`. If the new output is *not* obviously correct, stop and report rather than accepting it.

- [ ] **Step 2: Update the README's group-opacity sentence**

In `README.md`, in the SVG embedding bullet, replace:

> Group `opacity` is folded into child alphas, which is exact unless the children overlap.

with:

> Group **`opacity`** composites the subtree as a unit through a PDF transparency group, so overlapping children no longer darken where they cross. Where the element paints exactly once — a shape with only a fill or only a stroke, or an `<image>` — the alpha folds into the graphics state instead, which is exact and avoids a Form XObject per faded shape.

- [ ] **Step 3: Update the README's `<image>` sentence**

In the same bullet, replace:

> `fill-opacity` is folded into the image's constant alpha along with group `opacity` — SVG applies only the latter to an image, and PDF cannot separate them short of a transparency group.

with:

> `fill-opacity` is correctly ignored for an `<image>`, which SVG does not apply it to; only group `opacity` reaches the image's constant alpha.

- [ ] **Step 4: Verify the whole suite one more time**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green.

- [ ] **Step 5: Commit the docs**

```bash
git add README.md
git commit -m "docs: SVG group opacity is now a transparency group

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Record the invariant and close the issue**

```bash
bd remember --key svg-group-opacity-shipped "1gg0.12 shipped. resolveStyle returns groupOpacity SEPARATELY and no longer folds it into fillOpacity/strokeOpacity — folding made it inherit, so the group alpha could not be told apart from a child's own. svgdraw's walk decides: needsOpacityGroup(n,p) is true for containers, <text>, markered paths and fill+stroke shapes, false for <image> and single-channel shapes (the fold is exact with one paint op, and keeps a Form XObject off every faded shape). The /BBox is viewportBox(e,here) — the viewport inverse-mapped into element user space — NOT subtreeBBox, which is fill-geometry-only and would silently crop markers and filter regions. The group wraps the mask wrapper, inside the element's transform q/Q (equivalent, and keeps groupForm's identity-/Matrix contract). Renderers needed no change: pagerender's needsBuffer already fires on ca<1 over /Group /S /Transparency. Also fixed in passing: walkText re-resolved the ROOT <text> node's own attrs on top of walk's already-resolved paint, squaring fill-opacity and opacity — flattenText now passes isRoot."

bd close aspose-pdf-foss-for-ts-1gg0.12
```

- [ ] **Step 7: Push**

```bash
git pull --rebase
git push
git status        # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Unfold group opacity in the cascade | Task 2 |
| 2. Group vs. fold: the one-paint-operation rule | Task 3 (`needsOpacityGroup`) |
| 3. `<image>`: the second half of the fix | Task 4 |
| 4. Placement and `/BBox` | Task 3 (`viewportBox`, the emission block) |
| 5. Renderers — no change | verified in Task 5's pixel tests |
| 6. Module boundaries — no new module | Tasks 2-4 all edit existing files |
| Testing: structure | Tasks 1-4, `test/svg-opacity.test.ts` |
| Testing: the load-bearing assertion | Task 5 |
| Testing: proving tests load-bearing | Task 5, Steps 3-4 |
| Fixture churn | Task 6, Step 1 |
| Docs | Task 6, Steps 2-3 |

Plus one item the spec did not have, added after it was written and approved: the `<text>` double-resolve bug (Task 1), found by probing the current tree while writing this plan.

**Type consistency:** `resolveStyle` returns `{ paint, refs, groupOpacity }` in Task 2 and is destructured that way in Tasks 3 and 4. `needsOpacityGroup(n: XmlNode, p: Paint): boolean` and `viewportBox(e: Emitter, ctm: Matrix): SegBBox | null` are defined in Task 3 and used only there. `drawImage` gains its fifth parameter and its only call site is updated in the same task. `walkText`'s `isRoot` is added in Task 1 and read in Task 2.
