# XFA `tb` subform splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split a `tb` subform between its children across content areas, so DoD DD 1494 converts onto the 14 pages pdf.js lays it out on, every body field on pdf.js's page and box.

**Architecture:** `xfapage.ts` flattens a splittable root child into atoms (a container's top margin, its children placed whole or flattened in turn, its bottom margin), groups them into units that never break inside a margin, and fills content areas unit by unit from the room left. Each region receives shallow FRAGMENTS of the containers holding only that region's children, which `xfaflow.ts` lays out unchanged. `xfatemplate.ts` reads `<keep>` and `<overflow>`. Refusals that cited the closed 164g.8 now name its child issues.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest; the goldens generator uses tsx, puppeteer and the pinned pdfjs-dist 6.3.289.

**Spec:** `docs/superpowers/specs/2026-10-12-xfa-split-tb-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins in `src/`.
- `npm run typecheck` and `npm test` both green before the issue closes.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (no new catches are planned in `src/`).
- CHANGELOG entries under `## [Unreleased]`, bold lead-in, prose, `(aspose-pdf-foss-for-ts-164g.8)` at the end.
- Splittable, exactly: `kind === 'subform'`, `layout === 'tb'`, no stated `geom.h`, no `refusal`, `keep.intact` absent or `none`. Its parent is always a flow (the content area or a `tb` being split).
- A split puts the top into the CURRENT region (XFA 3.3 p. 290).
- Child issues already filed: 164g.11 (positioned subform, split consensus), 164g.12 (lr-tb lines, table rows), 164g.13 (text between lines), 164g.14 (keep intact=pageArea, adhesion), 164g.15 (overflow and break leaders/trailers), 164g.16 (breaks inside a split chain).
- Measured during planning: among every vendored XFA form (f1040, fw9, I-130, I-765, DD 1391, DD 1155, DD 2875, OPM 1644's three variants) only DD 1494 has a splittable root child. No existing oracle can move; if one does, stop and report.

## Review Focus

1. A split that runs out of pages (`pageArea` occur max): fields already placed keep their boxes, the rest are refused with the p. 300 discard reason, and later root children are refused after it. Held by the "runs past every occur max" case in Task 2.
2. A refusal in the middle of a split: earlier fragments stay placed and no field is both placed and refused. Held by the `layoutPages` mid-split case in Task 2.
3. A hidden or inactive child inside a split chain takes no height and does not break the chain. Held by the "concealed child" case in Task 2.
4. A root child that is splittable but FITS is placed whole and never flattened (every existing form). Held by the existing suite plus the "fits whole" case in Task 2.
5. A field inside a split chain keeps its SOM name and appears in exactly one fragment. Held by the DD 1494 oracle in Task 3 (every field compared by name and page).

---

### Task 1: Vocabulary: `<keep>`, `<overflow>`, and refusals that name the child issues

**Files:**
- Modify: `src/xfaflow.ts` (`LayoutNode`, new `XfaKeep`, new `SPLIT_LATER`, export `insetsOf`, messages at the `splitFail` and leaf-overflow sites, the `measureExtent` doc comment)
- Modify: `src/xfatemplate.ts` (`nodeOf`, `breakOf`'s leader/trailer refusal)
- Modify: `src/xfapage.ts` (the empty-region refusal message only)
- Test: `test/xfatemplate.test.ts`, `test/xfaflow.test.ts`, `test/xfapage.test.ts`, `test/xfa-real.test.ts`, `test/xfa-master-oracle.test.ts` (message assertions)

**Interfaces:**
- Produces:
  - `export interface XfaKeep { intact?: string; next?: string; previous?: string }` (xfaflow.ts)
  - `LayoutNode.keep?: XfaKeep`, `LayoutNode.overflow?: boolean`
  - `export const SPLIT_LATER = 'splitting beyond a tb subform between its children (164g.11, 164g.12, 164g.13)'` (xfaflow.ts)
  - `export function insetsOf(n: LayoutNode): { l: number; r: number; t: number; b: number } | { reason: string }` (xfaflow.ts; the existing function, now exported)

- [ ] **Step 1: Write the failing tests**

In `test/xfatemplate.test.ts`, find the existing `describe` that tests break parsing (it contains `'P[0]: <breakBefore> with a leader or trailer is not implemented (164g.8)'`). Change those two expected strings to end `(164g.15)`. Then add, in the same describe:

```ts
  // 164g.8: pagination reads keep and overflow; nothing else does.
  it('reads a subform\'s direct <keep> and flags an <overflow> that names anything', () => {
    const t = tplOf(`<subform name="root" layout="tb"><pageSet><pageArea name="A"><contentArea h="100pt"/></pageArea></pageSet>
      <subform name="P" layout="tb"><keep intact="contentArea" next="contentArea"/><overflow leader="#L"/></subform>
      <subform name="Q" layout="tb"><overflow/></subform>
    </subform>`);
    const [p, q] = t.body!.root.children;
    expect(p.keep).toEqual({ intact: 'contentArea', next: 'contentArea' });
    expect(p.overflow).toBe(true);
    expect(q.keep).toBeUndefined();
    expect(q.overflow).toBeUndefined();
  });
```

If the file has no `tplOf` helper, use the helper the break tests already use to parse a template string (read the top of the file and use that name; the call shape is "template XML string in, `XfaTemplate` out").

Update the message assertions that cite 164g.8:

- `test/xfaflow.test.ts`: the three `toMatch(/…splitting \(164g\.8\)/)` become `toMatch(/splitting beyond a tb subform between its children \(164g\.11, 164g\.12, 164g\.13\)/)`, keeping each assertion's leading words (`does not fit the remaining height of T` is fine as `/splitting beyond a tb subform/` too).
- `test/xfapage.test.ts`: the exact string `'A!: does not fit an empty content area and would need splitting (164g.8)'` becomes `'A!: does not fit an empty content area and would need splitting beyond a tb subform between its children (164g.11, 164g.12, 164g.13)'`, and `toMatch(/would need splitting \(164g\.8\)/)` becomes `toMatch(/would need splitting beyond a tb subform/)`.
- `test/xfa-real.test.ts`: `/mixed heights|164g\.8/` becomes `/mixed heights|would need splitting|needs splitting/`.
- `test/xfa-master-oracle.test.ts`: in the `dynamic DD bodies end to end (bkdi)` describe, the DD 1494 case's `/164g\.8/` becomes `/would need splitting/`. (Task 3 replaces that case; it must stay green until then.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfatemplate.test.ts test/xfaflow.test.ts test/xfapage.test.ts`
Expected: FAIL on the new keep/overflow case (`keep` undefined), the two leader/trailer strings, and every rewritten message assertion.

- [ ] **Step 3: Implement**

`src/xfaflow.ts`, after `XfaBreak`:

```ts
/** A subform's `<keep>` (XFA 3.3 p. 291-292, 311), as `xfatemplate.ts` reads
 *  it. Only pagination reads it (164g.8). */
export interface XfaKeep { intact?: string; next?: string; previous?: string }

/** What a refusal names when content would need a split 164g.8 does not do. */
export const SPLIT_LATER = 'splitting beyond a tb subform between its children (164g.11, 164g.12, 164g.13)';
```

In `LayoutNode`, after `breakAfter?: XfaBreak;`:

```ts
  /** A subform's `<keep>` and whether it states an `<overflow>` leader, trailer
   *  or target. Only `xfapage.ts` reads them, on a split chain (164g.8). */
  keep?: XfaKeep;
  overflow?: boolean;
```

Change `function insetsOf(` to `export function insetsOf(`.

In `splitFail`, the reason becomes:

```ts
    return { reason: `${c.label}: does not fit the remaining height of ${n.label}, which needs ${SPLIT_LATER}` };
```

At the leaf-overflow site in `emit`:

```ts
            reason: `${n.label}: overflows its contentArea, which needs ${SPLIT_LATER}`,
```

In the comment above it (`*  splitting (164g.8). */`) and in `measureExtent`'s doc comment (`otherwise it would need splitting (164g.8).`), replace `(164g.8)` with `(164g.8 splits a tb subform between its children; the rest is 164g.11-13)`.

`src/xfatemplate.ts`, in `breakOf`: `(164g.8)` in the leader/trailer refusal becomes `(164g.15)`. In `nodeOf`, inside `if (kind === 'subform') {`, after the break lines, add:

```ts
    // 164g.8: pagination honours keep intact and refuses what it cannot do.
    const keep = child(el, 'keep');
    if (keep) {
      const k: XfaKeep = {};
      for (const a of ['intact', 'next', 'previous'] as const) {
        const v = keep.attrs.get(a);
        if (v !== undefined) k[a] = v;
      }
      if (Object.keys(k).length > 0) n.keep = k;
    }
    const of = child(el, 'overflow');
    if (of && ['leader', 'trailer', 'target'].some((a) => (of.attrs.get(a) ?? '').trim() !== ''))
      n.overflow = true;
```

and add `type XfaKeep` to the existing type import from `./xfaflow.js` at the top of `xfatemplate.ts`.

`src/xfapage.ts`: add `SPLIT_LATER` to the import from `./xfaflow.js`, and the empty-region refusal becomes:

```ts
        fail(`${c.label}: does not fit an empty content area and would need ${SPLIT_LATER}`);
```

- [ ] **Step 4: Run the XFA suite**

Run: `npx vitest run test/xfa`
Expected: PASS everywhere. Then `npm run typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts src/xfatemplate.ts src/xfapage.ts test/xfatemplate.test.ts test/xfaflow.test.ts test/xfapage.test.ts test/xfa-real.test.ts test/xfa-master-oracle.test.ts
git commit -m "feat(164g.8): read <keep> and <overflow>; split refusals name the child issues

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Split a `tb` subform between its children (`xfapage.ts`)

**Files:**
- Modify: `src/xfapage.ts` (new `splittable`, `Atom`, `Unit`, `flatten`, `chainRefusal`, `unitsOf`, `emptyRegion`, `placeSplit`; `Paginator.placeUnit`; the root loop in `paginate`; the `Pagination.refused` doc)
- Test: `test/xfapage.test.ts`

**Interfaces:**
- Consumes (Task 1): `LayoutNode.keep`, `LayoutNode.overflow`, `SPLIT_LATER`, `insetsOf`.
- Produces: `export function splittable(n: LayoutNode): boolean`. `paginate`'s output may now hold FRAGMENTS (shallow copies of containers) in `contentAreas[].children`, and `refused` may name a node below a root child.

- [ ] **Step 1: Write the failing tests**

At the top of `test/xfapage.test.ts`, after `const height: XfaHeight = …`, add helpers:

```ts
/** A splittable tb subform (no stated h). */
const tb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'tb', geom: { w: '100pt' }, children, ...extra });
const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
/** A node's height: a stated h, else its margins plus its children's heights.
 *  A label ending in '!' draws past any limit. */
const hOf = (n: LayoutNode): number => (n.geom.h !== undefined ? pt(n.geom.h)
  : pt(n.margin?.topInset) + pt(n.margin?.bottomInset)
    + n.children.filter((k) => k.presence !== 'hidden').reduce((s, k) => s + hOf(k), 0));
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: n.label.endsWith('!') });
/** A region's children as nested labels: a fragment shows what it holds. */
const shape = (n: LayoutNode): string =>
  (n.layout === 'tb' && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
const split = (b: XfaBody) => paginate(b, flowHeight).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const splitRefusals = (b: XfaBody) => [...paginate(b, flowHeight).refused].map(([n, w]) => [n.label, w]);
```

Then add a describe:

```ts
// 164g.8: a tb subform with no stated h splits BETWEEN its children (XFA 3.3
// p. 290-292). DD 1494's TopForm > P1..P6 > front/back is the oracle (Task 3).
describe('paginate: splitting a tb subform between its children (164g.8)', () => {
  // p. 290: "putting the top of it into the current region". T (90) would fit an
  // empty page whole, which is what separates splitting here from moving first.
  it('puts the top into the room left, then continues on the next page', () => {
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 30), kid('b', 30), kid('c', 30)])])))
      .toEqual(['0:A,T(a)', '0:T(b,c)']);
  });

  it('places a splittable child that fits whole, unflattened', () => {
    const t = tb('T', [kid('a', 30), kid('b', 30)]);
    const r = paginate(body([area([ca(100)])], [kid('A', 20), t]), flowHeight);
    expect(r.pages[0].contentAreas[0].children[1]).toBe(t);
  });

  it('splits a splittable child in turn', () => {
    expect(split(body([area([ca(100)])], [tb('T', [tb('U', [kid('a', 40), kid('b', 40), kid('c', 40)]), kid('d', 10)])])))
      .toEqual(['0:T(U(a,b))', '0:T(U(c),d)']);
  });

  // p. 291: no split inside a margin. The bottom margin travels with c.
  it('keeps the bottom margin with the last child', () => {
    const t = tb('T', [kid('a', 40), kid('b', 40), kid('c', 10)], { margin: { topInset: '10pt', bottomInset: '10pt' } });
    const r = paginate(body([area([ca(100)])], [t]), flowHeight);
    expect(split(body([area([ca(100)])], [t]))).toEqual(['0:T(a,b)', '0:T(c)']);
    const [f1, f2] = r.pages.map((p) => p.contentAreas[0].children[0]);
    expect([f1.margin?.topInset, f1.margin?.bottomInset]).toEqual(['10pt', undefined]);
    expect([f2.margin?.topInset, f2.margin?.bottomInset]).toEqual([undefined, '10pt']);
  });

  it('never leaves a fragment holding only a top margin', () => {
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('T', [kid('a', 80)], { margin: { topInset: '30pt' } })])))
      .toEqual(['0:A', '0:T(a)']);
  });

  it('places whole a subform that states h, and one kept intact', () => {
    const c3 = [kid('a', 30), kid('b', 30), kid('c', 30)];
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('S', c3, { geom: { w: '100pt', h: '90pt' } })])))
      .toEqual(['0:A', '0:S']);
    expect(split(body([area([ca(100)])], [kid('A', 50), tb('K', c3, { keep: { intact: 'contentArea' } })])))
      .toEqual(['0:A', '0:K(a,b,c)']);
  });

  it('carries a concealed child at no height', () => {
    expect(split(body([area([ca(100)])], [tb('T', [kid('a', 60), kid('h', 60, { presence: 'hidden' }), kid('b', 60)])])))
      .toEqual(['0:T(a,h)', '0:T(b)']);
  });

  // p. 295 on one atom: placed past the boundary when its ink fits, refused otherwise.
  it('overrides the boundary for a whole child whose ink fits, and refuses one whose ink does not', () => {
    expect(split(body([area([ca(100)])], [tb('T', [kid('a', 50), kid('b', 150), kid('c', 10)])])))
      .toEqual(['0:T(a)', '0:T(b)', '0:T(c)']);
    const r = splitRefusals(body([area([ca(100)])], [tb('T', [kid('a', 50), kid('b!', 150), kid('c', 10)]), kid('Z', 10)]));
    expect(r[0]).toEqual(['b!', `b!: does not fit an empty content area and would need ${SPLIT_LATER}`]);
    expect(r.slice(1).map(([n]) => n)).toEqual(['c', 'Z']);
    for (const [, w] of r.slice(1)) expect(w).toMatch(AFTER);
  });

  it('runs past every occur max: what is placed stays, the rest is discarded', () => {
    const b = body([area([ca(100)], { max: 1 })], [tb('T', [kid('a', 60), kid('b', 60)])], { max: 1 });
    expect(split(b)).toEqual(['0:T(a)']);
    expect(splitRefusals(b)).toEqual([['b', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  it('refuses what it cannot do in a split chain, naming the child issue', () => {
    const big = (k: LayoutNode, t: Partial<LayoutNode> = {}) => body([area([ca(100)])], [tb('T', [kid('a', 60), k], t)]);
    expect(splitRefusals(big(kid('B', 60, { breakBefore: pb() })))[0][1]).toMatch(/break inside a split subform .*\(164g\.16\)/);
    expect(splitRefusals(big(kid('K', 60, { keep: { intact: 'pageArea' } })))[0][1]).toMatch(/keep intact="pageArea" .*\(164g\.14\)/);
    expect(splitRefusals(big(kid('N', 60, { keep: { next: 'contentArea' } })))[0][1]).toMatch(/adhesion.*\(164g\.14\)/);
    expect(splitRefusals(big(kid('O', 60), { overflow: true }))[0][1]).toMatch(/<overflow>.*\(164g\.15\)/);
  });
});
```

Add `SPLIT_LATER` to this file's import from `../src/xfaflow.js` (alongside the existing type imports; it is a value import). `pb`, `ca`, `area`, `body`, `kid` and `AFTER` already exist in this file.

In the `layoutPages` describe, add (it already defines `fld`, `S`, `placedBox`, `caAt`):

```ts
  // 164g.8: fragments carry their fields; a refusal mid-split keeps what was
  // placed and places nothing it refuses.
  it('lays out the fragments of a split, and refuses only from the failure on', () => {
    const t: LayoutNode = {
      kind: 'subform', label: 'T', layout: 'tb', geom: { w: '100pt' }, children: [
        kid('P', 60, { children: [fld('a', S)] }),
        kid('Q', 60, { children: [fld('b', S)] }),
        kid('R', 150, { children: [fld('c', { y: '120pt', ...S })] }),
      ],
    };
    // R is refused at an empty third page, which advancing has already opened.
    const r = layoutPages(body([area([caAt(100)])], [t]));
    expect(placedBox(r.pages[0].placed, 'a')).toEqual({ x: 10, y: 20, w: 10, h: 10 });
    expect(placedBox(r.pages[1].placed, 'b')).toEqual({ x: 10, y: 20, w: 10, h: 10 });
    expect(r.refused.get('c')).toMatch(/would need splitting beyond a tb subform/);
    expect(r.refused.has('a') || r.refused.has('b')).toBe(false);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfapage.test.ts`
Expected: FAIL: every new case except "places a splittable child that fits whole" (that one already holds, since nothing flattens today) and "places whole a subform that states h …" (also today's behaviour). The others fail because the child moves or is refused whole.

- [ ] **Step 3: Implement in `src/xfapage.ts`**

Imports become:

```ts
import {
  layoutPage, measureExtent, insetsOf, SPLIT_LATER,
  type LayoutNode, type Placed, type XfaBreak, type XfaMeasure,
} from './xfaflow.js';
```

Change `Pagination.refused`'s doc to: `/** A node that could not be placed -- a root child, or a child inside a split (164g.8) -- with the reason each field below it gets. */`.

After `resolveTarget`, add:

```ts
/** XFA 3.3 p. 291-292, narrowed to what 164g.8 implements: a tb subform with no
 *  stated h whose keep intact is none splits BETWEEN its children. Its parent is
 *  always a flow -- the content area, or a tb being split -- where a subform's
 *  intact defaults to none (a positioned parent would default it to
 *  contentArea). */
export function splittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && n.layout === 'tb' && n.geom.h === undefined
    && n.refusal === undefined && (n.keep?.intact ?? 'none') === 'none';
}

/** One piece of a split chain: a container's top margin, a child placed whole,
 *  or a bottom margin. `path` is the chain of containers from the root child to
 *  the atom's container, last (for open/close, the container itself). */
interface Atom { kind: 'open' | 'leaf' | 'close'; node: LayoutNode; h: number; path: LayoutNode[] }
/** Atoms that share a region. No split falls inside a margin (p. 291), so an
 *  `open` travels with the atom after it and a `close` with the one before;
 *  every unit but an empty container's holds a leaf. `lead` is the height of
 *  the opens above the leaf. */
interface Unit { atoms: Atom[]; h: number; leaf?: Atom; lead: number }

/** What 164g.8 cannot do inside a split chain, named for its issue. */
function chainRefusal(k: LayoutNode): string | undefined {
  if (k.breakBefore || k.breakAfter)
    return `${k.label}: a break inside a split subform is not implemented (164g.16)`;
  if (k.keep?.intact === 'pageArea')
    return `${k.label}: keep intact="pageArea" in a split subform is not implemented (164g.14)`;
  if ((k.keep?.next ?? 'none') !== 'none' || (k.keep?.previous ?? 'none') !== 'none')
    return `${k.label}: keep next/previous (adhesion) in a split subform is not implemented (164g.14)`;
  return undefined;
}

/** A splittable node as atoms, recursing into splittable children. A child's
 *  height is measured in its tb parent, which is what `measureExtent` with
 *  `'tb'` gives (bkdi), so the atoms sum to the node's own extent. */
function flatten(c: LayoutNode, height: XfaHeight, path: LayoutNode[] = []): Atom[] | { reason: string } {
  if (c.overflow) return { reason: `${c.label}: an <overflow> leader, trailer or target is not implemented (164g.15)` };
  const m = insetsOf(c);
  if ('reason' in m) return { reason: m.reason };
  const chain = [...path, c];
  const out: Atom[] = [{ kind: 'open', node: c, h: m.t, path: chain }];
  for (const k of c.children) {
    const why = chainRefusal(k);
    if (why !== undefined) return { reason: why };
    if (!concealed(k) && splittable(k)) {
      const inner = flatten(k, height, chain);
      if ('reason' in inner) return inner;
      out.push(...inner);
      continue;
    }
    let h = 0;
    if (!concealed(k)) {
      const r = height(k, Infinity);
      if ('reason' in r) return r;
      h = r.h;
    }
    out.push({ kind: 'leaf', node: k, h, path: chain });
  }
  out.push({ kind: 'close', node: c, h: m.b, path: chain });
  return out;
}

function unitsOf(atoms: Atom[]): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < atoms.length) {
    const u: Unit = { atoms: [], h: 0, lead: 0 };
    while (i < atoms.length && atoms[i].kind === 'open') { u.lead += atoms[i].h; u.atoms.push(atoms[i++]); }
    if (i < atoms.length && atoms[i].kind === 'leaf') { u.leaf = atoms[i]; u.atoms.push(atoms[i++]); }
    while (i < atoms.length && atoms[i].kind === 'close') u.atoms.push(atoms[i++]);
    u.h = u.atoms.reduce((s, a) => s + a.h, 0);
    units.push(u);
  }
  return units;
}

/** p. 295 at an EMPTY region, the one owner for a root child and a split's
 *  unit alike: advance when the next region can hold `h`, place when nothing
 *  drawn lies past, otherwise refuse. */
function emptyRegion(
  p: Paginator, h: number, past: () => boolean, label: string,
): { act: 'advance' } | { act: 'place' } | { reason: string } {
  const s = p.snapshot();
  const moved = p.advance();
  const nextH = moved === undefined ? p.capacity() : 0;
  p.restore(s);
  if (moved === undefined && h <= nextH + EPS) return { act: 'advance' };
  if (!past()) return { act: 'place' };
  return { reason: `${label}: does not fit an empty content area and would need ${SPLIT_LATER}` };
}

/** Place a splittable root child unit by unit, from the room left in the
 *  current region (XFA 3.3 p. 290). A unit that does not fit a region holding
 *  content moves to the next; one too tall for an EMPTY region takes the p. 295
 *  override as a whole root child does. On a failure the units already placed
 *  stay, and the failing leaf and every later one are refused. Returns the
 *  cause, or `undefined` when everything was placed. */
function placeSplit(
  p: Paginator, c: LayoutNode, height: XfaHeight, refuse: (n: LayoutNode, why: string) => void,
): string | undefined {
  const atoms = flatten(c, height);
  if ('reason' in atoms) { refuse(c, atoms.reason); return atoms.reason; }
  const units = unitsOf(atoms);
  const failFrom = (j: number, why: string): string => {
    units.forEach((u, i) => { if (i >= j && u.leaf) refuse(u.leaf.node, i === j ? why : after(why)); });
    return why;
  };
  for (const [j, u] of units.entries()) {
    for (;;) {
      const H = p.capacity();
      if (p.used + u.h <= H + EPS) { p.placeUnit(u); break; }
      if (p.used === 0) {
        const past = (): boolean => {
          if (!u.leaf) return false;
          const r = height(u.leaf.node, H - u.lead);
          return 'reason' in r ? true : r.past;
        };
        const e = emptyRegion(p, u.h, past, (u.leaf?.node ?? c).label);
        if ('reason' in e) return failFrom(j, e.reason);
        if (e.act === 'place') { p.placeUnit(u); break; }
      }
      const moved = p.advance();
      if (moved !== undefined) return failFrom(j, moved);
    }
  }
  return undefined;
}
```

In `class Paginator`, after `place`, add:

```ts
  /** Fragments per region (`page:contentArea`), each keyed by the container it
   *  copies (164g.8). */
  private readonly frags = new Map<string, Map<LayoutNode, LayoutNode>>();

  /** Place a split's unit into the current region, as fragments: shallow copies
   *  of its containers holding only this region's children. A fragment keeps a
   *  margin only where its `open` or `close` atom landed. */
  placeUnit(u: Unit): void {
    const key = `${String(this.pages.length - 1)}:${String(this.ca)}`;
    let fm = this.frags.get(key);
    if (!fm) { fm = new Map(); this.frags.set(key, fm); }
    for (const a of u.atoms) {
      const f = this.fragment(fm, a.path);
      if (a.kind === 'leaf') f.children.push(a.node);
      else if (a.kind === 'open' && a.node.margin?.topInset !== undefined) f.margin = { ...f.margin, topInset: a.node.margin.topInset };
      else if (a.kind === 'close' && a.node.margin?.bottomInset !== undefined) f.margin = { ...f.margin, bottomInset: a.node.margin.bottomInset };
    }
    this.used += u.h;
  }

  /** The fragment of `path`'s last container in this region, made (with its
   *  ancestors) on first use. */
  private fragment(fm: Map<LayoutNode, LayoutNode>, path: LayoutNode[]): LayoutNode {
    let parent: LayoutNode | undefined;
    for (const c of path) {
      let f = fm.get(c);
      if (!f) {
        const margin = { ...(c.margin ?? {}) };
        delete margin.topInset;
        delete margin.bottomInset;
        f = { ...c, children: [], margin };
        fm.set(c, f);
        if (parent) parent.children.push(f);
        else this.place(f, 0);
      }
      parent = f;
    }
    return parent!;
  }
```

In `paginate`'s root loop, replace the body of `for (;;) { … }` from `if (p.used + r.h <= H + EPS)` down to the end of the `if (p.used === 0) { … }` block with:

```ts
      if (p.used + r.h <= H + EPS) { p.place(c, r.h); placed = true; break; }
      if (splittable(c)) {
        // p. 290: the top goes into the current region (164g.8).
        const why = placeSplit(p, c, height, (n, w) => refused.set(n, w));
        if (why !== undefined) cause = why; else placed = true;
        break;
      }
      if (p.used === 0) {
        const e = emptyRegion(p, r.h, () => r.past, c.label);
        if ('reason' in e) { fail(e.reason); break; }
        if (e.act === 'place') { p.place(c, r.h); placed = true; break; }
      }
```

leaving the trailing `const moved = p.advance(); if (moved !== undefined) { fail(moved); break; }` as it is. (The old inline override is now `emptyRegion`; its message is unchanged from Task 1.)

- [ ] **Step 4: Run the file, then the XFA suite**

Run: `npx vitest run test/xfapage.test.ts`
Expected: PASS, every case.
Run: `npx vitest run test/xfa`
Expected: PASS everywhere (Global Constraints: no existing oracle may move). Run `npm run typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/xfapage.ts test/xfapage.test.ts
git commit -m "feat(164g.8): split a tb subform between its children across content areas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: DD 1494 against pdf.js

**Files:**
- Modify: `scripts/gen-xfa-goldens.ts` (registry downloads over `node:https`; keep DD 1494's body nodes)
- Modify: `test/helpers/xfa-dynamic.ts` (`MasterGoldens` gains `body?`)
- Modify: `test/fixtures/xfa-dynamic/master-goldens.json` (regenerated)
- Test: `test/xfa-master-oracle.test.ts`

**Interfaces:**
- Consumes (Task 2): `layoutPages` now splits.
- Produces: `MasterGoldens['files'][f].body?: GoldenNode[]`, DD 1494's body nodes.

- [ ] **Step 1: Generator downloads over `node:https`**

In `scripts/gen-xfa-goldens.ts`, add `import { get } from 'node:https';` beside the other `node:` imports, and add before the "fetch and verify" section:

```ts
/** A registry download over node:https with a 60 s timeout (164g.8). On a slow
 *  network `fetch`'s fixed 10 s connect timeout fails where curl succeeds. */
function download(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${String(res.statusCode)}`)); return; }
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${url}: timed out`)));
    req.on('error', reject);
  });
}
```

