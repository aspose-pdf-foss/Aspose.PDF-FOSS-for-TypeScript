# Removing a structure element (`q7hc.2`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `StructElement.Remove()` — detach an element and its subtree, release
every `/ParentTree` slot it holds, untag the content it marked without deleting
any ink, and make the validator say so.

**Architecture:** A new leaf `numbertree.ts` owns the `/ParentTree` number-tree
walk for both the read and the write side, because `struct.ts` will import the
remover by value. A new `structremove.ts` runs three phases — collect, release,
unwrap — reusing `q7hc.1`'s `marked` event to find each `BDC` and
`EditableContent` to delete it. `structvalidate.ts`'s `UntaggedContent` widens
to treat an MCID that does not resolve as untagged.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-14-struct-element-remove-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only; add no npm runtime dep.
- **ESM + NodeNext.** Every relative import specifier carries the `.js`
  extension (`import { x } from './numbertree.js'`).
- **`npm run typecheck` and `npm test` must both be green before any task is
  considered done.** Target one file with `npx vitest run test/<name>.test.ts`.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`,
  `InvalidPasswordError` from `errors.ts`; `TypeError`/`RangeError` for
  argument rejection.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.2` in parentheses at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  The sweep must print nothing:
  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
  done
  ```
- **Never edit `test/import-cycles.test.ts`'s `KNOWN` list to make a build
  green.** A new pair means the edge you added closed a cycle; fix the edge.
- **Removal must not delete ink.** Only the `BDC` and its matching `EMC` are
  deleted; every operator between them survives.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/numbertree.ts` | **Create.** Leaf: `lookupNumberTree` (moved from `struct.ts`) and `numsArrays`, the write side. |
| `src/structremove.ts` | **Create.** `removeElement` and `StructRemoveResult`: collect, release, unwrap. |
| `src/struct.ts` | **Modify.** Re-export `lookupNumberTree`; add `StructElement.Remove()`. |
| `src/structvalidate.ts` | **Modify.** `UntaggedContent` treats an unresolvable MCID as untagged. |
| `src/index.ts` | **Modify.** Export the `StructRemoveResult` type. |
| `test/numbertree.test.ts` | **Create.** Unit rules over the leaf; no PDF built. |
| `test/struct-element-remove.test.ts` | **Create.** Graph surgery, the unwrap, fail-open. **Note the name:** `test/struct-remove.test.ts` ALREADY EXISTS and is `hob8`'s suite for untagging a removed *annotation*. Do not touch it; it is a useful neighbour to read, since it covers the `untagObjects` direction this feature deliberately does not reuse. |
| `test/helpers/build-dangling-mcid-pdf.ts` | **Create.** A tagged page whose MCID resolves to nothing. |

---

### Task 1: The `numbertree.ts` leaf

Moves the number-tree walk into a leaf and adds the write side. **No behaviour
change** — nothing calls `numsArrays` yet.

**Files:**
- Create: `src/numbertree.ts`
- Modify: `src/struct.ts` (delete `lookupNumberTree`, lines 701-728; re-export)
- Modify: `CLAUDE.md` (Source list)
- Test: `test/numbertree.test.ts`

**Interfaces:**
- Consumes: nothing (a `Document` arrives as a type-only import).
- Produces:
  ```ts
  export function lookupNumberTree(doc: Document, node: PdfDict, key: number): PdfObject | undefined;
  export function numsArrays(doc: Document, node: PdfDict): PdfObject[][];
  ```
  `numsArrays` returns every LIVE flat `/Nums` array in the tree, in document
  order, so a caller can splice a pair or null a slot in place.

- [ ] **Step 1: Write the failing test**

Create `test/numbertree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { lookupNumberTree, numsArrays } from '../src/numbertree.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** A Document is needed only for `resolve`; this one is never saved. */
const doc = (): Document => Document.Open(buildStampTarget());

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('numbertree: lookupNumberTree', () => {
  it('finds a key in a flat /Nums', () => {
    const t = dict([['Nums', [0, 'a', 1, 'b']]]);
    expect(lookupNumberTree(doc(), t, 1)).toBe('b');
  });

  it('returns undefined for a key that is not there', () => {
    expect(lookupNumberTree(doc(), dict([['Nums', [0, 'a']]]), 7)).toBeUndefined();
  });

  it('descends into /Kids by /Limits', () => {
    const kid = dict([['Limits', [10, 20]], ['Nums', [15, 'x']]]);
    const root = dict([['Kids', [kid]]]);
    expect(lookupNumberTree(doc(), root, 15)).toBe('x');
    expect(lookupNumberTree(doc(), root, 5)).toBeUndefined();
  });

  // A number tree that points at itself is a file we did not write; it must
  // terminate rather than hang.
  it('stops on a cycle', () => {
    const root: PdfDict = new Map();
    root.set('Kids', [root]);
    root.set('Limits', [0, 100]);
    expect(lookupNumberTree(doc(), root, 1)).toBeUndefined();
  });
});

describe('numbertree: numsArrays', () => {
  it('returns the flat /Nums array itself, live', () => {
    const nums: PdfObject[] = [0, 'a'];
    const t = dict([['Nums', nums]]);
    const got = numsArrays(doc(), t);
    expect(got).toHaveLength(1);
    // LIVE: mutating what we got must mutate the tree.
    got[0].push(1, 'b');
    expect(nums).toEqual([0, 'a', 1, 'b']);
  });

  it('collects every leaf of a /Kids tree, in document order', () => {
    const k1 = dict([['Limits', [0, 9]], ['Nums', [0, 'a']]]);
    const k2 = dict([['Limits', [10, 19]], ['Nums', [10, 'b']]]);
    const root = dict([['Kids', [k1, k2]]]);
    expect(numsArrays(doc(), root).map((a) => a[1])).toEqual(['a', 'b']);
  });

  it('collects a node that has BOTH /Nums and /Kids', () => {
    const kid = dict([['Nums', [10, 'b']]]);
    const root = dict([['Nums', [0, 'a']], ['Kids', [kid]]]);
    expect(numsArrays(doc(), root).map((a) => a[1])).toEqual(['a', 'b']);
  });

  it('returns nothing for a tree with no /Nums anywhere', () => {
    expect(numsArrays(doc(), dict([['Kids', []]]))).toEqual([]);
  });

  it('stops on a cycle', () => {
    const root: PdfDict = new Map();
    root.set('Nums', [0, 'a']);
    root.set('Kids', [root]);
    expect(numsArrays(doc(), root)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/numbertree.test.ts`
