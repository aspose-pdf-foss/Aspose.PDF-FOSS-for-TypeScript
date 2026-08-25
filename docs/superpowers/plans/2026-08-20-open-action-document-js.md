# Catalog /OpenAction and Document JavaScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller author what the document does when it opens — `doc.SetOpenDestination` / `doc.SetOpenAction` — and carry document-level scripts through `doc.SetJavaScript`, over a name-tree helper that stops `/Dests`, `/EmbeddedFiles` and `/JavaScript` being three copies of one pruning rule.

**Architecture:** `nametree.ts` is a new leaf owning the `/Root /Names` vocabulary, read and write; the three read helpers move there from `outline.ts` and gain `upsertNameTreeEntry`/`removeNameTreeEntry`. `docaction.ts` owns both catalog features and is the only new module `document.ts` calls into. A pre-existing `/JS`-as-a-stream read defect in `actions.ts` is fixed first, because the JavaScript tree is where it bites.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-20-open-action-document-js-design.md` — read it before Task 1 and keep it open; this plan argues from it.

**Issue:** `aspose-pdf-foss-for-ts-lucg.4` (beads), already claimed.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **`nametree.ts` must stay a LEAF.** It imports `Document` as a **type** only (`import type`). If it ever needs a value from `document.js`, the design is wrong — take the value as an argument instead.
- **Validation precedes allocation**, so a rejected call leaves the document byte-identical.
- **One owner for each check.** `encodeAction` already range-checks a `goto` page and rejects an empty script; do not restate either.
- **Errors:** `RangeError` for an out-of-range page (matching `SetNamedDestination`), `TypeError` for a bad name or an unknown action type.
- **Run before closing:** `npm run typecheck` and `npm test`, both green.
- **Commit style:** `feat(lucg.4): <subject>` / `fix(lucg.4): …` / `test(lucg.4): …` / `docs(lucg.4): …`, ending with a `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## Two deviations from the spec, decided while planning

1. **`removeNameTreeEntry` returns `PdfObject | undefined`, not `boolean`.** The spec said boolean. `removeEmbeddedFile` needs the *removed value* to call `removeAssociatedFile(doc, removed)` — with a boolean it would have to walk the tree a second time through `lookupNameTree` just to recover what it had already found. Returning the value serves all three consumers and `!== undefined` is the boolean. `RemoveJavaScript` returns `removeNameTreeEntry(...) !== undefined`.
2. **`flatNameNode` leaves `outline.ts` entirely; `lookupNameTree` and `collectNameTree` are imported back.** Measured: `flatNameNode` has no caller inside `outline.ts` (only its definition at `:220`), while `lookupNameTree` is used at `:106` and `:121` and `collectNameTree` at `:189` and `:201`. So the import-back list is exactly two names, not three.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/nametree.ts` | **create** | The `/Root /Names` vocabulary: `lookupNameTree`, `collectNameTree`, `flatNameNode` (moved), plus `upsertNameTreeEntry` / `removeNameTreeEntry`. A leaf. |
| `src/outline.ts` | modify | Loses the three helpers; imports two back. |
| `src/embeddedfile.ts` | modify | `upsertEmbeddedFile` / `removeEmbeddedFile` delegate the tree half. |
| `src/document.ts` | modify | `SetNamedDestination` / `RemoveNamedDestination` delegate; seven new entry points. |
| `src/actions.ts` | modify | `/JS` stream read. |
| `src/docaction.ts` | **create** | `/OpenAction` and the `/Names /JavaScript` tree. |
| `src/index.ts` | modify | Export `OpenAction`, `DocumentJavaScript`. |
| `test/nametree.test.ts` | **create** | The shared machinery, from hand-built dicts. |
| `test/docaction.test.ts` | **create** | `/OpenAction`, both kinds and the discriminator. |
| `test/docjs.test.ts` | **create** | The JavaScript tree. |
| `test/actions.test.ts` | modify | The `/JS` stream case. |
| `README.md` / `CHANGELOG.md` | modify | Docs. |

---

## Task 1: Extract `nametree.ts`

**Files:**
- Create: `src/nametree.ts`
- Modify: `src/outline.ts`, `src/embeddedfile.ts`, `src/document.ts`
- Test: `test/nametree.test.ts` (create)

**Interfaces:**
- Consumes: `Document` (type only), `PdfDict`/`PdfObject` from `types.js`, `decodePdfText`/`encodePdfText` from `metadata.js`.
- Produces:
  ```ts
  export function lookupNameTree(doc: Document, node: PdfObject, key: string): PdfObject | undefined;
  export function collectNameTree(doc: Document, node: PdfObject | undefined, out: Array<[string, PdfObject]>): void;
  export function flatNameNode(entries: Map<string, PdfObject>): PdfDict;
  export function upsertNameTreeEntry(doc: Document, branch: string, key: string, value: PdfObject): void;
  export function removeNameTreeEntry(doc: Document, branch: string, key: string): PdfObject | undefined;
  ```
  Task 4 calls `upsertNameTreeEntry`, `removeNameTreeEntry` and `collectNameTree`.

- [ ] **Step 1: Write the failing test**

Create `test/nametree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  collectNameTree, removeNameTreeEntry, upsertNameTreeEntry,
} from '../src/nametree.js';
import { decodePdfText } from '../src/metadata.js';
import { isDict, isRef, isString, type PdfDict, type PdfObject } from '../src/types.js';

/** The entries of one branch, read back through the collector. */
const branchOf = (doc: Document, branch: string): Array<[string, PdfObject]> => {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const out: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, out);
  return out;
};

/** The raw key order of a branch's /Names array — flatNameNode must sort. */
const keyOrder = (doc: Document, branch: string): string[] => {
  const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
  const node = doc.resolve(names.get(branch)) as PdfDict;
  const arr = doc.resolve(node.get('Names')) as PdfObject[];
  const keys: string[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const k = doc.resolve(arr[i]);
    if (isString(k)) keys.push(decodePdfText(k.bytes));
  }
  return keys;
};

describe('upsertNameTreeEntry', () => {
  it('creates /Names and the branch when neither exists', () => {
    const doc = Document.New();
    expect(doc.catalog().has('Names')).toBe(false);
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    expect(branchOf(doc, 'Dests')).toEqual([['a', 42]]);
  });

  it('stores the branch node as an indirect REF, not a direct dict', () => {
    // Pins the risk the spec names: all three existing call sites allocate the
    // node, and turning it direct would move every saved-bytes assertion in the
    // attachment suite while every behavioural test stayed green.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(isRef(names.get('Dests'))).toBe(true);
  });

  it('keeps the other entries and sorts the /Names array by key', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'b', 2);
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    expect(keyOrder(doc, 'Dests')).toEqual(['a', 'b']);
  });

  it('replaces the value for an existing key rather than duplicating it', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'Dests', 'a', 2);
    expect(branchOf(doc, 'Dests')).toEqual([['a', 2]]);
  });
});

