# XFA Page Breaking Implementation Plan (`164g.3`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make XFA pages an OUTPUT of layout: the root subform's children are poured into content areas and page-area instances under `orderedOccurrence`, so hybrid forms with one reused `<pageArea>` (fw9, I-130, I-765) place their fields, and a dynamic form's placeholder pages are replaced by the pages its layout produces.

**Architecture:** A new pure module `src/xfapage.ts` paginates (decides which root child lands in which content area of which page) and then lays each content area out through the existing engine in `src/xfaflow.ts`, which gains one height query. `src/xfatemplate.ts` stops assigning pages and hands back the root node plus a `<pageSet>` model; `src/xfaconvert.ts` takes each field's page from the layout result, checks page identity, and (for a dynamic document) replaces the placeholder pages.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-09-xfa-page-breaking-design.md` — read it first; every rule below cites it, and it cites the XFA 3.3 pages.

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins. ESM with `.js` specifiers.
- `xfapage.ts`, `xfaflow.ts`, `xfatemplate.ts` are pure leaves: no `Document`, no PDF object, no `node:` import, and they never throw.
- Never an approximate rect or page: what cannot be paginated is refused BY NAME, and the reason reaches the field.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`). This plan adds no `catch`.
- `npm run typecheck` and `npm test` both green before closing; target one file with `npx vitest run test/<name>.test.ts`.
- Follow-up issues already filed: **`164g.8`** (content splitting) and **`164g.9`** (qualified pagination). Refusal messages cite them.
- CHANGELOG under `## [Unreleased]`, in the same commit as the user-visible change (Task 7).
- Commit with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git commit -a`: `.beads/interactions.jsonl` and `_my/` are not ours to commit; `git add` named paths only.

## Review Focus

1. **A hybrid whose layout yields a different page count than its PDF** (for example a page subform refused mid-document) — the whole document's geometry is refused and the document-level reason names both counts AND the first pagination refusal, so the cause is not lost. Test in Task 3.
2. **A dynamic document where nothing gets placed** — the placeholder pages stay and the file is byte-identical. Test in Task 4.
3. **Two fields of one SOM name landing in two content areas of one page** — both refuse rather than one silently winning. Test in Task 2.
4. **A break target written as a SOM expression** (`$form.P1`, `a.b`) — refused by name, never resolved by guess. Test in Task 2.
5. **Content areas of different heights** — a child too tall for an empty short content area moves to the next, taller one instead of being forced past the short one's boundary. Test in Task 2.

---

## File Structure

| File | Change |
|---|---|
| `src/xfaflow.ts` | `XfaBreak` type and `breakBefore`/`breakAfter` on `LayoutNode`; a `tb` page root bounds nothing at its own level; `measureExtent()`; `inkBottom()`; drop `bounded()`/`placedBottom()`; splitting messages cite `164g.8` |
| `src/xfapage.ts` (new) | `XfaBody`/`XfaPageSet`/`XfaPageAreaModel`/`XfaContentArea` models, `paginate()`, `layoutPages()` |
| `src/xfatemplate.ts` | `body` (root node + page set) replaces `roots`, `pages` and `XfaField.pageIndex`; breaks parsed onto subform nodes; repeating page subforms instantiated |
| `src/xfaconvert.ts` | pages from `layoutPages`; page identity; dynamic placeholder replacement; `pagesCreated` |
| `test/xfaflow.test.ts`, `test/xfapage.test.ts` (new), `test/xfatemplate.test.ts`, `test/xfatemplate-text.test.ts`, `test/xfaconvert.test.ts`, `test/xfaconvert-choice-data.test.ts`, `test/helpers/build-xfa-pdf.ts`, `test/xfaconvert-pages.test.ts` (new), `test/xfa-real.test.ts`, `test/xfa-dynamic-oracle.test.ts` | tests |
| `test/fixtures/xfa/PROVENANCE.md`, `test/fixtures/xfa-dynamic/PROVENANCE.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md` | docs |

---

### Task 1: The engine's page root and height query (`xfaflow.ts`)

**Files:**
- Modify: `src/xfaflow.ts`
- Test: `test/xfaflow.test.ts`

**Interfaces:**
- Produces:
  - `export interface XfaBreak { targetType: string; target?: string; startNew: boolean; refusal?: string }`
  - `LayoutNode.breakBefore?: XfaBreak`, `LayoutNode.breakAfter?: XfaBreak`
  - `export function measureExtent(n: LayoutNode, limit: number, measure?: XfaMeasure, warnings?: string[]): { h: number; past: boolean } | { reason: string }`
  - A root `{ kind: 'page', layout: 'tb' }` handed to `layoutPage` stacks its children and bounds nothing at its own level.

- [ ] **Step 1: Write the failing tests.** In `test/xfaflow.test.ts`, change the import to
  `import { layoutPage, measureExtent, type LayoutNode, type Placed } from '../src/xfaflow.js';`
  and REPLACE the whole `describe('layoutPage: the page root', ...)` block (three cases: "bounds a flowed page subform…", "bounds a broken flow…", "refuses a flowed page subform when the contentArea states no height") with:

```ts
describe('layoutPage: the page root (164g.3)', () => {
  const tbPage = (children: LayoutNode[], geom: XfaRawGeom): LayoutNode =>
    ({ kind: 'page', label: 'contentArea', layout: 'tb', geom, children });

  // Pagination (xfapage.ts) decided which children share this content area, so
  // the root stacks what it was handed and bounds nothing at its own level --
  // that is what lets fw9's 0.003pt-too-tall page subform land (XFA 3.3 p. 295).
  it('stacks a tb page root\'s children without bounding them', () => {
    const m = layoutPage(tbPage([
      sub('P', 'position', { w: '100pt', h: '15pt' }, [fld('a', S)]),
      sub('Q', 'position', { w: '100pt', h: '15pt' }, [fld('b', S)]),
    ], { x: '36pt', y: '36pt', w: '540pt', h: '20pt' }));
    expect(box(m, 'a')).toEqual({ x: 36, y: 36, w: 10, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 36, y: 51, w: 10, h: 10 });
  });

  // XFA 3.3 p. 279: a flowed child's x and y are ignored.
  it('ignores a page child\'s own x and y', () => {
    const m = layoutPage(tbPage([sub('P', 'position', { x: '50pt', y: '50pt', w: '10pt', h: '10pt' }, [fld('a', S)])],
      { w: '540pt', h: '720pt' }));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('still refuses a flowed box past the contentArea bottom, naming splitting', () => {
    const m = layoutPage(tbPage([sub('P', 'tb', {}, [fld('a', S), fld('b', S)])], { w: '540pt', h: '15pt' }));
    expect(box(m, 'a').y).toBe(0);
    expect(why(m, 'b')).toMatch(/overflows its contentArea, which needs splitting \(164g\.8\)/);
  });

  // A positioned root (the shape every older case here builds) holding a flow
  // whose content area states no height: the leaves say why.
  it('refuses a flow\'s leaves when the contentArea states no height', () => {
    const m = layoutPage(page([sub('P', 'tb', {}, [fld('a', S)])], {}));
    expect(why(m, 'a')).toMatch(/sits under layout="tb" and its pageArea declares no contentArea height/);
  });
});

describe('measureExtent (164g.3)', () => {
  it('answers a stated height, with nothing past the limit', () => {
    expect(measureExtent(sub('P', 'position', { w: '100pt', h: '50pt' }, [fld('a', { y: '10pt', ...S })]), 40))
      .toEqual({ h: 50, past: false });
  });

  // fw9's shape: a page subform taller than its content area whose contents all
  // end inside it. Only a descendant box below the limit is "past".
  // Q states a height (30pt) taller than its ink (25pt): reading a container's
  // extent instead of recursing into it would call 50 "past" a 45pt limit.
  it('reports past only when a descendant box ends below the limit', () => {
    const p = sub('P', 'position', { w: '100pt', h: '50pt' }, [
      sub('Q', 'position', { y: '20pt', w: '50pt', h: '30pt' }, [fld('a', { y: '15pt', ...S })]),
    ]);
    expect(measureExtent(p, 45)).toEqual({ h: 50, past: false });
    expect(measureExtent(p, 44)).toEqual({ h: 50, past: true });
  });

  it('counts a draw as ink', () => {
    const p = sub('P', 'position', { w: '100pt', h: '50pt' }, [drw('d', { y: '40pt', ...S })]);
    expect(measureExtent(p, 45)).toEqual({ h: 50, past: true });
  });

  it('reads ink inside a table row at the row\'s expanded height', () => {
    const t = sub('T', 'table', { columnWidths: '20pt' }, [row('R', [fld('c', { h: '30pt' })])]);
    expect(measureExtent(t, 30)).toEqual({ h: 30, past: false });
    expect(measureExtent(t, 29)).toEqual({ h: 30, past: true });
  });

  it('measures a growable child from its content', () => {
    expect(measureExtent(sub('T', 'tb', {}, [fld('a', S), fld('b', S)]), 100)).toEqual({ h: 20, past: false });
  });

  it('passes a refusal through', () => {
    const r = measureExtent(sub('P', 'position', { w: '1pt', h: '1pt', rotate: '90' }, []), 100);
    expect(r).toEqual({ reason: expect.stringMatching(/rotate="90" is not supported/) as unknown as string });
  });
});
```

  Note `row` is defined further down this file (`const row = (label, cells, extra) => sub(label, 'row', {}, cells, extra)`); if the new block sits ABOVE that definition, move the `row` helper up beside `sub` so it is in scope.

  Also update the two "review fixes" cases that match `164g.3`:
  `expect(why(m, 'b')).toMatch(/overflows its contentArea.*164g\.3/);` → `.toMatch(/overflows its contentArea, which needs splitting \(164g\.8\)/);`
  and any other `164g\.3` in a regex in this file that names splitting or overflow (grep `164g\\.3` in the file; the `refusal: 'R: a repeating page subform needs page breaking (164g.3)'` fixture at about line 111 is an arbitrary carried refusal and stays).

- [ ] **Step 2: Run them to see them fail.**
  Run: `npx vitest run test/xfaflow.test.ts`
  Expected: FAIL — `measureExtent` is not exported; the tb page root cases fail on bounding.

- [ ] **Step 3: Implement.** In `src/xfaflow.ts`:

  (a) Add above `LayoutNode`:

```ts
/** A subform's `<breakBefore>`/`<breakAfter>`, or the deprecated `<break>`'s
 *  half (XFA 3.3 p. 632-636), as `xfatemplate.ts` reads it. `refusal` names a
 *  shape pagination does not implement; `xfapage.ts` acts on it (164g.3). */
export interface XfaBreak {
  /** `pageArea`, `contentArea`, or what the template wrote. */
  targetType: string;
  /** `#id` or a name, verbatim; absent when the break names none. */
  target?: string;
  startNew: boolean;
  refusal?: string;
}
```

  and add to `LayoutNode`, after `text?`:

```ts
  /** A subform's break conditions (164g.3). Only `xfapage.ts` reads them, and
   *  only on the root subform and its children. */
  breakBefore?: XfaBreak;
  breakAfter?: XfaBreak;
```

  (b) In `flowTb`, replace `const avail = this.available(n, m);` with:

```ts
    // A content area's children were chosen by pagination (`xfapage.ts`), which
    // has already decided that each fits -- or is the p. 295 override, placed past
    // the boundary on purpose -- so the root bounds nothing at its own level.
    const avail = n.kind === 'page' ? undefined : this.available(n, m);
```

  (c) Delete the method `bounded(...)` and the method `placedBottom(...)` entirely, and in `positionOne` delete the line
  `if (n.kind === 'page' && (c.layout ?? 'position') !== 'position') return this.bounded(n, c, slot);`
  so it ends `return slot;` directly. Remove the now-unused `bounded` doc comment with it.

  (d) Change `splitFail`'s message to
  ``{ reason: `${c.label}: does not fit the remaining height of ${n.label}, which needs splitting (164g.8)` }``
  and in `emit` change
  ``reason: `${n.label}: overflows its contentArea, which needs page breaking (164g.3)`,``
  to
  ``reason: `${n.label}: overflows its contentArea, which needs splitting (164g.8)`,``
  and in `emit`'s doc comment replace "since past it is page breaking (164g.3)" with "since past it is splitting (164g.8)".

  (e) Add to `class Engine`, after `emit`:

```ts
  /** The lowest edge of any field or draw under `n`, relative to its top: what
   *  the p. 295 override reads (164g.3). A child that could not be placed draws
   *  nothing and contributes nothing; a concealed one is not arranged at all. */
  inkBottom(n: LayoutNode): number {
    if (isLeaf(n)) {
      const s = this.extent(n);
      return isFail(s) ? 0 : s.h;
    }
    let bottom = 0;
    for (const [c, sl] of this.arrange(n)) {
      if (isFail(sl)) continue;
      if (isLeaf(c)) {
        const size = sl.size ?? this.extent(c);
        if (!isFail(size)) bottom = Math.max(bottom, sl.y + size.h);
        continue;
      }
      bottom = Math.max(bottom, sl.y + this.inkBottom(c));
    }
    return bottom;
  }
```

  (f) Add after `layoutPage`:

```ts
/**
 * A node's laid-out height, and whether any field or draw inside it ends below
 * `limit` -- what pagination (`xfapage.ts`, 164g.3) needs to decide where a
 * root child lands. `past` is the p. 295 test: a child too tall for an EMPTY
 * content area may be placed past the boundary only when nothing it draws lies
 * past it; otherwise it would need splitting (164g.8).
 */
export function measureExtent(
  n: LayoutNode, limit: number, measure?: XfaMeasure, warnings: string[] = [],
): { h: number; past: boolean } | { reason: string } {
  const engine = new Engine(undefined, measure, warnings);
  const e = engine.extent(n);
  if (isFail(e)) return { reason: e.reason };
  return { h: e.h, past: engine.inkBottom(n) > limit + EPS };
}
```

- [ ] **Step 4: Run.** `npx vitest run test/xfaflow.test.ts test/xfaflow-measure.test.ts test/xfaflow-table-measure.test.ts test/xfa-flow-oracle.test.ts test/xfa-real.test.ts`
  Expected: PASS. (`xfa-real` still uses the old position page roots and is unaffected; `bounded` only acted on a flowed page subform, which f1040 has none of.) Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit.**

```bash
git add src/xfaflow.ts test/xfaflow.test.ts
git commit -m "feat(164g.3): xfaflow -- a tb page root bounds nothing; measureExtent for pagination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pagination (`xfapage.ts`)

**Files:**
- Create: `src/xfapage.ts`
- Test: `test/xfapage.test.ts`

**Interfaces:**
- Consumes: `measureExtent`, `layoutPage`, `LayoutNode`, `XfaBreak`, `Placed`, `XfaMeasure` (Task 1); `measureToPt`, `XfaMedium` from `xfageom.ts`.
- Produces (Task 3 and 4 rely on these exact names):

```ts
export interface XfaContentArea { name?: string; id?: string; node: LayoutNode }
export interface XfaPageAreaModel { name?: string; id?: string; medium?: XfaMedium; max: number; contentAreas: XfaContentArea[] }
export interface XfaPageSet { relation: string; max: number; pageAreas: XfaPageAreaModel[]; refusal?: string }
export interface XfaBody { root: LayoutNode; pageSet?: XfaPageSet }
export interface PaginatedPage { pageArea: number; contentAreas: Array<{ index: number; children: LayoutNode[] }> }
export interface Pagination { pages: PaginatedPage[]; refused: Map<LayoutNode, string>; warnings: string[] }
export type XfaHeight = (n: LayoutNode, limit: number) => { h: number; past: boolean } | { reason: string };
export function paginate(body: XfaBody, height: XfaHeight): Pagination;
export interface LaidOutPage { pageArea: number; placed: Map<string, Placed> }
export interface XfaLayoutResult { pages: LaidOutPage[]; refused: Map<string, string> }
export function layoutPages(body: XfaBody, measure?: XfaMeasure, warnings?: string[]): XfaLayoutResult;
```

  A content area's `node` is `{ kind: 'page', label: 'contentArea', layout: 'tb', geom: <the contentArea's x/y/w/h>, children: [] }`; `layoutPages` lays it out with the page's children substituted.

- [ ] **Step 1: Write the failing tests.** Create `test/xfapage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  paginate, layoutPages,
  type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight,
} from '../src/xfapage.js';
import type { LayoutNode, XfaBreak, Placed } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

