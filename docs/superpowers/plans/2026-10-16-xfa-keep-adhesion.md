# XFA adhesion and `keep intact="pageArea"` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ConvertXfaToAcroForm` paginates `keep next`/`keep previous` (adhesion) and `keep intact="pageArea"` the way Adobe Reader 26.1 does, as measured by probes t55-t72.

**Architecture:** A new pure leaf `src/xfakeep.ts` owns the keep vocabulary (`adheres`, `nextAdhering`, `intactSplits`). `src/xfapage.ts` gains a lookahead: before an object closes a region, the adhering next sibling must put something into the room left (`leadFits` at the root, `chainLead` inside `placeSplit`). An object that fails waits for the next region whole; a pair that cannot fit even an empty region is placed together, the second running past (R4). `xfatemplate.ts` reads `<keep next|previous>` on fields and draws too.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-xfa-keep-adhesion-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Every rule cites its probe(s) (t55-t72) or XFA 3.3 page in a comment, as `xfapage.ts` already does.
- No approximate geometry: a shape not probed falls back to TODAY's behaviour (spec section 4) and is named in a warning; a run-away member that draws past the content area is refused by name.
- `npm run typecheck` and `npm test` green before closing; every `catch` calls `rethrowLimit` first (none is expected here).
- CHANGELOG under `## [Unreleased]` in the same commit as the user-visible change (Task 7 owns it).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The last root child states `keep next`** (no sibling after it) — expect it placed as if it stated nothing. Pinned in Task 3 ("ignores keep next on the last child").
2. **A keep value spelled otherwise** (`ContentArea`, ` contentArea`) — expect no adhesion: the enumeration is matched exactly. Pinned in Task 2 (`adheres` cases).
3. **A long chain** — every one of 40 children states `keep next` in a 100pt content area — expect termination, the first child placed, the run-away members placed until one draws past, that one refused by name and the rest refused after it. Pinned in Task 3 ("terminates on a long unsatisfiable chain").
4. **A run-away member whose ink lies past the content area** — expect it refused naming R4, and every later root child refused after it. Pinned in Task 3.
5. **Adhesion into a sibling with a `breakBefore`** — expect today's layout (adhesion ignored) plus a warning naming 164g.14; inside a split chain, whole placement as today. Pinned in Tasks 3 and 4.

## Decisions this plan adds (beyond the spec)

| # | Decision | Why |
|---|---|---|
| 1 | `nextAdhering` returns the sibling's INDEX, not the node. | `leadFits` walks a chain onward from it; an index is what it needs. |
| 2 | Inside a split chain, an adhering pair that cannot fit even an empty region is NOT forced; the adhesion is dropped with a warning. | R4 was probed only between root children (t59, t69); forcing a leaf inside a fragment is unprobed machinery. |
| 3 | Adhesion OUT of a keep-none positioned subform that 164g.11 splits is ignored with a warning. | Unprobed; it is the mirror of spec section 4's "into" case. |
| 4 | A field's or draw's `intact` is NOT read; only `next`/`previous`. | Field splitting follows `fieldCut` (164g.13); reading intact would change splitting, which is unprobed. |
| 5 | t65's field D is compared by `only`: our D moves whole, Adobe splits it. | A field directly under the content area does not split (164g.13). Task 1 files that as its own issue; C, which this issue moves, still matches Adobe. |

---

### Task 1: Vendor probes t55-t72 and file the follow-up issue

**Files:**
- Move: `test/fixtures/xfa-adobe/tN.out.pdf` → `tN.pdf`, `tN.out.png` → `captures/tN.png` (N = 55..72)
- Modify: `test/fixtures/xfa-adobe/adobe.json` (18 new entries)
- Modify: `test/helpers/xfa-adobe.ts` (two optional fields)
- Modify: `test/fixtures/xfa-adobe/PROVENANCE.md`

**Interfaces:**
- Produces: `AdobeProbe.absolute?: true` (frag x/y already relative to the content-area origin at (0.5in, 0.5in), ancestors included) and `AdobeProbe.only?: string[]` (dotted paths: when present, only these fields and draws are compared). Task 6 reads both.

- [ ] **Step 1: Move the files**

```bash
cd test/fixtures/xfa-adobe
for n in $(seq 55 72); do git mv -f t$n.out.pdf t$n.pdf 2>/dev/null || mv t$n.out.pdf t$n.pdf; mv t$n.out.png captures/t$n.png; done
ls t5[5-9].pdf t6?.pdf t7[0-2].pdf captures/t7[0-2].png | wc -l   # expect 36
cd ../../..
```

- [ ] **Step 2: Add the two fields to `AdobeProbe`**

In `test/helpers/xfa-adobe.ts`, after the `draws?` member of `AdobeProbe`, add:

```ts
  /** t66, t67 (164g.14): every frag's x/y is relative to the content-area
   *  origin (0.5in, 0.5in) of an imaginary single content area, ancestors
   *  included -- content area B starts 360pt down. Needed because Reader's
   *  pageSpan reports one fragment per PAGE, so a subform split across two
   *  content areas of one page reports only its first. */
  absolute?: true;
  /** When present, only these dotted paths are compared (t65: Adobe splits a
   *  field directly under the content area, which we do not). */
  only?: string[];
```

and update the `ADOBE_PROBES` comment to end `...; t40-t54: a field split between its lines (164g.13); t55-t72: adhesion and keep intact="pageArea" (164g.14).` Do NOT change its `length` yet (Task 6).

- [ ] **Step 3: Transcribe the goldens**

These numbers are read from `captures/t55.png`..`captures/t72.png` (and `t71` from the same capture layout as t5). Write them with a one-off script in the scratchpad (not committed):