describe('removeNameTreeEntry', () => {
  it('returns the removed value, and undefined for an absent key', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    expect(removeNameTreeEntry(doc, 'Dests', 'nope')).toBeUndefined();
    expect(branchOf(doc, 'Dests')).toEqual([['a', 42]]); // untouched
    expect(removeNameTreeEntry(doc, 'Dests', 'a')).toBe(42);
  });

  it('returns undefined when there is no /Names at all', () => {
    expect(removeNameTreeEntry(Document.New(), 'Dests', 'a')).toBeUndefined();
  });

  it('prunes the branch but KEEPS /Names while another branch survives', () => {
    // The first half of the two-level rule. A single-branch fixture cannot tell
    // correct pruning from over-eager pruning — both delete /Names here — which
    // is why this case and the next are asserted as a pair.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'JavaScript', 'x', 2);
    removeNameTreeEntry(doc, 'Dests', 'a');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(names.has('Dests')).toBe(false);
    expect(names.has('JavaScript')).toBe(true);
  });

  it('prunes /Names itself once its last branch empties', () => {
    // The second half. One level of pruning leaves << /Names << >> >> in the
    // saved file: legal, harmless, and different from what the other branches
    // produce.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'JavaScript', 'x', 2);
    removeNameTreeEntry(doc, 'JavaScript', 'x');
    expect(doc.catalog().has('Names')).toBe(false);
  });

  it('leaves the surviving entries alone when the branch does not empty', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'Dests', 'b', 2);
    removeNameTreeEntry(doc, 'Dests', 'a');
    expect(branchOf(doc, 'Dests')).toEqual([['b', 2]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/nametree.test.ts`

Expected: FAIL — `Failed to resolve import "../src/nametree.js"`.

- [ ] **Step 3: Create `src/nametree.ts`**

Cut `lookupNameTree` (`src/outline.ts:86`), `collectNameTree` (`:179`) and `flatNameNode` (`:220`) out of `outline.ts` — bodies **verbatim**, comments included — and paste them into this new file beneath the header, then add the two writers:

```ts
// The /Root /Names name-tree vocabulary, read and write.
//
// A LEAF, deliberately: it imports Document as a TYPE only, which is what lets
// document.ts, embeddedfile.ts and docaction.ts all hold it without any of them
// depending on another — the arrangement tablegrid.ts already has between the
// two table detectors. It lives here rather than in outline.ts because that
// module is bookmarks and destinations, and a name tree is neither: /Dests is
// only one of its three branches.
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isString } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

// ... the three moved functions go here, unchanged ...

/** Upsert `key` → `value` into `/Root /Names /<branch>`, creating the
 *  containers as needed and rewriting the branch as a single flat node — no
 *  balanced-tree rebalancing, which is what all three branches already did.
 *
 *  The value is stored EXACTLY as given: `/Dests` stores a direct array and
 *  `/EmbeddedFiles` a ref, so this must not decide for them. The branch NODE is
 *  always allocated, which every existing call site did and which the attachment
 *  suite's saved-bytes assertions depend on. */
export function upsertNameTreeEntry(
  doc: Document, branch: string, key: string, value: PdfObject,
): void {
  const catalog = doc.catalog();
  let names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) { names = new Map<string, PdfObject>(); catalog.set('Names', names); }
  const entries = new Map<string, PdfObject>();
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, collected);
  for (const [k, v] of collected) entries.set(k, v);
  entries.set(key, value);
  names.set(branch, doc.allocObject(flatNameNode(entries)));
}

/** Remove `key` from `/Root /Names /<branch>`, returning the value that was
 *  there (undefined when the key, the branch or /Names was absent).
 *
 *  Returns the VALUE rather than a boolean because `removeEmbeddedFile` needs it
 *  to unregister the filespec from /AF, and would otherwise walk the tree a
 *  second time to recover what this call already found. `!== undefined` is the
 *  boolean for callers that only want that.
 *
 *  **Pruning is two-level.** Emptying the branch deletes it from /Names, and if
 *  /Names is then empty it is deleted from the catalog. One level leaves
 *  `<< /Names << >> >>` behind: legal, harmless, and different from what the
 *  other branches produce — so the divergence surfaces as a byte diff in an
 *  unrelated feature rather than as a failure here. */
export function removeNameTreeEntry(
  doc: Document, branch: string, key: string,
): PdfObject | undefined {
  const catalog = doc.catalog();
  const names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) return undefined;
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, collected);
  const entries = new Map<string, PdfObject>(collected);
  const removed = entries.get(key);
  if (!entries.delete(key)) return undefined;
  if (entries.size === 0) {
    names.delete(branch);
    if (names.size === 0) catalog.delete('Names');
  } else {
    names.set(branch, doc.allocObject(flatNameNode(entries)));
  }
  return removed;
}
```

- [ ] **Step 4: Fix up `outline.ts`**

Add the import back — **exactly two names**, since `flatNameNode` has no caller left in this file:

```ts
import { collectNameTree, lookupNameTree } from './nametree.js';
```

Then check whether `PdfDict` or `encodePdfText` became unused in `outline.ts` and drop them from its import lists if so. `npm run typecheck` reports this; `PdfObject`, `isArray`, `isDict`, `isString` and `decodePdfText` all have other users there.

- [ ] **Step 5: Point `embeddedfile.ts` and `document.ts` at the new module and delegate**

In `src/embeddedfile.ts`, replace `import { collectNameTree, flatNameNode } from './outline.js';` with exactly these two names — measured, `embeddedfile.ts` has zero occurrences of `lookupNameTree`, and after the delegation it no longer references `collectNameTree` or `flatNameNode` either:

```ts
import { removeNameTreeEntry, upsertNameTreeEntry } from './nametree.js';
```

and replace the two bodies (`src/embeddedfile.ts:223` and `:240`) with:

```ts
/** Upsert `key` → `fsRef` into /Root /Names /EmbeddedFiles (single flat node,
 *  no rebalancing) and register the filespec in /AF. */