/** A root child of stated height. A label ending in '!' has ink past any limit. */
const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const ca = (h: number | undefined, extra: { name?: string; id?: string } = {}): XfaContentArea => ({
  ...extra,
  node: {
    kind: 'page', label: 'contentArea', layout: 'tb',
    geom: h === undefined ? {} : { w: '500pt', h: `${String(h)}pt` }, children: [],
  },
});
const area = (cas: XfaContentArea[], extra: Partial<XfaPageAreaModel> = {}): XfaPageAreaModel =>
  ({ max: -1, contentAreas: cas, ...extra });
const body = (
  pageAreas: XfaPageAreaModel[], kids: LayoutNode[],
  o: { relation?: string; max?: number; refusal?: string; rootLayout?: string; rootBreak?: XfaBreak } = {},
): XfaBody => ({
  root: {
    kind: 'subform', label: 'root[0]', layout: o.rootLayout ?? 'tb', geom: {}, children: kids,
    ...(o.rootBreak ? { breakBefore: o.rootBreak } : {}),
  },
  pageSet: {
    relation: o.relation ?? 'orderedOccurrence', max: o.max ?? -1, pageAreas,
    ...(o.refusal !== undefined ? { refusal: o.refusal } : {}),
  },
});
const height: XfaHeight = (n) => ({ h: Number((n.geom.h ?? '0pt').replace('pt', '')), past: n.label.endsWith('!') });
const pages = (b: XfaBody) => paginate(b, height).pages.map((p) =>
  [p.pageArea, ...p.contentAreas.map((c) => `${String(c.index)}:${c.children.map((k) => k.label).join(',')}`)]);
const refusals = (b: XfaBody) => [...paginate(b, height).refused].map(([n, why]) => [n.label, why]);
const pb = (extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType: 'pageArea', startNew: false, ...extra });
const cb = (extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType: 'contentArea', startNew: false, ...extra });
const AFTER = /^an earlier item in its flow could not be laid out \(/;

describe('paginate: filling content areas (XFA 3.3 p. 288, 294)', () => {
  it('stacks children into one content area while they fit', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 40), kid('B', 40)]))).toEqual([[0, '0:A,B']]);
  });

  it('moves a child that does not fit WHOLE to a new page', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 60), kid('B', 60)]))).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('fills the next content area before starting a page', () => {
    expect(pages(body([area([ca(100), ca(100)])], [kid('A', 60), kid('B', 60), kid('C', 60)])))
      .toEqual([[0, '0:A', '1:B'], [0, '0:C']]);
  });

  it('takes a presence="hidden" child, which takes no space, where it stands', () => {
    expect(pages(body([area([ca(100)])], [kid('H', 1000, { presence: 'hidden' }), kid('A', 40)])))
      .toEqual([[0, '0:H,A']]);
  });
});