```js
// add-goldens.mjs -- run once with: node add-goldens.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'test/fixtures/xfa-adobe/adobe.json';
const j = JSON.parse(readFileSync(f, 'utf8'));
const O = { 'form1.oracle': [[1, 0, 0, 540, 216]] };
const OF = { 'form1.oracle.out': [[1, 0, 0, 540, 216]] };
const FILL = { 'form1.filler': [[1, 0, 216, 540, 400]] };
const FILLD = { 'form1.filler.fillerd': [[1, 0, 0, 72, 10]] };
const d = (p) => [[p, 0, 0, 72, 10]];
const s = (p, y, h = 50) => [[p, 0, y, 144, h]];
const t5x = {
  pages: 2, expect: 'match',
  subforms: { ...O, ...FILL, 'form1.C': [[2, 0, 0, 540, 60]], 'form1.D': [[2, 0, 60, 540, 60]], 'form1.E': [[2, 0, 120, 540, 60]] },
  fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(2), 'form1.D.Dd': d(2), 'form1.E.Ed': d(2) },
};
const add = {
  t55: t5x,
  t56: t5x,
  t57: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[1, 0, 616, 540, 40]], 'form1.D': [[1, 0, 656, 540, 40]], 'form1.E': [[2, 0, 0, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(1), 'form1.D.Dd': d(1), 'form1.E.Ed': d(2) } },
  t58: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[1, 0, 616, 540, 60]], 'form1.D': [[1, 0, 676, 540, 30], [2, 0, 0, 540, 150]], 'form1.E': [[2, 0, 150, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(1), 'form1.D.D1': s(1, 0, 30), 'form1.D.D2': s(2, 0, 30), 'form1.D.D3': s(2, 30, 30),
      'form1.D.D4': s(2, 60, 30), 'form1.D.D5': s(2, 90, 30), 'form1.D.D6': s(2, 120, 30), 'form1.E.Ed': d(2) } },
  t59: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[2, 0, 0, 540, 500]], 'form1.D': [[2, 0, 500, 540, 500]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(2), 'form1.D.Dd': d(2) } },
  t60: { pages: 2, expect: 'match',
    subforms: { ...O, 'form1.S': [[1, 0, 216, 540, 400], [2, 0, 0, 540, 180]] },
    fields: OF, draws: { 'form1.S.s1': s(1, 0, 400), 'form1.S.s2': s(2, 0, 60), 'form1.S.s3': s(2, 60, 60), 'form1.S.s4': s(2, 120, 60) } },
  t61: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.S': [[2, 0, 0, 540, 80]], 'form1.N': [[2, 0, 80, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.S.s1': s(2, 0, 40), 'form1.S.s2': s(2, 40, 40), 'form1.N.Nd': d(2) } },
  t62: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[1, 0, 616, 540, 60]], 'form1.X': [[2, 0, 0, 540, 60]], 'form1.X.D': [[2, 0, 0, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(1), 'form1.X.D.Dd': d(2) } },
  t63: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[2, 0, 0, 540, 60]], 'form1.D': [[2, 0, 60, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(2), 'form1.D.Dd': d(2) } },
  t64: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.C': [[1, 0, 616, 540, 60]], 'form1.D': [[2, 0, 0, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(1), 'form1.D.Dd': d(2) } },
  t65: { pages: 2, expect: 'match', only: ['form1.oracle.out', 'form1.filler.fillerd', 'form1.C'],
    subforms: { ...O, ...FILL },
    fields: { ...OF, 'form1.D': [[1, 0, 676, 144, 44], [2, 0, 0, 144, 16]] },
    draws: { ...FILLD, 'form1.C': [[1, 0, 616, 144, 60]] } },
  t66: { pages: 1, expect: 'match', absolute: true,
    subforms: { ...O, 'form1.S': [[1, 0, 216, 540, 100], [1, 0, 360, 540, 200]] },
    fields: OF, draws: { 'form1.S.s1': s(1, 216), 'form1.S.s2': s(1, 266), 'form1.S.s3': s(1, 360),
      'form1.S.s4': s(1, 410), 'form1.S.s5': s(1, 460), 'form1.S.s6': s(1, 510) } },
  t67: { pages: 2, expect: 'match', absolute: true,
    subforms: { ...O, 'form1.S': [[1, 0, 216, 540, 100], [1, 0, 360, 540, 350], [2, 0, 0, 540, 150]] },
    fields: OF, draws: { 'form1.S.s1': s(1, 216), 'form1.S.s2': s(1, 266), 'form1.S.s3': s(1, 360), 'form1.S.s4': s(1, 410),
      'form1.S.s5': s(1, 460), 'form1.S.s6': s(1, 510), 'form1.S.s7': s(1, 560), 'form1.S.s8': s(1, 610), 'form1.S.s9': s(1, 660),
      'form1.S.s10': s(2, 0), 'form1.S.s11': s(2, 50), 'form1.S.s12': s(2, 100) } },
  t68: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.S': [[1, 0, 616, 540, 100], [2, 0, 0, 540, 100]] },
    fields: OF, draws: { ...FILLD, 'form1.S.s1': s(1, 0), 'form1.S.s2': s(1, 50), 'form1.S.s3': s(2, 0), 'form1.S.s4': s(2, 50) } },
  t69: { pages: 1, expect: 'match',
    subforms: { ...O, 'form1.filler': [[1, 0, 216, 540, 100]], 'form1.C': [[1, 0, 316, 540, 300]], 'form1.D': [[1, 0, 616, 540, 500]] },
    fields: OF, draws: { ...FILLD, 'form1.C.Cd': d(1), 'form1.D.Dd': d(1) } },
  t70: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.S': [[1, 0, 616, 540, 80], [2, 0, 0, 540, 40]], 'form1.N': [[2, 0, 40, 540, 60]] },
    fields: OF, draws: { ...FILLD, 'form1.S.s1': s(1, 0, 40), 'form1.S.s2': s(1, 40, 40), 'form1.S.s3': s(2, 0, 40), 'form1.N.Nd': d(2) } },
  t71: { pages: 2, expect: 'match',
    subforms: { ...O, 'form1.filler': [[1, 0, 216, 540, 360]], 'form1.pos': [[2, 0, 0, 540, 288]] },
    fields: { ...OF, 'form1.pos.a': [[2, 0, 36, 144, 21.6]], 'form1.pos.b': [[2, 0, 108, 144, 21.6]], 'form1.pos.c': [[2, 0, 216, 144, 21.6]] },
    draws: { 'form1.filler.d0': [[1, 0, 0, 72, 10]] } },
  t72: { pages: 2, expect: 'match',
    subforms: { ...O, ...FILL, 'form1.T': [[1, 0, 616, 540, 40], [2, 0, 0, 540, 120]],
      'form1.T.r1': [[1, 0, 0, 144, 40]], 'form1.T.r2': [[2, 0, 0, 144, 40]], 'form1.T.r3': [[2, 0, 40, 144, 40]], 'form1.T.r4': [[2, 0, 80, 144, 40]] },
    fields: OF, draws: { ...FILLD, 'form1.T.r1.r1c': s(1, 0, 40), 'form1.T.r2.r2c': s(2, 0, 40), 'form1.T.r3.r3c': s(2, 0, 40), 'form1.T.r4.r4c': s(2, 0, 40) } },
};
Object.assign(j.probes, add);
writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
```

Before running, check the existing file's formatting: `head -c 300 test/fixtures/xfa-adobe/adobe.json`. If it is not `JSON.stringify(_, null, 2)`, match what it is (the diff must add 18 entries and change nothing else — confirm with `git diff --stat`).

- [ ] **Step 4: PROVENANCE**

Append to `test/fixtures/xfa-adobe/PROVENANCE.md`:

```markdown
## Adhesion and keep intact probes (164g.14)

**Producer:** as above, 2026-10-16. `t55.xml`-`t72.xml` as committed;
`captures/tN.png` are full Reader windows (not cropped). Every probe but t71
places a positioned `filler` after the 216pt oracle field, so page 1 has 504pt
less the filler left. Capital names are positioned subforms with a stated h
(unsplittable); lower-case names are draws.

**What Adobe settled, against the spec text:** a chain that cannot fit even
an EMPTY content area does not move to a fresh one -- the first member stays
where it would go alone and the next runs past (t69: C at 316, D from 616 to
1116 on ONE page; p. 312 reads as moving the chain). A flowed subform's
`keep intact="pageArea"` splits like `none`, across pages included (t67, t68;
p. 291 says not across pages), while a positioned one with `pageArea` still
moves whole (t71). `keep next="pageArea"` is no adhesion (t64). A splittable
subform that fits whole but not with its adhering next moves whole, not split
(t61).

**Derived, not read:** t66 and t67 state two content areas of 360pt (A above
B). Reader's `pageSpan` counts PAGES, so a subform split across A and B of one
page reports only its first fragment, and t67's second reported fragment
(`2,0,0,540,350`) is in fact B on page 1, mislabelled `page(c) + 1` by the
probe script. Their goldens are therefore `absolute` -- every draw's y is
relative to the A origin with B 360pt down -- and the subform fragments are
derived from the draws, which are read.

**t65 is compared in part (`only`):** Reader splits the empty field D 44/16
across the break; a field directly under the content area does not split here
(164g.13, follow-up issue). C, the object adhesion moves, is compared.

| File | SHA-256 |
|---|---|
```

then append the rows:

```bash
for n in $(seq 55 72); do echo "| \`t$n.pdf\` | \`$(sha256sum test/fixtures/xfa-adobe/t$n.pdf | cut -d' ' -f1)\` |"; done >> test/fixtures/xfa-adobe/PROVENANCE.md
```

- [ ] **Step 5: File the follow-up issue**

```bash
bd create --title "XFA: split a field or draw directly under the content area" --type feature --priority 3 --labels net-parity \
  --parent aspose-pdf-foss-for-ts-164g --deps discovered-from:aspose-pdf-foss-for-ts-164g.14 \
  --description "Adobe splits an empty field directly under the content area (probe t65: D 60pt, 44/16 across the break). Our root loop places a root-level field or draw whole (164g.13 splits only inside tb/lr-tb/positioned parents). t65 compares only C until this lands; widen its 'only' list then."
```

Record the new id: Task 6 cites it in the oracle comment, Task 7 in CHANGELOG and CLAUDE.md.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run test/xfa-adobe-fixture.test.ts test/xfa-adobe-oracle.test.ts`
Expected: PASS (the oracle still iterates t3-t54 only; the fixture test may check hashes of listed files — if it enumerates `ADOBE_PROBES`, nothing new is checked yet).

```bash
git add test/fixtures/xfa-adobe test/helpers/xfa-adobe.ts
git commit -m "test(164g.14): vendor Adobe probes t55-t72 for adhesion and keep intact

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `xfakeep.ts`, leaf keeps in the template, and `pageArea` as `none`

**Files:**
- Create: `src/xfakeep.ts`
- Create: `test/xfakeep.test.ts`
- Modify: `src/xfatemplate.ts:537-546` (keep reading)
- Modify: `src/xfapage.ts:195-224` (`splittable`, `chainRefusal`)
- Modify: `test/xfatemplate.test.ts` (one case), `test/xfapage.test.ts:166` (one line)

