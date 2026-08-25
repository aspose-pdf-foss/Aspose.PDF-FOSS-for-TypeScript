# Gradient stroke paint — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `PageGraphics.setStrokeGradient(g)` so callers can stroke vector paths with the same axial and radial gradients `setFillGradient` already fills with.

**Architecture:** A gradient stroke is `/Pattern CS` + `/<key> SCN` over the *same* `shadingPattern()` a fill registers, so `gradient.ts` and the renderers need nothing new. The real work is alpha: Task 1 gives `registerExtGState` a channel so a gradient's opacity lands on `ca` or `CA` and not both; Task 2 folds the shipped `setFillGradient` body into a shared `gradientPaint(g, channel)` core and adds the stroke entry point; Task 3 adds the live-soft-mask guard, since one `/ExtGState` holds one `/SMask` and it masks both paints; Task 4 proves the chain end-to-end through `ToImage`, documents it, and mutation-checks the lot.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

Design: `docs/superpowers/specs/2026-08-04-stroke-gradient-design.md`.
Issue: `aspose-pdf-foss-for-ts-menf`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension, e.g. `import { Page } from './page.js'` — even from a `.ts` file.
- **`bd`, not TodoWrite.** This project tracks tasks in beads. Do not create markdown TODO lists.
- **Both gates green before closing.** `npm run typecheck` and `npm test` must both pass. Target one file with `npx vitest run test/<name>.test.ts`.
- **Public error types** are `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`. Throw one of those, never a bare `Error`.
- **Argument rejection is `TypeError`** and must leave the document byte-identical — validate before allocating anything.
- **`doc.resolve(undefined)` returns `null`, not `undefined`.** Key *presence* must be tested on the raw dict (`d.has(k)`), never on the resolved value. This has already caused one shipped bug (the PDF/X ExtGState rules); Task 1 walks straight into it.

---

## File Structure

| File | Change | Responsibility after |
|---|---|---|
| `src/pagecontent.ts` | Modify `registerExtGState` (lines 76-94) | Page-resource registration. Gains the exported `AlphaChannel` type and a channel-scoped, exactly-matching reuse compare. |
| `src/graphics.ts` | Modify | The buffered vector builder. Gains `setStrokeGradient`, the shared private `gradientPaint` core, `channelOpacity`, `claimSoftMask`, and a `{ ctm, liveMask }` state stack. |
| `test/graphics.test.ts` | Modify | Unit assertions on emitted operators and page resources. Gains two describes: `registerExtGState channels` and `PageGraphics.setStrokeGradient`. |
| `test/graphics-gradient-render.test.ts` | Modify | End-to-end `Save`/`Open`/`ToImage` pixel checks. Gains a `setStrokeGradient` describe. |
| `README.md` | Modify (~line 568-606) | User-facing docs for the gradient methods. |

No new module. `src/gradient.ts` is untouched — it is already paint-agnostic, which is what makes this issue small.

---

### Task 1: Channel-scoped `/ExtGState` alpha

**Files:**
- Modify: `src/pagecontent.ts:76-94`
- Test: `test/graphics.test.ts` (append a new top-level describe at the end of the file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type AlphaChannel = 'both' | 'fill' | 'stroke';` from `src/pagecontent.ts`
  - `registerExtGState(doc: Document, page: Page, opacity: number, channel?: AlphaChannel): string` — the 4th parameter defaults to `'both'`, so the eight existing call sites in `stamp.ts`, `decorate.ts`, `compose.ts`, `imageembed.ts` and `graphics.ts` are unchanged and must stay unchanged.

**Background for the implementer:** `ca` is the fill alpha and `CA` the stroke alpha (PDF 32000-1 §11.6.4.4). They are independent. `registerExtGState` today writes both and reuses any state whose `ca` *and* `CA` equal the requested opacity. Task 2 needs a fill-only and a stroke-only variant, and the reuse loop has two traps: an absent key resolves to `null` (not `undefined`), and the soft-mask states `registerSoftMaskExtGState` builds carry `ca = CA = 1`, so a request for opacity 1 would match one and silently inherit its `/SMask`.

- [ ] **Step 1: Write the failing tests**

Append to the end of `test/graphics.test.ts`:

```ts
describe('registerExtGState channels', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];

  /** A named /ExtGState off page 1. */
  function ext(doc: Document, key: string): PdfDict {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const gs = isDict(res) ? doc.resolve(res.get('ExtGState')) : undefined;
    const d = isDict(gs) ? doc.resolve(gs.get(key)) : undefined;
    if (!isDict(d)) throw new Error(`no /ExtGState /${key}`);
    return d;
  }

  it('scopes the alpha to one paint channel', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const f = registerExtGState(doc, page, 0.5, 'fill');
    const s = registerExtGState(doc, page, 0.5, 'stroke');
    const b = registerExtGState(doc, page, 0.5, 'both');

    expect(ext(doc, f).get('ca')).toBe(0.5);
    expect(ext(doc, f).has('CA')).toBe(false);
    expect(ext(doc, s).get('CA')).toBe(0.5);
    expect(ext(doc, s).has('ca')).toBe(false);
    expect(ext(doc, b).get('ca')).toBe(0.5);
    expect(ext(doc, b).get('CA')).toBe(0.5);
    expect(new Set([f, s, b]).size).toBe(3);      // three distinct states
  });

  it('defaults to both channels, leaving existing callers unchanged', () => {
    const doc = Document.Open(buildStampTarget());
    const k = registerExtGState(doc, doc.Pages[0], 0.25);
    expect(ext(doc, k).get('ca')).toBe(0.25);
    expect(ext(doc, k).get('CA')).toBe(0.25);
  });

  it('reuses a state only when the whole channel set matches', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    expect(registerExtGState(doc, page, 0.5, 'fill'))
      .toBe(registerExtGState(doc, page, 0.5, 'fill'));
    // A fill-only 0.5 must NOT satisfy a request for both channels: ca and CA
    // are independent, and reusing it silently drops the stroke half.
    expect(registerExtGState(doc, page, 0.5, 'both'))
      .not.toBe(registerExtGState(doc, page, 0.5, 'fill'));
  });

  it('never reuses a soft-mask state for a plain alpha', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const grad: LinearGradient = {
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0 },
              { offset: 1, color: BLUE, opacity: 1 }],
    };
    const identity: Matrix = [1, 0, 0, 1, 0, 0];
    // The mask state carries ca = CA = 1, so an opacity-1 request matches it on
    // both channels — and would silently inherit its /SMask.
    const masked = registerSoftMaskExtGState(
      doc, page,
      shadingPattern(axialShading(grad, normalizeStops(grad.stops), 'alpha')),
      identity);
    expect(registerExtGState(doc, page, 1)).not.toBe(masked);
  });
});
```

Extend the existing imports at the top of the file — `registerShadingPattern` is already imported from `pagecontent.js` (line 5) and `axialShading`, `shadingPattern`, `normalizeStops`, `LinearGradient` from `gradient.js` (lines 6-9):

```ts
import {
  registerShadingPattern, registerExtGState, registerSoftMaskExtGState,
} from '../src/pagecontent.js';
import type { Matrix } from '../src/text.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/graphics.test.ts -t 'registerExtGState channels'`

