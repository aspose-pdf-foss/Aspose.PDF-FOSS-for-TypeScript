# ToSvg Clip Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ToSvg` render a non-isolated transparency group non-isolated, by emitting clips as attributes on the leaves they clip instead of as wrapper `<g>` elements.

**Architecture:** `clip-path` establishes a CSS stacking context, so the `<g clip-path>` wrapper that `SvgSink.addClip` emits for a form's `/BBox` isolates the group's contents from the page — an inner blend mode never reaches the page backdrop. Replace the wrapper with a clip *stack*: each clip is defined as a `<clipPath>` chained onto the enclosing one (`<clipPath clip-path="url(#prev)">`, which SVG intersects), and every painted leaf carries `clip-path="url(#innermost)"`. Group and mask wrappers are untouched.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Golden regeneration needs Chrome + resvg out of band.

**Issue:** `aspose-pdf-foss-for-ts-7wg`. **Spec:** `docs/superpowers/specs/2026-07-21-svg-clip-isolation-design.md`.

## Global Constraints

- **Zero runtime dependencies** — `node:` built-ins only. Do not add npm runtime deps.
- **ESM + NodeNext**, `strict` TypeScript; import specifiers carry `.js` (e.g. `./strokegeom.js`).
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- Issue tracking is **bd**, never TodoWrite or markdown TODO lists.
- `test/pkcs12.test.ts` fails on this machine for an unrelated environmental reason (OpenSSL 3.5 cannot load the legacy provider — `aspose-pdf-foss-for-ts-u75`). It is the **only** acceptable failure; treat any other red test as yours.
- Golden regeneration is **not** part of `npm test`. It needs packages installed without being recorded in `package.json`:
  ```bash
  npm i --no-save tsx puppeteer @resvg/resvg-js
  npx tsx scripts/gen-svg-goldens.ts
  ```
- A golden that passes on its first run is not evidence. Every construct gets a mutation check, recorded in `test/fixtures/svg/PROVENANCE.md`.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/svgrender.ts` | Modify | `SvgSink`: clip stack, chained `<clipPath>` defs, leaf `clip-path` attributes, capture save/restore |
| `test/helpers/svg-golden-fixtures.ts` | Modify | Register the `non-isolated-blend-group` golden fixture |
| `test/svgrender.test.ts` | Modify | Hermetic clip assertions (two existing tests assert the wrapper form and must change) |
| `test/fixtures/svg/non-isolated-blend-group.png` | Create (Task 3) | Browser golden, committed only once both engines agree with PDF semantics |
| `test/fixtures/svg/PROVENANCE.md` | Modify | Divergence entry (Task 1) → Covers + mutation rows (Tasks 3–4) |

No new files. The change is contained to `SvgSink`; `pagerender.ts` is not touched — it keeps calling `addClip` exactly as it does now.

---

### Task 1: Register the failing golden fixture and record the divergence

Proves the bug exists in a real SVG engine *before* any fix, using the same mechanism that caught the tiling-pattern and stroke-clip bugs. Nothing is fixed in this task.

**Files:**
- Modify: `test/helpers/svg-golden-fixtures.ts`
- Modify: `test/fixtures/svg/PROVENANCE.md`

**Interfaces:**
- Consumes: `isolatedBlendGroupPdf(isolated = true)` from `test/helpers/build-transparency-fixtures.ts` — already exists and already takes the flag; `isolatedBlendGroupPdf(false)` builds the non-isolated variant.
- Produces: a `GOLDEN_FIXTURES` entry named `non-isolated-blend-group`, consumed by `scripts/gen-svg-goldens.ts` and `test/svg-golden.test.ts`.

- [ ] **Step 1: Register the fixture**

In `test/helpers/svg-golden-fixtures.ts`, add this entry to the end of the `GOLDEN_FIXTURES` array, immediately after the existing `isolated-blend-group` entry:

```ts
  {
    name: 'non-isolated-blend-group',
    pdf: () => isolatedBlendGroupPdf(false),
    width: 200, height: 200,
    probes: [
      // The mirror image of isolated-blend-group. Not isolated, the inner
      // Multiply sees the yellow page and cyan × yellow reads green. Rendered
      // isolated it would read (0,255,255) — which is what ToSvg emits today,
      // because the /BBox clip wrapper establishes a stacking context (7wg).
      { x: 100, y: 100, rgb: GREEN, note: 'inner blend must reach the page backdrop' },
      { x: 20, y: 20, rgb: YELLOW, note: 'page backdrop outside the group' },
    ],
  },
