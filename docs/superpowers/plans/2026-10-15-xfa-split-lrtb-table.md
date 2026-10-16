# XFA: split an `lr-tb` between items and a table between rows — Implementation Plan (`164g.12`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ConvertXfaToAcroForm` splits an `lr-tb` subform between its items and a table between its rows across content areas, as Adobe Reader 26.1 does, and every split fragment carries both of its container's margins.

**Architecture:** 164g.8's atom/unit flattening in `src/xfapage.ts` is replaced by LEAVES: each region builds a fragment tree (shallow copies of the containers holding that region's leaves, both margins kept, a table's whole-table column widths pinned) and decides fit by MEASURING that fragment through the existing `XfaHeight` callback. Three layout callbacks (`boxes`, `columns`, `topOf`) reach `xfapage.ts` through one `XfaPaginateHooks` object built by `layoutHooks(measure)`, so `xfapage.ts` stays a pure leaf over `xfaflow.js`. `xfaflow.ts` gains one export, `tableColumnWidths`, recorded by `table()` itself so widths keep one owner.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-xfa-split-lrtb-table-design.md` (read it before Task 1; the probe table and rules 1-7 are cited by number below).

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- ESM + NodeNext: every relative import ends in `.js`.
- `src/xfapage.ts` stays a pure leaf over `xfaflow.js`, `xfageom.js` and `xfasplitpos.js`; it never throws. What it cannot paginate is refused BY NAME.
- No new `catch` blocks. (If one becomes unavoidable, its first statement is `rethrowLimit(e)` — `test/limits-catch.test.ts` enforces it.)
- `npm run typecheck` and `npm test` must both be green before the issue closes.
- CHANGELOG entries go under `## [Unreleased]` in the same commit as the user-visible change.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do NOT re-run `scripts/gen-*` or `scripts/run-xfa-adobe-probe.ps1`; the probes are vendored as they are.
- Do NOT re-record any oracle golden (DD 1494, OPM 1644, hybrids, t3-t26, q1-q15). A fence going red is investigated and reported, not refreshed.
- Use `bd` for tracking, never TodoWrite or markdown TODO lists.

## Review Focus

1. **Text-measured items in a split `lr-tb`** (no stated `w`/`h`): fit (`height`) and the straddle test (`topOf`) must measure with the SAME measurer, or an item fits by one and straddles by the other. `layoutPages` passes the one memoized measurer to both (Task 3, Step 7); DD 1494 is the fence (Task 4, Step 5).
2. **A hidden (`presence="hidden"`) item leading a split container**: it must wait for the first visible item and ride into whichever region that item lands in, never become a fragment holding only margins (a hidden item after visible ones joins their region, as in 164g.8). Pinned in Task 3's "no fragment holds only margins" case.
3. **A long table** (hundreds of rows): re-measuring per leaf must stay linear in CALLS (each call lays out one region). Pinned by Task 3's cost case, which counts `height` calls.
4. **A row whose cell is a field that would straddle the cut**: rows never straddle; the row moves whole even when its field's piece above the cut reaches the font size (t29). Pinned in Task 3's table case.
5. **`-1` columns resolved per fragment**: the page-1 fragment must keep the width a LATER row sets (t30). Pinned in Task 3's `-1` case and by t30.

---

### Task 1: Vendor probes t27-t39

The 13 probes are already committed under transient names (`tN.out.pdf`, `tN.out.png`, `tN.xml`, commit `3fde071a`). This task renames them to the directory's convention, transcribes Adobe's numbers into `adobe.json`, extends the helper types, and records provenance. The probes are NOT yet wired into the oracle loop (Task 4 does that, after the implementation exists).

**Files:**
- Rename: `test/fixtures/xfa-adobe/tN.out.pdf` → `tN.pdf`, `tN.out.png` → `captures/tN.png`, for N = 27..39
- Modify: `test/fixtures/xfa-adobe/adobe.json` (13 new probes)
- Modify: `test/helpers/xfa-adobe.ts` (types + `SPLIT_PROBES`)
- Modify: `test/fixtures/xfa-adobe/PROVENANCE.md` (new section)
- Modify: `test/xfa-adobe-oracle.test.ts` (one fixture-integrity case)

**Interfaces:**
- Produces: `AdobeProbe.draws?: Record<string, AdobeFrag[]>`, `AdobeProbe.refusedUnder?: string` (dotted path, e.g. `'form1.flow'`), `SPLIT_PROBES: readonly string[]` (`t27`..`t39`). Task 4 consumes all three.

- [ ] **Step 1: File the child issue the refusal message will name**

The spec's rule 7 refuses a splittable subform item that straddles a cut "naming a new child issue". The id is needed in code (Task 3), so file it first:

```bash
bd create "XFA: split an lr-tb item that is itself a splittable subform straddling a content-area break" \
  --parent aspose-pdf-foss-for-ts-164g --type feature --priority 3 \
  --deps discovered-from:aspose-pdf-foss-for-ts-164g.12 \
  --description "164g.12 splits an lr-tb between its items and refuses an item that is itself a splittable subform (tb, lr-tb or table) when it straddles the cut. Adobe's behaviour for that shape is unprobed: probe it (scripts/gen-xfa-adobe-probes.ts), then split by the consensus the probe shows."
```

Expected: bd prints the new id, most likely `aspose-pdf-foss-for-ts-164g.25`. Everywhere this plan writes `164g.25`, use the short form of the id bd printed.

- [ ] **Step 2: Rename the files**

```bash
cd test/fixtures/xfa-adobe
for n in 27 28 29 30 31 32 33 34 35 36 37 38 39; do
  git mv t$n.out.pdf t$n.pdf
  git mv t$n.out.png captures/t$n.png
done
cd ../../..
git status --short test/fixtures/xfa-adobe | head
```

Expected: 26 rename lines (`R`), nothing else.

- [ ] **Step 3: Add the goldens to `adobe.json`**

Write this script to the scratchpad as `add-split-probes.mjs` and run it with `node <path>` from the repo root. It keeps the file's existing `JSON.stringify(_, null, 2)` shape. Every number is transcribed from `captures/tN.png`; the ONE derived entry is t29's `c4c` (its capture line is cut off below `c4b`; `r4` and `c4a`/`c4b` on the same capture confirm it).