Expected: FAIL. `scopes the alpha to one paint channel` fails first — `registerExtGState` ignores the 4th argument, so every state has both keys and `has('CA')` is `true`. TypeScript will also reject the extra argument under `npm run typecheck`.

- [ ] **Step 3: Implement the channel**

Replace `src/pagecontent.ts:76-94` in full:

```ts
/** Which alpha channel(s) an /ExtGState sets: `ca` (fill), `CA` (stroke), or
 *  both. */
export type AlphaChannel = 'both' | 'fill' | 'stroke';

/** Register (or reuse) an /ExtGState with `opacity` on `channel`; returns its
 *  resource key. The default sets both channels, which is what setOpacity and
 *  every stamping caller means.
 *
 *  **Invariant:** the reuse compare matches the exact key SET, not just the
 *  values it happens to find. `ca` and `CA` are independent, so handing a
 *  << /ca 0.5 >> back to a caller asking for both channels silently drops the
 *  stroke half — and a gradient fill's alpha would then be reused for a gradient
 *  stroke's. Presence is read off the RAW dict: doc.resolve(undefined) returns
 *  null, so a resolved absent key does not compare equal to undefined.
 *
 *  **Invariant:** a state carrying an /SMask is never reused. The mask states
 *  registerSoftMaskExtGState builds set ca = CA = 1, so a request for opacity 1
 *  matches them on both channels and would silently inherit the mask. */
export function registerExtGState(
  doc: Document, page: Page, opacity: number, channel: AlphaChannel = 'both',
): string {
  const wantCa = channel === 'stroke' ? undefined : opacity;
  const wantCA = channel === 'fill' ? undefined : opacity;
  const res = ensureOwnResources(doc, page);
  const gs = ensureOwnSubdict(doc, res, 'ExtGState');
  for (const [k, v] of gs) {
    const d = doc.resolve(v);
    if (!isDict(d) || d.has('SMask')) continue;
    const at = (key: string): PdfObject | undefined =>
      (d.has(key) ? doc.resolve(d.get(key)) : undefined);
    if (at('ca') === wantCa && at('CA') === wantCA) return k;
  }
  const entries: [string, PdfObject][] = [['Type', name('ExtGState')]];
  if (wantCa !== undefined) entries.push(['ca', wantCa]);
  if (wantCA !== undefined) entries.push(['CA', wantCA]);
  const key = freshKey(gs, 'GS');
  gs.set(key, doc.allocObject(new Map<string, PdfObject>(entries)));
  return key;
}
```

Every identifier used here is already imported at the top of `pagecontent.ts` (`isDict`, `name`, `PdfObject`) or defined above it (`ensureOwnResources`, `ensureOwnSubdict`, `freshKey`). Add no imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/graphics.test.ts`
Expected: PASS, including the pre-existing `fill opacity registers a single reusable ExtGState` case (line 55), which pins that `'both'` still deduplicates.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. The eight existing `registerExtGState` call sites all take the default, so nothing else moves. If a stamp, decorate, compose or imageembed test goes red, the default is not `'both'` — fix that rather than the test.

- [ ] **Step 6: Commit**

```bash
git add src/pagecontent.ts test/graphics.test.ts
git commit -m "$(cat <<'EOF'
feat(pagecontent): scope /ExtGState alpha to a paint channel

