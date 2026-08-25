# Tagged-content authoring (S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the write side of tagged PDF — build a structure tree, tag authored text/images/vector content with `BDC`/`EMC`+`/MCID`, and tag annotations via `/StructParent`+`OBJR` — so the S1 read model reads the result back.

**Architecture:** A new `src/structwrite.ts` holds the write helpers (idempotent tree/`/ParentTree` setup, MCID allocation, `/K` wiring) — parallel to `structpreserve.ts`. The existing live read handles in `struct.ts` (`StructTreeRoot`, `StructElement`) gain thin write methods that delegate to those helpers. The draw functions (`stamp.ts`, `imageembed.ts`) take an optional `tag` and wrap their body in marked content via a new `pagecontent.wrapMarkedContent`; `graphics.ts` gets `BeginMarkedContent`/`EndMarkedContent`.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { Page } from './page.js'`).
- **Strict TypeScript** — `npm run typecheck` (tsc `--noEmit`) must be green.
- **TDD** — write the failing test first; fixtures via builders in `test/helpers/`.
- **Live-mutation model** — edits act directly on the live object map; `Save()` mark-sweeps from `/Root`+`/Info`. Call `doc.markModified()` from new mutation entry points.
- **PDF naming** — `PdfDict` keys carry no leading `/`; names are `name('X')` tagged objects; text strings are `{ kind: 'string', bytes: encodePdfText(s) }`.
- **Public errors** — throw `PdfParseError`, `UnsupportedFeatureError`, or `InvalidPasswordError` only (see `errors.ts`).
- Run `npm run typecheck` and `npm test` before closing the beads issue `aspose-pdf-foss-for-ts-pjx.3`.

## File Structure

- **Create `src/structwrite.ts`** — write helpers: `ensureStructTree`, `ElemOpts`, `applyElemOpts`, `createElement`, `allocContentMcid`, `tagAnnotation`, `kArray`, plus private `/ParentTree` plumbing. Imports types from `struct.ts` (`StructElement`, `StructTreeRoot`) only as types to avoid a cycle at the value level where possible; the helpers take the live dicts/refs.
- **Modify `src/struct.ts`** — add write methods to `StructTreeRoot` (`Append`, `RegisterRole`) and `StructElement` (`Append`, `NextMcid`, `AddAnnotation`, and `set` accessors for `Alt`/`ActualText`/`Lang`/`Title`/`Expansion`/`ID`).
- **Modify `src/document.ts`** — `CreateStructTree(): StructTreeRoot`, `set Lang(v: string)`.
- **Modify `src/pagecontent.ts`** — `wrapMarkedContent(tag, mcid, body)`.
- **Modify `src/stamp.ts`** — `tag?: StructElement` on `StampOptions` and `TextBlockOptions`; wrap emitted body when set.
- **Modify `src/imageembed.ts`** — `tag?: StructElement` on `AddImageOptions`; wrap when set.
- **Modify `src/graphics.ts`** — `BeginMarkedContent(tag, mcid)`, `EndMarkedContent()`, and expose `page` for `el.NextMcid(gfx.page)`.
- **Modify `src/index.ts`** — export `ElemOpts`.
- **Modify `README.md`** — Features + Limitations.
- **Create `test/struct-write.test.ts`** — all S3 tests. Reuses `test/helpers/build-stamp-target.ts` (`buildStampTarget()` — a plain page) and `test/helpers/build-annot-target.ts` where useful.

### Cyclic-import note

`struct.ts` already imports nothing from `structwrite.ts`. `structwrite.ts` needs the `StructElement`/`StructTreeRoot` **types** and reads their `.Dict`/`.Ref`/`.Root`. Import them with `import type { StructElement, StructTreeRoot } from './struct.js'` (type-only, erased at runtime — no value cycle). The write methods on the classes in `struct.ts` import the helper **functions** from `structwrite.js` (value import). This one-directional value import (`struct.ts` → `structwrite.ts`) is fine.

---

## Task 1: Tree bootstrap — `CreateStructTree`, `set Lang`, `ensureStructTree`

**Files:**
- Create: `src/structwrite.ts`
- Modify: `src/document.ts` (add `CreateStructTree`, `set Lang`)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Produces: `ensureStructTree(doc: Document): { dict: PdfDict; ref: PdfRef }` (idempotent: creates `/StructTreeRoot` with `/K []`, `/ParentTree << /Nums [] >>`, `/ParentTreeNextKey`, sets catalog `/MarkInfo << /Marked true >>`; returns the existing root when present). `Document.CreateStructTree(): StructTreeRoot`. `Document.set Lang(v: string)`.

- [ ] **Step 1: Write the failing test**

Add to a new file `test/struct-write.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isRef, isArray } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('Document.CreateStructTree', () => {
  it('creates a marked struct tree on an untagged doc', () => {
    const doc = Document.Open(buildStampTarget());
    expect(doc.IsTagged).toBe(false);
    const root = doc.CreateStructTree();
    expect(doc.IsTagged).toBe(true);
    expect(root.Children).toEqual([]);
    // round-trips
    const re = Document.Open(doc.Save());
    expect(re.IsTagged).toBe(true);
    expect(re.GetStructTree()).not.toBeNull();
  });

  it('is idempotent (no duplicate root / ParentTree / MarkInfo)', () => {
    const doc = Document.Open(buildStampTarget());
    const a = doc.CreateStructTree();
    const b = doc.CreateStructTree();
    expect(b.Ref!.num).toBe(a.Ref!.num);
    const cat = (doc as any).catalog();
    const mi = doc.resolve(cat.get('MarkInfo'));
    expect(isDict(mi) && doc.resolve(mi.get('Marked'))).toBe(true);
    const pt = doc.resolve(a.Dict.get('ParentTree'));
    expect(isDict(pt) && isArray(doc.resolve((pt as Map<string, any>).get('Nums')))).toBe(true);
  });

  it('sets the document language', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const re = Document.Open(doc.Save());
    expect(re.Lang).toBe('en-US');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — `doc.CreateStructTree is not a function`.

- [ ] **Step 3: Create `src/structwrite.ts` with the bootstrap helpers**

```ts
import type { Document } from './document.js';
import { PdfObject, PdfDict, PdfRef, isDict, isArray, isRef, name } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

const asNum = (o: PdfObject): number | undefined => (typeof o === 'number' ? o : undefined);

/** Largest key in a flat /ParentTree /Nums array ([key,val,key,val,...]); -1 when empty. */
function maxKey(nums: PdfObject[]): number {
  let m = -1;
  for (let i = 0; i < nums.length; i += 2) { const k = asNum(nums[i]); if (k !== undefined && k > m) m = k; }
  return m;
}

/** The live ParentTree dict, creating `<< /Nums [] >>` (+ /ParentTreeNextKey on the
 *  root) when absent. */
export function ensureParentTree(doc: Document, rootDict: PdfDict): PdfDict {
  let pt = doc.resolve(rootDict.get('ParentTree'));
  if (!isDict(pt)) {
    pt = new Map<string, PdfObject>([['Nums', []]]);
    rootDict.set('ParentTree', doc.allocObject(pt));
  }
  if (asNum(doc.resolve(rootDict.get('ParentTreeNextKey'))) === undefined) {
    const nums = doc.resolve((pt as PdfDict).get('Nums'));
    rootDict.set('ParentTreeNextKey', maxKey(isArray(nums) ? nums : []) + 1);
  }
  return pt as PdfDict;
}

/** Ensure the catalog has a /StructTreeRoot (+ /ParentTree, /MarkInfo Marked) and
 *  return its live dict and ref. Idempotent. */
export function ensureStructTree(doc: Document): { dict: PdfDict; ref: PdfRef } {
  const catalog = doc.catalog();
  const existingRef = catalog.get('StructTreeRoot');
  const existing = doc.resolve(existingRef);
  let dict: PdfDict;
  let rootRef: PdfRef;
  if (isDict(existing) && isRef(existingRef)) {
    dict = existing;
    rootRef = existingRef;
  } else {
    dict = new Map<string, PdfObject>([['Type', name('StructTreeRoot')], ['K', []]]);
    rootRef = doc.allocObject(dict);
    catalog.set('StructTreeRoot', rootRef);
  }
  ensureParentTree(doc, dict);
  const mi = doc.resolve(catalog.get('MarkInfo'));
  if (isDict(mi)) mi.set('Marked', true);
  else catalog.set('MarkInfo', new Map<string, PdfObject>([['Marked', true]]));
  doc.markModified();
  return { dict, ref: rootRef };
}
```

(The `UnsupportedFeatureError` import is used by later tasks in this file; if your linter flags it as unused now, add the later helpers in Task 3 first or temporarily reference it — it is needed by Task 3's `parentTreeNums`.)

- [ ] **Step 4: Add `CreateStructTree` and `set Lang` to `src/document.ts`**

Find the existing `GetStructTree()` method (around line 433) and add after it:

```ts
  /** Build (or return the existing) document structure tree, marking the
   *  document Tagged. Idempotent. */
  CreateStructTree(): StructTreeRoot {
    const { dict, ref: rootRef } = ensureStructTree(this);
    return new StructTreeRoot(this, dict, rootRef);
  }
```

Find the `get Lang()` accessor (around line 447) and add a setter directly after it:

```ts
  /** Set the document default language (catalog /Lang), e.g. 'en-US'. */
  set Lang(v: string) {
    this.catalog().set('Lang', { kind: 'string', bytes: encodePdfText(v) });
    this.markModified();
  }
```

Add the imports at the top of `document.ts` (merge into existing import groups):

```ts
import { ensureStructTree } from './structwrite.js';
```

`encodePdfText` is already imported in `document.ts` (used by metadata); confirm with a grep — if absent, add `import { encodePdfText } from './metadata.js';` (it already imports `decodePdfText` from there, so extend that line).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS (3 tests).
Then `npm run typecheck` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/structwrite.ts src/document.ts test/struct-write.test.ts
git commit -m "feat(struct): CreateStructTree + document Lang setter (S3)"
```

---

## Task 2: Tree write API — `Append`, setters, `RegisterRole`

**Files:**
- Modify: `src/structwrite.ts` (add `ElemOpts`, `applyElemOpts`, `createElement`, `kArray`)
- Modify: `src/struct.ts` (add `StructTreeRoot.Append`/`RegisterRole`, `StructElement.Append` + setters)
- Modify: `src/index.ts` (export `ElemOpts`)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `ensureStructTree` (Task 1).
- Produces:
  - `interface ElemOpts { alt?; actualText?; lang?; title?; expansion?; id?: string }`
  - `kArray(doc: Document, dict: PdfDict): PdfObject[]` — ensures `/K` is a live array, returns it.
  - `applyElemOpts(dict: PdfDict, opts?: ElemOpts): void`
  - `createElement(doc, type: string, parentRef: PdfRef, parentK: PdfObject[], opts?: ElemOpts): { dict: PdfDict; ref: PdfRef }`
  - `StructTreeRoot.Append(type, opts?): StructElement`, `StructTreeRoot.RegisterRole(custom, standard): void`
  - `StructElement.Append(type, opts?): StructElement`, plus `set Alt/ActualText/Lang/Title/Expansion/ID`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`:

```ts
describe('struct tree write API', () => {
  it('builds a tree and round-trips element properties through S1', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const sect = root.Append('Sect', { title: 'Body' });
    const h1 = sect.Append('H1', { lang: 'en-GB' });
    h1.Alt = 'Heading one';
    sect.Append('P');

    const re = Document.Open(doc.Save());
    const rroot = re.GetStructTree()!;
    expect(rroot.Children.map((c) => c.Type)).toEqual(['Sect']);
    const rsect = rroot.Children[0];
    expect(rsect.Title).toBe('Body');
    expect(rsect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
    const rh1 = rsect.Children[0];
    expect(rh1.Alt).toBe('Heading one');
    expect(rh1.Lang).toBe('en-GB');
    expect(rh1.Parent!.Type).toBe('Sect');
  });

  it('registers a custom role resolved through RoleMap', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    const e = root.Append('Subtitle');
    const re = Document.Open(doc.Save());
    const rroot = re.GetStructTree()!;
    const re0 = rroot.Children[0];
    expect(re0.Type).toBe('Subtitle');
    expect(re0.StandardType).toBe('P');
    expect(re0.IsStandardType).toBe(true);
  });

  it('clears a property when set to undefined', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const e = root.Append('P', { alt: 'x' });
    e.Alt = undefined;
    expect(e.Alt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — `root.Append is not a function`.

- [ ] **Step 3: Add element-construction helpers to `src/structwrite.ts`**

```ts
import { encodePdfText } from './metadata.js';

/** Options for creating a structure element. */
export interface ElemOpts {
  alt?: string;
  actualText?: string;
  lang?: string;
  title?: string;
  expansion?: string;
  id?: string;
}

/** ElemOpts field -> PDF dict key. */
const OPT_KEYS: ReadonlyArray<[keyof ElemOpts, string]> = [
  ['alt', 'Alt'], ['actualText', 'ActualText'], ['lang', 'Lang'],
  ['title', 'T'], ['expansion', 'E'], ['id', 'ID'],
];

/** Write the given ElemOpts onto a struct-element dict as PDF text strings. */
export function applyElemOpts(dict: PdfDict, opts?: ElemOpts): void {
  if (!opts) return;
  for (const [field, key] of OPT_KEYS) {
    const v = opts[field];
    if (v !== undefined) dict.set(key, { kind: 'string', bytes: encodePdfText(v) });
  }
}

/** Ensure `dict`'s /K is a live array (wrapping a single existing entry) and
 *  return it. Works whether /K was absent, a single item, or a (ref-to-)array. */
export function kArray(doc: Document, dict: PdfDict): PdfObject[] {
  const raw = dict.get('K');
  const resolved = doc.resolve(raw);
  if (isArray(resolved)) return resolved; // live; mutations persist (same object)
  const arr: PdfObject[] = raw === undefined ? [] : [raw];
  dict.set('K', arr);
  return arr;
}

/** Allocate a new /StructElem under `parentRef`, append its ref to `parentK`,
 *  apply `opts`, and return the live dict + ref. */
export function createElement(
  doc: Document, type: string, parentRef: PdfRef, parentK: PdfObject[], opts?: ElemOpts,
): { dict: PdfDict; ref: PdfRef } {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('StructElem')],
    ['S', name(type)],
    ['P', parentRef],
    ['K', []],
  ]);
  applyElemOpts(dict, opts);
  const r = doc.allocObject(dict);
  parentK.push(r);
  doc.markModified();
  return { dict, ref: r };
}
```

- [ ] **Step 4: Add write methods to `StructTreeRoot` in `src/struct.ts`**

At the top of `struct.ts`, extend the `types.js` import to include `name` and add the helper import:

```ts
import {
  PdfObject, PdfDict, PdfRef, isDict, isRef, isName, isArray, isString, name,
} from './types.js';
import {
  ElemOpts, applyElemOpts, createElement, kArray, allocContentMcid, tagAnnotation,
} from './structwrite.js';
```

(`allocContentMcid`/`tagAnnotation` are added in later tasks — importing them now is fine as long as Task 3/7 land before running; if you implement strictly task-by-task, import only what each task needs and widen the import as you go.)

Inside `class StructTreeRoot`, after `GetText()`:

```ts
  /** Create a top-level structure element of `type` and return its handle. */
  Append(type: string, opts?: ElemOpts): StructElement {
    if (this.Ref === undefined) throw new Error('StructTreeRoot has no ref');
    const k = kArray(this.doc, this.Dict);
    const { dict, ref: r } = createElement(this.doc, type, this.Ref, k, opts);
    this.RoleMap; // no-op; keep field warm
    return new StructElement(this.doc, dict, r, this);
  }

  /** Map a custom structure type `custom` to a standard type `standard` in the
   *  /RoleMap (writes the dict and updates the in-memory map). */
  RegisterRole(custom: string, standard: string): void {
    let rm = this.doc.resolve(this.Dict.get('RoleMap'));
    if (!isDict(rm)) { rm = new Map<string, PdfObject>(); this.Dict.set('RoleMap', rm); }
    (rm as PdfDict).set(custom, name(standard));
    this.RoleMap.set(custom, standard);
    this.doc.markModified();
  }
```

Remove the `this.RoleMap; // no-op` line — it was a placeholder; the real `Append` body is just the three lines (`if`, `kArray`, `createElement`, `return`). Final `Append`:

```ts
  Append(type: string, opts?: ElemOpts): StructElement {
    if (this.Ref === undefined) throw new Error('StructTreeRoot has no ref');
    const k = kArray(this.doc, this.Dict);
    const { dict, ref: r } = createElement(this.doc, type, this.Ref, k, opts);
    return new StructElement(this.doc, dict, r, this);
  }
```

- [ ] **Step 5: Add `Append` + setters to `StructElement` in `src/struct.ts`**

Inside `class StructElement`, after `GetText()`:

```ts
  /** Create a child structure element of `type` under this one; returns its handle. */
  Append(type: string, opts?: ElemOpts): StructElement {
    if (this.Ref === undefined) throw new Error('cannot append to an element with no ref');
    const k = kArray(this.doc, this.Dict);
    const { dict, ref: r } = createElement(this.doc, type, this.Ref, k, opts);
    return new StructElement(this.doc, dict, r, this.Root);
  }

  private setText(key: string, v: string | undefined): void {
    if (v === undefined) this.Dict.delete(key);
    else this.Dict.set(key, { kind: 'string', bytes: encodePdfText(v) });
    this.doc.markModified();
  }

  set Alt(v: string | undefined) { this.setText('Alt', v); }
  set ActualText(v: string | undefined) { this.setText('ActualText', v); }
  set Lang(v: string | undefined) { this.setText('Lang', v); }
  set Title(v: string | undefined) { this.setText('T', v); }
  set Expansion(v: string | undefined) { this.setText('E', v); }
  set ID(v: string | undefined) { this.setText('ID', v); }
```

Add `encodePdfText` to the existing `metadata.js` import in `struct.ts` (it currently imports `decodePdfText`):

```ts
import { decodePdfText, encodePdfText } from './metadata.js';
```

Note: adding a `set` accessor to an existing `get` (e.g. `get Alt()`) is valid TypeScript as long as both live in the same class body — they already do.

- [ ] **Step 6: Export `ElemOpts` from `src/index.ts`**

Find the line that re-exports from `./struct.js` and add `ElemOpts` from `./structwrite.js`:

```ts
export type { ElemOpts } from './structwrite.js';
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS (Task 1 + Task 2 tests).
Run: `npm run typecheck` — clean.

- [ ] **Step 8: Commit**

```bash
git add src/structwrite.ts src/struct.ts src/index.ts test/struct-write.test.ts
git commit -m "feat(struct): tree write API — Append, setters, RegisterRole (S3)"
```

---

## Task 3: Marked-content primitives — `NextMcid` + `wrapMarkedContent`

**Files:**
- Modify: `src/structwrite.ts` (add `parentTreeNums`, `takeNextKey`, `pageMcidArray`, `appendContentKid`, `allocContentMcid`)
- Modify: `src/struct.ts` (add `StructElement.NextMcid`)
- Modify: `src/pagecontent.ts` (add `wrapMarkedContent`)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `ensureParentTree`, `kArray` (Tasks 1–2); `Document.pageRef(page1Based): PdfRef` (existing, document.ts:488).
- Produces:
  - `allocContentMcid(doc, element: StructElement, page: Page): number` — ensures the page has a `/StructParents` key + ParentTree array, appends `element.Ref` at index `mcid`, wires the element's `/K` (integer MCID + `/Pg`, or `MCR` once content spans pages), returns the MCID.
  - `StructElement.NextMcid(page: Page): number` — thin wrapper over `allocContentMcid`.
  - `wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array` — returns `/<tag> << /MCID n >> BDC\n` + body + `\nEMC`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`:

```ts
import { isName } from '../src/types.js';

describe('low-level marked content (NextMcid)', () => {
  it('allocates an MCID, wires ParentTree + /K, and resolves via ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    const mcid = p.NextMcid(page);
    expect(mcid).toBe(0);

    const re = Document.Open(doc.Save());
    const rpage = re.Pages[0];
    const spKey = re.resolve(rpage.Dict.get('StructParents')) as number;
    expect(typeof spKey).toBe('number');
    const found = re.GetStructTree()!.ElementFor(spKey, 0);
    expect(found!.Type).toBe('P');
  });

  it('increments MCID per page and sets the element /Pg', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    expect(p.NextMcid(page)).toBe(0);
    expect(p.NextMcid(page)).toBe(1);
    // /Pg set to the page; /K holds integers 0,1
    const pg = p.Dict.get('Pg');
    expect(pg && (pg as any).num).toBe(re_pageNum(doc, page));
    const k = doc.resolve(p.Dict.get('K')) as any[];
    expect(k).toEqual([0, 1]);
  });
});

// helper: the page's object number for the assertion above
function re_pageNum(doc: Document, page: import('../src/page.js').Page): number {
  return (doc as any).pageRef(page.Number).num;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — `p.NextMcid is not a function`.

- [ ] **Step 3: Add the content-MCID helpers to `src/structwrite.ts`**

```ts
import type { Page } from './page.js';
import type { StructElement } from './struct.js';

/** The live ParentTree /Nums array. Throws for a /Kids-based number tree
 *  (authoring supports only a flat /Nums). */
function parentTreeNums(doc: Document, rootDict: PdfDict): PdfObject[] {
  const pt = ensureParentTree(doc, rootDict);
  const nums = doc.resolve(pt.get('Nums'));
  if (isArray(nums)) return nums;
  if (pt.has('Kids'))
    throw new UnsupportedFeatureError('authoring into a /Kids-based /ParentTree is not supported');
  const arr: PdfObject[] = [];
  pt.set('Nums', arr);
  return arr;
}

/** Read and post-increment the root's /ParentTreeNextKey. */
function takeNextKey(doc: Document, rootDict: PdfDict): number {
  ensureParentTree(doc, rootDict); // guarantees /ParentTreeNextKey exists
  const cur = asNum(doc.resolve(rootDict.get('ParentTreeNextKey')))!;
  rootDict.set('ParentTreeNextKey', cur + 1);
  return cur;
}

/** The page's MCID->element array in the ParentTree, creating it (and the page's
 *  /StructParents key) when absent. Returned live so callers can append. */
function pageMcidArray(doc: Document, rootDict: PdfDict, page: Page): PdfObject[] {
  const nums = parentTreeNums(doc, rootDict);
  const existing = asNum(doc.resolve(page.Dict.get('StructParents')));
  if (existing !== undefined) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (asNum(doc.resolve(nums[i])) === existing) {
        const arr = doc.resolve(nums[i + 1]);
        if (isArray(arr)) return arr;
      }
    }
  }
  const key = takeNextKey(doc, rootDict);
  page.Dict.set('StructParents', key);
  const arr: PdfObject[] = [];
  nums.push(key, arr);
  return arr;
}

