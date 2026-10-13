# XFA `lr-tb` mixed-height wrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay out an XFA `lr-tb` flow that wraps after a line of mixed heights, and stop applying a container's `min*` when its parent flows, so DoD DD 1391 and DD 1155 convert every body field onto Adobe's rects.

**Architecture:** Two changes in `src/xfaflow.ts`'s `Engine`. `flowLrTb` drops its mixed-heights refusal and advances a wrap by the tallest item on the line (the loop already holds it as `lineH`). The engine records every node's parent layout once per call (`index`), and `measure` skips the `min*` floor for a container whose parent is `tb` or `lr-tb`. `measureExtent` gains a `parentLayout` argument, and `xfapage.ts` passes `'tb'`, so pagination measures a root child exactly as layout will.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-12-xfa-lrtb-mixed-heights-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- `npm run typecheck` and `npm test` must both be green before the issue closes.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (no new catches are planned).
- CHANGELOG entries go under `## [Unreleased]`, bold lead-in, prose, issue id `(aspose-pdf-foss-for-ts-bkdi)` at the end.
- The rule's scope is exactly: a CONTAINER (any non-leaf node) whose PARENT's layout is `tb` or `lr-tb` does not apply `minW`/`minH`. Leaves, `position` parents, `table` and `row` parents keep the floor. `max*` is enforced everywhere.
- Measured during design: with EVERY container's `minH` dropped, no oracle in the suite (f1040, fw9, I-130, I-765, OPM 1644 pdf.js goldens) moved. Only unit tests asserting the old rule failed. If an oracle reddens in this plan, stop and report: that contradicts the design's evidence.

## Review Focus

1. A page-level subform with `minH` above its content, in a body content area: pagination and layout must agree on its height. Held by the `layoutPages` case in Task 2.
2. A container with `minH` inside a `position` subform that is itself inside a `tb` flow: the floor applies (the parent is `position`). Held by the "positioned parent" case in Task 2.
3. A text-measured leaf with `minH` in a flow keeps its floor. Already held by `test/xfaflow-measure.test.ts`'s "applies minH and minW as floors under tb and row parents too"; Task 3's mutation M5 confirms it is load-bearing.
4. A container whose content exceeds `maxH` inside a flow is still refused. Held by the existing "refuses content past maxH" half of Task 2's rewritten tb case.
5. A wrap whose tallest item is neither first nor last on the line. Task 1's fixture puts it in the middle, so the first, last and shortest rivals each fail it.

---

### Task 1: The wrap below the tallest item

**Files:**
- Modify: `src/xfaflow.ts` (`flowLrTb`, currently around lines 448-492)
- Test: `test/xfaflow.test.ts` (the `layoutPage: lr-tb` describe, the "refuses a wrap after a line of mixed heights" case around line 278-285)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports; `flowLrTb` behaviour only.

- [ ] **Step 1: Replace the refusal test with the new rule's test**

In `test/xfaflow.test.ts`, replace this block:

```ts
  // The spec's "immediately below it" does not say below what when the line's
  // heights differ, so that wrap refuses rather than picks.
  it('refuses a wrap after a line of mixed heights', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '20pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect(why(m, 'c')).toMatch(/mixed heights/);
  });
```

with:

```ts
  // bkdi: p. 281's "immediately below it" leaves open below WHAT once a line's
  // heights differ. Adobe's rects (DD 1155) put the next line below the TALLEST
  // item. The tallest here, b, is neither first nor last nor shortest, so each
  // of those rivals fails this case.
  it('wraps a line of mixed heights below its tallest item', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('L', 'lr-tb', { w: '35pt' }, [
        fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '10pt', h: '25pt' }),
        fld('c', { w: '10pt', h: '15pt' }), fld('d', { w: '30pt', h: '10pt' }),
      ]),
      fld('e', S),
    ])]));
    expect(box(m, 'd')).toEqual({ x: 0, y: 25, w: 30, h: 10 });
    // The container is as tall as its lines: 25 + 10.
    expect(box(m, 'e').y).toBe(35);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/xfaflow.test.ts -t "below its tallest item"`
Expected: FAIL, thrown `d: …wraps after a line of mixed heights…`.

- [ ] **Step 3: Implement**