registerExtGState gains an AlphaChannel; the default stays 'both', so all
eight existing call sites are unchanged. setStrokeGradient needs CA
without ca, and the shipped setFillGradient should never have written CA.

Two traps in the reuse loop, both now covered: an absent key resolves to
null rather than undefined, so presence is read off the raw dict; and the
soft-mask states carry ca = CA = 1, so an opacity-1 request would have
matched one and inherited its /SMask.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `setStrokeGradient` over a shared core

**Files:**
- Modify: `src/graphics.ts:95-138` (the `setFillGradient` body and `inverseCtm`), plus one new type alias near the top
- Test: `test/graphics.test.ts` (a new `PageGraphics.setStrokeGradient` describe, and one added assertion in the existing fill describe)

**Interfaces:**
- Consumes: from Task 1 — `registerExtGState(doc, page, opacity, channel?: AlphaChannel)`.
- Produces:
  - `PageGraphics.setStrokeGradient(g: Gradient): this` — public, chainable.
  - `PageGraphics.setFillGradient(g: Gradient): this` — unchanged signature, now delegating.
  - private `gradientPaint(g: Gradient, ch: PaintChannel): this`
  - private `channelOpacity(alpha: number, ch: PaintChannel): void`
  - module-local `type PaintChannel = 'fill' | 'stroke';`

**Background for the implementer:** the two public methods differ in exactly three things — operator case (`cs`/`scn` vs `CS`/`SCN`), the degenerate solid (`rg` vs `RG`), and the alpha channel. Everything else is shared, including three invariants a copied implementation would have to re-derive: gradient coordinates live in the stream's default space, the soft-mask group needs the inverse CTM, and a degenerate collapse takes the *single stop's own* opacity rather than the gradient-wide one. Write one core, not two bodies.

- [ ] **Step 1: Write the failing tests**

Add this describe to `test/graphics.test.ts`, immediately after the closing `});` of the existing `PageGraphics.setFillGradient` describe (line 415). It repeats the small resource helpers rather than reaching into the other describe's scope:

```ts
describe('PageGraphics.setStrokeGradient', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];
  const ramp = (): GradientStop[] => [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  function pageResource(doc: Document, key: string): PdfDict | undefined {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(res)) return undefined;
    const p = doc.resolve(res.get(key));
    return isDict(p) ? p : undefined;
  }

  const patterns = (doc: Document) => pageResource(doc, 'Pattern');

  const nameOf = (v: PdfObject | undefined): string | undefined =>
    (isName(v) ? v.name : undefined);

  function extGState(doc: Document, key: string): PdfDict {
    const d = doc.resolve(pageResource(doc, 'ExtGState')?.get(key));
    if (!isDict(d)) throw new Error(`no /ExtGState /${key}`);
    return d;
  }

  it('selects a registered shading pattern as the stroke colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: ramp() })
     .setLineWidth(8).drawLine(10, 20, 110, 20).stroke();
    g.apply();

    const text = pageContentText(doc);
    // Upper case: the stroke colour operators, not the fill ones.
    expect(text).toContain('/Pattern CS');
    expect(text).toContain('/P0 SCN');
    expect(text).not.toContain('/Pattern cs');

    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.get('PatternType')).toBe(2);
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('selects a registered ShadingType 3 pattern for a radial gradient', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'radial', cx: 50, cy: 60, r: 25, stops: ramp() })
     .circle(50, 60, 25).stroke();
    g.apply();

    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual([50, 60, 0, 50, 60, 25]);
  });

  it('collapses a single-stop gradient to a solid stroke and allocates no pattern', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                          stops: [{ offset: 0, color: RED }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toContain('1 0 0 RG');
    expect(pageContentText(doc)).not.toContain('/Pattern CS');
    expect(patterns(doc)).toBeUndefined();
  });

  it('collapses a zero-length axis and a zero radius to the last stop colour', () => {
    for (const grad of [
      { kind: 'linear' as const, x1: 50, y1: 50, x2: 50, y2: 50, stops: ramp() },
      { kind: 'radial' as const, cx: 50, cy: 50, r: 0, stops: ramp() },
    ]) {
      const doc = Document.Open(buildStampTarget());
      const g = doc.Pages[0].Graphics();
      g.setStrokeGradient(grad);
      g.drawLine(0, 0, 10, 10).stroke();
      g.apply();

      expect(pageContentText(doc)).toContain('0 0 1 RG');   // BLUE, the last stop
      expect(patterns(doc)).toBeUndefined();
    }
  });

  it('folds a uniform stop alpha into /CA alone, leaving fills opaque', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                          stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                  { offset: 1, color: BLUE, opacity: 0.5 }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toMatch(/\/GS\d+ gs/);
    // A stroke's own alpha must not fade the fill of the same path.
    expect(extGState(doc, 'GS0').get('CA')).toBe(0.5);
    expect(extGState(doc, 'GS0').has('ca')).toBe(false);
  });

  it('takes the single stop\'s own opacity when it collapses', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 50, y1: 50, x2: 50, y2: 50,
                          stops: [{ offset: 0, color: RED, opacity: 0.4 },
                                  { offset: 1, color: BLUE, opacity: 0.25 }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(extGState(doc, 'GS0').get('CA')).toBe(0.25);   // the LAST stop's alpha
    expect(extGState(doc, 'GS0').has('ca')).toBe(false);
  });

  it('keeps gradient coordinates in the default space, ignoring the CTM', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.transform(2, 0, 0, 2, 10, 20);
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: ramp() });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    // A pattern /Matrix maps pattern space to the stream's DEFAULT space, so the
    // cm above moves the path and not the ramp.
    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('Coords')).toEqual([0, 0, 100, 0]);
  });

  it('leaves the document byte-identical when validation rejects', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setStrokeGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [],
    })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });
});
```