```

Add the `GREEN` constant next to the existing `CYAN` / `YELLOW` declarations near the top of the file:

```ts
const GREEN = [0, 255, 0] as [number, number, number];
```

`isolatedBlendGroupPdf` is already imported by this file — no import change is needed.

- [ ] **Step 2: Confirm the fixture is wired up but has no golden**

Run: `npx vitest run test/svg-golden.test.ts`

Expected: PASS, and the test count is **unchanged** from before your edit. `test/svg-golden.test.ts` filters `GOLDEN_FIXTURES` to those with a committed PNG (`existsSync`), so a fixture with no golden contributes no tests. If the count went up, a stale `non-isolated-blend-group.png` exists — delete it.

- [ ] **Step 3: Run the generator and observe the SKIP**

```bash
npm i --no-save tsx puppeteer @resvg/resvg-js
npx tsx scripts/gen-svg-goldens.ts
```

Expected: `14 golden(s) written, 1 skipped.` and this line on stderr:

```
SKIP non-isolated-blend-group: engines agree with each other but not with PDF semantics
    chrome (100,100) expected 0,255,0 got 0,255,255
    resvg  (100,100) expected 0,255,0 got 0,255,255
```

This is the signature that matters: **both engines agree with each other and both disagree with PDF semantics.** That is a bug in our emitted markup, not an engine quirk. If instead the engines disagree with *each other*, stop — the diagnosis in the spec is wrong and the plan needs revisiting.

Confirm `git status --short test/fixtures/svg/` shows **no** new PNG: a skipped fixture is never written.

- [ ] **Step 4: Record the divergence**

In `test/fixtures/svg/PROVENANCE.md`, add this section at the end of the `## Divergences` section (after the stroke-shaped clips subsection):

```markdown
### Non-isolated groups render isolated — FIX IN PROGRESS

`aspose-pdf-foss-for-ts-7wg`. Chrome and resvg agree with each other and both
disagree with PDF semantics: `non-isolated-blend-group` probes green at the
group centre and both engines paint cyan, i.e. the group renders isolated.

`drawFormBody` wraps every form XObject body in a clip for its `/BBox`, which
`SvgSink.addClip` emits as `<g clip-path="url(#id)">`. `clip-path` establishes a
CSS stacking context, and a stacking context isolates — so the group's inner
`mix-blend-mode` composites against the wrapper's transparent backdrop instead
of the page. The wrapper is emitted on the unbuffered path too, so this is wrong
even at group alpha 1 with a Normal group blend, which is the case
`aspose-pdf-foss-for-ts-bbu` describes as exact. `ToImage` is correct there.

Not detectable from `ToImage`, which composites directly and never goes through
this markup — the same blind spot the goldens exist to find.
```

- [ ] **Step 5: Commit**

```bash
git add test/helpers/svg-golden-fixtures.ts test/fixtures/svg/PROVENANCE.md
git commit -m "test(svg): register non-isolated-blend-group, which both engines fail (7wg)"
```

---

### Task 2: Clips become leaf attributes

The whole emitter change, TDD. At the end of this task the in-tree suite is green; the goldens are regenerated in Task 3.

**Files:**
- Modify: `src/svgrender.ts` (`SvgSink`: fields, `save`/`restore`, `addClip`, `clipToStroke`, `beginOffscreen`, `endOffscreen`, `fill`, `stroke`, `image`, `glyphRun`, `fillViewportRect`)
- Modify: `test/svgrender.test.ts`

