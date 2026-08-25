# Isolated Group Inner-Blend Buffering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an isolated transparency group whose contents use a blend mode composite against the group's own transparent backdrop rather than the page, and prove `isolation="isolate"` is load-bearing in our SVG output.

**Architecture:** Add a resource-tree scan (`groupContentBlends`) to `src/pagerender.ts` that answers "do this form's contents blend?", and OR it into the existing `needsBuffer` predicate so the offscreen path triggers at alpha 1. Only the isolated branch changes; non-isolated groups still draw inline. Then add a fixture whose isolated and non-isolated answers differ, and register it with the golden harness.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-07-21-isolated-group-blend-design.md`

## Global Constraints

- Import specifiers carry the `.js` extension (e.g. `import { Page } from './page.js'`).
- No npm runtime dependencies. `node:zlib`, `node:crypto`, `node:fs` only.
- Issue tracking is **bd (beads)**, not TodoWrite or markdown TODO lists.
- `npm run typecheck` and `npm test` must both be green before closing an issue.
- Repo rule: **prove assertions load-bearing by mutation.** A test that passes on
  its first run is not evidence. Break the code path, confirm red, revert.
- Repo rule: a differential test must not run both sides through the same code.
- Fixtures are built programmatically by builders in `test/helpers/`.
- Blend-mode names resolve through `blendModeFromName` (`src/blend.ts`), which
  maps `Compatible` and unrecognized names to `Normal`.

---

### Task 1: Buffer isolated groups whose contents blend

**Files:**
- Modify: `src/pagerender.ts` (add `groupContentBlends`; extend `needsBuffer` at ~line 608)
- Modify: `test/helpers/build-transparency-fixtures.ts` (add `isolatedBlendGroupPdf`)
- Test: `test/raster-transparency.test.ts`

**Interfaces:**
- Consumes: `blendModeFromName` from `./blend.js`; `isDict`, `isName`, `isArray`, `isStream`, `PdfObject`, `PdfStream` from `./types.js`; `MAX_OFFSCREEN_DEPTH` (already exported, `src/pagerender.ts:73`). All are already imported in `pagerender.ts` — no import changes needed.
- Produces: `groupContentBlends(doc: Document, stream: PdfStream, seen?: Set<PdfObject>, depth?: number): boolean` (module-private to `pagerender.ts`). `isolatedBlendGroupPdf(isolated?: boolean): Uint8Array` exported from `test/helpers/build-transparency-fixtures.ts`, used by Task 2.

- [ ] **Step 1: Add the fixture builder**

Append to `test/helpers/build-transparency-fixtures.ts`:

```ts
/** 200×200 page: a yellow backdrop, then an ISOLATED transparency group at
 *  ca 1.0 whose contents Multiply a cyan square over it.
 *
 *  Isolated, the blend sees the group's transparent backdrop and is a no-op, so
 *  the group composites Normal onto the page and the square reads pure cyan
 *  (0,255,255). Drawn non-isolated — or inline, which is what an unbuffered
 *  group amounts to — the multiply sees the yellow page instead:
 *  cyan × yellow = (0,255,0). The two answers differ in a saturated channel, so
 *  antialiasing cannot blur one into the other.
 *
 *  `isolated` is a parameter so the tests can assert the fixture discriminates
 *  rather than passing for an unrelated reason. */
