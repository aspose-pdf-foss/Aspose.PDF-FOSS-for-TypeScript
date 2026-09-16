# Moving and reordering structure elements (`q7hc.3`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `StructElement.MoveTo(parent, index?)` and `ReorderChildren(order)` —
change an element's place in the tree without disturbing one `/ParentTree`
entry or one MCID's page.

**Architecture:** A new `structmove.ts` over two primitives exported from
`structremove.ts` (`detachKid`, `subtreeOf`) and `kArray` from
`structwrite.ts`. Everything validates before anything mutates. Before a move,
`/Pg` is materialized onto any element in the subtree that would otherwise
inherit it, which is what makes the move provably page-safe.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-14-struct-move-reorder-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only; add no npm runtime dep.
- **ESM + NodeNext.** Every relative import specifier carries the `.js`
  extension (`import { x } from './structremove.js'`).
- **`npm run typecheck` and `npm test` must both be green before any task is
  considered done.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Argument rejection uses `RangeError`** (outside the allowed set) and
  `TypeError` (wrong kind of thing) — `formcreate.ts`'s split.
- **Validate everything before mutating anything**, so a rejected call leaves
  the document byte-identical.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.3` in parentheses at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  The sweep must print nothing:
  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
  done
  ```
- **Never edit `test/import-cycles.test.ts`'s `KNOWN` list to make a build
  green.** A new pair means the edge you added closed a cycle; fix the edge.
- **A move must not touch the `/ParentTree`.** Not one entry.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/structremove.ts` | **Modify.** Export `detachKid`; add and export `subtreeOf`. |
| `src/structmove.ts` | **Create.** `StructContainer`, `moveElement`, `reorderChildren`, the `/Pg` materialization. |
| `src/struct.ts` | **Modify.** `StructElement.MoveTo` and `.ReorderChildren`; re-export `StructContainer`. |
| `src/index.ts` | **Modify.** Export the `StructContainer` type. |
| `test/struct-move.test.ts` | **Create.** Mechanics, refusals, order, `/Pg`, reorder. |
| `test/helpers/build-inherited-pg-pdf.ts` | **Create.** Two pages; an element with bare-integer MCIDs and no `/Pg` of its own. |

**Existing APIs this plan relies on** (verified, do not re-derive):

- `kArray(doc, dict): PdfObject[]` (`structwrite.ts:90`) — normalizes `/K` to a
  LIVE array, whether it was absent, a single value, or an array.
- `doc.pageRef(pageNumber): PdfRef` (`document.ts:1402`) and
  `page.Number` (`page.ts:88`) — how `structwrite.ts` itself gets a page ref.
- `StructElement` and `StructTreeRoot` BOTH carry `Dict: PdfDict` and
  `Ref: PdfRef | undefined`; only `StructElement` carries `Root`, which is what
  narrows the `StructContainer` union.

---

### Task 1: `MoveTo` — mechanics and refusals

Ships a move that is correct for every document this library authors. The
`/Pg` safety net for third-party trees is Task 2.

**Files:**
- Modify: `src/structremove.ts` (export `detachKid`; add `subtreeOf`)
- Create: `src/structmove.ts`
- Modify: `src/struct.ts`, `src/index.ts`
- Test: `test/struct-move.test.ts`

**Interfaces:**
- Consumes: `kArray` (`structwrite.js`), `detachKid` + `subtreeOf`
  (`structremove.js`, exported in this task).
- Produces:
  ```ts
  // structremove.ts
  export function detachKid(doc: Document, parent: PdfDict, dict: PdfDict): boolean;
  export function subtreeOf(el: StructElement): StructElement[];
  // structmove.ts
  export type StructContainer = StructElement | StructTreeRoot;
  export function moveElement(
    doc: Document, element: StructElement, parent: StructContainer, index?: number,
  ): void;
  // struct.ts, on StructElement
  MoveTo(parent: StructContainer, index?: number): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/struct-move.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** A Sect holding H1 "AAA" then P "bbb", both tagged, on one page.
 *
 *  `AddText(text, x, y, opts)` takes POSITIONAL coordinates — it is not an
 *  options-object API (`test/struct-write.test.ts:121`). */
function twoKids() {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  const page = doc.Pages[0];
  const root = doc.CreateStructTree();
  const sect = root.Append('Sect');
  const h = sect.Append('H1');
  const p = sect.Append('P');
  page.AddText('AAA', 72, 700, { tag: h });
  page.AddText('bbb', 72, 600, { tag: p });
  return { doc, page, root, sect, h, p };
}