export function upsertEmbeddedFile(doc: Document, key: string, fsRef: PdfRef): void {
  if (typeof key !== 'string' || key === '')
    throw new RangeError('attachment name must be a non-empty string');
  upsertNameTreeEntry(doc, 'EmbeddedFiles', key, fsRef);
  addAssociatedFile(doc, fsRef);
}

/** Remove `key` from /EmbeddedFiles (collapsing empty containers) and from /AF.
 *  Returns false when the name was absent. */
export function removeEmbeddedFile(doc: Document, key: string): boolean {
  const removed = removeNameTreeEntry(doc, 'EmbeddedFiles', key);
  if (removed === undefined) return false;
  if (isRef(removed)) removeAssociatedFile(doc, removed);
  return true;
}
```

Note the name check stays a `RangeError` here — that is this function's existing contract and Task 1 must not change it. `isRef` is already imported in that file for other uses; leave its import list otherwise alone.

In `src/document.ts`, change the `./outline.js` import block (`:48-51`) to drop `collectNameTree, flatNameNode`:

```ts
import {
  OutlineItem, PageDest, readOutlineTree, buildOutlineObjects, validateOutlineItems,
  NamedDestination, readNamedDestinations, encodeDest,
} from './outline.js';
import { removeNameTreeEntry, upsertNameTreeEntry } from './nametree.js';
```

and replace the two method bodies (`src/document.ts:1251` and `:1270`) with:

```ts
  /** Upsert `name` → `dest` into the /Names /Dests name tree (creating the
   *  containers as needed), writing a single flat node — no balanced-tree
   *  rebalancing. Leaves the legacy /Dests dict untouched. */
  SetNamedDestination(name: string, dest: PageDest): void {
    if (typeof name !== 'string' || name === '') throw new TypeError('named destination name must be a non-empty string');
    const p = dest.page;
    if (!Number.isInteger(p) || p < 1 || p > this.Pages.length)
      throw new RangeError(`named destination page ${p} out of range 1..${this.Pages.length}`);
    upsertNameTreeEntry(this, 'Dests', name, encodeDest(this.pageRef(p), dest.view));
  }

  /** Remove `name` from both the name tree and the legacy /Dests dict, pruning
   *  the now-empty containers. A no-op when the name is absent.
   *
   *  Stays void and ignores the tree removal's result: the name may live in the
   *  tree, in the legacy dict, or in both, so the legacy pass runs either way. */
  RemoveNamedDestination(name: string): void {
    removeNameTreeEntry(this, 'Dests', name);
    const catalog = this.catalog();
    const legacy = this.resolve(catalog.get('Dests'));
    if (isDict(legacy) && legacy.delete(name) && legacy.size === 0) catalog.delete('Dests');
  }