describe('paginate: the p. 295 override', () => {
  // fw9: a page subform 0.003pt taller than its content area, nothing drawn past it.
  it('places a child too tall for an EMPTY content area when nothing it draws lies past it', () => {
    expect(pages(body([area([ca(100)])], [kid('A', 110), kid('B', 10)]))).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('refuses one whose content lies past the boundary, and every child after it', () => {
    const b = body([area([ca(100)])], [kid('A!', 110), kid('B', 10)]);
    const r = refusals(b);
    expect(r[0]).toEqual(['A!', 'A!: does not fit an empty content area and would need splitting (164g.8)']);
    expect(r[1][0]).toBe('B');
    expect(r[1][1]).toMatch(AFTER);
  });

  // Review Focus 5: p. 295 overrides only when the NEXT region cannot hold it either.
  it('moves on to a taller next content area rather than overriding a short one', () => {
    expect(pages(body([area([ca(100), ca(200)])], [kid('A', 150)]))).toEqual([[0, '1:A']]);
  });

  it('overrides when the next content area is no taller', () => {
    expect(pages(body([area([ca(200), ca(100)])], [kid('A', 250)]))).toEqual([[0, '0:A']]);
  });
});

describe('paginate: the start point (p. 296) and breaks (p. 269-270, 360-365)', () => {
  // The recorded spec conflict: Example 9.22 shows a blank first page; the
  // start-point rule and both oracles do not.
  it('opens no blank first page for the first child\'s startNew break', () => {
    const b = body([area([ca(100)])], [kid('A', 10, { breakBefore: pb({ startNew: true }) }),
      kid('B', 10, { breakBefore: pb({ startNew: true }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('starts on the page area the first child\'s break targets', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { name: 'P2' })],
      [kid('A', 10, { breakBefore: pb({ target: 'P2' }) })]);
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  it('lets the ROOT\'s own break choose the start, over the first child\'s', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { name: 'P2' })],
      [kid('A', 10)], { rootBreak: pb({ target: 'P2' }) });
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  it('resolves a #target by XML id', () => {
    const b = body([area([ca(100)], { name: 'P1' }), area([ca(100)], { id: 'pa2' })],
      [kid('A', 10, { breakBefore: pb({ target: '#pa2' }) })]);
    expect(pages(b)).toEqual([[1, '0:A']]);
  });

  // f1040's shape.
  it('breaks to each named page area in turn', () => {
    const b = body([area([ca(792)], { name: 'P1' }), area([ca(792)], { name: 'P2' })],
      [kid('A', 792, { breakBefore: pb({ target: 'P1' }) }), kid('B', 792, { breakBefore: pb({ target: 'P2' }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B']]);
  });

  it('stays in the current page area when startNew is 0 and it already matches', () => {
    const b = body([area([ca(100)], { name: 'P1' })],
      [kid('A', 40, { breakBefore: pb({ target: 'P1' }) }), kid('B', 40, { breakBefore: pb({ target: 'P1' }) })]);
    expect(pages(b)).toEqual([[0, '0:A,B']]);
  });

  it('starts a new instance when startNew is 1', () => {
    const b = body([area([ca(100)], { name: 'P1' })],
      [kid('A', 40), kid('B', 40, { breakBefore: pb({ target: 'P1', startNew: true }) })]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('honours a breakAfter', () => {
    const b = body([area([ca(100)])], [kid('A', 10, { breakAfter: pb() }), kid('B', 10)]);
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  it('moves to the next content area on a contentArea break', () => {
    const b = body([area([ca(100), ca(100)])], [kid('A', 10), kid('B', 10, { breakBefore: cb() })]);
    expect(pages(b)).toEqual([[0, '0:A', '1:B']]);
  });

  it('moves to a named content area, on a new page when it lies behind', () => {
    const b = body([area([ca(100, { name: 'L' }), ca(100, { name: 'R' })])], [
      kid('A', 10), kid('B', 10, { breakBefore: cb({ target: 'R' }) }), kid('C', 10, { breakBefore: cb({ target: 'L' }) }),
    ]);
    expect(pages(b)).toEqual([[0, '0:A', '1:B'], [0, '0:C']]);
  });
});

describe('paginate: occurrence limits (p. 296-300)', () => {
  it('moves to the next page area once one\'s max is spent', () => {
    const b = body([area([ca(100)], { max: 1 }), area([ca(100)])], [kid('A', 60), kid('B', 60), kid('C', 60)]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B'], [1, '0:C']]);
  });

  it('discards what lies past every limit, and says so', () => {
    const b = body([area([ca(100)], { max: 2 })], [kid('A', 60), kid('B', 60), kid('C', 60)], { max: 1 });
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
    expect(refusals(b)).toEqual([['C', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  it('reuses the current page area before opening a new page-set instance', () => {
    const b = body([area([ca(100)])], [kid('A', 60), kid('B', 60)], { max: 1 });
    expect(pages(b)).toEqual([[0, '0:A'], [0, '0:B']]);
  });

  // Ordered occurrence moves FORWARD: P1 still has an instance to spare, but
  // reaching it again needs a new page-set instance, which max 1 forbids.
  it('never moves backward within a page-set instance', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 2 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ], { max: 1 });
    expect(refusals(b)).toEqual([['C', "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)"]]);
  });

  it('opens a new page-set instance to reach an EARLIER page area', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 1 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ]);
    expect(pages(b)).toEqual([[0, '0:A'], [1, '0:B'], [0, '0:C']]);
  });

  it('emits a page area with no content area as an empty page, reading its max -1 as 1', () => {
    const b = body([area([], { name: 'Cover' }), area([ca(100)])], [kid('A', 10)]);
    const r = paginate(b, height);
    expect(pages(b)).toEqual([[0], [1, '0:A']]);
    expect(r.warnings).toEqual([expect.stringMatching(/Cover.*p\. 298/) as unknown as string]);
  });
});

describe('paginate: refusals, by name', () => {
  const two = [kid('A', 10), kid('B', 10)];
  const all = (b: XfaBody) => refusals(b).map(([, w]) => w);

  it('refuses a body with no pageSet', () => {
    const b: XfaBody = { root: { kind: 'subform', label: 'r', layout: 'tb', geom: {}, children: two } };
    expect(all(b)).toEqual([expect.stringMatching(/declares no <pageSet>/), expect.stringMatching(/declares no <pageSet>/)]);
  });

  it('refuses a root that is not tb', () => {
    expect(all(body([area([ca(100)])], two, { rootLayout: 'position' }))[0]).toMatch(/layout "position" is not paginated \(only tb\)/);
  });

  it('refuses a qualified pagination relation', () => {
    expect(all(body([area([ca(100)])], two, { relation: 'simplexPaginated' }))[0]).toMatch(/simplexPaginated.*164g\.9/);
  });

  it('passes the page set\'s own refusal through', () => {
    expect(all(body([area([ca(100)])], two, { refusal: 'X' }))).toEqual(['X', 'X']);
  });

  it('refuses a page set with no content area at all', () => {
    expect(all(body([area([])], two))[0]).toMatch(/no pageArea declares a contentArea/);
  });

  it('refuses a content area that states no height', () => {
    expect(all(body([area([ca(undefined, { name: 'C1' })])], two))[0]).toMatch(/contentArea C1 states no readable h/);
  });

  it('refuses a break the template could not model, and every child after it', () => {
    const r = refusals(body([area([ca(100)])], [kid('A', 10), kid('B', 10, { breakBefore: pb({ refusal: 'B: no' }) }), kid('C', 10)]));
    expect(r.map(([l]) => l)).toEqual(['B', 'C']);
    expect(r[0][1]).toBe('B: no');
    expect(r[1][1]).toMatch(AFTER);
  });

  it('refuses a target naming nothing, or more than one', () => {
    const none = body([area([ca(100)], { name: 'P1' })], [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: 'Nowhere' }) })]);
    expect(refusals(none)[0]).toEqual(['B', 'break target "Nowhere" names no pageArea']);
    const twice = body([area([ca(100)], { name: 'P' }), area([ca(100)], { name: 'P' })],
      [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: 'P' }) })]);
    expect(refusals(twice)[0]).toEqual(['B', 'break target "P" names more than one pageArea']);
  });

  // Review Focus 4.
  it('refuses a target written as a SOM expression rather than resolving it', () => {
    for (const t of ['$form.P1', 'a.b', 'P1[0]']) {
      const b = body([area([ca(100)], { name: 'P1' })], [kid('A', 10), kid('B', 10, { breakBefore: pb({ target: t }) })]);
      expect(refusals(b)[0], t).toEqual(['B', `break target "${t}" is a SOM expression, which is not resolved`]);
    }
  });

  it('refuses a child whose height cannot be measured, and every child after it', () => {
    const h: XfaHeight = (n) => (n.label === 'A' ? { reason: 'A: no size' } : { h: 10, past: false });
    const r = [...paginate(body([area([ca(100)])], [kid('A', 10), kid('B', 10)]), h).refused].map(([n, w]) => [n.label, w]);
    expect(r[0]).toEqual(['A', 'A: no size']);
    expect(r[1][1]).toMatch(AFTER);
  });
});

describe('layoutPages', () => {
  const S: XfaRawGeom = { w: '10pt', h: '10pt' };
  const fld = (label: string, geom: XfaRawGeom): LayoutNode => ({ kind: 'field', label, field: label, geom, children: [] });
  const placedBox = (m: Map<string, Placed>, n: string) => {
    const p = m.get(n);
    if (!p || 'reason' in p) throw new Error(`${n}: ${p ? p.reason : 'none'}`);
    return p.box;
  };
  const caAt = (h: number): XfaContentArea => ({
    node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { x: '10pt', y: '20pt', w: '500pt', h: `${String(h)}pt` }, children: [] },
  });

  it('lays each page out from its content area\'s origin', () => {
    const r = layoutPages(body([area([caAt(100)])], [
      kid('P', 60, { children: [fld('a', { x: '1pt', y: '2pt', ...S })] }),
      kid('Q', 60, { children: [fld('b', { x: '1pt', y: '2pt', ...S })] }),
    ]));
    expect(r.pages.map((p) => p.pageArea)).toEqual([0, 0]);
    expect(placedBox(r.pages[0].placed, 'a')).toEqual({ x: 11, y: 22, w: 10, h: 10 });
    expect(placedBox(r.pages[1].placed, 'b')).toEqual({ x: 11, y: 22, w: 10, h: 10 });
    expect(r.refused.size).toBe(0);
  });

  it('gives every field under a refused child that child\'s reason', () => {
    const r = layoutPages(body([area([caAt(100)])], [kid('P', 150, { children: [fld('c', { y: '120pt', ...S })] })]));
    expect(r.refused.get('c')).toMatch(/would need splitting \(164g\.8\)/);
  });

  // Review Focus 3.
  it('refuses two fields of one name in two content areas of one page', () => {
    const r = layoutPages(body([area([caAt(100), caAt(100)])], [
      kid('P', 60, { children: [fld('d', S)] }), kid('Q', 60, { children: [fld('d', S)] }),
    ]));
    const p = r.pages[0].placed.get('d');
    expect(p && 'reason' in p ? p.reason : '').toMatch(/two fields share the SOM name d/);
  });
});
```

- [ ] **Step 2: Run to see it fail.** `npx vitest run test/xfapage.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement.** Create `src/xfapage.ts`:

```ts
/**
 * XFA pagination (`164g.3`): which child of the root subform lands in which
 * content area of which page, under `orderedOccurrence` (XFA Specification 3.3,
 * pinned by 164g.1; p. 269-270, 288-300, 360-367).
 *
 * **Invariant: it decides MEMBERSHIP only.** Every position comes from
 * `xfaflow.ts`: each content area holding children is laid out as a `tb` root,
 * so a page and its layout cannot disagree about where a child sits.
 *
 * **Invariant: a pure leaf over `xfaflow.js` and `xfageom.js` that never
 * throws.** What it cannot paginate is refused BY NAME, and a refused child
 * refuses every child after it -- the root is a `tb` flow, so where a later one
 * lands depends on the one that failed (`xfaflow.ts`'s rule, one level up).
 *
 * **The recorded spec conflict:** Example 9.22 (p. 362) shows a first child's
 * `startNew` break leaving page 1 blank; the start-point rule (p. 296) and both
 * oracles (Adobe's I-130/I-765, pdf.js's OPM 1644) do not. The first child's
 * break chooses where layout STARTS and never opens a page of its own.
 */
import {
  layoutPage, measureExtent,
  type LayoutNode, type Placed, type XfaBreak, type XfaMeasure,
} from './xfaflow.js';
import { measureToPt, type XfaMedium } from './xfageom.js';

export interface XfaContentArea { name?: string; id?: string; node: LayoutNode }
export interface XfaPageAreaModel {
  name?: string;
  id?: string;
  medium?: XfaMedium;
  /** `<occur max>`; -1 (the default, p. 300) is no limit. */
  max: number;
  contentAreas: XfaContentArea[];
}
export interface XfaPageSet {
  /** `relation`, `orderedOccurrence` when absent. */
  relation: string;
  max: number;
  pageAreas: XfaPageAreaModel[];
  /** Why this page set cannot be paginated, as the template found it. */
  refusal?: string;
}
/** The root subform (whose children are the page-level content) and its page set. */
export interface XfaBody { root: LayoutNode; pageSet?: XfaPageSet }

export interface PaginatedPage {
  pageArea: number;
  /** Per content area of that page area, the children that landed there. */
  contentAreas: Array<{ index: number; children: LayoutNode[] }>;
}
export interface Pagination {
  pages: PaginatedPage[];
  /** A root child that could not be placed, with the reason each field below it gets. */
  refused: Map<LayoutNode, string>;
  warnings: string[];
}
/** A child's laid-out height, and whether it draws anything below `limit`. */
export type XfaHeight = (n: LayoutNode, limit: number) => { h: number; past: boolean } | { reason: string };

/** Tolerance for comparing summed measurements (`xfaflow.ts`'s). */
const EPS = 1e-6;
const DISCARDED = "content past every pageArea's occur max is discarded (XFA 3.3 p. 300)";

const concealed = (n: LayoutNode): boolean => n.presence === 'hidden' || n.presence === 'inactive';
const after = (cause: string): string => `an earlier item in its flow could not be laid out (${cause})`;

/** A break target to the page area and, for a content-area target, the content
 *  area it names -- or why it names nothing. `#` is an XML id; a bare name is
 *  matched by `name`; anything else is a SOM expression, which is not resolved. */
function resolveTarget(
  ps: XfaPageSet, type: 'pageArea' | 'contentArea', target: string,
): { area: number; ca?: number } | { reason: string } {
  const t = target.trim();
  const byId = t.startsWith('#');
  const v = byId ? t.slice(1) : t;
  if (v === '' || /[\s.[\]$!*]/.test(v))
    return { reason: `break target "${target}" is a SOM expression, which is not resolved` };
  const key = byId ? 'id' : 'name';
  const hits: Array<{ area: number; ca?: number }> = [];
  ps.pageAreas.forEach((pa, a) => {
    if (type === 'pageArea') { if (pa[key] === v) hits.push({ area: a }); return; }
    pa.contentAreas.forEach((c, i) => { if (c[key] === v) hits.push({ area: a, ca: i }); });
  });
  if (hits.length === 0) return { reason: `break target "${target}" names no ${type}` };
  if (hits.length > 1) return { reason: `break target "${target}" names more than one ${type}` };
  return hits[0];
}

/** The cursor: page-set instance, page-area instances, content area, height used. */
interface State { set: number; uses: number[]; area: number; ca: number; used: number; pages: number }

class Paginator {
  readonly pages: PaginatedPage[] = [];
  private set = 0;
  private readonly uses: number[];
  area = -1;
  ca = 0;
  used = 0;

  constructor(
    private readonly ps: XfaPageSet, private readonly maxOf: readonly number[],
    private readonly heights: readonly number[][],
  ) { this.uses = ps.pageAreas.map(() => 0); }

  capacity(): number { return this.heights[this.area][this.ca]; }

  snapshot(): State {
    return { set: this.set, uses: [...this.uses], area: this.area, ca: this.ca, used: this.used, pages: this.pages.length };
  }
  restore(s: State): void {
    this.set = s.set;
    this.uses.splice(0, this.uses.length, ...s.uses);
    this.area = s.area; this.ca = s.ca; this.used = s.used;
    this.pages.length = s.pages;
  }

  private canUse(a: number): boolean { return this.maxOf[a] === -1 || this.uses[a] < this.maxOf[a]; }

  private newSet(): boolean {
    if (this.ps.max !== -1 && this.set + 1 >= this.ps.max) return false;
    this.set += 1;
    this.uses.fill(0);
    return true;
  }

  /** A page of page area `a`. One with no content area is pure boilerplate
   *  (p. 296): emitted holding nothing, and the advance continues. */
  private open(a: number): string | undefined {
    this.uses[a] += 1;
    this.pages.push({ pageArea: a, contentAreas: [] });
    this.area = a;
    this.ca = 0;
    this.used = 0;
    return this.ps.pageAreas[a].contentAreas.length === 0 ? this.nextPage() : undefined;
  }

  /** The natural next page (p. 298-300): another instance of the current page
   *  area while its max allows, then the next page area in order, then a new
   *  page-set instance from the first. */
  nextPage(): string | undefined {
    const n = this.ps.pageAreas.length;
    if (this.area >= 0 && this.canUse(this.area)) return this.open(this.area);
    for (let a = this.area + 1; a < n; a++) if (this.canUse(a)) return this.open(a);
    if (!this.newSet()) return DISCARDED;
    for (let a = 0; a < n; a++) if (this.canUse(a)) return this.open(a);
    return DISCARDED;
  }

  /** The next content area on this page, else the next page (p. 294). */
  advance(): string | undefined {
    if (this.ca + 1 < this.ps.pageAreas[this.area].contentAreas.length) {
      this.ca += 1;
      this.used = 0;
      return undefined;
    }
    return this.nextPage();
  }

  /** A new page of page area `a` (p. 360-361, 367). Ordered occurrence moves
   *  FORWARD: a page area at or behind the current one is reached through a new
   *  page-set instance once the current instance cannot hold another. */
  private toPageArea(a: number): string | undefined {
    if (a >= this.area && this.canUse(a)) return this.open(a);
    if (!this.newSet()) return DISCARDED;
    return this.open(a);
  }

  /** Where layout starts (p. 296): the break's target, else the first page area. */
  start(b: XfaBreak | undefined): string | undefined {
    if (b?.refusal !== undefined) return b.refusal;
    const want = b?.target !== undefined && (b.targetType === 'pageArea' || b.targetType === 'contentArea')
      ? resolveTarget(this.ps, b.targetType, b.target) : undefined;
    if (want && 'reason' in want) return want.reason;
    if (!want) return this.nextPage();
    const r = this.open(want.area);
    if (r !== undefined) return r;
    if (want.ca !== undefined) this.ca = want.ca;
    return undefined;
  }

  apply(b: XfaBreak): string | undefined {
    if (b.refusal !== undefined) return b.refusal;
    if (b.targetType !== 'pageArea' && b.targetType !== 'contentArea')
      return `a break with targetType="${b.targetType}" is not implemented`;
    const tgt = b.target !== undefined ? resolveTarget(this.ps, b.targetType, b.target) : undefined;
    if (tgt && 'reason' in tgt) return tgt.reason;
    if (b.targetType === 'pageArea') {
      // p. 270: with no target, the current page is treated as full.
      if (!tgt) return this.nextPage();
      if (!b.startNew && tgt.area === this.area) return undefined;
      return this.toPageArea(tgt.area);
    }
    if (!tgt) return this.advance();
    const c = tgt.ca ?? 0;
    if (!b.startNew && tgt.area === this.area && c === this.ca) return undefined;
    if (tgt.area === this.area && c > this.ca) { this.ca = c; this.used = 0; return undefined; }
    const r = this.toPageArea(tgt.area);
    if (r !== undefined) return r;
    this.ca = c;
    return undefined;
  }

  place(c: LayoutNode, h: number): void {
    const page = this.pages[this.pages.length - 1];
    let e = page.contentAreas.find((x) => x.index === this.ca);
    if (!e) { e = { index: this.ca, children: [] }; page.contentAreas.push(e); }
    e.children.push(c);
    this.used += h;
  }
}

/** Paginate `body` (spec section 2). */
export function paginate(body: XfaBody, height: XfaHeight): Pagination {
  const refused = new Map<LayoutNode, string>();
  const warnings: string[] = [];
  const kids = body.root.children;
  const refuseAll = (why: string): Pagination => {
    for (const c of kids) refused.set(c, why);
    return { pages: [], refused, warnings };
  };
  const ps = body.pageSet;
  if (!ps) return refuseAll('the root subform declares no <pageSet>, so no page can be laid out');
  if (ps.refusal !== undefined) return refuseAll(ps.refusal);
  if (ps.relation !== 'orderedOccurrence')
    return refuseAll(`pageSet relation="${ps.relation}" is not implemented (164g.9)`);
  const lay = body.root.layout ?? 'position';
  if (lay !== 'tb') return refuseAll(`the root subform's layout "${lay}" is not paginated (only tb)`);
  if (!ps.pageAreas.some((p) => p.contentAreas.length > 0))
    return refuseAll('no pageArea declares a contentArea, so no content can be laid out (XFA 3.3 p. 296)');
  const heights: number[][] = [];
  for (const pa of ps.pageAreas) {
    const row: number[] = [];
    for (const ca of pa.contentAreas) {
      const h = ca.node.geom.h === undefined ? undefined : measureToPt(ca.node.geom.h);
      if (h === undefined)
        return refuseAll(`contentArea ${ca.name ?? ca.id ?? '(unnamed)'} states no readable h, so it cannot be filled`);
      row.push(h);
    }
    heights.push(row);
  }
  // p. 298: a pure-boilerplate page area with no max would emit pages forever;
  // read its max as 1, with a warning.
  const maxOf = ps.pageAreas.map((pa, i) => {
    if (pa.contentAreas.length > 0 || pa.max !== -1) return pa.max;
    warnings.push(`pageArea ${pa.name ?? String(i)} has no contentArea and no occur max, so its max is read as 1 (XFA 3.3 p. 298)`);
    return 1;
  });

  const p = new Paginator(ps, maxOf, heights);
  // p. 296: the root's break, else its first subform child's, chooses the start.
  const first = kids.find((c) => c.kind === 'subform' && !concealed(c));
  const started = p.start(body.root.breakBefore ?? first?.breakBefore);
  if (started !== undefined) return refuseAll(started);

  let cause: string | undefined;
  for (const c of kids) {
    if (cause !== undefined) { refused.set(c, after(cause)); continue; }
    if (concealed(c)) { p.place(c, 0); continue; }
    const fail = (why: string): void => { refused.set(c, why); cause = why; };
    if (c.breakBefore && c !== first) {
      const r = p.apply(c.breakBefore);
      if (r !== undefined) { fail(r); continue; }
    }
    let placed = false;
    for (;;) {
      const H = p.capacity();
      const r = height(c, H);
      if ('reason' in r) { fail(r.reason); break; }
      if (p.used + r.h <= H + EPS) { p.place(c, r.h); placed = true; break; }
      if (p.used === 0) {
        // p. 295: the region is EMPTY. Override its boundary only when the next
        // region cannot hold the child either, and only when nothing it draws
        // lies past -- anything else needs splitting.
        const s = p.snapshot();
        const moved = p.advance();
        const nextH = moved === undefined ? p.capacity() : 0;
        p.restore(s);
        if (moved === undefined && r.h <= nextH + EPS) { p.advance(); continue; }
        if (!r.past) { p.place(c, r.h); placed = true; break; }
        fail(`${c.label}: does not fit an empty content area and would need splitting (164g.8)`);
        break;
      }
      const moved = p.advance();
      if (moved !== undefined) { fail(moved); break; }
    }
    if (placed && c.breakAfter) {
      const r = p.apply(c.breakAfter);
      if (r !== undefined) cause = r;
    }
  }
  return { pages: p.pages, refused, warnings };
}

export interface LaidOutPage { pageArea: number; placed: Map<string, Placed> }
export interface XfaLayoutResult {
  pages: LaidOutPage[];
  /** Field SOM name to the reason pagination refused the root child above it. */
  refused: Map<string, string>;
}

/** Paginate, then lay every content area out through `xfaflow.ts`. The ONE
 *  owner of "where is this field, on which page", shared by the converter and
 *  the oracles. */
export function layoutPages(body: XfaBody, measure?: XfaMeasure, warnings: string[] = []): XfaLayoutResult {
  // Heights are measured again when the page is laid out, which records any
  // swap warning; the measuring pass's own copy is discarded.
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, measure, []));
  warnings.push(...pg.warnings);
  const refused = new Map<string, string>();
  const mark = (n: LayoutNode, why: string): void => {
    if (n.field !== undefined) refused.set(n.field, why);
    for (const c of n.children) mark(c, why);
  };
  for (const [n, why] of pg.refused) mark(n, why);
  const pages = pg.pages.map((p) => {
    const placed = new Map<string, Placed>();
    for (const ca of p.contentAreas) {
      const node = body.pageSet!.pageAreas[p.pageArea].contentAreas[ca.index].node;
      for (const [k, v] of layoutPage({ ...node, children: ca.children }, measure, warnings)) {
        placed.set(k, placed.has(k)
          ? { reason: `two fields share the SOM name ${k}, so neither can be placed by it` } : v);
      }
    }
    return { pageArea: p.pageArea, placed };
  });
  return { pages, refused };
}
```

  Note on the override loop: when the next region CAN hold the child, `p.advance()` is called for real and the loop re-runs on the empty next region, where it fits. When it cannot, the cursor is restored and the child is placed in the current empty region (or refused).

- [ ] **Step 4: Run.** `npx vitest run test/xfapage.test.ts` — PASS. `npm run typecheck` — clean. `npx vitest run test/import-cycles.test.ts` — PASS (`xfapage.ts` value-imports `xfaflow.ts` one way only).

- [ ] **Step 5: Commit.**

```bash
git add src/xfapage.ts test/xfapage.test.ts
git commit -m "feat(164g.3): xfapage -- orderedOccurrence pagination of the root's children

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cut over -- the template's page set and the converter's pages

**Files:**
- Modify: `src/xfatemplate.ts`, `src/xfaconvert.ts`
- Modify (tests and fixtures): `test/xfatemplate.test.ts`, `test/xfatemplate-text.test.ts`, `test/xfa-dynamic-oracle.test.ts`, `test/xfaconvert.test.ts`, `test/xfaconvert-choice-data.test.ts`, `test/helpers/build-xfa-pdf.ts`, `test/xfa-real.test.ts`

**Interfaces:**
- Consumes: `XfaBody`, `XfaPageSet`, `XfaPageAreaModel`, `XfaContentArea`, `layoutPages` (Task 2); `XfaBreak` (Task 1).
- Produces: `XfaTemplate = { fields: XfaField[]; body?: XfaBody; masterPageFields: XfaField[] }`. **Removed:** `XfaTemplate.pages`, `XfaTemplate.roots`, `XfaLayoutRoot`, `XfaField.pageIndex`. `XfaPageArea` stays exported (it is `{ name?, medium? }`, used by nothing else after this task; keep it for API stability).

This task cuts over in one go because removing `roots` breaks the converter and moving the converter needs the new model. It handles hybrids only: a dynamic document whose layout disagrees with its page count is refused like a hybrid until Task 4.

- [ ] **Step 1: Write the new template tests.** In `test/xfatemplate.test.ts`:

  (a) Replace `describe('parseXfaTemplate: pageAreas', ...)` with:

```ts
describe('parseXfaTemplate: the page set', () => {
  const ps = (inner: string) => tpl(`<subform name="f" layout="tb">${inner}</subform>`).body?.pageSet;

  it('models page areas in document order with their media, ids, occur and content areas', () => {
    expect(ps(`<pageSet>
      <pageArea name="P1" id="a1"><medium short="8.5in" long="11in"/>
        <contentArea name="C" id="c1" x="1pt" y="2pt" w="3pt" h="4pt"/></pageArea>
      <pageArea name="P2"><occur max="2"/><medium short="8.5in" long="11in" orientation="landscape"/></pageArea>
      </pageSet>`)).toEqual({
      relation: 'orderedOccurrence', max: -1,
      pageAreas: [
        {
          name: 'P1', id: 'a1', medium: { short: '8.5in', long: '11in' }, max: -1,
          contentAreas: [{
            name: 'C', id: 'c1',
            node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { x: '1pt', y: '2pt', w: '3pt', h: '4pt' }, children: [] },
          }],
        },
        { name: 'P2', medium: { short: '8.5in', long: '11in', orientation: 'landscape' }, max: 2, contentAreas: [] },
      ],
    });
  });

  it('reads relation and the page set\'s own occur max', () => {
    expect(ps('<pageSet relation="duplexPaginated"><occur max="3"/><pageArea/></pageSet>'))
      .toMatchObject({ relation: 'duplexPaginated', max: 3 });
  });

  it('refuses an occur max that is not -1 or positive (p. 300)', () => {
    expect(ps('<pageSet><pageArea><occur max="0"/></pageArea></pageSet>')?.refusal)
      .toBe('pageArea occur max="0" could not be read (XFA 3.3 p. 300: -1 or positive)');
    expect(ps('<pageSet><occur max="x"/><pageArea/></pageSet>')?.refusal)
      .toBe('pageSet occur max="x" could not be read (XFA 3.3 p. 300: -1 or positive)');
  });

  it('refuses a nested pageSet, a second one, and one not on the root subform', () => {
    expect(ps('<pageSet><pageSet><pageArea/></pageSet></pageSet>')?.refusal).toMatch(/more than one pageSet, or a nested one.*164g\.9/);
    expect(ps('<pageSet><pageArea/></pageSet><pageSet><pageArea/></pageSet>')?.refusal).toMatch(/more than one pageSet/);
    const t = tpl('<subform name="f" layout="tb"><subform name="S"><pageSet><pageArea/></pageSet></subform></subform>');
    expect(t.body?.pageSet?.refusal).toBe('a pageSet not on the root subform is not paginated');
  });

  it('has no page set when the root declares none', () => {
    const t = tpl('<subform name="f"><field name="a"><ui><textEdit/></ui></field></subform>');
    expect(t.body?.pageSet).toBeUndefined();
    expect(t.body?.root.label).toBe('f[0]');
  });
});

describe('parseXfaTemplate: break conditions (p. 632-636)', () => {
  const kid = (inner: string) => tpl(`<subform name="f" layout="tb"><pageSet><pageArea/></pageSet>
    <subform name="P">${inner}</subform></subform>`).body!.root.children[0];

  it('reads breakBefore and breakAfter', () => {
    const k = kid('<breakBefore targetType="pageArea" target="P1" startNew="1"/><breakAfter targetType="contentArea"/>');
    expect(k.breakBefore).toEqual({ targetType: 'pageArea', target: 'P1', startNew: true });
    expect(k.breakAfter).toEqual({ targetType: 'contentArea', startNew: false });
  });

  it('reads the deprecated break element\'s two halves', () => {
    const k = kid('<break before="pageArea" startNew="1" beforeTarget="#x" after="contentArea"/>');
    expect(k.breakBefore).toEqual({ targetType: 'pageArea', target: '#x', startNew: true });
    expect(k.breakAfter).toEqual({ targetType: 'contentArea', startNew: false });
  });

  // OPM 1644's <break overflowLeader="..."> on its tables asks for nothing at
  // either edge.
  it('reads an auto break, or none, as no break', () => {
    expect(kid('<breakBefore targetType="auto" target="P1"/>').breakBefore).toBeUndefined();
    expect(kid('<break overflowLeader="#h"/>').breakBefore).toBeUndefined();
    expect(kid('').breakBefore).toBeUndefined();
  });

  it('refuses a script, a leader, a trailer and pageEven/pageOdd by name', () => {
    expect(kid('<breakBefore targetType="pageArea"><script>true</script></breakBefore>').breakBefore?.refusal)
      .toBe('P[0]: <breakBefore> with a script is not implemented');
    expect(kid('<breakBefore targetType="pageArea" leader="#L"/>').breakBefore?.refusal)
      .toBe('P[0]: <breakBefore> with a leader or trailer is not implemented (164g.8)');
    expect(kid('<breakAfter targetType="pageArea" trailer="#T"/>').breakAfter?.refusal)
      .toBe('P[0]: <breakAfter> with a leader or trailer is not implemented (164g.8)');
    expect(kid('<breakBefore targetType="pageOdd"/>').breakBefore?.refusal)
      .toBe('P[0]: <breakBefore> targetType="pageOdd" is not implemented (164g.9)');
    expect(kid('<break before="pageEven"/>').breakBefore?.refusal)
      .toBe('P[0]: <break> before="pageEven" is not implemented (164g.9)');
  });
});
```

  (b) In `describe('parseXfaTemplate: geometry', ...)`: `const leafOf = (t: ReturnType<typeof tpl>) => t.body!.root.children[0].children[0];`

  (c) In `describe('parseXfaTemplate: the layout chain', ...)`: replace `t.roots[0].node.children[0]` with `t.body!.root.children[0]` (two places), and in the contentArea case replace `expect(t.roots[0].node.geom).toMatchObject({ x: '0.25in', y: '0.5in' });` with `expect(t.body!.pageSet!.pageAreas[0].contentAreas[0].node.geom).toMatchObject({ x: '0.25in', y: '0.5in' });`. In "carries a repeating page subform's REAL layout", replace its comment's last sentence with "It is a PAGE subform, instantiated since 164g.3; its chain carries its real layout."

  (d) Delete the whole `describe('parseXfaTemplate: page identity', ...)` block (four cases): pages are pagination's now, covered in `test/xfapage.test.ts` and the converter.

  (e) In `describe('parseXfaTemplate: the layout tree', ...)` replace the first case with:

```ts
  it('roots the tree at the root subform, its page subforms its children', () => {
    const t = tpl(`${PAGE}<subform name="Page1" layout="position" x="1pt">
      <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const r = t.body!.root;
    expect(r).toMatchObject({ kind: 'subform', label: 'form1[0]', layout: 'tb' });
    expect(r.children).toHaveLength(1);
    expect(r.children[0]).toMatchObject({
      kind: 'subform', label: 'Page1[0]', layout: 'position', geom: { x: '1pt' },
    });
    expect(r.children[0].children[0]).toMatchObject({
      kind: 'field', label: 'a[0]', field: 'form1[0].Page1[0].a[0]',
      geom: { x: '0', y: '0', w: '1in', h: '1in' },
    });
    expect(t.body!.pageSet!.pageAreas[0].contentAreas[0].node).toMatchObject({
      kind: 'page', label: 'contentArea', layout: 'tb',
      geom: { x: '0.25in', y: '0.5in', w: '8in', h: '10in' },
    });
  });

  // The root is a tb flow, so content directly under it takes up space there.
  it('puts a field directly under the root in the tree', () => {
    const t = tpl(`${PAGE}<field name="z" w="1in" h="1in"><ui><textEdit/></ui></field></subform>`);
    expect(t.body!.root.children[0]).toMatchObject({ kind: 'field', field: 'form1[0].z[0]' });
  });
```

  replace every remaining `t.roots[0].node.children[0]` in that block with `t.body!.root.children[0]`, delete the case "roots no page whose pageArea cannot be resolved", and replace "gives a pageArea with no contentArea an empty root geometry" with:

```ts
  it('models a pageArea with no contentArea as having none', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea name="P1"/></pageSet>
      <subform name="Page1"/></subform>`);
    expect(t.body!.pageSet!.pageAreas[0].contentAreas).toEqual([]);
  });
```

  (f) In the master-page block: `expect(t.pages).toHaveLength(2);` → `expect(t.body!.pageSet!.pageAreas).toHaveLength(2);`.

  (g) In the `<occur>` block: `const kids = t.roots[0].node.children[0].children;` → `const kids = t.body!.root.children[0].children;`; in `refused`, `t.roots.forEach((r) => visit(r.node));` → `if (t.body) visit(t.body.root);`; and replace "refuses a repeating PAGE subform (164g.3)" with the case below. It does NOT use `refused`, whose root states no layout: a root defaulting to `position` would refuse two instances as overlapping, which is a different rule.

```ts
  it('instantiates a repeating PAGE subform (164g.3)', () => {
    const t = tplWith(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P"><contentArea w="8in" h="10in"/></pageArea></pageSet>
      <subform name="Page1" layout="tb"><occur max="-1"/>
      <field name="a"><ui><textEdit/></ui></field></subform></subform>`, '<form1><Page1/><Page1/></form1>');
    expect(names(t)).toEqual(['form1[0].Page1[0].a[0]', 'form1[0].Page1[1].a[0]']);
    expect(t.body!.root.children.map((c) => [c.label, c.refusal]))
      .toEqual([['Page1[0]', undefined], ['Page1[1]', undefined]]);
  });