describe('StructElement.MoveTo: mechanics', () => {
  it('moves a child to a new parent and updates /P', () => {
    const { doc, root, sect, p } = twoKids();
    const other = root.Append('Sect');

    p.MoveTo(other);

    expect(sect.Children.map((c) => c.Type)).toEqual(['H1']);
    expect(other.Children.map((c) => c.Type)).toEqual(['P']);
    // /P must follow, or Parent and the real container disagree.
    expect(doc.GetStructTree()!.Children[1].Children[0].Parent!.Dict)
      .toBe(other.Dict);
  });

  it('inserts at the given index among element children', () => {
    const { root, sect, h } = twoKids();
    const other = root.Append('Sect');
    const x = other.Append('Span');
    const y = other.Append('Span');
    x.SetType('Code');    // tell the two apart
    y.SetType('Quote');

    h.MoveTo(other, 1);
    expect(other.Children.map((c) => c.Type)).toEqual(['Code', 'H1', 'Quote']);
  });

  it('appends when no index is given', () => {
    const { root, sect, h } = twoKids();
    const other = root.Append('Sect');
    other.Append('Span');
    h.MoveTo(other);
    expect(other.Children.map((c) => c.Type)).toEqual(['Span', 'H1']);
  });

  it('moves to the tree root', () => {
    const { doc, root, sect, p } = twoKids();
    p.MoveTo(root, 0);
    expect(root.Children.map((c) => c.Type)).toEqual(['P', 'Sect']);
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1']);
    // Round-trips.
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['P', 'Sect']);
  });

  it('reorders within the same parent', () => {
    const { sect, p } = twoKids();
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
    p.MoveTo(sect, 0);
    expect(sect.Children.map((c) => c.Type)).toEqual(['P', 'H1']);
  });

  it('leaves the /ParentTree resolving every MCID', () => {
    const { doc, root, sect, p } = twoKids();
    const before = [root.ElementFor(0, 0)!.Type, root.ElementFor(0, 1)!.Type];
    expect(before).toEqual(['H1', 'P']);

    p.MoveTo(root, 0);

    const re = doc.GetStructTree()!;
    expect([re.ElementFor(0, 0)!.Type, re.ElementFor(0, 1)!.Type]).toEqual(['H1', 'P']);
  });
});

describe('StructElement.MoveTo: what order actually changes', () => {
  // MEASURED, and the issue's acceptance criterion says otherwise:
  // `extractStructured` sorts fragments by baseline and x and never touches the
  // structure tree, so a move provably cannot reorder GetStructuredText.
  // Asserted BOTH ways so the correction reads as a decision.
  it('changes GetText and ToMarkdown, and NOT GetStructuredText', () => {
    const { doc, page, sect, p } = twoKids();
    expect(sect.GetText()).toBe('AAA\nbbb');
    expect(doc.ToMarkdown()).toBe('# AAA\n\nbbb\n');
    const geometric = page.GetStructuredText().map((b) => b.text);

    p.MoveTo(sect, 0);

    expect(sect.GetText()).toBe('bbb\nAAA');
    expect(doc.ToMarkdown()).toBe('bbb\n\n# AAA\n');
    expect(page.GetStructuredText().map((b) => b.text)).toEqual(geometric);
  });
});