```js
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'test/fixtures/xfa-adobe/adobe.json';
const g = JSON.parse(readFileSync(file, 'utf8'));
const W = 180, H = 60;
const ORACLE = { 'form1.oracle': [[1, 0, 0, 540, 216]], 'form1.filler': [[1, 0, 216, 540, 400]] };
const OUT = { 'form1.oracle.out': [[1, 0, 0, 540, 216]] };
const D0 = { 'form1.filler.d0': [[1, 0, 0, 72, 10]] };
/** Nine 180x60 items: page `p0` first line holds `onFirst` of them. */
const grid = (prefix, names, at) => Object.fromEntries(names.map((n, i) => [`${prefix}.${n}`, [at(i)]]));
const p = {};
p.t27 = {
  pages: 2, expect: 'refused', reason: '164g.13', refusedUnder: 'form1.flow',
  subforms: { ...ORACLE, 'form1.flow': [[1, 0, 616, 540, 104], [2, 0, 0, 540, 120]] },
  fields: {
    ...OUT,
    'form1.flow.f1': [[1, 0, 0, W, H]], 'form1.flow.f2': [[1, 180, 0, W, H]], 'form1.flow.f3': [[1, 360, 0, W, H]],
    'form1.flow.f4': [[1, 0, 60, W, 44], [2, 0, 0, W, 16]],
    'form1.flow.f5': [[2, 180, 0, W, H]], 'form1.flow.f6': [[2, 360, 0, W, H]],
    'form1.flow.f7': [[2, 0, 60, W, H]], 'form1.flow.f8': [[2, 180, 60, W, H]], 'form1.flow.f9': [[2, 360, 60, W, H]],
  },
};
p.t28 = {
  pages: 2, expect: 'refused', reason: '164g.13', refusedUnder: 'form1.flow',
  subforms: { ...ORACLE, 'form1.flow': [[1, 0, 616, 540, 104], [2, 0, 0, 540, 46]] },
  fields: {
    ...OUT,
    'form1.flow.a1': [[1, 0, 0, W, 40]], 'form1.flow.a2': [[1, 180, 0, W, 90]], 'form1.flow.a3': [[1, 360, 0, W, 40]],
    'form1.flow.b1': [[1, 0, 90, W, 10]], 'form1.flow.b2': [[1, 180, 90, W, 14], [2, 0, 0, W, 46]],
    'form1.flow.b3': [[2, 180, 0, W, 10]],
  },
};
const rowsOf = (tbl, w, rowPages, cellNames, colW) => {
  const subforms = { [tbl]: w };
  const fields = {};
  rowPages.forEach(([r, frag], i) => {
    subforms[`${tbl}.${r}`] = [frag];
    let x = 0;
    cellNames[i].forEach((c, k) => { fields[`${tbl}.${r}.${c}`] = [[frag[0], x, 0, colW[k], frag[4]]]; x += colW[k]; });
  });
  return { subforms, fields };
};
{
  const t = rowsOf('form1.tbl', [[1, 0, 616, 540, 60], [2, 0, 0, 540, 180]],
    [['r1', [1, 0, 0, 540, 60]], ['r2', [2, 0, 0, 540, 60]], ['r3', [2, 0, 60, 540, 60]], ['r4', [2, 0, 120, 540, 60]]],
    [['c1a', 'c1b', 'c1c'], ['c2a', 'c2b', 'c2c'], ['c3a', 'c3b', 'c3c'], ['c4a', 'c4b', 'c4c']], [180, 180, 180]);
  p.t29 = { pages: 2, expect: 'match', subforms: { ...ORACLE, ...t.subforms }, fields: { ...OUT, ...t.fields } };
}
{
  const t = rowsOf('form1.tbl', [[1, 0, 616, 450, 60], [2, 0, 0, 450, 120]],
    [['r1', [1, 0, 0, 450, 60]], ['r2', [2, 0, 0, 450, 60]], ['r3', [2, 0, 60, 450, 60]]],
    [['c1a', 'c1b'], ['c2a', 'c2b'], ['c3a', 'c3b']], [250, 200]);
  p.t30 = { pages: 2, expect: 'match', subforms: { ...ORACLE, ...t.subforms }, fields: { ...OUT, ...t.fields } };
}
p.t31 = {
  pages: 2, expect: 'refused', reason: '164g.13', refusedUnder: 'form1.outer',
  subforms: {
    ...ORACLE, 'form1.outer': [[1, 0, 616, 540, 104], [2, 0, 0, 540, 60]],
    'form1.outer.flow': [[1, 0, 30, 540, 74], [2, 0, 0, 540, 60]],
  },
  fields: {
    ...OUT, 'form1.outer.top': [[1, 0, 0, W, 30]],
    'form1.outer.flow.f1': [[1, 0, 0, W, H]], 'form1.outer.flow.f2': [[1, 180, 0, W, H]], 'form1.outer.flow.f3': [[1, 360, 0, W, H]],
    'form1.outer.flow.f4': [[1, 0, 60, W, 14], [2, 0, 0, W, 46]],
    'form1.outer.flow.f5': [[2, 180, 0, W, H]], 'form1.outer.flow.f6': [[2, 360, 0, W, H]],
  },
};
{
  const t = rowsOf('form1.outer.tbl', [[1, 0, 30, 360, 60], [2, 0, 0, 360, 120]],
    [['r1', [1, 0, 0, 360, 60]], ['r2', [2, 0, 0, 360, 60]], ['r3', [2, 0, 60, 360, 60]]],
    [['c1a', 'c1b'], ['c2a', 'c2b'], ['c3a', 'c3b']], [180, 180]);
  p.t32 = {
    pages: 2, expect: 'match',
    subforms: { ...ORACLE, 'form1.outer': [[1, 0, 616, 540, 90], [2, 0, 0, 540, 120]], ...t.subforms },
    fields: { ...OUT, 'form1.outer.top': [[1, 0, 0, W, 30]], ...t.fields },
  };
}
const nine = (names) => grid('form1.flow', names, (i) => [2, (i % 3) * 180, Math.floor(i / 3) * 60, W, H]);
p.t33 = {
  pages: 2, expect: 'match',
  subforms: { ...ORACLE, 'form1.flow': [[2, 0, 0, 540, 180]] },
  fields: { ...OUT, ...nine(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']) },
};
{
  const t = rowsOf('form1.tbl', [[2, 0, 0, 360, 180]],
    [['r1', [2, 0, 0, 360, 60]], ['r2', [2, 0, 60, 360, 60]], ['r3', [2, 0, 120, 360, 60]]],
    [['c1a', 'c1b'], ['c2a', 'c2b'], ['c3a', 'c3b']], [180, 180]);
  p.t34 = { pages: 2, expect: 'match', subforms: { ...ORACLE, ...t.subforms }, fields: { ...OUT, ...t.fields } };
}
/** Three on page 1's line, six on page 2's two lines. */
const split9 = (prefix, names) => grid(prefix, names,
  (i) => (i < 3 ? [1, i * 180, 0, W, H] : [2, ((i - 3) % 3) * 180, Math.floor((i - 3) / 3) * 60, W, H]));
p.t35 = {
  pages: 2, expect: 'match', insets: { 'form1.flow': [0, 20] },
  subforms: { ...ORACLE, 'form1.flow': [[1, 0, 616, 540, 100], [2, 0, 0, 540, 160]] },
  fields: { ...OUT, ...split9('form1.flow', ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']) },
};
{
  const t = rowsOf('form1.tbl', [[1, 0, 616, 360, 100], [2, 0, 0, 360, 160]],
    [['r1', [1, 0, 0, 360, 60]], ['r2', [2, 0, 0, 360, 60]], ['r3', [2, 0, 60, 360, 60]]],
    [['c1a', 'c1b'], ['c2a', 'c2b'], ['c3a', 'c3b']], [180, 180]);
  p.t36 = { pages: 2, expect: 'match', insets: { 'form1.tbl': [0, 20] }, subforms: { ...ORACLE, ...t.subforms }, fields: { ...OUT, ...t.fields } };
}
p.t37 = {
  pages: 2, expect: 'match',
  subforms: { ...ORACLE, 'form1.flow': [[1, 0, 616, 540, 100], [2, 0, 0, 540, 60]] },
  fields: { ...OUT },
  draws: {
    ...D0,
    'form1.flow.a1': [[1, 0, 0, W, 40]], 'form1.flow.a2': [[1, 180, 0, W, 90]], 'form1.flow.a3': [[1, 360, 0, W, 40]],
    'form1.flow.b1': [[1, 0, 90, W, 10]],
    'form1.flow.b2': [[2, 0, 0, W, 60]], 'form1.flow.b3': [[2, 180, 0, W, 10]], 'form1.flow.c1': [[2, 360, 0, W, 30]],
  },
};
p.t38 = {
  pages: 2, expect: 'match',
  subforms: { ...ORACLE, 'form1.flow': [[1, 0, 616, 540, 60], [2, 0, 0, 540, 120]] },
  fields: { ...OUT },
  draws: { ...D0, ...split9('form1.flow', ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']) },
};
p.t39 = {
  pages: 2, expect: 'match', insets: { 'form1.stack': [0, 20] },
  subforms: { ...ORACLE, 'form1.stack': [[1, 0, 616, 540, 100], [2, 0, 0, 540, 100]] },
  fields: { ...OUT },
  draws: {
    ...D0,
    'form1.stack.d1': [[1, 0, 0, W, 30]], 'form1.stack.d2': [[1, 0, 30, W, 30]],
    'form1.stack.d3': [[2, 0, 0, W, 30]], 'form1.stack.d4': [[2, 0, 30, W, 30]],
  },
};
for (const [k, v] of Object.entries(p)) g.probes[k] = v;
writeFileSync(file, `${JSON.stringify(g, null, 2)}\n`);
console.log('added', Object.keys(p).join(' '));
```

Expected output: `added t27 t28 t29 t30 t31 t32 t33 t34 t35 t36 t37 t38 t39`. Then `git diff --stat test/fixtures/xfa-adobe/adobe.json` shows only additions (if the file had no trailing newline before, one changed last line is acceptable).

Cross-check three values by hand against the captures before moving on: `t35` `form1.flow` page 2 height is 160; `t37` `form1.flow.b3` is `[2,180,0,180,10]`; `t30` `form1.tbl.r1.c1a` is `[1,0,0,250,60]`.

- [ ] **Step 4: Extend the helper types**

In `test/helpers/xfa-adobe.ts`, replace the `AdobeProbe` interface and add `SPLIT_PROBES` beside `ADOBE_PROBES`:

```ts
export interface AdobeProbe {
  pages: number;
  expect: 'match' | 'refused';
  /** The issue id a refused probe's reason cites. */
  reason?: string;
  /** The dotted path of the subform whose fields a refused probe refuses;
   *  `form1.pos` (164g.11's probes) when absent. */
  refusedUnder?: string;
  /** [left, top] content insets of a subform, by dotted path. */
  insets?: Record<string, [number, number]>;
  subforms: Record<string, AdobeFrag[]>;
  fields: Record<string, AdobeFrag[]>;
  /** Draws, by dotted path (164g.12): t37-t39 hold only draws, which have no
   *  widget, so they are compared through our layout rather than the PDF. */
  draws?: Record<string, AdobeFrag[]>;
}
```

```ts
/** The lr-tb and table splitting probes (164g.12). */
export const SPLIT_PROBES: readonly string[] = Array.from({ length: 13 }, (_, i) => `t${String(i + 27)}`);
```

- [ ] **Step 5: Write the fixture-integrity test**

Append to `test/xfa-adobe-oracle.test.ts` (import `SPLIT_PROBES` beside the existing helper imports):

```ts
// 164g.12: the lr-tb/table probes are vendored and transcribed; Task 4 of the
// plan wires them into the loop above once the engine splits them.
describe('Adobe oracle: the 164g.12 probes are vendored', () => {
  for (const name of SPLIT_PROBES) {
    it(`${name} has its bytes, its golden, and a dynamic template`, () => {
      const probe = g.probes[name];
      expect(probe, `${name} in adobe.json`).toBeDefined();
      expect(probe.pages).toBe(2);
      const doc = Document.Open(loadAdobeProbe(name));
      const acro = doc.resolve(doc.catalog().get('AcroForm'));
      expect(acro).toBeDefined();
    });
  }
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run test/xfa-adobe-oracle.test.ts`
Expected: PASS, the 13 new cases included, and the existing t3-t26 cases unchanged.

- [ ] **Step 7: Provenance**

Compute hashes:

```bash
cd test/fixtures/xfa-adobe; for n in 27 28 29 30 31 32 33 34 35 36 37 38 39; do sha256sum t$n.pdf; done; cd -
```

Append to `test/fixtures/xfa-adobe/PROVENANCE.md`:

```markdown
## lr-tb and table splitting probes (164g.12)

**Producer:** as above, 2026-10-14. Every probe holds the 216pt oracle field and
a 400pt positioned filler, leaving 104pt of a 720pt content area on page 1, then
the shape under test: an `lr-tb` of 180pt items, three to a 540pt line (t27,
t28, t33, t35, t37, t38), a table (t29, t30, t34, t36), a `tb` holding one of
those (t31, t32), or a `tb` of draws (t39). The spec's probe table
(`docs/superpowers/specs/2026-10-14-xfa-split-lrtb-table-design.md`) says what
each settled.

**Captures are uncropped.** `captures/t27.png`-`t39.png` are whole Reader
windows, not crops of the field. Only `t29`'s `c4c` is derived rather than read:
its line is cut off at the bottom of the field, and `r4`, `c4a` and `c4b` on the
same capture fix it at `2,360,0,180,60`.

**What Adobe overruled:** 164g.8 gave a split `tb` its top margin on the first
fragment and its bottom margin on the last; Adobe puts both on every fragment
(t35, t36, t39). DD 1494, 164g.8's oracle, has no margins on a split subform, so
it could not see this.

**Ceiling:** one producer, one version, hand transcription. Not covered: a field
split between its lines (t27, t28, t31 -- refused, 164g.13), an `lr-tb` item that
is itself a splittable subform straddling the cut (164g.25), repeated table
header rows (164g.15).

| File | SHA-256 |
|---|---|
| `t27.pdf` | `<sha256 from the command above>` |
```

…with one row per file t27..t39, each hash pasted from the `sha256sum` output (the cell holds the hash itself, not the placeholder text).

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/xfa-adobe test/helpers/xfa-adobe.ts test/xfa-adobe-oracle.test.ts
git commit -m "test(164g.12): vendor Adobe probes t27-t39 for lr-tb and table splitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Layout hooks — table column widths and an item's top

**Files:**
- Modify: `src/xfaflow.ts` (Engine records widths; export `tableColumnWidths`)
- Modify: `src/xfasplitpos.ts` (export `ptStr`, `fontSizeOf`, add `fieldSplitRefusal`)
- Modify: `src/xfapage.ts` (export `XfaPaginateHooks`, `layoutHooks`, `memoMeasure`; `paginate` takes hooks)
- Modify: `test/xfapage.test.ts:493` (one call site)
- Create: `test/xfapage-hooks.test.ts`

**Interfaces:**
- Produces (xfaflow): `tableColumnWidths(n: LayoutNode, measure?: XfaMeasure): number[] | { reason: string }`
- Produces (xfasplitpos): `ptStr(v: number): string`, `fontSizeOf(f: LayoutNode): number`, `fieldSplitRefusal(label: string): string`
- Produces (xfapage):
  ```ts
  export interface XfaPaginateHooks {
    boxes?: XfaChildBoxes;
    columns?: (n: LayoutNode) => number[] | { reason: string };
    topOf?: (root: LayoutNode, n: LayoutNode) => number | undefined;
  }
  export function layoutHooks(measure?: XfaMeasure): XfaPaginateHooks;
  export function memoMeasure(m: XfaMeasure): XfaMeasure;
  export function paginate(body: XfaBody, height: XfaHeight, hooks?: XfaPaginateHooks, force?: ReadonlyMap<number, number>): Pagination;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/xfapage-hooks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tableColumnWidths, type LayoutNode, type XfaMeasure } from '../src/xfaflow.js';
import { layoutHooks, memoMeasure } from '../src/xfapage.js';

const fld = (label: string, w: number, h: number): LayoutNode =>
  ({ kind: 'field', label, field: label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [] });
const drw = (label: string, w: number, h: number): LayoutNode =>
  ({ kind: 'draw', label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [] });
const row = (label: string, cells: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'row', geom: {}, children: cells });
const table = (label: string, cols: string, rows: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'table', columnWidths: cols, geom: {}, children: rows });

describe('tableColumnWidths (164g.12, rule 4)', () => {
  it('resolves -1 columns from every row and keeps stated ones', () => {
    const t = table('T', '-1 30pt', [row('r1', [fld('c1', 40, 10), fld('c2', 10, 10)]), row('r2', [fld('c3', 80, 10), fld('c4', 10, 10)])]);
    expect(tableColumnWidths(t)).toEqual([80, 30]);
  });
  it('names why a -1 column cannot be sized', () => {
    const t = table('T', '-1', [row('r1', [{ kind: 'subform', label: 'S', layout: 'tb', geom: {}, children: [] }])]);
    const w = tableColumnWidths(t);
    expect('reason' in w ? w.reason : '').toMatch(/column 1 has width -1 and no single-column cell/);
  });
});

describe('layoutHooks (164g.12)', () => {
  it('topOf: an lr-tb item on the second line sits below the first line', () => {
    const items = ['d1', 'd2', 'd3', 'd4'].map((n, i) => drw(n, 100, i === 1 ? 40 : 30));
    const flow: LayoutNode = { kind: 'subform', label: 'L', layout: 'lr-tb', geom: { w: '300pt' }, children: items,
      margin: { topInset: '5pt' } };
    expect(layoutHooks().topOf!(flow, items[3])).toBe(45);
    expect(layoutHooks().topOf!(flow, items[0])).toBe(5);
  });
  it('topOf: undefined for a node not under the root', () => {
    const flow: LayoutNode = { kind: 'subform', label: 'L', layout: 'lr-tb', geom: { w: '300pt' }, children: [drw('a', 10, 10)] };
    expect(layoutHooks().topOf!(flow, drw('b', 10, 10))).toBeUndefined();
  });
  it('columns: the same answer as tableColumnWidths', () => {
    const t = table('T', '-1', [row('r1', [fld('c1', 40, 10)]), row('r2', [fld('c2', 70, 10)])]);
    expect(layoutHooks().columns!(t)).toEqual([70]);
  });
});

describe('memoMeasure', () => {
  it('measures a node once per box', () => {
    let calls = 0;
    const m: XfaMeasure = () => { calls += 1; return { w: 1, h: 2 }; };
    const mm = memoMeasure(m);
    const n = drw('a', 1, 1);
    mm(n, { width: 10 }); mm(n, { width: 10 }); mm(n, { width: 20 });
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfapage-hooks.test.ts`
Expected: FAIL — `tableColumnWidths`, `layoutHooks` and `memoMeasure` are not exported.

- [ ] **Step 3: Record a table's widths in `xfaflow.ts`**

In `class Engine`, beside `private readonly tables = new Map<LayoutNode, Size>();`:

```ts
  /** A table's resolved column widths, set by `table()` (164g.12): a split
   *  table's fragments keep the WHOLE table's widths, and this is their one owner. */
  private readonly widths = new Map<LayoutNode, number[]>();
  columnWidthsOf(n: LayoutNode): number[] | undefined { return this.widths.get(n); }
```

In `table()`, immediately before `const tableW = sum(widths);` add:

```ts
    this.widths.set(n, widths);
```

After `measureExtent`, add the export:

```ts
/** A table's column widths as `table()` resolves them -- `-1` columns from
 *  every row (XFA 3.3 p. 327-329) -- or why they cannot be. Pagination pins a
 *  split table's fragments to these (164g.12, Adobe probe t30). */
export function tableColumnWidths(n: LayoutNode, measure?: XfaMeasure): number[] | { reason: string } {
  const engine = new Engine(undefined, measure, []);
  engine.index(n);
  const slots = engine.arrange(n);
  const w = engine.columnWidthsOf(n);
  if (w !== undefined) return w;
  const f = [...slots.values()].find(isFail);
  return { reason: f?.reason ?? `${n.label}: its column widths could not be resolved` };
}
```

- [ ] **Step 4: Export the shared helpers in `xfasplitpos.ts`**

Change `const ptStr` and `const fontSizeOf` to `export const`, and add below `fontSizeOf`:

```ts
/** R4 (t6, t9-t11, t20; 164g.12's t27, t28, t31): Adobe splits a field
 *  straddling a content-area break between its lines; that is 164g.13's. */
export const fieldSplitRefusal = (label: string): string =>
  `${label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)`;
```

and in `positionedCut` replace the inline refusal string with `return { refusal: fieldSplitRefusal(k.node.label) };`.

- [ ] **Step 5: Add the hooks to `xfapage.ts`**

Update the imports:

```ts
import {
  layoutPage, measureExtent, insetsOf, positionedChildBoxes, tableColumnWidths, SPLIT_LATER,
  type LayoutNode, type Placed, type PlacedNode, type XfaBreak, type XfaMeasure,
} from './xfaflow.js';
import { measureToPt, type XfaMedium } from './xfageom.js';
import {
  fieldSplitRefusal, fontSizeOf, positionedCut, positionedFragment, positionedSplittable, ptStr,
  type XfaChildBoxes,
} from './xfasplitpos.js';
```

After `export type XfaHeight = ...` add:

```ts
/** The layout callbacks pagination splits with (164g.11, 164g.12). Each one
 *  missing narrows what splits, never fails: without `boxes` no positioned
 *  subform splits; without `columns` a table fragment keeps its stated
 *  `columnWidths`; without `topOf` a straddling lr-tb item moves. */
export interface XfaPaginateHooks {
  /** A positioned container's children as pagination sees them. */
  boxes?: XfaChildBoxes;
  /** A table's whole-table column widths (rule 4, t30). */
  columns?: (n: LayoutNode) => number[] | { reason: string };
  /** `n`'s top within `root` once `root` is laid out, in points (rule 7). */
  topOf?: (root: LayoutNode, n: LayoutNode) => number | undefined;
}

/** A measurer that measures each node once per box: a split re-measures its
 *  region after every leaf, which must lay containers out again but measure no
 *  text twice (164g.12). */
export function memoMeasure(m: XfaMeasure): XfaMeasure {
  const cache = new Map<LayoutNode, Map<string, ReturnType<XfaMeasure>>>();
  return (n, box) => {
    let c = cache.get(n);
    if (!c) { c = new Map(); cache.set(n, c); }
    const k = JSON.stringify(box);
    let v = c.get(k);
    if (v === undefined) { v = m(n, box); c.set(k, v); }
    return v;
  };
}

/** The hooks over `xfaflow.ts`, for one measurer. `topOf` lays `root` out on a
 *  probe page, since leaves under a flow are only placed when a content-area
 *  bottom bounds them. */
export function layoutHooks(measure?: XfaMeasure): XfaPaginateHooks {
  return {
    boxes: (n) => positionedChildBoxes(n, measure),
    columns: (n) => tableColumnWidths(n, measure),
    topOf: (root, n) => {
      const nodes: PlacedNode[] = [];
      layoutPage({ kind: 'page', label: 'probe', layout: 'tb', geom: { h: '100000pt' }, children: [root] }, measure, [], nodes);
      const r = nodes.find((x) => x.node === root);
      const k = nodes.find((x) => x.node === n);
      return r && 'box' in r && k && 'box' in k ? k.box.y - r.box.y : undefined;
    },
  };
}
```