export function isolatedBlendGroupPdf(isolated = true): Uint8Array {
  const inner = flate('q /GSM gs 0 1 1 rg 50 50 100 100 re f Q');
  const form = {
    dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] `
      + `/Group << /S /Transparency /I ${isolated} /CS /DeviceRGB >> `
      + `/Resources << /ExtGState << /GSM << /Type /ExtGState /BM /Multiply >> >> >> `
      + `/Filter /FlateDecode /Length ${inner.length} >>`,
    raw: inner,
  };
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: '<< /XObject << /Fm0 5 0 R >> >>',
    content: '1 1 0 rg 0 0 200 200 re f /Fm0 Do',
    extra: { 5: form },
  });
}
```

- [ ] **Step 2: Write the failing tests**

Append to `test/raster-transparency.test.ts`. Add `isolatedBlendGroupPdf` to the
existing import from `./helpers/build-transparency-fixtures.js`:

```ts
describe('Page.ToImage — isolated group with an inner blend mode', () => {
  it('blends against the group backdrop, not the page', () => {
    const p = decodePng(Document.Open(isolatedBlendGroupPdf(true)).Pages[0].ToImage());
    expect(p.at(100, 100).slice(0, 3)).toEqual([0, 255, 255]);  // pure cyan
    expect(p.at(20, 20).slice(0, 3)).toEqual([255, 255, 0]);    // page backdrop
  });

  // Proves the assertion above is not vacuous: if isolation were ignored, both
  // cases would read green and the fixture would verify nothing.
  it('blends against the page when the group is not isolated', () => {
    const p = decodePng(Document.Open(isolatedBlendGroupPdf(false)).Pages[0].ToImage());
    expect(p.at(100, 100).slice(0, 3)).toEqual([0, 255, 0]);    // cyan × yellow
  });
});
```

- [ ] **Step 3: Run the tests to verify the first one fails**

Run: `npx vitest run test/raster-transparency.test.ts`

Expected: `blends against the group backdrop, not the page` FAILS with received
`[0, 255, 0]` instead of `[0, 255, 255]`. The non-isolated test PASSES already —
that is the point: today both cases produce the non-isolated answer.

- [ ] **Step 4: Add the detection function**

Insert into `src/pagerender.ts` immediately above the function containing the
`needsBuffer` predicate (the form-XObject draw path, ~line 594):

```ts
/** Does this form's content use a non-Normal blend mode? An isolated group that
 *  blends internally needs an offscreen buffer even at alpha 1, because the
 *  blend must see the group's transparent backdrop rather than the page.
 *
 *  Scans the resource tree rather than parsing content: cheap, and done once per
 *  form. It over-triggers when an ExtGState declares a blend that is never used,
 *  which costs only a buffer — whereas under-triggering silently blends against
 *  the wrong backdrop. */
function groupContentBlends(
  doc: Document, stream: PdfStream, seen = new Set<PdfObject>(), depth = 0,
): boolean {
  if (depth > MAX_OFFSCREEN_DEPTH || seen.has(stream)) return false;   // resource cycles
  seen.add(stream);
  const res = doc.resolve(stream.dict.get('Resources'));
  if (!isDict(res)) return false;

  const egs = doc.resolve(res.get('ExtGState'));
  if (isDict(egs)) {
    for (const v of egs.values()) {
      const g = doc.resolve(v);
      if (!isDict(g)) continue;
      const bm = doc.resolve(g.get('BM'));
      // Same shape as applyExtGState: a name, or an array whose first name wins.
      const name = isName(bm) ? bm
        : isArray(bm) ? bm.map((x) => doc.resolve(x)).find((x) => isName(x))
        : undefined;
      if (isName(name) && blendModeFromName(name.name) !== 'Normal') return true;
    }
  }

  const xo = doc.resolve(res.get('XObject'));
  if (isDict(xo)) {
    for (const v of xo.values()) {
      const s = doc.resolve(v);
      if (!isStream(s)) continue;
      const st = doc.resolve(s.dict.get('Subtype'));
      if (isName(st) && st.name === 'Form'
        && groupContentBlends(doc, s, seen, depth + 1)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 5: Wire it into the buffering predicate**

In `src/pagerender.ts`, replace:

```ts
  const needsBuffer = isolated
    && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined)
    && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

with:

```ts
  const needsBuffer = isolated
    && (gs.fillAlpha < 1 || gs.blend !== 'Normal' || gs.softMask !== undefined
      || groupContentBlends(ctx.doc, stream))
    && ctx.depth < MAX_OFFSCREEN_DEPTH;
```

Also update the comment block above it. Replace the sentence:

```
  // A transparency group needs its own buffer only when compositing it as a unit
  // differs from drawing it inline — i.e. when group alpha, a blend mode, or a
  // soft mask applies. At alpha 1 / Normal / no mask the results are identical,
```