Expected: FAIL — `Failed to load url ../src/numbertree.js`.

- [ ] **Step 3: Create the leaf**

Create `src/numbertree.ts`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';

/** The PDF number tree (7.9.7), read and write.
 *
 *  **Invariant:** a near-LEAF — `Document` arrives as a TYPE only, for
 *  `resolve` — so every rule here is testable from hand-built Maps with no PDF
 *  built. It is a module rather than part of `struct.ts` because
 *  `structremove.ts` needs it and `struct.ts` imports THAT by value, so
 *  reaching back would close a cycle. `nametree.ts` is the NAME-tree sibling,
 *  and the extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
 *  `langmatch.ts` and `structtype.ts` each already made. */

/** Look up `key` in a PDF number tree rooted at `node` (/Nums leaves, /Kids
 *  with /Limits). Returns the RAW value so a caller can resolve it itself. */
export function lookupNumberTree(doc: Document, node: PdfDict, key: number): PdfObject | undefined {
  let cur: PdfDict | undefined = node;
  const seen = new Set<PdfDict>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (doc.resolve(nums[i]) === key) return nums[i + 1];
      }
    }
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return undefined;
    let next: PdfDict | undefined;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (!isDict(kd)) continue;
      const lim = doc.resolve(kd.get('Limits'));
      if (isArray(lim) && lim.length === 2) {
        const lo = doc.resolve(lim[0]); const hi = doc.resolve(lim[1]);
        if (typeof lo === 'number' && typeof hi === 'number' && key >= lo && key <= hi) {
          next = kd; break;
        }
      }
    }
    cur = next;
  }
  return undefined;
}

/** Every LIVE flat /Nums array in the tree, in document order.
 *
 *  The WRITE side: `lookupNumberTree` answers "what is the value for key K",
 *  which is enough to read a slot and not enough to null one or to splice a
 *  pair out. A caller mutates what this returns in place.
 *
 *  **Invariant:** it descends /Kids WITHOUT consulting /Limits, unlike the
 *  lookup. A release has no key to steer by — it is collecting every leaf —
 *  and a tree whose /Limits are wrong would otherwise hide a pair that really
 *  is there, which is precisely the damaged-file case this must survive. */
export function numsArrays(doc: Document, node: PdfDict): PdfObject[][] {
  const out: PdfObject[][] = [];
  const seen = new Set<PdfDict>();
  const walk = (cur: PdfDict): void => {
    if (seen.has(cur)) return;
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) out.push(nums);
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (isDict(kd)) walk(kd);
    }
  };
  walk(node);
  return out;
}
```

- [ ] **Step 4: Point `struct.ts` at the leaf**

In `src/struct.ts`, DELETE the whole `lookupNumberTree` function (its doc
comment and body, lines 701-728) and add beside the other imports:

```ts
import { lookupNumberTree } from './numbertree.js';

// Re-exported so `structpreserve.ts`'s import path stays put. The local import
// above is separate and required: `export … from` creates no local binding,
// and `ElementFor` / `ElementForObject` call it directly.
export { lookupNumberTree } from './numbertree.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/numbertree.test.ts test/import-cycles.test.ts && npm run typecheck`
Expected: PASS, with `import-cycles` reporting exactly the same 15 pairs.

- [ ] **Step 6: Prove the move changed nothing**

Run: `npx vitest run test/structpreserve.test.ts test/struct.test.ts`
Expected: PASS unedited. `structpreserve.ts:3` is the only other importer of
`lookupNumberTree` (swept across `src/`) and it imports it from `struct.js`, so
the re-export is what keeps it working — the fence that the move changed
nothing.

- [ ] **Step 7: Add the CLAUDE.md entry**

In CLAUDE.md's Source list, immediately after the `structtype.ts` bullet, add:

```markdown
- **numbertree.ts** — the PDF number tree (7.9.7), read and write:
  `lookupNumberTree` and `numsArrays`. The NAME-tree sibling is `nametree.ts`.
  **Invariant:** a near-LEAF taking `Document` as a TYPE only, so every rule is
  testable from hand-built `Map`s with no PDF built. It is its own module
  because `structremove.ts` needs it while `struct.ts` imports THAT by value,
  so leaving the walk in `struct.ts` would close a cycle — the forcing argument
  behind `structtype.ts`, `langmatch.ts` and `bordersides.ts`. `struct.ts`
  re-exports `lookupNumberTree`, so `structpreserve.ts`'s import path is
  unchanged.
  **Invariant:** `numsArrays` descends `/Kids` WITHOUT consulting `/Limits`,
  unlike the lookup. A release is collecting every leaf rather than steering by
  a key, and a tree whose `/Limits` are wrong would otherwise hide a pair that
  really is there — the damaged-file case it exists to survive.
```

Run the module-doc sweep from Global Constraints; it must print nothing.

- [ ] **Step 8: Commit**

```bash
git add src/numbertree.ts src/struct.ts test/numbertree.test.ts CLAUDE.md
git commit -m "refactor(q7hc.2): extract numbertree.ts, and add the write side

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

No CHANGELOG entry: internal refactor, no user-visible change.

---

### Task 2: `Remove()` — the object graph

Detach, release the `/ParentTree`, unwire `OBJR` annotations. **The content
unwrap is Task 3**, so after this task the marked content is orphaned but still
carries its `BDC`.

**Files:**
- Create: `src/structremove.ts`
- Modify: `src/struct.ts` (`StructElement.Remove()`, beside `SetType`)
- Modify: `src/index.ts:75`
- Test: `test/struct-element-remove.test.ts`

**Interfaces:**
- Consumes: `numsArrays`, `lookupNumberTree` (Task 1).
- Produces:
  ```ts
  // structremove.ts
  export interface StructRemoveResult {
    elements: number; mcids: number; annotations: number; unreachable: number;
  }
  export function removeElement(doc: Document, element: StructElement): StructRemoveResult;
  // struct.ts, on StructElement
  Remove(): StructRemoveResult;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/struct-element-remove.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isArray } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';