Replace the tarball fetch with `const tgz = await download(\`https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz\`);` and the version-document fetch with:

```ts
const pkg = JSON.parse(Buffer.from(await download(`https://registry.npmjs.org/pdfjs-dist/${VERSION}`)).toString('utf8')) as { gitHead?: string };
```

The integrity check after the tarball is unchanged.

- [ ] **Step 2: Keep DD 1494's body**

In `test/helpers/xfa-dynamic.ts`, `MasterGoldens.files`' value type becomes `{ pages: number; sha256: string; nodes: GoldenNode[]; body?: GoldenNode[] }`, and its doc comment gains: "`body` is every OTHER node pdf.js named, kept for DD 1494 only: the oracle for splitting (164g.8)."

In the generator's master loop, the object becomes:

```ts
  masterFiles[file] = {
    pages,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nodes: nodes.filter((n) => n.som.startsWith('#pageArea[')),
    // 164g.8: DD 1494's body is the oracle for splitting a tb subform.
    ...(file === 'dod-dd1494.pdf' ? { body: nodes.filter((n) => !n.som.startsWith('#pageArea[')) } : {}),
  };
```

and update the comment above the loop ("Only nodes pdf.js names under a page area are kept -- the body of these forms is bkdi's and is not compared.") to: "Page-area nodes for both; DD 1494's body nodes too, the oracle for splitting (164g.8)."

- [ ] **Step 3: Regenerate**

Run: `npm run gen:xfa`
Expected: it prints `dod-dd1494.pdf: 14 pages, …` and `wrote goldens.json …`. If it fails with a connect or DNS error, retry once with `NODE_OPTIONS=--dns-result-order=ipv4first npm run gen:xfa` (CLAUDE.md records this machine's IPv6 preference) and ledger a Ruling.

Then check that only the new `body` changed:

Run: `git diff --stat test/fixtures/xfa-dynamic/`
Expected: `master-goldens.json` changed; `goldens.json` unchanged.
Run: `node -e "const a=JSON.parse(require('child_process').execSync('git show HEAD:test/fixtures/xfa-dynamic/master-goldens.json'));const b=require('./test/fixtures/xfa-dynamic/master-goldens.json');for(const f of Object.keys(a.files)){console.log(f, JSON.stringify(a.files[f].nodes)===JSON.stringify(b.files[f].nodes), a.files[f].pages===b.files[f].pages, (b.files[f].body??[]).length)}"`
Expected: both files `true true`, DD 2875 body 0, DD 1494 body several hundred (the spike saw 544 = 628 − 84).

- [ ] **Step 4: Replace the DD 1494 pin with the oracle**

In `test/xfa-master-oracle.test.ts`, add `import { layoutPages } from '../src/xfapage.js';`, and replace the case `'dod-dd1494.pdf: its body is refused for splitting (164g.8), not at the wrap'` with:

```ts
  // 164g.8: pdf.js splits TopForm > P1..P6 between their children onto 14
  // pages, every node below whole on one page. Fields are joined by DATA path,
  // which is what pdf.js's som spells (fdq3).
  it("dod-dd1494.pdf: every body field lands on pdf.js's page and box", () => {
    const gold = g.files['dod-dd1494.pdf'];
    const doc = Document.Open(loadMasterPdf('dod-dd1494.pdf'));
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
    if ('reason' in set) throw new Error(set.reason);
    const datasets = set.packets.get('datasets');
    const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
    const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
    const laid = layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), []);
    expect(laid.pages.length).toBe(gold.pages);
    const where = new Map<string, { page: number; box: { x: number; y: number; w: number; h: number } }>();
    laid.pages.forEach((p, i) => { for (const [k, v] of p.placed) if ('box' in v) where.set(k, { page: i + 1, box: v.box }); });
    const nameOf = (som: string): string => tpl.fields.find((f) => f.dataPath === som)?.name ?? som;
    const fields = gold.body!.filter((n) => n.kind === 'field');
    let compared = 0;
    for (const n of fields) {
      const ours = where.get(nameOf(n.som));
      expect(ours, `${n.som}: not placed (${laid.refused.get(nameOf(n.som)) ?? 'no reason'})`).toBeDefined();
      expect(ours!.page, `${n.som} page`).toBe(n.page);
      for (const [a, b, what] of [[ours!.box.x, n.x, 'x'], [ours!.box.y, n.y, 'y'], [ours!.box.w, n.w, 'w'], [ours!.box.h, n.h, 'h']] as const)
        expect(Math.abs(a - b), `${n.som} ${what}`).toBeLessThanOrEqual(TOL);
      compared += 1;
    }
    expect(compared).toBe(fields.length);
    expect(compared).toBeGreaterThan(290);

    const report = Document.Open(loadMasterPdf('dod-dd1494.pdf')).ConvertXfaToAcroForm({ removeXfa: false });
    expect(report.pagesCreated).toBe(gold.pages);
    expect(report.skipped.filter((s) => /would need splitting|needs splitting/.test(s.reason))).toEqual([]);
  });