```

  (h) In `test/xfatemplate-text.test.ts`, replace each `tpl.roots[0].node` with `tpl.body!.root` (three places).

- [ ] **Step 2: Run to see them fail.** `npx vitest run test/xfatemplate.test.ts test/xfatemplate-text.test.ts` — FAIL (`body` undefined; `roots` still present).

- [ ] **Step 3: Implement the template.** In `src/xfatemplate.ts`:

  (a) Imports: replace the `xfaflow.js` import with
  `import type { LayoutKind, LayoutNode, XfaBreak, XfaMinMax } from './xfaflow.js';`
  and add
  `import type { XfaBody, XfaContentArea, XfaPageAreaModel, XfaPageSet } from './xfapage.js';`

  (b) Delete `XfaField.pageIndex` (and its doc comment), `XfaLayoutRoot`, and `pageRootOf`. Replace `XfaTemplate` with:

```ts
export interface XfaTemplate {
  fields: XfaField[];
  /** The root subform's layout node -- its children are the page-level content
   *  -- and its `<pageSet>`. Pages are an OUTPUT of layout (`xfapage.ts`,
   *  164g.3), so nothing here says which page a field is on. Absent only for a
   *  template with no root subform. */
  body?: XfaBody;
  /** Fields on a MASTER page (`<pageSet>` › `<pageArea>`), named as LiveCycle
   *  writes a page's first instance: `form1[0].#pageSet[0].Page1[0].x[0]`.
   *
   *  **Invariant (d3mq):** they are a list of their OWN, never in `fields`, so
   *  layout, measuring and data binding cannot see them. Adobe writes one
   *  instance PER PAGE (`Page1[0..n]`); placing those is d3mq part 2. */
  masterPageFields: XfaField[];
}
```

  (c) Add after `occurOf`:

```ts
/** A `<pageSet>` or `<pageArea>`'s `<occur max>`: -1 (the default, p. 300) or a
 *  positive integer; anything else is unreadable. */