Then pin the fill-side correction. In the existing `folds a uniform stop alpha into an /ExtGState` case (`test/graphics.test.ts:249-261`), replace its two assertions with:

```ts
    const text = pageContentText(doc);
    expect(text).toMatch(/\/GS\d+ gs/);
    expect(text).toContain('/Pattern cs');
    // A fill's own alpha must not fade the stroke of the same path.
    expect(extGState(doc, 'GS0').get('ca')).toBe(0.5);
    expect(extGState(doc, 'GS0').has('CA')).toBe(false);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/graphics.test.ts -t 'setStrokeGradient'`
Expected: FAIL — `g.setStrokeGradient is not a function`. `npm run typecheck` fails on the same.

Run: `npx vitest run test/graphics.test.ts -t 'folds a uniform stop alpha'`
Expected: FAIL on the fill case too — it writes `CA` today, so `has('CA')` is `true`.

- [ ] **Step 3: Add the `PaintChannel` alias**

In `src/graphics.ts`, after the `KAPPA` constant (line 41) and before the class:

```ts
/** Which paint a gradient sets. Narrower than pagecontent's AlphaChannel:
 *  there is no 'both' paint. */
type PaintChannel = 'fill' | 'stroke';
```

- [ ] **Step 4: Replace the gradient methods**

Replace `src/graphics.ts:74-138` — the whole shipped `setFillGradient` doc comment and body, plus `inverseCtm`, which keeps its implementation and moves below the new helpers:

```ts
  /** Fill subsequent paths with an axial or radial gradient. Symmetric with
   *  {@link setFillColor}: this sets the fill paint, and the next `fill()` /
   *  `fillEvenOdd()` / `fillStroke()` uses it. See {@link gradientPaint} for the
   *  invariants both gradient setters share. */
  setFillGradient(g: Gradient): this { return this.gradientPaint(g, 'fill'); }

  /** Stroke subsequent paths with an axial or radial gradient. Symmetric with
   *  {@link setStrokeColor}: this sets the stroke paint, and the next `stroke()`
   *  / `fillStroke()` uses it. See {@link gradientPaint} for the invariants both
   *  gradient setters share.
   *
   *  The ramp is pinned to page space and not to the path, so a gradient
   *  stroke's colour at a point depends on where that point IS, not on how far
   *  along the outline it lies. A ramp that follows a path is a different
   *  feature and is not this one. */
  setStrokeGradient(g: Gradient): this { return this.gradientPaint(g, 'stroke'); }

  /** The shared body of {@link setFillGradient} and {@link setStrokeGradient}.
   *  The two differ in exactly three things — operator case, the degenerate
   *  solid, and which alpha channel a uniform stop opacity folds into — so there
   *  is one implementation and not two: this path carries three invariants a
   *  copy would have to re-derive, and a later fix to one would silently miss
   *  the other.
   *
   *  **Invariant:** gradient coordinates are in the page's DEFAULT user space
   *  and ignore the CTM. A pattern /Matrix maps pattern space to the default
   *  space of the parent content stream (PDF 32000-1 §8.7.3.1), not to the CTM
   *  in force when the pattern is selected — so a `transform()` earlier in this
   *  builder moves the path and not the ramp. The upside is that apply()'s q/Q
   *  wrapping and appendContent's stream nesting can never shift a gradient.
   *
   *  A gradient with fewer than two stops, a zero-length axis, or a zero radius
   *  collapses to a solid colour and allocates no pattern. A uniform stop
   *  opacity folds into an /ExtGState carrying THIS channel's alpha alone — `ca`
   *  for a fill, `CA` for a stroke — so it OVERRIDES an earlier
   *  {@link setOpacity} in that channel rather than multiplying with it, and
   *  leaves the other paint alone. Stops whose opacities DIFFER become a
   *  luminosity soft mask, also carried on an /ExtGState and overriding earlier
   *  opacity the same way; a mask has no channel split, so it dims both paints.
   *
   *  Like every other graphics-state setting, that mask stays in force until a
   *  {@link restore}; wrap the paint in {@link save}/{@link restore} if later
   *  drawing must be unmasked. */
  private gradientPaint(g: Gradient, ch: PaintChannel): this {
    validateGradient(g);

    // Degenerate cases collapse to a solid, matching svggradient.ts's rules.
    // Each paints ONE stop, so it takes that stop's own opacity: using the
    // gradient-wide alpha here would paint a varying ramp's degenerate case
    // fully opaque.
    const flat = g.kind === 'linear' ? g.x1 === g.x2 && g.y1 === g.y2 : !(g.r > 0);
    if (g.stops.length < 2 || flat) {
      const s = g.stops[g.stops.length - 1];
      const a = stopOpacity(s);
      if (a < 1) this.channelOpacity(a, ch);
      return ch === 'fill' ? this.setFillColor(s.color) : this.setStrokeColor(s.color);
    }

    const stops = normalizeStops(g.stops);
    const shade = (variant: ShadingVariant) =>
      g.kind === 'linear' ? axialShading(g, stops, variant) : radialShading(g, stops, variant);

    const key = registerShadingPattern(this.doc, this.page, shadingPattern(shade('color')));
    const alpha = uniformOpacity(stops);
    if (alpha === null) {
      // A varying ramp cannot fold into a single ca/CA: its grayscale twin
      // becomes a luminosity soft mask, whose group is un-transformed back into
      // the default space the colour pattern lives in.
      const gs = registerSoftMaskExtGState(
        this.doc, this.page, shadingPattern(shade('alpha')), this.inverseCtm());
      this.op(`/${escapeName(gs)} gs`);
    } else if (alpha < 1) this.channelOpacity(alpha, ch);
    return ch === 'fill'
      ? this.op(`/Pattern cs /${escapeName(key)} scn`)
      : this.op(`/Pattern CS /${escapeName(key)} SCN`);
  }

  /** An /ExtGState alpha scoped to ONE paint channel. A gradient's own opacity
   *  must not fade the other paint of the same path, which is why this is not
   *  {@link setOpacity} — that one means both channels, and its callers rely on
   *  it. */
  private channelOpacity(alpha: number, ch: PaintChannel): void {
    const key = registerExtGState(this.doc, this.page, alpha, ch);
    this.op(`/${escapeName(key)} gs`);
  }

  /** The matrix that undoes this builder's current CTM — the soft-mask group's
   *  /Matrix. A singular CTM paints nothing at all, so identity is as good an
   *  answer as any and beats throwing from a fill. */
  private inverseCtm(): Matrix {
    try {
      // invert() hands back -0 for the off-diagonal of an axis-aligned CTM;
      // fold it to 0 so the emitted /Matrix reads as one.
      return invert(this.ctm).map((v) => (v === 0 ? 0 : v)) as Matrix;
    } catch {
      return [...IDENTITY];
    }
  }
```

