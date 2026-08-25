# In-Memory PDF Object Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the file-backed (incremental-update) PDF engine with a single in-memory object model where `Open` eagerly parses everything into a live `Map<number, PdfObject>`, every mutation writes directly into that map, and `Save` mark-sweeps + renumbers it to bytes.

**Architecture:** `Document` owns one live `objects` map and one live `trailer`, both fully populated at `Open`. Mutations (`SetMetadata`, `ClearMetadata`, `Reorder`, `Page.Rotate` setter) write straight into those structures. A new `serializer.ts` walks reachable-from-`/Root` objects, renumbers them `1..N`, and emits a classic xref PDF. The old `built` mode, lazy cache, `writer.ts`, and `incremental.ts` are deleted.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node 20. Build: `npm run typecheck`; tests: `npm test`.

---

## Approach notes (read before starting)

- **Keep the suite green at every commit.** The cutover from the old deferred/incremental save to the new serializer is coupled to making mutations live. We sequence so that each task either is additive or converts one concern while preserving `save()` behavior, then a single cutover (Task 6) flips the save path.
- **Interim scaffolding** (the `buf`, `synthetic`, `rootNum` fields and the old `save()` body) is intentionally retained through Tasks 1–5 and removed in Task 6. This is throwaway by design — it is what keeps each intermediate commit green.
- **Scratch dirs:** never `git add -A`. Stage only `src`, `test`, `docs`. Oleg keeps scratch notes/screenshots in `_my/`.
- Run the **full** suite (`npm test`) at the end of every task, not just the new test — this is a big-bang core rewrite and regressions surface in sibling tests.

## File Structure

| File | Responsibility after this plan |
|------|--------------------------------|
| `src/document.ts` | Eager parse in `Open`; live `objects` + `trailer`; live metadata/reorder; `Save` / `WriteTo`; delegates serialization to `serializer.ts` |
| `src/serializer.ts` | **New.** `serializeDocument(objects, trailer)`: mark-sweep from `/Root`(+`/Info`), renumber `1..N`, emit classic xref PDF |
| `src/page.ts` | Live dict reference; dynamic `/Parent`-chain inheritance; `Rotate` setter |
| `src/pagetree.ts` | `buildPages` records live dicts + object numbers; no materialize-copy |
| `src/extractor.ts` | Unchanged logic; output seeds an ordinary `Document` |
| `src/serialize.ts` | Unchanged; low-level value/stream serialization reused by `serializer.ts` |
| `src/metadata.ts` | Unchanged; operates on the live `/Info` |
| `src/node.ts` | Delegates to `Save` / `WriteTo` |
| `src/index.ts` | Unchanged exports (Save/WriteTo are methods on the already-exported `Document`) |
| `src/writer.ts` | **Deleted** |
| `src/incremental.ts` | **Deleted** |

---

## Task 1: Eager parse in `Open`

Replace lazy materialization with a single eager parse into a live `objects` map. Keep the old `save()` working (it still uses `buf` + a `synthetic` flag) so the suite stays green.

**Files:**
- Modify: `src/document.ts`
- Test: `test/document.test.ts`, `test/objstm.test.ts` (existing — must stay green), `test/xref-stream.test.ts` (existing — must stay green)

- [ ] **Step 1: Add a failing test that object-stream contents are top-level after Open**

Add to `test/document.test.ts` inside a new `describe`:

```ts
import { buildXrefStreamPdf } from './helpers/build-pdf.js';
// ...
describe('Document.Open eager parse', () => {
  it('materializes every object up front (xref-stream input resolves without lazy parse)', () => {
    const doc = Document.Open(buildXrefStreamPdf());
    const cat = doc.catalog();
    const pages = doc.resolve(cat.get('Pages')!);
    expect(isDict(pages)).toBe(true);
    // Page 3 is reachable through the eagerly-parsed map.
    const kids = (pages as Map<string, any>).get('Kids');
    const page = doc.resolve(kids[0]);
    expect(isDict(page)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm current behavior (should still pass under lazy code)**

Run: `npm test -- document.test`
Expected: PASS (lazy code already resolves on demand). This test pins behavior we must preserve.

- [ ] **Step 3: Rewrite `Document` fields + constructor for the live map**

In `src/document.ts`, replace the field block and constructor (lines ~45–76). New shape:

```ts
export class Document {
  /** One Page per page, in document order. Populated by the constructor. */
  readonly Pages: Page[];
  /** Object number backing each Pages slot (parallel to Pages). */
  private pageObjNums: number[];
  /** Object number of the root /Pages node, or undefined when /Pages is inline. */
  private readonly rootPagesNum: number | undefined;
  /** Set by Reorder(); triggers a page-tree rewrite in save(). (Interim — removed in the serializer cutover.) */
  private pageOrderChanged = false;
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;