**Interfaces:**
- Produces: `adheres(a: LayoutNode, b: LayoutNode): boolean`, `nextAdhering(sibs: readonly LayoutNode[], i: number): number | undefined`, `intactSplits(n: LayoutNode): boolean`, all from `src/xfakeep.ts`. `LayoutNode.keep` is now set on fields and draws too (`next`/`previous` only).

- [ ] **Step 1: Write the failing tests**

`test/xfakeep.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { adheres, nextAdhering, intactSplits } from '../src/xfakeep.js';
import type { LayoutNode } from '../src/xfaflow.js';

const n = (label: string, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: {}, children: [], ...extra });

describe('adheres (164g.14 R1, R7)', () => {
  it('holds when the first states next or the second previous (t55, t56)', () => {
    expect(adheres(n('a', { keep: { next: 'contentArea' } }), n('b'))).toBe(true);
    expect(adheres(n('a'), n('b', { keep: { previous: 'contentArea' } }))).toBe(true);
    expect(adheres(n('a'), n('b'))).toBe(false);
  });
  it('reads pageArea as no adhesion (t64)', () => {
    expect(adheres(n('a', { keep: { next: 'pageArea' } }), n('b', { keep: { previous: 'pageArea' } }))).toBe(false);
  });
  it('ignores next on the second and previous on the first', () => {
    expect(adheres(n('a', { keep: { previous: 'contentArea' } }), n('b', { keep: { next: 'contentArea' } }))).toBe(false);
  });
  it('matches the enumeration exactly', () => {
    expect(adheres(n('a', { keep: { next: 'ContentArea' } }), n('b'))).toBe(false);
    expect(adheres(n('a', { keep: { next: ' contentArea' } }), n('b'))).toBe(false);
  });
});

describe('nextAdhering (R6)', () => {
  const k = { keep: { next: 'contentArea' } };
  it('skips a hidden or inactive sibling (t63)', () => {
    const s = [n('C', k), n('H', { presence: 'hidden' }), n('I', { presence: 'inactive' }), n('D')];
    expect(nextAdhering(s, 0)).toBe(3);
  });
  it('answers undefined for the last visible sibling and for no adhesion', () => {
    expect(nextAdhering([n('C', k), n('H', { presence: 'hidden' })], 0)).toBeUndefined();
    expect(nextAdhering([n('C'), n('D')], 0)).toBeUndefined();
  });
  it('a visible but invisible sibling is adjacent (it takes space)', () => {
    expect(nextAdhering([n('C', k), n('V', { presence: 'invisible' }), n('D')], 0)).toBe(1);
  });
});

describe('intactSplits (R8)', () => {
  it('none and absent split; contentArea does not', () => {
    expect(intactSplits(n('t', { layout: 'tb' }))).toBe(true);
    expect(intactSplits(n('t', { layout: 'tb', keep: { intact: 'none' } }))).toBe(true);
    expect(intactSplits(n('t', { layout: 'tb', keep: { intact: 'contentArea' } }))).toBe(false);
  });
  it('pageArea splits a flowed subform (t66-t68) and not a positioned one (t71)', () => {
    for (const layout of ['tb', 'lr-tb', 'table'])
      expect(intactSplits(n('t', { layout, keep: { intact: 'pageArea' } }))).toBe(true);
    expect(intactSplits(n('p', { layout: 'position', keep: { intact: 'pageArea' } }))).toBe(false);
    expect(intactSplits(n('p', { keep: { intact: 'pageArea' } }))).toBe(false);
  });
});
```

In `test/xfatemplate.test.ts`, inside `describe('parseXfaTemplate: break conditions (p. 632-636)'`, after the "reads a subform's direct <keep>" case, add:

```ts
  // 164g.14: a field's or draw's adhesion is read; its intact is not (164g.13's fieldCut decides splitting).
  it("reads a field's and a draw's keep next/previous, and not their intact", () => {
    const f = kid('<field name="x"><keep next="contentArea" intact="contentArea"/><ui><textEdit/></ui></field>').children[0];
    expect(f.keep).toEqual({ next: 'contentArea' });
    const d = kid('<draw name="y"><keep previous="contentArea"/><value><text>y</text></value></draw>').children[0];
    expect(d.keep).toEqual({ previous: 'contentArea' });
    const g = kid('<draw name="z"><keep intact="contentArea"/><value><text>z</text></value></draw>').children[0];
    expect(g.keep).toBeUndefined();
  });
```

In `test/xfapage.test.ts`, inside 'refuses what it cannot do in a split chain', REPLACE the line

```ts
    expect(splitRefusals(big(kid('K', 60, { keep: { intact: 'pageArea' } })))[0][1]).toMatch(/keep intact="pageArea" .*\(164g\.14\)/);
```

with nothing (delete it), and add this case after that test:

```ts
  // 164g.14 R8: a flowed subform's keep intact="pageArea" splits like none (t66-t68).
  it('splits a tb stating keep intact="pageArea", as none', () => {
    const b = body([area([ca(100)])], [tb('T', [kid('a', 60), kid('b', 60)], { keep: { intact: 'pageArea' } })]);
    expect(split(b)).toEqual(['0:T(a)', '0:T(b)']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfakeep.test.ts test/xfatemplate.test.ts test/xfapage.test.ts`
Expected: FAIL — `xfakeep.js` cannot be resolved; the template case fails (`f.keep` undefined); the pageArea case fails (`T` placed whole, `['0:T(a,b)']`... or refused).

- [ ] **Step 3: Implement**

`src/xfakeep.ts`:

```ts
/**
 * XFA adhesion and keep intact (`164g.14`; XFA 3.3 p. 291-292, 311-314,
 * 357-358), as Adobe Reader 26.1 applies them -- probes t55-t72 in
 * `test/fixtures/xfa-adobe/`.
 *
 * **Invariant: one owner for the keep vocabulary.** The root loop and
 * `placeSplit` in `xfapage.ts` both ask these, so the two cannot disagree
 * about whether two siblings adhere.
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES that never throws.**
 */
import type { LayoutNode } from './xfaflow.js';

/** The layouts a subform splits BETWEEN its children (164g.8, 164g.12). */
const FLOWED: ReadonlySet<string> = new Set(['tb', 'lr-tb', 'table']);

const concealed = (n: LayoutNode): boolean => n.presence === 'hidden' || n.presence === 'inactive';

/** R1, R7: `a` adheres to the sibling `b` after it when `a` states keep next or
 *  `b` keep previous -- "In all three cases the effect is the same" (p. 312,
 *  t55 = t56). `pageArea` is no adhesion: Adobe does not support it (p. 312's
 *  note, t64). The enumeration is matched exactly. */
export function adheres(a: LayoutNode, b: LayoutNode): boolean {
  return a.keep?.next === 'contentArea' || b.keep?.previous === 'contentArea';
}

/** R6: the index of the sibling after `sibs[i]` that it adheres to, skipping
 *  hidden and inactive siblings, which take no space (t63); undefined when
 *  there is none or it does not adhere. Only siblings adhere (p. 314, t62). */
export function nextAdhering(sibs: readonly LayoutNode[], i: number): number | undefined {
  for (let j = i + 1; j < sibs.length; j++) {
    if (concealed(sibs[j])) continue;
    return adheres(sibs[i], sibs[j]) ? j : undefined;
  }
  return undefined;
}

/** R8, and it overrules p. 291: a FLOWED subform's `keep intact="pageArea"`
 *  splits exactly as `none`, across pages included (t66-t68). A positioned one
 *  does not -- Adobe splits a positioned subform only when it states `none`
 *  (164g.11, t71). */
export function intactSplits(n: LayoutNode): boolean {
  const v = n.keep?.intact ?? 'none';
  return v === 'none' || (v === 'pageArea' && FLOWED.has(n.layout ?? 'position'));
}
```

In `src/xfatemplate.ts`, replace the keep block inside `if (kind === 'subform') {` (the lines from `// 164g.8: pagination honours keep intact` through `if (Object.keys(k).length > 0) n.keep = k;\n    }`) with:

```ts
    // 164g.8: pagination honours keep intact and refuses what it cannot do.
    const k = keepOf(el, ['intact', 'next', 'previous']);
    if (k) n.keep = k;
```