Note what did *not* change: `setLineCap` and everything after it stay where they are, and the `setStrokeColor` / `setFillColor` / `setOpacity` methods above are untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/graphics.test.ts`
Expected: PASS, all describes.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing outside `graphics.ts` calls `setFillGradient`, so the `ca`-only correction is contained; if an SVG or flow test goes red, something in the shared core changed behaviour — stop and report rather than editing the test.

- [ ] **Step 7: Commit**

```bash
git add src/graphics.ts test/graphics.test.ts
git commit -m "$(cat <<'EOF'
feat(graphics): gradient stroke paint via setStrokeGradient (menf)

/Pattern CS + SCN over the same shadingPattern() a fill registers. The
shipped setFillGradient body becomes a shared gradientPaint(g, channel)
core rather than being copied: it carries three invariants — default-space
coordinates, the inverse-CTM mask matrix, per-stop opacity on the
degenerate collapse — that a second implementation would have to
re-derive, and a later fix to one would silently miss the other.

A uniform stop alpha now lands on that gradient's own channel alone, so a
translucent gradient stroke no longer fades the fill of the same path.
That corrects setFillGradient too, which wrote CA as well as ca.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The live-soft-mask guard

**Files:**
- Modify: `src/graphics.ts` — the class state fields (lines 46-54 as shipped), `save`/`restore`, the four paint operators, and one line in `gradientPaint`
- Test: `test/graphics.test.ts` (added cases in the `PageGraphics.setStrokeGradient` describe)

**Interfaces:**
- Consumes: from Task 2 — `gradientPaint(g, ch)`, `type PaintChannel`.
- Produces: private `claimSoftMask(ch: PaintChannel): void` and private `paint(op: string): this`. No public surface change; `save`, `restore`, `stroke`, `fill`, `fillEvenOdd`, `fillStroke` keep their signatures.

**Background for the implementer:** an `/ExtGState` holds one `/SMask` and it masks fill and stroke alike — there is no per-channel split the way `ca`/`CA` gives one. So a varying-alpha fill gradient followed by a varying-alpha stroke gradient loses the first mask entirely, and the `fillStroke()` paints the fill through the *stroke's* ramp. The fix a caller must apply is to paint in two operations, the split `svgdraw.ts` already makes in `resolvePaint`/`gsOps`. Undetected, this is a silently wrong render, so the builder tracks which channel owns the mask in force and refuses the collision.