```

Also update the describe's header comment: DD 1494's sentence becomes "DD 1494's body splits across 14 pages and is compared with pdf.js field by field (164g.8)."

- [ ] **Step 5: Run it**

Run: `npx vitest run test/xfa-master-oracle.test.ts`
Expected: PASS, all cases. If any field is not on pdf.js's page or box, use superpowers:systematic-debugging: the spike found every field on those 14 pages exact when each page-sized child is laid out alone, so a miss is in the fragments, not in measurement.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-xfa-goldens.ts test/helpers/xfa-dynamic.ts test/fixtures/xfa-dynamic/master-goldens.json test/xfa-master-oracle.test.ts
git commit -m "test(164g.8): DD 1494's body against pdf.js -- 14 pages, every field on its page and box

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mutation sweep and documentation

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `test/fixtures/xfa-dynamic/PROVENANCE.md`

- [ ] **Step 1: Mutation sweep**

Apply each ALONE, confirm `git diff --stat src/` is non-empty, run the named files, judge by exit status with ANSI stripped (a timeout or a file that fails to load is NOT green), restore with `git checkout -- src/`.

| # | Mutation (in `src/xfapage.ts`) | Run | Expected red |
|---|---|---|---|
| M1 | Split from a fresh page: at the top of `placeSplit`, `if (p.used > 0) { const m = p.advance(); if (m !== undefined) return failFrom(0, m); }` — insert after `const units = unitsOf(atoms);` | `test/xfapage.test.ts` | "puts the top into the room left" |
| M2 | No margin binding: in `unitsOf`, drop the `close` loop and push closes as their own units (replace `while (… 'close') u.atoms.push(atoms[i++]);` with nothing, so a close starts the next unit) | `test/xfapage.test.ts` | "keeps the bottom margin with the last child" |
| M3 | Margin-only fragment: in `unitsOf`, end a unit after its opens (remove the `if (… 'leaf')` line) | `test/xfapage.test.ts` | "never leaves a fragment holding only a top margin" |
| M4 | Split a subform that states h: drop `n.geom.h === undefined &&` from `splittable` | `test/xfapage.test.ts` | "places whole a subform that states h, and one kept intact" |
| M5 | Ignore keep: drop `&& (n.keep?.intact ?? 'none') === 'none'` | `test/xfapage.test.ts` | "places whole a subform that states h, and one kept intact" |
| M6 | No recursion: in `flatten`, change `if (!concealed(k) && splittable(k))` to `if (false)` | `test/xfapage.test.ts test/xfa-master-oracle.test.ts` | "splits a splittable child in turn", DD 1494 oracle |
| M7 | Refuse the root child on a mid-split failure instead of from the failing leaf: `failFrom` calls `refuse(c, why)` only | `test/xfapage.test.ts` | the `layoutPages` mid-split case, the occur-max case |
| M8 | Fragment keeps both margins: in `fragment`, drop the two `delete` lines | `test/xfapage.test.ts` | "keeps the bottom margin …" (margin assertions) |

If one stays green, add the case that reddens it, or record it as equivalent in CLAUDE.md with the reason.

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]`, at the top of the first `### Added` section:

```markdown
- **`ConvertXfaToAcroForm` splits a flowed XFA subform across pages.** A `tb` subform too tall for the room left is split between its children, the top into the current content area and the rest onward (XFA 3.3 p. 290), recursively through nested `tb` subforms; a margin never splits, and a fragment always holds a child. Until now any subform too tall for one page was refused. DoD DD 1494, whose whole body is one subform, now converts onto 14 pages, and every one of its body fields lands on the page and box pdf.js gives it. What is still placed whole -- a positioned subform, an `lr-tb` line, a table row, a multi-line text field -- is refused when it does not fit an empty page, naming the issue that will split it. (aspose-pdf-foss-for-ts-164g.8)
```

- [ ] **Step 3: CLAUDE.md**

In the `xfapage.ts` entry, after the paragraph beginning `**Invariant (p. 295):**`, add:

```markdown
  **Invariant (`164g.8`):** a root child that does not fit the room left and is
  SPLITTABLE -- a `tb` subform with no stated `h`, no `refusal`, `keep intact`
  absent or `none` -- splits BETWEEN its children, the top into the CURRENT
  region (p. 290: "putting the top of it into the current region"). It is
  flattened into atoms (`open` = top margin, each child whole or flattened in
  turn, `close` = bottom margin) grouped into units: an open travels with the
  atom after it and a close with the one before, so no split falls inside a
  margin (p. 291) and no fragment holds only margins. Each region gets
  FRAGMENTS, shallow copies of the containers holding that region's children,
  with a margin only where its atom landed; `xfaflow.ts` lays them out
  unchanged. One that fits is placed whole and never flattened, which is why no
  oracle before DD 1494 moved: no other vendored form has a splittable root child.
  **Invariant (`164g.8`):** the p. 295 override has ONE owner, `emptyRegion`,
  shared by a root child and a split's unit. A failure mid-split keeps what was
  placed and refuses from the failing leaf on -- never the whole root child,
  whose earlier fragments are already laid out.
  **Note, a narrowing:** everything else is placed whole -- a positioned subform
  (164g.11), an `lr-tb` or table (164g.12), a text field (164g.13). By the
  specification each of those may split too, so where one does not fit the room
  left we DEFER it where XFA might split it, which is 164g.3's existing
  behaviour for every root child. A break, `keep intact="pageArea"`, adhesion or
  an `<overflow>` in a split chain is refused, naming 164g.14-16.
  **Note on the oracle:** DD 1494 (pdf.js 6.3.289) pins only tb-between-children
  splitting; its template has no keep, break, overflow or occur. The 0.44pt by
  which we measure `P1.front` short of pdf.js is slack below its last field.
```