**Interfaces:**
- Consumes: `SvgWriter.nextId(prefix)`, `.addDef(s)`, `.emit(s)`, `.beginCapture()`, `.endCapture()` — all unchanged.
- Produces: private `SvgSink` members `clipStack: string[]`, `clipSaves: string[][]`, `currentClip(): string | undefined`, `clipAttrs(): string[]`, `pushClip(child: string, prefix: string): void`. `saveStack` changes element type from `number` to `{ depth: number; clips: number }`. The public `RenderSink` interface is **unchanged** — `pagerender.ts` needs no edit.

- [ ] **Step 1: Write the failing tests**

In `test/svgrender.test.ts`, **replace** the existing test `'registers a clipPath and wraps subsequent content in a clip group'` (in `describe('Page.ToSvg — clipping')`) with these four:

```ts
  it('clips leaves by attribute instead of wrapping them in a group', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: CLIP_CONTENT }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<defs>.*<clipPath id="clip\d+">.*<\/clipPath>.*<\/defs>/s);
    // clip-path establishes a stacking context, so a clip wrapper would isolate
    // a non-isolated group's inner blend from the page (7wg). Leaves only.
    expect(svg).not.toMatch(/<g[^>]*clip-path=/);
    expect(svg).toMatch(/<path[^>]*clip-path="url\(#clip\d+\)"/);
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  // SVG intersects a <clipPath> with its own clip-path, which is what lets
  // nested clips compose without a wrapper element.
  it('chains nested clipPaths, and leaves carry the innermost id', () => {
    const content = 'q 0 0 100 100 re W n q 0 0 50 50 re W n 1 0 0 rg 0 0 200 200 re f Q Q';
    const svg = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0].ToSvg();
    const defs = [...svg.matchAll(/<clipPath id="(clip\d+)"([^>]*)>/g)];
    expect(defs).toHaveLength(2);
    const [outer, inner] = defs;
    expect(outer[2]).not.toContain('clip-path');                     // nothing encloses it
    expect(inner[2]).toContain(`clip-path="url(#${outer[1]})"`);     // intersects the outer
    expect(svg).toMatch(new RegExp(`<path[^>]*clip-path="url\\(#${inner[1]}\\)"`));
  });

  it('drops the clip at Q, leaving later content unclipped', () => {
    const content = 'q 0 0 50 50 re W n 1 0 0 rg 0 0 200 200 re f Q 0 0 1 rg 0 0 200 200 re f';
    const svg = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0].ToSvg();
    const paths = (svg.match(/<path[^>]*\/>/g) ?? []);
    const red = paths.find((p) => p.includes('#ff0000')) ?? '';
    const blue = paths.find((p) => p.includes('#0000ff')) ?? '';
    expect(red).toContain('clip-path=');
    expect(blue).not.toContain('clip-path=');
  });

  // A captured definition is built once and used elsewhere: the active clip
  // applies where it is *used*. A tiling cell in particular lives outside the
  // region it fills, so baking the clip into the cell would erase it.
  it('does not bake the active clip into a tiling pattern cell', () => {
    const svg = Document.Open(tilingPatternOffsetClipPdf()).Pages[0].ToSvg();
    const cell = svg.match(/<pattern[^>]*>(.*?)<\/pattern>/s)?.[1] ?? '';
    expect(cell).not.toContain('clip-path=');
    expect(svg).toMatch(/<rect[^>]*fill="url\(#tile\d+\)"[^>]*clip-path="url\(#clip\d+\)"/);
  });
```

Extend the existing import from `./helpers/build-transparency-fixtures.js` at the top of the file to add the tiling fixture:

```ts
import { strokePatternPdf, tilingPatternOffsetClipPdf } from './helpers/build-transparency-fixtures.js';
```

Then in `describe('Page.ToSvg — shadings')`, the test `'renders a shading-pattern fill (scn) as a gradient clipped to the path'` asserts the wrapper form. Replace its two clip lines:

```ts
    expect(svg).toMatch(/<clipPath id="clip\d+">/);
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)">/);
```

with:

```ts
    expect(svg).toMatch(/<clipPath id="clip\d+">/);
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    // The gradient paints through a viewport rect carrying the clip, not a wrapper.
    expect(svg).toMatch(/<rect[^>]*fill="url\(#grad\d+\)"[^>]*clip-path="url\(#clip\d+\)"/);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svgrender.test.ts`

Expected: FAIL — 5 failures. The four clipping tests fail on `expect(svg).not.toMatch(/<g[^>]*clip-path=/)` and on the missing leaf attribute; the shading test fails because the rect carries no `clip-path`.

- [ ] **Step 3: Add the clip stack to SvgSink**

In `src/svgrender.ts`, replace the field declarations and `save`/`restore` of `SvgSink`.

Change:

```ts
  private saveStack: number[] = [];
```

to:

```ts
  /** Depth of open wrapper <g>s, plus clip-stack depth, per `save()`. */
  private saveStack: { depth: number; clips: number }[] = [];
  /** Active clip ids, innermost last. Clips are attributes on the leaves they
   *  clip, never wrapper elements: clip-path establishes a stacking context,
   *  which would isolate a non-isolated group's inner blend from the page
   *  (7wg). Nesting is expressed by chaining the <clipPath> defs instead. */
  private clipStack: string[] = [];
  /** clipStack saved across a capture — see beginOffscreen. */
  private clipSaves: string[][] = [];
```

Change:

```ts
  save(): void { this.saveStack.push(this.groupDepth); }
  restore(): void {
    const target = this.saveStack.pop() ?? 0;
    while (this.groupDepth > target) { this.w.emit('</g>'); this.groupDepth--; }
  }
```

to:

```ts
  save(): void { this.saveStack.push({ depth: this.groupDepth, clips: this.clipStack.length }); }
  restore(): void {
    const target = this.saveStack.pop() ?? { depth: 0, clips: 0 };
    while (this.groupDepth > target.depth) { this.w.emit('</g>'); this.groupDepth--; }
    if (this.clipStack.length > target.clips) this.clipStack.length = target.clips;
  }
```

Add these three private helpers immediately after `restore()`:

```ts
  /** The innermost active clip, or undefined when nothing is clipped. */
  private currentClip(): string | undefined { return this.clipStack[this.clipStack.length - 1]; }

  /** `clip-path` for a painted leaf. Append last, after paintAttrs. */
  private clipAttrs(): string[] {
    const id = this.currentClip();
    return id ? [`clip-path="url(#${id})"`] : [];
  }

  /** Define a clipPath chained onto the enclosing clip and make it current.
   *  SVG intersects a <clipPath> with its own clip-path, so the innermost id
   *  alone denotes the full active clip. */
  private pushClip(child: string, prefix: string): void {
    const id = this.w.nextId(prefix);
    const parent = this.currentClip();
    const chain = parent ? ` clip-path="url(#${parent})"` : '';
    this.w.addDef(`<clipPath id="${id}"${chain}>${child}</clipPath>`);
    this.clipStack.push(id);
  }
```

- [ ] **Step 4: Convert the two clip entry points**

Replace the body of `addClip`:

```ts
  addClip(path: Path, ctm: Matrix, evenOdd: boolean): void {
    const d = pathToD(path);
    if (!d) return;
    const rule = evenOdd ? ' clip-rule="evenodd"' : '';
    this.pushClip(`<path d="${d}" transform="${matrixAttr(ctm)}"${rule}/>`, 'clip');
  }
```

Replace the tail of `clipToStroke` — keep its existing leading comment and the `strokeOutlinePolys` call, and replace everything from `const d = polys.map(...)` onward with:

```ts
    const d = polys.map((p) => polyToD(p)).join('');
    this.pushClip(`<path d="${d}"/>`, 'sclip');
```

- [ ] **Step 5: Attach the clip to every painted leaf**

Five emit sites. In `fill`, `stroke`, and `glyphRun`, add one line immediately after the existing `attrs.push(...this.paintAttrs(...))` line:

```ts
    attrs.push(...this.clipAttrs());
```