/** Append a content reference to an element's /K following the /Pg rule:
 *  integer MCID + element /Pg while content stays on one page; an MCR dict once a
 *  second page contributes. */
function appendContentKid(doc: Document, elemDict: PdfDict, mcid: number, pageRef: PdfRef): void {
  const k = kArray(doc, elemDict);
  const pg = elemDict.get('Pg');
  if (pg === undefined) {
    elemDict.set('Pg', pageRef);
    k.push(mcid);
  } else if (isRef(pg) && pg.num === pageRef.num) {
    k.push(mcid);
  } else {
    k.push(new Map<string, PdfObject>([['Type', name('MCR')], ['Pg', pageRef], ['MCID', mcid]]));
  }
}

/** Allocate the next MCID for `page` against `element`: wires ParentTree and the
 *  element's /K, returns the MCID. */
export function allocContentMcid(doc: Document, element: StructElement, page: Page): number {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag content to an element with no ref');
  const arr = pageMcidArray(doc, element.Root.Dict, page);
  const mcid = arr.length;
  arr.push(elemRef);
  appendContentKid(doc, element.Dict, mcid, doc.pageRef(page.Number));
  doc.markModified();
  return mcid;
}
```

- [ ] **Step 4: Add `NextMcid` to `StructElement` in `src/struct.ts`**

Inside `class StructElement`, after the setters from Task 2:

```ts
  /** Allocate the next MCID for `page` against this element and wire the
   *  /ParentTree + /K. Returns the MCID — emit `/<Type> << /MCID n >> BDC … EMC`
   *  around the marked content yourself (escape hatch for hand-built content). */
  NextMcid(page: Page): number {
    return allocContentMcid(this.doc, this, page);
  }