describe('StructElement.Remove: the object graph', () => {
  it('detaches from the root /K and reports one element', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    expect(root.Children).toHaveLength(1);

    const r = el.Remove();
    expect(r.elements).toBe(1);
    expect(doc.GetStructTree()!.Children).toHaveLength(0);
  });

  it('detaches from a parent element /K', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    const p = sect.Append('P');
    sect.Append('P');
    expect(sect.Children).toHaveLength(2);

    p.Remove();
    expect(sect.Children).toHaveLength(1);
  });

  it('removes the whole subtree and counts every element', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    const p = sect.Append('P');
    p.Append('Span');
    p.Append('Span');

    expect(sect.Remove().elements).toBe(4);   // Sect + P + 2 Spans
    expect(doc.GetStructTree()!.Children).toHaveLength(0);
  });

  it('releases the /ParentTree slot so ElementFor stops resolving', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    const mcid = el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(mcid).toBe(0);
    expect(root.ElementFor(0, mcid)).toBeDefined();

    expect(el.Remove().mcids).toBe(1);
    expect(doc.GetStructTree()!.ElementFor(0, mcid)).toBeUndefined();
  });

  it('survives a save and reopen', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Remove();

    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children).toHaveLength(0);
    expect(re.GetStructTree()!.ElementFor(0, 0)).toBeUndefined();
  });

  // Removing the same element twice must be a no-op, not a throw: after the
  // first call it is in no /K and there is nothing left to find.
  it('is idempotent', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(el.Remove().elements).toBe(1);
    expect(el.Remove()).toEqual({ elements: 0, mcids: 0, annotations: 0, unreachable: 0 });
  });
});

describe('StructElement.Remove: annotations survive', () => {
  it('unwires an OBJR but keeps the annotation in /Annots', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const link = root.Append('Link');
    const annot = page.AddLink({
      rect: [72, 700, 200, 720],
      action: { type: 'uri', uri: 'https://example.com' },
    });
    link.AddAnnotation(annot);
    expect(annot.Dict.has('StructParent')).toBe(true);

    const r = link.Remove();
    expect(r.annotations).toBe(1);

    // The annotation itself is untouched apart from losing its /StructParent.
    expect(annot.Dict.has('StructParent')).toBe(false);
    const annots = doc.resolve(page.Dict.get('Annots'));
    expect(isArray(annots) && annots.some((a) => doc.resolve(a) === annot.Dict)).toBe(true);
  });
});
```

`AddLink({ rect, action })` and `buildAnnotTarget` are exactly what
`test/struct-write.test.ts:206-212` already uses for annotation tagging — read
that case if anything here is unclear.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-element-remove.test.ts`
Expected: FAIL — `el.Remove is not a function`.

- [ ] **Step 3: Create `structremove.ts`**

Create `src/structremove.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';
import { numsArrays } from './numbertree.js';

/** What a removal released.
 *
 *  `unreachable` counts marked-content items whose `BDC` the content walk
 *  cannot address — an item whose /Pg does not resolve, and a BDC inside a
 *  tiling pattern, a Type 3 /CharProcs or an annotation appearance, none of
 *  which `ContentAddr`'s XObject-name chain can name (the `85l8.6` limit). */
export interface StructRemoveResult {
  /** Elements detached, including descendants. */
  elements: number;
  /** /ParentTree marked-content slots released. */
  mcids: number;
  /** OBJR annotations unwired. */
  annotations: number;
  /** Marked-content sequences whose BDC could not be reached. */
  unreachable: number;
}

const asNum = (o: PdfObject | undefined): number | undefined =>
  (typeof o === 'number' ? o : undefined);

/** The element and every descendant, cycle-guarded. */
function subtree(el: StructElement, out: StructElement[], seen: Set<PdfDict>): void {
  if (seen.has(el.Dict)) return;
  seen.add(el.Dict);
  out.push(el);
  for (const c of el.Children) subtree(c, out, seen);
}

/** Null the slot at `mcid` in the array the page key maps to. True when a live
 *  entry was actually released.
 *
 *  **Invariant:** the slot is NULLED, never spliced, and the page's key/value
 *  pair is never removed. MCIDs are INDICES, so shortening the array renumbers
 *  every later one; and that pair's value is the array shared by EVERY element
 *  on the page, so removing it orphans all of them. That is exactly what
 *  `untagObjects`'s `clearParentTreeKeys` would have done, which is why it is
 *  a precedent here rather than a function to call. */
function releaseMcid(doc: Document, pt: PdfDict, pageKey: number, mcid: number): boolean {
  for (const nums of numsArrays(doc, pt)) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (asNum(doc.resolve(nums[i])) !== pageKey) continue;
      const arr = doc.resolve(nums[i + 1]);
      if (!isArray(arr) || mcid < 0 || mcid >= arr.length) return false;
      if (arr[mcid] === null) return false;   // already released
      arr[mcid] = null;
      return true;
    }
  }
  return false;
}

/** Splice an object key's whole key/value pair out. True when one went.
 *
 *  **Invariant:** an annotation's /StructParent names ONE entry, so the pair
 *  goes whole — the opposite of the MCID case above, and the distinction the
 *  spec's second correction turns on. */
function releaseObjectKey(doc: Document, pt: PdfDict, key: number): boolean {
  for (const nums of numsArrays(doc, pt)) {
    for (let i = nums.length - 2; i >= 0; i -= 2) {
      if (asNum(doc.resolve(nums[i])) === key) { nums.splice(i, 2); return true; }
    }
  }
  return false;
}

/** Detach `dict` from `parent`'s /K. True when it was there. */
function detachKid(doc: Document, parent: PdfDict, dict: PdfDict): boolean {
  const raw = doc.resolve(parent.get('K'));
  if (isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      if (doc.resolve(raw[i]) === dict) { raw.splice(i, 1); return true; }
    }
    return false;
  }
  if (raw !== undefined && doc.resolve(raw) === dict) { parent.delete('K'); return true; }
  return false;
}

/** Remove `element` and its subtree from the structure tree, releasing every
 *  /ParentTree slot it holds and unwiring its OBJR annotations.
 *
 *  The element dicts are NOT deleted from the document: `Save`'s mark-sweep
 *  drops them once unreachable, which is this library's model everywhere else.
 *
 *  **Invariant:** an OBJR's annotation SURVIVES, losing only its
 *  /StructParent. `untagObjects` never clears that key because its objects are
 *  dying; here they are not, and a /StructParent naming a released entry
 *  dangles. */
export function removeElement(doc: Document, element: StructElement): StructRemoveResult {
  const out: StructRemoveResult = { elements: 0, mcids: 0, annotations: 0, unreachable: 0 };

  // Detach FIRST, and bail when it was not attached: that is what makes a
  // second Remove() a no-op rather than a second release.
  const parentRaw = element.Dict.get('P');
  const parentDict = doc.resolve(parentRaw);
  const container = isDict(parentDict) ? parentDict : element.Root.Dict;
  if (!detachKid(doc, container, element.Dict)) return out;

  const els: StructElement[] = [];
  subtree(element, els, new Set());
  out.elements = els.length;

  const pt = doc.resolve(element.Root.Dict.get('ParentTree'));
  if (!isDict(pt)) { doc.markModified(); return out; }

  for (const el of els) {
    for (const item of el.ContentItems) {
      if (item.kind === 'objr') {
        const annot = doc.resolve(item.ref);
        if (!isDict(annot)) continue;
        const key = asNum(doc.resolve(annot.get('StructParent')));
        if (key === undefined) continue;
        if (releaseObjectKey(doc, pt, key)) out.annotations++;
        annot.delete('StructParent');
        continue;
      }
      const pageKey = item.page === undefined
        ? undefined
        : asNum(doc.resolve(item.page.Dict.get('StructParents')));
      if (pageKey === undefined) { out.unreachable++; continue; }
      if (releaseMcid(doc, pt, pageKey, item.mcid)) out.mcids++;
    }
  }

  doc.markModified();
  return out;
}
```