In `src/xfaflow.ts`, replace `flowLrTb`'s doc comment and body with:

```ts
  /** XFA 3.3 p. 281: each child "immediately to the right of the nominal extent
   *  of the previous object, or if this fails immediately below it aligned with
   *  the left edge". A child on the same line keeps the line's top. With no
   *  stated `w` the container is growable in width and never wraps.
   *
   *  "Below it" leaves open below WHAT once a line's heights differ. Adobe's own
   *  rects settle it (bkdi, DoD DD 1155): the next line starts below the TALLEST
   *  item on the line, where the first, the last and the shortest each miss. */
  private flowLrTb(n: LayoutNode, kids: LayoutNode[], m: Insets, out: Slots): void {
    const sw = stated(n, 'w');
    const width = typeof sw === 'number' ? sw - m.l - m.r : Infinity;
    const avail = this.available(n, m);
    let x = 0;
    let y = 0;
    let lineH = 0;
    let broken: Fail | undefined;
    for (const c of kids) {
      if (broken) { out.set(c, after(broken)); continue; }
      const size = this.flowSize(c);
      if (isFail(size)) { out.set(c, size); broken = size; continue; }
      if (x > 0 && x + size.w > width + EPS) {
        y += lineH;
        x = 0;
        lineH = 0;
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
    }
  }
```

(The `line` array existed only for the refusal; it goes with it.)

- [ ] **Step 4: Run the file**

Run: `npx vitest run test/xfaflow.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/xfaflow.ts test/xfaflow.test.ts
git commit -m "feat(bkdi): lr-tb wraps a line of mixed heights below its tallest item

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A container's `min*` is not applied in a flowed parent

**Files:**
- Modify: `src/xfaflow.ts` (`Engine`: new `parentOf` map and `index` method; `measure`; `grow`; `layoutPage`; `measureExtent`)
- Modify: `src/xfapage.ts` (`layoutPages`, the `measureExtent` call around line 318)
- Test: `test/xfaflow.test.ts` (rewrite the tb minH case around line 205; new describe; new `measureExtent` case)
- Test: `test/xfapage.test.ts` (new case in the `layoutPages` describe)

**Interfaces:**
- Consumes: Task 1's `flowLrTb`.
- Produces:
  - `measureExtent(n: LayoutNode, limit: number, measure?: XfaMeasure, warnings: string[] = [], parentLayout?: string): { h: number; past: boolean } | { reason: string }`. The new fifth argument is the layout of `n`'s parent, `undefined` when it has none.
  - `Engine.index(n: LayoutNode, parent?: string): void` (internal).
  - `Engine.grow(n, minKey, maxKey, fixed, content, floor = true)` (internal).

- [ ] **Step 1: Rewrite the old tb minH case and add the new cases**

In `test/xfaflow.test.ts`, the tb case "raises a growable extent to minH, honours maxH="0" as none, and refuses content past maxH" puts its container under a `tb` parent, where the floor no longer applies. Change only its first third, so `G` sits under a `position` subform that itself flows in `T`:

```ts
  it('raises a growable extent to minH, honours maxH="0" as none, and refuses content past maxH', () => {
    // G's own parent is positioned (P), where minH is a floor; P flows in T.
    const grown = layoutPage(page([sub('T', 'tb', {}, [
      sub('P', 'position', {}, [
        sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { minH: '50pt' } }),
      ]),
      fld('b', S),
    ])]));
    expect(box(grown, 'b').y).toBe(50);