```

Add `Page` as a type import in `struct.ts` if not already present (it imports `type { Page }` already — confirm at the top; line 2 imports `import type { Page } from './page.js';`).

- [ ] **Step 5: Add `wrapMarkedContent` to `src/pagecontent.ts`**

```ts
import { escapeName } from './serialize.js';

/** Wrap a content-stream body in a marked-content sequence carrying an /MCID:
 *  `/<tag> << /MCID n >> BDC` … body … `EMC`. */
export function wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array {
  const head = enc(`/${escapeName(tag)} <</MCID ${mcid}>> BDC\n`);
  const tail = enc('\nEMC');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}
```

(`enc` is already imported in `pagecontent.ts`; `escapeName` lives in `serialize.ts`.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/structwrite.ts src/struct.ts src/pagecontent.ts test/struct-write.test.ts
git commit -m "feat(struct): NextMcid + wrapMarkedContent marked-content primitives (S3)"
```

---

## Task 4: Tag-aware `AddText` / `AddTextBlock`

**Files:**
- Modify: `src/stamp.ts` (`tag?: StructElement` on `StampOptions` + `TextBlockOptions`; wrap body)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `allocContentMcid` (Task 3), `wrapMarkedContent` (Task 3), `StructElement` type (struct.ts).
- Produces: `StampOptions.tag?: StructElement`, `TextBlockOptions.tag?: StructElement`. When set, the emitted body is wrapped in `/<element.Type> << /MCID n >> BDC … EMC` and the element's `/K`/`/ParentTree` are wired. `AddTextBlock` emits one MCID for the whole block.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`:

```ts
describe('tag-aware AddText / AddTextBlock', () => {
  it('round-trips tagged text into reading-order GetText + ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const sect = root.Append('Sect');
    const h1 = sect.Append('H1');
    page.AddText('Title', 72, 700, { tag: h1 });
    const p = sect.Append('P');
    page.AddTextBlock('Body text here.', [72, 600, 400, 80], { tag: p });

    const re = Document.Open(doc.Save());
    const rroot = re.GetStructTree()!;
    expect(rroot.GetText()).toContain('Title');
    expect(rroot.GetText()).toContain('Body text here.');
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    expect(re.GetStructTree()!.ElementFor(spKey, 0)!.Type).toBe('H1');
    expect(re.GetStructTree()!.ElementFor(spKey, 1)!.Type).toBe('P');
  });

  it('emits a BDC/EMC pair around the tagged body', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const h = doc.CreateStructTree().Append('H2');
    page.AddText('X', 72, 700, { tag: h });
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/H2 <</MCID 0>> BDC');
    expect(content).toContain('EMC');
  });

  it('uses MCR entries when one element spans two pages', () => {
    const doc = Document.Open(buildStampTarget());
    // ensure two pages
    if (doc.Pages.length < 2) doc.AddPage(doc.Pages[0]);
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    doc.Pages[0].AddText('one', 72, 700, { tag: p });
    doc.Pages[1].AddText('two', 72, 700, { tag: p });
    const k = doc.resolve(p.Dict.get('K')) as any[];
    expect(k[0]).toBe(0);                       // first page: integer MCID
    expect(isName((k[1] as Map<string, any>).get('Type'))).toBe(true); // second: MCR dict
    expect(((k[1] as Map<string, any>).get('Type') as any).name).toBe('MCR');
  });
});
```