Change `paginate`, `terminate` and `paginateOnce` to take `hooks: XfaPaginateHooks` where they took `boxes?: XfaChildBoxes`:

```ts
export function paginate(
  body: XfaBody, height: XfaHeight, hooks: XfaPaginateHooks = {}, force?: ReadonlyMap<number, number>,
): Pagination {
  const first = paginateOnce(body, height, hooks, force);
  const rel = body.pageSet?.relation;
  if (force || (rel !== 'simplexPaginated' && rel !== 'duplexPaginated')) return first;
  return terminate(body, height, hooks, first);
}
```

In `terminate`, rename the parameter `boxes: XfaChildBoxes | undefined` to `hooks: XfaPaginateHooks` and call `paginateOnce(body, height, hooks, new Map([[k, a]]))`. In `paginateOnce`, rename the parameter `boxes?: XfaChildBoxes` to `hooks: XfaPaginateHooks` and change the positioned branch to:

```ts
      if (hooks.boxes && positionedSplittable(c)) {
        // 164g.11: a keep-none positioned root child splits where Adobe does.
        const why = placePositioned(p, c, r.h, hooks.boxes);
```

In `layoutPages` replace the `paginate(...)` call with:

```ts
  const m = measure && memoMeasure(measure);
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, m, [], 'tb'), layoutHooks(m));
```

and pass `m` (not `measure`) to the `layoutPage(...)` call in the same function.

The `fieldSplitRefusal`, `fontSizeOf` and `ptStr` imports are used in Task 3; the tsconfigs do not set `noUnusedLocals`, so they typecheck now.

- [ ] **Step 6: Update the one caller passing `boxes`**

In `test/xfapage.test.ts`, the `run` helper of the 164g.11 describe block:

```ts
  const run = (kids: LayoutNode[], b = body([area([ca(720)])], kids)) => paginate(b, posHeight, { boxes: posBoxes });
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/xfapage-hooks.test.ts test/xfapage.test.ts test/xfaflow.test.ts test/xfasplitpos.test.ts`
Expected: PASS. Then `npm run typecheck` — expected clean.

- [ ] **Step 8: Commit**

```bash
git add src/xfaflow.ts src/xfasplitpos.ts src/xfapage.ts test/xfapage-hooks.test.ts test/xfapage.test.ts
git commit -m "refactor(164g.12): layout hooks for splitting -- table widths, an item's top

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Split by measuring the region

Replaces 164g.8's atoms with leaves and fit-by-measuring (spec §3), widens `splittable` to `lr-tb` and `table` (§2), puts both margins on every fragment (rule 3), and adds the straddle test (rule 7).

**Files:**
- Modify: `src/xfapage.ts:143-226` (`splittable`, `Atom`/`Unit`/`flatten`/`unitsOf`/`innerBreak`), `:427-468` (Paginator fragment code), `:528-594` (`placeSplit`), the `placeSplit` call in `paginateOnce`
- Modify: `src/xfaflow.ts:47` (`SPLIT_LATER` text)
- Modify: `test/xfapage.test.ts` (helpers, the margin case, new cases)
- Modify: `test/xfaflow.test.ts:229,372,586` (the `SPLIT_LATER` text)

**Interfaces:**
- Consumes: `XfaPaginateHooks`, `layoutHooks`, `ptStr`, `fontSizeOf`, `fieldSplitRefusal` (Task 2).
- Produces: `splittable(n)` true for `tb`, `lr-tb`, `table`; refusal texts
  - `${label}: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)`
  - `fieldSplitRefusal(label)` for a straddling field
  - `SPLIT_LATER = 'splitting a field between its lines or a subform beyond its children (164g.13, 164g.19)'`

- [ ] **Step 1: Update the test helpers**

In `test/xfapage.test.ts`:

1. Make the mock's `past` look through a fragment — a fragment copies its container's label, so the old leaf-label test can no longer see a `!` leaf inside it:

```ts
/** A node's height: a stated h, else its margins plus its children's heights.
 *  A node with a label ending in '!' anywhere below it draws past any limit. */
const bang = (n: LayoutNode): boolean => n.label.endsWith('!') || n.children.some(bang);
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: bang(n) });
```

2. Widen `shape` so lr-tb and table fragments print what they hold:

```ts
const SPLITS = new Set(['tb', 'lr-tb', 'table']);
const shape = (n: LayoutNode): string =>
  (SPLITS.has(n.layout ?? '') && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
```

3. Add the real-layout helpers (after `splitRefusals`):

```ts
// 164g.12: lr-tb and table fragments are measured by the real engine.
import { measureExtent } from '../src/xfaflow.js';   // move into the import block at the top
import { layoutHooks } from '../src/xfapage.js';     // ditto
const real: XfaHeight = (n, limit) => measureExtent(n, limit, undefined, [], 'tb');
const realRun = (b: XfaBody) => paginate(b, real, layoutHooks());
const realSplit = (b: XfaBody) => realRun(b).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const realRefusals = (b: XfaBody) => [...realRun(b).refused].map(([n, w]) => [n.label, w]);
const fldN = (label: string, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [], ...extra });
const drwN = (label: string, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [], ...extra });
const lrtb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'lr-tb', geom: { w: '300pt' }, children, ...extra });
const rowN = (label: string, cells: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'row', geom: {}, children: cells });
const tableN = (label: string, cols: string, rows: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'table', columnWidths: cols, geom: {}, children: rows, ...extra });
const draws = (n: number, w = 100, h = 30): LayoutNode[] =>
  Array.from({ length: n }, (_, i) => drwN(`d${String(i + 1)}`, w, h));