The subtlety: re-setting the *same* channel's mask is legal (nothing was painted through the one being replaced), and painting clears the claim, so the correct sequence — set, paint, set, paint — must pass through untouched. Get this wrong in the strict direction and you break `allocates a fresh mask per call rather than deduplicating` (line 341), which sets a varying fill gradient twice.

- [ ] **Step 1: Write the failing tests**

Add to the `PageGraphics.setStrokeGradient` describe from Task 2, before its closing `});`:

```ts
  const varying = (): GradientStop[] =>
    [{ offset: 0, color: RED, opacity: 0.2 }, { offset: 1, color: BLUE, opacity: 0.9 }];
  const varyingGrad = (): LinearGradient =>
    ({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: varying() });

  it('masks varying stop alpha with a luminosity soft mask', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: varying() })
     .drawLine(10, 20, 110, 20).stroke();
    g.apply();

    // The mask `gs` must precede the pattern selection and the paint.
    expect(pageContentText(doc)).toMatch(/\/GS\d+ gs[\s\S]*\/Pattern CS[\s\S]*\/P0 SCN/);

    const smask = doc.resolve(extGState(doc, 'GS0').get('SMask'));
    expect(isDict(smask)).toBe(true);
    if (!isDict(smask)) return;
    const form = doc.resolve(smask.get('G'));
    expect(isStream(form)).toBe(true);
    if (!isStream(form)) return;
    const res = doc.resolve(form.dict.get('Resources'));
    const pat = isDict(res) ? doc.resolve(res.get('Pattern')) : undefined;
    const p0 = isDict(pat) ? doc.resolve(pat.get('P0')) : undefined;
    expect(isDict(p0)).toBe(true);
    if (!isDict(p0)) return;
    const sh = doc.resolve(p0.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    // The grayscale twin on the SAME axis: a mask that does not line up with
    // what it masks is worse than no mask.
    expect(nameOf(sh.get('ColorSpace'))).toBe('DeviceGray');
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('refuses a second soft mask for the other channel before a paint', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient(varyingGrad());
    // One /ExtGState holds ONE /SMask and it masks both paints, so this would
    // silently paint the fill through the stroke's ramp.
    expect(() => g.setStrokeGradient(varyingGrad())).toThrow(UnsupportedFeatureError);
  });

  it('allows the two-operation split a paint between them makes', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient(varyingGrad());
    g.rect(0, 0, 10, 10).fill();
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toContain('/GS0 gs');
    expect(pageContentText(doc)).toContain('/GS1 gs');
  });

  it('allows re-setting the same channel, which paints through neither', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient(varyingGrad());
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });

  it('pops the claim with restore(), as a real /SMask is popped by Q', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.save();
    g.setFillGradient(varyingGrad());
    g.restore();                                   // the fill mask is out of force
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });

  it('a uniform-alpha gradient claims nothing, since it registers no mask', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                { offset: 1, color: BLUE, opacity: 0.5 }] });
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });
```

Add the error import to the top of `test/graphics.test.ts`:

```ts
import { UnsupportedFeatureError } from '../src/errors.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/graphics.test.ts -t 'refuses a second soft mask'`
Expected: FAIL — nothing throws today; the second `gs` is emitted and the first mask is lost.

- [ ] **Step 3: Replace the tracked state**

In `src/graphics.ts`, replace the two state fields and their comment (lines 46-54 as shipped) with:

```ts
  /** The CTM this builder's own operators have established. Tracked because a
   *  varying-alpha gradient's soft mask renders under the CTM in force where its
   *  `gs` runs, and must be given the inverse to stay in the default space its
   *  colour twin lives in. */
  private ctm: Matrix = [...IDENTITY];
  /** Which paint owns the soft mask currently in force, if any. See
   *  {@link claimSoftMask}. */
  private liveMask?: PaintChannel;
  /** What save() pushes and restore() pops: the two pieces of state above, which
   *  are the only coordinate- or state-sensitive things this builder knows. */
  private readonly stateStack: { ctm: Matrix; liveMask?: PaintChannel }[] = [];
```

- [ ] **Step 4: Push and pop both**

Replace `save` and `restore`:

```ts
  save(): this {
    this.stateStack.push({ ctm: [...this.ctm], liveMask: this.liveMask });
    return this.op('q');
  }
  restore(): this {
    // An unbalanced restore() is the caller's business; keeping the last state
    // is the least surprising thing to do with one.
    const s = this.stateStack.pop();
    if (s !== undefined) { this.ctm = s.ctm; this.liveMask = s.liveMask; }
    return this.op('Q');
  }
```

- [ ] **Step 5: Clear the claim on every paint**

Replace the four paint operators:

```ts
  // ---- paint ----
  stroke(): this { return this.paint('S'); }
  fill(): this { return this.paint('f'); }
  fillEvenOdd(): this { return this.paint('f*'); }
  fillStroke(): this { return this.paint('B'); }

  /** A paint operator. Clears the soft-mask claim: the mask has done its job, so
   *  the other channel may take the single /SMask slot now. */
  private paint(op: string): this {
    this.liveMask = undefined;
    return this.op(op);
  }
```

- [ ] **Step 6: Add the guard and call it**

Add beside `channelOpacity`:

```ts
  /** Claim the single /SMask slot for `ch`. An /ExtGState holds ONE soft mask
   *  and it masks fill and stroke alike, so a varying-alpha fill and a
   *  varying-alpha stroke cannot both be in force: the second silently replaces
   *  the first, and the paint then uses the wrong ramp for one of them. The fix
   *  is to paint in two operations, the split svgdraw.ts makes in resolvePaint.
   *
   *  Re-claiming for the SAME channel is legal — nothing was painted through the
   *  mask being replaced — and every paint operator releases the claim, so the
   *  correct sequence (set, paint, set, paint) passes through untouched. */
  private claimSoftMask(ch: PaintChannel): void {
    if (this.liveMask !== undefined && this.liveMask !== ch)
      throw new UnsupportedFeatureError(
        'a varying-alpha fill gradient and a varying-alpha stroke gradient cannot be ' +
        'in force at once: an /ExtGState holds one soft mask, which masks both paints. ' +
        'Paint the fill and the stroke as two operations.');
    this.liveMask = ch;
  }
```

In `gradientPaint`, call it as the first statement of the `alpha === null` branch, before anything is allocated — a rejected call must leave the document byte-identical:

```ts
    if (alpha === null) {
      this.claimSoftMask(ch);
      // A varying ramp cannot fold into a single ca/CA: its grayscale twin
```

Add the import at the top of `src/graphics.ts`:

```ts
import { UnsupportedFeatureError } from './errors.js';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/graphics.test.ts`
Expected: PASS. Watch two pre-existing cases in particular — `allocates a fresh mask per call rather than deduplicating` (line 341) proves a same-channel re-claim is allowed, and `undoes the CTM in the mask group's /Matrix, popping it with restore()` (line 320) proves the state stack still carries the CTM correctly.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/graphics.ts test/graphics.test.ts
git commit -m "$(cat <<'EOF'
feat(graphics): refuse two soft masks in one graphics state

An /ExtGState holds ONE /SMask and it masks fill and stroke alike, so a
varying-alpha fill gradient followed by a varying-alpha stroke gradient
loses the first mask and paints the fill through the stroke's ramp. That
is a silently wrong render, so PageGraphics tracks which paint owns the
mask in force and throws UnsupportedFeatureError naming the fix: paint
the two as separate operations.

Re-claiming the same channel stays legal and every paint operator
releases the claim, so set-paint-set-paint passes through untouched. The
claim rides the save()/restore() stack beside the CTM.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: End-to-end proof, docs, and the mutation check

**Files:**
- Modify: `test/graphics-gradient-render.test.ts` (append a describe)
- Modify: `README.md:568-606`

**Interfaces:**
- Consumes: from Tasks 2 and 3 — `PageGraphics.setStrokeGradient`.
- Produces: nothing new in code.

**Background for the implementer:** this is the only test that exercises the whole chain — build, `Save`, `Open`, `ToImage` — and the one that catches a wrong operator case or a wrong `/Matrix`. `raster.ts` is an independently written *reader* of shading patterns, so these assertions are not a round trip through one body of code. It already resolves stroke shading patterns by narrowing the clip to the stroke outline (`pagerender.ts:450-458`, `clipToStroke`), so no rendering support is needed.

The helper at the top of the file renders on a blank 200×200 page at 1 px per point, so device pixel `(x, y)` is user `(x, 200 - y)`.

- [ ] **Step 1: Write the end-to-end test**

This one is not red-first: Tasks 2 and 3 already built what it exercises, and its job is to prove the chain rather than to drive a new unit.

Append to `test/graphics-gradient-render.test.ts`:

```ts
describe('setStrokeGradient through Save/Open/ToImage', () => {
  it('ramps red → blue along a thick stroked line and paints nothing off it', () => {
    const png = render((g) => {
      g.setStrokeGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).setLineWidth(40).drawLine(0, 100, 200, 100).stroke();
    });

    // The line covers user y 80..120, i.e. the same device rows.
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

    // Off the line the page is untouched. This is what proves the shading was
    // clipped to the STROKE: a fill-side mix-up would flood the whole page.
    expect(png.at(4, 20)).toEqual([255, 255, 255, 255]);
    expect(png.at(100, 180)).toEqual([255, 255, 255, 255]);
  });

  it('strokes a radial ramp centred on the circle it draws', () => {
    const png = render((g) => {
      g.setStrokeGradient({
        kind: 'radial', cx: 100, cy: 100, r: 60,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).setLineWidth(20).circle(100, 100, 60).stroke();
    });

    // The stroke straddles r = 60, where the ramp has reached its last stop.
    const [r, , b] = png.at(160, 100);
    expect(b).toBeGreaterThan(r);
    // Inside the circle, away from the stroke, nothing was painted.
    expect(png.at(100, 100)).toEqual([255, 255, 255, 255]);
  });
});
```