  private constructor(
    /** Original input bytes; empty for in-memory (Split) documents. Interim — removed in the serializer cutover. */
    private readonly buf: Uint8Array,
    /** Every indirect object, eagerly parsed and live-mutable. */
    private readonly objects: Map<number, PdfObject>,
    readonly trailer: PdfDict,
    /** True for documents built in memory (Split); routes save() through writePdf. Interim. */
    private readonly synthetic: boolean = false,
    /** /Root object number for synthetic documents. Interim. */
    private readonly rootNum: number = 0,
  ) {
    const tree: PageTree = buildPages(this);
    this.Pages = tree.pages;
    this.pageObjNums = tree.pageObjNums;
    this.rootPagesNum = tree.rootPagesNum;
  }
```

Remove the `cache`, `objStmCache`, and `entries` fields and the old `built` parameter entirely.

- [ ] **Step 4: Replace `getObject` / `fromObjStm` with a plain map lookup**

Replace the whole `getObject` method and delete `fromObjStm`:

```ts
getObject(num: number): PdfObject {
  return this.objects.get(num) ?? null;
}
```

- [ ] **Step 5: Rewrite `Open` to eager-parse every entry**

Add the needed imports at the top if missing: `isName` from `./types.js` is already importable (add it to the existing `types.js` import line). Replace `Open`:

```ts
static Open(buf: Uint8Array): Document {
  const { entries, trailer } = readXref(buf);
  if (trailer.get('Encrypt') !== undefined)
    throw new UnsupportedFeatureError('encrypted PDFs are not supported');

  const objects = new Map<number, PdfObject>();
  const objStmCache = new Map<number, Map<number, PdfObject>>();

  // Parse one xref entry into `objects`, memoizing; recurses for forward refs
  // (e.g. an indirect stream /Length) and for object-stream containers.
  const parseEntry = (num: number): PdfObject => {
    const existing = objects.get(num);
    if (existing !== undefined) return existing;
    const entry = entries.get(num);
    if (!entry) return null;
    let value: PdfObject;
    if (entry.type === 'offset') {
      const parser = new ObjectParser(new Lexer(buf, entry.offset), (lenObj) => {
        const r = isRef(lenObj) ? parseEntry(lenObj.num) : lenObj;
        return typeof r === 'number' ? r : undefined;
      });
      value = parser.parseIndirectObject().value;
    } else {
      let map = objStmCache.get(entry.streamObj);
      if (!map) {
        const s = parseEntry(entry.streamObj);
        if (!isStream(s)) throw new PdfParseError(`object stream ${entry.streamObj} is not a stream`);
        map = decodeObjStm(s);
        objStmCache.set(entry.streamObj, map);
      }
      value = map.get(num) ?? null;
    }
    objects.set(num, value);
    return value;
  };

  for (const num of entries.keys()) parseEntry(num);

  // Object-stream containers were only holders; their contents now live
  // top-level, so drop the containers themselves.
  for (const [num, obj] of [...objects]) {
    if (isStream(obj)) {
      const t = obj.dict.get('Type');
      if (isName(t) && t.name === 'ObjStm') objects.delete(num);
    }
  }

  return new Document(buf, objects, trailer);
}
```

- [ ] **Step 6: Point `fromObjects` and `save()`'s synthetic branch at the new fields**

Replace `fromObjects`:

```ts
private static fromObjects(objects: Map<number, PdfObject>, rootNum: number): Document {
  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(rootNum)]]);
  return new Document(new Uint8Array(0), objects, trailer, true, rootNum);
}
```

In `save()`, replace the first line `if (this.built) return writePdf(this.built.objects, this.built.rootNum);` with:

```ts
if (this.synthetic) return writePdf(this.objects, this.rootNum);
```

And replace the `maxObjNum` derivation that read `this.entries.keys()` with the live map:

```ts
let maxObjNum = 0;
for (const n of this.objects.keys()) if (n > maxObjNum) maxObjNum = n;
```

In the reorder branch of `save()`, replace `const rootNode = this.resolve(ref(rootNum));` — `resolve` still works (reads `objects`), no change needed there. Leave the rest of `save()` intact for now.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (all existing tests, including `objstm`, `xref-stream`, `split`, `document-metadata`, plus the new eager-parse test).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `XrefEntry` import is now unused, remove it from the import line.)

- [ ] **Step 9: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "refactor: eager-parse all objects into a live map at Open"
```

---

## Task 2: New mark-sweep + renumber serializer (additive)

Build `serializer.ts` as a standalone, fully unit-tested function. Nothing in `document.ts` calls it yet.

**Files:**
- Create: `src/serializer.ts`
- Test: `test/serializer.test.ts`

- [ ] **Step 1: Write failing tests for `serializeDocument`**

Create `test/serializer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeDocument } from '../src/serializer.js';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, name, ref } from '../src/types.js';

/** A tiny live doc: 1=Catalog -> 2=Pages -> 3=Page (+ an orphan 9). */
function tinyDoc(): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const page: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 100, 100]],
  ]);
  const pages: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)],
  ]);
  const orphan: PdfDict = new Map<string, PdfObject>([['Dead', name('Yes')]]);
  const objects = new Map<number, PdfObject>([[1, catalog], [2, pages], [3, page], [9, orphan]]);
  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}

describe('serializeDocument', () => {
  it('emits a parseable PDF whose catalog and one page round-trip', () => {
    const { objects, trailer } = tinyDoc();
    const re = Document.Open(serializeDocument(objects, trailer));
    expect(re.Pages.length).toBe(1);
    expect(re.Pages[0].MediaBox).toEqual([0, 0, 100, 100]);
  });

  it('drops objects unreachable from /Root', () => {
    const { objects, trailer } = tinyDoc();
    const out = new TextDecoder('latin1').decode(serializeDocument(objects, trailer));
    expect(out.includes('/Dead')).toBe(false); // orphan 9 swept
  });

  it('renumbers reachable objects compactly 1..N with the root first', () => {
    const { objects, trailer } = tinyDoc();
    const out = new TextDecoder('latin1').decode(serializeDocument(objects, trailer));
    expect(out.includes('xref\n0 4\n')).toBe(true); // 3 reachable + free head
    expect(/\/Root 1 0 R/.test(out)).toBe(true);    // catalog renumbered to 1
  });

  it('preserves /ID and /Info references', () => {
    const { objects, trailer } = tinyDoc();
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', { kind: 'string', bytes: new TextEncoder().encode('T') }],
    ]);
    objects.set(7, info);
    trailer.set('Info', ref(7));
    trailer.set('ID', [
      { kind: 'string', bytes: Uint8Array.from([1, 2]) },
      { kind: 'string', bytes: Uint8Array.from([3, 4]) },
    ]);
    const re = Document.Open(serializeDocument(objects, trailer));
    expect(re.GetMetadata().title).toBe('T');
    expect(re.trailer.get('ID')).toBeDefined();
  });

  it('is stable across reopen (second serialize equals first)', () => {
    const { objects, trailer } = tinyDoc();
    const first = serializeDocument(objects, trailer);
    const reopened = Document.Open(first);
    const second = serializeDocument(
      (reopened as any).objects as Map<number, PdfObject>,
      reopened.trailer,
    );
    expect(second).toEqual(first);
  });
});
```