- [ ] **Step 4: Add `Remove()` to `StructElement`**

In `src/struct.ts`, add `removeElement` and `type StructRemoveResult` to the
imports, re-export the type beside `StructRetagResult`:

```ts
export type { StructRemoveResult } from './structremove.js';
```

and add immediately after `SetType`/`set Type`:

```ts
  /** Remove this element and its subtree from the structure tree, releasing
   *  every /ParentTree slot its content items and /OBJR kids hold.
   *
   *  **It does not delete ink.** The marked content stays in the page and
   *  becomes untagged, which `ValidatePdfUa` then reports as
   *  `UntaggedContent` — a true statement the caller can act on, where
   *  deleting the content would be a silent edit to the page.
   *
   *  Removing an element that is already detached is a no-op returning zeroes. */
  Remove(): StructRemoveResult {
    return removeElement(this.doc, this);
  }
```

Import line:

```ts
import { removeElement, type StructRemoveResult } from './structremove.js';
```

- [ ] **Step 5: Export the type**

In `src/index.ts`, change line 75 to:

```ts
export type { ContentItem, StructRetagResult, StructRemoveResult } from './struct.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/struct-element-remove.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove the two release rules are load-bearing, separately**

Mutation A — make `releaseMcid` splice the page's pair instead of nulling the
slot (the `untagObjects` mistake):

```ts
      const arr = doc.resolve(nums[i + 1]);
      if (!isArray(arr)) return false;
      nums.splice(i, 2);          // MUTATION A
      return true;
```

Run `npx vitest run test/struct-element-remove.test.ts`. Expected: the ElementFor case
still passes — **which is the point**: with one element on the page, splicing
and nulling are indistinguishable. Record that, restore, and note it: a
discriminating fixture needs TWO elements on one page and arrives in Task 3.

Mutation B — drop `annot.delete('StructParent')`. Expected: the annotation case
FAILS. Restore.

Mutation C — replace the whole `container` expression with `element.Root.Dict`
unconditionally. Expected: "detaches from a parent element /K" FAILS, because a
nested element's container is its parent, not the root.

**Note what is NOT covered, and do not claim it is.** The `isDict(parentDict)`
fallback to `element.Root.Dict` is reached by nothing: `createElement` writes
`/P` as the parent's ref, and for a top-level element that ref IS the struct
root — a dict — so the ternary takes its first branch for every element this
library authors. The fallback is defence for a third-party `/P` that does not
resolve. Deleting it reddens nothing; say so rather than reporting it as
measured.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: green. Nothing calls `Remove()` yet outside the new test.

- [ ] **Step 9: Commit**

```bash
git add src/structremove.ts src/struct.ts src/index.ts test/struct-element-remove.test.ts
git commit -m "feat(q7hc.2): StructElement.Remove — detach and release the /ParentTree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

No CHANGELOG entry yet — the feature is user-visible only once Task 3 makes it
untag the content. Task 3 carries the entry.

---

### Task 3: Untag the content — delete the `BDC` and its `EMC`

**Files:**
- Modify: `src/structremove.ts` (the unwrap phase)
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`
- Test: `test/struct-element-remove.test.ts`

**Interfaces:**
- Consumes: `ContentVisitor.marked` + `MarkedContentEvent` (`q7hc.1`),
  `EditableContent` (existing), `removeElement` (Task 2).
- Produces: no new exported names; `StructRemoveResult.unreachable` becomes
  real.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-element-remove.test.ts` (add these imports at the TOP of the
file with the others):