```

Leave the `zero` and `clipped` halves as they are: `maxH` is still enforced in a flow.

Then add, after the `layoutPage: lr-tb` describe:

```ts
// bkdi: Adobe does not apply a container's min* when its parent flows. DoD
// DD 1155's `thirty` is an lr-tb subform in an lr-tb whose minH="8.89mm" wraps
// 8.128mm of content; Adobe starts the next line at 8.128mm. pdf.js agrees.
// Leaves and positioned parents keep 164g.7's floor.
describe('layoutPage: min* on a container in a flow (bkdi)', () => {
  const G = (minMax: { minW?: string; minH?: string }): LayoutNode =>
    sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax });

  it('does not apply a container minH under a tb parent', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [G({ minH: '50pt' }), fld('b', S)])]));
    expect(box(m, 'b').y).toBe(30);
  });

  it('does not apply a container minH under an lr-tb parent', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '15pt' }, [G({ minH: '50pt' }), fld('b', S)])]));
    expect(box(m, 'b')).toEqual({ x: 0, y: 30, w: 10, h: 10 });
  });

  it('does not apply a container minW under a flowed parent', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [G({ minW: '40pt' }), fld('b', S)])]));
    expect(box(m, 'b').x).toBe(10);
  });

  it('still applies a container minH under a positioned parent', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('P', 'position', {}, [G({ minH: '50pt' })]),
      fld('b', S),
    ])]));
    expect(box(m, 'b').y).toBe(50);
  });
});
```

In the `measureExtent (164g.3)` describe, add:

```ts
  // bkdi: the parent's layout decides whether a container's min* applies, so a
  // caller measuring a node out of its tree says what its parent is.
  it('applies a container minH only when the parent does not flow', () => {
    const g = sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { minH: '50pt' } });
    expect(measureExtent(g, 100)).toEqual({ h: 50, past: false });
    expect(measureExtent(g, 100, undefined, [], 'position')).toEqual({ h: 50, past: false });
    expect(measureExtent(g, 100, undefined, [], 'tb')).toEqual({ h: 30, past: false });
  });