Note: the last test reaches `(reopened as any).objects`. `objects` is `private`; the cast is acceptable in a test. If preferred, drop that single test — the integration idempotence test in Task 6 covers reopen-stability through the public `Save`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- serializer.test`
Expected: FAIL with "Cannot find module '../src/serializer.js'".

- [ ] **Step 3: Implement `serializer.ts`**

Create `src/serializer.ts`:

```ts
import { PdfObject, PdfDict, PdfRef, isRef, isDict, isArray, isStream, ref } from './types.js';
import { enc, serializeObject, serializeValue } from './serialize.js';
import { PdfParseError } from './errors.js';

/** Collect every PdfRef contained directly in `o` (dict values, array elements, stream-dict values). */
function refsIn(o: PdfObject, out: PdfRef[]): void {
  if (isRef(o)) out.push(o);
  else if (isArray(o)) for (const v of o) refsIn(v, out);
  else if (isDict(o)) for (const v of o.values()) refsIn(v, out);
  else if (isStream(o)) for (const v of o.dict.values()) refsIn(v, out);
}

/** Deep-copy `o`, rewriting every ref's object number through `map` (gen reset to 0). */
function remap(o: PdfObject, map: Map<number, number>): PdfObject {
  if (isRef(o)) return ref(map.get(o.num) ?? o.num, 0);
  if (isArray(o)) return o.map((v) => remap(v, map));
  if (isDict(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o) d.set(k, remap(v, map));
    return d;
  }
  if (isStream(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o.dict) d.set(k, remap(v, map));
    return { kind: 'stream', dict: d, raw: o.raw };
  }
  return o;
}

/** Serialize the live object map to bytes: mark reachable-from-/Root(+/Info),
 *  renumber compactly 1..N (root first, then discovery order), emit classic xref.
 *  Does not mutate `objects` or `trailer` (remapping produces copies). */
export function serializeDocument(objects: Map<number, PdfObject>, trailer: PdfDict): Uint8Array {
  const rootRef = trailer.get('Root');
  if (!isRef(rootRef)) throw new PdfParseError('cannot serialize: /Root is not an indirect reference');
  const infoRef = trailer.get('Info');

  // Mark + assign new numbers in discovery order. oldToNew.size is the next number - 1.
  const oldToNew = new Map<number, number>();
  const order: number[] = []; // old numbers, indexed by (newNumber - 1)
  const queue: number[] = [];
  const enqueue = (num: number): void => {
    if (oldToNew.has(num)) return;
    oldToNew.set(num, oldToNew.size + 1);
    order.push(num);
    queue.push(num);
  };
  enqueue(rootRef.num);
  if (isRef(infoRef)) enqueue(infoRef.num);
  while (queue.length) {
    const obj = objects.get(queue.shift()!);
    if (obj === undefined) continue;
    const refs: PdfRef[] = [];
    refsIn(obj, refs);
    for (const r of refs) if (objects.has(r.num)) enqueue(r.num);
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  const n = order.length;
  const offsets: number[] = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const newNum = i + 1;
    offsets[newNum] = length;
    push(enc(`${newNum} 0 obj\n`));
    push(serializeObject(remap(objects.get(order[i])!, oldToNew)));
    push(enc('\nendobj\n'));
  }

  const xrefStart = length;
  let xref = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));

  let tr = `trailer\n<< /Size ${n + 1} /Root ${oldToNew.get(rootRef.num)} 0 R`;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) tr += ` /Info ${oldToNew.get(infoRef.num)} 0 R`;
  const id = trailer.get('ID');
  if (id !== undefined) tr += ` /ID ${serializeValue(id)}`;
  tr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(tr));

  const out = new Uint8Array(length);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
```

- [ ] **Step 4: Run the serializer tests**

Run: `npm test -- serializer.test`
Expected: PASS (all 5).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add src/serializer.ts test/serializer.test.ts
git commit -m "feat: add mark-sweep + renumber serializer (serializeDocument)"
```

---

## Task 3: `Page` as a live handle — dynamic inheritance + `Rotate` setter

Stop materializing folded-in copies. `Page` holds the live dict and resolves inheritable keys by walking `/Parent`. Add the `Rotate` setter. The old `save()` stays intact.