```ts
import { EditableContent } from '../src/editcontent.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

/** The operator sequence of page 0's first content stream. */
function ops(doc: Document): string[] {
  return [...new EditableContent(doc, doc.Pages[0]).topOps(0)].map((o) => o.operator);
}

/** The decoded text of page 0's content streams. */
function pageText(doc: Document): string {
  const c = doc.resolve(doc.Pages[0].Dict.get('Contents'));
  const entries = isStream(c) ? [c] : (Array.isArray(c) ? c.map((e) => doc.resolve(e)) : []);
  return entries.filter(isStream)
    .map((s) => new TextDecoder().decode(inflateStream(s))).join('\n');
}
```

then the cases:

```ts
describe('StructElement.Remove: untagging the content', () => {
  // The acceptance criterion "the page renders identically". A RENDER
  // comparison cannot check it — dropping the ink between BDC and EMC still
  // renders something. The op list is what can.
  it('deletes exactly the BDC and EMC, keeping every op between them', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const before = ops(doc);
    expect(before).toContain('BDC');
    expect(before).toContain('EMC');

    el.Remove();

    const after = ops(doc);
    const expected = before.filter((o, i) =>
      !(o === 'BDC' && before.indexOf('BDC') === i) && o !== 'EMC');
    expect(after).toEqual(expected);
    expect(after).not.toContain('BDC');
    expect(after).not.toContain('EMC');
    // Ink survives.
    expect(pageText(doc)).toContain('Tj');
  });

  it('leaves no MCID behind, so the content is genuinely untagged', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Remove();
    expect(pageText(doc)).not.toContain('MCID');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-element-remove.test.ts`
Expected: FAIL — both new cases; `Remove()` releases the tree but leaves the
`BDC` in the stream.

- [ ] **Step 3: Implement the unwrap**

In `src/structremove.ts`, add to the imports:

```ts
import { EditableContent, type ContentAddr } from './editcontent.js';
import { visitContent } from './text.js';
import type { ContentOp } from './content.js';
```

Add this function above `removeElement`:

```ts
/** Index of the `EMC` matching the `BDC` at `from`, or -1.
 *
 *  **Invariant:** it counts NESTING. A child element's marked content is
 *  commonly nested inside its parent's — a `/Link` mid-paragraph is the
 *  everyday case — so the first `EMC` after a `BDC` is frequently the CHILD's.
 *  Take that one and the parent's sequence is left unterminated, which is a
 *  content stream no reader can make sense of. */
function matchingEmc(ops: readonly ContentOp[], from: number): number {
  let depth = 0;
  for (let i = from; i < ops.length; i++) {
    const op = ops[i].operator;
    if (op === 'BDC' || op === 'BMC') depth++;
    else if (op === 'EMC') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Delete the BDC/EMC pair of every `(page, mcid)` in `want`, keeping every op
 *  between them. Returns how many sequences could not be reached. */
function unwrapContent(doc: Document, byPage: Map<Page, Set<number>>): number {
  let unreachable = 0;
  for (const [page, want] of byPage) {
    const hits: { addr: ContentAddr; mcid: number }[] = [];
    // No ContentWalkOptions: skipHidden keeps its `false` default, so content
    // the current optional-content configuration hides is untagged too. An
    // EDIT consumer must see what the file contains (q1g2.3).
    visitContent(doc, page, {
      marked(e) { if (want.has(e.mcid)) hits.push({ addr: e.addr, mcid: e.mcid }); },
    });
    const found = new Set(hits.map((h) => h.mcid));
    for (const m of want) if (!found.has(m)) unreachable++;
    if (hits.length === 0) continue;

    const ec = new EditableContent(doc, page);
    const scopes = new Map<string, { addr: ContentAddr; starts: Set<number> }>();
    for (const h of hits) {
      const key = `${h.addr.path.join('\0')}${h.addr.streamIndex}`;
      const hit = scopes.get(key);
      if (hit) hit.starts.add(h.addr.opIndex);
      else scopes.set(key, { addr: h.addr, starts: new Set([h.addr.opIndex]) });
    }

    for (const { addr, starts } of scopes.values()) {
      const top = addr.path.length === 0;
      const list = [...(top ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path))];
      // Pair each BDC with its EMC BEFORE deleting anything, then delete every
      // index DESCENDING.
      //
      // **Invariant, and it is the INVERSE of q7hc.1's:** `retagContentItems`
      // may collect addresses up front because a REPLACE moves nothing. A
      // DELETE shifts every later index, so both the pairing and the order
      // matter. Ascending deletion takes the wrong ops for the second sequence
      // in a stream — and still yields a parseable content stream, so only an
      // op-level assertion can see it.
      const doomed: number[] = [];
      for (const s of starts) {
        if (list[s]?.operator !== 'BDC') { unreachable++; continue; }
        const e = matchingEmc(list, s);
        if (e < 0) { unreachable++; continue; }
        doomed.push(s, e);
      }
      if (doomed.length === 0) continue;
      doomed.sort((a, b) => b - a);
      for (const i of doomed) list.splice(i, 1);
      if (top) ec.setTopOps(addr.streamIndex, list);
      else ec.setXobjectOps(addr.path, list);
    }
    ec.commit();
  }
  return unreachable;
}
```

Then, in `removeElement`, collect the MCIDs per page while releasing and unwrap
at the end. Replace the content-item loop and the tail with:

```ts
  const byPage = new Map<Page, Set<number>>();
  for (const el of els) {
    for (const item of el.ContentItems) {
      if (item.kind === 'objr') {
        const annot = doc.resolve(item.ref);
        if (!isDict(annot)) continue;
        const key = asNum(doc.resolve(annot.get('StructParent')));
        if (key === undefined) continue;
        if (releaseObjectKey(doc, pt, key)) out.annotations++;
        annot.delete('StructParent');
        continue;
      }
      if (item.page === undefined) { out.unreachable++; continue; }
      const pageKey = asNum(doc.resolve(item.page.Dict.get('StructParents')));
      if (pageKey === undefined) { out.unreachable++; continue; }
      if (releaseMcid(doc, pt, pageKey, item.mcid)) out.mcids++;
      let s = byPage.get(item.page);
      if (!s) { s = new Set<number>(); byPage.set(item.page, s); }
      s.add(item.mcid);
    }
  }

  out.unreachable += unwrapContent(doc, byPage);
  doc.markModified();
  return out;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/struct-element-remove.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Write the discriminating cases Task 2 could not**

Append to `test/struct-element-remove.test.ts`:

```ts
describe('StructElement.Remove: cases a one-element page cannot see', () => {
  /** A page with TWO marked sequences in ONE content stream, each under its
   *  own element. Built with two AddText calls so each gets its own region. */
  function twoSequences() {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const a = root.Append('P');
    const b = root.Append('P');
    page.AddText('alpha', { x: 50, y: 700, size: 12 });
    page.AddText('bravo', { x: 50, y: 600, size: 12 });
    const ma = a.MarkContent(page, [40, 690, 300, 720]);
    const mb = b.MarkContent(page, [40, 590, 300, 620]);
    return { doc, page, root, a, b, ma, mb };
  }

  // Task 2's release could not tell nulling a slot from splicing the page's
  // whole pair, because one element on a page makes them identical. With two,
  // splicing the pair takes the SURVIVOR's mapping with it.
  it('releases one slot without disturbing the other element on the page', () => {
    const { doc, root, a, ma, mb } = twoSequences();
    expect(ma).toBeGreaterThanOrEqual(0);
    expect(mb).toBeGreaterThanOrEqual(0);
    expect(mb).not.toBe(ma);

    a.Remove();

    const re = doc.GetStructTree()!;
    expect(re.ElementFor(0, ma)).toBeUndefined();
    expect(re.ElementFor(0, mb)).toBeDefined();     // the survivor still resolves
    expect(root.Children).toHaveLength(1);
  });

  // Ascending deletion shifts the second pair's indices and takes the wrong
  // ops. The surviving sequence must still be balanced and still carry its own
  // MCID.
  it('deletes the right pair when two sequences share a stream', () => {
    const { doc, a, mb } = twoSequences();
    a.Remove();

    const seq = ops(doc);
    expect(seq.filter((o) => o === 'BDC')).toHaveLength(1);
    expect(seq.filter((o) => o === 'EMC')).toHaveLength(1);
    expect(seq.indexOf('BDC')).toBeLessThan(seq.indexOf('EMC'));
    expect(pageText(doc)).toContain(`/MCID ${mb}`);
  });

  // A child's BDC nests INSIDE its parent's, so the first EMC after the
  // parent's BDC is the CHILD's. Taking it leaves the parent unterminated.
  it('pairs a nested sequence with its own EMC', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const parent = root.Append('P');
    const child = parent.Append('Span');
    const mp = parent.NextMcid(page);
    const mc = child.NextMcid(page);
    page.Graphics()
      .BeginMarkedContent('P', mp)
      .setFillColor([0, 0, 0]).rect(10, 10, 20, 20).fill()
      .BeginMarkedContent('Span', mc)
      .setFillColor([1, 0, 0]).rect(40, 10, 20, 20).fill()
      .EndMarkedContent()
      .EndMarkedContent()
      .apply();

    expect(parent.Remove().elements).toBe(2);

    const seq = ops(doc);
    expect(seq).not.toContain('BDC');
    expect(seq).not.toContain('EMC');
    // Both fills survive: no ink was deleted.
    expect(seq.filter((o) => o === 'f')).toHaveLength(2);
  });
});
```

`BeginMarkedContent(tag, mcid)` and `EndMarkedContent()` are `PageGraphics`'
existing marked-content primitives (`src/graphics.ts:333,346`); `apply()`
splices the buffered ops into the page.

- [ ] **Step 6: Run them**

Run: `npx vitest run test/struct-element-remove.test.ts`
Expected: PASS. If `MarkContent` returns -1 for either region in
`twoSequences`, the region did not cover top-level content — widen the rects
until both return >= 0; the assertions already guard that.

- [ ] **Step 7: Prove the three rules of this task, separately**

Mutation A — delete ASCENDING (`doomed.sort((a, b) => a - b)`). Expected: "
deletes the right pair when two sequences share a stream" FAILS; the
single-sequence cases stay green.

Mutation B — take the first `EMC` (`matchingEmc` returns the first index whose
operator is `EMC`, ignoring depth). Expected: the nested case FAILS.

Mutation C — re-run Task 2's Mutation A (splice the page's pair in
`releaseMcid`). Expected: NOW "releases one slot without disturbing the other
element" FAILS, where in Task 2 it could not.

Restore after each and record the counts in the commit message.

- [ ] **Step 8: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 9: Update CHANGELOG.md and README.md**

In `CHANGELOG.md` under `## [Unreleased]` → `### Added`:

```markdown
- **A structure element can be removed.** `StructElement.Remove()` detaches an
  element and its subtree, releases every `/ParentTree` slot its content items
  and `/OBJR` kids hold, and returns
  `{ elements, mcids, annotations, unreachable }`. **It does not delete ink:**
  the `BDC`/`EMC` pair around the content is removed while every operator
  between them survives, so the marked content stays on the page and becomes
  untagged — which `ValidatePdfUa` now reports as `UntaggedContent`, a true
  statement the caller can act on, where deleting the content would be a silent
  edit to the page. An annotation keeps its `/Annots` entry and loses only its
  `/StructParent`. Removing an already-detached element is a no-op returning
  zeroes (`q7hc.2`).
```

In `README.md`, extend the **Tagged-PDF structure authoring** bullet after the
`SetType` clause with: `` `element.Remove()` detaches an element and its
subtree, releasing its `/ParentTree` slots and untagging the content it marked
without deleting any of it ``. Add a types-table row between
`StructRetagResult` and `StructTreeRoot`:

```markdown
| `StructRemoveResult` | What removing a structure element released: elements, marked-content slots, annotations, and what could not be reached. |
```

- [ ] **Step 10: Document the invariants in CLAUDE.md**

Add a `structremove.ts` bullet to the Source list, after `structtype.ts`:

```markdown
- **structremove.ts** — `StructElement.Remove()`: detach an element and its
  subtree, release every `/ParentTree` slot it holds, and untag the content it
  marked. Three phases — collect, release, unwrap.
  **Invariant:** it DOES NOT DELETE INK. Only the `BDC` and its matching `EMC`
  go; every operator between them survives, so the content stays on the page
  and becomes untagged. A test for this must assert the OP LIST, not a render:
  dropping the ink between the two still renders something.
  **Invariant:** the two `/ParentTree` releases are DIFFERENT operations and
  must not be conflated. A content item's slot is NULLED at its MCID index,
  because MCIDs are indices and that key's value is the array shared by EVERY
  element on the page — splicing the pair orphans all of them, which is
  precisely what `untagObjects`'s `clearParentTreeKeys` does and why it is a
  precedent here rather than a function to call. An `/OBJR` annotation's own
  key names ONE entry, so its pair goes whole.
  **Invariant:** an `/OBJR`'s annotation SURVIVES and loses only its
  `/StructParent`. `untagObjects` never clears that key because its objects are
  dying; here they are not, and a `/StructParent` naming a released entry
  dangles.
  **Invariant, and it is the INVERSE of `q7hc.1`'s:** `retagContentItems` may
  collect every address before editing because a REPLACE moves nothing. A
  DELETE shifts every later index, so each `BDC` is paired with its `EMC`
  first and the indices are then deleted DESCENDING. Ascending takes the wrong
  ops for the second sequence in a stream and still yields a parseable stream,
  so only an op-level assertion sees it.
  **Invariant:** `matchingEmc` counts NESTING. A child's marked content is
  commonly nested inside its parent's, so the first `EMC` after a `BDC` is
  frequently the child's; taking it leaves the parent's sequence unterminated.
  **Note, measured:** with ONE element on a page, nulling the slot and splicing
  the page's whole pair are INDISTINGUISHABLE — the `untagObjects` mistake
  passes every single-element fixture. `test/struct-element-remove.test.ts`'s
  two-sequences-on-one-page case is the only thing that separates them.
```

- [ ] **Step 11: Commit**

```bash
git add src/structremove.ts test/struct-element-remove.test.ts CHANGELOG.md README.md CLAUDE.md
git commit -m "feat(q7hc.2): untag the content a removed element marked

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Make the validator see an orphaned MCID

**Files:**
- Modify: `src/structvalidate.ts:121-135`
- Create: `test/helpers/build-dangling-mcid-pdf.ts`
- Modify: `CHANGELOG.md`, `CLAUDE.md`
- Test: `test/struct-element-remove.test.ts`

**Interfaces:**
- Consumes: `StructTreeRoot.ElementFor` (existing). Produces nothing exported.

- [ ] **Step 1: Write the fixture**

Create `test/helpers/build-dangling-mcid-pdf.ts`:

```ts
// A tagged page whose marked content names an MCID the /ParentTree does not
// map to any element.
//
// Hand-built because NOTHING this library authors can produce one: every MCID
// we write is wired to an element by allocContentMcid, and `Remove` deletes the
// BDC along with the mapping. So the widened UntaggedContent rule — which
// reports content whose MCID does not resolve — is reached by no fixture built
// the ordinary way, and is otherwise untested.

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

/** `dangling: true` nulls the /ParentTree slot the page's MCID 0 names, leaving
 *  a `BDC` that points at nothing. `false` builds the same page wired
 *  correctly, which is the control: the rule must stay silent for it. */
