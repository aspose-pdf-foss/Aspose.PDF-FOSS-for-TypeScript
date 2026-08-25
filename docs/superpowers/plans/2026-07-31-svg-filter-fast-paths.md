# SVG `<filter>` Vector Fast Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rasterizing the four `<filter>` chain shapes that PDF can express exactly, so their text stays extractable and their vectors stay resolution-independent.

**Architecture:** A pure `classify(spec: FilterSpec): FastPath | null` in `src/svgfilter.ts` matches the resolved primitive graph against a narrow table and returns a three-case discriminated union. `emitFastFilter` in `src/svgdraw.ts` turns each case into operators using machinery that already exists — `groupForm` for the region clip, `gsKey` for constant alpha and the `/S /Alpha` soft mask. `walk` tries `classify` first and falls through to the existing `emitFiltered` raster path on `null`. Nothing else changes.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-31-svg-filter-fast-paths-design.md`

**Issue:** `aspose-pdf-foss-for-ts-1gg0.10.5`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`./svgfilter.js`), even from a `.ts` file.
- **`src/svgfilter.ts` stays pure.** No pixels, no `Document`, no allocation. It resolves geometry and returns descriptors. `classify` belongs there for exactly that reason; anything that emits operators belongs in `src/svgdraw.ts`.
- **`src/svgdraw.ts` allocates nothing directly.** It reaches PDF objects only through the `SvgStreamSink` / `SvgImageSink` / `SvgRasterSink` seams.
- **Both gates must be green before an issue closes:** `npm run typecheck` and `npm test`.
- **Target a single file while iterating:** `npx vitest run test/<name>.test.ts`.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/svgfilter.ts` | Pure filter resolution: region, subregions, input wiring — and now fast-path classification | Add `FastPath`, `classify`, and the private `floodPaint`. Grows ~70 lines from 259. |
| `src/svgdraw.ts` | SVG → operators | Add `emitFastFilter` and the private `rectClip` beside `emitFiltered`; `walk` tries `classify` first. ~55 lines. |
| `test/svg-filter-fast.test.ts` | The whole phase: `classify` units, emission through `drawSvg`, equivalence through `AddSVGObject` + `ToImage` | Create |
| `test/svg-filter-render.test.ts` | Existing end-to-end raster-path coverage | Repoint the raster-specific tests at a padded chain so they keep testing the raster path (Task 1) |
| `README.md` | User-facing feature list | The "a filtered subtree is **rasterized**" claim becomes false (Task 7) |

No new source file: `svgfilter.ts` at ~330 lines stays well inside the range of its neighbours (`svgmarker.ts` 239, `svgpath.ts` 536).

## Background an implementer needs

Read `docs/superpowers/specs/2026-07-31-svg-filter-fast-paths-design.md` first. Beyond it, four facts about this codebase that the code below depends on and that are not obvious:

1. **`resolveFilter` has already normalised the graph.** By the time a `FilterPrim` exists, a missing `in` has been defaulted to `SourceGraphic` (first primitive) or to the previous primitive's `result` (later ones), an unnamed `result` has been given the collision-proof key `#0`/`#1`/…, and every `sub` has been intersected with the filter region by `clipTo`. `classify` matches on that resolved form, which is why the natural spellings need no special case.
2. **`feMergeNode` is not a primitive.** Its `in` is *not* resolved by `resolveFilter` and it joins no implicit chain — a missing `in` on an `feMergeNode` means `SourceGraphic`, never the previous result (`svgfilterfx.ts:807`). So the `feMerge` branch must read the child's own attribute, not `p[0].in1`.
3. **SVG content here is emitted y-DOWN.** The flip to PDF's y-up happens once, in `placementMatrix` (`svgtransform.ts`). Everything in `svgdraw.ts` — including every rectangle and every `cm` below — is in raw viewBox units with y growing downward. Do not compensate.
4. **A form's `/BBox` clips in the form's own coordinate space,** before any `cm` outside the `Do` is applied. That is the whole trick in the `offset` emission and the reason it needs no rectangle arithmetic.

---

### Task 1: Keep the existing raster coverage on the raster path

`test/svg-filter-render.test.ts` builds most of its end-to-end assertions on `SHIFT`, a **lone `feOffset`** — which is the very first chain Task 2 diverts to a fast path. Three of those tests assert raster-specific behaviour (`rasterized: ['filter']`, an image XObject with an `/SMask`, a raster that scales with `filterScale`) and would go red for the right reason, which is the worst kind of red: it looks like the feature broke something.

Repoint them now, while the suite is still green either way, so Task 2's diff contains only the feature.

**Files:**
- Modify: `test/svg-filter-render.test.ts:114-190`

**Interfaces:**
- Consumes: nothing.
- Produces: `SHIFT_RASTER`, a module-level `const` in that test file — a chain that is semantically identical to `SHIFT` but takes the raster path. Later tasks do not import it; they build their own padding.

- [ ] **Step 1: Add the padded fixture next to `SHIFT`**

In `test/svg-filter-render.test.ts`, immediately after the existing `SHIFT` declaration (around line 118), add:

```ts
/** SHIFT, padded with a no-op second primitive so it does NOT take a vector
 *  fast path (1gg0.10.5). Two primitives is enough — `classify` matches only a
 *  lone one — and an feOffset of (0, 0) is an exact identity: offsetKernel
 *  rounds its delta to whole pixels, and 0 rounds to 0. These tests are about
 *  the raster path, so they have to keep taking it. */
const SHIFT_RASTER = SHIFT.replace(
  '<feOffset dx="50" dy="50"/>',
  '<feOffset dx="50" dy="50"/><feOffset dx="0" dy="0"/>');
```

- [ ] **Step 2: Repoint the four raster-specific tests**

Change `render(SHIFT)` to `render(SHIFT_RASTER)` in exactly these tests, and in no others:

- `'draws the filtered result, not the source'` — asserts `rasterized: ['filter']`
- `'emits the result as an image with an /SMask, not as vector ink'`
- `'scales the raster with filterScale'` — both the `small` and the `big` call
- `'applies a clip-path to the FILTERED result, not to the source'` — this one has its filter written inline rather than via `SHIFT`; add the same `<feOffset dx="0" dy="0"/>` directly after its `<feOffset dx="50" dy="50"/>`, so it keeps proving the clip/filter ordering through the raster path

Leave these alone — they do not reach a fast path and must keep using `SHIFT`:

- `'rejects a bad filterScale before allocating anything'` — the `TypeError` is thrown before the walk
- `'draws unfiltered and reports an unsupported primitive'` — replaces the `feOffset` with `feNonesuch`
- `'renders nothing, and reports nothing, for a zero-area filter region'` — resolves to `kind: 'empty'` before classification