function layoutMax(el: XmlNode): number | undefined {
  const o = child(el, 'occur');
  const v = o?.attrs.get('max');
  if (v === undefined) return -1;
  const t = v.trim();
  if (t === '-1') return -1;
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : undefined;
}

/** `<breakBefore>`/`<breakAfter>`, else the deprecated `<break>`'s half
 *  (p. 632-636), or `undefined` when it asks for nothing: `auto` continues in
 *  the current container (p. 635). `label` prefixes a refusal. */
function breakOf(el: XmlNode, which: 'before' | 'after', label: string): XfaBreak | undefined {
  const modern = child(el, which === 'before' ? 'breakBefore' : 'breakAfter');
  const legacy = modern ? undefined : child(el, 'break');
  if (!modern && !legacy) return undefined;
  const tag = `<${(modern ?? legacy)!.name}>`;
  const targetType = (modern ? modern.attrs.get('targetType') : legacy!.attrs.get(which)) ?? 'auto';
  const target = modern ? modern.attrs.get('target')
    : legacy!.attrs.get(which === 'before' ? 'beforeTarget' : 'afterTarget');
  const startNew = modern ? modern.attrs.get('startNew') === '1'
    : which === 'before' && legacy!.attrs.get('startNew') === '1';
  const shown = modern ? `${tag} targetType="${targetType}"` : `${tag} ${which}="${targetType}"`;
  let refusal: string | undefined;
  const script = modern ? child(modern, 'script') : undefined;
  if (script && script.text.trim() !== '') refusal = `${label}: ${tag} with a script is not implemented`;
  else if (modern && ((modern.attrs.get('leader') ?? '').trim() !== '' || (modern.attrs.get('trailer') ?? '').trim() !== ''))
    refusal = `${label}: ${tag} with a leader or trailer is not implemented (164g.8)`;
  else if (targetType === 'pageEven' || targetType === 'pageOdd')
    refusal = `${label}: ${shown} is not implemented (164g.9)`;
  else if (!['auto', 'pageArea', 'contentArea'].includes(targetType))
    refusal = `${label}: ${shown} is not one XFA defines`;
  if (targetType === 'auto' && refusal === undefined) return undefined;
  return {
    targetType,
    ...(target !== undefined && target.trim() !== '' ? { target } : {}),
    startNew,
    ...(refusal !== undefined ? { refusal } : {}),
  };
}
```

  (d) In `nodeOf`, after `if (kind === 'field' || kind === 'draw') n.text = leafText(el);` add:

```ts
  if (kind === 'subform') {
    const bb = breakOf(el, 'before', label);
    if (bb) n.breakBefore = bb;
    const ba = breakOf(el, 'after', label);
    if (ba) n.breakAfter = ba;
  }
```

  (e) In `repetition`, delete the `isPage` parameter and the line
  `if (isPage) return { count: 1, refusal: 'a repeating page subform needs page breaking (164g.3)' };`
  and at the call site drop the `carriesPageSet` argument:
  `repetition(c, anonymous, somName(dpath), el.attrs.get('layout') ?? 'position', groups)`.

  (f) Change `ChainCtx` to drop `pageIndex`:

```ts
interface ChainCtx {
  /** Layouts between the page origin and here, outermost first. */
  layouts: string[];
  /** True once the walk has passed BELOW the root subform, which carries the
   *  `<pageSet>`. Above it there is no page origin, so nothing is accumulated. */
  inPage: boolean;
}

/** The walk's view of the template as a whole. */
interface Top {
  /** The root subform; its node becomes `XfaBody.root`. Undefined for the walk
   *  over a master page. */
  rootEl?: XmlNode;
  /** Some page area declares a content area: the chain then starts at one. */
  hasCa: boolean;
  root?: LayoutNode;
}
```

  (g) Rewrite `walk`'s signature and its subform branch. The signature becomes

```ts
function walk(
  el: XmlNode, path: readonly string[], dpath: readonly string[], group: GroupPaths | undefined,
  ctx: ChainCtx, out: XfaField[], parent: LayoutNode | undefined, scope: IndexScope,
  master: XfaField[], groups: XfaDataGroups | undefined, top: Top,
): void {
```

  delete `const carriesPageSet = ...` and `let nextPage = 0;`, change the master-page call to
  `walk(pa, at, [], undefined, { layouts: [], inPage: false }, master, undefined, newScope(), master, undefined, { hasCa: false });`,
  in the field branch delete `if (ctx.pageIndex !== undefined) f.pageIndex = ctx.pageIndex;`,
  and replace everything from `let next: ChainCtx;` to the end of the instance loop body with:

```ts
      let next: ChainCtx;
      if (c === top.rootEl) {
        // The root subform: a tb flow that pagination (xfapage.ts) pours into
        // content areas. Its node IS the body; the chain of everything below
        // starts at the content area, which places its first child at its
        // origin.
        top.root = node;
        next = { layouts: top.hasCa ? ['position'] : [], inPage: true };
      } else if (!ctx.inPage) {
        // Still above any page origin: accumulate nothing.
        next = { layouts: [], inPage: false };
      } else {
        parent?.children.push(node);
        next = { layouts: [...ctx.layouts, layoutOf(c)], inPage: true };
      }
      walk(
        c, sub, dsub,
        c.name === 'exclGroup' ? { som: somName(sub), data: somName(dsub) } : group,
        next, out, next.inPage ? node : undefined,
        anonymous ? scope : newScope(), master, groups, top,
      );
```

  Update `walk`'s doc comment: replace the paragraph beginning "**Where the chain BEGINS" with:

```ts
 * **Where the chain BEGINS:** at the content area, below the root subform.
 * LiveCycle's root `<subform>` -- the one carrying the `<pageSet>` -- is
 * routinely `layout="tb"`, because that flow is what breaks PAGES (164g.3,
 * `xfapage.ts`) rather than what places FIELDS. Read as starting at the
 * document root, "every ancestor must be position" degrades every field of
 * every LiveCycle form.
```

  (h) Replace `pageAreaElements`, `pageAreaOf` and `parseXfaTemplate` with:

```ts
/** Every `<pageSet>` in the template, with the element holding it. */
function pageSets(el: XmlNode, out: Array<{ ps: XmlNode; parent: XmlNode }>): void {
  for (const c of el.children) {
    if (c.name === 'pageSet') out.push({ ps: c, parent: el });
    pageSets(c, out);
  }
}

/** One `<pageArea>` element to its model. A content area's node is the `tb`
 *  root `xfapage.ts` lays out (XFA 3.3 p. 288). */
function pageAreaOf(el: XmlNode): XfaPageAreaModel | string {
  const m = child(el, 'medium');
  let medium: XfaMedium | undefined;
  if (m) {
    const short = m.attrs.get('short');
    const long = m.attrs.get('long');
    const orientation = m.attrs.get('orientation');
    medium = {
      ...(short !== undefined ? { short } : {}),
      ...(long !== undefined ? { long } : {}),
      ...(orientation !== undefined ? { orientation } : {}),
    };
  }
  const max = layoutMax(el);
  if (max === undefined)
    return `pageArea occur max="${child(el, 'occur')?.attrs.get('max') ?? ''}" could not be read (XFA 3.3 p. 300: -1 or positive)`;
  const named = (x: XmlNode) => {
    const name = x.attrs.get('name');
    const id = x.attrs.get('id');
    return { ...(name !== undefined ? { name } : {}), ...(id !== undefined ? { id } : {}) };
  };
  const contentAreas: XfaContentArea[] = el.children.filter((c) => c.name === 'contentArea').map((c) => ({
    ...named(c),
    node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: geomOf(c), children: [] },
  }));
  return { ...named(el), ...(medium ? { medium } : {}), max, contentAreas };
}