Then append any equivalent mutant from Step 1 to that block as a `**Note, measured:**`.

In the `xfapage.ts` entry's existing sentence "Otherwise it needs splitting and is refused (`164g.8`)", change `(\`164g.8\`)` to `(\`164g.11\`-\`164g.13\`)`.

In the CLAUDE.md fixtures table row for `fixtures/xfa-dynamic/`, append to the DD 2875/1494 sentence: "Since `164g.8` DD 1494's body is compared too, 14 pages field by field."

- [ ] **Step 4: PROVENANCE**

In `test/fixtures/xfa-dynamic/PROVENANCE.md`, replace the sentence of the "What it does NOT compare" paragraph that says DD 1494's body "overflows its content area and waits on splitting (164g.8)" with: "Since `164g.8` DD 1494's body IS compared: `master-goldens.json` keeps its body nodes as `body`, and every field lands on pdf.js's page and box across 14 pages. It pins only splitting a `tb` subform between its children; the template has no keep, break, overflow or occur." Add a line recording that `gen:xfa` now downloads over `node:https` with a 60-second timeout.

- [ ] **Step 5: Gates and commit**

Run: `npm run typecheck` (no errors) and `npm test` (all files pass).

```bash
git add CHANGELOG.md CLAUDE.md test/fixtures/xfa-dynamic/PROVENANCE.md
git commit -m "docs(164g.8): CHANGELOG, CLAUDE.md, PROVENANCE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Close out

- [ ] **Step 1: Close and push**

```bash
bd close aspose-pdf-foss-for-ts-164g.8 --reason "A tb subform splits between its children across content areas; DD 1494 converts onto pdf.js's 14 pages, every body field on its page and box. The rest is 164g.11-16."
git pull --rebase --autostash
git push
git status
```

Expected: up to date with origin. `_my/` is the user's and is never staged.

---

## Amendment (during Task 2): breaks and overflow inside a split chain

DD 1494 holds `<overflow leader>` on every `Pn.front` and `breakBefore` on P2-P6's
`front` and on P5/P6's `lineDiagramPg`. The spike missed them, because its scan
matched only tags on one line. The requester chose to widen the slice (spec
decision #3). This changes Tasks 2-4 as follows.

**Task 2, code (`src/xfapage.ts`):**
- `chainRefusal` no longer refuses `breakBefore`; it refuses `breakAfter` only, naming 164g.16.
- `Atom` gains `brk?: XfaBreak`: a leaf child's `breakBefore`, or a flattened child's on its `open` atom. `flatten(k, height, chain, k.breakBefore)` passes it down.
- `flatten` no longer refuses `<overflow>` up front.
- In `placeSplit`, before placing a unit, each atom's `brk` is applied with `p.apply(brk)`; a returned reason fails from that unit.
- Before each `p.placeUnit(u)`, every container on the unit's atom paths that has `overflow` is checked against the region where its first fragment landed (`Paginator.regionKey()`). A container continuing into a second region fails from that unit with `<label>: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)`.
- In `paginate`'s root loop, a splittable root child whose chain holds a `breakBefore` (`innerBreak(c)`) is flattened even when it would fit whole.

**Task 2, tests (`test/xfapage.test.ts`):** the "refuses what it cannot do" case asserts `breakAfter` (164g.16), `keep intact="pageArea"` and adhesion (164g.14), and an `<overflow>` container that continues (164g.15). New cases:
- a `breakBefore` inside a chain starts a new page even though the root child fits whole: `tb('T', [kid('a', 30), kid('b', 30, { breakBefore: pb() })])` gives `['0:T(a)', '0:T(b)']`;
- an `<overflow>` container that stays in one region is placed: `tb('T', [tb('O', [kid('a', 30)], { overflow: true }), kid('b', 90)])` gives `['0:T(O(a))', '0:T(b)']`.

**Task 3:** the DD 1494 oracle additionally asserts each page's page area: a page holds a `#pageArea[Page1]…` or `#pageArea[Page2]…` node in the goldens, and `laid.pages[i].pageArea` must name that page area.

**Task 4, extra mutations:** M9, ignore `brk` in `placeSplit` (expected red: the inner-break case, DD 1494); M10, refuse `<overflow>` up front again (expected red: the stays-in-one-region case, DD 1494); M11, drop `innerBreak(c)` from the root loop (expected red: the inner-break case).