and, just before `if (kind === 'subform') {`, add:

```ts
  if (kind === 'field' || kind === 'draw') {
    // 164g.14: a leaf adheres to its siblings (t60, t65). Its intact is not
    // read: whether a field splits is fieldCut's (164g.13), and is unprobed.
    const k = keepOf(el, ['next', 'previous']);
    if (k) n.keep = k;
  }
```

and add this helper above the function that builds the node (beside the other small readers such as `child`; `XfaKeep` is already imported there):

```ts
/** An element's direct `<keep>`, the named attributes only; undefined when it states none. */
function keepOf(el: XmlNode, attrs: ReadonlyArray<'intact' | 'next' | 'previous'>): XfaKeep | undefined {
  const keep = child(el, 'keep');
  if (!keep) return undefined;
  const k: XfaKeep = {};
  for (const a of attrs) {
    const v = keep.attrs.get(a);
    if (v !== undefined) k[a] = v;
  }
  return Object.keys(k).length > 0 ? k : undefined;
}
```

(If the element type is named other than `XmlNode` in that file, use its name — check the signature of `child`.)

In `src/xfapage.ts`: add `import { intactSplits } from './xfakeep.js';` after the `xfafieldsplit.js` import; in `splittable` replace `&& n.refusal === undefined && (n.keep?.intact ?? 'none') === 'none';` with `&& n.refusal === undefined && intactSplits(n);` and extend its doc comment's first sentence to `... whose keep intact is none -- or pageArea, which Adobe splits alike (164g.14 R8, t66-t68) -- splits`; in `chainRefusal` delete the two lines

```ts
  if (k.keep?.intact === 'pageArea')
    return `${k.label}: keep intact="pageArea" in a split subform is not implemented (164g.14)`;
```

(leave the adhesion refusal for Task 4).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xfakeep.test.ts test/xfatemplate.test.ts test/xfapage.test.ts test/xfapage-hooks.test.ts test/xfapage-qualified.test.ts`
Expected: PASS.

- [ ] **Step 5: Fence and commit**

Run: `npx vitest run test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-master-oracle.test.ts test/xfa-adobe-oracle.test.ts test/xfa-adobe-qualified-oracle.test.ts && npm run typecheck`
Expected: PASS (no vendored real form states `pageArea` or a leaf keep).

```bash
git add src/xfakeep.ts src/xfatemplate.ts src/xfapage.ts test/xfakeep.test.ts test/xfatemplate.test.ts test/xfapage.test.ts
git commit -m "feat(164g.14): keep vocabulary; a flowed subform's intact=pageArea splits as none

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Adhesion between root children