/** The root subform's `<pageSet>` model, or why it cannot be paginated. */
function pageSetOf(template: XmlNode, rootEl: XmlNode): XfaPageSet | undefined {
  const found: Array<{ ps: XmlNode; parent: XmlNode }> = [];
  pageSets(template, found);
  if (found.length === 0) return undefined;
  const { ps, parent } = found[0];
  const areas: XfaPageAreaModel[] = [];
  let refusal: string | undefined;
  for (const c of ps.children) {
    if (c.name !== 'pageArea') continue;
    const a = pageAreaOf(c);
    if (typeof a === 'string') { refusal ??= a; continue; }
    areas.push(a);
  }
  const max = layoutMax(ps);
  if (max === undefined)
    refusal = `pageSet occur max="${child(ps, 'occur')?.attrs.get('max') ?? ''}" could not be read (XFA 3.3 p. 300: -1 or positive)`;
  if (found.length > 1) refusal = 'more than one pageSet, or a nested one, is not paginated (164g.9)';
  if (parent !== rootEl) refusal = 'a pageSet not on the root subform is not paginated';
  return {
    relation: ps.attrs.get('relation') ?? 'orderedOccurrence',
    max: max ?? -1,
    pageAreas: areas,
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** The `template` packet's root element to the field model. `groups` is the
 *  datasets' data groups (164g.2); omitted, every repeating subform takes its
 *  `initial`, the empty-merge answer. */
export function parseXfaTemplate(root: XmlNode, groups?: XfaDataGroups): XfaTemplate {
  const rootEl = root.children.find((c) => c.name === 'subform');
  const pageSet = rootEl ? pageSetOf(root, rootEl) : undefined;
  const top: Top = { ...(rootEl ? { rootEl } : {}), hasCa: pageSet?.pageAreas.some((p) => p.contentAreas.length > 0) ?? false };
  const fields: XfaField[] = [];
  const masterPageFields: XfaField[] = [];
  walk(root, [], [], undefined, { layouts: [], inPage: false }, fields, undefined, newScope(),
    masterPageFields, groups, top);
  const body: XfaBody | undefined = top.root ? { root: top.root, ...(pageSet ? { pageSet } : {}) } : undefined;
  return { fields, ...(body ? { body } : {}), masterPageFields };
}
```

  Keep `export interface XfaPageArea { name?: string; medium?: XfaMedium }` as it is.

- [ ] **Step 4: Run the template tests.** `npx vitest run test/xfatemplate.test.ts test/xfatemplate-text.test.ts` — PASS. (`npm run typecheck` will still fail in `xfaconvert.ts` and two test files until the next steps.)

- [ ] **Step 5: Give the converter fixtures their content areas.** Templates that place fields now need a `<contentArea>` (spec, "pure boilerplate"). Run once, from the repo root:

```bash
node -e "
const fs=require('fs');
for (const f of ['test/helpers/build-xfa-pdf.ts','test/xfaconvert.test.ts','test/xfaconvert-choice-data.test.ts']) {
  let s=fs.readFileSync(f,'utf8'); let n=0;
  s=s.replace(/<pageArea([^>]*)>((?:(?!<\/pageArea>)[\s\S])*?)<\/pageArea>/g,(m,attrs,inner)=>{
    if(/<contentArea/.test(inner)) return m;
    const md=inner.match(/<medium short=\"([^\"]+)\" long=\"([^\"]+)\"( orientation=\"landscape\")?\/>/);
    if(!md) return m;
    const [w,h]=md[3]?[md[2],md[1]]:[md[1],md[2]]; n++;
    return '<pageArea'+attrs+'>'+inner+'<contentArea w=\"'+w+'\" h=\"'+h+'\"/></pageArea>';
  });
  fs.writeFileSync(f,s); console.log(f,n);
}"
```

  Then, by hand in `test/helpers/build-xfa-pdf.ts`:
  - **`FLOWED_TEMPLATE` and `NESTED_FLOW_TEMPLATE`**: remove the `<contentArea .../>` the script added, so they still degrade (now for the missing content area). Update `FLOWED_TEMPLATE`'s doc comment to "The same field under a page set with no content area, so it degrades (no content can be laid out)."
  - **`THREE_DEEP_TEMPLATE`**: a flowed child's own x/y is ignored (p. 279), so move Page1's offset onto the content area. Change `<subform name="Page1" layout="position" x="0.25in" y="0.25in">` to `<subform name="Page1" layout="position">` and the added content area to `<contentArea x="0.25in" y="0.25in" w="8in" h="10.5in"/>`. The sum stays 0.25in + 1in + 10pt = 100pt; update its comment to say the first level is the content area.

- [ ] **Step 6: Update the converter tests that name the old rules.** In `test/xfaconvert.test.ts`:
  - "degrades a flow-laid field to bare and says why": `reason: expect.stringMatching(/layout/i)` → `reason: expect.stringMatching(/no pageArea declares a contentArea/)`.
  - "degrades the whole document when the pageArea count disagrees with the pages" → rename to "degrades the whole document when the layout's page count disagrees with the pages" and change `/pageArea/i` to `/the layout produces 1 page\(s\) and the document has 2/`.
  - Add, as Review Focus 1, in the same `describe`. The bad target goes on the SECOND page subform: on the first it would be the start rule, which refuses everything and produces no page at all.

```ts
  // Review Focus 1: a page subform that cannot be paginated takes every later
  // one with it, the counts then disagree, and the document reason must still
  // name the refusal that caused it.
  it('names the first pagination refusal when the page counts then disagree', () => {
    const t = POSITIONED_TEMPLATE.replace('</subform></subform></template>',
      '</subform><subform name="Page2" layout="position"><breakBefore targetType="pageArea" target="Nowhere"/>'
      + '<field name="b" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field></subform></subform></template>');
    const p = planOf(buildXfaPdf({ template: t, pages: 2 }));
    const doc = p.report.skipped.find((s) => s.what === 'document');
    expect(doc?.reason).toMatch(/layout produces 1 page\(s\) and the document has 2.*break target "Nowhere" names no pageArea/);
  });
```

- [ ] **Step 7: Implement the converter.** In `src/xfaconvert.ts`:

  (a) Imports: `import { layoutPage, type Placed, type XfaMeasure } from './xfaflow.js';` → `import { type Placed, type XfaMeasure } from './xfaflow.js';` and add `import { layoutPages } from './xfapage.js';`.

  (b) Replace steps 3, 4 and 4b (from the comment `// 3. Page identity.` down to the end of the `if (!noGeometry) { const measure = ... }` block) with:

```ts
  // 3. Pagination (164g.3): pages are an OUTPUT of layout. The root subform's
  //    children are poured into content areas and page-area instances, and a
  //    field's page is wherever its page subform landed.
  const measure = xfaMeasurer(doc, tpl, values);
  const laid = tpl.body ? layoutPages(tpl.body, measure, report.warnings)
    : { pages: [], refused: new Map<string, string>() };
  const pageSet = tpl.body?.pageSet;

  // 4. Page identity. A layout whose page count disagrees with the document's
  //    degrades the WHOLE document's geometry rather than aligning the two by
  //    guess -- a field placed perfectly on the wrong sheet looks right and is
  //    wrong. The first pagination refusal rides along, or the cause is lost.
  let noGeometry = false;
  if (!pageSet) {
    report.skipped.push({
      what: 'document',
      reason: "the template's root subform declares no <pageSet>, so no field can be placed",
    });
    noGeometry = true;
  } else if (laid.pages.length > 0 && laid.pages.length !== doc.Pages.length) {
    const first = laid.refused.values().next().value;
    report.skipped.push({
      what: 'document',
      reason: `the layout produces ${String(laid.pages.length)} page(s) and the document has `
        + `${String(doc.Pages.length)}, so no field can be placed`
        + (first !== undefined ? ` (first refusal: ${first})` : ''),
    });
    noGeometry = true;
  }

  // 4a. Per-page medium. This is the check that makes the rest trustworthy: it
  //     asserts against a number we did not compute.
  const badPages = new Set<number>();
  const crops: number[][] = [];
  if (!noGeometry && pageSet) {
    for (let i = 0; i < laid.pages.length; i++) {
      crops[i] = doc.Pages[i].CropBox;
      if (mediumAgrees(pageSet.pageAreas[laid.pages[i].pageArea].medium, crops[i])) continue;
      badPages.add(i);
      report.skipped.push({
        what: 'page',
        reason: `page ${String(i + 1)}: the template's <medium> does not match the `
          + "page's CropBox, so no field on it can be placed",
      });
    }
  }

  // 4b. Each field's page and box, keyed by SOM name.
  const where = new Map<string, { page: number; p: Placed }>();
  laid.pages.forEach((pg, i) => {
    for (const [k, v] of pg.placed) {
      where.set(k, where.has(k)
        ? { page: i, p: { reason: `two fields share the SOM name ${k}, so neither can be placed by it` } }
        : { page: i, p: v });
    }
  });
```

  (c) The call `geometryFor(f, entry, doc, noGeometry, badPages, placed)` becomes `geometryFor(f, entry, noGeometry, badPages, where, laid.refused, crops)`, and `geometryFor` becomes:

```ts
function geometryFor(
  f: XfaField, entry: PlanEntry, noGeometry: boolean, badPages: ReadonlySet<number>,
  where: ReadonlyMap<string, { page: number; p: Placed }>,
  refused: ReadonlyMap<string, string>, crops: readonly number[][],
): string | undefined {
  if (noGeometry) return '';
  const r = refused.get(f.name);
  if (r !== undefined) return `${r}, so the field carries no geometry`;
  const w = where.get(f.name);
  if (w === undefined) return 'the field is not on any laid-out page, so it carries no geometry';
  if (badPages.has(w.page)) return '';
  const p = w.p;
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
  entry.page = w.page + 1;
  entry.rect = rectFromBox(button, crops[w.page]);
  return undefined;
}
```

  Update `geometryFor`'s doc comment to read "`''` means "already reported" -- the document- and page-level refusals, whose one entry names the cause for every field on them."

  (d) In step 5b, change the master-page reason to
  `'a field on a master page (<pageArea>) is not converted yet: each page carries its own instance (d3mq)'`
  and its comment's "(164g.3)" to "(d3mq part 2)".

  (e) In the module doc comment, change "an unresolvable page" to "a page the layout cannot produce".

- [ ] **Step 8: Update the oracle tests that used `roots`.** In `test/xfa-dynamic-oracle.test.ts`:
  - imports: add `import { layoutPages } from '../src/xfapage.js';`.
  - `expect(tpl.pages).toHaveLength(1);` → `expect(tpl.body!.pageSet!.pageAreas).toHaveLength(1);`.
  - `const page1 = tpl.roots[0].node.children[0];` → `const page1 = tpl.body!.root.children[0];`.
  - in "header: three Header instances…", `t.roots[0].node.children[0].children` → `t.body!.root.children[0].children`.
  - Replace the body of "agrees with every box the flow engine places" with:

```ts
    const placed: Record<string, number> = {};
    for (const v of DYNAMIC_VARIANTS) {
      const tpl = templateOf(deriveVariant(source, v));
      const laid = layoutPages(tpl.body!);
      placed[v] = 0;
      laid.pages.forEach((pg, i) => {
        for (const [name, p] of pg.placed) {
          if (!('box' in p)) continue;
          placed[v]++;
          const g = one(v, dataOf(tpl, name));
          expect(g.page, `${v} ${name} page`).toBe(i + 1);
          for (const k of ['x', 'y', 'w', 'h'] as const)
            expect(Math.abs(p.box[k] - g[k]), `${v} ${name} ${k}`).toBeLessThanOrEqual(0.05);
        }
      });
    }
    expect(placed).toEqual({ published: 37, header: 37, pages: 37 });
```

    Run it once; the counts RISE because `Page2` now lands on page 2 (and in `pages` on pages 2-4). Every placed box must still agree with pdf.js and sit on pdf.js's page — those two `expect`s are what must hold. Then replace the `toEqual` with the observed counts, and update the comment above the case: "Since 164g.3 the page subforms are paginated, so `Page2` lands on page 2 (and in `pages`, its three instances on pages 2-4), and each placed box agrees with pdf.js on pdf.js's page. This loop runs with NO text measurer, so text-sized fields still refuse here. The count is pinned so the issue that changes it updates it." If any box disagrees or sits on another page, STOP and investigate; do not loosen the tolerance.

  In `test/xfa-real.test.ts`, the fw9 case "converts every field to data when the pageArea count cannot be matched" no longer holds; leave it failing for Task 5 ONLY if Task 5 runs next in the same session — otherwise mark it `it.skip` with the comment `// Replaced in 164g.3 Task 5 by the fw9 rect oracle.` and remove the skip in Task 5.

- [ ] **Step 9: Run everything.** `npm run typecheck` — clean. `npx vitest run test/xfa` (all XFA files) — PASS except as noted for fw9. Then `npm test`. Any other failure: read it, fix the cause, and note it in the commit body.

- [ ] **Step 10: Commit.**