```

(Put the two `import` lines with the existing imports; vitest hoists nothing here.)

- [ ] **Step 2: Rewrite the 164g.8 margin case and add the new cases**

Replace the case `'keeps the bottom margin with the last child'` with:

```ts
  // 164g.12, rule 3 (Adobe t35, t36, t39): every fragment carries BOTH margins.
  it('gives every fragment both margins', () => {
    const t = tb('T', [kid('a', 40), kid('b', 40), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    const r = paginate(body([area([ca(100)])], [t]), flowHeight);
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a,b)', '0:T(c)']);
    const [f1, f2] = r.pages.map((p) => p.contentAreas[0].children[0]);
    expect([f1.margin?.topInset, f1.margin?.bottomInset]).toEqual(['10pt', '10pt']);
    expect([f2.margin?.topInset, f2.margin?.bottomInset]).toEqual(['10pt', '10pt']);
  });

  // 164g.8 checked page 1's room without the bottom margin, so b fitted there.
  it('reserves the bottom margin on the first page (t39)', () => {
    const t = tb('T', [kid('a', 40), kid('b', 45), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a)', '0:T(b,c)']);
  });
```

Then add a new describe block after the 164g.8 block:

```ts
// 164g.12: an lr-tb splits between its items and a table between its rows,
// from the room left, as Adobe Reader does (probes t27-t39).
describe('paginate: splitting an lr-tb between items and a table between rows (164g.12)', () => {
  // t37: b3 would fit beside b1, but the first item that does not fit ends the
  // fragment; the rest re-packs from the left on the next page.
  it('cuts at the first item that does not fit and re-packs the rest from x = 0', () => {
    const L = lrtb('L', [drwN('a1', 100, 20), drwN('a2', 100, 40), drwN('a3', 100, 20),
      drwN('b1', 100, 5), drwN('b2', 100, 30), drwN('b3', 100, 5), drwN('c1', 100, 10)]);
    const b = body([area([ca(100)])], [kid('A', 50), L]);
    expect(realSplit(b)).toEqual(['0:A,L(a1,a2,a3,b1)', '0:L(b2,b3,c1)']);
    const p2 = layoutPages(b).pages[1].nodes;
    const at = (label: string) => p2.find((x) => x.node.label === label && 'box' in x) as { box: { x: number; y: number } };
    expect([at('b3').box.x, at('b3').box.y]).toEqual([100, 0]);
    expect([at('c1').box.x, at('c1').box.y]).toEqual([200, 0]);
  });

  // t27/t28/t31 against t35: a field straddling the cut is split by Adobe when its
  // piece above the cut reaches its font size (164g.13 -- refused), moved otherwise.
  it('refuses a straddling field whose piece reaches its font size, and moves one whose piece does not', () => {
    const fields = () => ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => fldN(n, 100, 30));
    const refused = realRefusals(body([area([ca(100)])], [kid('A', 50), lrtb('L', fields())]));
    expect(refused[0]).toEqual(['f4', 'f4: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)']);
    expect(refused.slice(1).map(([n]) => n)).toEqual(['f5', 'f6']);
    for (const [, w] of refused.slice(1)) expect(w).toMatch(AFTER);
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), lrtb('L', fields())]))[0]).toBe('0:A,L(f1,f2,f3)');
    // A 62: room 38, f4's piece 8 < 10 -> it moves.
    expect(realSplit(body([area([ca(100)])], [kid('A', 62), lrtb('L', fields())])))
      .toEqual(['0:A,L(f1,f2,f3)', '0:L(f4,f5,f6)']);
  });

  // t38: a draw never splits -- it moves however much of it would fit.
  it('moves a straddling draw', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), lrtb('L', draws(6))])))
      .toEqual(['0:A,L(d1,d2,d3)', '0:L(d4,d5,d6)']);
  });

  // t29: rows never straddle, even when a cell's field piece would reach its font size.
  it('splits a table between rows, moving a row whole', () => {
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [fldN(`c${String(i)}`, 100, 30)])));
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), T]))).toEqual(['0:A,T(r1)', '0:T(r2,r3)']);
    expect(realRefusals(body([area([ca(100)])], [kid('A', 50), T]))).toEqual([]);
  });

  // t30: a -1 column is sized from the WHOLE table, on every page.
  it('keeps the whole table\'s -1 column width on every fragment', () => {
    const T = tableN('T', '-1', [rowN('r1', [fldN('c1', 40, 30)]), rowN('r2', [fldN('c2', 80, 30)])]);
    const r = layoutPages(body([area([ca(100)])], [kid('A', 60), T]));
    expect(r.pages.length).toBe(2);
    expect(r.pages[0].placed.get('c1')).toMatchObject({ box: { w: 80 } });
    expect(r.pages[1].placed.get('c2')).toMatchObject({ box: { w: 80 } });
  });

  // t31, t32: an lr-tb or table reached in a split tb chain splits too.
  it('splits an lr-tb nested in a split tb', () => {
    const T = tb('T', [drwN('top', 100, 30), lrtb('L', draws(6))]);
    expect(realSplit(body([area([ca(100)])], [kid('A', 40), T])))
      .toEqual(['0:A,T(top,L(d1,d2,d3))', '0:T(L(d4,d5,d6))']);
  });

  // Rule 7: a straddling item that is itself a splittable subform is not split yet.
  it('refuses a straddling lr-tb item that is a splittable subform, naming 164g.25', () => {
    const S = tb('S', [drwN('s1', 100, 20), drwN('s2', 100, 20)]);
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), lrtb('L', [...draws(3), S])]));
    expect(r[0]).toEqual(['S', 'S: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)']);
  });

  // p. 295 on a row: placed past the boundary when nothing it draws lies past,
  // refused otherwise.
  it('takes the p. 295 rule for a row taller than an empty region', () => {
    const empty: LayoutNode = { kind: 'subform', label: 'E', layout: 'position', geom: { w: '100pt', h: '150pt' }, children: [] };
    const T = tableN('T', '100pt', [rowN('r1', [drwN('a', 100, 50)]), rowN('r2', [empty])]);
    expect(realSplit(body([area([ca(100)])], [T]))).toEqual(['0:T(r1)', '0:T(r2)']);
    const U = tableN('U', '100pt', [rowN('r1', [drwN('a', 100, 50)]), rowN('r2', [drwN('b', 100, 150)])]);
    expect(realRefusals(body([area([ca(100)])], [U]))[0])
      .toEqual(['r2', `r2: does not fit an empty content area and would need ${SPLIT_LATER}`]);
  });

  it('refuses an <overflow> lr-tb or table that would continue (164g.15)', () => {
    const L = lrtb('L', draws(6), { overflow: true });
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), L]));
    expect(r[0]).toEqual(['d4', expect.stringMatching(/^L: its <overflow> leader or trailer .*\(164g\.15\)$/) as unknown as string]);
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 30)])), { overflow: true });
    expect(realRefusals(body([area([ca(100)])], [kid('A', 50), T]))[0][1]).toMatch(/^T: its <overflow> .*\(164g\.15\)$/);
  });

  it('places an lr-tb or table kept intact whole', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), lrtb('L', draws(6), { keep: { intact: 'contentArea' } })])))
      .toEqual(['0:A', '0:L(d1,d2,d3,d4,d5,d6)']);
    const T = tableN('T', '100pt', [1, 2, 3].map((i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 30)])),
      { keep: { intact: 'contentArea' } });
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), T]))).toEqual(['0:A', '0:T(r1,r2,r3)']);
  });

  // Review Focus 2: neither a margin nor a hidden item makes a fragment alone.
  it('never leaves a fragment holding only margins or a hidden item', () => {
    const L = lrtb('L', [drwN('h', 100, 30, { presence: 'hidden' }), ...draws(3)], { margin: { topInset: '30pt' } });
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), L]))).toEqual(['0:A', '0:L(h,d1,d2,d3)']);
    const M = lrtb('M', [...draws(3), drwN('h', 100, 30, { presence: 'hidden' }), ...draws(3).map((d) => ({ ...d, label: `e${d.label}` }))]);
    // A hidden item AFTER visible ones joins their region, as in 164g.8.
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), M]))).toEqual(['0:A,M(d1,d2,d3,h)', '0:M(ed1,ed2,ed3)']);
  });

  // Review Focus 3: re-measuring per leaf stays linear in calls.
  it('measures a long table a bounded number of times', () => {
    let calls = 0;
    const counted: XfaHeight = (n, limit) => { calls += 1; return real(n, limit); };
    const rows = Array.from({ length: 400 }, (_, i) => rowN(`r${String(i)}`, [drwN(`c${String(i)}`, 100, 10)]));
    const r = paginate(body([area([ca(720)])], [kid('A', 50), tableN('T', '100pt', rows)]), counted, layoutHooks());
    expect(r.pages.length).toBe(6);
    expect(calls).toBeLessThan(400 * 2 + 20);
  });
});
```

Also add `layoutPages` to this file's `xfapage.js` import if it is not already there (it is — line 3).

- [ ] **Step 3: Run the new cases to see them fail**

Run: `npx vitest run test/xfapage.test.ts`
Expected: FAIL — the 164g.12 block (an lr-tb or table root child is still placed whole) and the two margin cases.

- [ ] **Step 4: Replace 164g.8's flattening in `src/xfapage.ts`**

Replace everything from the `splittable` doc comment (line 143) through the end of `innerBreak` (line 226) with:

```ts
/** The layouts that split between their children (164g.8, 164g.12). */
const SPLITS: ReadonlySet<string> = new Set(['tb', 'lr-tb', 'table']);

/** XFA 3.3 p. 291-292, narrowed to what 164g.8 and 164g.12 implement: a `tb`,
 *  `lr-tb` or `table` subform with no stated h whose keep intact is none splits
 *  BETWEEN its children -- a tb between its children, an lr-tb between its
 *  items, a table between its rows, each placed whole (Adobe t27-t39). A stated
 *  h keeps it whole (t33, t34). Its parent is always a flow -- the content area,
 *  or a tb being split -- where a subform's intact defaults to none. A
 *  positioned subform splits geometrically instead, when it states keep
 *  intact="none" (xfasplitpos.ts, 164g.11). */
export function splittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && SPLITS.has(n.layout ?? 'position') && n.geom.h === undefined
    && n.refusal === undefined && (n.keep?.intact ?? 'none') === 'none';
}

/** One child placed whole in a split chain (164g.12): `path` runs from the root
 *  child to the container holding it, and `brks` are the breakBefores that take
 *  effect before it -- those of any flattened container it opens, then its own. */
interface Leaf { node: LayoutNode; path: LayoutNode[]; brks: XfaBreak[] }

/** What 164g.8 cannot do inside a split chain, named for its issue. */
function chainRefusal(k: LayoutNode): string | undefined {
  if (k.breakAfter)
    return `${k.label}: a breakAfter inside a split subform is not implemented (164g.16)`;
  if (k.keep?.intact === 'pageArea')
    return `${k.label}: keep intact="pageArea" in a split subform is not implemented (164g.14)`;
  if ((k.keep?.next ?? 'none') !== 'none' || (k.keep?.previous ?? 'none') !== 'none')
    return `${k.label}: keep next/previous (adhesion) in a split subform is not implemented (164g.14)`;
  return undefined;
}

/** A splittable node as its leaves (164g.12). A tb's child that is itself
 *  splittable and shows something is flattened in turn -- an lr-tb or a table as
 *  much as a tb (rule 6, t31, t32). An lr-tb's items and a table's rows are
 *  leaves. A table's whole-table widths go into `widths`, so every fragment
 *  keeps them (rule 4, t30). */
function flatten(
  c: LayoutNode, hooks: XfaPaginateHooks, widths: Map<LayoutNode, number[]>,
  path: LayoutNode[] = [], brks: XfaBreak[] = [],
): Leaf[] | { reason: string } {
  const m = insetsOf(c);
  if ('reason' in m) return { reason: m.reason };
  if (c.layout === 'table' && hooks.columns) {
    const w = hooks.columns(c);
    if ('reason' in w) return w;
    widths.set(c, w);
  }
  const chain = [...path, c];
  const out: Leaf[] = [];
  let pending = brks;
  for (const k of c.children) {
    // A hidden child takes no part in layout (p. 67): no height, and its break
    // and refusals do not apply -- as at the root.
    if (concealed(k)) { out.push({ node: k, path: chain, brks: [] }); continue; }
    const why = chainRefusal(k);
    if (why !== undefined) return { reason: why };
    const own = k.breakBefore ? [...pending, k.breakBefore] : pending;
    pending = [];
    if (c.layout === 'tb' && splittable(k) && k.children.some((x) => !concealed(x))) {
      const inner = flatten(k, hooks, widths, chain, own);
      if ('reason' in inner) return inner;
      out.push(...inner);
    } else out.push({ node: k, path: chain, brks: own });
  }
  return out;
}