**Files:**
- Modify: `src/page.ts`, `src/pagetree.ts`
- Test: `test/page.test.ts`, `test/pagetree.test.ts`

- [ ] **Step 1: Write a failing test for the `Rotate` setter (in-memory liveness)**

Add to `test/page.test.ts` inside `describe('Page', ...)`:

```ts
it('Rotate setter writes the live dict and is observable via the getter', () => {
  const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
  const page = new Page(doc, dict, 1);
  page.Rotate = 90;
  expect(page.Rotate).toBe(90);
  expect(dict.get('Rotate')).toBe(90);          // wrote the live dict
  page.Rotate = 450;
  expect(page.Rotate).toBe(90);                  // normalized
});
```

- [ ] **Step 2: Write a failing test for inheritance via the `/Parent` chain**

Add to `test/pagetree.test.ts`:

```ts
it('inherits MediaBox and Rotate from an ancestor /Pages node via the live tree', () => {
  const doc = Document.Open(buildClassicPdf(2));
  const pages = buildPages(doc).pages;
  // buildClassicPdf puts /MediaBox on the root /Pages node, not on the page dicts.
  expect(pages[0].Dict.has('MediaBox')).toBe(false); // own dict has no MediaBox
  expect(pages[0].MediaBox).toEqual([0, 0, 200, 200]); // inherited through /Parent
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npm test -- page.test pagetree.test`
Expected: FAIL — `Rotate` has no setter; `pages[0].Dict.has('MediaBox')` is currently `true` (materialized copy).

- [ ] **Step 4: Add a `/Parent`-walking inheritance helper + setter to `Page`**

In `src/page.ts`, replace the class body's box/getter section. Add the helper and rewrite `MediaBox`/`CropBox`/`Rotate`/`Resources` to consult it. Add `isRef`-free walking via `doc.resolve`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isStream } from './types.js';
import { inflateStream } from './flate.js';

/** A single PDF page: a live, mutable handle over its real page dict. */
export class Page {
  constructor(
    private readonly doc: Document,
    /** The live page dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
    /** 1-based position in document order. */
    readonly Number: number,
  ) {}

  /** Resolve an inheritable key: own dict, then up the /Parent chain (cycle-guarded). */
  private inherited(key: string): PdfObject {
    let node: PdfObject = this.Dict;
    const seen = new Set<PdfDict>();
    while (isDict(node)) {
      if (seen.has(node)) break;
      seen.add(node);
      if (node.has(key)) return this.doc.resolve(node.get(key));
      node = this.doc.resolve(node.get('Parent'));
    }
    return null;
  }

  private box(key: string, dflt: number[]): number[] {
    const b = this.inherited(key);
    if (isArray(b) && b.length === 4) {
      const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
      if (nums.length === 4) return nums;
    }
    return dflt;
  }

  /** Page boundary [llx, lly, urx, ury]; inherited; defaults to US Letter. */
  get MediaBox(): number[] {
    return this.box('MediaBox', [0, 0, 612, 792]);
  }

  /** Visible region; inherited; falls back to MediaBox. */
  get CropBox(): number[] {
    return this.box('CropBox', this.MediaBox);
  }

  /** Effective visible rectangle (= CropBox). */
  get Rect(): number[] {
    return this.CropBox;
  }

  /** Clockwise rotation in degrees, normalized to 0/90/180/270; inherited. */
  get Rotate(): number {
    const r = this.inherited('Rotate');
    if (typeof r !== 'number') return 0;
    return ((Math.trunc(r) % 360) + 360) % 360;
  }

  /** Write /Rotate into the page's own live dict (overrides any inherited value). */
  set Rotate(deg: number) {
    this.Dict.set('Rotate', ((Math.trunc(deg) % 360) + 360) % 360);
  }