- [ ] **Step 3: Run the file and confirm it is still green**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: PASS, same test count as before. Nothing about behaviour changed — a padded chain rasterizes today exactly as the unpadded one does. A failure here means the padding is not the no-op it claims to be; stop and work that out before continuing.

- [ ] **Step 4: Commit**

```bash
git add test/svg-filter-render.test.ts
git commit -m "test(svg): pin the raster filter tests to a chain that stays raster

A lone feOffset is about to take a vector fast path (1gg0.10.5). Pad the
fixture behind the raster-specific assertions with a no-op second
primitive now, while the suite is green either way, so the feature commit
does not read as a regression.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The `offset` fast path

Lone `feOffset` from `SourceGraphic`, and the one-node `feMerge` that is the same thing spelled differently. Both become `{ kind: 'offset' }`; an identity chain is `dx = dy = 0` rather than its own union case, so there is no fourth branch for a consumer to forget.

**Files:**
- Modify: `src/svgfilter.ts` (add after `primLength`, before `resolveFilter`)
- Modify: `src/svgdraw.ts` (add after `emitFiltered`, ~line 1014; wire in `walk`, ~line 1153)
- Test: `test/svg-filter-fast.test.ts` (create)

**Interfaces:**
- Consumes: `FilterSpec`, `FilterPrim`, `primLength` from `src/svgfilter.ts`; `groupForm(e: Emitter, box: SegBBox, body: (sub: Emitter) => void): PdfObject`, `Emitter.xobjKey(r: PdfObject, prefix?: 'Im' | 'Fm'): string`, and `num(n: number): string` from `src/pagecontent.js` — all already in `src/svgdraw.ts`.
- Produces:
  - `export type FastPath = { kind: 'offset'; dx: number; dy: number; clip: SegBBox }` (Tasks 3 and 4 add members to this union)
  - `export function classify(spec: FilterSpec): FastPath | null`
  - `function emitFastFilter(e: Emitter, fast: FastPath, region: SegBBox, body: (sub: Emitter) => void): void` — module-private to `svgdraw.ts`. Returns `void`, not `boolean`: unlike `emitFiltered` it cannot fail, because `classify` only returns chains it can draw and none of them need the rasterizer.
  - `const rectClip = (b: SegBBox): string` — module-private to `svgdraw.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/svg-filter-fast.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { classify, resolveFilter, type FilterSpec } from '../src/svgfilter.js';