```

In `test/xfapage.test.ts`, inside the `layoutPages` describe (it defines `fld`, `S`, `placedBox` and `caAt`), add:

```ts
  // bkdi: a root child is laid out in the content area's tb flow, so its
  // container min* does not apply -- and pagination must measure it the same
  // way, or it moves Q to a second page that layout never needed.
  it('measures a root child as the content area tb flow lays it out', () => {
    const g: LayoutNode = {
      kind: 'subform', label: 'G', layout: 'tb', geom: { w: '100pt' },
      children: [fld('a', { w: '10pt', h: '30pt' })], minMax: { minH: '300pt' },
    };
    const r = layoutPages(body([area([caAt(100)])], [g, kid('Q', 20, { children: [fld('b', S)] })]));
    expect(r.refused.size).toBe(0);
    expect(r.pages.map((p) => p.pageArea)).toEqual([0]);
    expect(placedBox(r.pages[0].placed, 'b')).toEqual({ x: 10, y: 50, w: 10, h: 10 });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfaflow.test.ts test/xfapage.test.ts`
Expected: FAIL on the five cases that expect the floor dropped: tb, lr-tb, minW, `measureExtent` with `'tb'` (vitest strips types, so the not-yet-declared fifth argument does not stop it running), and the `layoutPages` case. The positioned-parent case and the rewritten tb case already pass, since the floor applies everywhere today.

- [ ] **Step 3: Implement in `src/xfaflow.ts`**

Near `LAID_OUT` (module level), add:

```ts
/** The parent layouts under which a container's `min*` is not applied (bkdi):
 *  Adobe lays such a container out at its content size. */
const FLOWS: ReadonlySet<string> = new Set(['tb', 'lr-tb']);
```

In `class Engine`, after `private readonly sizes = new Map<LayoutNode, Size | Fail>();`, add:

```ts
  /** Each node's parent layout, recorded once by `index`. `measure` is memoized
   *  per node and cannot see its parent, so it reads the parent from here. */
  private readonly parentOf = new Map<LayoutNode, string>();

  /** Record the layout every node under `n` is laid out in. `parent` is `n`'s
   *  own parent's layout, when the caller knows one. */
  index(n: LayoutNode, parent?: string): void {
    if (parent !== undefined) this.parentOf.set(n, parent);
    const lay = n.layout ?? 'position';
    for (const c of n.children) this.index(c, lay);
  }
```

In `measure`, replace:

```ts
    const width = this.grow(n, 'minW', 'maxW', w, c.w + m.l + m.r);
    if (isFail(width)) return width;
    const height = this.grow(n, 'minH', 'maxH', h, c.h + m.t + m.b);
```

with:

```ts
    // bkdi: in a flowed parent Adobe lays a container out at its content size,
    // its min* unapplied (DoD DD 1155's `thirty`); max* still bounds it.
    const floor = !FLOWS.has(this.parentOf.get(n) ?? '');
    const width = this.grow(n, 'minW', 'maxW', w, c.w + m.l + m.r, floor);
    if (isFail(width)) return width;
    const height = this.grow(n, 'minH', 'maxH', h, c.h + m.t + m.b, floor);
```

Change `grow`'s doc comment, signature and floor line to:

```ts
  /** One axis of a growable extent. Content past a stated maximum would be
   *  clipped, which is not modelled. `floor` false skips the minimum (bkdi). */
  private grow(
    n: LayoutNode, minKey: 'minW' | 'minH', maxKey: 'maxW' | 'maxH',
    fixed: number | undefined, content: number, floor = true,
  ): number | Fail {
    if (fixed !== undefined) return fixed;
    const lim = this.limits(n, minKey, maxKey);
    if (isFail(lim)) return lim;
    const v = Math.max(content, floor ? lim.min ?? 0 : 0);
```

(the rest of `grow` unchanged). `measureLeaf`'s two `grow` calls are NOT changed: leaves keep the floor.

In `layoutPage`, after `const engine = new Engine(bottom, measure, warnings);`, add:

```ts
  engine.index(root);
```

Replace `measureExtent` with:

```ts
export function measureExtent(
  n: LayoutNode, limit: number, measure?: XfaMeasure, warnings: string[] = [], parentLayout?: string,
): { h: number; past: boolean } | { reason: string } {
  const engine = new Engine(undefined, measure, warnings);
  engine.index(n, parentLayout);
  const e = engine.extent(n);
  if (isFail(e)) return { reason: e.reason };
  return { h: e.h, past: engine.inkBottom(n) > limit + EPS };
}
```

and add one sentence to its doc comment: "`parentLayout` is the layout `n` is laid out in, which decides whether a container's `min*` applies (bkdi)."

- [ ] **Step 4: Implement in `src/xfapage.ts`**

In `layoutPages`, replace:

```ts
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, measure, []));
```

with:

```ts
  // A root child is laid out in its content area's tb flow (xfatemplate builds
  // every body content area with layout tb), so it is measured as one: a
  // container's min* does not apply there (bkdi), and pagination and layout
  // must agree on its height.
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, measure, [], 'tb'));
```

- [ ] **Step 5: Run the XFA suite**

Run: `npx vitest run test/xfaflow test/xfapage test/xfa`
Expected: PASS everywhere, oracles included. If any oracle file (`xfa-real`, `xfa-dynamic-oracle`, `xfa-master-oracle`, `xfa-flow*`) reddens, stop and report (Global Constraints).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/xfaflow.ts src/xfapage.ts test/xfaflow.test.ts test/xfapage.test.ts
git commit -m "feat(bkdi): a container's min* is not applied in a flowed parent, as Adobe lays it out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The DD oracle, the mutation sweep, and the docs

**Files:**
- Test: `test/xfa-real.test.ts` (new describe, after the `master-page fields, against Adobe (d3mq)` describe)
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `test/fixtures/xfa/PROVENANCE.md`

**Interfaces:**
- Consumes: Tasks 1 and 2; the file's own `load`, `stripAcroFields`, `rectOf`, `adobePage`.
- Produces: nothing.

- [ ] **Step 1: Add the oracle**

Append to `test/xfa-real.test.ts`:

```ts
// bkdi: DoD DD forms flow their bodies as lr-tb lines of mixed heights. Every
// field lands on Adobe's rect only under both rules: the next line below the
// TALLEST item, and a container's min* unapplied in a flowed parent (DD 1155's
// `thirty`). Each rival reddens DD 1155: the last item 84/87, the first 85/87,
// min* applied 80/84 with page 1 overflowing.
describe('lr-tb bodies of mixed heights, against Adobe (bkdi)', () => {
  for (const [file, count] of [['dod-dd1391.pdf', 62], ['dod-dd1155.pdf', 87]] as const) {
    it(`${file}: places all ${String(count)} fields on Adobe's page and rect`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields.map((f) =>
        [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.skipped.map((s) => s.reason).filter((r) => /mixed heights|164g\.8/.test(r))).toEqual([]);
      let compared = 0;
      let exact = 0;
      for (const f of report.fields) {
        if (f.route !== 'positioned') continue;
        const want = adobe.get(f.name);
        if (!want || want.length !== 4) continue;
        expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
        const got = rectOf(doc, f.name);
        compared += 1;
        if (Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i]))) <= 0.01) exact += 1;
      }
      expect(compared, 'fields compared').toBe(count);
      expect(exact, 'exact').toBe(count);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/xfa-real.test.ts`
Expected: PASS, both new cases (62 and 87; these counts were measured during design and include the master-page instances).

- [ ] **Step 3: Mutation sweep**

Apply each mutation ALONE to the committed code, run the named files, record red/green, then restore with `git checkout -- src/`. Before each run, confirm the mutation applied (`git diff --stat src/` non-empty). Judge by vitest's exit status and the FAIL lines with ANSI stripped, never by a "passed" line alone, and treat a timeout or a file that fails to load as NOT green.

| # | Mutation | Run | Expected |
|---|---|---|---|
| M1 | In `flowLrTb`, wrap below the LAST item: add `let lastH = 0;`, set `lastH = size.h;` after `lineH = Math.max(...)`, and use `y += lastH;` | `test/xfaflow.test.ts test/xfa-real.test.ts` | red: Task 1 case, DD 1155 oracle |
| M2 | Wrap below the FIRST item: `let firstH = 0;`, set `if (x === 0) firstH = size.h;` before placing, use `y += firstH;` | same | red: Task 1 case, DD 1155 oracle |
| M3 | `const floor = true;` in `measure` | `test/xfaflow.test.ts test/xfapage.test.ts test/xfa-real.test.ts` | red: tb, lr-tb, minW and `measureExtent` bkdi cases, the `layoutPages` case, DD 1155 oracle |
| M4 | `FLOWS` holds only `'lr-tb'` | `test/xfaflow.test.ts test/xfapage.test.ts` | red: tb case, `measureExtent` case, `layoutPages` case |
| M5 | Extend the rule to leaves: in `measureLeaf` pass `!FLOWS.has(this.parentOf.get(n) ?? '')` as `grow`'s `floor` for both axes | `test/xfaflow-measure.test.ts` | red: "applies minH and minW as floors under tb and row parents too" |
| M6 | `xfapage.ts` calls `measureExtent(n, limit, measure, [])` (no `'tb'`) | `test/xfapage.test.ts` | red: the `layoutPages` bkdi case |
| M7 | Delete `engine.index(root);` from `layoutPage` | `test/xfaflow.test.ts` | red: tb, lr-tb and minW bkdi cases |

If any mutation stays green, do NOT weaken it: add the case that reddens it, or, if it is provably equivalent, record it as such in CLAUDE.md (Step 5) with the reason.

- [ ] **Step 4: CHANGELOG**

In `CHANGELOG.md` under `## [Unreleased]`, add at the top of the first `### Fixed` section:

```markdown
- **`ConvertXfaToAcroForm` left nearly every body field of a DoD DD form without a widget.** These forms flow their bodies as `lr-tb` lines whose items differ in height, and the layout engine refused any line that wrapped after one, because XFA 3.3 says the next line goes "immediately below" without saying below what. DD 1391 lost 60 of its 62 fields and DD 1155 86 of 90. The next line now starts below the tallest item on the line, which is what Adobe's own rects show: converted from the template alone, all 62 and all 87 positioned fields land on Adobe's page and rect, where wrapping below the first, the last or the shortest item misses. (aspose-pdf-foss-for-ts-bkdi)
```

and at the top of the first `### Changed` section:

```markdown
- **An XFA container's `minW`/`minH` is no longer applied when its parent flows.** A subform, area or exclusion group inside a `tb` or `lr-tb` parent is laid out at its content size, its stated minimum ignored; `max*` still bounds it, and leaves and positioned parents keep the minimum as a floor. This reverses part of what 164g.7 shipped, which read XFA 3.3 p. 276 as "a floor everywhere". Adobe does otherwise: DoD DD 1155's `thirty` states `minH="8.89mm"` around 8.128mm of content inside an `lr-tb`, and Adobe starts the next line at 8.128mm. Applying the minimum puts four fields 2.16pt low and page 1 1.8pt past its content area. pdf.js agrees with Adobe. No other vendored oracle moved. (aspose-pdf-foss-for-ts-bkdi)
```

- [ ] **Step 5: CLAUDE.md**

1. In the `xfaflow.ts` entry (the `(164g.1)` paragraphs), find the sentence listing what refuses: "a shape it leaves open REFUSES: a non-left `hAlign` in a flow, an `lr-tb` wrap after a line of mixed heights, a `-1` column…". Delete "an `lr-tb` wrap after a line of mixed heights, ". After that `**Invariant:**` paragraph add:

```markdown
  **Invariant (`bkdi`):** an `lr-tb` wrap starts the next line below the
  TALLEST item on the line. p. 281's "immediately below it" leaves open below
  what; Adobe's rects for DoD DD 1155 settle it, where the first, the last and
  the shortest item each miss. A container is as tall as its lines.
  **Invariant (`bkdi`):** a CONTAINER whose parent's layout is `tb` or `lr-tb`
  does not apply `minW`/`minH`; `max*` still bounds it, and leaves, `position`
  parents and table rows/cells keep the floor. DD 1155's `thirty` (an `lr-tb`
  in an `lr-tb`, `minH` 8.89mm around 8.128mm) is the evidence, the only
  container in six hybrids whose minimum binds. `measure` is memoized per node,
  so the engine records each node's parent layout once (`index`), and
  `measureExtent` takes the parent's layout as an argument -- `xfapage.ts`
  passes `'tb'`, or pagination and layout disagree about a root child's height.
```

Append any equivalent mutant from Task 3 Step 3 to that paragraph as a `**Note, measured:**`.

2. In the `xfarich.ts`, `xfatext.ts`, `xfafont.ts` entry, replace "`min*`/`max*` are the engine's, a floor and ceiling in every parent layout (p. 276)" with "`min*`/`max*` are the engine's, a floor and ceiling in every parent layout (p. 276) -- except a CONTAINER's `min*` in a flowed parent, which `bkdi` found Adobe does not apply".


- [ ] **Step 6: PROVENANCE**

In `test/fixtures/xfa/PROVENANCE.md`, at the end of the `## DoD DD 1391 and DD 1155 (d3mq)` section, add:

```markdown
Since `bkdi` they also anchor BODY layout. Both bodies flow as `lr-tb` lines of
mixed heights, which the engine refused until then. Converted from the template
alone, all 62 (DD 1391) and 87 (DD 1155) positioned fields land on Adobe's page
and rect (`test/xfa-real.test.ts`). They settled two rules the specification
leaves open: the next line starts below the TALLEST item on the line, and a
container's `min*` is not applied in a flowed parent (DD 1155's `thirty`). DD 1391
alone cannot tell the tallest item from the last or the first; DD 1155 can.
```

- [ ] **Step 7: Full gates**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: all files pass.

- [ ] **Step 8: Commit**

```bash
git add test/xfa-real.test.ts CHANGELOG.md CLAUDE.md test/fixtures/xfa/PROVENANCE.md
git commit -m "test(bkdi): DD 1391 and DD 1155 bodies against Adobe; CHANGELOG, CLAUDE.md, PROVENANCE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Close out

- [ ] **Step 1: File the follow-up**

```bash
bd create --title "Vendor DoD DD 1610 and DD 2952 as multi-page XFA master-field oracles" --type task --priority 3 --parent aspose-pdf-foss-for-ts-164g --description "d3mq could not use DD 1610 and DD 2952 (3 pages each) as multi-page master-page-field oracles: their lr-tb bodies laid out 1 page against 3, refused at the mixed-heights wrap. bkdi lays that wrap out. Vendor both (https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/, US federal works), check they paginate to 3 pages, and add them to the master-field oracle in test/xfa-real.test.ts. Discovered from bkdi."
bd dep add $NEW aspose-pdf-foss-for-ts-bkdi --type discovered-from   # $NEW = the id bd create printed
```

- [ ] **Step 2: Close and push**

```bash
bd close aspose-pdf-foss-for-ts-bkdi --reason "lr-tb wraps below the tallest item; a container's min* is not applied in a flowed parent. DD 1391 62/62 and DD 1155 87/87 on Adobe's rects."
git pull --rebase
git push
git status
```

Expected: `git status` reports up to date with origin.