  /** The page's resource dictionary, or undefined when absent; inherited. */
  get Resources(): PdfDict | undefined {
    const r = this.inherited('Resources');
    return isDict(r) ? r : undefined;
  }
```

Keep the existing `Contents` and `Annotations` getters exactly as they are (they already read `this.Dict` through `doc.resolve`). The class's closing brace stays.

- [ ] **Step 5: Make `buildPages` record live dicts (no materialize)**

In `src/pagetree.ts`, delete the `materialize` function and change `walk` to push the live `node` dict. Replace the two `out.push({ dict: materialize(node, merged), ... })` calls with `out.push({ dict: node, objNum: objNum ?? 0 })`, and drop the now-unused `inherited`/`merged` plumbing:

```ts
import type { Document } from './document.js';
import { PdfDict, isDict, isArray, isName, isRef } from './types.js';
import { PdfParseError } from './errors.js';
import { Page } from './page.js';

export interface PageTree {
  pages: Page[];
  pageObjNums: number[];
  rootPagesNum: number | undefined;
}

export function buildPages(doc: Document): PageTree {
  const catalog = doc.catalog();
  const pagesRef = catalog.get('Pages');
  const pagesRoot = doc.resolve(pagesRef);
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const rootPagesNum = isRef(pagesRef) ? pagesRef.num : undefined;
  const leaves: { dict: PdfDict; objNum: number }[] = [];
  walk(doc, pagesRoot, rootPagesNum, new Set(), leaves);
  return {
    pages: leaves.map((leaf, i) => new Page(doc, leaf.dict, i + 1)),
    pageObjNums: leaves.map((leaf) => leaf.objNum),
    rootPagesNum,
  };
}

function walk(
  doc: Document, node: PdfDict, objNum: number | undefined,
  seen: Set<PdfDict>, out: { dict: PdfDict; objNum: number }[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push({ dict: node, objNum: objNum ?? 0 });
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const childNum = isRef(kid) ? kid.num : undefined;
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, childNum, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type and no kids: treat as page.
  out.push({ dict: node, objNum: objNum ?? 0 });
}
```

Note `PdfObject` import is no longer needed in `pagetree.ts`; drop it from the import line.

- [ ] **Step 6: Fix the existing `pagetree.test.ts` MediaBox assertion**

The pre-existing test "returns pages in order with inherited MediaBox" asserts `pages[0].Dict.get('MediaBox')` is a 4-element array. With live dicts the page's own dict has no MediaBox. Update that assertion to read through the getter:

```ts
it('returns pages in order with inherited MediaBox', () => {
  const doc = Document.Open(buildClassicPdf(3));
  const pages = buildPages(doc).pages;
  expect(pages.length).toBe(3);
  expect(pages[0].MediaBox).toEqual([0, 0, 200, 200]); // inherited via /Parent
});
```

- [ ] **Step 7: Run the affected suites**

Run: `npm test -- page.test pagetree.test`
Expected: PASS.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors. Watch `split.test` and `document.test` (Reorder) — they exercise `Page.Contents` through live dicts; they should remain green because `save()` still reparents to the root `/Pages` node that carries `/MediaBox`.

- [ ] **Step 9: Commit**

```bash
git add src/page.ts src/pagetree.ts test/page.test.ts test/pagetree.test.ts
git commit -m "feat: live Page handle with /Parent-chain inheritance and Rotate setter"
```

---

## Task 4: Live metadata

`SetMetadata` / `ClearMetadata` mutate the live `/Info` dict in `objects` + `trailer`; `GetMetadata` reads it live. The old `save()` still serializes correctly because `infoWork` now *is* the live `/Info` object.

**Files:**
- Modify: `src/document.ts`
- Test: `test/document-metadata.test.ts`

- [ ] **Step 1: Write a failing liveness test (Set then Get, no save)**

Add to `test/document-metadata.test.ts` inside `describe('Document.SetMetadata / ClearMetadata', ...)`:

```ts
it('reflects a SetMetadata immediately via GetMetadata (no save/reload)', () => {
  const doc = Document.Open(buildClassicPdf(1));
  doc.SetMetadata({ title: 'Live' });
  expect(doc.GetMetadata().title).toBe('Live'); // observable without save
});

it('creates a live /Info on first write even when the input had none', () => {
  const doc = Document.Open(buildClassicPdf(1)); // no /Info
  doc.SetMetadata({ author: 'Ada' });
  expect(doc.GetMetadata().author).toBe('Ada');
  expect(doc.trailer.get('Info')).toBeDefined(); // trailer now references /Info
});
```

- [ ] **Step 2: Run to verify the new tests' intent (first may already pass, second is the real driver)**

Run: `npm test -- document-metadata.test`
Expected: the "creates a live /Info ... trailer now references /Info" test FAILS (current code keeps edits in `infoWork` and only references `/Info` at save time).

- [ ] **Step 3: Make metadata mutation live**

In `src/document.ts`, replace `currentInfo`, `ensureInfoWork`, `SetMetadata`, `ClearMetadata` with live versions. Add a small max-object-number helper if not present:

```ts
/** Largest object number currently in the live map (0 when empty). */
private maxObjNum(): number {
  let m = 0;
  for (const n of this.objects.keys()) if (n > m) m = n;
  return m;
}

/** The live /Info dict, or undefined when there is none. */
private currentInfo(): PdfDict | undefined {
  const info = this.resolve(this.trailer.get('Info'));
  return isDict(info) ? info : undefined;
}

GetMetadata(): Metadata {
  return readMetadata(this.currentInfo(), (o) => this.resolve(o));
}

/** Resolve or lazily create the live /Info dict, ensuring it has an object number
 *  and a trailer reference. */
private ensureInfo(): PdfDict {
  const existing = this.currentInfo();
  if (existing) return existing;
  const num = this.maxObjNum() + 1;
  const info: PdfDict = new Map<string, PdfObject>();
  this.objects.set(num, info);
  this.trailer.set('Info', ref(num));
  this.infoState = 'modified'; // interim: keeps the old save() metadata branch active
  return info;
}

SetMetadata(update: MetadataUpdate): void {
  this.infoState = 'modified';
  applyUpdate(this.ensureInfo(), update);
}

ClearMetadata(): void {
  const infoRef = this.trailer.get('Info');
  if (isRef(infoRef)) this.objects.delete(infoRef.num);
  this.trailer.delete('Info');
  this.infoState = 'cleared';
  this.infoWork = undefined;
}
```

- [ ] **Step 4: Update the old `save()` metadata branch to read the live /Info**

The interim `save()` still appends changed objects. Replace its metadata block so it pulls the live `/Info` from `trailer`/`objects` rather than `infoWork`:

```ts
// Metadata: decide the /Info reference for the new trailer.
let info: number | null;
if (this.infoState === 'cleared') {
  info = null;
} else if (this.infoState === 'modified') {
  const infoRef = this.trailer.get('Info');
  const infoNum = isRef(infoRef) ? infoRef.num : ++maxObjNum;
  const live = this.resolve(ref(infoNum));
  objects.set(infoNum, isDict(live) ? live : new Map<string, PdfObject>());
  info = infoNum;
} else {
  const infoRef = this.trailer.get('Info');
  info = isRef(infoRef) ? infoRef.num : null;
}
```

(`infoWork` is now unused by `save`; leave the field declared — it is removed in Task 6.)

- [ ] **Step 5: Run the metadata suites**

Run: `npm test -- document-metadata.test node-metadata.test`
Expected: PASS. The existing round-trip and clear tests still pass because the old `save()` still appends the live `/Info` incrementally.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/document-metadata.test.ts
git commit -m "feat: live /Info metadata mutation observable without save"
```

---

## Task 5: Live reorder

`Reorder` mutates the live root `/Pages` node's `/Kids` + `/Count`, clones repeated pages into fresh live objects, and rebuilds `Pages` from the live tree. The old `save()` reorder branch is simplified to append the already-mutated live objects so incremental round-trips stay green until the cutover.

**Files:**
- Modify: `src/document.ts`
- Test: `test/document.test.ts`

- [ ] **Step 1: Write a failing liveness test for the live page tree**

Add to `test/document.test.ts` inside `describe('Document.Reorder (in-memory)', ...)`:

```ts
it('mutates the live /Pages node so Kids reflects the new order immediately', () => {
  const doc = Document.Open(buildClassicPdf(3));
  doc.Reorder([3, 1]);
  const pagesNode = doc.resolve(doc.catalog().get('Pages')!) as Map<string, any>;
  expect(pagesNode.get('Count')).toBe(2);          // live count updated
  expect((pagesNode.get('Kids') as any[]).length).toBe(2); // live kids updated
});

it('clones a repeated page into a distinct live object', () => {
  const doc = Document.Open(buildClassicPdf(3));
  doc.Reorder([1, 1]);
  const pagesNode = doc.resolve(doc.catalog().get('Pages')!) as Map<string, any>;
  const kids = pagesNode.get('Kids') as any[];
  expect(kids[0].num).not.toBe(kids[1].num);       // duplicate is a second object
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- document.test`
Expected: FAIL — current `Reorder` defers the tree rewrite to `save()`, so the live `/Pages` node is unchanged.

- [ ] **Step 3: Rewrite `Reorder` to mutate the live tree**

In `src/document.ts`, replace `Reorder`:

```ts
Reorder(order: number[]): void {
  const n = this.Pages.length;
  if (order.length === 0) throw new RangeError('Reorder: order must not be empty');
  for (const o of order)
    if (!Number.isInteger(o) || o < 1 || o > n)
      throw new RangeError(`Reorder: page number ${o} out of range 1..${n}`);

  if (this.rootPagesNum === undefined)
    throw new UnsupportedFeatureError('cannot reorder: /Pages is not an indirect reference');
  const rootNum = this.rootPagesNum;
  for (const num of this.pageObjNums)
    if (num === 0) throw new UnsupportedFeatureError('cannot reorder: a page is not an indirect object');

  const srcNums = this.pageObjNums.slice();
  const kids: PdfObject[] = [];
  const newNums: number[] = [];
  const used = new Set<number>();
  let maxObjNum = this.maxObjNum();

  for (const o of order) {
    let num = srcNums[o - 1];
    if (used.has(num)) {
      // Repeated page: clone the live dict into a fresh object.
      const src = this.objects.get(num);
      const clone: PdfDict = isDict(src) ? new Map(src) : new Map<string, PdfObject>();
      num = ++maxObjNum;
      this.objects.set(num, clone);
    }
    used.add(num);
    const pageDict = this.objects.get(num);
    if (isDict(pageDict)) {
      pageDict.set('Parent', ref(rootNum));
      if (!pageDict.has('Type')) pageDict.set('Type', name('Page'));
    }
    kids.push(ref(num));
    newNums.push(num);
  }

  const rootNode = this.objects.get(rootNum);
  const pagesNode: PdfDict = isDict(rootNode) ? rootNode : new Map<string, PdfObject>();
  pagesNode.set('Type', name('Pages'));
  pagesNode.set('Kids', kids);
  pagesNode.set('Count', order.length);
  this.objects.set(rootNum, pagesNode);

  this.pageObjNums = newNums;
  const tree = buildPages(this);
  this.Pages.length = 0;
  this.Pages.push(...tree.pages);
  this.pageObjNums = tree.pageObjNums;
  this.pageOrderChanged = true; // interim: keeps the old save() reorder branch active
}
```

- [ ] **Step 4: Simplify the old `save()` reorder branch to append the live objects**

The live `/Pages` node and any clones are already in `this.objects`. Replace the whole `if (this.pageOrderChanged) { ... }` block in `save()` with one that copies the live reachable page objects + root into the incremental set:

```ts
if (this.pageOrderChanged) {
  const rootNum = this.rootPagesNum!;
  const rootNode = this.objects.get(rootNum);
  if (isDict(rootNode)) objects.set(rootNum, rootNode);
  for (const num of this.pageObjNums) {
    const pageDict = this.objects.get(num);
    if (isDict(pageDict)) objects.set(num, pageDict);
  }
}
```

This appends the mutated root `/Pages` node and the current page dicts (including clones). Dropped pages simply aren't referenced; they linger as orphans in the incremental output, which is fine for the round-trip tests.

- [ ] **Step 5: Run the reorder suites**

Run: `npm test -- document.test`
Expected: PASS — both in-memory and persisted-on-save reorder describes, plus the two new liveness tests.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors. (`Page` import in `document.ts` is no longer used by `Reorder`; leave other imports as-is, the cutover prunes them.)

- [ ] **Step 7: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: live page-tree Reorder mutating /Kids with duplicate cloning"
```

---

## Task 6: Cutover — `Save` / `WriteTo` via the serializer; delete deferred/incremental/writer paths

Flip the save path to `serializeDocument`. Rename `save()` → `Save()`, add `WriteTo`. `Split` results serialize through the same path. Remove the interim `buf` / `synthetic` / `rootNum` / `infoState` / `infoWork` / `pageOrderChanged` scaffolding. Update every call site and adapt the save-shape tests.

**Files:**
- Modify: `src/document.ts`, `src/node.ts`
- Modify: `test/document.test.ts`, `test/document-metadata.test.ts`, `test/split.test.ts`
- Test: new idempotence + reachable-only integration tests in `test/document.test.ts`

- [ ] **Step 1: Write failing tests for `Save` / `WriteTo` and reachable-only output**

Add to `test/document.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
// (mkdtempSync/rmSync already imported at top; add readFileSync, writeFileSync if missing)

describe('Document.Save / WriteTo', () => {
  it('Save round-trips a metadata edit through reopen', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old' } }));
    doc.SetMetadata({ title: 'New' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('New');
  });

  it('Save drops pages removed by Reorder (reachable-only)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([2]); // keep only old page 2
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(1);
    const txt = new TextDecoder().decode(re.Pages[0].Contents);
    expect(txt).toContain('Page 2');
  });

  it('Save is stable across reopen (idempotent bytes)', () => {
    const doc = Document.Open(buildClassicPdf(2, { info: { Title: 'X' } }));
    const first = doc.Save();
    const second = Document.Open(first).Save();
    expect(second).toEqual(first);
  });

  it('persists Page.Rotate set via the live handle', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Pages[0].Rotate = 90;
    expect(Document.Open(doc.Save()).Pages[0].Rotate).toBe(90);
  });

  it('WriteTo writes serialized bytes to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfwriteto-'));
    try {
      const path = join(dir, 'out.pdf');
      Document.Open(buildClassicPdf(2)).WriteTo(path);
      expect(Document.Open(new Uint8Array(readFileSync(path))).Pages.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- document.test`
Expected: FAIL — `Save` / `WriteTo` are not defined.

- [ ] **Step 3: Replace `save()` with `Save()` + add `WriteTo`; delete the deferred machinery**

In `src/document.ts`:

1. Delete the fields `infoState`, `infoWork`, `pageOrderChanged`, and the constructor params `buf`, `synthetic`, `rootNum`. New constructor:

```ts
private constructor(
  private readonly objects: Map<number, PdfObject>,
  readonly trailer: PdfDict,
) {
  const tree: PageTree = buildPages(this);
  this.Pages = tree.pages;
  this.pageObjNums = tree.pageObjNums;
  this.rootPagesNum = tree.rootPagesNum;
}
```

2. `Open` returns `new Document(objects, trailer)`. `fromObjects` returns `new Document(objects, new Map([['Root', ref(rootNum)]]))`.

3. In `Reorder`, delete the trailing `this.pageOrderChanged = true;` line.

4. In `SetMetadata` delete `this.infoState = 'modified';`; in `ensureInfo` delete the `this.infoState = 'modified';` line; in `ClearMetadata` keep only the deletion logic:

```ts
ClearMetadata(): void {
  const infoRef = this.trailer.get('Info');
  if (isRef(infoRef)) this.objects.delete(infoRef.num);
  this.trailer.delete('Info');
}
```

5. Replace the entire old `save()` method with:

```ts
/** Serialize the live document to PDF bytes (mark-sweep from /Root, renumbered). */
Save(): Uint8Array {
  return serializeDocument(this.objects, this.trailer);
}

/** Serialize and write to a file path (synchronous), mirroring OpenFile. */
WriteTo(fileName: string): void {
  writeFileSync(fileName, this.Save());
}
```

6. Update imports: add `import { serializeDocument } from './serializer.js';` and `writeFileSync` to the `node:fs` import (`import { readFileSync, writeFileSync } from 'node:fs';`). Remove `import { appendIncremental } from './incremental.js';` and `import { writePdf } from './writer.js';`. Remove the now-unused `XrefEntry` import if still present. `Page` is still used? `Reorder` no longer constructs `Page`; check remaining uses — if none, remove the `Page` import (keep `buildPages`/`PageTree`).

- [ ] **Step 4: Point `node.ts` at `Save`**

In `src/node.ts`, replace the three `.save()` call sites with `.Save()`:
- `await writeFile(p, docs[i].Save());`
- `await writeFile(outputPath, doc.Save());` (in `updateMetadataFile`)
- `await writeFile(outputPath, doc.Save());` (in `clearMetadataFile`)

- [ ] **Step 5: Update `split.test.ts` to `Save`**

Replace every `.save()` with `.Save()` in `test/split.test.ts` (4 occurrences).

- [ ] **Step 6: Update `document.test.ts` reorder round-trip describe to `Save`**

In `test/document.test.ts`, the `describe('Document.Reorder (persisted on save)', ...)` block calls `doc.save()` four times. Replace each `Document.Open(doc.save())` with `Document.Open(doc.Save())`.

- [ ] **Step 7: Adapt the `document-metadata.test.ts` save-shape tests**

The old `describe('Document.save', ...)` asserts byte-prefix preservation, which no longer holds (the serializer renumbers). Replace that whole describe block with `Save`-based round-trip assertions:

```ts
describe('Document.Save', () => {
  it('round-trips a metadata edit through Save + Open', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.SetMetadata({ title: 'New', custom: { Tag: 'T1' } });
    const meta = Document.Open(doc.Save()).GetMetadata();
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Tag: 'T1' });
  });

  it('round-trips a non-ASCII value', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.SetMetadata({ title: 'Café—Ω' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('Café—Ω');
  });

  it('ClearMetadata + Save yields a document with no metadata', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.ClearMetadata();
    expect(Document.Open(doc.Save()).GetMetadata()).toEqual({ custom: {} });
  });
});
```

(The old "returns original bytes verbatim when nothing changed" guarantee is intentionally dropped — byte preservation is a non-goal.)

- [ ] **Step 8: Run the changed suites**

Run: `npm test -- document.test document-metadata.test split.test node.test node-metadata.test`
Expected: PASS.

- [ ] **Step 9: Full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors. (`incremental.test.ts` and `writer.test.ts` still pass here — they test the soon-to-be-deleted modules directly. They are removed in Task 7.)

- [ ] **Step 10: Commit**

```bash
git add src/document.ts src/node.ts test/document.test.ts test/document-metadata.test.ts test/split.test.ts
git commit -m "feat: Save/WriteTo via mark-sweep serializer; remove deferred save state"
```

---

## Task 7: Delete dead modules + tidy

Remove `writer.ts`, `incremental.ts`, and their tests. Confirm `index.ts` exports are correct.

**Files:**
- Delete: `src/writer.ts`, `src/incremental.ts`, `test/writer.test.ts`, `test/incremental.test.ts`
- Verify: `src/index.ts`

- [ ] **Step 1: Confirm nothing imports the doomed modules**

Run: `npm test` first to confirm green, then search:
Run (Grep tool): pattern `from '\./(writer|incremental)\.js'` across `src` and `test`.
Expected: only `test/writer.test.ts` and `test/incremental.test.ts` reference them (those tests are deleted next). `src/document.ts` must show **no** matches (removed in Task 6).

- [ ] **Step 2: Delete the modules and their tests**

```bash
git rm src/writer.ts src/incremental.ts test/writer.test.ts test/incremental.test.ts
```

- [ ] **Step 3: Verify `index.ts`**

Open `src/index.ts`. It exports `Document` (carries `Save`/`WriteTo`/`OpenFile` as methods), `Page`, `SplitOptions`, the metadata types, error classes, and the node file helpers. No removed type was ever exported, so no change is required. If a lint of imports flags anything, fix it; otherwise leave as-is.

- [ ] **Step 4: Full suite + typecheck**

Run: `npm test`
Run: `npm run typecheck`
Expected: PASS / no errors. The suite no longer contains `writer`/`incremental` tests; everything else is green.

- [ ] **Step 5: Build to confirm a clean compile**

Run: `npm run build`
Expected: emits `dist/` with no errors.

- [ ] **Step 6: Commit**

```bash
git add -u src test
git commit -m "chore: delete writer.ts and incremental.ts (subsumed by serializer)"
```

---

## Final verification

- [ ] Run the entire suite once more: `npm test` — all green.
- [ ] `npm run typecheck` and `npm run build` — clean.
- [ ] Grep the tree for stragglers: no remaining references to `built`, `infoWork`, `infoState`, `pageOrderChanged`, `appendIncremental`, or `writePdf`.
- [ ] Confirm liveness end-to-end manually if desired: open a fixture, `SetMetadata`, `GetMetadata` (no save) returns the new value; `Pages[0].Rotate = 90` then read back `90`; `Reorder([...])` reflected in `doc.Pages` immediately.
- [ ] Session close: file follow-up issues (MediaBox/CropBox setters are out of scope — see the spec's "Out of scope"), then `git pull --rebase && git push`.

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Eager-parse entire PDF into `Map<number, PdfObject>` | 1 |
| Hoist object-stream contents top-level; drop the container | 1 |
| `getObject` = plain map lookup; `resolve` reads same map | 1 |
| Reject encrypted PDFs (unchanged) | 1 (preserved) |
| Mark-sweep from `/Root`(+`/Info`), renumber `1..N`, classic xref, preserve `/ID` | 2 |
| Serializer doesn't mutate the live map (save → mutate → save) | 2 (`remap` copies) |
| `Page` holds the live dict; dynamic `/Parent`-chain inheritance | 3 |
| `Rotate` setter writes the page's own live dict | 3 |
| `buildPages` records live dicts + object numbers, no materialize | 3 |
| Live `/Info`; `Set`/`Clear`/`Get` observable without save | 4 |
| Live `Reorder`: rewrite `/Kids` + `/Count`, reparent, clone duplicates, drop via sweep | 5 |
| `Save(): Uint8Array` primary serializer (PascalCase) | 6 |
| `WriteTo(path)` sync file write | 6 |
| `Split` results are ordinary `Document`s serialized via the same path | 6 |
| `node.ts` helpers delegate to `Save` | 6 |
| Error types preserved (`PdfParseError`, `UnsupportedFeatureError`) | 5, 6 (preserved) |
| Delete `incremental.ts` + `writer.ts` | 7 |
| `index.ts` exports correct | 7 |