import { drawSvg } from '../src/svgdraw.js';
import { isDict, type PdfDict, type PdfObject } from '../src/types.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** The element carrying `id`, from a document fragment. */
function nodeOf(src: string, id = 'f'): XmlNode {
  const root = parseXml(xml(src));
  let found: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found!;
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

/** resolveFilter, asserting it resolved to a runnable spec. */
function spec(src: string, bbox = BOX): FilterSpec {
  const r = resolveFilter(nodeOf(src), bbox, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

/** A <filter> wrapping `prims`, pinned to user space so the region is exactly
 *  0,0 200x100 and every subregion assertion below reads directly. */
const filt = (prims: string, attrs = '') =>
  `<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ` +
  `width="200" height="100" ${attrs}>${prims}</filter></svg>`;

describe('classify — offset', () => {
  it('matches a lone feOffset from SourceGraphic', () => {
    const f = classify(spec(filt('<feOffset dx="5" dy="-7"/>')));
    expect(f).toEqual({ kind: 'offset', dx: 5, dy: -7,
                        clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('defaults a missing dx/dy to zero, which is the identity chain', () => {
    expect(classify(spec(filt('<feOffset/>'))))
      .toEqual({ kind: 'offset', dx: 0, dy: 0, clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('refuses an feOffset on SourceAlpha', () => {
    // The alpha channel painted black is not the source graphic, and PDF has
    // no operator that produces it.
    expect(classify(spec(filt('<feOffset in="SourceAlpha" dx="5"/>')))).toBeNull();
  });

  it('refuses a chain of two primitives', () => {
    expect(classify(spec(filt('<feOffset dx="5"/><feOffset dx="0"/>')))).toBeNull();
  });

  it('carries the subregion as the clip, already cut to the filter region', () => {
    const f = classify(spec(filt('<feOffset dx="5" x="20" y="10" width="500" height="30"/>')));
    // width 500 from x=20 runs past the region's right edge at 200, and
    // resolveFilter has already intersected it.
    expect(f).toEqual({ kind: 'offset', dx: 5, dy: 0,
                       clip: { x: 20, y: 10, w: 180, h: 30 } });
  });

  it('scales dx and dy by the right bbox side under primitiveUnits', () => {
    // objectBoundingBox: dx is a fraction of the box WIDTH (40), dy of its
    // HEIGHT (80). A square box could not tell the two apart.
    const f = classify(spec(
      filt('<feOffset dx="0.5" dy="0.5"/>', 'primitiveUnits="objectBoundingBox"')));
    expect(f).toMatchObject({ kind: 'offset', dx: 20, dy: 40 });
  });

  it('matches a one-node feMerge as the identity', () => {
    expect(classify(spec(filt('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'))))
      .toEqual({ kind: 'offset', dx: 0, dy: 0, clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('matches a one-node feMerge whose node names no input', () => {
    // An feMergeNode is not a primitive and joins no implicit chain, so a
    // missing `in` means SourceGraphic — reading the PRIMITIVE's resolved in1
    // would get this right by accident here and wrong in a longer chain.
    expect(classify(spec(filt('<feMerge><feMergeNode/></feMerge>'))))
      .toMatchObject({ kind: 'offset', dx: 0, dy: 0 });
  });

  it('refuses a two-node feMerge', () => {
    expect(classify(spec(filt(
      '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="SourceGraphic"/></feMerge>'))))
      .toBeNull();
  });

  it('refuses a one-node feMerge on SourceAlpha', () => {
    expect(classify(spec(filt('<feMerge><feMergeNode in="SourceAlpha"/></feMerge>'))))
      .toBeNull();
  });
});

/** A stream sink that records what it was asked to allocate and hands back a
 *  ref, standing in for svgembed.ts. */
function recordingSink() {
  const streams: { dict: PdfDict; content: string }[] = [];
  return {
    streams,
    sink: {
      stream: (dict: PdfDict, content: string): PdfObject => {
        streams.push({ dict, content });
        return { kind: 'ref' as const, num: streams.length, gen: 0 };
      },
    },
    images: { image: (): PdfObject => ({ kind: 'ref' as const, num: 999, gen: 0 }) },
  };
}

/** A font provider with no faces — none of these fixtures draw text. */
const noFonts = {
  dict: () => new Map<string, PdfObject>(),
  face: () => { throw new Error('no font expected'); },
};

function draw(src: string) {
  const rec = recordingSink();
  const r = drawSvg(parseXml(xml(src)), { minX: 0, minY: 0, w: 100, h: 100 },
    noFonts as never, rec.sink, rec.images as never);
  return { ...r, streams: rec.streams };
}

/** A red square filtered by `prims`, over a 100x100 user-space region. */
const doc = (prims: string) =>
  '<svg viewBox="0 0 100 100"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
  prims + '</filter></defs>' +
  '<rect x="0" y="0" width="40" height="40" fill="#ff0000" filter="url(#f)"/></svg>';

describe('drawSvg — offset fast path', () => {
  it('emits the subtree through a form and a translate, not an image', () => {
    const { content, rasterized, skipped } = draw(doc('<feOffset dx="30" dy="20"/>'));
    expect(content).toContain('1 0 0 1 30 20 cm');
    expect(content).toMatch(/\/Fm\d+ Do/);
    // No rasterizer was involved, so nothing was flattened and nothing lost.
    expect(rasterized).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('clips the source to the filter region inside the form, before the shift', () => {
    // The form BBox is the region, and it applies in the form's OWN space. If
    // the region clip were applied after the translate instead, ink the region
    // had already removed could be dragged back in.
    const { streams } = draw(doc('<feOffset dx="30" dy="20"/>'));
    const form = streams.find((s) => {
      const b = s.dict.get('BBox');
      return Array.isArray(b) && b[2] === 100 && b[3] === 100;
    });
    expect(form).toBeDefined();
    // The source rect is in there (svgdraw emits a <rect> as m/l subpaths, not
    // as `re`, so match on its fill colour), and the shift is NOT.
    expect(form!.content).toContain('1 0 0 rg');
    expect(form!.content).not.toContain('1 0 0 1 30 20 cm');
  });

  it('clips the result to a narrow subregion', () => {
    const { content } = draw(doc('<feOffset dx="30" dy="20" x="10" y="5" width="20" height="15"/>'));
    expect(content).toContain('10 5 20 15 re');
    expect(content).toContain('W n');
  });

  it('omits the translate for an identity chain', () => {
    const { content } = draw(doc('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'));
    expect(content).toMatch(/\/Fm\d+ Do/);
    expect(content).not.toContain(' cm');
  });

  it('still rasterizes a chain that does not classify', () => {
    // No raster sink is wired here, so the raster path cannot run and degrades
    // to unfiltered — which is the pre-existing behaviour this must not change.
    const { rasterized, skipped } = draw(doc('<feGaussianBlur stdDeviation="2"/>'));
    expect(rasterized).toEqual([]);
    expect(skipped).toEqual(['filter']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-filter-fast.test.ts`
Expected: FAIL — `classify` is not exported from `../src/svgfilter.js`, so the whole file fails to load with a TypeScript/import error.

- [ ] **Step 3: Add `FastPath` and `classify` to `src/svgfilter.ts`**

Insert after `primLength` (which ends at line 161) and before `resolveFilter`:

```ts
/** A chain PDF can express EXACTLY, so it never reaches the rasterizer.
 *
 *  Deliberately narrow. Each member is a second implementation of a primitive
 *  the raster path already runs, and every one has to be provably equal to it —
 *  the raster path is the reference, which is why it shipped first (1gg0.10.3).
 *
 *  An identity chain is `offset` with dx = dy = 0 rather than a case of its
 *  own, so there is no extra branch for a consumer to forget. Same reasoning as
 *  FilterResolution above, applied in the other direction. */
export type FastPath =
  | { kind: 'offset'; dx: number; dy: number; clip: SegBBox };

/** Match a resolved graph against the fast-path table; null means rasterize.
 *
 *  Matching is on the RESOLVED prims, never on the source attributes.
 *  resolveFilter has already defaulted a missing `in` to SourceGraphic or to
 *  the previous result, and has already intersected every subregion with the
 *  filter region, so the spellings authors actually write need no special case
 *  here. */
export function classify(spec: FilterSpec): FastPath | null {
  const p = spec.prims;

  if (p.length === 1 && p[0].name === 'feOffset' && p[0].in1 === 'SourceGraphic')
    return {
      kind: 'offset',
      dx: primLength(spec, p[0].attrs.get('dx'), 0, 'x'),
      dy: primLength(spec, p[0].attrs.get('dy'), 0, 'y'),
      clip: p[0].sub,
    };

  // A one-node feMerge is a pass-through. An feMergeNode is NOT a primitive and
  // joins no implicit chain, so its missing `in` means SourceGraphic rather
  // than the previous result -- which is why this reads the child's own
  // attribute and not p[0].in1.
  if (p.length === 1 && p[0].name === 'feMerge') {
    const nodes = p[0].node.children.filter((c) => c.name === 'feMergeNode');
    if (nodes.length === 1
        && (nodes[0].attrs.get('in') ?? 'SourceGraphic') === 'SourceGraphic')
      return { kind: 'offset', dx: 0, dy: 0, clip: p[0].sub };
  }

  return null;
}
```

- [ ] **Step 4: Add `rectClip` and `emitFastFilter` to `src/svgdraw.ts`**

First extend the existing import at line 36:

```ts
import {
  classify, resolveFilter, type FastPath, type FilterPrim, type FilterSpec,
} from './svgfilter.js';
```

Then insert after `emitFiltered` ends (line 1014), before `function walk`:

```ts
/** A subregion as a clip. y-down, like everything else this module emits. */
const rectClip = (b: SegBBox): string =>
  `${num(b.x)} ${num(b.y)} ${num(b.w)} ${num(b.h)} re W n`;

/** Emit a chain PDF can express exactly, instead of rasterizing it (1gg0.10.5).
 *
 *  Paints where `emitFiltered` would have, inside the element's own transform
 *  and inside any clip/mask wrapper, so SVG's filter -> clip-path -> mask ->
 *  opacity order is unchanged.
 *
 *  Returns void, not boolean: unlike emitFiltered this cannot fail. classify
 *  only hands back chains this can draw, and none of them touch the rasterizer
 *  -- which is why these filters now render even where no raster sink is wired. */
function emitFastFilter(
  e: Emitter, fast: FastPath, region: SegBBox, body: (sub: Emitter) => void,
): void {
  switch (fast.kind) {
    case 'offset': {
      // The form's /BBox is the region clip, and a /BBox applies in the form's
      // OWN space -- so SourceGraphic is cut to the region BEFORE the cm shifts
      // it, which is SVG's order (15.7.5). Translating the region rectangle
      // instead would let a large offset drag back in ink the region had
      // already removed.
      const form = groupForm(e, region, body);
      e.out.push('q');
      e.out.push(rectClip(fast.clip));
      if (fast.dx !== 0 || fast.dy !== 0)
        e.out.push(`1 0 0 1 ${num(fast.dx)} ${num(fast.dy)} cm`);
      e.out.push(`/${e.xobjKey(form, 'Fm')} Do`);
      e.out.push('Q');
      return;
    }
  }
}
```

- [ ] **Step 5: Wire it into `walk`**

In `src/svgdraw.ts`, replace the `else` branch at lines 1153-1163 (the one that currently builds `painted` around `emitFiltered`) with:

```ts
      } else {
        const inner = paintInto;
        const fast = classify(r.spec);
        if (fast !== null) {
          const region = r.spec.region;
          // No activeFilters guard: that exists to stop an feImage element
          // reference recursing into its own filter, and no fast-path chain
          // contains an feImage. Setting it here would refuse the perfectly
          // legal case of a child carrying the same filter as its parent.
          painted = (t: Emitter): void => { emitFastFilter(t, fast, region, inner); };
        } else {
          const scale = e.filterPx * ctmScale(here);
          painted = (t: Emitter): void => {
            if (fid !== undefined) t.activeFilters.add(fid);
            const ok = emitFiltered(t, r.spec, scale, inner);
            if (fid !== undefined) t.activeFilters.delete(fid);
            if (ok) t.rasterized.add('filter');
            else { t.skipped.add('filter'); inner(t); }
          };
        }
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-fast.test.ts`
Expected: PASS, all 15 tests.

- [ ] **Step 7: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green. `test/svg-filter-render.test.ts` in particular must still pass — Task 1 moved its raster assertions onto a padded chain.

- [ ] **Step 8: Commit**

```bash
git add src/svgfilter.ts src/svgdraw.ts test/svg-filter-fast.test.ts
git commit -m "feat(svg): vector fast path for a lone feOffset

classify() in svgfilter.ts matches a resolved primitive graph against the
chains PDF can express exactly; emitFastFilter in svgdraw.ts draws them.
First member: a lone feOffset from SourceGraphic, and the one-node feMerge
that is the same thing spelled differently, both as { kind: 'offset' }.

The subtree goes into a form whose /BBox is the filter region, and a /BBox
clips in the form's own space -- so the source is cut to the region before
the cm shifts it, which is SVG 15.7.5's order without any rectangle
arithmetic.

These no longer report 'filter' in rasterized, and no longer need a raster
sink at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The `flood` fast path

A lone `feFlood` is a solid rectangle: `flood-color × flood-opacity` over its subregion. The colour round-trips linearRGB unchanged because it is constant, so the emitted `rg` is exact regardless of `color-interpolation-filters`.

**Files:**
- Modify: `src/svgfilter.ts` (extend `FastPath` and `classify`; add `floodPaint`)
- Modify: `src/svgdraw.ts` (add the `flood` case to `emitFastFilter`)
- Test: `test/svg-filter-fast.test.ts`

**Interfaces:**
- Consumes: `FastPath`, `classify`, `clipTo`, `emitFastFilter`, `rectClip` from Task 2; `parseColor(s: string): Rgb | null | undefined` and `type Rgb = [number, number, number]` from `src/svgstyle.js`; `Emitter.gsKey(ca: number, CA: number, smask?: PdfObject, smaskType?: 'Luminosity' | 'Alpha'): string`.
- Produces:
  - `FastPath` gains `| { kind: 'flood'; color: Rgb; opacity: number; clip: SegBBox }`
  - `function floodPaint(p: FilterPrim): { color: Rgb; opacity: number } | null` — module-private to `svgfilter.ts`; Task 4 reuses it

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-filter-fast.test.ts`:

```ts
describe('classify — flood', () => {
  it('matches a lone feFlood', () => {
    expect(classify(spec(filt('<feFlood flood-color="#ff0000"/>'))))
      .toEqual({ kind: 'flood', color: [1, 0, 0], opacity: 1,
                 clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('defaults flood-color to black and flood-opacity to 1', () => {
    expect(classify(spec(filt('<feFlood/>'))))
      .toMatchObject({ kind: 'flood', color: [0, 0, 0], opacity: 1 });
  });

  it('carries flood-opacity, clamped', () => {
    expect(classify(spec(filt('<feFlood flood-opacity="0.25"/>'))))
      .toMatchObject({ opacity: 0.25 });
    expect(classify(spec(filt('<feFlood flood-opacity="3"/>'))))
      .toMatchObject({ opacity: 1 });
  });

  it('clips to the subregion', () => {
    expect(classify(spec(filt('<feFlood x="10" y="20" width="30" height="40"/>'))))
      .toMatchObject({ clip: { x: 10, y: 20, w: 30, h: 40 } });
  });

  it('rasterizes a flood that paints nothing', () => {
    // flood-color="none" and an unparseable value both flood nothing. Rather
    // than grow a fourth emission that draws nothing, hand these to the raster
    // path, which already produces the same empty result. Divergence here is
    // exactly the kind nobody writes a test for.
    expect(classify(spec(filt('<feFlood flood-color="none"/>')))).toBeNull();
    expect(classify(spec(filt('<feFlood flood-color="url(#g)"/>')))).toBeNull();
  });
});

describe('drawSvg — flood fast path', () => {
  it('emits a solid fill over the subregion, with no form and no image', () => {
    const { content, rasterized } = draw(doc('<feFlood flood-color="#0000ff"/>'));
    expect(content).toContain('0 0 1 rg');
    expect(content).toContain('0 0 100 100 re');
    expect(content).not.toMatch(/\/Fm\d+ Do/);
    expect(rasterized).toEqual([]);
  });

  it('folds flood-opacity into the constant alpha', () => {
    const { content, resources } = draw(doc('<feFlood flood-color="#0000ff" flood-opacity="0.5"/>'));
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    expect(gs.get('ca')).toBe(0.5);
  });

  it('emits no /ExtGState for an opaque flood', () => {
    const { content } = draw(doc('<feFlood flood-color="#0000ff"/>'));
    expect(content).not.toContain(' gs');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-filter-fast.test.ts -t flood`
Expected: FAIL — `classify` returns `null` for every `feFlood`, so the `toEqual`/`toMatchObject` assertions fail with `null`.

- [ ] **Step 3: Extend `src/svgfilter.ts`**

Add `parseColor` and `Rgb` to the existing `svgstyle.js` import at line 8:

```ts
import { parseColor, styleGetter, type Rgb } from './svgstyle.js';
```

Add the union member to `FastPath`:

```ts
export type FastPath =
  | { kind: 'offset'; dx: number; dy: number; clip: SegBBox }
  | { kind: 'flood'; color: Rgb; opacity: number; clip: SegBBox };
```

Add `floodPaint` immediately above `classify`:

```ts
/** flood-color x flood-opacity, or null when the flood paints nothing.
 *
 *  Mirrors floodKernel in svgfilterfx.ts exactly, including its treatment of
 *  'none' and of a value that will not parse. The two paths have to agree on
 *  precisely the inputs nobody writes a test for, so a flood that paints
 *  nothing returns null and rasterizes -- where the raster path already
 *  produces the same empty result -- rather than growing an emission whose only
 *  job is to draw nothing. */
function floodPaint(p: FilterPrim): { color: Rgb; opacity: number } | null {
  const c = parseColor(p.attrs.get('flood-color') ?? 'black');
  if (c === null || c === undefined) return null;
  const o = parseFloat(p.attrs.get('flood-opacity') ?? '1');
  const a = Number.isFinite(o) ? Math.min(1, Math.max(0, o)) : 1;
  return { color: c, opacity: a };
}
```

Add this branch to `classify`, after the `feMerge` branch and before `return null`:

```ts
  if (p.length === 1 && p[0].name === 'feFlood') {
    const f = floodPaint(p[0]);
    if (f !== null)
      return { kind: 'flood', color: f.color, opacity: f.opacity, clip: p[0].sub };
  }
```

- [ ] **Step 4: Add the `flood` case to `emitFastFilter` in `src/svgdraw.ts`**

Insert inside the `switch`, after the `offset` case:

```ts
    case 'flood': {
      e.out.push('q');
      if (fast.opacity < 1) e.out.push(`/${e.gsKey(fast.opacity, 1)} gs`);
      e.out.push(`${fast.color.map(num).join(' ')} rg`);
      // The fill rectangle IS the clip. A flood paints its whole subregion and
      // nothing outside it, so a `re W n` would be the same rectangle twice.
      e.out.push(
        `${num(fast.clip.x)} ${num(fast.clip.y)} ${num(fast.clip.w)} ${num(fast.clip.h)} re`);
      e.out.push('f');
      e.out.push('Q');
      return;
    }
```

Note the switch has no `default`. TypeScript's exhaustiveness check on the union is what forces the next task to handle its new member; do not add one.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-fast.test.ts`
Expected: PASS, all 23 tests.

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/svgfilter.ts src/svgdraw.ts test/svg-filter-fast.test.ts
git commit -m "feat(svg): vector fast path for a lone feFlood

A solid rectangle over the subregion. Exact in either colour space: a
constant colour round-trips linearRGB, so the emitted rg needs no
conversion. flood-opacity folds into /ca.

floodPaint mirrors floodKernel including its 'none' and unparseable cases,
which return null and rasterize rather than growing an emission whose only
job is to draw nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The `tint` fast path

`feFlood` then `feComposite operator="in"` against the source's alpha — the recolour-an-icon recipe, and the one chain in this set that real documents actually contain. `operator="in"` reads only `in2`'s alpha, so this is a constant colour behind an alpha mask: exactly a PDF `/S /Alpha` soft mask.

**Files:**
- Modify: `src/svgfilter.ts` (extend `FastPath` and `classify`)
- Modify: `src/svgdraw.ts` (add the `tint` case to `emitFastFilter`)
- Test: `test/svg-filter-fast.test.ts`

**Interfaces:**
- Consumes: `floodPaint` and `clipTo` (both already private in `svgfilter.ts`), `groupForm`, `Emitter.gsKey`.
- Produces: `FastPath` gains `| { kind: 'tint'; color: Rgb; opacity: number; clip: SegBBox }`. This completes the union; no later task extends it.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-filter-fast.test.ts`:

```ts
/** The icon-recolour recipe, over the standard 200x100 region. */
const TINT = '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha" operator="in"/>';

describe('classify — tint', () => {
  it('matches feFlood then feComposite operator="in" on SourceAlpha', () => {
    expect(classify(spec(filt(TINT))))
      .toEqual({ kind: 'tint', color: [0, 1, 0], opacity: 1,
                 clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('matches the SourceGraphic spelling too', () => {
    // operator="in" reads in2's ALPHA and nothing else, so SourceGraphic and
    // SourceAlpha are the same input here.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceGraphic" operator="in"/>'))))
      .toMatchObject({ kind: 'tint', color: [0, 1, 0] });
  });

  it('matches when the composite names its first input explicitly', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" result="c"/>' +
      '<feComposite in="c" in2="SourceAlpha" operator="in"/>'))))
      .toMatchObject({ kind: 'tint' });
  });

  it('refuses a different operator', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha" operator="over"/>'))))
      .toBeNull();
    // operator is required: its default is "over", which is not this recipe.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha"/>')))).toBeNull();
  });

  it('refuses the inputs the other way round', () => {
    // flood as in2 gives the source's alpha coloured black, masked by the
    // flood's alpha -- a different picture entirely.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" result="c"/>' +
      '<feComposite in="SourceAlpha" in2="c" operator="in"/>')))).toBeNull();
  });

  it('intersects the flood and composite subregions', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" x="0" y="0" width="60" height="60"/>' +
      '<feComposite in2="SourceAlpha" operator="in" x="40" y="10" width="100" height="20"/>'))))
      .toMatchObject({ clip: { x: 40, y: 10, w: 20, h: 20 } });
  });

  it('carries flood-opacity', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" flood-opacity="0.4"/>' +
      '<feComposite in2="SourceAlpha" operator="in"/>'))))
      .toMatchObject({ kind: 'tint', opacity: 0.4 });
  });
});

describe('drawSvg — tint fast path', () => {
  const TINT_DOC = doc(TINT);

  it('emits a solid fill behind an ALPHA soft mask', () => {
    const { content, resources, rasterized } = draw(TINT_DOC);
    expect(content).toContain('0 1 0 rg');
    expect(rasterized).toEqual([]);
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    const smask = gs.get('SMask');
    if (!isDict(smask)) throw new Error('no /SMask');
    const s = smask.get('S');
    // Alpha, NOT Luminosity: feComposite operator="in" reads in2's alpha and
    // nothing else. A luminosity mask of dark artwork is ~0, so the tint would
    // silently vanish on exactly the icons this recipe is used for.
    expect(s).toEqual({ kind: 'name', name: 'Alpha' });
    expect(smask.get('G')).toBeDefined();
  });

  it('puts the source subtree in the mask group, not on the page', () => {
    const { streams } = draw(TINT_DOC);
    const form = streams.find((s) => {
      const b = s.dict.get('BBox');
      return Array.isArray(b) && b[2] === 100 && b[3] === 100;
    });
    expect(form).toBeDefined();
    expect(form!.content).toContain('1 0 0 rg');    // the red source rect
  });

  it('folds flood-opacity into the constant alpha alongside the mask', () => {
    const { content, resources } = draw(doc(
      '<feFlood flood-color="#00ff00" flood-opacity="0.4"/>' +
      '<feComposite in2="SourceAlpha" operator="in"/>'));
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    expect(gs.get('ca')).toBe(0.4);
    expect(isDict(gs.get('SMask'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-filter-fast.test.ts -t tint`
Expected: FAIL — `classify` returns `null` for the two-primitive chain.

- [ ] **Step 3: Extend `src/svgfilter.ts`**

Add the union member:

```ts
export type FastPath =
  | { kind: 'offset'; dx: number; dy: number; clip: SegBBox }
  | { kind: 'flood'; color: Rgb; opacity: number; clip: SegBBox }
  | { kind: 'tint'; color: Rgb; opacity: number; clip: SegBBox };
```

Add this branch to `classify`, after the `feFlood` branch and before `return null`:

```ts
  // feFlood -> feComposite operator="in" against the source's alpha: the
  // recolour-an-icon recipe, and the only chain here that real documents
  // contain. Exact in EITHER colour space, because a constant colour through an
  // alpha multiply round-trips linearRGB unchanged -- which is what qualifies
  // it where feBlend over a flood does not.
  //
  // `operator` is matched literally rather than defaulted: its default is
  // "over", which is a different picture.
  if (p.length === 2 && p[0].name === 'feFlood' && p[1].name === 'feComposite'
      && p[1].attrs.get('operator') === 'in'
      && p[1].in1 === p[0].result
      && (p[1].in2 === 'SourceAlpha' || p[1].in2 === 'SourceGraphic')) {
    const f = floodPaint(p[0]);
    if (f !== null)
      return { kind: 'tint', color: f.color, opacity: f.opacity,
               clip: clipTo(p[0].sub, p[1].sub) };
  }
```

- [ ] **Step 4: Add the `tint` case to `emitFastFilter` in `src/svgdraw.ts`**

Insert inside the `switch`, after the `flood` case:

```ts
    case 'tint': {
      // /S /Alpha, not /Luminosity: feComposite operator="in" reads in2's ALPHA
      // and nothing else. An alpha soft mask needs no /CS, so the group
      // groupForm already builds is the right one unchanged.
      const form = groupForm(e, region, body);
      e.out.push('q');
      e.out.push(`/${e.gsKey(fast.opacity, 1, form, 'Alpha')} gs`);
      e.out.push(`${fast.color.map(num).join(' ')} rg`);
      e.out.push(
        `${num(fast.clip.x)} ${num(fast.clip.y)} ${num(fast.clip.w)} ${num(fast.clip.h)} re`);
      e.out.push('f');
      e.out.push('Q');
      return;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-filter-fast.test.ts`
Expected: PASS, all 33 tests.

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add src/svgfilter.ts src/svgdraw.ts test/svg-filter-fast.test.ts
git commit -m "feat(svg): vector fast path for the feFlood -> feComposite tint

The recolour-an-icon recipe, and the only chain in this set that real
documents contain. operator=\"in\" reads in2's alpha and nothing else, so
the result is a constant colour behind an alpha mask -- exactly a PDF
/S /Alpha soft mask over a form of the source subtree.

Exact in either colour space: a constant colour through an alpha multiply
round-trips linearRGB unchanged, which is what qualifies this where
feBlend over a flood does not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Prove each fast path equals the raster path

The whole justification for a second implementation is that it agrees with the first. This task renders each chain twice through the public `AddSVGObject` + `ToImage` — once as written, once padded with a trailing `feOffset dx="0" dy="0"` so it takes the raster path — and compares.

The comparison is a **mean absolute difference over every pixel**, plus exact spot checks in flat interiors. Edges will differ: the fast path is vector and the raster path resamples at `filterScale`. That is the point of the change, so the tolerance is on the mean, not the max.

**Files:**
- Test: `test/svg-filter-fast.test.ts` (append)

**Interfaces:**
- Consumes: `Document` from `../src/document.js`; `buildSvgPdf` from `./helpers/build-svg-fixtures.js`; `decodePng` and `DecodedPng` from `./helpers/decode-png.js`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-filter-fast.test.ts`, and add these imports at the top of the file:

```ts
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';
```

```ts
/** Place `src` over a 200x200 page at 1 px per point and rasterize it. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(xml(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r };
}

/** The same chain, padded so it can no longer classify. An feOffset of (0, 0)
 *  is an exact identity -- offsetKernel rounds its delta to whole pixels -- so
 *  the two documents are the same picture by spec, and differ only in which
 *  code path drew them. This is what keeps the fast paths honest without a
 *  test-only opt-out flag that no caller would ever exercise. */
const padded = (prims: string) => prims + '<feOffset dx="0" dy="0"/>';

/** Mean absolute RGB difference per channel, 0..255. */
function meanDiff(a: DecodedPng, b: DecodedPng): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const p = a.at(x, y), q = b.at(x, y);
      for (let c = 0; c < 3; c++) sum += Math.abs(p[c] - q[c]);
    }
  return sum / (a.width * a.height * 3);
}

/** A 60x60 red square at (20, 20), filtered by `prims`, over a user-space
 *  region covering the whole 200x200 viewBox. */
const page = (prims: string) =>
  '<svg viewBox="0 0 200 200"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  prims + '</filter></defs>' +
  '<rect x="20" y="20" width="60" height="60" fill="#ff0000" filter="url(#f)"/></svg>';

/** Assert the fast path and the raster path draw the same picture, and that
 *  each actually took the path it was supposed to. */
function agree(prims: string, tolerance: number, build = page): void {
  const fast = render(build(prims));
  const slow = render(build(padded(prims)));
  expect(fast.result.rasterized).toEqual([]);
  expect(slow.result.rasterized).toEqual(['filter']);
  expect(fast.result.skipped).toEqual([]);
  expect(slow.result.skipped).toEqual([]);
  expect(meanDiff(fast.png, slow.png)).toBeLessThan(tolerance);
}

describe('fast path vs raster path — same picture', () => {
  it('agrees on a lone feOffset', () => {
    agree('<feOffset dx="50" dy="30"/>', 4);
  });

  it('agrees on the identity feMerge', () => {
    agree('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>', 4);
  });

  it('agrees on a lone feFlood', () => {
    agree('<feFlood flood-color="#0000ff" flood-opacity="0.4" ' +
          'x="30" y="40" width="90" height="70"/>', 4);
  });

  it('agrees on the tint recipe', () => {
    agree('<feFlood flood-color="#00aa44"/>' +
          '<feComposite in2="SourceAlpha" operator="in"/>', 4);
  });

  it('agrees on the tint recipe over a shape with soft edges', () => {
    // A circle's antialiased rim is where an alpha mask and a resampled raster
    // are most likely to part company; a rectangle's axis-aligned edges hide it.
    agree('<feFlood flood-color="#00aa44"/>' +
          '<feComposite in2="SourceAlpha" operator="in"/>', 5,
      (prims) =>
        '<svg viewBox="0 0 200 200"><defs>' +
        '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
        prims + '</filter></defs>' +
        '<circle cx="100" cy="100" r="60" fill="#ff0000" filter="url(#f)"/></svg>');
  });
});

describe('fast path — spot checks in flat interiors', () => {
  it('moves the square by the offset and leaves the source position empty', () => {
    const { png } = render(page('<feOffset dx="50" dy="30"/>'));
    const [r, g, b] = png.at(100, 80);       // 20+50+30, 20+30+30: inside the shifted square
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(png.at(40, 40)[1]).toBeGreaterThan(240);   // where it was: white page
  });

  it('paints the tint colour, not the source colour, inside the shape', () => {
    const { png } = render(page(
      '<feFlood flood-color="#00aa44"/><feComposite in2="SourceAlpha" operator="in"/>'));
    const [r, g, b] = png.at(50, 50);
    expect(r).toBeLessThan(80);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(120);
    expect(png.at(150, 150)[0]).toBeGreaterThan(240); // outside the shape: untinted white
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/svg-filter-fast.test.ts`
Expected: PASS. These exercise code that Tasks 2-4 already landed, so they should be green on the first run — which is precisely why Task 6 exists and this step is not evidence of anything.

If a `meanDiff` assertion fails, do **not** raise the tolerance to make it pass. A mean above ~5/255 over a mostly-flat 200×200 page means the two paths disagree about placement or colour, not about antialiasing. Print the two PNGs and find the disagreement.

- [ ] **Step 3: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add test/svg-filter-fast.test.ts
git commit -m "test(svg): prove each filter fast path equals the raster path

Renders each chain twice through the public AddSVGObject + ToImage: once
as written, once padded with a no-op feOffset so it rasterizes. The two
documents are the same picture by spec and differ only in which code path
drew them, which keeps both honest without a test-only opt-out that no
caller would exercise.

Compared as mean absolute difference: edges legitimately differ, since the
fast path is vector where the raster path resamples. That is the change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Prove the tests are load-bearing

Every test written so far passed on its first run. That is not evidence. This task breaks each guarded code path in turn and confirms the suite goes red — the discipline that found the missing `hmtx` coverage and the deleted `maskTo` in earlier phases.

**This task writes no production code.** It adds fixtures only where a mutation survives.

**Files:**
- Modify: `test/svg-filter-fast.test.ts` (only if a mutation survives)

**Interfaces:**
- Consumes: everything from Tasks 2-5.
- Produces: nothing.

- [ ] **Step 1: Run each mutation and record the result**

For each row: make the edit, run `npx vitest run test/svg-filter-fast.test.ts`, record whether it went red, then **revert the edit** with `git checkout -- src/` before the next row.

| # | Mutation | Must fail because |
|---|---|---|
| 1 | In `emitFastFilter`'s `offset` case, delete the `e.out.push(rectClip(fast.clip))` line | `'clips the result to a narrow subregion'` — a full-region subregion would pass with the clip gone, which is why that fixture uses `x="10" y="5" width="20" height="15"` |
| 2 | In the `offset` case, change `groupForm(e, region, body)` to build its BBox from `fast.clip` instead of `region` | the region-vs-subregion distinction collapses; `'clips the source to the filter region inside the form'` and the offset equivalence test should both move |
| 3 | In the `offset` case, negate `fast.dy` in the `cm` | `'moves the square by the offset'` and the feOffset equivalence test. The fixture is asymmetric in y on purpose — the y-down/y-up seam has already bitten this stack once |
| 4 | In `classify`'s `feMerge` branch, drop the `nodes.length === 1` check | `'refuses a two-node feMerge'` |
| 5 | In `classify`'s `feMerge` branch, replace `nodes[0].attrs.get('in') ?? 'SourceGraphic'` with `p[0].in1` | `'refuses a one-node feMerge on SourceAlpha'` — `in1` on the primitive defaults to SourceGraphic regardless of what the node says |
| 6 | In `emitFastFilter`'s `tint` case, change `'Alpha'` to `'Luminosity'` | the tint equivalence tests. The source is `#ff0000`, whose luminance is ~0.21 — dark enough that a luminosity mask changes the picture substantially |
| 7 | In the `tint` case, drop `fast.opacity` from the `gsKey` call (pass `1`) | `'folds flood-opacity into the constant alpha alongside the mask'` |
| 8 | In `classify`'s tint branch, remove the `p[1].attrs.get('operator') === 'in'` check | `'refuses a different operator'` |
| 9 | In `classify`'s tint branch, replace `clipTo(p[0].sub, p[1].sub)` with `p[1].sub` | `'intersects the flood and composite subregions'` |
| 10 | In `floodPaint`, drop the clamp (return `o` raw when finite) | `'carries flood-opacity, clamped'` |
| 11 | In `classify`, make the `feOffset` branch accept any `in1` | `'refuses an feOffset on SourceAlpha'` |

- [ ] **Step 2: Investigate every mutation that survived**

A surviving mutation means the guard it broke has no test. Do not move on. Add a fixture that fails under that mutation and passes without it, then re-run the mutation to confirm it now goes red.

Mutation 6 is the one most likely to survive, and the reason is worth understanding before you write a replacement fixture: an alpha mask and a luminosity mask agree wherever the source is *white*. If red at luminance ~0.21 turns out not to move the mean enough, change the tint fixture's source `fill` to something darker — `#202020` — and assert the interior is the flood colour at full strength rather than at ~12% of it.

Mutation 2 may also survive if the region and the subregion happen to coincide in the fixture. If so, give the offset equivalence fixture a filter region that is genuinely smaller than the shape (`x="0" y="0" width="120" height="200"` with the square at x=20..80 and `dx="50"`), so the region clips the source and the offset would otherwise drag the clipped part back into view.

- [ ] **Step 3: Confirm the tree is clean**

Run: `git status --porcelain src/`
Expected: no output. Every mutation must have been reverted.

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 5: Commit (only if Step 2 added fixtures)**

```bash
git add test/svg-filter-fast.test.ts
git commit -m "test(svg): fixtures that make the fast-path guards load-bearing

Found by mutation, not by failure: <name the specific mutations that
survived and what each new fixture pins>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

If nothing survived, skip the commit and say so in the task report — that is a real result, not a non-event.

---

### Task 7: Documentation, follow-up issue, and close

**Files:**
- Modify: `README.md:19` (the SVG embedding bullet) and `README.md:1398` (the API table row)
- Modify: `docs/superpowers/plans/2026-07-31-svg-filter-fast-paths.md` — nothing; this task closes the issue instead

**Interfaces:**
- Consumes: the shipped feature.
- Produces: nothing.

- [ ] **Step 1: Correct the README's rasterization claim**

In the **Filters** portion of the `README.md:19` bullet, find this sentence:

> PDF has no filter model, so a filtered subtree is **rasterized**: it renders correctly but is resolution-bound, and its text stops being extractable or searchable.

Replace it with:

> PDF has no filter model, so a filtered subtree is generally **rasterized**: it renders correctly but is resolution-bound, and its text stops being extractable or searchable. Four chain shapes escape that, because PDF expresses them exactly — a lone `feOffset` (and the one-node `feMerge` that means the same thing), a lone `feFlood`, and `feFlood` + `feComposite operator="in"`, the recolour-an-icon recipe, which becomes an `/S /Alpha` soft mask. These stay vector, keep their text extractable, ignore `filterScale`, and are **not** named in `rasterized`.

- [ ] **Step 2: Correct the API table row**

In the `page.AddSVGObject` row at `README.md:1398`, change:

> and `<filter>` (all of SVG 1.1's primitives, rasterized at `opts.filterScale`)

to:

> and `<filter>` (all of SVG 1.1's primitives, rasterized at `opts.filterScale` except four chains PDF expresses exactly, which stay vector)

- [ ] **Step 3: File the follow-up the wiring exposed**

The `activeFilters` guard exists to stop an `feImage` element reference recursing into its own filter, but `emitFiltered` sets it around the *whole* subtree walk. That makes the raster path refuse the legal case of a child carrying the same `filter=` as its parent — the child reports `filter` and draws unfiltered. The fast path does not have this problem (Task 2, Step 5), which is what made the asymmetry visible.

```bash
bd create "SVG <filter>: nested same-filter refused on the raster path" \
  -t bug -p 4 --parent aspose-pdf-foss-for-ts-1gg0.10 \
  -d "emitFiltered adds the filter id to activeFilters around the entire subtree walk, so a descendant carrying the same filter= as its ancestor is refused as a reference cycle and drawn unfiltered. That is legal SVG: each element applies the filter independently. The guard is only needed for feImage element references, which are the only way a filter can reach back into the tree. Narrow it to the feImage path. The vector fast paths added in 1gg0.10.5 do not set the guard and render this case correctly, which is how the asymmetry surfaced."
```

- [ ] **Step 4: Run the full gates one last time**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 5: Commit the docs**

```bash
git add README.md
git commit -m "docs: four SVG filter chains are no longer rasterized

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Record what shipped and close the issue**

```bash
bd remember --key svg-filter-fast-paths-shipped "1gg0.10.5 shipped (1gg0.10 phase 5), closing the filter track. classify(spec) in svgfilter.ts is pure and returns FastPath|null -- a THREE-case union (offset/flood/tint), not four: an identity chain is offset with dx=dy=0, so there is no extra branch to forget. emitFastFilter in svgdraw.ts draws them; walk tries classify before emitFiltered. A fast path adds nothing to rasterized OR skipped, ignores filterScale, and needs NO raster sink -- these filters now render through drawSvg calls that pass none.

MATCHING IS ON THE RESOLVED PRIMS, never the source attributes: resolveFilter has already defaulted a missing in to SourceGraphic/prev-result and already intersected every sub with the region. But feMergeNode is NOT a primitive and joins no implicit chain, so its missing in means SourceGraphic -- the feMerge branch must read the CHILD's attribute, not p[0].in1.

WHY THESE FOUR. offset: a form whose /BBox is the region, then the cm -- a /BBox clips in the form's OWN space, so the source is cut to the region BEFORE the shift (15.7.5) with no rectangle arithmetic. flood/tint: a constant colour through an alpha multiply round-trips linearRGB unchanged, so both are exact in EITHER colour space. tint (feFlood -> feComposite operator=in) is /S /Alpha, which needs no /CS, so groupForm's group works unchanged.

DROPPED, do not re-litigate: the 1gg0.10 design's feBlend-over-flood row. SVG composites in linearRGB by default and PDF /BM blends in device space, so it is exact only under color-interpolation-filters=sRGB.

TEST METHOD: no opt-out flag. Each chain renders twice through the public AddSVGObject+ToImage -- once as written, once padded with a trailing feOffset dx=0 dy=0 so it rasterizes -- compared as MEAN abs diff, because edges legitimately differ. TRAPS: a luminosity-vs-alpha mutation only shows on a DARK source (white artwork makes the two masks agree); a subregion clip only shows on a subregion narrower than the region; a dy sign flip only shows on a vertically asymmetric fixture. Existing svg-filter-render.test.ts fixtures had to be padded first -- SHIFT was a lone feOffset."

bd close aspose-pdf-foss-for-ts-1gg0.10.5
```

- [ ] **Step 7: Push**

```bash
git pull --rebase
git push
git status
```

Expected: `git status` reports the branch is up to date with `origin`. Work is not complete until this succeeds.

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: the `classify` seam and the three-case union (Tasks 2-4); all four chain shapes (Task 2 offset + feMerge, Task 3 flood, Task 4 tint); each emission including the form-BBox region clip and the `/S /Alpha` mask (Tasks 2-4); the "adds nothing to `rasterized` or `skipped`" consequence (asserted in every emission test); "needs no rasterizer" (Task 2's `'still rasterizes a chain that does not classify'` runs with no raster sink at all); `filterRes` ignored (implicit — `classify` never reads `spec.res`, and no emission consults it); the equivalence method with padding (Task 5); all five load-bearing fixtures from the spec's trap table (Task 6, mutations 1, 2, 3, 6, 7); the README correction (Task 7).

The spec's Files table lists exactly the four files Tasks 1-7 touch.

**Placeholders.** None. Every code step carries the actual code; the one judgement call left open — which replacement fixture to write if a mutation survives — is Task 6's entire purpose, and it names the two likeliest survivors with the specific fix for each.

**Type consistency.** `FastPath` is declared once in Task 2 and extended in Tasks 3 and 4 with the same three property names throughout (`clip` on all members; `dx`/`dy` on `offset`; `color`/`opacity` on `flood` and `tint`). `classify(spec: FilterSpec): FastPath | null` and `emitFastFilter(e, fast, region, body): void` keep one signature each across all tasks. `floodPaint` is introduced in Task 3 and reused by name in Task 4. `gsKey(ca, CA, smask?, smaskType?)`, `groupForm(e, box, body)`, `xobjKey(r, prefix?)`, `clipTo(a, r)`, `primLength(spec, v, dflt, axis)` and `parseColor(s)` are all quoted at their real existing signatures.