```bash
git add src/xfatemplate.ts src/xfaconvert.ts test/xfatemplate.test.ts test/xfatemplate-text.test.ts \
  test/xfa-dynamic-oracle.test.ts test/xfaconvert.test.ts test/xfaconvert-choice-data.test.ts \
  test/helpers/build-xfa-pdf.ts test/xfa-real.test.ts
git commit -m "feat(164g.3): pages are an output of layout -- template page set, converter page identity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dynamic documents -- replace the placeholder pages (`xfaconvert.ts`)

**Files:**
- Modify: `src/xfaconvert.ts`
- Create: `test/xfaconvert-pages.test.ts`

**Interfaces:**
- Consumes: Task 3's converter.
- Produces: `XfaConvertReport.pagesCreated: number`; `XfaPlan.newPages?: Array<{ w: number; h: number }>`.

- [ ] **Step 1: Write the failing tests.** Create `test/xfaconvert-pages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// A4 on purpose: the placeholder page buildXfaPdf writes is US Letter, so a
// page sized from the PLACEHOLDER rather than the <medium> is visible.
const TWO_PAGES = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="210mm" long="297mm"/>
    <contentArea w="210mm" h="297mm"/></pageArea></pageSet>
  <subform name="Page1" w="210mm" h="297mm">
    <field name="a" x="1in" y="1in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>
  <subform name="Page2" w="210mm" h="297mm"><break before="pageArea" startNew="1"/>
    <field name="b" x="1in" y="2in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>
  </subform></template>`;

const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
const A4: [number, number] = [595.2755905511812, 841.8897637795276];

describe('ConvertXfaToAcroForm: a dynamic document gets the pages its layout produces', () => {
  it('replaces the placeholder with one page per laid-out page, sized from the medium', () => {
    const doc = dynamic(TWO_PAGES);
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(2);
    expect(doc.Pages).toHaveLength(2);
    for (const p of doc.Pages) {
      expect(p.MediaBox[2]).toBeCloseTo(A4[0], 6);
      expect(p.MediaBox[3]).toBeCloseTo(A4[1], 6);
    }
    expect(r.warnings).toContainEqual(expect.stringMatching(/1 placeholder page\(s\) were replaced by the 2 page\(s\) the layout produced/));
    expect(r.fields.map((f) => [f.name, f.route, f.page])).toEqual([
      ['form1[0].Page1[0].a[0]', 'positioned', 1],
      ['form1[0].Page2[0].b[0]', 'positioned', 2],
    ]);
    // b sits 2in from the top of an A4 page.
    const rect = doc.resolve(doc.Form.Get('form1[0].Page2[0].b[0]')!.Dict.get('Rect')) as number[];
    expect(rect[3]).toBeCloseTo(A4[1] - 144, 6);
  });

  it('survives a save and reopen', () => {
    const doc = dynamic(TWO_PAGES);
    convertXfaToAcroForm(doc);
    const again = Document.Open(doc.Save());
    expect(again.Pages).toHaveLength(2);
    expect(again.Form.Get('form1[0].Page2[0].b[0]')).toBeDefined();
  });

  // Review Focus 2: replacing pages is one-way, so it happens only when
  // something is placed.
  it('leaves the document byte-identical when nothing would be placed', () => {
    const bytes = buildXfaPdf({ template: TWO_PAGES.replace(/<ui><textEdit\/><\/ui>/g, '<ui><signature/></ui>'), pages: 1, needsRendering: true });
    const doc = Document.Open(bytes);
    const before = doc.Save();
    const r = convertXfaToAcroForm(doc);
    expect(r.pagesCreated).toBe(0);
    expect(doc.Pages).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(doc.Save()), Buffer.from(before))).toBe(0);
  });

  it('refuses the whole document when a laid-out page has no readable medium', () => {
    const doc = dynamic(TWO_PAGES.replace('<medium short="210mm" long="297mm"/>', ''));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(doc.Pages).toHaveLength(1);
    expect(r.skipped).toContainEqual(expect.objectContaining({
      what: 'document', reason: expect.stringMatching(/page 1's pageArea states no readable <medium>/) as unknown as string,
    }));
    expect(r.fields.every((f) => f.route === 'bare')).toBe(true);
  });

  it('treats a document with AcroForm fields as a hybrid, whose count must match', () => {
    const doc = Document.Open(buildXfaPdf({ template: TWO_PAGES, pages: 1, needsRendering: true, acroFieldObjects: ['{HYBRID}'] }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(r.skipped).toContainEqual(expect.objectContaining({
      what: 'document', reason: expect.stringMatching(/layout produces 2 page\(s\) and the document has 1/) as unknown as string,
    }));
  });

  it('reports pagesCreated 0 for an ordinary hybrid conversion', () => {
    const doc = Document.Open(buildXfaPdf({ template: TWO_PAGES, pages: 2, mediaBox: [0, 0, A4[0], A4[1]] }));
    expect(convertXfaToAcroForm(doc, { removeXfa: false }).pagesCreated).toBe(0);
  });
});
```

- [ ] **Step 2: Run to see it fail.** `npx vitest run test/xfaconvert-pages.test.ts` — FAIL (`pagesCreated` undefined; dynamic count refused).

- [ ] **Step 3: Implement.** In `src/xfaconvert.ts`:

  (a) Imports: add `import { PageFormat } from './pageformat.js';` and add `mediumSizePt` to the `./xfageom.js` import.

  (b) `XfaConvertReport` gains, after `dataOnly`:

```ts
  /** Pages created for a DYNAMIC document (`/NeedsRendering`, no AcroForm
   *  fields), whose own pages are only Designer's placeholder: they are replaced
   *  by the pages its layout produced, each sized from its `<medium>`. 0 for a
   *  hybrid, whose pages are its own. */
  pagesCreated: number;
```

  and the report literal in `buildXfaPlan` gains `pagesCreated: 0`. `XfaPlan` gains

```ts
  /** For a dynamic document: the pages to create, in order, replacing the
   *  placeholder ones. Applied only when something is placed. */
  newPages?: Array<{ w: number; h: number }>;
```

  (c) In step 4, replace Task 3's whole `let noGeometry = false; if (!pageSet) { … } else if (…) { … }` with this ONE chain:

```ts
  // A DYNAMIC document's pages are Designer's placeholder ("please wait"):
  // the layout's pages replace them, each sized from its page area's <medium>.
  // A page with no readable medium gets no invented size, and a missing page
  // would shift every later one, so the whole document is refused.
  const isDynamic = doc.resolve(doc.catalog().get('NeedsRendering')) === true
    && doc.Form.Fields.length === 0;
  let newPages: Array<{ w: number; h: number }> | undefined;
  let noGeometry = false;
  if (!pageSet) {
    report.skipped.push({
      what: 'document',
      reason: "the template's root subform declares no <pageSet>, so no field can be placed",
    });
    noGeometry = true;
  } else if (isDynamic && laid.pages.length > 0) {
    const sizes = laid.pages.map((pg) => mediumSizePt(pageSet.pageAreas[pg.pageArea].medium));
    const missing = sizes.findIndex((s) => s === undefined);
    if (missing >= 0) {
      report.skipped.push({
        what: 'document',
        reason: `page ${String(missing + 1)}'s pageArea states no readable <medium>, so the `
          + 'laid-out pages cannot be created and no field can be placed',
      });
      noGeometry = true;
    } else {
      newPages = sizes as Array<{ w: number; h: number }>;
    }
  } else if (laid.pages.length > 0 && laid.pages.length !== doc.Pages.length) {
    const first = laid.refused.values().next().value;
    report.skipped.push({
      what: 'document',
      reason: `the layout produces ${String(laid.pages.length)} page(s) and the document has `
        + `${String(doc.Pages.length)}, so no field can be placed`
        + (first !== undefined ? ` (first refusal: ${first})` : ''),
    });
    noGeometry = true;
  }