(`fill` and `glyphRun` use `paintAttrs('fill')`, `stroke` uses `paintAttrs('stroke')` — leave those calls as they are.)

Replace `image` entirely — it builds its markup inline today, so it needs restructuring rather than one added line:

```ts
  image(stream: PdfStream, ctm: Matrix, fillColor: Rgb): void {
    const href = this.imageHref(stream, fillColor);
    const transform = matrixAttr(mul([1, 0, 0, -1, 0, 1], ctm)); // unit-square with local Y-flip
    if (href) {
      const attrs = ['x="0"', 'y="0"', 'width="1"', 'height="1"', 'preserveAspectRatio="none"',
        `transform="${transform}"`, `href="${href}"`];
      attrs.push(...this.paintAttrs('fill'));
      attrs.push(...this.clipAttrs());
      this.w.emit(`<image ${attrs.join(' ')}/>`);
    } else {
      const attrs = ['x="0"', 'y="0"', 'width="1"', 'height="1"',
        `transform="${transform}"`, 'fill="#cccccc"'];
      attrs.push(...this.clipAttrs());
      this.w.emit(`<rect ${attrs.join(' ')}/>`);
    }
  }
```

Replace `fillViewportRect` — this one carries both shadings and tiling-pattern paint:

```ts
  private fillViewportRect(ctm: Matrix, paint: string): void {
    const attrs = ['x="-100000"', 'y="-100000"', 'width="200000"', 'height="200000"',
      `transform="${matrixAttr(ctm)}"`, `fill="${paint}"`];
    attrs.push(...this.clipAttrs());
    this.w.emit(`<rect ${attrs.join(' ')}/>`);
  }
```

- [ ] **Step 6: Save and restore the clip stack across a capture**

Captured content becomes a `<pattern>`/`<mask>`/`<g>` *definition*; the active clip applies where that definition is used, not while it is built. Without this, a tiling cell would bake in the outer clip and paint nothing.

Replace `beginOffscreen`:

```ts
  beginOffscreen(_region?: { x0: number; y0: number; x1: number; y1: number }): void {
    this.w.beginCapture();
    // Contents are captured unclipped: the active clip applies to whatever
    // *uses* the resulting definition. A tiling cell in particular lives
    // outside the region it fills, so clipping it here would erase it. Mirrors
    // beginOffscreen in raster.ts, which resets to a fresh Paint for the same
    // reason.
    this.clipSaves.push(this.clipStack);
    this.clipStack = [];
  }
```

In `endOffscreen`, restore it on the line immediately after `const inner = this.w.endCapture();`, **before** any branch runs — every branch emits markup that needs the outer clip:

```ts
  endOffscreen(use: OffscreenUse): void {
    const inner = this.w.endCapture();
    this.clipStack = this.clipSaves.pop() ?? [];
```

Then in the `use.kind === 'group'` branch, give the group wrapper the clip it used to inherit from the enclosing wrapper. Change:

```ts
      const attrs = [`opacity="${fmt(use.alpha)}"`, `style="${style.join(';')}"`];
```

to:

```ts
      const attrs = [`opacity="${fmt(use.alpha)}"`, `style="${style.join(';')}"`];
      attrs.push(...this.clipAttrs());
```

The `softmask` branch needs no change: its `<g mask="url(#id)">` stays open and the leaves drawn inside it carry their own clip attributes.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/svgrender.test.ts test/svg-transparency.test.ts test/svg-golden.test.ts`

Expected: PASS, all three files.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck` — expected: no output (clean).

Run: `npx vitest run` — expected: 1 failed (`test/pkcs12.test.ts`, the known environmental `u75` failure), everything else green. Any other failure is yours: the most likely is an unbalanced `<g>` from `restore()`, or a fixture whose clip is now missing because a paint site did not get `clipAttrs()`.

- [ ] **Step 9: Commit**

```bash
git add src/svgrender.ts test/svgrender.test.ts
git commit -m "fix(svg): emit clips as leaf attributes, not wrapper groups (7wg)"
```

---

### Task 3: Regenerate the goldens and commit the new one