/** Whether a splittable node's chain holds a `breakBefore` below it: such a
 *  node is split even when it fits, since a break takes effect wherever it sits
 *  (spec decision #3). Mirrors `flatten`: only a tb's children are descended. */
function innerBreak(c: LayoutNode): boolean {
  return c.children.some((k) => !concealed(k)
    && (k.breakBefore !== undefined || (c.layout === 'tb' && splittable(k) && innerBreak(k))));
}

const hasVisible = (leaves: readonly Leaf[]): boolean => leaves.some((l) => !concealed(l.node));

/** A region's leaves as fragments: shallow copies of their containers, made
 *  only when a leaf lands in them, so none holds only margins. Every fragment
 *  keeps BOTH margins (rule 3; Adobe t35, t36, t39 -- 164g.8 split them between
 *  the first and last fragment), and a table fragment its whole-table widths. */
function fragmentOf(leaves: readonly Leaf[], widths: ReadonlyMap<LayoutNode, number[]>): LayoutNode {
  const fm = new Map<LayoutNode, LayoutNode>();
  let root: LayoutNode | undefined;
  for (const l of leaves) {
    let parent: LayoutNode | undefined;
    for (const c of l.path) {
      let f = fm.get(c);
      if (!f) {
        const w = widths.get(c);
        f = { ...c, children: [], ...(w ? { columnWidths: w.map(ptStr).join(' ') } : {}) };
        fm.set(c, f);
        if (parent) parent.children.push(f);
        else root = f;
      }
      parent = f;
    }
    parent!.children.push(l.node);
  }
  return root!;
}

/** Rule 7: why a leaf that does not fit cannot simply move, or undefined. Only
 *  an lr-tb's items straddle: a tb child and a table row move (164g.8, t29).
 *  The piece above the cut is the room left less the leaf's top in the
 *  candidate fragment and the bottom margins of the fragments around it. A draw
 *  moves (t37, t38); a field moves when that piece is below its font size (t35)
 *  and is refused otherwise (t27, t28, t31; 164g.13); a splittable subform item
 *  is refused (164g.25). */
function straddle(l: Leaf, cand: LayoutNode, room: number, hooks: XfaPaginateHooks): string | undefined {
  if (l.path[l.path.length - 1].layout !== 'lr-tb' || !hooks.topOf) return undefined;
  const top = hooks.topOf(cand, l.node);
  if (top === undefined) return undefined;
  let bottoms = 0;
  for (const n of l.path) {
    const m = insetsOf(n);
    if (!('reason' in m)) bottoms += m.b;
  }
  const piece = room - top - bottoms;
  if (piece <= EPS) return undefined;
  const n = l.node;
  if (n.kind === 'field') return piece >= fontSizeOf(n) - EPS ? fieldSplitRefusal(n.label) : undefined;
  if (splittable(n))
    return `${n.label}: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)`;
  return undefined;
}
```

- [ ] **Step 5: Remove the old fragment machinery from `Paginator`**

Delete `private readonly frags`, `placeUnit` and `fragment` (lines 427-468), keeping `regionKey`:

```ts
  /** The current region, as an <overflow>'s continuation is checked against. */
  regionKey(): string { return `${String(this.pages.length - 1)}:${String(this.ca)}`; }
```

- [ ] **Step 6: Replace `placeSplit`**

Replace the doc comment and body of `placeSplit` (lines 528-594) with:

```ts
/** Place a splittable root child leaf by leaf, from the room left in the
 *  current region (XFA 3.3 p. 290; 164g.8, 164g.12). A region's leaves form one
 *  fragment tree, and a leaf FITS when the region's fragment with it added,
 *  MEASURED, fits the room left -- so pagination and layout cannot disagree
 *  about a cut, and margins, an lr-tb's re-pack and a table's column widths are
 *  all counted by the engine that lays them out. The first leaf that does not
 *  fit ends the region's fragment; it and every later leaf continue in the next
 *  region, and none returns to an earlier one (rule 1, t37). A leaf too tall for
 *  an EMPTY region takes the p. 295 override as a whole root child does. On a
 *  failure what was placed stays, and the failing leaf and every later one are
 *  refused. Returns the cause, or `undefined` when everything was placed. */
function placeSplit(
  p: Paginator, c: LayoutNode, height: XfaHeight, hooks: XfaPaginateHooks,
  refuse: (n: LayoutNode, why: string) => void,
): string | undefined | { unsplittable: string } {
  // A chain that cannot be split places nothing here: the caller falls back to
  // placing it whole, which is what 164g.3 did (164g.8 final review).
  const widths = new Map<LayoutNode, number[]>();
  const leaves = flatten(c, hooks, widths);
  if ('reason' in leaves) return { unsplittable: leaves.reason };
  let region: Leaf[] = [];
  let regionH = 0;
  // Leading hidden leaves wait for the first visible one, so no fragment holds
  // only margins or hidden children.
  const flush = (): void => {
    if (!hasVisible(region)) return;
    p.place(fragmentOf(region, widths), regionH);
    region = [];
    regionH = 0;
  };
  const failFrom = (j: number, why: string): string => {
    flush();
    leaves.forEach((l, i) => { if (i >= j) refuse(l.node, i === j ? why : after(why)); });
    return why;
  };
  // A container with an <overflow> may not continue into a second region: XFA
  // would insert its leader or trailer there (164g.15).
  const seen = new Map<LayoutNode, string>();
  const continues = (l: Leaf): string | undefined => {
    const key = p.regionKey();
    for (const n of l.path) {
      if (!n.overflow) continue;
      const k = seen.get(n);
      if (k !== undefined && k !== key)
        return `${n.label}: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)`;
      seen.set(n, key);
    }
    return undefined;
  };
  for (const [j, l] of leaves.entries()) {
    if (concealed(l.node)) { region.push(l); continue; }
    if (l.brks.length > 0) {
      flush();
      for (const b of l.brks) {
        const r = p.apply(b);
        if (r !== undefined) return failFrom(j, r);
      }
    }
    for (;;) {
      const cap = p.capacity();
      const cand = [...region, l];
      const f = fragmentOf(cand, widths);
      const r = height(f, Infinity);
      if ('reason' in r) return failFrom(j, r.reason);
      const fresh = !hasVisible(region);
      let take = p.used + r.h <= cap + EPS;
      if (!take && fresh && p.used === 0) {
        const past = (): boolean => { const q = height(f, cap); return 'reason' in q ? true : q.past; };
        const e = emptyRegion(p, r.h, past, l.node.label);
        if ('reason' in e) return failFrom(j, e.reason);
        take = e.act === 'place';
      } else if (!take) {
        const s = straddle(l, f, cap - p.used, hooks);
        if (s !== undefined) return failFrom(j, s);
      }
      if (take) {
        const why = continues(l);
        if (why !== undefined) return failFrom(j, why);
        region = cand;
        regionH = r.h;
        break;
      }
      flush();
      const moved = p.advance();
      if (moved !== undefined) return failFrom(j, moved);
    }
  }
  flush();
  return undefined;
}
```

Update its call in `paginateOnce`:

```ts
        const why = placeSplit(p, c, height, hooks, (n, w) => refused.set(n, w));
```

Delete the now-unused `Atom`, `Unit` and `unitsOf` if any references survive (`npm run typecheck` will list them).

- [ ] **Step 7: Update `SPLIT_LATER`**

In `src/xfaflow.ts:47`:

```ts
/** What a refusal names when content would need a split 164g.8/164g.12 do not do. */
export const SPLIT_LATER = 'splitting a field between its lines or a subform beyond its children (164g.13, 164g.19)';
```

Update the four literal assertions: `test/xfapage.test.ts:203` (`'A!: does not fit an empty content area and would need splitting a field between its lines or a subform beyond its children (164g.13, 164g.19)'`) and `test/xfaflow.test.ts:229,372,586` (replace `splitting beyond a tb subform between its children \(164g\.12, 164g\.13, 164g\.19\)` with `splitting a field between its lines or a subform beyond its children \(164g\.13, 164g\.19\)` in each regex).

- [ ] **Step 8: Run the xfapage, xfaflow and hooks tests**

Run: `npx vitest run test/xfapage.test.ts test/xfaflow.test.ts test/xfapage-hooks.test.ts test/xfasplitpos.test.ts`
Expected: PASS, every pre-existing 164g.8 case unchanged except the replaced margin case. If one of the 164g.8 cases fails, compare against the walk-throughs in this plan's Task 3 notes below before changing the expectation — those cases are the fence for "the tb rule did not move except for margins".

Walk-throughs (all with `flowHeight`, `ca(100)`):
- `T(a30,b30,c30)` after `A 50`: `[a]` 30 fits; `[a,b]` 60 → 110 > 100 → cut → `['0:A,T(a)', '0:T(b,c)']`.
- `T(U(a40,b40,c40),d10)`: `[a,b]` 80; `+c` 120 → cut → `T(U(a,b))`, then `T(U(c),d)`.
- `T(a50,b150,c10)`: `b` alone 150 > next region's 100, nothing past → placed by p. 295; `c` → new page.
- `A 50, T(top 30)[a80]`: `[a]` = 110 > 50, region holds nothing → advance; on the empty page 110 > 100, next page no taller, nothing past → placed → `['0:A', '0:T(a)']`.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` — expected clean.