(If `Document.AddPage` is not the right helper for adding a second page in your tree, use the existing multi-page tagged builder pattern or `buildStampTarget`-style two-page fixture; the assertion is on the `/K` shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — content lacks `BDC`; `tag` not honored (TS error on unknown option until Step 3).

- [ ] **Step 3: Add `tag` to options and wrap the body in `src/stamp.ts`**

At the top of `stamp.ts`, extend imports:

```ts
import type { StructElement } from './struct.js';
import { allocContentMcid } from './structwrite.js';
import {
  num, freshKey, ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent,
  wrapMarkedContent,
} from './pagecontent.js';
```

Add `tag` to `StampOptions` (after `align`):

```ts
  /** When set, wrap this text in a marked-content sequence and attach it to the
   *  given structure element (emits `/<type> << /MCID n >> BDC … EMC`). */
  tag?: StructElement;
```

Add the same field to `TextBlockOptions` (it `extends Omit<StampOptions, 'align' | 'rotate'>`, so `tag` is inherited automatically — no edit needed there).

In `stampText`, replace the final `appendContent(...)` call:

```ts
  const body = buildStampBody(bytes, x, y, o, fontKey, width, gsKey);
  const tagged = options.tag
    ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
    : body;
  appendContent(doc, page, tagged);
```

In `stampTextBlock`, replace the `appendContent` inside the `if (lines.length > 0)` block:

```ts
  if (lines.length > 0) {
    const fontKey = registerFont(doc, page, o.font);
    const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
    const body = buildBlockBody(lines, x, y, w, h, o, fontKey, gsKey);
    const tagged = options.tag
      ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
      : body;
    appendContent(doc, page, tagged);
  }
```

Note: `normalizeOptions`/`normalizeBlockOptions` strip `tag`; reference `options.tag` (the raw argument) directly as shown. `tag` needs no validation beyond being a `StructElement` (a wrong-document element is documented as undefined behavior).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS.
Run: `npx vitest run test/stamp.test.ts` (or the text-stamping test) — expected: still PASS (no regression for untagged draws).
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/stamp.ts test/struct-write.test.ts
git commit -m "feat(struct): tag-aware AddText/AddTextBlock emitting BDC/EMC (S3)"
```

---

## Task 5: Tag-aware `AddImage`

**Files:**
- Modify: `src/imageembed.ts` (`tag?: StructElement` on `AddImageOptions`; wrap body)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `allocContentMcid`, `wrapMarkedContent`, `StructElement`.
- Produces: `AddImageOptions.tag?: StructElement`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`. Use the existing image bytes helper:

```ts
import { tinyPng } from './helpers/build-embed-images.js';

describe('tag-aware AddImage', () => {
  it('tags an image as a Figure with /Alt and resolves via ElementFor', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const fig = root.Append('Figure', { alt: 'A red dot' });
    page.AddImage(tinyPng(), [72, 500, 64, 64], { tag: fig });

    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/Figure <</MCID 0>> BDC');

    const re = Document.Open(doc.Save());
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    const found = re.GetStructTree()!.ElementFor(spKey, 0)!;
    expect(found.Type).toBe('Figure');
    expect(found.Alt).toBe('A red dot');
  });
});
```

(Check `test/helpers/build-embed-images.js` for the actual exported PNG-bytes function name — adjust `tinyPng` to whatever it exports, e.g. a `pngBytes`/`redDotPng` helper. If none returns raw bytes, inline a minimal PNG the way `build-image-pdf.ts` does.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — TS error on unknown `tag` option / no `BDC` in content.

- [ ] **Step 3: Add `tag` and wrap in `src/imageembed.ts`**

Extend imports:

```ts
import type { StructElement } from './struct.js';
import { allocContentMcid } from './structwrite.js';
import {
  ensureOwnResources, ensureOwnSubdict, registerExtGState, appendContent, freshKey, num,
  wrapMarkedContent,
} from './pagecontent.js';
```

Add to `AddImageOptions`:

```ts
  /** When set, wrap the image draw in a marked-content sequence and attach it to
   *  the given structure element (typically a `Figure` with `/Alt`). */
  tag?: StructElement;
```

In `addImage`, replace the final `appendContent(doc, page, enc(s));`:

```ts
  const body = enc(s);
  const tagged = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : body;
  appendContent(doc, page, tagged);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Run: `npx vitest run test/embed-images.test.ts` (or whichever exercises AddImage) — no regression.
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts test/struct-write.test.ts
git commit -m "feat(struct): tag-aware AddImage (Figure marked content) (S3)"
```

---

## Task 6: `PageGraphics` marked-content ops

**Files:**
- Modify: `src/graphics.ts` (`BeginMarkedContent`, `EndMarkedContent`; expose `page`)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `escapeName` (serialize.ts).
- Produces: `PageGraphics.BeginMarkedContent(tag: string, mcid: number): this`, `PageGraphics.EndMarkedContent(): this`, `PageGraphics.page` (the bound `Page`, for `el.NextMcid(gfx.page)`).

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`:

```ts
describe('PageGraphics marked content', () => {
  it('marks vector content with an MCID that resolves to its element', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const fig = root.Append('Figure', { alt: 'box' });

    const gfx = page.Graphics();
    const mcid = fig.NextMcid(gfx.page);
    gfx.BeginMarkedContent(fig.Type, mcid)
       .setFillColor([1, 0, 0]).drawRect(72, 400, 50, 50).fill()
       .EndMarkedContent();
    gfx.apply();

    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/Figure <</MCID 0>> BDC');
    expect(content).toContain('EMC');

    const re = Document.Open(doc.Save());
    const spKey = re.resolve(re.Pages[0].Dict.get('StructParents')) as number;
    expect(re.GetStructTree()!.ElementFor(spKey, 0)!.Type).toBe('Figure');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — `gfx.BeginMarkedContent is not a function` / `gfx.page` undefined.

- [ ] **Step 3: Implement in `src/graphics.ts`**

Change the constructor parameter for `page` from `private readonly` to `readonly` so it is accessible, and add `escapeName` to imports:

```ts
import { num, appendContent, registerExtGState } from './pagecontent.js';
import { escapeName } from './serialize.js';
```

Constructor:

```ts
  constructor(private readonly doc: Document, readonly page: Page) {}
```

Add a new section (e.g. after the `// ---- nesting & transform ----` block):

```ts
  // ---- marked content (tagged PDF) ----
  /** Begin a marked-content sequence carrying an /MCID. Pair with
   *  {@link EndMarkedContent}. Obtain `mcid` from `element.NextMcid(this.page)`. */
  BeginMarkedContent(tag: string, mcid: number): this {
    return this.op(`/${escapeName(tag)} <</MCID ${mcid}>> BDC`);
  }

  /** End the most recent marked-content sequence. */
  EndMarkedContent(): this {
    return this.op('EMC');
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Run: `npx vitest run test/graphics.test.ts` (or whichever exercises PageGraphics) — no regression.
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/graphics.ts test/struct-write.test.ts
git commit -m "feat(struct): PageGraphics BeginMarkedContent/EndMarkedContent (S3)"
```

---

## Task 7: Tag annotations — `StructElement.AddAnnotation`

**Files:**
- Modify: `src/structwrite.ts` (add `tagAnnotation`)
- Modify: `src/struct.ts` (add `StructElement.AddAnnotation`)
- Test: `test/struct-write.test.ts`

**Interfaces:**
- Consumes: `parentTreeNums`/`takeNextKey`/`kArray` (Task 3 internals), `Document.pageForRef`, `Document.pageRef`.
- Produces:
  - `tagAnnotation(doc, element: StructElement, annot: Annotation): void` — derives the page from the annotation's `/P`, finds/promotes the annotation's ref in the page `/Annots`, allocates an object `/StructParent` key, sets `ParentTree[key] = element.Ref`, and appends an `OBJR` dict to the element's `/K`.
  - `StructElement.AddAnnotation(annotation: Annotation): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-write.test.ts`:

```ts
import { buildAnnotTarget } from './helpers/build-annot-target.js';

describe('tag annotations (OBJR / StructParent)', () => {
  it('round-trips a tagged Link via ElementForObject', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const link = root.Append('Link');
    const annot = page.AddLink({ rect: [72, 700, 200, 720], uri: 'https://example.com' });
    link.AddAnnotation(annot);

    // OBJR appended to the element's /K
    const k = doc.resolve(link.Dict.get('K')) as any[];
    expect((k[k.length - 1] as Map<string, any>).get('Type')).toBeTruthy();

    const re = Document.Open(doc.Save());
    const rpage = re.Pages[0];
    // find the link annot's /StructParent and resolve the element
    const annots = re.resolve(rpage.Dict.get('Annots')) as any[];
    let spKey: number | undefined;
    for (const a of annots) {
      const d = re.resolve(a);
      const sp = re.resolve((d as Map<string, any>).get('StructParent'));
      if (typeof sp === 'number') spKey = sp;
    }
    expect(spKey).toBeDefined();
    expect(re.GetStructTree()!.ElementForObject(spKey!)!.Type).toBe('Link');
  });
});
```

(Confirm `buildAnnotTarget` exports the expected name and `AddLink`'s options shape — adjust `{ rect, uri }` to match `LinkOptions` in `annotation.ts` if it differs, e.g. `{ Rect, action: { uri } }`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-write.test.ts`
Expected: FAIL — `link.AddAnnotation is not a function`.

- [ ] **Step 3: Add `tagAnnotation` to `src/structwrite.ts`**

```ts
import type { Annotation } from './annotation.js';

/** Tag an annotation object: allocate an object /StructParent key, set
 *  ParentTree[key] = element ref, and append an OBJR to the element's /K. The
 *  page is derived from the annotation's /P. */
export function tagAnnotation(doc: Document, element: StructElement, annot: Annotation): void {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag an annotation to an element with no ref');
  const pRef = annot.Dict.get('P');
  const page = isRef(pRef) ? doc.pageForRef(pRef) : undefined;
  if (!page) throw new UnsupportedFeatureError('annotation has no page (/P) to tag against');

  // Find (and promote to indirect if needed) the annotation's ref in /Annots.
  const annots = doc.resolve(page.Dict.get('Annots'));
  let annotRef: PdfRef | undefined;
  if (isArray(annots)) {
    for (let i = 0; i < annots.length; i++) {
      if (doc.resolve(annots[i]) === annot.Dict) {
        annotRef = isRef(annots[i]) ? (annots[i] as PdfRef) : doc.allocObject(annot.Dict);
        if (!isRef(annots[i])) annots[i] = annotRef;
        break;
      }
    }
  }
  if (annotRef === undefined) throw new UnsupportedFeatureError('annotation is not on its page /Annots');

  const nums = parentTreeNums(doc, element.Root.Dict);
  const key = takeNextKey(doc, element.Root.Dict);
  annot.Dict.set('StructParent', key);
  nums.push(key, elemRef);
  const k = kArray(doc, element.Dict);
  k.push(new Map<string, PdfObject>([
    ['Type', name('OBJR')], ['Pg', doc.pageRef(page.Number)], ['Obj', annotRef],
  ]));
  doc.markModified();
}
```

- [ ] **Step 4: Add `AddAnnotation` to `StructElement` in `src/struct.ts`**

Add the type import at the top of `struct.ts`:

```ts
import type { Annotation } from './annotation.js';
```

Widen the `structwrite.js` import to include `tagAnnotation` (already listed in Task 2's import block). Inside `class StructElement`, after `NextMcid`:

```ts
  /** Tag an annotation (e.g. a Link) under this element via /StructParent + OBJR.
   *  The annotation must already be added to its page. */
  AddAnnotation(annotation: Annotation): void {
    tagAnnotation(this.doc, this, annotation);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/struct-write.test.ts`
Expected: PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/structwrite.ts src/struct.ts test/struct-write.test.ts
git commit -m "feat(struct): tag annotations via AddAnnotation (OBJR/StructParent) (S3)"
```

---

## Task 8: Docs, full suite, and close

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Update `README.md`**

In the Features list, add a bullet near the existing tagged-PDF / structure read entry:

```markdown
- **Tagged-content authoring** — build a structure tree (`Document.CreateStructTree`,
  `StructElement.Append`, accessibility setters, `RegisterRole`), tag authored
  text/images with `BDC`/`EMC`+`/MCID` (`AddText`/`AddTextBlock`/`AddImage` `tag`
  option), tag annotations (`StructElement.AddAnnotation`), and mark hand-built
  vector content (`StructElement.NextMcid` + `PageGraphics.BeginMarkedContent`).
```

In Limitations, add:

```markdown
- Tagged-content authoring tags the content you author; it does not auto-tag
  pre-existing untagged content. Authoring into a `/ParentTree` that uses an
  intermediate `/Kids` number tree (very large imported tagged PDFs) is not
  supported — `CreateStructTree`-built trees use a flat `/Nums`.
```

- [ ] **Step 2: Run the full quality gates**

Run: `npm run typecheck`
Expected: clean.
Run: `npm test`
Expected: all green (existing suite + `test/struct-write.test.ts`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: tagged-content authoring (S3)"
```

- [ ] **Step 4: Close the beads issue**

```bash
bd close aspose-pdf-foss-for-ts-pjx.3
```

Then follow the CLAUDE.md session-completion workflow (file follow-ups, push to remote).

---

## Self-Review

**Spec coverage:**

- *CreateStructTree (idempotent, MarkInfo, ParentTree)* → Task 1. ✅
- *`set Lang`* → Task 1. ✅
- *Tree write API: `Append`, setters, `RegisterRole`, `ElemOpts`* → Task 2. ✅
- *Marked-content emission + ParentTree/`/K` wiring + `/Pg`-vs-`MCR` rule* → Task 3 (`allocContentMcid`, `appendContentKid`) + tested in Task 4. ✅
- *Tag-aware AddText / AddTextBlock (one MCID per block)* → Task 4. ✅
- *Tag-aware AddImage (Figure + Alt)* → Task 5. ✅
- *Low-level escape hatch: `NextMcid` + PageGraphics BDC/EMC* → Tasks 3 + 6. ✅
- *Annotations via `AddAnnotation` (OBJR/StructParent)* → Task 7. ✅
- *Edge cases:* idempotency (T1), page already has `/StructParents` reuse (`pageMcidArray`, T3), next-MCID via array length (T3), cross-page MCR (T4), empty/all-unencodable text no-ops (existing `stampText`/`stampTextBlock` early-returns precede tag handling — no MCID allocated). ✅
- *Serialization unchanged* → no serializer task; plain dicts/arrays. ✅
- *Docs + index export* → Task 8 + Task 2 (`ElemOpts`). ✅

**Type consistency:** `allocContentMcid(doc, element, page)`, `tagAnnotation(doc, element, annot)`, `wrapMarkedContent(tag, mcid, body)`, `createElement(doc, type, parentRef, parentK, opts)`, `ElemOpts` keys (`alt/actualText/lang/title/expansion/id` → `Alt/ActualText/Lang/T/E/ID`) are used identically across `structwrite.ts`, `struct.ts`, `stamp.ts`, `imageembed.ts`, `graphics.ts`. `StructElement.Type` (raw `/S`) is the BDC tag in all three draw paths. ✅

**Placeholder scan:** No TBD/TODO. Two spots ask the implementer to confirm an existing helper's exact export/option name (`build-embed-images` PNG bytes in T5; `buildAnnotTarget`/`LinkOptions` shape in T7) before use — these are verification notes, not unfilled implementation. ✅

**Known follow-ups (file as issues if hit):** authoring into a `/Kids`-based `/ParentTree` throws `UnsupportedFeatureError` by design (documented limitation).