**Files:**
- Modify: `src/xfapage.ts` (`leadFits`, `keepWith`, `paginateOnce`'s root loop)
- Create: `test/xfapage-keep.test.ts`

**Interfaces:**
- Consumes: `adheres`, `nextAdhering` (Task 2); existing `splittable`, `flatten`, `fragmentOf`, `straddle`, `concealed`, `positionedSplittable`, `fieldCut`, `EPS`.
- Produces (module-private, Task 4 uses them): `type Lead = 'yes' | 'no' | { fallback: string }` and `function leadFits(sibs: readonly LayoutNode[], iy: number, room: number, height: XfaHeight, hooks: XfaPaginateHooks): Lead`.

- [ ] **Step 1: Write the failing tests**

`test/xfapage-keep.test.ts` (helpers copied from `test/xfapage.test.ts`, which keeps them module-private):

```ts
import { describe, it, expect } from 'vitest';
import { paginate, type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight } from '../src/xfapage.js';
import type { LayoutNode, XfaBreak } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const tb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'tb', geom: { w: '100pt' }, children, ...extra });
const ca = (h: number): XfaContentArea =>
  ({ node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { w: '500pt', h: `${String(h)}pt` }, children: [] } });
const area = (cas: XfaContentArea[]): XfaPageAreaModel => ({ max: -1, contentAreas: cas });
const body = (pageAreas: XfaPageAreaModel[], kids: LayoutNode[]): XfaBody => ({
  root: { kind: 'subform', label: 'root[0]', layout: 'tb', geom: {}, children: kids },
  pageSet: { relation: 'orderedOccurrence', max: -1, pageAreas },
});
const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
const hOf = (n: LayoutNode): number => (n.geom.h !== undefined ? pt(n.geom.h)
  : n.children.filter((k) => k.presence !== 'hidden').reduce((s, k) => s + hOf(k), 0));
const bang = (n: LayoutNode): boolean => n.label.endsWith('!') || n.children.some(bang);
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: bang(n) });
const SPLITS = new Set(['tb', 'lr-tb', 'table']);
const shape = (n: LayoutNode): string =>
  (SPLITS.has(n.layout ?? '') && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
const run = (b: XfaBody, hooks = {}) => paginate(b, flowHeight, hooks);
const split = (b: XfaBody, hooks = {}) => run(b, hooks).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const refusals = (b: XfaBody) => [...run(b).refused].map(([n, w]) => [n.label, w]);
const NEXT = { keep: { next: 'contentArea' } };
const PREV = { keep: { previous: 'contentArea' } };
const EMPTY_TEXT = {
  kind: 'text', paras: [{ runs: [], base: { family: ['Courier'], size: 10, bold: false, italic: false },
    marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
  insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false,
} as unknown as LeafText;
const fld = (label: string, h: number): LayoutNode =>
  ({ kind: 'field', label, field: label, ui: 'textEdit', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], text: EMPTY_TEXT });
const pb = (): XfaBreak => ({ targetType: 'pageArea', startNew: false });

describe('adhesion between root children (164g.14)', () => {
  // Content area 100: F 40 leaves 60.
  it('moves an adhering pair together when they do not fit (R1, t55)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('previous on the second is the same (t56)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40), kid('D', 40, PREV)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('a chain of three moves together; the one after it does not (t55, t57)', () => {
    expect(split(body([area([ca(200)])], [kid('F', 120), kid('C', 30, NEXT), kid('D', 30, NEXT), kid('E', 30), kid('G', 10)])))
      .toEqual(['0:F', '0:C,D,E,G']);
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 20, NEXT), kid('D', 20), kid('E', 30)])))
      .toEqual(['0:F,C,D', '0:E']);
  });
  it('a chain whose MIDDLE link fails moves whole', () => {
    // C+D fit the 60 left, D+E do not: C must wait too.
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 20, NEXT), kid('D', 20, NEXT), kid('E', 30)])))
      .toEqual(['0:F', '0:C,D,E']);
  });
  it('skips a hidden sibling (t63)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('H', 40, { presence: 'hidden' }), kid('D', 40)])))
      .toEqual(['0:F', '0:C,H,D']);
  });
  it('does not reach a non-sibling (t62)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40), tb('X', [kid('D', 40, PREV)])])))
      .toEqual(['0:F,C', '0:X(D)']);
  });
  it('ignores keep next on the last child', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT)]))).toEqual(['0:F,C']);
  });
  it('needs only the first piece of a splittable next (R2, t58)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 30, NEXT), tb('D', [kid('d1', 20), kid('d2', 40)])])))
      .toEqual(['0:F,C,D(d1)', '0:D(d2)']);
  });
  it('needs only a piece of a field it can split (R2, t65)', () => {
    // 60 left: C 40, then 20 >= the 10pt font size of an empty field.
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), fld('D', 60)]), { fieldLines: () => 0 }))
      .toEqual(['0:F,C', '0:D']);
  });
  it('moves a splittable child that fits whole but not with its next WHOLE (R3, t61)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), tb('S', [kid('s1', 20), kid('s2', 20)], NEXT), kid('N', 40)])))
      .toEqual(['0:F', '0:S(s1,s2),N']);
  });
  it('runs the next past this region when the pair cannot fit an empty one (R4, t69)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 20), kid('C', 40, NEXT), kid('D', 70), kid('E', 10)])))
      .toEqual(['0:F,C,D', '0:E']);
  });
  it('R4 at an empty region: the first stays, the next runs past (t59)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 80, NEXT), kid('D', 80)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('refuses a run-away member that draws past, and everything after it', () => {
    const r = refusals(body([area([ca(100)])], [kid('F', 20), kid('C', 40, NEXT), kid('D!', 70), kid('E', 10)]));
    expect(r[0]).toEqual(['D!', expect.stringMatching(/^D!: .*cannot fit an empty content area.*\(164g\.14 R4\)/) as unknown as string]);
    expect(r.map(([n]) => n)).toEqual(['D!', 'E']);
  });
  it('terminates on a long unsatisfiable chain', () => {
    const kids = Array.from({ length: 40 }, (_, i) => kid(i === 5 ? `K${String(i)}!` : `K${String(i)}`, 30, NEXT));
    const res = run(body([area([ca(100)])], kids));
    expect(res.refused.size).toBe(35);
    expect(res.pages[0].contentAreas[0].children.map((k) => k.label)).toEqual(['K0', 'K1', 'K2', 'K3', 'K4']);
  });
  it('ignores adhesion into a sibling with a breakBefore, with a warning (section 4)', () => {
    const r = run(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40, { breakBefore: pb() })]));
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40, { breakBefore: pb() })])))
      .toEqual(['0:F,C', '0:D']);
    expect(r.warnings).toContainEqual(expect.stringMatching(/D: adhesion into a sibling with a breakBefore .*\(164g\.14\)/));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapage-keep.test.ts`
Expected: FAIL — adhesion ignored (e.g. `['0:F,C', '0:D']` for the first case); the 'last child', 'non-sibling' and 'breakBefore' layout cases may already pass.

- [ ] **Step 3: Implement**

In `src/xfapage.ts`, extend the import from `./xfakeep.js` to `import { intactSplits, nextAdhering } from './xfakeep.js';`.

Add after `straddle`:

```ts
/** Whether something of an adhering sibling fits (164g.14). */
type Lead = 'yes' | 'no' | { fallback: string };

/** R1, R2: would `sibs[iy]` -- a sibling the one before it adheres to -- put
 *  SOMETHING into `room`? Whole, and then something of what IT adheres to (a
 *  chain); else its first piece: a splittable subform's first leaf (t58, t70)
 *  or a field's first piece by `fieldCut` (t65). Measured through the same
 *  `height` and `fragmentOf` as the fit test, so the two cannot disagree. A
 *  shape no probe settles is a fallback (spec section 4). */
function leadFits(
  sibs: readonly LayoutNode[], iy: number, room: number, height: XfaHeight, hooks: XfaPaginateHooks,
): Lead {
  const y = sibs[iy];
  if (y.breakBefore)
    return { fallback: `${y.label}: adhesion into a sibling with a breakBefore is not implemented (164g.14)` };
  const r = height(y, Infinity);
  // Its own refusal is reported where it is placed; it does not hold anything off.
  if ('reason' in r) return 'yes';
  if (r.h <= room + EPS) {
    const iz = nextAdhering(sibs, iy);
    return iz === undefined ? 'yes' : leadFits(sibs, iz, room - r.h, height, hooks);
  }
  if (hooks.boxes && positionedSplittable(y))
    return { fallback: `${y.label}: adhesion into a positioned subform that splits is not implemented (164g.14)` };
  if (y.kind === 'field') {
    const fc = fieldCut(y, room, hooks.fieldLines?.(y), r.h);
    return typeof fc === 'object' && 'cut' in fc ? 'yes' : 'no';
  }
  if (!splittable(y)) return 'no';
  const widths = new Map<LayoutNode, number[]>();
  const leaves = flatten(y, hooks, widths);
  if ('reason' in leaves) return 'no';
  const first = leaves.findIndex((l) => !concealed(l.node));
  if (first < 0) return 'yes';
  const f = fragmentOf(leaves.slice(0, first + 1), widths);
  const q = height(f, Infinity);
  if ('reason' in q) return 'no';
  if (q.h <= room + EPS) return 'yes';
  return typeof straddle(leaves[first], f, room, hooks, height) === 'object' ? 'yes' : 'no';
}

/** R1, R3, R4 for a root child `sibs[i]`, `h` tall, about to be placed whole
 *  with `room` left after it: place it, hold it off whole to the next region,
 *  force the next sibling into this region after it, or ignore the adhesion. */
function keepWith(
  p: Paginator, sibs: readonly LayoutNode[], i: number, room: number, h: number,
  height: XfaHeight, hooks: XfaPaginateHooks,
): 'place' | 'advance' | 'force' | { warning: string } {
  const iy = nextAdhering(sibs, i);
  if (iy === undefined) return 'place';
  const lead = leadFits(sibs, iy, room, height, hooks);
  if (lead === 'yes') return 'place';
  if (typeof lead === 'object') return { warning: lead.fallback };
  // R1, R3: hold off when the pair fits the next region -- never from an empty one.
  if (p.used > EPS) {
    const s = p.snapshot();
    const moved = p.advance();
    const cap = moved === undefined ? p.capacity() : 0;
    p.restore(s);
    if (moved === undefined && h <= cap + EPS && leadFits(sibs, iy, cap - h, height, hooks) === 'yes') return 'advance';
  }
  // R4 (t59, t69): nothing waits; the next runs past this region after it.
  if (splittable(sibs[iy]))
    return { warning: `${sibs[iy].label}: adheres to the content before it, which together cannot fit an empty content area, and is splittable; the adhesion is not kept (164g.14)` };
  return 'force';
}
```

In `paginateOnce`, after `let cause: string | undefined;` add `let force = false;` and a dedupe helper:

```ts
  /** The run-away member of an R4 pair goes next, in this region (164g.14). */
  let force = false;
  const warn = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
```

Change `for (const c of kids) {` to `for (const [i, c] of kids.entries()) {`. After the line `const fail = (why: string): void => { refused.set(c, why); cause = why; };` and BEFORE the `if (c.breakBefore && c !== consumed)` block, add:

```ts
    if (force) {
      // R4 (t59, t69): placed after the one it adheres to, running past this
      // region -- only when nothing it draws lies past (p. 295's posture).
      force = false;
      const r = height(c, p.capacity() - p.used);
      if ('reason' in r) { fail(r.reason); continue; }
      if (r.past) {
        fail(`${c.label}: adheres to the content before it, which together cannot fit an empty content area, and draws past the content area (164g.14 R4)`);
        continue;
      }
      p.place(c, r.h);
      // A chain runs past whole.
      if (nextAdhering(kids, i) !== undefined) force = true;
      if (c.breakAfter) {
        const ra = p.apply(c.breakAfter);
        if (ra !== undefined) cause = ra;
      }
      continue;
    }
```

Replace the fit line

```ts
      if (!breaks && p.used + r.h <= H + EPS) { p.place(c, r.h); placed = true; break; }
```

with

```ts
      if (!breaks && p.used + r.h <= H + EPS) {
        const k = keepWith(p, kids, i, H - p.used - r.h, r.h, height, hooks);
        if (k === 'advance') {
          const moved = p.advance();
          if (moved !== undefined) { fail(moved); break; }
          continue;
        }
        if (k === 'force') force = true;
        else if (typeof k === 'object') warn(k.warning);
        p.place(c, r.h); placed = true; break;
      }
```

Note on the long-chain Review Focus case: with K0..K39 each 30pt in a 100pt area, K0 is placed (`force`, since the chain can never fit an empty region), K1..K4 are forced after it (the region overfills; `past` is false until K5, whose `!` label reports ink past), K5 is refused, and K6..K39 are refused after it. A forced child is placed even when `p.used` already exceeds the capacity; the room passed to `height` may be negative.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xfapage-keep.test.ts test/xfapage.test.ts test/xfapage-hooks.test.ts test/xfapage-qualified.test.ts`
Expected: PASS. If 'needs only the first piece of a splittable next' fails because `D` is placed whole rather than split, check that `placeSplit` is reached for `D` (it does not fit the 30 left), not that `leadFits` is wrong.

- [ ] **Step 5: Fence and commit**

Run: `npx vitest run test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-master-oracle.test.ts test/xfa-adobe-oracle.test.ts test/xfa-adobe-qualified-oracle.test.ts test/xfa-chrome-fence.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/xfapage.ts test/xfapage-keep.test.ts
git commit -m "feat(164g.14): adhesion between root children, as Adobe Reader pages it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Adhesion inside a split chain

**Files:**
- Modify: `src/xfapage.ts` (`chainRefusal`, `placeSplit`, its call site in `paginateOnce`, the positioned-split branch)
- Modify: `test/xfapage-keep.test.ts`, `test/xfapage.test.ts` (two cases)

**Interfaces:**
- Consumes: `adheres` (Task 2), `leadFits`, `Lead` (Task 3).
- Produces: `placeSplit(p, c, height, hooks, refuse, tail?: (room: number) => boolean, warn?: (w: string) => void)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfapage-keep.test.ts` (it needs `drw` for an lr-tb item):

```ts
const lrtb = (label: string, children: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'lr-tb', geom: { w: '300pt' }, children });

describe('adhesion inside a split chain (164g.14 R5)', () => {
  it('holds a leaf off with the leaf it adheres to (t60)', () => {
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 60), kid('s2', 20, NEXT), kid('s3', 30), kid('s4', 10)])])))
      .toEqual(['0:S(s1)', '0:S(s2,s3,s4)']);
  });
  it('previous on the later leaf is the same', () => {
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 60), kid('s2', 20), kid('s3', 30, PREV), kid('s4', 10)])])))
      .toEqual(['0:S(s1)', '0:S(s2,s3,s4)']);
  });
  it('a nested container adheres to its sibling at the level they part', () => {
    // I's last leaf i2 and the sibling J: I states keep next.
    expect(split(body([area([ca(100)])], [tb('S', [kid('a', 50), tb('I', [kid('i1', 10), kid('i2', 20)], NEXT), kid('J', 30)])])))
      .toEqual(['0:S(a,I(i1))', '0:S(I(i2),J)']);
  });
  it('the last piece of a split root child adheres to the next root child (R2, t70)', () => {
    // S splits: s1 on page 1, s2 on page 2. s3 fits after s2 there (90), but
    // s3 + N (120) do not, and fit an empty page: s3 waits with N.
    expect(split(body([area([ca(100)])], [kid('F', 40), tb('S', [kid('s1', 50), kid('s2', 80), kid('s3', 10)], NEXT), kid('N', 30)])))
      .toEqual(['0:F,S(s1)', '0:S(s2)', '0:S(s3),N']);
  });
  it('rows of a table adhere (t72)', () => {
    // r1 fits the 50 left; r2 fits too, but r2 + r3 (80) do not, and fit an empty area.
    const row = (l: string, extra: Partial<LayoutNode> = {}): LayoutNode =>
      ({ kind: 'subform', label: l, layout: 'row', geom: { h: '20pt' }, children: [], ...extra });
    const T: LayoutNode = { kind: 'subform', label: 'T', layout: 'table', geom: { w: '100pt' }, children: [row('r1'), row('r2', NEXT), row('r3'), row('r4')] };
    expect(split(body([area([ca(100)])], [kid('F', 50), T]))).toEqual(['0:F,T(r1)', '0:T(r2,r3,r4)']);
  });
  it('falls back to whole placement for adhesion between lr-tb items (section 4)', () => {
    const res = run(body([area([ca(100)])], [kid('F', 40), lrtb('L', [kid('a', 40, NEXT), kid('b', 40)])]));
    expect(res.pages.map((pg) => pg.contentAreas.map((c) => c.children.map(shape).join(',')).join(' '))).toEqual(['F', 'L(a,b)']);
    expect(res.refused.size).toBe(0);
  });
  it('a pair inside a split that cannot fit an empty region is not forced, with a warning (decision 2)', () => {
    const res = run(body([area([ca(100)])], [tb('S', [kid('s1', 50), kid('s2', 40, NEXT), kid('s3', 70)])]));
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 50), kid('s2', 40, NEXT), kid('s3', 70)])])))
      .toEqual(['0:S(s1,s2)', '0:S(s3)']);
    expect(res.warnings).toContainEqual(expect.stringMatching(/s2: .*not kept inside a split subform \(164g\.14\)/));
  });
});
```

`flowHeight` sums children for a container with no stated `h`, so the lr-tb case's `L` measures 80 (its items' real line packing is not modelled here) and splits; that is what reaches the lr-tb fallback.