```

- [ ] **Step 6: Run the new test and the extraction's fences**

```bash
npm run typecheck
npx vitest run test/nametree.test.ts test/named-destinations.test.ts test/embedded-files.test.ts test/embedded-authoring.test.ts test/outline.test.ts
```

Expected: PASS, with **no edits to the four existing files** (all four exist; `test/outline.test.ts` is confirmed present). That is the evidence the extraction preserved behaviour — the same argument `containMatrix` rested on in `lucg.3`.

- [ ] **Step 7: Prove the prune rule load-bearing**

In `removeNameTreeEntry`, delete the inner `if (names.size === 0) catalog.delete('Names');` line. Run `npx vitest run test/nametree.test.ts`:

- `prunes /Names itself once its last branch empties` must FAIL
- `prunes the branch but KEEPS /Names while another branch survives` must stay GREEN — the pair is what separates the two levels

Restore. Then delete `names.delete(branch);` and confirm the KEEPS-`/Names` case fails on `names.has('Dests')`. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/nametree.ts src/outline.ts src/embeddedfile.ts src/document.ts test/nametree.test.ts
git commit -m "feat(lucg.4): one owner for the /Names name-tree upsert and prune

The body existed twice verbatim apart from the branch name — document.ts for
/Dests and embeddedfile.ts for /EmbeddedFiles — and /JavaScript would have been
the third. nametree.ts is a leaf holding it plus the three read helpers moved
out of outline.ts, which is bookmarks and destinations and not the owner of a
tree whose /Dests is only one branch of three.

Only the tree half is shared: the legacy /Dests cleanup and the /AF
registration stay with their callers, since they are not the same step.
removeNameTreeEntry returns the removed VALUE rather than a boolean because
removeEmbeddedFile needs it to unregister from /AF.

Measured: dropping either level of the prune reddens one of the two pruning
cases and leaves the other green, which is why a single-branch fixture cannot
pin this. The existing named-destination, attachment and outline suites pass
unedited — the evidence the move preserved behaviour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Read a `/JS` stream

**Files:**
- Modify: `src/actions.ts:191`
- Test: `test/actions.test.ts` (append)

**Interfaces:**
- Consumes: `decodeStream` from `filters.js`, `isStream` from `types.js`.
- Produces: nothing new. `parseActionDict`'s `JavaScript` case gains a branch, so `parseAction` / `parseStandaloneAction` / `parseFieldActions` all inherit it.

**Why this is its own task, before the feature.** It is a **pre-existing defect**, reachable today from any annotation `/A` and any field `/AA` — nothing to do with the catalog. It goes in first because Task 4's stream test then needs no separate fix, and it is logged under **Fixed**, not **Added**.

- [ ] **Step 1: Write the failing test**

Append to `test/actions.test.ts`. Match that file's existing import style; it needs `Document`, `enc` from `../src/serialize.js`, `name` from `../src/types.js`, and `parseStandaloneAction` from `../src/actions.js` — add whichever are missing.

```ts
describe('JavaScript action /JS as a stream', () => {
  it('reads a stream /JS, not just a string', () => {
    // 32000-1 table 217: /JS is a text string OR a text stream, and a large
    // script is commonly the stream form. Before this, isString was the only
    // branch, so the WHOLE action read back as undefined — not merely its
    // script.
    const doc = Document.New();
    const js = doc.allocObject({
      kind: 'stream', dict: new Map(), raw: enc('app.alert("hi");'),
    });
    const action = new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', js]]);
    expect(parseStandaloneAction(doc, action))
      .toEqual({ type: 'javascript', script: 'app.alert("hi");' });
  });

  it('still reads a string /JS', () => {
    const doc = Document.New();
    const action = new Map<string, PdfObject>([
      ['S', name('JavaScript')],
      ['JS', { kind: 'string', bytes: encodePdfText('x = 1;') }],
    ]);
    expect(parseStandaloneAction(doc, action))
      .toEqual({ type: 'javascript', script: 'x = 1;' });
  });

  it('returns undefined for a /JS that is neither', () => {
    const doc = Document.New();
    const action = new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', 42]]);
    expect(parseStandaloneAction(doc, action)).toBeUndefined();
  });
});
```

`encodePdfText` comes from `../src/metadata.js`; `PdfObject` from `../src/types.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/actions.test.ts`

Expected: the stream case FAILS (`undefined` where the action was expected); the other two PASS.

- [ ] **Step 3: Implement the branch**

In `src/actions.ts`, add to the imports:

```ts
import { decodeStream } from './filters.js';
```

and add `isStream` to the existing `./types.js` import list. Then replace the `JavaScript` case in `parseActionDict` (`src/actions.ts:191`):

```ts
    case 'JavaScript': {
      const js = doc.resolve((a as PdfDict).get('JS'));
      if (isString(js)) return { type: 'javascript', script: decodePdfText(js.bytes) };
      // 32000-1 table 217: /JS is a text string OR a text stream. Reading only
      // the string made the whole action vanish, not merely its script — and
      // the stream form is what a producer picks for a large document-level
      // script. Damage costs the action, never the parse: this grammar is one
      // of the layers that ignores what it cannot read.
      if (isStream(js)) {
        try {
          return { type: 'javascript', script: decodePdfText(decodeStream(js)) };
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
```

The `try` is not decoration: `decodeStream` throws `UnsupportedFeatureError` for a filter it cannot apply, and an unreadable script must not take down the parse of the annotation that carries it.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run typecheck
npx vitest run test/actions.test.ts
```

Expected: PASS. If `typecheck` reports an import cycle, stop — `filters.ts` reaches only `types`/`flate`/`lzw`/`ascii`/`ccitt` and must not reach `actions.ts`.

- [ ] **Step 5: Prove it load-bearing**

Delete the `isStream(js)` branch. Run `npx vitest run test/actions.test.ts`: `reads a stream /JS` must FAIL and the other two stay GREEN. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/actions.ts test/actions.test.ts
git commit -m "fix(lucg.4): read a JavaScript action whose /JS is a stream

32000-1 table 217 makes /JS a text string OR a text stream, and parseActionDict
accepted only the string — so such an action read back as undefined ENTIRELY,
not merely without its script. Reachable today from any annotation /A and any
field /AA; document-level scripts are simply where the stream form is most
common, since that is where large scripts live.

An undecodable stream still yields undefined rather than throwing: this grammar
is one of the layers that ignores what it cannot read.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Catalog `/OpenAction`

**Files:**
- Create: `src/docaction.ts`
- Modify: `src/document.ts`, `src/index.ts`
- Test: `test/docaction.test.ts` (create)

**Interfaces:**
- Consumes: `encodeAction` / `parseStandaloneAction` / `PdfAction` (`actions.js`), `decodeDest` / `encodeDest` / `PageDest` (`outline.js`).
- Produces:
  ```ts
  export type OpenAction =
    | { kind: 'dest';   dest: PageDest }
    | { kind: 'action'; action: PdfAction };
  export function readOpenAction(doc: Document): OpenAction | undefined;
  export function setOpenDestination(doc: Document, dest: PageDest): void;
  export function setOpenAction(doc: Document, action: PdfAction): void;
  export function removeOpenAction(doc: Document): void;
  ```
  Task 4 adds to this same module.

**Why `kind` and not `type`.** `PdfAction` already discriminates on `type`, so `{ type: 'action', action: { type: 'goto' } }` would nest two different `type` fields one level apart. `kind` is the discriminator `types.ts` already uses for `PdfStream`/`PdfString`.

- [ ] **Step 1: Write the failing test**

Create `test/docaction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodeDest } from '../src/outline.js';
import { isArray, isDict, name, type PdfObject } from '../src/types.js';

/** A document with `n` A4 pages. */
const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetOpenAction (read)', () => {
  it('is undefined when the catalog has none', () => {
    expect(docWith(1).GetOpenAction()).toBeUndefined();
  });

  it('reads a bare destination array as kind dest', () => {
    const doc = docWith(3);
    doc.catalog().set('OpenAction', encodeDest(doc.pageRef(3), { type: 'Fit' }));
    expect(doc.GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 3, view: { type: 'Fit' } } });
  });

  // THE pair. Both dicts carry /D and both resolve to page 3, so a page-number
  // assertion passes with the discriminator inverted; only `kind` separates
  // them. decodeDest already accepts the << /D [...] >> destination-dict form,
  // which is exactly why a dict alone cannot decide it.
  it('reads a << /D [...] >> dict with NO /S as kind dest', () => {
    const doc = docWith(3);
    const d = encodeDest(doc.pageRef(3), { type: 'Fit' });
    doc.catalog().set('OpenAction', new Map<string, PdfObject>([['D', d]]));
    const got = doc.GetOpenAction();
    expect(got?.kind).toBe('dest');
    expect(got).toEqual({ kind: 'dest', dest: { page: 3, view: { type: 'Fit' } } });
  });

  it('reads a << /S /GoTo /D [...] >> dict as kind action', () => {
    const doc = docWith(3);
    const d = encodeDest(doc.pageRef(3), { type: 'Fit' });
    doc.catalog().set('OpenAction',
      new Map<string, PdfObject>([['S', name('GoTo')], ['D', d]]));
    const got = doc.GetOpenAction();
    expect(got?.kind).toBe('action');
    expect(got).toEqual({
      kind: 'action', action: { type: 'goto', page: 3, view: { type: 'Fit' } },
    });
  });

  it('is undefined for an action type the library does not model', () => {
    const doc = docWith(1);
    doc.catalog().set('OpenAction', new Map<string, PdfObject>([['S', name('Launch')]]));
    expect(doc.GetOpenAction()).toBeUndefined();
  });
});

describe('SetOpenDestination / SetOpenAction (write)', () => {
  it('SetOpenDestination writes an ARRAY and round-trips', () => {
    const doc = docWith(3);
    doc.SetOpenDestination({ page: 2, view: { type: 'Fit' } });
    expect(isArray(doc.resolve(doc.catalog().get('OpenAction')))).toBe(true);
    expect(reopen(doc).GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 2, view: { type: 'Fit' } } });
  });

  it('SetOpenAction writes a DICT and round-trips', () => {
    // The two writers must not converge on one shape: a caller who asked for an
    // action and got an array back has had their statement rewritten.
    const doc = docWith(3);
    doc.SetOpenAction({ type: 'javascript', script: 'app.alert("hi");' });
    expect(isDict(doc.resolve(doc.catalog().get('OpenAction')))).toBe(true);
    expect(reopen(doc).GetOpenAction())
      .toEqual({ kind: 'action', action: { type: 'javascript', script: 'app.alert("hi");' } });
  });

  it('defaults the view to Fit, as encodeDest does', () => {
    const doc = docWith(3);
    doc.SetOpenDestination({ page: 2 });
    expect(doc.GetOpenAction())
      .toEqual({ kind: 'dest', dest: { page: 2, view: { type: 'Fit' } } });
  });

  it('rejects an out-of-range page and leaves the document byte-identical', () => {
    const doc = docWith(2);
    const before = doc.Save().length;
    expect(() => doc.SetOpenDestination({ page: 3 })).toThrow(RangeError);
    expect(() => doc.SetOpenDestination({ page: 0 })).toThrow(RangeError);
    // encodeAction owns the same check for a goto action — not restated.
    expect(() => doc.SetOpenAction({ type: 'goto', page: 3 })).toThrow(RangeError);
    expect(doc.Save().length).toBe(before);
  });

  it('rejects an unknown action type', () => {
    const doc = docWith(1);
    expect(() => doc.SetOpenAction({ type: 'nope' } as never)).toThrow(TypeError);
  });
});

describe('RemoveOpenAction', () => {
  it('removes an existing one and is a no-op otherwise', () => {
    const doc = docWith(2);
    doc.SetOpenDestination({ page: 1 });
    doc.RemoveOpenAction();
    expect(doc.GetOpenAction()).toBeUndefined();
    expect(() => doc.RemoveOpenAction()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docaction.test.ts`

Expected: FAIL — `doc.GetOpenAction is not a function`.

- [ ] **Step 3: Create `src/docaction.ts`**

```ts
// Catalog-level actions: /OpenAction and the /Names /JavaScript tree — what the
// DOCUMENT does, as opposed to what activating an annotation does, which is
// annotation.ts's /A. Both halves are small, both write to the catalog, and
// neither has anything the other lacks, so they share a module rather than
// making a two-file feature with nothing in either file.
//
// Nothing here re-derives the action grammar: encodeAction and
// parseStandaloneAction in actions.ts are the one owner, which is what gives
// this module the /JS stream read for free.
import type { Document } from './document.js';
import { isDict, isName } from './types.js';
import { encodeAction, parseStandaloneAction, type PdfAction } from './actions.js';
import { decodeDest, encodeDest, type PageDest } from './outline.js';

/** What a document does when it is opened: go to a view, or run an action.
 *  32000-1 table 28 permits either.
 *
 *  Discriminated on `kind` rather than `type` because {@link PdfAction} already
 *  uses `type`, and nesting two of them one level apart reads badly. */
export type OpenAction =
  | { kind: 'dest'; dest: PageDest }
  | { kind: 'action'; action: PdfAction };

/** Read the catalog /OpenAction; undefined when absent, or present in a form
 *  this library does not model.
 *
 *  **The discriminator is `/S`, and it must be tested FIRST.** Three shapes
 *  arrive and two of them are dicts: a bare array is a destination,
 *  `<< /D [...] >>` is a destination, and `<< /S /GoTo /D [...] >>` is an
 *  action. `decodeDest` already accepts the middle form, and a GoTo action
 *  carries /D too, so a dict alone decides nothing.
 *
 *  This is the one rule here that is silently wrong when wrong: a GoTo action
 *  mis-read as a destination resolves to the SAME page, so every page-number
 *  assertion passes while the reported kind is wrong and a read-modify-write
 *  rewrites the producer's action dict as a bare array. */
export function readOpenAction(doc: Document): OpenAction | undefined {
  const v = doc.resolve(doc.catalog().get('OpenAction'));
  if (isDict(v) && isName(doc.resolve(v.get('S')))) {
    const action = parseStandaloneAction(doc, v);
    return action ? { kind: 'action', action } : undefined;
  }
  const dest = decodeDest(doc, v, (o) => doc.pageNumberOf(o));
  return dest ? { kind: 'dest', dest } : undefined;
}

/** Write /OpenAction as a bare destination array. */
export function setOpenDestination(doc: Document, dest: PageDest): void {
  const p = dest.page;
  if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
    throw new RangeError(`open destination page ${String(p)} out of range 1..${doc.Pages.length}`);
  doc.catalog().set('OpenAction', encodeDest(doc.pageRef(p), dest.view));
}

/** Write /OpenAction as a direct action dict. `encodeAction` validates — it
 *  already range-checks a goto page and rejects an unknown type, and a second
 *  copy of those checks is how two entry points come to disagree about a page
 *  number. */
export function setOpenAction(doc: Document, action: PdfAction): void {
  const dict = encodeAction(doc, action);
  doc.catalog().set('OpenAction', dict);
}

/** Delete /OpenAction. A no-op when absent. */
export function removeOpenAction(doc: Document): void {
  doc.catalog().delete('OpenAction');
}
```

Task 4 adds `PdfObject` to that `./types.js` import; this task does not need it.

- [ ] **Step 4: Add the four entry points to `document.ts`**

Add the imports beside the `./nametree.js` one added in Task 1:

```ts
import type { PdfAction } from './actions.js';
import {
  OpenAction, readOpenAction, removeOpenAction, setOpenAction, setOpenDestination,
} from './docaction.js';
```

and add the methods immediately after `RemoveNamedDestination`:

```ts
  /** What this document does when it is opened: go to a view (`kind: 'dest'`)
   *  or run an action (`kind: 'action'`). Undefined when the catalog carries
   *  none, and also when it carries one in a form this library does not model —
   *  the position an annotation's /A already takes. */
  GetOpenAction(): OpenAction | undefined {
    return readOpenAction(this);
  }

  /** Open the document at `dest`, written as a destination. Throws RangeError
   *  for a page outside 1..Pages.length. */
  SetOpenDestination(dest: PageDest): void {
    setOpenDestination(this, dest);
  }

  /** Run `action` when the document is opened, written as an action dict.
   *  `{ type: 'goto', page }` is the action spelling of `SetOpenDestination`;
   *  both are legal and the two write different shapes, so pick the one you
   *  mean. */
  SetOpenAction(action: PdfAction): void {
    setOpenAction(this, action);
  }

  /** Remove the catalog /OpenAction. A no-op when there is none. */
  RemoveOpenAction(): void {
    removeOpenAction(this);
  }
```

- [ ] **Step 5: Export the type**

In `src/index.ts`, beside the existing `./actions.js` type export block:

```ts
export type { OpenAction } from './docaction.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run typecheck
npx vitest run test/docaction.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove the discriminator load-bearing**

In `readOpenAction`, invert the test — change `if (isDict(v) && isName(doc.resolve(v.get('S'))))` to `if (isDict(v) && !isName(doc.resolve(v.get('S'))))`. Run `npx vitest run test/docaction.test.ts`:

- both `reads a << /D ... >> dict with NO /S` and `reads a << /S /GoTo ... >>` must FAIL, on `kind`
- `reads a bare destination array as kind dest` must stay GREEN — the array path never reaches the test, which is why an array-only fixture cannot pin this

Restore. Then remove the `/S` test entirely (`if (false)`), and confirm the `/S /GoTo` case fails while the page number it reports is still 3 — the measurement behind the comment.

- [ ] **Step 8: Commit**

```bash
git add src/docaction.ts src/document.ts src/index.ts test/docaction.test.ts
git commit -m "feat(lucg.4): author the catalog /OpenAction

Two writers, because 32000-1 table 28 permits two shapes and they are not
interchangeable: SetOpenDestination writes a bare destination array,
SetOpenAction a direct action dict. Neither restates a check — encodeAction
already range-checks a goto page and rejects an unknown type.

Reading turns on one rule: the discriminator is /S and nothing else. decodeDest
already accepts a << /D [...] >> destination dict and a GoTo action carries /D
too, so a dict alone decides nothing. Measured — inverting the test reddens the
two dict cases and leaves the bare-array case green, and with the test removed
the mis-read GoTo still reports the right page, which is why only kind is
asserted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The document JavaScript name tree

**Files:**
- Modify: `src/docaction.ts`, `src/document.ts`, `src/index.ts`
- Test: `test/docjs.test.ts` (create)

**Interfaces:**
- Consumes: `collectNameTree` / `upsertNameTreeEntry` / `removeNameTreeEntry` (Task 1), `encodeAction` / `parseStandaloneAction` (Task 2's fix included).
- Produces:
  ```ts
  export interface DocumentJavaScript { name: string; script: string; }
  export function readDocumentJavaScripts(doc: Document): DocumentJavaScript[];
  export function setDocumentJavaScript(doc: Document, key: string, script: string): void;
  export function removeDocumentJavaScript(doc: Document, key: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/docjs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { upsertNameTreeEntry } from '../src/nametree.js';
import { enc } from '../src/serialize.js';
import { isDict, name, type PdfDict, type PdfObject } from '../src/types.js';

const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('GetJavaScripts / SetJavaScript', () => {
  it('is empty for a document with no tree', () => {
    expect(docWith(1).GetJavaScripts()).toEqual([]);
  });

  it('round-trips a script through Save/Open', () => {
    const doc = docWith(1);
    doc.SetJavaScript('greet', 'app.alert("hi");');
    expect(reopen(doc).GetJavaScripts())
      .toEqual([{ name: 'greet', script: 'app.alert("hi");' }]);
  });

  it('returns several entries sorted by name', () => {
    const doc = docWith(1);
    doc.SetJavaScript('zebra', 'z');
    doc.SetJavaScript('alpha', 'a');
    expect(doc.GetJavaScripts().map((j) => j.name)).toEqual(['alpha', 'zebra']);
  });

  it('sorts a tree that does not present its entries in order', () => {
    // The case above CANNOT pin the sort: flatNameNode orders the /Names array
    // on write, so any tree we wrote comes back sorted whatever the reader
    // does. Scrambling the node afterwards is the only fixture that fails when
    // the sort is removed — and an unordered node is a real shape, since a
    // third-party producer or a /Kids tree owes us nothing.
    const doc = docWith(1);
    doc.SetJavaScript('alpha', 'a');
    doc.SetJavaScript('zebra', 'z');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    const node = doc.resolve(names.get('JavaScript')) as PdfDict;
    const arr = doc.resolve(node.get('Names')) as PdfObject[];
    node.set('Names', [arr[2], arr[3], arr[0], arr[1]]);   // zebra pair first
    expect(doc.GetJavaScripts().map((j) => j.name)).toEqual(['alpha', 'zebra']);
  });

  it('replaces the script for an existing name', () => {
    const doc = docWith(1);
    doc.SetJavaScript('n', 'first');
    doc.SetJavaScript('n', 'second');
    expect(doc.GetJavaScripts()).toEqual([{ name: 'n', script: 'second' }]);
  });

  it('reads an entry whose /JS is a STREAM', () => {
    // The shape a producer picks for a large document-level script. Task 2's
    // fix is what makes this readable; before it, the entry vanished whole.
    const doc = docWith(1);
    const js = doc.allocObject({
      kind: 'stream', dict: new Map(), raw: enc('var big = 1;'),
    });
    upsertNameTreeEntry(doc, 'JavaScript', 'big',
      new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', js]]));
    expect(doc.GetJavaScripts()).toEqual([{ name: 'big', script: 'var big = 1;' }]);
  });

  it('skips a non-JavaScript entry and still returns its siblings', () => {
    // 32000-1 7.7.4 requires a JavaScript action here. A ResetForm action parses
    // fine and has no script to report, so it is skipped — but the skip must not
    // truncate the list, which is the failure a single-entry fixture cannot see.
    const doc = docWith(1);
    doc.SetJavaScript('good', 'x = 1;');
    upsertNameTreeEntry(doc, 'JavaScript', 'bad',
      new Map<string, PdfObject>([['S', name('ResetForm')]]));
    expect(doc.GetJavaScripts()).toEqual([{ name: 'good', script: 'x = 1;' }]);
  });

  it('rejects an empty name or an empty script, allocating nothing', () => {
    const doc = docWith(1);
    const before = doc.Save().length;
    expect(() => doc.SetJavaScript('', 'x')).toThrow(TypeError);
    expect(() => doc.SetJavaScript('n', '')).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('RemoveJavaScript', () => {
  it('returns true then false, and prunes /Names when the last entry goes', () => {
    // The end-to-end reading of nametree.ts's two-level prune.
    const doc = docWith(1);
    doc.SetJavaScript('n', 'x = 1;');
    expect(doc.RemoveJavaScript('n')).toBe(true);
    expect(doc.RemoveJavaScript('n')).toBe(false);
    expect(doc.GetJavaScripts()).toEqual([]);
    expect(doc.catalog().has('Names')).toBe(false);
  });

  it('leaves a sibling branch alone', () => {
    const doc = docWith(2);
    doc.SetNamedDestination('chap1', { page: 1 });
    doc.SetJavaScript('n', 'x = 1;');
    doc.RemoveJavaScript('n');
    const names = doc.resolve(doc.catalog().get('Names'));
    expect(isDict(names) && (names as PdfDict).has('Dests')).toBe(true);
    expect(doc.GetNamedDestinations()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docjs.test.ts`

Expected: FAIL — `doc.GetJavaScripts is not a function`.

- [ ] **Step 3: Add the JavaScript half to `src/docaction.ts`**

Extend the imports — add `PdfObject` to the existing `./types.js` line so it reads `import { PdfObject, isDict, isName } from './types.js';`, and add:

```ts
import {
  collectNameTree, removeNameTreeEntry, upsertNameTreeEntry,
} from './nametree.js';
```

and append to the module:

```ts
/** One entry of the document-level JavaScript name tree. */
export interface DocumentJavaScript {
  /** The name-tree key. Viewers run every entry at open, in name order. */
  name: string;
  /** The script text. */
  script: string;
}

/** Every entry of /Root /Names /JavaScript, sorted by name — matching
 *  `GetNamedDestinations`.
 *
 *  Entries are read through `parseStandaloneAction`, never by reaching for /JS
 *  directly: that function is the one owner of the action grammar, and it is
 *  what makes a stream /JS readable here.
 *
 *  32000-1 §7.7.4 requires these values to be JavaScript actions. An entry that
 *  parses as anything else has no script to report and {@link DocumentJavaScript}
 *  admits nothing else, so it is SKIPPED while its siblings are still returned. */
export function readDocumentJavaScripts(doc: Document): DocumentJavaScript[] {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('JavaScript') ?? null, collected);
  const out: DocumentJavaScript[] = [];
  for (const [key, value] of collected) {
    const a = parseStandaloneAction(doc, value);
    if (a?.type === 'javascript') out.push({ name: key, script: a.script });
  }
  return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** Upsert `key` → a JavaScript action carrying `script`.
 *
 *  The action is built BEFORE the tree is touched, so `encodeAction`'s rejection
 *  of an empty script leaves the document byte-identical. */
export function setDocumentJavaScript(doc: Document, key: string, script: string): void {
  if (typeof key !== 'string' || key === '')
    throw new TypeError('document JavaScript name must be a non-empty string');
  const value = encodeAction(doc, { type: 'javascript', script });
  upsertNameTreeEntry(doc, 'JavaScript', key, value);
}

/** Remove `key` from the tree, pruning the empty containers. False when absent. */
export function removeDocumentJavaScript(doc: Document, key: string): boolean {
  return removeNameTreeEntry(doc, 'JavaScript', key) !== undefined;
}
```

- [ ] **Step 4: Add the three entry points to `document.ts`**

Extend the `./docaction.js` import to include `DocumentJavaScript, readDocumentJavaScripts, removeDocumentJavaScript, setDocumentJavaScript`, and add the methods after `RemoveOpenAction`:

```ts
  /** Document-level JavaScript: every entry of the /Names /JavaScript tree,
   *  sorted by name. An entry that is not a JavaScript action is skipped. */
  GetJavaScripts(): DocumentJavaScript[] {
    return readDocumentJavaScripts(this);
  }

  /** Upsert a document-level script, run by the viewer when the document opens.
   *  Throws TypeError for an empty name or an empty script. */
  SetJavaScript(name: string, script: string): void {
    setDocumentJavaScript(this, name, script);
  }

  /** Remove a document-level script. False when the name was absent. */
  RemoveJavaScript(name: string): boolean {
    return removeDocumentJavaScript(this, name);
  }
```

- [ ] **Step 5: Export the type**

In `src/index.ts`, extend the line added in Task 3:

```ts
export type { OpenAction, DocumentJavaScript } from './docaction.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run typecheck
npx vitest run test/docjs.test.ts test/docaction.test.ts test/nametree.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove the skip and the ordering load-bearing**

1. Change `if (a?.type === 'javascript')` to `if (a)` and push `script: ''` for the rest. `skips a non-JavaScript entry` must FAIL. Restore.
2. Delete the `.sort(...)` in `readDocumentJavaScripts`. `sorts a tree that does not present its entries in order` must FAIL, and `returns several entries sorted by name` must stay **GREEN** — that asymmetry is the whole reason the scrambled fixture exists, since `flatNameNode` orders the array on write and makes the ordinary case blind to the reader's sort. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/docaction.ts src/document.ts src/index.ts test/docjs.test.ts
git commit -m "feat(lucg.4): author the document JavaScript name tree

GetJavaScripts/SetJavaScript/RemoveJavaScript over /Root /Names /JavaScript,
mirroring the named-destination trio and sharing nametree.ts's upsert and
two-level prune.

Entries are read through parseStandaloneAction rather than by reaching for /JS,
which is what gives this the stream read fixed earlier. A non-JavaScript entry
is skipped — 32000-1 7.7.4 requires a JavaScript action and DocumentJavaScript
has nowhere to put a ResetForm — and the skip must not truncate the list, which
a single-entry fixture cannot see.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Documentation and the full verification pass

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by code.

- [ ] **Step 1: Document it in the README**

Find the named-destinations prose (search for `GetNamedDestinations`) and add after that subsection:

````markdown
### Document open behaviour and document-level JavaScript

The catalog's `/OpenAction` says what happens when the document is opened, and
32000-1 permits two shapes — a destination, or an action. They are separate
calls because they are not interchangeable:

```ts
doc.SetOpenDestination({ page: 3, view: { type: 'Fit' } }); // open at page 3
doc.SetOpenAction({ type: 'javascript', script: 'app.alert("Hello");' });

doc.GetOpenAction();
// -> { kind: 'dest', dest: { page: 3, view: { type: 'Fit' } } }
// or { kind: 'action', action: { type: 'javascript', script: '...' } }
doc.RemoveOpenAction();
```

`GetOpenAction()` is `undefined` both when there is none and when the document
carries one this library does not model — the position an annotation's `/A`
already takes.

Document-level scripts live in the `/Names /JavaScript` tree, which a viewer
runs at open in name order:

```ts
doc.SetJavaScript('init', 'var total = 0;');
doc.GetJavaScripts();      // [{ name: 'init', script: 'var total = 0;' }]
doc.RemoveJavaScript('init');   // true
```

An entry that is not a JavaScript action is skipped rather than reported, since
there is no script to give back. The library stores script text and never
interprets it. Note `ConvertToPdfA` and `ConvertToPdfX` remove both constructs
unless you preserve them — they are prohibited in those profiles.
````

- [ ] **Step 2: Update the Features bullet and the API table**

In the Features list, after the bookmarks/destinations bullet, add:

```markdown
- **Open behaviour and document JavaScript** — `doc.SetOpenDestination(dest)` / `doc.SetOpenAction(action)` author the catalog `/OpenAction` in either shape 32000-1 permits, read back through one `GetOpenAction()`; `doc.SetJavaScript(name, script)` / `GetJavaScripts()` / `RemoveJavaScript(name)` author the document-level `/Names /JavaScript` tree.
```

In the API overview table, beside the `doc.SetNamedDestination` row:

```markdown
| `doc.GetOpenAction()` / `doc.SetOpenDestination(dest)` / `doc.SetOpenAction(action)` / `doc.RemoveOpenAction()` | The catalog `/OpenAction`: open at a view, or run an action. `GetOpenAction()` returns `{ kind: 'dest' \| 'action' }` |
| `doc.GetJavaScripts()` / `doc.SetJavaScript(name, script)` / `doc.RemoveJavaScript(name)` | Document-level scripts (`/Names /JavaScript`), sorted by name |
```

- [ ] **Step 3: Add the CHANGELOG entries**

As the **first** bullet under `## [Unreleased]` → `### Added`:

```markdown
- **The document's open behaviour and its JavaScript are authorable** — `doc.SetOpenDestination` / `doc.SetOpenAction` / `doc.GetOpenAction` / `doc.RemoveOpenAction` for the catalog `/OpenAction`, and `doc.SetJavaScript` / `doc.GetJavaScripts` / `doc.RemoveJavaScript` for the `/Names /JavaScript` tree. The gap ran one way through the whole stack, as this epic's three previous children did: `pdfavalidate.ts` reports both constructs, `pdfaconvert.ts` and `pdfxconvert.ts` *remove* both as prohibited, and `actions.ts` already modelled a JavaScript action with one encoder and one parser — so `ConvertToPdfA` could confidently report having removed a thing no caller could add. Two writers rather than one, because 32000-1 table 28 permits `/OpenAction` to be a destination **or** an action and the two are not interchangeable; a single sniffing entry point would have had to guess which a caller meant. Reading turns on one rule that is silently wrong when wrong: the discriminator is `/S` and nothing else, since `decodeDest` already accepts a `<< /D [...] >>` destination dict and a GoTo action carries `/D` too — mis-read, it resolves to the **same page**, so only the reported `kind` betrays it, which is why the two dict shapes are asserted side by side on `kind` alone. Underneath, the name-tree upsert and its two-level prune became `nametree.ts` with one owner: the body existed verbatim twice already — `document.ts` for `/Dests`, `embeddedfile.ts` for `/EmbeddedFiles` — and `/JavaScript` would have been the third copy of a pruning rule whose failure mode is a stray `<< /Names << >> >>` in an unrelated feature's output. Only the tree half is shared; the legacy `/Dests` cleanup and the `/AF` registration stay with their callers, because they are not the same step. Document-level structure JavaScript is stored, never interpreted. (`lucg.4`)
```

And under `## [Unreleased]` → `### Fixed` (create the heading if it is absent, ordered after `### Added` as Keep a Changelog specifies):

```markdown
- **A JavaScript action whose `/JS` is a stream is read** — 32000-1 table 217 makes `/JS` a text string **or** a text stream, and `parseActionDict` accepted only the string, so such an action read back as `undefined` **entirely** rather than merely without its script. Reachable from any annotation `/A` and any field `/AA`, not only from the document-level tree — that is simply where it bites hardest, since a large script is exactly what a producer stores as a stream. An undecodable stream still yields `undefined` rather than throwing: this grammar is one of the layers that ignores what it cannot read. (`lucg.4`)
```

- [ ] **Step 4: Run the full suite and the typecheck**

```bash
npm run typecheck
npm test
```

Expected: both green. Pay attention to `test/graphics-identity.test.ts` and `test/docx-flow-identity.test.ts` — no task here touches those paths, so a move there is a surprise worth investigating rather than refreshing.

- [ ] **Step 5: Re-run the new and adjacent files together**

```bash
npx vitest run test/nametree.test.ts test/docaction.test.ts test/docjs.test.ts \
  test/actions.test.ts test/named-destinations.test.ts test/embedded-files.test.ts \
  test/embedded-authoring.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(lucg.4): /OpenAction and document JavaScript in the README and changelog

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-lucg.4
bd export || true
git add .beads/ && git commit -m "chore(lucg.4): sync beads export

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" || true
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Closing `lucg.4` completes the `lucg` epic (Authoring breadth); check whether `bd show aspose-pdf-foss-for-ts-lucg` reports 4/4 and close the epic if the project's convention is to close a parent whose children are all done.

---

## Notes for the executor

**Task 1 is a verbatim move plus two new functions, and that is the change a
green suite is most likely to be mistaken for coverage of.** The evidence it
preserved behaviour is that `test/named-destinations.test.ts`,
`test/embedded-files.test.ts` and `test/embedded-authoring.test.ts` pass with
**no edits**. If any of them needs a change to go green, stop — the extraction
altered behaviour and the question is which, not how to update the assertion.

**The `/S` discriminator and the two-level prune are the two rules that are
silently wrong when wrong.** Both are fenced by a *pair* of cases, and in both
pairs one half stays green under the mutation. That asymmetry is the point; do
not simplify either pair to a single case.

**Do not restate a validation `encodeAction` already owns.** A `goto` page
range and an empty script are checked there. `setOpenDestination` checks its own
page range only because it never builds an action at all.

**Out of scope, per the spec.** Catalog `/AA` — the document-level additional
actions `/WC`, `/WS`, `/DS`, `/WP`, `/DP`; a second trigger vocabulary is its
own decision. Interpreting or validating script text. Balanced name trees:
every branch writes a single flat node, as all three already did.

**Recorded as deliberately unpinned.** `GetOpenAction()` returns `undefined`
both for "absent" and for "present but unmodelled", and no test distinguishes
them because no caller can. The reason is in the doc comment so it reads as a
decision rather than an oversight.