describe('StructElement.MoveTo: refusals', () => {
  it('refuses a move into the element itself', () => {
    const { sect } = twoKids();
    expect(() => sect.MoveTo(sect)).toThrow(RangeError);
  });

  // The one that matters: a cycle makes the tree unwalkable, so every consumer
  // that recurses would hang rather than report anything.
  it('refuses a move into its own descendant, and writes nothing', () => {
    const { doc, sect, h } = twoKids();
    const before = doc.Save();
    expect(() => sect.MoveTo(h)).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
    // The tree is intact: sect still holds both kids.
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
  });

  it('refuses a destination in another document', () => {
    const { p } = twoKids();
    const otherDoc = Document.Open(buildStampTarget());
    const otherRoot = otherDoc.CreateStructTree();
    expect(() => p.MoveTo(otherRoot)).toThrow(RangeError);
  });

  it('refuses an out-of-range index', () => {
    const { root, p } = twoKids();
    const other = root.Append('Sect');
    expect(() => p.MoveTo(other, 1)).toThrow(RangeError);   // empty: only 0 is valid
    expect(() => p.MoveTo(other, -1)).toThrow(RangeError);
  });

  it('refuses a non-integer index', () => {
    const { root, p } = twoKids();
    expect(() => p.MoveTo(root, 1.5)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-move.test.ts`
Expected: FAIL — `p.MoveTo is not a function`.

- [ ] **Step 3: Export the two primitives from `structremove.ts`**

In `src/structremove.ts`, change `function detachKid` to
`export function detachKid`, and add beside `subtree`:

```ts
/** The element and every descendant, cycle-guarded.
 *
 *  Exported so `structmove.ts` shares one answer to "what is this element's
 *  subtree" — the containment test behind the cycle refusal, and the walk the
 *  /Pg materialization runs. */
export function subtreeOf(el: StructElement): StructElement[] {
  const out: StructElement[] = [];
  subtree(el, out, new Set());
  return out;
}
```

and in `removeElement` replace

```ts
  const els: StructElement[] = [];
  subtree(element, els, new Set());
  out.elements = els.length;
```

with

```ts
  const els = subtreeOf(element);
  out.elements = els.length;
```

- [ ] **Step 4: Create `structmove.ts`**

Create `src/structmove.ts`:

```ts
import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';
import { kArray } from './structwrite.js';
import { detachKid, subtreeOf } from './structremove.js';

/** Anything that can hold structure elements: an element, or the tree root.
 *
 *  **Note the name:** deliberately NOT `StructParent`. `/StructParent` is an
 *  unrelated key on an annotation dict, already modelled here, and the
 *  collision would be read as a relationship that does not exist. */
export type StructContainer = StructElement | StructTreeRoot;

/** The tree root a container belongs to. Only `StructElement` carries `Root`,
 *  which is what narrows the union — `structmove.ts` imports both as TYPES
 *  only, so `instanceof` is unavailable. */
function rootOf(c: StructContainer): StructTreeRoot {
  return 'Root' in c ? c.Root : c;
}

/** Raw /K indices of the element kids of `dict`, in order. */
function elementSlots(doc: Document, dict: PdfDict): number[] {
  const raw = doc.resolve(dict.get('K'));
  const arr = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const kid = doc.resolve(arr[i]);
    if (isDict(kid) && kid.has('S')) out.push(i);
  }
  return out;
}

/** Write /Pg onto every element in `els` that has a BARE-INTEGER content item
 *  and no /Pg of its own, resolved from where it sits NOW.
 *
 *  **Invariant, and it is the whole safety property of a move:**
 *  `StructElement.Page` walks UP the ancestor chain, and `ContentItems`
 *  resolves a bare-integer MCID against that inherited page — so moving such an
 *  element to a parent on a different page silently re-points every one of its
 *  MCIDs, while the /ParentTree goes on mapping them to the element. The two
 *  directions then disagree, which is worse than either being wrong alone.
 *
 *  **Invariant:** it runs UNCONDITIONALLY, never only when the pages differ.
 *  Deciding whether they differ means resolving the destination's inherited
 *  /Pg — the same walk — so the conditional buys nothing and adds a branch that
 *  is SILENT when wrong.
 *
 *  Only BARE INTEGERS inherit: an MCR dict carries its own /Pg, and an OBJR is
 *  addressed through /StructParent rather than a page key. For anything this
 *  library authored this is a no-op, since `appendContentKid` already
 *  materialized /Pg. */
function materializePg(doc: Document, els: readonly StructElement[]): void {
  for (const el of els) {
    if (el.Dict.has('Pg')) continue;
    const raw = doc.resolve(el.Dict.get('K'));
    const arr: PdfObject[] = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);
    if (!arr.some((k) => typeof doc.resolve(k) === 'number')) continue;
    const page = el.Page;
    if (page === undefined) continue;   // nothing to inherit from either
    el.Dict.set('Pg', doc.pageRef(page.Number));
  }
}

/** Move `element` under `parent`, at `index` among its ELEMENT children
 *  (default: last).
 *
 *  **Invariant:** everything is validated before anything is written, so a
 *  rejected call leaves the document byte-identical — `formcreate.ts`'s rule.
 *
 *  **Invariant:** the /ParentTree is not touched, not one entry. A move changes
 *  /K and /P and nothing else, which is what keeps every MCID resolving. */
export function moveElement(
  doc: Document, element: StructElement, parent: StructContainer, index?: number,
): void {
  if (index !== undefined && !Number.isInteger(index))
    throw new TypeError('index must be an integer');
  if (element.Ref === undefined)
    throw new RangeError('cannot move an element with no indirect ref');
  if (parent.Ref === undefined)
    throw new RangeError('cannot move into a container with no indirect ref');
  if (rootOf(parent).Dict !== element.Root.Dict)
    throw new RangeError('cannot move an element into a different structure tree');

  // The cycle refusal. A tree with a loop is unwalkable, so GetText, Nodes,
  // docmodel.ts and the validator would all hang rather than report anything.
  const els = subtreeOf(element);
  if (els.some((e) => e.Dict === parent.Dict))
    throw new RangeError('cannot move an element into itself or its own subtree');

  const slots = elementSlots(doc, parent.Dict);
  // The element's own slot does not count when it is already under `parent`:
  // it is about to be removed, so the valid range is over the OTHERS.
  const own = slots.length - (parent.Dict === doc.resolve(element.Dict.get('P')) ? 1 : 0);
  const at = index ?? own;
  if (at < 0 || at > own) throw new RangeError(`index ${at} is out of range 0..${own}`);

  // --- nothing above this line has written anything ---

  materializePg(doc, els);

  const from = doc.resolve(element.Dict.get('P'));
  if (isDict(from)) detachKid(doc, from, element.Dict);

  const k = kArray(doc, parent.Dict);
  const after = elementSlots(doc, parent.Dict);
  const rawAt = at < after.length ? after[at] : k.length;
  k.splice(rawAt, 0, element.Ref);
  element.Dict.set('P', parent.Ref);
  doc.markModified();
}
```

- [ ] **Step 5: Wire it onto `StructElement`**

In `src/struct.ts`, add to the imports and re-export the type:

```ts
import { moveElement, type StructContainer } from './structmove.js';

export type { StructContainer } from './structmove.js';
```

and add the method after `Remove()`:

```ts
  /** Move this element under `parent`, at `index` among its element children
   *  (default: last). `parent` may be another element or the tree root.
   *
   *  Reading order IS the tree's order, so this is what fixes a reading order
   *  `AutoTag` got wrong. It changes `GetText`, `Nodes` and every export built
   *  on them; `GetStructuredText` is geometric and is unaffected.
   *
   *  Throws `RangeError` for a move into this element's own subtree, into a
   *  different structure tree, or at an out-of-range index, and `TypeError` for
   *  a non-integer index. Nothing is written when it throws. */
  MoveTo(parent: StructContainer, index?: number): void {
    moveElement(this.doc, this, parent, index);
  }
```

In `src/index.ts`, add `StructContainer` to the `export type` line from
`./struct.js`, keeping the run alphabetical:

```ts
export type {
  ContentItem, StructContainer, StructRemoveResult, StructRetagResult,
} from './struct.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/struct-move.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove three rules are load-bearing**

Mutation A — drop `element.Dict.set('P', parent.Ref)`. Expected: "moves a child
to a new parent and updates /P" FAILS. Restore.

Mutation B — delete the cycle check (the `els.some(...)` throw). Expected: the
descendant refusal FAILS. **Run it with a timeout** (`npx vitest run
test/struct-move.test.ts --testTimeout=10000`): a cycle may HANG `Children`
rather than fail an assertion, which is exactly the failure the check prevents.
Restore.

Mutation C — insert at `k.length` always, ignoring `rawAt`. Expected: "inserts
at the given index among element children" and "reorders within the same
parent" FAIL. Restore.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: green. Nothing calls `MoveTo` outside the new test, and
`structremove.ts`'s two exports change no behaviour.

- [ ] **Step 9: Commit**

```bash
git add src/structremove.ts src/structmove.ts src/struct.ts src/index.ts \
        test/struct-move.test.ts
git commit -m "feat(q7hc.3): StructElement.MoveTo — mechanics and refusals

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

No CHANGELOG entry yet: Task 2 completes the feature's safety property and
Task 3 carries the entry for both methods.

---

### Task 2: The `/Pg` hazard, and the fixture that proves it

`materializePg` shipped in Task 1 and is exercised by nothing — every fixture
there was authored through `AddText`, which already materializes `/Pg`. This
task builds the shape that reaches it.

**Files:**
- Create: `test/helpers/build-inherited-pg-pdf.ts`
- Test: `test/struct-move.test.ts`

**Interfaces:**
- Consumes: `MoveTo` (Task 1).
- Produces:
  ```ts
  export function buildInheritedPgPdf(): Uint8Array;
  ```

- [ ] **Step 1: Write the fixture**

Create `test/helpers/build-inherited-pg-pdf.ts`:

```ts
// Two tagged pages. The element carrying the marked content has BARE-INTEGER
// /K entries and NO /Pg of its own — it inherits one from its parent Sect.
//
// Hand-built because nothing this library authors can produce that shape:
// `appendContentKid` writes /Pg onto the element the first time content is
// added, so every element we create already owns one. The inherited case is
// the third-party and hand-built population, which is exactly who
// StructElement.MoveTo has to be safe for.
//
// Tree:  root -> Sect  (/Pg page 1) -> P    (no /Pg, /K 0)
//        root -> Other (/Pg page 2) -> Span (no /Pg, /K [])
// Moving P under Other must NOT change which page its MCID resolves against.
// The Span is what reaches the bare-integer guard — see the test that names it.

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

export function buildInheritedPgPdf(): Uint8Array {
  const c1 = '/P << /MCID 0 >> BDC 0 0 0 rg 10 10 20 20 re f EMC';
  const c2 = '0 0 1 rg 30 30 20 20 re f';
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 8 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << >> /Contents 5 0 R >>';
  objects[4] = '<< /Type /Page /Parent 2 0 R /StructParents 1 '
    + '/Resources << >> /Contents 6 0 R >>';
  objects[5] = streamObj(c1);
  objects[6] = streamObj(c2);
  objects[7] = '<< /Nums [0 [10 0 R] 1 []] >>';
  objects[8] = '<< /Type /StructTreeRoot /K [9 0 R 11 0 R] /ParentTree 7 0 R '
    + '/ParentTreeNextKey 2 >>';
  // Sect owns the /Pg; its child P does not.
  objects[9] = '<< /Type /StructElem /S /Sect /P 8 0 R /Pg 3 0 R /K [10 0 R] >>';
  objects[10] = '<< /Type /StructElem /S /P /P 9 0 R /K 0 >>';
  // A second top-level Sect, on the OTHER page, holding a Span that has
  // NEITHER a /Pg of its own NOR any bare-integer kid. That Span is the only
  // shape that reaches materializePg's bare-integer guard: `other` itself is
  // skipped by the earlier has('Pg') test, so without this element the guard
  // is unreachable and a mutation removing it measures nothing.
  objects[11] = '<< /Type /StructElem /S /Sect /P 8 0 R /Pg 4 0 R /K [12 0 R] >>';
  objects[12] = '<< /Type /StructElem /S /Span /P 11 0 R /K [] >>';
  return assemble(objects, 12, 1);
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/struct-move.test.ts` (import the builder at the TOP of the file
with the others):

```ts
import { buildInheritedPgPdf } from './helpers/build-inherited-pg-pdf.js';

describe('StructElement.MoveTo: an inherited /Pg', () => {
  // MEASURED, and it is the issue's own safety claim made true: "the element
  // keeps its content items and its /Pg" holds only when it HAS one.
  // StructElement.Page walks UP, and ContentItems resolves a bare-integer MCID
  // against that inherited page — so without materialization this move silently
  // re-points the MCID to page 2 while the /ParentTree still maps it under
  // page 1's key.
  it('keeps the MCID on its original page when moved across pages', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const p = sect.Children[0];

    expect(p.Dict.has('Pg')).toBe(false);          // inherits it
    expect(p.Page!.Number).toBe(1);
    expect(p.ContentItems[0].page!.Number).toBe(1);

    p.MoveTo(other);

    expect(p.Page!.Number).toBe(1);                 // unchanged
    expect(p.ContentItems[0].page!.Number).toBe(1);
    // The /ParentTree still resolves it, under page 1's key.
    expect(root.ElementFor(0, 0)!.Type).toBe('P');
  });

  it('materializes /Pg onto the element', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const p = sect.Children[0];
    p.MoveTo(other);
    expect(p.Dict.has('Pg')).toBe(true);
  });

  // An element with no bare-integer kids has nothing to protect, so it gets no
  // /Pg. Without the guard the move would write one onto every element it
  // touched, changing documents that did not need changing.
  //
  // The element that reaches the guard is the SPAN inside `other`: it has no
  // /Pg of its own AND no bare-integer kid. `other` itself never gets there —
  // it owns a /Pg, so the earlier has('Pg') test skips it first.
  it('leaves an element with no bare-integer kids alone', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const span = other.Children[0];
    expect(span.Type).toBe('Span');
    expect(span.Dict.has('Pg')).toBe(false);

    other.MoveTo(sect);

    expect(span.Dict.has('Pg')).toBe(false);        // still nothing to protect
    expect(other.Dict.has('Pg')).toBe(true);        // its own, untouched
  });
});
```

- [ ] **Step 3: Run to confirm the fixture reaches the rule**

Run: `npx vitest run test/struct-move.test.ts`
Expected: PASS — `materializePg` shipped in Task 1, so these should be green
immediately. **If the first case fails, the bug is real and this fixture found
it**; fix `structmove.ts`, not the fixture.

- [ ] **Step 4: Prove the materialization is load-bearing**

Mutation — make `materializePg` return immediately (`return;` on its first
line). Expected: "keeps the MCID on its original page when moved across pages"
and "materializes /Pg onto the element" BOTH fail, and every Task 1 case stays
GREEN — which is the measured claim that nothing this library authors can reach
this rule. Restore, and record both counts in the commit message.

- [ ] **Step 5: Prove the bare-integer guard is load-bearing**

Mutation — delete the `if (!arr.some(...)) continue;` line so `/Pg` is written
onto every element in the subtree. Expected: "leaves an element with no
bare-integer kids alone" FAILS. Restore.

- [ ] **Step 6: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/build-inherited-pg-pdf.ts test/struct-move.test.ts
git commit -m "test(q7hc.3): pin the inherited-/Pg move, which nothing we author can reach

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `ReorderChildren`, and the docs

**Files:**
- Modify: `src/structmove.ts` (add `reorderChildren`)
- Modify: `src/struct.ts` (add the method)
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`
- Test: `test/struct-move.test.ts`

**Interfaces:**
- Consumes: `elementSlots` (Task 1, module-private).
- Produces:
  ```ts
  // structmove.ts
  export function reorderChildren(
    doc: Document, element: StructElement, order: readonly StructElement[],
  ): void;
  // struct.ts, on StructElement
  ReorderChildren(order: StructElement[]): void;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/struct-move.test.ts`:

```ts
describe('StructElement.ReorderChildren', () => {
  it('permutes the element children', () => {
    const { sect, h, p } = twoKids();
    sect.ReorderChildren([p, h]);
    expect(sect.Children.map((c) => c.Type)).toEqual(['P', 'H1']);
    expect(sect.GetText()).toBe('bbb\nAAA');
  });

  // /K interleaves element kids with content-item kids. A /P carrying its own
  // text beside a /Link child is the everyday inline shape, and its text must
  // not move relative to anything — only the elements permute, in the slots
  // they already occupy.
  it('leaves content-item kids at their original indices', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const para = root.Append('P');
    // INTERLEAVED, and that is load-bearing: the parent's own MCID must sit
    // BETWEEN the two element kids. Appended last it stays at the same index
    // under a build that rebuilds /K as "elements first, content items after",
    // and the case measures nothing — which is exactly what Step 6's mutation
    // checks.
    const a = para.Append('Span');
    para.NextMcid(page);
    const b = para.Append('Span');
    a.SetType('Code');
    b.SetType('Quote');

    /** Index of the sole bare-integer kid in /K. */
    const mcidSlot = (): number => {
      const k = doc.resolve(para.Dict.get('K'));
      return (k as unknown[]).findIndex((x) => typeof doc.resolve(x as never) === 'number');
    };

    const before = mcidSlot();
    expect(before).toBe(1);          // between the two Spans

    para.ReorderChildren([b, a]);

    expect(mcidSlot()).toBe(before);
    expect(para.Children.map((c) => c.Type)).toEqual(['Quote', 'Code']);
  });

  it('refuses an order that is not exactly this element\'s children', () => {
    const { root, sect, h, p } = twoKids();
    const stranger = root.Append('Span');
    expect(() => sect.ReorderChildren([h])).toThrow(RangeError);          // too few
    expect(() => sect.ReorderChildren([h, p, h])).toThrow(RangeError);    // too many
    expect(() => sect.ReorderChildren([h, h])).toThrow(RangeError);       // duplicate
    expect(() => sect.ReorderChildren([h, stranger])).toThrow(RangeError); // not a child
  });

  it('writes nothing when it refuses', () => {
    const { doc, sect, h } = twoKids();
    const before = doc.Save();
    expect(() => sect.ReorderChildren([h])).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
  });

  it('accepts the current order as a no-op', () => {
    const { sect, h, p } = twoKids();
    sect.ReorderChildren([h, p]);
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-move.test.ts`
Expected: FAIL — `sect.ReorderChildren is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/structmove.ts`:

```ts
/** Reorder `element`'s ELEMENT children into `order`.
 *
 *  **Invariant:** the element kids permute among the raw /K positions they
 *  ALREADY occupy; every MCID and OBJR kid stays exactly where it is. That is
 *  what makes the operation meaningful for the inline shape — a /P holding its
 *  own text beside a /Link child keeps its text where it was. Permuting the
 *  whole /K instead would let a caller reorder a parent's own text against its
 *  children, which is a different feature, and would break `Nodes`'
 *  interleaving: that reads content order from the page and would then
 *  disagree with /K.
 *
 *  **Invariant:** `order` must be exactly this element's element children, each
 *  once — validated before anything is written. */
export function reorderChildren(
  doc: Document, element: StructElement, order: readonly StructElement[],
): void {
  const slots = elementSlots(doc, element.Dict);
  const raw = doc.resolve(element.Dict.get('K'));
  const arr: PdfObject[] = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);

  if (order.length !== slots.length)
    throw new RangeError(`order has ${order.length} elements, expected ${slots.length}`);

  const current = slots.map((i) => doc.resolve(arr[i]) as PdfDict);
  const seen = new Set<PdfDict>();
  for (const el of order) {
    if (!current.includes(el.Dict))
      throw new RangeError('order names an element that is not a child of this one');
    if (seen.has(el.Dict)) throw new RangeError('order names the same element twice');
    seen.add(el.Dict);
  }

  // --- nothing above this line has written anything ---

  // Keep the raw entries, not the dicts: a kid may be a ref, and replacing it
  // with its resolved dict would inline an object the tree points at.
  const entries = slots.map((i) => arr[i]);
  const byDict = new Map<PdfDict, PdfObject>();
  slots.forEach((i, n) => byDict.set(current[n], entries[n]));
  order.forEach((el, n) => { arr[slots[n]] = byDict.get(el.Dict)!; });

  // /K may have been a single value; kArray normalized nothing here, so write
  // the array back when the original was not one.
  if (!isArray(raw)) element.Dict.set('K', arr);
  doc.markModified();
}
```

- [ ] **Step 4: Wire it onto `StructElement`**

In `src/struct.ts`, add `reorderChildren` to the `./structmove.js` import and
add the method after `MoveTo`:

```ts
  /** Reorder this element's element children into `order`, which must be
   *  exactly those children, each once.
   *
   *  Content-item kids (MCIDs and OBJRs) keep their positions: only the
   *  elements permute, in the slots they already occupy. Throws `RangeError`
   *  otherwise, writing nothing. */
  ReorderChildren(order: StructElement[]): void {
    reorderChildren(this.doc, this, order);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/struct-move.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Prove the slot rule is load-bearing**

Mutation — replace the permutation with a rebuild that puts the elements first
and the content items after:

```ts
  const kept = arr.filter((_, i) => !slots.includes(i));
  arr.length = 0;
  arr.push(...order.map((el) => byDict.get(el.Dict)!), ...kept);
```

Expected: "leaves content-item kids at their original indices" FAILS and
"permutes the element children" stays GREEN — which is why the mixed-`/K` case
exists. Restore.

- [ ] **Step 7: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 8: Update CHANGELOG.md**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Structure elements can be moved and reordered.**
  `StructElement.MoveTo(parent, index?)` re-parents an element and its subtree
  — `parent` being another element or the tree root, `index` counting element
  children and defaulting to last — and `ReorderChildren(order)` permutes an
  element's children in place. Reading order IS the tree's order, so this is
  what fixes a reading order `AutoTag` got wrong, which its geometric heuristic
  regularly does on a multi-column page with a full-width banner. Neither
  touches the `/ParentTree`: every MCID still resolves to the same element on
  the same page afterwards. Where an element relied on an inherited `/Pg`, the
  move materializes it first, so re-parenting across pages cannot silently
  re-point its marked content. A move into the element's own subtree, into a
  different structure tree, or at an out-of-range index is refused with a
  `RangeError` and writes nothing. Note the tree's order drives `GetText`,
  `StructElement.Nodes` and the `ToHtml('semantic')` / `ToMarkdown` / `ToDocx` /
  `ToEpub` exports; `GetStructuredText` is geometric and is unaffected by
  either (`q7hc.3`).
```

- [ ] **Step 9: Update README.md**

In the **Tagged-PDF structure authoring** bullet, after the `element.Remove()`
clause, add: `` `element.MoveTo(parent, index?)` re-parents an element and its
subtree (materializing an inherited `/Pg` first, so its marked content keeps
its page) and `element.ReorderChildren(order)` permutes an element's children
while leaving its own text where it was ``. Then add a types-table row — the run
holding `StructElement` is alphabetical, so `StructContainer` goes between
`StructElement` and `StructRemoveResult`:

```markdown
| `StructContainer` | Anything that can hold structure elements: an element, or the tree root. |
```

- [ ] **Step 10: Update CLAUDE.md**

Add a `structmove.ts` bullet to the Source list, after `structremove.ts`:

```markdown
- **structmove.ts** — `StructElement.MoveTo` and `.ReorderChildren`: where an
  element sits in the tree, and in what order its children do. Reading order IS
  the tree's order.
  **Invariant:** it does NOT touch the `/ParentTree` — not one entry. A move
  changes `/K` and `/P` and nothing else, which is what keeps every MCID
  resolving, and it is why this is far smaller than `structremove.ts`.
  **Invariant, and it is the safety property the issue's own text got wrong:**
  `/Pg` is MATERIALIZED onto every element in the moved subtree that has a
  BARE-INTEGER content item and no `/Pg` of its own, BEFORE the move.
  `StructElement.Page` walks UP the ancestor chain and `ContentItems` resolves
  a bare integer against that inherited page, so re-parenting such an element
  across pages silently re-points every one of its MCIDs while the
  `/ParentTree` goes on mapping them to the element — the two directions then
  disagree, which is worse than either being wrong alone. It runs
  UNCONDITIONALLY rather than only when the pages differ: deciding that means
  resolving the destination's inherited `/Pg`, the same walk, so the
  conditional buys nothing and adds a branch that is silent when wrong.
  **Note, measured, and it is why the fixture is hand-built:** NOTHING this
  library authors can reach that rule — `appendContentKid` writes `/Pg` onto
  the element the first time content is added, so every element we create
  already owns one. Neutering `materializePg` reddens only
  `build-inherited-pg-pdf.ts`'s two cases and leaves every other move case
  green.
  **Invariant:** `ReorderChildren` permutes the ELEMENT kids among the raw
  `/K` positions they already occupy; every MCID and OBJR kid stays put. That
  is what makes it meaningful for the inline shape — a `/P` holding its own
  text beside a `/Link` child keeps its text where it was — and permuting the
  whole `/K` would also break `Nodes`' interleaving, which reads content order
  from the page and would then disagree with `/K`.
  **Invariant:** a move into the element's own subtree is refused. A cycle
  makes the tree unwalkable, so `GetText`, `Nodes`, `docmodel.ts` and the
  validator would HANG rather than report anything — which is why the mutation
  that removes the check must be run under a test timeout.
  **Note:** `StructContainer`, deliberately NOT `StructParent` —
  `/StructParent` is an unrelated key on an annotation dict and the collision
  would be read as a relationship that does not exist.
  **Note:** nothing is extracted to a leaf here, unlike `numbertree.ts` in
  `q7hc.2`. `structmove.ts` → `structremove.ts` and → `structwrite.ts` are
  one-way edges that close no cycle, and the extraction rule `resprune.ts`
  follows applies only where one would.
```

Run the module-doc sweep from Global Constraints; it must print nothing.

- [ ] **Step 11: Commit**

```bash
git add src/structmove.ts src/struct.ts test/struct-move.test.ts \
        CHANGELOG.md README.md CLAUDE.md
git commit -m "feat(q7hc.3): ReorderChildren, leaving content-item kids in place

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Close out

- [ ] **Step 1: Run the full gates**

```bash
npm run typecheck && npm test
```
Both must be green.

- [ ] **Step 2: Module-doc sweep**

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```
Expected: prints nothing. One new module landed (`structmove.ts`).

- [ ] **Step 3: Confirm the cycle baseline did not move**

```bash
npx vitest run test/import-cycles.test.ts
git diff --stat main -- test/import-cycles.test.ts
```
Expected: PASS with the same 15 pairs, and no diff on that file. Two new edges
landed (`structmove.ts` → `structremove.ts`, → `structwrite.ts`) and both are
one-way.

- [ ] **Step 4: Close the issue**

```bash
bd close q7hc.3
```

- [ ] **Step 5: Hand off**

Report what shipped, the measured mutation results from Tasks 1-3, and that
`q7hc.4` (PDF/UA-2) is the last child — noting it is a validator-and-converter
issue with no object-graph surgery, so `pdfavalidate.ts`'s part-4 backport
(`72nc.1`, `72nc.2`, `pjy7`) is the template rather than anything in this
epic.

---

## Notes for the implementer

**The issue text is wrong in two places and the spec says why.** Its acceptance
criterion names `GetStructuredText`, which is geometric and provably cannot
change — the test asserts that BOTH ways so the correction stays recorded. And
its claim that "the element keeps its content items and its `/Pg`" holds only
when the element HAS a `/Pg`; Task 2 is the case where it does not.

**Nothing this library authors reaches the `/Pg` rule.** Task 1's fixtures all
go through `AddText`, which materializes `/Pg` already. Do not read Task 1's
green as covering `materializePg` — Task 2's hand-built fixture is the only
thing that does.

**Run the cycle-refusal mutation under a timeout.** Removing that check does not
produce a failed assertion; it produces a hang, because `Children` recurses
into a loop. `--testTimeout=10000` turns that into a reportable failure.

**`AddText` takes positional coordinates** — `AddText(text, x, y, opts)`, not an
options object (`test/struct-write.test.ts:121`). Getting this wrong yields an
element with no content and tests that pass vacuously.