In `test/xfapage.test.ts`, in 'refuses what it cannot do in a split chain', delete the line

```ts
    expect(splitRefusals(big(kid('N', 60, { keep: { next: 'contentArea' } })))[0][1]).toMatch(/adhesion.*\(164g\.14\)/);
```

and in 'places whole, as before, a child whose chain it cannot split but which fits an empty region', replace `kid('a', 30, { keep: { next: 'contentArea' } })` with `kid('a', 30, { breakAfter: pb() })` and its comment's "(here a keep-with-next, which Designer writes routinely)" with "(here a breakAfter, 164g.16)" — adhesion now splits, so the case keeps its point with a shape that still cannot.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapage-keep.test.ts test/xfapage.test.ts`
Expected: FAIL — the chain refusal `keep next/previous (adhesion) in a split subform is not implemented (164g.14)` makes `S` unsplittable, so the new cases place it whole.

- [ ] **Step 3: Implement**

Extend the `./xfakeep.js` import to `{ adheres, intactSplits, nextAdhering }`.

In `chainRefusal`, delete

```ts
  if ((k.keep?.next ?? 'none') !== 'none' || (k.keep?.previous ?? 'none') !== 'none')
    return `${k.label}: keep next/previous (adhesion) in a split subform is not implemented (164g.14)`;
```

and update its doc comment to `/** What 164g.8 cannot do inside a split chain, named for its issue (164g.16). */`.

Add above `placeSplit`:

```ts
/** The two siblings two consecutive leaves part at, and their parent: R5's
 *  adhesion is decided there, so a container's own keep next makes its LAST
 *  leaf adhere to its next sibling's FIRST (t58, t70). */
function partAt(a: Leaf, b: Leaf): { x: LayoutNode; y: LayoutNode; parent: LayoutNode } | undefined {
  const ca = [...a.path, a.node];
  const cb = [...b.path, b.node];
  let d = 0;
  while (d < ca.length && d < cb.length && ca[d] === cb[d]) d++;
  if (d === 0 || d >= ca.length || d >= cb.length) return undefined;
  return { x: ca[d], y: cb[d], parent: ca[d - 1] };
}
```

Change `placeSplit`'s signature to

```ts
function placeSplit(
  p: Paginator, c: LayoutNode, height: XfaHeight, hooks: XfaPaginateHooks,
  refuse: (n: LayoutNode, why: string) => void,
  tail?: (room: number) => boolean, warn: (w: string) => void = () => undefined,
): string | undefined | { unsplittable: string } {
```

and its doc comment gains: `Since 164g.14 a leaf that fits but whose adhering next leaf -- or, for the last leaf, the root child after `c` (`tail`) -- puts nothing into the room left is held off WHOLE to the next region (R3, R5), when the pair fits that region; a pair that cannot is not forced here (decision 2).`

Right after `if ('reason' in leaves) return { unsplittable: leaves.reason };` add:

```ts
  // 164g.14 R5: which visible leaf adheres to which; the unprobed shapes make
  // the chain unsplittable before anything is placed (spec section 4).
  const vis = leaves.flatMap((l, i) => (concealed(l.node) ? [] : [i]));
  const lastVis = vis[vis.length - 1];
  const link = new Map<number, number>();
  for (let a = 0; a + 1 < vis.length; a++) {
    const j = vis[a];
    const k = vis[a + 1];
    const part = partAt(leaves[j], leaves[k]);
    if (!part || !adheres(part.x, part.y)) continue;
    if (part.parent.layout === 'lr-tb')
      return { unsplittable: `${part.x.label}: adhesion between the items of an lr-tb line is not implemented (164g.14)` };
    if (leaves[k].brks.length > 0)
      return { unsplittable: `${part.y.label}: adhesion into a sibling with a breakBefore is not implemented (164g.14)` };
    link.set(j, k);
  }
  /** Whether leaf `k` (adhered to) puts something into a region whose room is
   *  `capRoom`, after `cand` -- and onward along the chain. */
  const chainLead = (cand: Leaf[], k: number, capRoom: number): boolean => {
    const withK = [...cand, leaves[k]];
    const f = fragmentOf(withK, widths);
    const q = height(f, Infinity);
    if ('reason' in q) return true;
    if (q.h <= capRoom + EPS) {
      const n = link.get(k);
      if (n !== undefined) return chainLead(withK, n, capRoom);
      return k === lastVis && tail ? tail(capRoom - q.h) : true;
    }
    return typeof straddle(leaves[k], f, capRoom, hooks, height) === 'object';
  };
  /** Whether leaf `j` (as `cur`) and what it adheres to fit the next region, empty. */
  const fitsNextEmpty = (j: number, cur: Leaf): boolean => {
    const s = p.snapshot();
    const moved = p.advance();
    const capN = moved === undefined ? p.capacity() : 0;
    p.restore(s);
    if (moved !== undefined) return false;
    const q = height(fragmentOf([cur], widths), Infinity);
    if ('reason' in q || q.h > capN + EPS) return false;
    const k = link.get(j);
    if (k !== undefined) return chainLead([cur], k, capN);
    return j === lastVis && tail ? tail(capN - q.h) : true;
  };
```