```

  (d) In step 4a, the per-page medium loop runs only for a hybrid; for a dynamic document the crop is the page it will create. Replace its loop head with:

```ts
  if (!noGeometry && pageSet) {
    for (let i = 0; i < laid.pages.length; i++) {
      if (newPages) { crops[i] = [0, 0, newPages[i].w, newPages[i].h]; continue; }
      crops[i] = doc.Pages[i].CropBox;
```

  (keep the rest of the loop body as it is).

  (e) `return { report, entries, groups };` at the end of `buildXfaPlan` → `return { report, entries, groups, ...(newPages ? { newPages } : {}) };`.

  (f) In `convertXfaToAcroForm`, right after `const plan = buildXfaPlan(doc, opts);` and its early return, add:

```ts
  // A dynamic document's placeholder pages give way to the laid-out ones, but
  // only when something will actually be PLACED on them: this is one-way, like
  // removing /XFA, and a form we cannot lay out must leave the file as it was.
  if (plan.newPages && (plan.entries.some((e) => !e.reconcile && e.rect !== undefined)
    || plan.groups.some((g) => !g.reconcile))) {
    const old = doc.Pages.length;
    for (const s of plan.newPages) doc.AddPage(PageFormat.custom(s.w, s.h));
    for (let i = 0; i < old; i++) doc.RemovePage(1);
    plan.report.pagesCreated = plan.newPages.length;
    plan.report.warnings.push(`the document's ${String(old)} placeholder page(s) were replaced by the `
      + `${String(plan.newPages.length)} page(s) the layout produced`);
  }
```

  Note the early return `if (plan.entries.length === 0 && plan.groups.length === 0) return plan.report;` already precedes this, so a plan with nothing at all never touches pages.

- [ ] **Step 4: Run.** `npx vitest run test/xfaconvert-pages.test.ts test/xfaconvert.test.ts` — PASS. `npm run typecheck` — clean.

- [ ] **Step 5: Commit.**

```bash
git add src/xfaconvert.ts test/xfaconvert-pages.test.ts
git commit -m "feat(164g.3): a dynamic XFA document's placeholder pages give way to the laid-out ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Adobe oracle -- fw9, I-130, I-765 (`test/xfa-real.test.ts`)

**Files:**
- Modify: `test/xfa-real.test.ts`, `test/fixtures/xfa/PROVENANCE.md`

**Interfaces:** Consumes the converter as of Task 4. Produces nothing for later tasks.

- [ ] **Step 1: Write the oracle cases.** In `test/xfa-real.test.ts`, delete the fw9 `describe` ("converts every field to data when the pageArea count cannot be matched"), and add:

```ts
/** The 0-based page Adobe put a field's widget on, from the page /Annots. */
function adobePage(src: Document, name: string): number {
  const f = src.Form.Get(name)!;
  const widgets = new Set<unknown>([f.Dict]);
  const kids = src.resolve(f.Dict.get('Kids'));
  if (Array.isArray(kids)) for (const k of kids) widgets.add(src.resolve(k));
  return src.Pages.findIndex((p) => {
    const annots = src.resolve(p.Dict.get('Annots'));
    return Array.isArray(annots) && annots.some((a) => widgets.has(src.resolve(a)));
  });
}

// 164g.3: each of these declares ONE <pageArea> for a multi-page document --
// LiveCycle's ordinary way of saying "this page repeats" -- and was refused
// outright until pages became an output of layout. Each page subform is as
// tall as its content area (fw9's odd pages 0.003pt taller, placed under the
// p. 295 override), so the layout produces exactly the document's pages, and
// every rect is compared with the one Adobe wrote. Master-page fields (the
// USCIS barcode) are d3mq's and left out.
describe('the paginated hybrid oracle (164g.3)', () => {
  for (const [file, pages] of [['irs-fw9.pdf', 6], ['uscis-i130.pdf', 12], ['uscis-i765.pdf', 7]] as const) {
    it(`${file}: lays out ${String(pages)} pages and reproduces every placed rect and page Adobe wrote`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields
        .filter((f) => !f.FullName.includes('#pageSet'))
        .map((f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[] | null]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.skipped.filter((s) => s.what === 'document' || s.what === 'page')).toEqual([]);
      let compared = 0;
      let exact = 0;
      let worst = 0;
      for (const f of report.fields) {
        if (f.route !== 'positioned') continue;
        const want = adobe.get(f.name);
        if (!want || want.length !== 4) continue;
        expect(f.page! - 1, `${f.name} page`).toBe(adobePage(src, f.name));
        const got = rectOf(doc, f.name);
        const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
        compared += 1;
        if (d <= 0.01) exact += 1;
        if (d > worst) worst = d;
      }
      expect(compared, 'fields compared').toBe(EXPECTED[file]);
      expect(exact, 'exact').toBe(compared);
      expect(worst).toBeLessThanOrEqual(0.01);
    });
  }
});
```

  with, above it, `const EXPECTED: Record<string, number> = { 'irs-fw9.pdf': 23, 'uscis-i130.pdf': 438, 'uscis-i765.pdf': 154 };` — the body-field counts Adobe wrote, i.e. the claim that EVERY one is placed.

- [ ] **Step 2: Run.** `npx vitest run test/xfa-real.test.ts`
  - If all three pass: done with this step.
  - If `compared` is lower than `EXPECTED`: list the fields that are not positioned (`report.fields.filter(f => f.route !== 'positioned')` with their `report.skipped` reasons). Each must be a refusal this repo already makes for a reason unrelated to pagination (a `<signature>`, an unmeasurable face, …). Set `EXPECTED` to the observed count ONLY then, and write the reasons into PROVENANCE (Step 3). A pagination reason in that list is a bug to fix, not a count to pin.
  - If `exact < compared` or a page disagrees: STOP. Print the field, our rect and page, Adobe's rect and page, and investigate the rule that differs. Do not loosen a tolerance.

- [ ] **Step 3: PROVENANCE.** In `test/fixtures/xfa/PROVENANCE.md`, add a section `## Pagination (164g.3)` saying: fw9, I-130 and I-765 each declare one `<pageArea>` for 6, 12 and 7 pages and were refused until pages became an output of layout; the suite now converts each from the template alone and compares every placed body field's rect AND page with Adobe's; the observed counts and worst error; fw9's odd page subforms are `h="10.999597in"` (791.971pt) in a 791.968pt content area and land on their own pages under the p. 295 override, which Adobe's page assignment confirms; and the ceiling — one producer, page subforms that each fill a page exactly, so no content area is ever shared or overflowed.

- [ ] **Step 4: Run the whole XFA set and commit.** `npx vitest run test/xfa` — PASS.

```bash
git add test/xfa-real.test.ts test/fixtures/xfa/PROVENANCE.md
git commit -m "test(164g.3): Adobe oracle -- fw9, I-130 and I-765 paginate onto Adobe's pages and rects

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The pdf.js oracle -- OPM 1644 across pages (`test/xfa-dynamic-oracle.test.ts`)

**Files:**
- Modify: `test/xfa-dynamic-oracle.test.ts`, `test/fixtures/xfa-dynamic/PROVENANCE.md`

**Interfaces:** Consumes `paginate`, `layoutPages` (Task 2), `measureExtent` (Task 1), the converter (Task 4).

- [ ] **Step 1: Write the cases.** In `test/xfa-dynamic-oracle.test.ts`, add `paginate` to the `xfapage.js` import and `measureExtent` to the `xfaflow.js` import, and append:

```ts
describe('164g.3: OPM 1644 paginated as pdf.js paginates it', () => {
  const membership = (v: (typeof DYNAMIC_VARIANTS)[number]) => {
    const tpl = templateOf(deriveVariant(source, v));
    return paginate(tpl.body!, (n, limit) => measureExtent(n, limit)).pages
      .map((p) => p.contentAreas.flatMap((c) => c.children.map((k) => k.label)));
  };

  // The tb root OF1644 holds two page-tall subforms; pdf.js puts each on its
  // own instance of the ONE pageArea.
  it('published: Page1 on page 1, Page2 on page 2', () => {
    expect(membership('published')).toEqual([['Page1[0]'], ['Page2[0]']]);
    expect(membership('published')).toHaveLength(goldens.variants.published.pages);
  });

  it('pages: Page2\'s three instances on pages 2-4', () => {
    expect(membership('pages')).toEqual([['Page1[0]'], ['Page2[0]'], ['Page2[1]'], ['Page2[2]']]);
    expect(membership('pages')).toHaveLength(goldens.variants.pages.pages);
  });

  // End to end: the placeholder page gives way to the laid-out ones, and each
  // Page2 instance's FieldQ1FinInst is on its own page, bound to its own group.
  it('pages: converts onto four pages, each Page2 instance with its own datum', () => {
    const doc = deriveVariant(source, 'pages');
    const r = doc.ConvertXfaToAcroForm({ removeXfa: false });
    expect(r.pagesCreated).toBe(4);
    expect(doc.Pages).toHaveLength(4);
    for (let k = 0; k < 3; k++) {
      const f = r.fields.find((x) => new RegExp(`\\.Page2\\[${String(k)}\\]\\..*FieldQ1FinInst\\[0\\]$`).test(x.name));
      expect(f, `Page2[${String(k)}]`).toBeDefined();
      expect(doc.Form.Get(f!.name)!.Value).toBe(`Bank ${String(k + 1)}`);
      if (f!.route === 'positioned') expect(f!.page).toBe(k + 2);
    }
  });
});
```

  The last loop asserts the page only where the field got a widget: whether `FieldQ1FinInst` is placed depends on text measurement this issue does not touch. Run it once and, if every instance is `positioned`, tighten it to `expect(f!.route).toBe('positioned'); expect(f!.page).toBe(k + 2);`.

- [ ] **Step 2: Run.** `npx vitest run test/xfa-dynamic-oracle.test.ts` — PASS. If `membership` differs from pdf.js's page assignment, STOP and investigate (print each page's children and pdf.js's `page` per subform golden).

- [ ] **Step 3: PROVENANCE.** In `test/fixtures/xfa-dynamic/PROVENANCE.md`, under "What it established on its first run", replace the sentence ending "`Page2` still waits on `164g.3`." with: "**Since `164g.3` the form paginates.** OF1644's two page-tall subforms land on two instances of the one `<pageArea>`, and in `pages` `Page2[0..2]` on pages 2-4, exactly as pdf.js puts them; every box the page-level loop places agrees with pdf.js on pdf.js's page, and the `pages` variant converts onto four pages with each instance bound to its own data group." Remove "no page breaking" from the list in the opening paragraph's description of what the hybrid oracle lacks only if it now reads wrongly (it describes the HYBRID oracle, so it stays).

- [ ] **Step 4: Commit.**

```bash
git add test/xfa-dynamic-oracle.test.ts test/fixtures/xfa-dynamic/PROVENANCE.md
git commit -m "test(164g.3): pdf.js oracle -- OPM 1644 paginates onto pdf.js's pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mutation sweep, docs, gates, close

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Mutation sweep.** For each mutation: apply it, VERIFY it applied (`git diff --stat` shows the file changed), run the named test files with `npx vitest run <files>`, record red/green, and `git checkout -- src/` to revert. A run that does not load a test file is not green: confirm the summary lists every file. Kill orphaned vitest workers before trusting a timing-sensitive run.

| # | Mutation | Expected red in |
|---|---|---|
| 1 | `xfaflow.ts` `flowTb`: bound page roots again (`const avail = this.available(n, m);`) | `xfaflow.test.ts` ("stacks a tb page root's children…"), `xfa-real.test.ts` (fw9) |
| 2 | `measureExtent`: `past: false` always | `xfaflow.test.ts` (measureExtent), `xfapage.test.ts` ("would need splitting" via layoutPages) |
| 3 | `inkBottom`: use the container's extent instead of recursing (`bottom = Math.max(bottom, sl.y + (this.extent(c) as Size).h)` for containers) | `xfaflow.test.ts` ("reports past only when a descendant box…") |
| 4 | `paginate`: first child's break not exempt (`c.breakBefore` applied for `first` too) | `xfapage.test.ts` ("opens no blank first page…") — NOT `xfa-real`: no vendored first page subform carries a `startNew` |
| 5 | `paginate`: the override places even when `past` | `xfapage.test.ts` ("refuses one whose content lies past…") |
| 6 | `paginate`: drop the next-region peek (always override an empty region) | `xfapage.test.ts` ("moves on to a taller next content area…") |
| 7 | `paginate`: a refused child does not refuse later ones (`cause` never set) | `xfapage.test.ts` (several "every child after it") |
| 8 | `Paginator.apply`: ignore `startNew` | `xfapage.test.ts` ("starts a new instance when startNew is 1") — NOT `xfa-real`: every vendored page subform fills its page, so the next one starts a page anyway |
| 9 | `Paginator.toPageArea`: allow moving backward without a new page-set instance (`if (this.canUse(a)) return this.open(a);`) | `xfapage.test.ts` ("never moves backward within a page-set instance") |
| 10 | `Paginator.nextPage`: never reuse the current page area (drop the first `if`) | `xfapage.test.ts` ("reuses the current page area before opening a new page-set instance") |
| 11 | `resolveTarget`: strip `#` but match `name` instead of `id` | `xfapage.test.ts` ("resolves a #target by XML id") |
| 12 | `resolveTarget`: accept a dotted SOM target by its last segment | `xfapage.test.ts` (Review Focus 4) |
| 13 | `layoutPages`: last write wins on a duplicated name | `xfapage.test.ts` (Review Focus 3) |
| 14 | `xfatemplate.ts` `breakOf`: ignore the legacy `<break>` | `xfatemplate.test.ts` — NOT the OPM membership: its `Page2` fills a page, so it starts one with or without the break |
| 15 | `xfaconvert.ts`: replace placeholder pages even when nothing is placed | `xfaconvert-pages.test.ts` (Review Focus 2) |
| 16 | `xfaconvert.ts`: size new pages from the placeholder's CropBox | `xfaconvert-pages.test.ts` ("sized from the medium") |
| 17 | `xfaconvert.ts`: drop the first refusal from the count-mismatch reason | `xfaconvert.test.ts` (Review Focus 1) |

  Any mutation that stays GREEN: either add the case that reddens it (and say so), or record why it cannot (equivalent mutant, redundant defence) — measured, not assumed — for CLAUDE.md.

- [ ] **Step 2: CHANGELOG.md.** Under `## [Unreleased]` → `### Added`, as the FIRST entry:

```markdown
- **`ConvertXfaToAcroForm` paginates XFA forms.** A `<pageArea>` is a template used for as many pages as layout needs, but conversion mapped page subform k to page area k and refused every field of a document whose page-area count differed from its page count -- which is how LiveCycle writes most multi-page forms. IRS fw9 (one page area, six pages), USCIS I-130 (twelve) and I-765 (seven) were refused outright, and a dynamic form's second page landed nowhere. The root subform's children are now poured into content areas and page-area instances as XFA 3.3 orders them (`orderedOccurrence`, p. 288-300 and 360-367): breaks to a page area or content area by `#id` or name, `startNew`, the deprecated `<break>`, page-area and page-set `occur max`, several content areas per page, and the p. 295 override that places a page subform 0.003pt taller than its content area. Each field's page is where its page subform landed. Converted from the template alone, fw9, I-130 and I-765 now put every body field on the page and rect Adobe wrote. A **dynamic** document (`/NeedsRendering`, no AcroForm fields) has only Designer's placeholder page, so it is replaced by the pages the layout produced, each sized from its `<medium>`, and `report.pagesCreated` says how many; OPM 1644 converts onto the pages pdf.js lays it out on. Content is never split across pages (`164g.8`), and `simplexPaginated`/`duplexPaginated` are refused (`164g.9`); both are named in the report. (aspose-pdf-foss-for-ts-164g.3)
```

  Replace "every body field on the page and rect Adobe wrote" with the measured counts if Task 5 pinned fewer than all.

- [ ] **Step 3: README.md.** In the `**XFA converts to AcroForm, without page breaking**` limitation: change the heading to `**XFA converts to AcroForm, without content splitting**`; replace `there is no page breaking, so a repeating page subform, a repeating subform bound by` with `pages are laid out as XFA's ordered pagination produces them, but content is never split across them, so a repeating subform bound by`; replace `content that overflows its \`contentArea\`` with `content too tall for an empty content area whose ink lies past it, a qualified pagination strategy (\`simplexPaginated\`/\`duplexPaginated\`), a break with a script, leader or trailer`; replace `and a \`pageArea\` count that disagrees with the document's page count` with `and a laid-out page count that disagrees with a hybrid document's page count`; replace `` `report.dataOnly` says the document converted to data and renders nothing at all, which is what a **dynamic** XFA form does: its fields become addressable, exportable and fillable, and the pages its layout engine would have built do not appear.`` with `` A **dynamic** XFA form, whose PDF pages are only a placeholder, gets the pages its layout produces, each sized from its `<medium>` (`report.pagesCreated`), with its fields on them; the form's static text and boxes are not drawn yet. ``; and replace `against **hybrid LiveCycle forms** (IRS f1040 and fw9)` with `against **hybrid LiveCycle forms** (IRS f1040 and fw9, USCIS I-130 and I-765)` and append after "…and nothing else." the sentence `fw9, I-130 and I-765 declare one page area for 6, 12 and 7 pages, and every body field lands on Adobe's page and rect.` (with Task 5's counts if fewer). In the API Reference, add `pagesCreated` wherever `XfaConvertReport`'s members are listed (grep `dataOnly` in README.md).

  Run `npx vitest run test/readme-api.test.ts` — PASS (no new export from `index.ts`: `xfapage.ts` is internal).

- [ ] **Step 4: CLAUDE.md.** Add a Source-list entry for `xfapage.ts` directly after the `xfarich.ts`/`xfatext.ts`/`xfafont.ts` entry, written in the file's style, covering: membership only, positions from `xfaflow.ts`; pure leaf, never throws; a refused child refuses every later one; the start-point conflict (Example 9.22) and the oracles that settle it; the p. 295 override and its two conditions (empty region, next region no taller, nothing past); targets by `#id`/bare name, SOM expressions refused; occurrence limits and the backward move through a new page-set instance; a pure-boilerplate page area read as max 1 (p. 298); an `<overflow>` target ignored because nothing splits; and the measured mutation results from Step 1 (which redden, which stay green and why). In the `xfaconvert.ts` part of the XFA entry, replace "an unresolvable page" wording and the "page-area count" invariant with: pages are an output of layout; a hybrid's laid-out count must equal its page count (the reason carries the first pagination refusal); a dynamic document's placeholder pages are replaced, only when something is placed, each sized from its `<medium>`, a page without one refusing the whole document. In the `xfatemplate.ts` notes, record that `XfaTemplate.body` replaced `roots`/`pages`/`pageIndex`, that the chain starts at the content area, and that a repeating page subform is instantiated since 164g.3. In the `fixtures/xfa/` table row, add I-130/I-765 and pagination. Then run the module-entry sweep; it must print nothing:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 5: Gates.** `npm run typecheck` (clean) and `npm test` (all green). Record the file and test counts.

- [ ] **Step 6: Commit, close, push.**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs(164g.3): XFA pagination in CHANGELOG, CLAUDE.md, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-164g.3
git pull --rebase --autostash && git push && git status
```

  `git status` must say "up to date with 'origin/main'". Note in the hand-off that d3mq (master-page fields, one per page) is now unblocked.