export function buildDanglingMcidPdf(dangling = true): Uint8Array {
  const content = '/P << /MCID 0 >> BDC 0 0 0 rg 10 10 20 20 re f EMC';
  const slot = dangling ? 'null' : '7 0 R';
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R '
    + '/MarkInfo << /Marked true >> /Lang (en-US) >>';
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 '
    + '/Resources << >> /Contents 4 0 R >>';
  objects[4] = streamObj(content);
  objects[5] = `<< /Nums [0 [${slot}]] >>`;
  objects[6] = '<< /Type /StructTreeRoot /K [7 0 R] /ParentTree 5 0 R /ParentTreeNextKey 1 >>';
  objects[7] = '<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>';
  return assemble(objects, 7, 1);
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/struct-element-remove.test.ts` (import the builder at the top):

```ts
import { buildDanglingMcidPdf } from './helpers/build-dangling-mcid-pdf.js';

const untagged = (doc: Document): boolean =>
  doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

describe('UntaggedContent sees an MCID that resolves to nothing', () => {
  // MEASURED: the rule tested `e.mcid === undefined`, so content whose BDC is
  // still in the stream read as tagged however broken the mapping. Widening it
  // reddens NOTHING in the pre-existing suite, because every MCID this library
  // authors resolves — which is exactly why this hand-built fixture exists.
  it('reports a dangling MCID', () => {
    expect(untagged(Document.Open(buildDanglingMcidPdf(true)))).toBe(true);
  });

  // The control. Without it the case above passes for a build that reports
  // every tagged page.
  it('stays silent when the same page is wired correctly', () => {
    expect(untagged(Document.Open(buildDanglingMcidPdf(false)))).toBe(false);
  });

  it('reports the page a removed element left behind', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(untagged(doc)).toBe(false);
    el.Remove();
    expect(untagged(doc)).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify the first case fails**

Run: `npx vitest run test/struct-element-remove.test.ts`
Expected: "reports a dangling MCID" FAILS. The other two already pass —
the control trivially, and the third because Task 3 removed the `BDC`
altogether so its content has no MCID at all.

- [ ] **Step 4: Widen the rule**

In `src/structvalidate.ts`, replace the `UntaggedContent` block (lines 121-135)
with:

```ts
  // UntaggedContent — page content that is neither tagged nor artifacted.
  //
  // **Invariant (`q7hc.2`):** "tagged" means the MCID RESOLVES to an element
  // through the /ParentTree, not merely that the content carries one. A `BDC`
  // whose slot was released — or a third-party file whose mapping was never
  // written — is content in no structure tree, and the older `mcid === undefined`
  // test called it tagged and said nothing.
  //
  // **Note, measured:** widening this reddened NOTHING across the suite, because
  // every MCID this library authors resolves. It is held by
  // `build-dangling-mcid-pdf.ts` alone.
  for (const page of doc.Pages) {
    const spRaw = doc.resolve(page.Dict.get('StructParents'));
    const sp = typeof spRaw === 'number' ? spRaw : undefined;
    // Memoized per page: ElementFor walks a number tree, and asking it per
    // glyph would make validation quadratic in a page's marked content.
    const memo = new Map<number, boolean>();
    const tagged = (mcid: number | undefined): boolean => {
      if (mcid === undefined || sp === undefined) return false;
      let hit = memo.get(mcid);
      if (hit === undefined) { hit = tree.ElementFor(sp, mcid) !== undefined; memo.set(mcid, hit); }
      return hit;
    };
    let untagged = false;
    visitContent(doc, page, {
      glyph: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
      image: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
      path: (e) => { if (!tagged(e.mcid) && !e.artifact) untagged = true; },
    });
    if (untagged) {
      issues.push({
        rule: 'UntaggedContent', severity: 'warning', clause: 'Matterhorn 01-006', page,
        message: 'Page has visible content (text, image or vector) that is neither tagged nor marked as an artifact.',
      });
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/struct-element-remove.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the whole suite — this is the blast-radius check**

Run: `npm test`
Expected: green, with the same file count as before plus the new files. This
widening was measured to move nothing before the plan was written; if a test
now reddens, **do not weaken the rule** — report which document has an MCID
that does not resolve, because that is a real finding about our own output.

- [ ] **Step 7: Prove the widening and the memo**

Mutation A — revert the predicate to `e.mcid === undefined`. Expected: "reports
a dangling MCID" FAILS and nothing else does. Restore.

Mutation B — invert the `sp === undefined` guard so a page with no
`/StructParents` counts every MCID as tagged. Run the whole suite. Expected:
NOTHING reddens — every tagged page this library authors has a
`/StructParents`, and the dangling fixture declares one. Record it as
uncovered; the guard is correct either way, since a page with no key maps
nothing.

- [ ] **Step 8: Update CHANGELOG.md**

Under `## [Unreleased]` → `### Fixed`:

```markdown
- **`ValidatePdfUa` called content tagged when its `/MCID` resolved to
  nothing.** `UntaggedContent` tested only whether a marked-content sequence
  carried an `/MCID`, so a `BDC` naming a `/ParentTree` slot that holds no
  element — a slot released by `StructElement.Remove`, or a mapping a third-party
  producer never wrote — read as perfectly tagged and no rule fired. It now
  requires the `/MCID` to resolve to a structure element, which is what "tagged"
  means. Measured: this moved no existing test, because every `/MCID` this
  library authors resolves; it is a fix for documents we did not write
  (`q7hc.2`).
```

- [ ] **Step 9: Document it in CLAUDE.md**

In the `structvalidate.ts` bullet, add:

```markdown
  **Invariant (`q7hc.2`):** `UntaggedContent` means the `/MCID` RESOLVES to an
  element, not merely that the content carries one — a `BDC` naming a released
  or never-written `/ParentTree` slot is content in no structure tree. The
  lookup is memoized per page, since `ElementFor` walks a number tree and
  asking per glyph would make validation quadratic in a page's marked content.
  **Note, measured, and it is why the fixture is hand-built:** widening this
  reddened NOTHING across the whole suite — every `/MCID` this library authors
  resolves, and so does every one in the vendored corpora — so
  `test/helpers/build-dangling-mcid-pdf.ts` is the only thing that covers it.
  It builds the same page BOTH ways, because the dangling case alone passes for
  a build that reports every tagged page.
```

- [ ] **Step 10: Commit**

```bash
git add src/structvalidate.ts test/helpers/build-dangling-mcid-pdf.ts \
        test/struct-element-remove.test.ts CHANGELOG.md CLAUDE.md
git commit -m "fix(q7hc.2): UntaggedContent now requires the MCID to resolve

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Close out

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
Expected: prints nothing. Two new modules landed (`numbertree.ts`,
`structremove.ts`), so this is the check that both were documented.

- [ ] **Step 3: Confirm the cycle baseline did not move**

```bash
npx vitest run test/import-cycles.test.ts
git diff --stat main -- test/import-cycles.test.ts
```
Expected: PASS with the same 15 pairs, and no diff on that file.

- [ ] **Step 4: Close the issue**

```bash
bd close q7hc.2
```

- [ ] **Step 5: Hand off**

Report what shipped, the measured mutation results from Tasks 1-4, and that
`q7hc.3` (move and reorder) is next — noting that `detachKid` is the half it
already needs, and that its `/ParentTree` work is strictly smaller, since a move
keeps every content item and only changes the parent.

---

## Notes for the implementer

**The issue text is wrong in three places and the spec says why.** It asks you
to reuse `untagObjects`; doing so would splice out a page's whole MCID array
and orphan every other element on that page. It asserts the validator will
report untagged content; it does not, until Task 4. Read the spec's
corrections before writing code.

**Assert op lists, not renders.** "The page renders identically" cannot be
checked by rendering — dropping the ink between `BDC` and `EMC` still renders
something. Every unwrap assertion is on the operator sequence.

**One element on a page hides the release bug.** Nulling a slot and splicing the
page's pair are indistinguishable until two elements share a page. Task 2 says
so explicitly and Task 3 adds the fixture that separates them — do not read
Task 2's green as covering the rule.

**Do not make `import-cycles.test.ts` green by editing it.** Two new modules
land here, and both exist specifically to avoid a cycle.

**`test/struct-remove.test.ts` is somebody else's file.** It is `hob8`'s suite
for untagging a removed *annotation*. This feature's tests go in
`test/struct-element-remove.test.ts`.

**One thing ships untested, deliberately.** The spec's note that "the two
halves converge" — an unreachable `BDC` keeps its wrapper while its slot is
released, so the widened rule reports it anyway — cannot be exercised: reaching
an unaddressable `BDC` needs one inside a tiling pattern or a Type 3
`/CharProcs`, and no fixture here builds one. The reasoning is what holds it.
Do not invent a fixture that merely *looks* like that shape; say it is
uncovered.