**Files:**
- Create: `test/fixtures/svg/non-isolated-blend-group.png`
- Modify: `test/fixtures/svg/PROVENANCE.md`

**Interfaces:**
- Consumes: the emitter change from Task 2 and the fixture registered in Task 1.
- Produces: a committed golden, which activates a `non-isolated-blend-group` block in `test/svg-golden.test.ts` automatically (it enumerates fixtures with a committed PNG).

- [ ] **Step 1: Regenerate**

```bash
npx tsx scripts/gen-svg-goldens.ts
```

Expected: `15 golden(s) written, 0 skipped.`

- [ ] **Step 2: Verify that nothing moved**

Run: `git status --short test/fixtures/svg/`

Expected: exactly one line, `?? test/fixtures/svg/non-isolated-blend-group.png`.

**This is the load-bearing check in the whole plan.** The emitted markup changed substantially, so the 14 pre-existing goldens coming back byte-identical is what proves the refactor changed representation and not rendering. If any of them shows as modified, stop and diff it — a changed golden means the clip refactor altered output somewhere, and committing the new bytes would silently bless a regression.

- [ ] **Step 3: Run the golden suite**

Run: `npx vitest run test/svg-golden.test.ts`

Expected: PASS, with three more tests than before (the new fixture's block).

- [ ] **Step 4: Move the entry from Divergences to Covers**

In `test/fixtures/svg/PROVENANCE.md`:

1. Add the golden's row to the `## Goldens` table, after the `isolated-blend-group.png` row. Take the size/maxDelta/failFraction/SHA verbatim from the generator's printed row — do not hand-write them.
2. Retitle the divergence section added in Task 1 from `### Non-isolated groups render isolated — FIX IN PROGRESS` to `### Non-isolated groups render isolated — FIXED`, and replace its final paragraph with:

```markdown
Fixed in `svgrender.ts`: clips are now attributes on the leaves they clip rather
than wrapper elements. Each clip is defined as a `<clipPath>` chained onto the
enclosing one — SVG intersects a `<clipPath>` with its own `clip-path` — so
nesting composes without any element between a blending leaf and the page.
Regenerating after the fix left the other 14 goldens byte-identical, which is
what shows the change altered representation and not rendering.
```

3. In `## Covers`, add:

```markdown
- **Non-isolated groups** (`non-isolated-blend-group`): that a group without
  `/I true` lets its contents' blend reach the page backdrop, and that our clip
  markup puts no stacking context in the way. Paired with `isolated-blend-group`,
  which is the same fixture isolated — the two differ only in `/I`, so together
  they discriminate isolation rather than merely exercising it.
```

4. In `## Does NOT cover`, delete the bullet beginning `- **Non-isolated groups and knockout groups.**` and replace it with:

```markdown
- **Knockout groups** (`/K true`) — unimplemented in both backends.
- **Backdrop removal** for non-isolated groups (ISO 32000-1 §11.4.6) in the
  raster backend: `ToImage` draws them inline, which is exact at alpha 1 with a
  Normal group blend and an approximation otherwise
  (`aspose-pdf-foss-for-ts-bbu`).
```

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/svg/non-isolated-blend-group.png test/fixtures/svg/PROVENANCE.md
git commit -m "test(svg): commit the non-isolated-blend-group golden (7wg)"
```

---

### Task 4: Mutation checks

A green first run is not evidence. Break each mechanism, confirm the suite catches it, revert. Every mutation is reverted before the task ends — verify with `git diff --stat src/`, which must print nothing.

**Files:**
- Modify: `test/fixtures/svg/PROVENANCE.md` (mutation table rows only)

- [ ] **Step 1: Mutation A — restore the clip wrapper**

In `pushClip`, insert these two lines between the `addDef` call and `this.clipStack.push(id)`:

```ts
    this.w.emit(`<g clip-path="url(#${id})">`);
    this.groupDepth++;
```

Run: `npx tsx scripts/gen-svg-goldens.ts`

Expected: `SKIP non-isolated-blend-group: engines agree with each other but not with PDF semantics`. Revert.

- [ ] **Step 2: Mutation B — break the chain**

In `pushClip`, replace `const chain = parent ? ... : '';` with `const chain = '';`.

Run: `npx vitest run test/svgrender.test.ts`

Expected: FAIL on `'chains nested clipPaths, and leaves carry the innermost id'`.

Then run: `npx tsx scripts/gen-svg-goldens.ts` — expected: `tiling-pattern-offset-clip` skips, its outside-the-clip probes now painting the pattern. Revert.

- [ ] **Step 3: Mutation C — drop the leaf attribute**

In `clipAttrs`, `return [];` unconditionally.

Run: `npx vitest run test/svgrender.test.ts` — expected: FAIL on the leaf-attribute assertions.

Then run: `npx tsx scripts/gen-svg-goldens.ts` — expected: `tiling-pattern-offset-clip` skips (clipping gone entirely). Revert.

- [ ] **Step 4: Mutation D — let a capture inherit the clip**

In `beginOffscreen`, keep the save but drop the reset — that is, replace

```ts
    this.clipSaves.push(this.clipStack);
    this.clipStack = [];
```

with

```ts
    this.clipSaves.push(this.clipStack);
```

so the capture goes on seeing the enclosing clip.

Run: `npx vitest run test/svgrender.test.ts` — expected: FAIL on `'does not bake the active clip into a tiling pattern cell'`.

Then run: `npx tsx scripts/gen-svg-goldens.ts` — expected: `tiling-pattern-offset-clip` skips, in-cell probes reading white because each cell is clipped to a region it lies outside of. Revert.

- [ ] **Step 5: Confirm every mutation is reverted**

Run: `git diff --stat src/`

Expected: **no output**. Then `npx tsx scripts/gen-svg-goldens.ts` once more and confirm `15 golden(s) written, 0 skipped.` with `git status --short test/fixtures/svg/` clean.

- [ ] **Step 6: Record the results**

Add these rows to the mutation table in `test/fixtures/svg/PROVENANCE.md`, and correct any expectation that did not match what you actually observed — the table records measurements, not predictions:

```markdown
| `pushClip` emits a `<g clip-path>` wrapper again (the original bug) | **caught** — `non-isolated-blend-group` skipped, both engines painting the isolated result |
| `pushClip` stops chaining onto the enclosing clip | **caught** — `tiling-pattern-offset-clip` skipped, outside-the-clip probes painting the pattern |
| `clipAttrs` returns nothing, so leaves are unclipped | **caught** — `tiling-pattern-offset-clip` skipped; clipping gone entirely |
| `beginOffscreen` lets a capture inherit the active clip | **caught** — `tiling-pattern-offset-clip` skipped, in-cell probes white: each cell clipped to a region it lies outside |
```

- [ ] **Step 7: Commit and close**

```bash
git add test/fixtures/svg/PROVENANCE.md
git commit -m "docs(render): record clip-isolation mutation checks (7wg)"
```

Then update the tracker and push:

```bash
bd close aspose-pdf-foss-for-ts-7wg --reason @'
Clips are now attributes on the leaves they clip, chained via <clipPath
clip-path=...> instead of wrapper <g>s, so no clip-induced stacking context sits
between a blending leaf and the page. non-isolated-blend-group skipped before
the fix (both engines painting the isolated result) and is committed after.

The 14 pre-existing goldens regenerated byte-identical, which is what shows the
refactor changed representation rather than rendering. Four mutations recorded
in PROVENANCE.md, all caught.

Still unverified: isolation:isolate itself stays redundant in our output, since
an isolated group keeps a wrapper — needs a group with no BBox clip. Raster
backdrop removal for non-isolated groups remains open as bbu.
'@
git pull --rebase
git push
git status   # MUST show up to date with origin
```

`aspose-pdf-foss-for-ts-bbu` stays open — it keeps the raster half (ISO 32000-1 §11.4.6 backdrop removal, via rendering the group twice to obtain the group-only alpha α_gn). Nothing in this plan blocks or unblocks it.