```bash
git add src/xfapage.ts src/xfaflow.ts test/xfapage.test.ts test/xfaflow.test.ts
git commit -m "feat(164g.12): split an lr-tb between items and a table between rows

Fit is decided by measuring the region's fragment tree, so every fragment
carries both margins (Adobe t35, t36, t39) and a table keeps its whole-table
column widths (t30).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(CHANGELOG lands with Task 4's commit, where the oracle proves the behaviour.)

---

### Task 4: Wire t27-t39 into the oracle, run the fences

**Files:**
- Modify: `test/helpers/xfa-adobe.ts` (`ADOBE_PROBES` → t3..t39; drop `SPLIT_PROBES`)
- Modify: `test/xfa-adobe-oracle.test.ts` (box helper, draws, `refusedUnder`; drop Task 1's integrity block)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `AdobeProbe.draws`, `AdobeProbe.refusedUnder` (Task 1); `layoutPages` (Task 3).

- [ ] **Step 1: One probe list**

In `test/helpers/xfa-adobe.ts`:

```ts
/** t3-t26: a positioned subform split (164g.11); t27-t39: an lr-tb or table split (164g.12). */
export const ADOBE_PROBES: readonly string[] = Array.from({ length: 37 }, (_, i) => `t${String(i + 3)}`);
```

Delete `SPLIT_PROBES` and the Task 1 describe block `'Adobe oracle: the 164g.12 probes are vendored'` (the loop now covers those files).

- [ ] **Step 2: Rewrite the oracle test's comparison**

Replace `test/xfa-adobe-oracle.test.ts` with:

```ts
// test/xfa-adobe-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, type PdfObject } from '../src/types.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPages, type XfaLayoutResult } from '../src/xfapage.js';
import { xfaMeasurer } from '../src/xfaconvert.js';
import { ADOBE_PROBES, adobeGoldens, loadAdobeProbe, type AdobeFrag, type AdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for splitting: a positioned subform (164g.11, t3-t26)
 * and an lr-tb or table (164g.12, t27-t39). Each probe in
 * test/fixtures/xfa-adobe/ is converted from its template and compared, field
 * by field, with the layout Adobe Reader 26.1 reported for it; a probe's draws
 * have no widget, so they are compared through our layout of the template.
 *
 * Its ceiling: one producer, one version, hand-transcribed numbers.
 */
const g = adobeGoldens();
/** US Letter; every probe's content area sits at (0.5in, 0.5in). */
const PAGE_H = 792;
const ORIGIN = 36;
const TOL = 0.05;
const som = (path: string): string => path.split('.').map((s) => `${s}[0]`).join('.');

interface TopBox { page: number; x: number; y: number; w: number; h: number }
/** A node's box, top-down from the page's top-left: its own fragment plus, on
 *  the same page, every ancestor subform's fragment and content inset. */
function boxOf(probe: AdobeProbe, path: string, f: AdobeFrag): TopBox | string {
  const [page, fx, fy, w, h] = f;
  let x = ORIGIN + fx;
  let y = ORIGIN + fy;
  const parts = path.split('.');
  for (let i = 2; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('.');
    const frag = probe.subforms[anc]?.find((a) => a[0] === page);
    if (!frag) return `${anc} has no fragment on page ${String(page)}`;
    const [l, t] = probe.insets?.[anc] ?? [0, 0];
    x += frag[1] + l;
    y += frag[2] + t;
  }
  return { page, x, y, w, h };
}

/** Our layout of a probe's template, measured as the converter measures it. */
function laidOut(name: string): XfaLayoutResult {
  const doc = Document.Open(loadAdobeProbe(name));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in set) throw new Error(set.reason);
  const datasets = set.packets.get('datasets');
  const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
  const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
  return layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), []);
}

for (const name of ADOBE_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe oracle: ${name}`, () => {
    const src = Document.Open(loadAdobeProbe(name));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    if (probe.expect === 'match') {
      it("produces Adobe's page count", () => {
        expect(doc.Pages.length).toBe(probe.pages);
      });
      it("puts every field on Adobe's page and box", () => {
        const widgets = new Map(doc.Form.Fields.map((fld) => {
          const page = doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
            .some((a) => doc.resolve(a) === fld.Dict));
          return [fld.FullName, { page: page + 1, rect: doc.resolve(fld.Dict.get('Rect')) as number[] }];
        }));
        const wrong: string[] = [];
        for (const [path, frags] of Object.entries(probe.fields)) {
          const b = boxOf(probe, path, frags[0]);
          if (typeof b === 'string') { wrong.push(`${path}: ${b}`); continue; }
          const want = { page: b.page, rect: [b.x, PAGE_H - b.y - b.h, b.x + b.w, PAGE_H - b.y] };
          const got = widgets.get(som(path));
          if (!got || got.page !== want.page || got.rect.some((v, i) => Math.abs(v - want.rect[i]) > TOL))
            wrong.push(`${path}: want p${String(want.page)} [${want.rect.join(' ')}], got ${got ? `p${String(got.page)} [${got.rect.join(' ')}]` : 'nothing'}`);
        }
        expect(wrong).toEqual([]);
      });
      if (probe.draws) {
        it("puts every draw on Adobe's page and box", () => {
          const laid = laidOut(name);
          expect(laid.pages.length).toBe(probe.pages);
          const wrong: string[] = [];
          for (const [path, frags] of Object.entries(probe.draws!)) {
            const want = boxOf(probe, path, frags[0]);
            if (typeof want === 'string') { wrong.push(`${path}: ${want}`); continue; }
            const label = `${path.split('.').pop()!}[0]`;
            const hits = (laid.pages[want.page - 1]?.nodes ?? [])
              .filter((n) => n.node.kind === 'draw' && n.node.label === label && 'box' in n);
            if (hits.length !== 1) { wrong.push(`${path}: ${String(hits.length)} placed draws labelled ${label} on page ${String(want.page)}`); continue; }
            const got = (hits[0] as { box: { x: number; y: number; w: number; h: number } }).box;
            if ([got.x - want.x, got.y - want.y, got.w - want.w, got.h - want.h].some((d) => Math.abs(d) > TOL))
              wrong.push(`${path}: want p${String(want.page)} ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
          }
          expect(wrong).toEqual([]);
        });
      }
    } else {
      const under = `${som(probe.refusedUnder ?? 'form1.pos')}.`;
      it(`refuses the split subform's fields, naming ${String(probe.reason)}`, () => {
        const hits = report.skipped.filter((s) => s.what === 'field' && s.name?.startsWith(under));
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(h.reason).toContain(String(probe.reason));
      });
    }
  });
}
```

- [ ] **Step 3: Run the oracle**

Run: `npx vitest run test/xfa-adobe-oracle.test.ts`
Expected: PASS for all 37 probes — t29, t30, t32-t39 match field by field (and t37-t39 draw by draw), t27, t28, t31 are refused naming 164g.13, t3-t26 unchanged.

If every draw case reports "0 placed draws labelled …", the draw label is spelled differently from `name[0]`: print `laid.pages[0].nodes.map((n) => n.node.label)` once to read it, fix the `label` line, and re-run. Do not change any golden number.

- [ ] **Step 4: Time DD 1494 before and after**

```bash
git stash list   # must be empty of unrelated work
git checkout HEAD~1 -- src/xfapage.ts src/xfaflow.ts src/xfasplitpos.ts
npx vitest run test/xfa-master-oracle.test.ts 2>&1 | tail -5     # note "Duration"
git checkout HEAD -- src/xfapage.ts src/xfaflow.ts src/xfasplitpos.ts
npx vitest run test/xfa-master-oracle.test.ts 2>&1 | tail -5     # note "Duration"
```

(`HEAD~1` here is Task 2's commit, i.e. pagination before Task 3.) Record both durations for the commit message and CLAUDE.md. If the after-duration exceeds 3x the before, stop and report — the spec's cost argument (memoized text, O(k²) container layout) does not hold.

- [ ] **Step 5: Run the fences**

Run: `npx vitest run test/xfa-master-oracle.test.ts test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-adobe-qualified-oracle.test.ts test/xfa-chrome-fence.test.ts`
Expected: PASS unchanged. DD 1494 (spec Risks) nests `lr-tb` subforms in its split `tb` chain, which now split; if its pdf.js comparison reddens, do NOT re-record: report which field moved, on which page, and why (probably a straddling field now refused by 164g.13's rule) and stop for a decision.

Then the full gate: `npm run typecheck && npm test` — expected all green.

- [ ] **Step 6: CHANGELOG**

Under `## [Unreleased]` → `### Added`, first entry:

```markdown
- **`ConvertXfaToAcroForm` splits an `lr-tb` subform between its items and a table between its rows, as Adobe Reader does.** An `lr-tb` or `table` subform that did not fit the room left on a page moved to the next page whole, and was refused when it was taller than a page. It now splits there: the items or rows that fit stay, and the first one that does not ends the page's part -- it and everything after it continue on the next page, an `lr-tb` re-packing its items from the left, and nothing later returns to the earlier page. Rows always move whole, and a table keeps the column widths its whole set of rows decides, so a `-1` column is as wide on page 1 as a later row makes it. A field that straddles the break is moved when its piece above the break is smaller than its font size, as Adobe does; when Reader would split it between its lines instead, it is refused by name (164g.13), as is an `lr-tb` item that is itself a splittable subform (164g.25). An `lr-tb` or table nested in a `tb` being split splits too. Each rule was measured in Adobe Reader 26.1 through 13 probe forms (`test/fixtures/xfa-adobe/`, t27-t39); every field and draw of the 10 Reader laid out without splitting a field lands on Reader's page and box, and the other 3 are refused. Fit is decided by measuring each page's part with the same engine that lays it out, so pagination and layout cannot disagree about a break. (aspose-pdf-foss-for-ts-164g.12)
```

Under the `### Fixed` heading of `[Unreleased]` (the first `### Fixed` in the file), first entry:

```markdown
- **A split `tb` subform with margins placed its continued content too high, and could overfill the first page.** Since `ConvertXfaToAcroForm` began splitting a `tb` subform across pages, it gave the top margin to the first part only and the bottom margin to the last only. Adobe Reader puts both on every part (probes t35, t36, t39), so on each later page every child sat a top margin too high, and the first page was checked for room without the bottom margin and could take one child too many. Every part now carries both margins, and the room check counts them. No vendored form splits a subform with margins, which is why the earlier oracle could not see it. (aspose-pdf-foss-for-ts-164g.12)
```

- [ ] **Step 7: Commit**

```bash
git add test/helpers/xfa-adobe.ts test/xfa-adobe-oracle.test.ts CHANGELOG.md
git commit -m "test(164g.12): Adobe oracle for lr-tb and table splitting, t27-t39

DD 1494 timing: <before>s before, <after>s after.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Fill the two durations measured in Step 4.)

---

### Task 5: Mutation sweep

Prove each rule load-bearing. For every mutation: apply it, CHECK it applied (`git diff --stat src/` non-empty — a no-op mutation reports green and masquerades as a coverage gap), run the named files with `npx vitest run <files> --testTimeout=30000`, record red/green, then `git checkout -- src/`. If a run hangs, kill orphaned vitest workers (`Get-Process node | Where-Object StartTime -gt <run start> | Stop-Process`) before the next run. A run whose test file fails to LOAD is not green.

**Files:** none committed except the results, recorded in Task 6's CLAUDE.md text.

- [ ] **Step 1: Run the sweep**

| # | Mutation (in `src/xfapage.ts` unless noted) | Expected red |
|---|---|---|
| M1 | Per-line cuts: in `placeSplit`, when a leaf does not fit and its parent is `lr-tb`, also move back every leaf of `region` whose `topOf` equals the leaf's (drop them from `region` before `flush()`, prepend them to the next region) | t37, builder "cuts at the first item" |
| M2 | Widths per fragment: in `fragmentOf`, drop `...(w ? { columnWidths: … } : {})` | t30, builder "-1 column" |
| M3 | 164g.8 margins: in `fragmentOf`, `f = { ...c, children: [], margin: { ...c.margin, bottomInset: undefined } }` | t35, t36, t39, builder "both margins", "reserves the bottom margin" |
| M4 | Later item returns: in `placeSplit`, when a leaf does not fit and `region` has a visible leaf, push the leaf onto a `held` list and `continue` to the next leaf; after the loop, place `held` in the next region | t37 (`b3`), builder "cuts at the first item" |
| M5 | No straddle font test: in `straddle`, `if (n.kind === 'field') return undefined;` | t27, t28, t31, builder "refuses a straddling field" |
| M5b | Every straddling field refused: `if (n.kind === 'field') return fieldSplitRefusal(n.label);` | t35, builder "refuses a straddling field" (its A 62 half) |
| M6 | Split despite a stated h: in `splittable`, drop `&& n.geom.h === undefined` | t33, t34 |
| M7 | No recursion into chained lr-tb/table: in `flatten`, `c.layout === 'tb' && k.layout === 'tb' && splittable(k) …` | t31, t32, builder "nested in a split tb" |
| M8 | No item refusal: in `straddle`, delete the `splittable(n)` branch | builder "names 164g.25" only |
| M9 | No `continues` check on a new region | builder "<overflow>" only |
| M10 | Hidden-only flush: in `flush`, drop the `hasVisible` guard | builder "never leaves a fragment holding only margins…" only |
| M11 | No memo (`src/xfapage.ts` `layoutPages`): `const m = measure;` | none expected (cost only); record DD 1494's duration under it |

- [ ] **Step 2: Record the results**

Write each row's actual outcome (files and case counts that reddened) into a scratch note for Task 6. Any mutation that stays green where red was expected is a coverage gap: add the missing case to `test/xfapage.test.ts`, re-run that mutation, commit the case:

```bash
git add test/xfapage.test.ts
git commit -m "test(164g.12): pin <rule> -- mutation <Mn> was green

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and close

**Files:**
- Modify: `CLAUDE.md` (the `xfapage.ts` 164g.8 invariants; the `fixtures/xfa-adobe/` table row; `xfasplitpos.ts` exports note)

- [ ] **Step 1: Rewrite the 164g.8 invariant paragraph in `CLAUDE.md`**

Replace the paragraph beginning `**Invariant (\`164g.8\`):** a root child that does not fit the room left and is` (through `other vendored form has a splittable root child.`) with:

```markdown
  **Invariant (`164g.8`, `164g.12`):** a root child that does not fit the room
  left and is SPLITTABLE -- a `tb`, `lr-tb` or `table` subform with no stated
  `h`, no `refusal`, `keep intact` absent or `none` -- splits BETWEEN its
  children, the top into the CURRENT region (p. 290). ONE rule for all three
  (rule 1): children are taken in order, and the first that does not fit ends
  the region's fragment; it and every later one continue in the next region, and
  none returns to an earlier one (Adobe t37, where `b3` would have fitted beside
  `b1` and still went to page 2). A tb's child is placed whole or flattened in
  turn -- an `lr-tb` or table as much as a tb (t31, t32); an `lr-tb`'s items and
  a table's rows are LEAVES. One that fits is placed whole and never flattened,
  unless its chain holds a `breakBefore`.
  **Invariant (`164g.12`): fit is decided by MEASURING.** Each region's leaves
  form a fragment tree -- shallow copies of the containers holding them, made
  only when a leaf lands in one, so none holds only margins or hidden children
  -- and a leaf fits when that tree with it added, measured by the same
  `XfaHeight` (`measureExtent`, `'tb'` parent), fits the room left. `xfaflow.ts`
  then lays out exactly those fragments, so pagination and layout cannot
  disagree about a cut, and an `lr-tb` continuation re-packs from x = 0 for free.
  164g.8 summed precomputed atom heights, which could express neither margins on
  every fragment nor a re-pack.
  **Invariant (`164g.12`), and Adobe OVERRULED 164g.8:** EVERY fragment carries
  BOTH of its container's margins and the fit test counts them (t35, t36, t39).
  164g.8 gave the top margin to the first fragment and the bottom to the last,
  which placed continued content a margin too high and checked page 1 without
  the bottom margin. DD 1494, 164g.8's oracle, has no margins on a split
  subform, so it could not see this.
  **Invariant (`164g.12`):** a table fragment keeps the WHOLE table's column
  widths, `-1` columns included (t30), pinned from `tableColumnWidths` -- which
  `table()` records, so widths keep one owner.
  **Invariant (`164g.12`, rule 7):** only an `lr-tb`'s items straddle; a tb
  child and a table row simply move (t29: rows whole although their cells are
  fields). The piece above the cut is the room left less the item's top in the
  candidate fragment (`hooks.topOf`, a layout on a probe page) and the bottom
  margins around it. A draw moves (t37, t38); a field moves when the piece is
  below its font size (t35) and is refused otherwise (t27, t28, t31 -- 164g.13,
  `xfasplitpos.ts`'s `fieldSplitRefusal`, one text for both splitters); a
  splittable subform item is refused (164g.25).
  **Invariant (`164g.12`):** the three layout callbacks reach `xfapage.ts` as
  one `XfaPaginateHooks` (`boxes`, `columns`, `topOf`), built by `layoutHooks`
  over one MEMOIZED measurer (`memoMeasure`), so the fit and the straddle test
  measure text identically and no text twice. Each hook missing narrows what
  splits and never fails. **Measured:** DD 1494's oracle file ran in <before>s
  before and <after>s after.
```

(Fill the two durations from Task 4, Step 4.) Also, in the `**Note, a narrowing:**` paragraph that follows, replace `an \`lr-tb\` or table (164g.12), a text field (164g.13)` with `a text field (164g.13), an \`lr-tb\` item that is itself splittable (164g.25)`; and in the `**Invariant (\`164g.8\`, spec decision #3):**` paragraph replace `before its unit is placed` with `before its leaf is placed`.

After those paragraphs, add the mutation results recorded in Task 5 as one `**Note, measured:**` paragraph naming which mutations reddened only builder cases (expected: M8, M9, M10) and that M11 is a cost rule.

- [ ] **Step 2: Update the `fixtures/xfa-adobe/` table row**

In the row starting `| \`fixtures/xfa-adobe/\` |`, change `24 dynamic XFA probes` to `37 dynamic XFA probes`, and before `Since \`164g.9\`` insert: `Since \`164g.12\`, 13 more (t27-t39) settled how an \`lr-tb\` splits between items and a table between rows -- per item, never per line, rows whole, whole-table column widths -- and that every fragment carries both margins, overruling 164g.8; 10 land every field and draw on Reader's page and box and 3 are refused naming 164g.13.`

- [ ] **Step 3: Run the module-doc sweep**

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

Expected: empty output (no new module was added).

- [ ] **Step 4: Final gate and commit**

Run: `npm run typecheck && npm test` — expected all green.

```bash
git add CLAUDE.md
git commit -m "docs(164g.12): xfapage invariants for lr-tb and table splitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Close out the tracker**

```bash
bd update aspose-pdf-foss-for-ts-164g.15 --append-notes "164g.12: a split table's header rows are not repeated on later pages; Adobe repeats them through overflowLeader, which is this issue's."
bd close aspose-pdf-foss-for-ts-164g.12 --reason "lr-tb splits between items and table between rows from the room left, fit by measuring the region's fragments; both margins on every fragment (Adobe t35/t36/t39 overruled 164g.8). Oracle: Adobe probes t27-t39, 10 matched and 3 refused (164g.13). Item-that-is-a-splittable-subform filed as 164g.25."
```

- [ ] **Step 6: Push**

```bash
git pull --rebase
git push
git status    # must say "up to date with 'origin/main'"
```