In the leaf loop, replace the `} else if (take) {` branch:

```ts
      } else if (take) {
        const why = continues(cur);
        if (why !== undefined) return failFrom(j, why);
        region = cand;
        regionH = r.h;
        pending = [];
        break;
      }
```

with

```ts
      } else if (take) {
        // 164g.14 R3, R5: the leaf it adheres to must put something here too.
        const k = link.get(j);
        const lead = k !== undefined ? chainLead(cand, k, cap - p.used)
          : j === lastVis && tail ? tail(cap - p.used - r.h) : true;
        if (!lead && (hasVisible(region) || p.used > EPS)) {
          if (fitsNextEmpty(j, cur)) {
            flush();
            const moved = p.advance();
            if (moved !== undefined) return failFrom(j, moved);
            continue;
          }
          warn(`${cur.node.label}: adheres to the content after it, which together cannot fit an empty content area; the adhesion is not kept inside a split subform (164g.14)`);
        }
        const why = continues(cur);
        if (why !== undefined) return failFrom(j, why);
        region = cand;
        regionH = r.h;
        pending = [];
        break;
      }
```

At the call site in `paginateOnce`, replace

```ts
        const why = placeSplit(p, c, height, hooks, (n, w) => refused.set(n, w));
```

with

```ts
        // 164g.14: the split child's last piece adheres to the next root child.
        const iy = nextAdhering(kids, i);
        const tail = iy === undefined ? undefined : (room: number): boolean => {
          const l = leadFits(kids, iy, room, height, hooks);
          if (typeof l === 'object') { warn(l.fallback); return true; }
          return l === 'yes';
        };
        const why = placeSplit(p, c, height, hooks, (n, w) => refused.set(n, w), tail, warn);
```

In the positioned branch, after `const why = placePositioned(p, c, r.h, hooks.boxes, hooks.fieldLines);`, replace `if (why === undefined) { placed = true; break; }` with

```ts
        if (why === undefined) {
          // Decision 3: adhesion out of a split positioned subform is unprobed.
          if (nextAdhering(kids, i) !== undefined)
            warn(`${c.label}: adhesion out of a positioned subform that splits is not implemented (164g.14)`);
          placed = true; break;
        }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xfapage-keep.test.ts test/xfapage.test.ts test/xfapage-hooks.test.ts test/xfapage-qualified.test.ts`
Expected: PASS.

- [ ] **Step 5: Fence and commit**

Run: `npx vitest run test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-master-oracle.test.ts test/xfa-adobe-oracle.test.ts test/xfa-adobe-qualified-oracle.test.ts test/xfa-chrome-fence.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/xfapage.ts test/xfapage-keep.test.ts test/xfapage.test.ts
git commit -m "feat(164g.14): adhesion between leaves of a split chain and out of its last piece

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Converter warnings reach the report

**Files:**
- Test: `test/xfaconvert-keep.test.ts` (create)

**Interfaces:**
- Consumes: `layoutPages(body, measure, warnings)` already forwards `pg.warnings`; `XfaConvertReport.warnings`.

- [ ] **Step 1: Write the test**

`test/xfaconvert-keep.test.ts` (the `dynamic` helper is `test/xfaconvert-pages.test.ts`'s):

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
/** US Letter with a 720pt content area: F 600 leaves 120. */
const form = (c: string, d: string) => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>
  <subform name="F" w="7.5in" h="600pt"/>
  <subform name="C" w="7.5in" h="80pt">${c}<field name="c" x="0" y="0" w="1in" h="0.3in"><ui><textEdit/></ui></field></subform>
  <subform name="D" w="7.5in" h="80pt">${d}<field name="d" x="0" y="0" w="1in" h="0.3in"><ui><textEdit/></ui></field></subform>
  </subform></template>`;
const pageOf = (r: ReturnType<typeof convertXfaToAcroForm>, name: string) => r.fields.find((f) => f.name === name)?.page;

describe('ConvertXfaToAcroForm: adhesion end to end (164g.14)', () => {
  it('moves an adhering pair to the next page together', () => {
    const doc = dynamic(form('<keep next="contentArea"/>', ''));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Pages).toHaveLength(2);
    expect(pageOf(r, 'form1[0].C[0].c[0]')).toBe(2);
    expect(pageOf(r, 'form1[0].D[0].d[0]')).toBe(2);
  });

  it('names an unprobed shape in report.warnings and keeps today\'s layout', () => {
    const doc = dynamic(form('<keep next="contentArea"/>', '<breakBefore targetType="pageArea"/>'));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.warnings).toContainEqual(expect.stringMatching(/adhesion into a sibling with a breakBefore is not implemented \(164g\.14\)/));
    expect(pageOf(r, 'form1[0].C[0].c[0]')).toBe(1);
    expect(pageOf(r, 'form1[0].D[0].d[0]')).toBe(2);
  });
});
```

Check the field-name spelling the converter reports (`r.fields[i].name`) against `test/xfaconvert-pages.test.ts`'s `'form1[0].Page1[0].a[0]'` before running; adjust the two names only if the report differs.

- [ ] **Step 2: Run**

Run: `npx vitest run test/xfaconvert-keep.test.ts`
Expected: PASS (Tasks 3-4 did the work; this pins the end-to-end path). If the warning is missing, check that `xfaconvert.ts` passes `layoutPages`'s `warnings` into `report.warnings` (it does for min/max swaps) — fix there if not.

- [ ] **Step 3: Commit**

```bash
git add test/xfaconvert-keep.test.ts
git commit -m "test(164g.14): adhesion end to end through ConvertXfaToAcroForm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Oracle — t55-t72

**Files:**
- Modify: `test/helpers/xfa-adobe.ts` (`ADOBE_PROBES` length)
- Modify: `test/xfa-adobe-oracle.test.ts` (`absolute`, `only`, header comment)

- [ ] **Step 1: Extend the oracle**

In `test/helpers/xfa-adobe.ts` change `Array.from({ length: 52 }` to `Array.from({ length: 70 }`.

In `test/xfa-adobe-oracle.test.ts`:
- header comment: after `(164g.12, t27-t39).` add ` Field splitting is t40-t54 (164g.13); adhesion and keep intact="pageArea" are t55-t72 (164g.14) -- t65 is compared in part, its field D splitting directly under the content area, which <NEW-ID from Task 1> will do.`
- in `boxOf`, as the first statement after the destructuring line add `if (probe.absolute) return { page, x: ORIGIN + fx, y: ORIGIN + fy, w, h };`
- in the fields loop, change `for (const [path, frags] of Object.entries(probe.fields)) {` to `for (const [path, frags] of Object.entries(probe.fields).filter(([q]) => !probe.only || probe.only.includes(q))) {`, and the same filter on `Object.entries(probe.draws!)`.

- [ ] **Step 2: Run**

Run: `npx vitest run test/xfa-adobe-oracle.test.ts test/xfa-adobe-fixture.test.ts`
Expected: PASS for all 70 probes. A failure on t66/t67 that reports draws on content area B offset by 360 means our layout's B origin differs from the `absolute` convention (B at 5.5in, i.e. 396 from the page top = ORIGIN + 360) — check the probe's `<contentArea y="5.5in">` reached `layoutPages`. A failure on t69/t59 for D means layout refused D's box past the content area: check `layoutPage` accepts a root child whose `past` was false (the p. 295 override path places such children today).

- [ ] **Step 3: Commit**

```bash
git add test/helpers/xfa-adobe.ts test/xfa-adobe-oracle.test.ts
git commit -m "test(164g.14): Adobe oracle for adhesion and keep intact, t55-t72

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mutation sweep, documentation, close, push

**Files:** `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Mutation sweep**

For each mutation: apply, check `git diff --stat src/` is non-empty, run `npx vitest run test/xfakeep.test.ts test/xfapage-keep.test.ts test/xfapage.test.ts test/xfa-adobe-oracle.test.ts test/xfaconvert-keep.test.ts --testTimeout=30000 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -30`, record which cases go red (a run whose file fails to LOAD is not green), restore with `git checkout -- src/`. Kill orphaned vitest workers after a hang.