with:

```
  // A transparency group needs its own buffer only when compositing it as a unit
  // differs from drawing it inline — i.e. when group alpha, a blend mode, or a
  // soft mask applies. "A blend mode" means either one in force at `Do` time or
  // one used *inside* the group: an inner blend must see the group's own
  // transparent backdrop, so an isolated group that blends internally needs the
  // buffer even at alpha 1. At alpha 1 / Normal / no inner blend / no mask the
  // results are identical,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/raster-transparency.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 7: Prove the fix is load-bearing by mutation**

Temporarily delete `|| groupContentBlends(ctx.doc, stream)` from the predicate.

Run: `npx vitest run test/raster-transparency.test.ts`
Expected: `blends against the group backdrop, not the page` goes RED with
`[0, 255, 0]`.

**Revert the mutation** and re-run to confirm green before continuing.

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`

Expected: typecheck clean; all tests pass. Isolated groups that previously drew
inline now allocate a buffer, so if any existing golden or raster expectation
moves, **stop and report it** — do not adjust the expectation to match new
output. A shift means the fix changed a case it was not meant to.

- [ ] **Step 9: Commit**

```bash
git add src/pagerender.ts test/helpers/build-transparency-fixtures.ts test/raster-transparency.test.ts
git commit -m "fix(render): buffer isolated groups whose contents blend (vp8)

needsBuffer tested gs.blend, the blend mode in force outside the group at
Do time. A blend used inside the group did not appear in it, so the group
drew inline and its contents blended against the page backdrop — exactly
the non-isolated behaviour the group was declared to prevent. Isolated
and non-isolated output was measurably identical.

groupContentBlends scans the form's resource tree (ExtGState /BM,
recursing into nested form XObjects, with a cycle guard) rather than
parsing content. It over-triggers on a declared-but-unused ExtGState,
which costs a buffer; under-triggering would be silent wrong pixels.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Assert the SVG markup and register the golden fixture

**Files:**
- Modify: `test/svg-transparency.test.ts`
- Modify: `test/helpers/svg-golden-fixtures.ts`

**Interfaces:**
- Consumes: `isolatedBlendGroupPdf(isolated?: boolean)` from Task 1; the `GoldenFixture` interface and `Probe` type already in `test/helpers/svg-golden-fixtures.ts`.
- Produces: a `GOLDEN_FIXTURES` entry named `isolated-blend-group`, consumed by `test/svg-golden.test.ts` once a golden PNG exists.

- [ ] **Step 1: Write the failing SVG markup test**

Append to `test/svg-transparency.test.ts`. Add `isolatedBlendGroupPdf` to the
existing import from `./helpers/build-transparency-fixtures.js`:

```ts
describe('Page.ToSvg — isolated group with an inner blend mode', () => {
  it('emits isolation="isolate" at full opacity, where it is load-bearing', () => {
    const svg = Document.Open(isolatedBlendGroupPdf(true)).Pages[0].ToSvg();
    // opacity="1" creates no stacking context on its own, so isolation is the
    // only thing keeping the inner multiply off the page backdrop. This is the
    // case the isolated-group fixture could not produce — there, ca 0.5 forced
    // an implicit stacking context and made the attribute redundant.
    expect(svg).toMatch(/<g opacity="1" isolation="isolate">/);
    expect(svg).toContain('mix-blend-mode:multiply');
  });
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx vitest run test/svg-transparency.test.ts`
Expected: PASS — Task 1 made the group take the offscreen path, which is what
emits the `isolation="isolate"` wrapper.

If it FAILS with no match, Task 1's predicate is not firing for this fixture;
return to Task 1 rather than weakening this assertion.

- [ ] **Step 3: Register the fixture with the golden harness**

In `test/helpers/svg-golden-fixtures.ts`, add `isolatedBlendGroupPdf` to the
import from `./build-transparency-fixtures.js`, add the two colour constants
beside the existing `W` and `BLUE`:

```ts
const CYAN = [0, 255, 255] as [number, number, number];
const YELLOW = [255, 255, 0] as [number, number, number];
```

and append this entry to the `GOLDEN_FIXTURES` array:

```ts
  {
    name: 'isolated-blend-group',
    pdf: () => isolatedBlendGroupPdf(true),
    width: 200, height: 200,
    probes: [
      // Isolated, the inner multiply sees a transparent backdrop and is a
      // no-op. Drawn against the page it would read (0,255,0).
      { x: 100, y: 100, rgb: CYAN, note: 'inner blend sees the group backdrop, not the page' },
      { x: 20, y: 20, rgb: YELLOW, note: 'page backdrop outside the group' },
    ],
  },
```

- [ ] **Step 4: Verify the golden harness skips it cleanly**

Run: `npx vitest run test/svg-golden.test.ts`

Expected: PASS. No `test/fixtures/svg/isolated-blend-group.png` exists, so the
`existsSync` filter at the top of the file skips it. The suite must not error on
the unregistered golden — confirm the run is green and the fixture simply does
not appear.

- [ ] **Step 5: Commit**

```bash
git add test/svg-transparency.test.ts test/helpers/svg-golden-fixtures.ts
git commit -m "test(svg): assert isolation=isolate where it is load-bearing (vp8)

The isolated-group fixture draws at ca 0.5, where SVG group opacity
already forces an implicit stacking context and isolation=isolate is
redundant. isolated-blend-group runs at opacity 1, where the attribute
is the only thing keeping the inner multiply off the page backdrop.

Registered in GOLDEN_FIXTURES; no golden PNG yet (needs Chrome + resvg
out of band, otk), so svg-golden.test.ts skips it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Correct the provenance record and close the issue

**Files:**
- Modify: `test/fixtures/svg/PROVENANCE.md` (Mutation checks table + the `isolation="isolate" is not verified` subsection + the "Does NOT cover" bullet)
- Modify: `CLAUDE.md` (rendering bullet, ~line 207)

**Interfaces:**
- Consumes: nothing. Documentation only.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the Mutation checks table**

In `test/fixtures/svg/PROVENANCE.md`, in the table under `## Mutation checks`,
replace the row:

```
| `isolation="isolate"` removed from the group | **NOT caught** — see below |
```

with:

```
| `isolation="isolate"` removed from the group | **not caught by `isolated-group`** (ca 0.5 makes it redundant) — `isolated-blend-group` now exercises it at opacity 1, but has no golden yet; see below |
```

- [ ] **Step 2: Rewrite the `isolation="isolate" is not verified` subsection**

Replace the whole `### isolation="isolate" is not verified` subsection body with:

```markdown
`aspose-pdf-foss-for-ts-vp8`. Deleting `isolation="isolate"` from `svgrender.ts`
produced a byte-identical `isolated-group.png`, because `isolatedGroupPdf` draws
its group at `ca 0.5` — SVG group opacity below 1 already forces an implicit
stacking context, so the attribute is redundant there. `isolation` only has an
observable effect at alpha 1 with a blend mode inside the group.

Investigating that turned up a renderer bug rather than a fixture gap. The
buffering predicate in `pagerender.ts` tested `gs.blend`, the blend mode in force
*outside* the group when `Do` ran; a blend used inside the group did not appear
in it, so the group drew inline and blended against the page. Isolated and
non-isolated output were measurably identical (`0,255,0` for both, where isolated
should be `0,255,255`). Fixed by `groupContentBlends`, a resource-tree scan that
triggers the offscreen path when a group's contents blend.

`isolated-blend-group` is the fixture that exercises it: an isolated group at
`ca 1.0` whose contents Multiply cyan over a yellow page. Isolated reads
`(0,255,255)`; non-isolated reads `(0,255,0)`.

**No golden is committed for it yet** — that needs Chrome and resvg out of band
(`aspose-pdf-foss-for-ts-otk`). In-tree, `test/raster-transparency.test.ts`
covers the compositing (including a non-isolated case proving the fixture
discriminates) and `test/svg-transparency.test.ts` asserts the attribute is
emitted at `opacity="1"`. Those show our two backends agree and that the markup
is what we intend. They **cannot** show that a real SVG engine honours
`isolation` the way we assume — which is the whole reason the goldens exist.
```

- [ ] **Step 3: Update the "Does NOT cover" bullet**

Replace:

```
- **The `isolation="isolate"` attribute.** Proven decorative by mutation; see
  below. `aspose-pdf-foss-for-ts-vp8`.
```

with:

```
- **The `isolation="isolate"` attribute.** Now load-bearing in our output rather
  than decorative (see Mutation checks), but browser-unverified: no golden is
  committed for `isolated-blend-group`. `aspose-pdf-foss-for-ts-otk`.
```

- [ ] **Step 4: Record the invariant in CLAUDE.md**

In the rendering bullet of `CLAUDE.md` (the `svgrender.ts`, `raster.ts`,
`pagerender.ts` entry), append:

```
  **Invariant:** an isolated transparency group whose *contents* use a blend mode
  needs an offscreen buffer even at alpha 1. The buffering predicate reads the
  graphics state at `Do` time, which cannot see an inner blend; miss this and the
  group draws inline and blends against the page backdrop — silently producing
  the non-isolated result for a group declared `/I true`.
```

- [ ] **Step 5: Verify the whole suite once more**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit, close the issue, and push**

```bash
git add test/fixtures/svg/PROVENANCE.md CLAUDE.md
git commit -m "docs: record the isolated-group blend fix and what stays unverified (vp8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-vp8 --reason "Fixed the underlying renderer bug (needsBuffer ignored blend modes inside the group) and added isolated-blend-group, which exercises isolation=isolate at opacity 1. Browser golden still pending under otk."
git add .beads/
git commit -m "chore(bd): close vp8

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git pull --rebase
git push
git status  # MUST show "up to date with origin"
```

- [ ] **Step 7: Note the golden dependency on otk**

Run:

`--append-notes` adds to the existing notes rather than replacing them, so this
will not clobber anything already recorded on `otk`:

```bash
bd update aspose-pdf-foss-for-ts-otk --append-notes "Also needs a golden for isolated-blend-group (added under vp8): isolated group at ca 1.0 with an inner Multiply, isolated (0,255,255) vs non-isolated (0,255,0)."
git add .beads/
git commit -m "chore(bd): note the isolated-blend-group golden on otk

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Detection via resource scan, `blendModeFromName`, array form, cycle guard, depth cap | Task 1 Step 4 |
| Rejected alternatives (content parse, always buffer) | Design rationale only — no task needed |
| Wiring into `needsBuffer`, isolated branch only | Task 1 Step 5 |
| Fixture `isolatedBlendGroupPdf`, colour choice | Task 1 Step 1 |
| `GOLDEN_FIXTURES` registration with both probes | Task 2 Step 3 |
| Raster tests: isolated cyan + discriminating non-isolated case | Task 1 Step 2 |
| SVG test: `isolation="isolate"` at `opacity="1"` | Task 2 Step 1 |
| Mutation proof | Task 1 Step 7 |
| PROVENANCE.md: mutation table, subsection, Does-NOT-cover | Task 3 Steps 1–3 |
| Risk: existing goldens may shift | Task 1 Step 8 (report, don't absorb) |

**Placeholder scan:** none. Every code step carries complete code; every run step
carries an exact command and expected output. Task 3 Step 7 originally hedged on
the `bd` flag set; `bd update --help` was checked and `--append-notes` confirmed,
so the step is now unconditional.

**Type consistency:** `groupContentBlends(doc, stream, seen?, depth?)` is called
as `groupContentBlends(ctx.doc, stream)` in Step 5, matching the defaults.
`isolatedBlendGroupPdf(isolated = true)` is called as `(true)` and `(false)` in
tests and `() => isolatedBlendGroupPdf(true)` in the fixture entry — all
consistent with the declared signature. The fixture `name` is
`isolated-blend-group` in every reference.