If the fourth channel of `png.at` on a blank page is not 255 (the page may render as RGB rather than RGBA), assert `png.at(4, 20).slice(0, 3)` equals `[255, 255, 255]` instead — `decodePng` pads gray/RGB to opaque, so this is a shape question, not a correctness one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics-gradient-render.test.ts -t 'setStrokeGradient'`
Expected: PASS if Tasks 2 and 3 are complete. That is the point of this task — it is the integration check, not a red-first unit. If it FAILS, the operator case or the pattern registration is wrong; debug before continuing.

- [ ] **Step 3: Update the README**

In `README.md`, change the sentence at line 568 that opens the gradient paragraph:

```markdown
`setFillGradient` fills — and `setStrokeGradient` strokes — with an axial
(linear) `ShadingType 2` or radial `ShadingType 3` ramp:
```

After the existing radial example block (ending at line 592), add:

```markdown
```ts
g.setStrokeGradient({
  kind: 'linear',
  x1: 50, y1: 0, x2: 250, y2: 0,
  stops: [
    { offset: 0, color: [1, 0, 0] },
    { offset: 1, color: [0, 0, 1] },
  ],
});
g.setLineWidth(6).drawLine(50, 300, 250, 300).stroke();
```

A gradient stroke's ramp is pinned to page space, not to the path, so its colour
at a point depends on where that point is rather than on how far along the
outline it lies.
```

Then correct the alpha sentence at lines 599-606, replacing from "and a uniform stop `opacity` folds" through "must be unmasked.":

```markdown
and a uniform stop `opacity` folds into the graphics state — on that gradient's
own channel alone (`ca` for a fill, `CA` for a stroke), so a translucent gradient
stroke does not fade the fill of the same path. A gradient with one stop, a
zero-length axis, or a zero radius is drawn as a solid colour. Stops with
*differing* `opacity` are exact too, rendered through a luminosity `/SMask` — a
grayscale twin of the shading inside a transparency group, the same construct the
SVG importer uses. Both alpha forms **override** an earlier `setOpacity()` in
their channel rather than multiplying with it, and like every graphics-state
setting the mask stays in force until a `restore()`, so wrap the paint in
`save()`/`restore()` if later drawing must be unmasked.

A soft mask has no channel split — one `/ExtGState` holds one `/SMask` and it
dims both paints. So a varying-alpha fill gradient and a varying-alpha stroke
gradient cannot be in force at once: setting the second throws
`UnsupportedFeatureError`. Paint the fill and the stroke as two operations.
```

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck`
Expected: clean.

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Mutation check**

Per CLAUDE.md, passing on the first run is not evidence. Break each path deliberately, confirm the suite goes **red**, then revert the break before moving to the next. Run `npx vitest run test/graphics.test.ts test/graphics-gradient-render.test.ts` after each.

| # | Break | Must fail |
|---|---|---|
| 1 | In `gradientPaint`, emit `/Pattern cs … scn` for the stroke branch too | `selects a registered shading pattern as the stroke colour`, and both render cases |
| 2 | In `gradientPaint`, swap the two `Coords` endpoints by passing `{ ...g, x1: g.x2, x2: g.x1 }` to `shade` | `selects a registered shading pattern as the stroke colour`, and the red/blue ends of the render case |
| 3 | In `channelOpacity`, hard-code the channel to `'both'` | `folds a uniform stop alpha into /CA alone` and the fill-side `folds a uniform stop alpha into an /ExtGState` |
| 4 | In `registerExtGState`, drop the `d.has('SMask')` skip | `never reuses a soft-mask state for a plain alpha` |
| 5 | In `registerExtGState`, compare with `doc.resolve(d.get(key))` instead of the `d.has` guard | `reuses a state only when the whole channel set matches` |
| 6 | In `claimSoftMask`, return early instead of throwing | `refuses a second soft mask for the other channel before a paint` |
| 7 | In `paint`, drop the `this.liveMask = undefined` line | `allows the two-operation split a paint between them makes` |
| 8 | In `restore`, restore only `ctm` and not `liveMask` | `pops the claim with restore(), as a real /SMask is popped by Q` |

If any row stays green, the assertion is not load-bearing — fix the test, not the mutation.

- [ ] **Step 6: Commit**

```bash
git add test/graphics-gradient-render.test.ts README.md
git commit -m "$(cat <<'EOF'
test(graphics): end-to-end gradient stroke render, and README

A thick gradient-stroked line and a stroked circle through
Save/Open/ToImage, sampling the ramp along the axis. raster.ts is an
independently written reader of shading patterns, so these are not a
round trip through one body of code. The off-line white assertions are
what prove the shading was clipped to the stroke rather than flooding
the page.

Mutation-checked: wrong operator case, swapped /Coords, both-channel
alpha, the /SMask reuse skip, the raw-dict presence test, the soft-mask
guard, and the claim's release and restore all turn the suite red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-menf
git pull --rebase
git push
git status                     # MUST show "up to date with origin"
```

---

## Notes for the reviewer

- **The one deliberate behaviour change to shipped code** is `setFillGradient`'s uniform-alpha path moving from `ca` + `CA` to `ca` alone (Task 2). It is in the design's Scope section, and `test/graphics.test.ts:249` pins it.
- **`setOpacity` is untouched** and still writes both channels. That is what its name says and what its callers in `stamp.ts`, `decorate.ts`, `compose.ts` and `imageembed.ts` mean.
- **`src/gradient.ts` must not change.** If a task seems to need a change there, the shared core has drifted — stop and report.