| # | Mutation | Expected red |
|---|---|---|
| M1 | `adheres` ignores `previous` | t56, "previous on the second", "previous on the later leaf" |
| M2 | `adheres` accepts `pageArea` | t64, unit pageArea case |
| M3 | `nextAdhering` does not skip hidden | t63, unit hidden case |
| M4 | `intactSplits` returns `v === 'none'` | t66-t68, "splits a tb stating pageArea" |
| M5 | `intactSplits` lets a positioned pageArea split (drop the FLOWED test) | unit t71 case (t71 itself stays green: `positionedSplittable` reads intact directly) |
| M6 | `leadFits` returns `'no'` for a splittable next (drop the first-leaf branch) | t58, "first piece of a splittable next" |
| M7 | `leadFits` drops the field branch | "a piece of a field", t65 |
| M8 | `keepWith` holds off from an empty region too (drop `p.used > EPS`) | t59, "R4 at an empty region" |
| M9 | `keepWith` never forces (return `'place'` instead of `'force'`) | t69, "runs the next past", "long chain" |
| M10 | forced placement ignores `r.past` | "refuses a run-away member", "long chain" |
| M11 | `placeSplit` ignores `link` (lead always true) | t60, t72, "holds a leaf off" |
| M12 | `partAt` compares at the leaves, not where they part | "nested container adheres" |
| M13 | `tail` not passed to `placeSplit` | t70, "last piece of a split root child" |
| M14 | `fitsNextEmpty` always true | "a pair inside a split ... not forced" |
| M15 | `xfatemplate.ts` drops leaf keeps | t60, t65, template leaf case |

Any expected-red mutation that stays green is a coverage gap: add the missing case, rerun, commit it with a message naming the mutation. M5 is expected green on the oracle and held by the unit case alone — record that.

- [ ] **Step 2: CLAUDE.md**

After the `xfafieldsplit.ts` entry (the one beginning `- **xfafieldsplit.ts** — splitting a field between its lines`), add:

```markdown
- **xfakeep.ts** — XFA adhesion and keep intact (`164g.14`): `adheres`,
  `nextAdhering`, `intactSplits`. A pure leaf over `xfaflow.js` TYPES; the
  root loop and `placeSplit` both ask it, so they cannot disagree about whether
  two siblings adhere.
  **Invariant:** two siblings adhere when the first states `keep
  next="contentArea"` or the second `keep previous="contentArea"` (t55 = t56);
  `pageArea` is NO adhesion (t64); a hidden sibling is skipped (t63) and only
  siblings adhere (t62).
  **Invariant, and it overrules p. 291:** a FLOWED subform's `keep
  intact="pageArea"` splits exactly as `none`, across pages included (t66-t68);
  a positioned one still moves whole (t71), Adobe splitting a positioned
  subform only on an explicit `none`.
  **Invariant (`xfapage.ts`):** before an object closes a region, `leadFits`
  asks that its adhering next put SOMETHING into the room left -- whole and
  onward along a chain, else a splittable subform's first leaf or a field's
  first `fieldCut` piece -- through the same `height` and `fragmentOf` as the
  fit test. An object that fails waits for the next region WHOLE, never split
  to make room (t61), and only when the pair fits that region.
  **Invariant, and it reads wrong:** a pair that cannot fit even an EMPTY
  region does not move to a fresh one -- the first stays where it would go
  alone and the next is FORCED into the same region, running past (t59, t69).
  The run-away member is placed only when nothing it draws lies past (p. 295's
  posture), and refused by name otherwise. Inside a split chain such a pair is
  NOT forced: the adhesion is dropped with a warning (unprobed).
  **Invariant (`placeSplit`):** adhesion between leaves is decided where their
  paths PART (`partAt`), so a container's keep next makes its last leaf adhere
  to its next sibling's first; the root child's last leaf adheres to the next
  root child through `tail`. Unprobed shapes -- adhesion between lr-tb items,
  into a sibling with a `breakBefore`, into or out of a positioned subform that
  splits, an R4 run-away that is splittable -- fall back to TODAY's layout with
  a warning (between root children) or whole placement (inside a chain).
  **Invariant (`xfatemplate.ts`):** a field's and a draw's `keep next/previous`
  are read; their `intact` is not, field splitting being `fieldCut`'s.
  **Note on the oracle:** Adobe probes t55-t72 (`test/fixtures/xfa-adobe/`);
  t66/t67 are `absolute`, Reader reporting one fragment per page; t65 is
  compared in part (`only`), its field D splitting directly under the content
  area (<NEW-ID>). No vendored real form states these keeps.
  **Note, measured:** <fill from Step 1: N of 15 mutations redden; name M5 and
  any other held by unit cases alone>.
```

Then:
- In the `xfapage.ts` `164g.8` invariant ending "A `breakAfter` in a chain stays refused (164g.16), as do `keep intact="pageArea"` and adhesion (164g.14).", replace the last clause with "A `breakAfter` in a chain stays refused (164g.16); `keep intact="pageArea"` and adhesion are honoured since 164g.14 (`xfakeep.ts`)."
- In the next invariant ("a chain 164g.8 CANNOT split -- a `breakAfter`, `keep intact="pageArea"` or adhesion in it --"), replace that parenthesis with "-- a `breakAfter` in it, or (since 164g.14) adhesion between lr-tb items or into a sibling with a `breakBefore` --".
- In the `fixtures/xfa-adobe/` table row change `52 dynamic XFA probes` to `70 dynamic XFA probes`, and before `Since \`164g.9\`` insert: `Since \`164g.14\`, 18 more (t55-t72) settled adhesion and keep intact="pageArea" -- a chain moves together, a splittable next needs only its first piece, a pair that cannot fit an empty area runs past rather than moving, and a flowed pageArea splits like none, overruling p. 291 and p. 312.`

Run the module sweep (expected empty):

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]` → `### Added`, first entry:

```markdown
- **`ConvertXfaToAcroForm` keeps adhering subforms together, and splits a flowed `keep intact="pageArea"` subform, as Adobe Reader does.** `keep next`/`keep previous` was ignored between page-level subforms, and inside a subform being split it stopped the split, so the subform moved to the next page whole. Now an object whose adhering next sibling would put nothing into the room left waits for the next content area with it -- a chain of adhering siblings moves together, a splittable next sibling needs only its first piece to fit, and a splittable subform that fits whole but not with its next moves whole rather than splitting. A pair that cannot fit even an empty content area stays where the first would go and the second runs past the area's end, as Reader draws it; it is refused by name when it draws past. Adhesion holds between siblings inside a subform being split, table rows included, and only between siblings; a hidden sibling is skipped. `keep next="pageArea"` is no adhesion, and a flowed subform's `keep intact="pageArea"` splits like `none`, across pages included, which overrules XFA 3.3 p. 291; a positioned one still moves whole. Every rule was measured in Adobe Reader 26.1 through 18 probe forms (`test/fixtures/xfa-adobe/`, t55-t72), and every field and draw of all 18 lands on Reader's page and box but one field Reader splits directly under the content area (<NEW-ID>). Shapes no probe settled -- adhesion between the items of an `lr-tb` line, into a sibling with a `breakBefore`, into or out of a positioned subform that splits -- keep today's layout and are named in `report.warnings`. (aspose-pdf-foss-for-ts-164g.14)
```

- [ ] **Step 4: README**

In the bullet beginning `- **XFA converts to AcroForm, with limited content splitting**`, replace `content splits across them where Adobe Reader splits it -- ` with `content splits across them where Adobe Reader splits it, keeping adhering siblings (\`keep next\`/\`previous\`) together and splitting a flowed \`keep intact="pageArea"\` subform as Reader does -- `.

- [ ] **Step 5: Gates, close, push**

```bash
npm run typecheck && npm test
```

Expected: both green.

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(164g.14): adhesion and keep intact invariants, changelog, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-164g.14 --reason "Adhesion and keep intact=pageArea paginated as Adobe Reader does; oracle t55-t72."
git add .beads/interactions.jsonl 2>/dev/null; git diff --cached --quiet || git commit -m "chore(164g.14): close issue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git pull --rebase && git push && bd dolt push && git status -sb | head -1
```

Expected: `## main...origin/main`.
