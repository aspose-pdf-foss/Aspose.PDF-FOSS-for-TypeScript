# Structure Preservation Across Page Ops — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a tagged document's `/StructTreeRoot` through every page-copy op (Split, ExtractPages, Merge, Append, InsertPages, AddPage, InsertPage) so output stays tagged, automatically when the source is tagged.

**Architecture:** A single post-pass in a new module `src/structpreserve.ts` rebuilds the structure tree on the output document after pages are installed. Each op records a `PageOrigin[]` (source doc + source page object number + new page object number) and calls `preserveStructure(outDoc, origins)`. The post-pass marks the structure elements with surviving content (plus their ancestors), clones that subtree into the output with fresh object numbers, rebuilds `/ParentTree` with freshly allocated `/StructParents` keys, unions `/RoleMap`, and creates or extends `/StructTreeRoot`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier ends in `.js` (e.g. `./struct.js`).
- Strict TypeScript. `npm run typecheck` and `npm test` must both be green before any task is considered done.
- Live-mutation model: edits act on the object map; copy ops must not mutate their source documents (clone before mutating).
- TDD: write the failing test first, watch it fail, then implement. Commit per task.
- Design spec (authority for behavior): `docs/superpowers/specs/2026-06-25-struct-preservation-page-ops-design.md`.
- Key invariant this design leans on: copy ops duplicate page content streams verbatim, so **MCIDs never change** — only `/StructParents` keys, `/Pg` page refs, and object numbers are remapped.
- Beads issue: `aspose-pdf-foss-for-ts-pjx.2` (S2). It is already claimed/in-progress.

---

## File Structure

- **Create** `src/structpreserve.ts` — the entire post-pass: `PageOrigin`, `preserveStructure`, and all private helpers (mark/clone/ParentTree/RoleMap/OBJR). One responsibility: rebuild structure on an output doc from a page-origin map.
- **Create** `test/helpers/build-multipage-tagged-pdf.ts` — a 2-page tagged fixture (Document → Sect spanning both pages, plus a Figure with an OBJR to a link annotation, a `/RoleMap`, `/MarkInfo`).
- **Create** `test/structpreserve.test.ts` — all behavior tests for the post-pass through the public ops.
- **Modify** `src/document.ts` — wire `preserveStructure` into `Split`, `ExtractPages`, `InsertPages`/`Append`, `Merge`, `AddPage`/`InsertPage`; add `preserveStructure?: boolean` opt-out to `SplitOptions` and a new `ExtractPagesOptions`/`InsertPagesOptions`.
- **Modify** `src/index.ts` — export the new `ExtractPagesOptions`/`InsertPagesOptions` types (and `PageOrigin` is internal — not exported).
- **Modify** `README.md` — Features/Limitations note (Task 5).

Reused existing API (all already public on `Document`): `GetStructTree(): StructTreeRoot | null`, `IsTagged: boolean`, `getObject(num): PdfObject`, `resolve(o): PdfObject`, `catalog(): PdfDict`, `allocObject(obj): PdfRef`. Reused from `struct.ts`: `lookupNumberTree(doc, node, key)`. The private `pageObjNums: number[]` field is accessible inside `document.ts` (same class) for building origins.

---

## Task 1: Multi-page tagged fixture builder

**Files:**
- Create: `test/helpers/build-multipage-tagged-pdf.ts`
- Test: `test/structpreserve.test.ts` (smoke only in this task)

**Interfaces:**
- Produces: `buildMultiPageTaggedPdf(): Uint8Array` — a 2-page classic-xref tagged PDF with this structure tree:
  - `Document (8)` → `K [Sect(13), Figure(14)]`
  - `Sect (13)` → `K [P(10) on page1, P(11) on page2]` (spans both pages)
  - `P (10)` `/Pg page1`, `/K 0` (MCID 0 → "Page one body")
  - `P (11)` `/Pg page2`, `/K 0` (MCID 0 → "Page two body")
  - `Figure (14)` `/Pg page1`, `/Alt`, `/K << /Type /OBJR /Obj annot(9) >>`
  - annot `(9)` is a Link on page1 with `/StructParent 2`
  - `/RoleMap << /MyHead /H2 >>`, catalog `/MarkInfo << /Marked true >>`, `/Lang (en-US)`
  - `/ParentTree` Nums: `0 → [10]` (page1 MCID), `1 → [11]` (page2 MCID), `2 → 14` (annot object key)

- [ ] **Step 1: Write the failing smoke test**

Create `test/structpreserve.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

describe('structpreserve fixture', () => {
  test('multi-page tagged fixture opens with a 2-element root and spanning Sect', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.Pages.length).toBe(2);
    expect(doc.IsTagged).toBe(true);
    const tree = doc.GetStructTree();
    expect(tree).not.toBeNull();
    const top = tree!.Children;
    expect(top.map((e) => e.Type)).toEqual(['Document']);
    const document = top[0];
    expect(document.Children.map((e) => e.Type)).toEqual(['Sect', 'Figure']);
    const sect = document.Children[0];
    expect(sect.Children.map((e) => e.Type)).toEqual(['P', 'P']);
    // reading order across both pages
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).toContain('Page two body');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: FAIL — `Cannot find module './helpers/build-multipage-tagged-pdf.js'`.

- [ ] **Step 3: Implement the fixture builder**

Create `test/helpers/build-multipage-tagged-pdf.ts` (mirror the byte-layout style of `test/helpers/build-tagged-pdf.ts`):

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Two-page classic-xref tagged PDF. See plan Task 1 for the full tree shape. */
export function buildMultiPageTaggedPdf(): Uint8Array {
  const page1 =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Page one body) Tj ET\nEMC\n';
  const page2 =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Page two body) Tj ET\nEMC\n';

  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  o[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << /Font << /F1 15 0 R >> >> /StructParents 0 /Annots [9 0 R] >>`;
  o[4] = `<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Resources << /Font << /F1 15 0 R >> >> /StructParents 1 >>`;
  o[5] = `<< /Length ${byteLen(page1)} >>\nstream\n${page1}endstream`;
  o[6] = `<< /Length ${byteLen(page2)} >>\nstream\n${page2}endstream`;
  o[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /H2 >> /ParentTree 12 0 R >>`;
  o[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [13 0 R 14 0 R] >>`;
  o[9] = `<< /Type /Annot /Subtype /Link /Rect [50 100 150 150] /StructParent 2 >>`;
  o[10] = `<< /Type /StructElem /S /P /P 13 0 R /Pg 3 0 R /K 0 >>`;
  o[11] = `<< /Type /StructElem /S /P /P 13 0 R /Pg 4 0 R /K 0 >>`;
  o[12] = `<< /Nums [0 [10 0 R] 1 [11 0 R] 2 14 0 R] >>`;
  o[13] = `<< /Type /StructElem /S /Sect /P 8 0 R /K [10 0 R 11 0 R] >>`;
  o[14] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /Alt (A figure) /K << /Type /OBJR /Obj 9 0 R >> >>`;
  o[15] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 15;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${o[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-multipage-tagged-pdf.ts test/structpreserve.test.ts
git commit -m "test(struct): multi-page tagged fixture for structure preservation"
```

---

## Task 2: Core single-source preserve + wire Split & ExtractPages

This task builds the whole post-pass for the single-source case (one tagged input → fewer pages), which covers Split and ExtractPages and gives pruning for free (only elements with surviving content are cloned). OBJR/Figure handling and multi-source merge come in Tasks 3–4.

**Files:**
- Create: `src/structpreserve.ts`
- Modify: `src/document.ts` (Split ~188-196, ExtractPages ~204-215, SplitOptions ~61-64, add `ExtractPagesOptions`)
- Modify: `src/index.ts` (export `ExtractPagesOptions`)
- Test: `test/structpreserve.test.ts`

**Interfaces:**
- Produces: `interface PageOrigin { srcDoc: Document; srcPageNum: number; newPageNum: number; }` and `function preserveStructure(outDoc: Document, origins: PageOrigin[]): void;`
- Produces: `interface ExtractPagesOptions { preserveStructure?: boolean; }`
- Consumes: `Document.GetStructTree`, `.IsTagged`, `.getObject`, `.resolve`, `.catalog`, `.allocObject`; `lookupNumberTree` from `./struct.js`; `ref`, `name` from `./types.js`.

- [ ] **Step 1: Write failing tests**

Append to `test/structpreserve.test.ts`:

```ts
describe('structpreserve — Split', () => {
  test('each split page is tagged with its own slice', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const parts = doc.Split();
    expect(parts.length).toBe(2);

    const t0 = parts[0].GetStructTree();
    expect(parts[0].IsTagged).toBe(true);
    expect(t0).not.toBeNull();
    expect(t0!.GetText()).toContain('Page one body');
    expect(t0!.GetText()).not.toContain('Page two body');
    // ParentTree round-trips: page 1's StructParents resolves MCID 0 -> a P
    const sp = parts[0].Pages[0].Dict.get('StructParents');
    expect(typeof sp).toBe('number');
    expect(t0!.ElementFor(sp as number, 0)?.Type).toBe('P');

    const t1 = parts[1].GetStructTree();
    expect(t1!.GetText()).toContain('Page two body');
    expect(t1!.GetText()).not.toContain('Page one body');
  });
});

describe('structpreserve — ExtractPages', () => {
  test('subset prunes dropped-page branches; spanning Sect keeps only survivor', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([1]);
    const tree = out.GetStructTree();
    expect(tree).not.toBeNull();
    const document = tree!.Children[0];
    expect(document.Type).toBe('Document');
    const sect = document.Children.find((e) => e.Type === 'Sect')!;
    expect(sect).toBeDefined();
    // Sect spanned pages 1 & 2; only the page-1 P survives
    expect(sect.Children.map((e) => e.Type)).toEqual(['P']);
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).not.toContain('Page two body');
  });

  test('source document is not mutated', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    doc.ExtractPages([1]);
    // source still spans both pages
    const sect = doc.GetStructTree()!.Children[0].Children[0];
    expect(sect.Children.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: FAIL — `out.GetStructTree()` is `null` (structure currently dropped), assertions throw.

- [ ] **Step 3: Implement `src/structpreserve.ts`**

Create `src/structpreserve.ts`:

```ts
import type { Document } from './document.js';
import { PdfObject, PdfDict, PdfRef, isDict, isArray, isRef, isName, ref, name } from './types.js';
import { lookupNumberTree } from './struct.js';

/** One copied page: where it came from and where it landed. */
export interface PageOrigin {
  srcDoc: Document;
  srcPageNum: number;   // source page object number in srcDoc
  newPageNum: number;   // resulting page object number in outDoc
}

const asNum = (o: PdfObject): number | undefined => (typeof o === 'number' ? o : undefined);

/** Accumulating state for the out-doc structure tree (created or extended). */
interface OutTree {
  rootDict: PdfDict;
  rootRef: PdfRef;
  topK: PdfObject[];      // /K of the root (cloned top-level elements)
  nums: PdfObject[];      // flat /ParentTree /Nums: [key, value, key, value, ...]
  nextKey: number;        // next /StructParents key to allocate
  roleMap: Map<string, string>;
}

/** Rebuild/extend outDoc's structure tree from the structure of the pages in
 *  `origins`. No-op when no source is tagged. */
export function preserveStructure(outDoc: Document, origins: PageOrigin[]): void {
  const bySrc = new Map<Document, PageOrigin[]>();
  for (const o of origins) {
    const list = bySrc.get(o.srcDoc) ?? [];
    list.push(o);
    bySrc.set(o.srcDoc, list);
  }

  let tree: OutTree | undefined;
  for (const [srcDoc, list] of bySrc) {
    const srcRoot = srcDoc.GetStructTree();
    if (!srcDoc.IsTagged || srcRoot === null) continue;
    tree ??= openOutTree(outDoc);
    cloneSource(outDoc, srcDoc, srcRoot.Dict, list, tree);
  }
  if (tree) finalizeTree(outDoc, tree);
}

/** Create a fresh /StructTreeRoot, or adopt an existing one for extension. */
function openOutTree(outDoc: Document): OutTree {
  const catalog = outDoc.catalog();
  const existingRef = catalog.get('StructTreeRoot');
  const existing = outDoc.resolve(existingRef);
  if (isRef(existingRef) && isDict(existing)) {
    const pt = outDoc.resolve(existing.get('ParentTree'));
    const ptNums = isDict(pt) ? outDoc.resolve(pt.get('Nums')) : null;
    const nums = isArray(ptNums) ? [...ptNums] : [];
    const nextKey = asNum(outDoc.resolve(existing.get('ParentTreeNextKey'))) ?? maxKey(nums) + 1;
    const k = outDoc.resolve(existing.get('K'));
    const topK = isArray(k) ? [...k] : k != null ? [existing.get('K') as PdfObject] : [];
    return { rootDict: existing, rootRef: existingRef, topK, nums, nextKey, roleMap: readRoleMap(outDoc, existing) };
  }
  const rootDict: PdfDict = new Map([['Type', name('StructTreeRoot')]]);
  const rootRef = outDoc.allocObject(rootDict);
  return { rootDict, rootRef, topK: [], nums: [], nextKey: 0, roleMap: new Map() };
}

function maxKey(nums: PdfObject[]): number {
  let m = -1;
  for (let i = 0; i < nums.length; i += 2) { const k = asNum(nums[i]); if (k !== undefined && k > m) m = k; }
  return m;
}

function readRoleMap(doc: Document, rootDict: PdfDict): Map<string, string> {
  const out = new Map<string, string>();
  const rm = doc.resolve(rootDict.get('RoleMap'));
  if (isDict(rm)) for (const [k, v] of rm) { const t = doc.resolve(v); if (isName(t)) out.set(k, t.name); }
  return out;
}

/** Clone the surviving structure of one source doc into the out tree. */
function cloneSource(outDoc: Document, srcDoc: Document, srcRootDict: PdfDict, origins: PageOrigin[], tree: OutTree): void {
  // src page obj num -> new page obj num (first occurrence wins; repeats untagged)
  const pageMap = new Map<number, number>();
  for (const o of origins) if (!pageMap.has(o.srcPageNum)) pageMap.set(o.srcPageNum, o.newPageNum);

  const srcPt = srcDoc.resolve(srcRootDict.get('ParentTree'));

  // Phase 1 — mark keep-set + collect each page's MCID->element array.
  const keep = new Set<number>();
  const pageArrays: { newPageNum: number; arr: PdfObject[] }[] = [];
  for (const [srcPageNum, newPageNum] of pageMap) {
    const srcPage = srcDoc.getObject(srcPageNum);
    const spKey = isDict(srcPage) ? asNum(srcDoc.resolve(srcPage.get('StructParents'))) : undefined;
    if (spKey === undefined || !isDict(srcPt)) continue;
    const arr = srcDoc.resolve(lookupNumberTree(srcDoc, srcPt, spKey));
    if (!isArray(arr)) continue;
    for (const e of arr) if (isRef(e)) markKeep(srcDoc, e.num, keep);
    pageArrays.push({ newPageNum, arr });
  }
  if (keep.size === 0) return;

  // Phase 2 — clone kept elements top-down from the root, preserving order.
  const cache = new Map<number, PdfRef>();   // src elem num -> new ref
  for (const k of childEntries(srcDoc, srcRootDict)) {
    if (isRef(k) && keep.has(k.num)) {
      const r = cloneElem(outDoc, srcDoc, k.num, pageMap, keep, cache, tree.rootRef);
      tree.topK.push(r);
    }
  }

  // Phase 3 — rebuild ParentTree entries with cloned refs + fresh keys.
  for (const { newPageNum, arr } of pageArrays) {
    const newArr = arr.map((e) => (isRef(e) && cache.has(e.num) ? cache.get(e.num)! : null));
    const newKey = tree.nextKey++;
    const newPage = outDoc.getObject(newPageNum);
    if (isDict(newPage)) newPage.set('StructParents', newKey);
    tree.nums.push(newKey, newArr);
  }
}

/** Add `num` and its /P ancestors (that are structure elements) to `keep`. */
function markKeep(srcDoc: Document, num: number, keep: Set<number>): void {
  let cur = num;
  while (!keep.has(cur)) {
    keep.add(cur);
    const d = srcDoc.getObject(cur);
    const p = isDict(d) ? d.get('P') : undefined;
    if (!isRef(p) || !isStructElemNum(srcDoc, p.num)) break;
    cur = p.num;
  }
}

/** Clone a kept element + its kept descendants; rebuild /K in source order. */
function cloneElem(
  outDoc: Document, srcDoc: Document, srcNum: number,
  pageMap: Map<number, number>, keep: Set<number>, cache: Map<number, PdfRef>, parentRef: PdfRef,
): PdfRef {
  const hit = cache.get(srcNum);
  if (hit) return hit;
  const src = srcDoc.getObject(srcNum) as PdfDict;
  const clone: PdfDict = new Map();
  const newRef = outDoc.allocObject(clone);
  cache.set(srcNum, newRef);

  for (const [key, val] of src) {
    if (key === 'K' || key === 'P' || key === 'Pg') continue;
    clone.set(key, deepCopy(outDoc, srcDoc, val, new Map()));
  }
  clone.set('P', parentRef);
  const pg = src.get('Pg');
  if (isRef(pg) && pageMap.has(pg.num)) clone.set('Pg', ref(pageMap.get(pg.num)!));

  const newK: PdfObject[] = [];
  for (const entry of childEntries(srcDoc, src)) {
    if (isRef(entry) && isStructElemNum(srcDoc, entry.num)) {
      if (keep.has(entry.num)) newK.push(cloneElem(outDoc, srcDoc, entry.num, pageMap, keep, cache, newRef));
    } else {
      const item = remapContentItem(outDoc, srcDoc, entry, pageMap);
      if (item !== undefined) newK.push(item);
    }
  }
  clone.set('K', newK);
  return newRef;
}

/** A content item in /K that is not a child element: integer MCID or MCR dict.
 *  (OBJR handled in a later task — dropped here.) Returns undefined to drop. */
function remapContentItem(outDoc: Document, srcDoc: Document, entry: PdfObject, pageMap: Map<number, number>): PdfObject | undefined {
  if (typeof entry === 'number') return entry; // MCID — content stream copied verbatim
  const d = srcDoc.resolve(entry);
  if (isDict(d) && isName(d.get('Type')) && (d.get('Type') as { name: string }).name === 'MCR') {
    const pg = d.get('Pg');
    if (isRef(pg) && !pageMap.has(pg.num)) return undefined; // MCR on a dropped page
    const copy = new Map(d);
    if (isRef(pg) && pageMap.has(pg.num)) copy.set('Pg', ref(pageMap.get(pg.num)!));
    return copy;
  }
  return undefined; // OBJR or unknown — dropped for now
}

/** /K entries of a struct element or the root, normalized to an array. */
function childEntries(doc: Document, dict: PdfDict): PdfObject[] {
  const k = dict.get('K');
  if (k === undefined) return [];
  const resolved = doc.resolve(k);
  return isArray(resolved) ? resolved : [k];
}

function isStructElemNum(doc: Document, num: number): boolean {
  const d = doc.getObject(num);
  return isDict(d) && d.has('S');
}

/** Deep-copy an attribute value into outDoc, allocating referenced objects.
 *  Struct attribute graphs are acyclic in practice (no cycle guard needed). */
function deepCopy(outDoc: Document, srcDoc: Document, val: PdfObject, cache: Map<number, PdfRef>): PdfObject {
  if (isRef(val)) {
    const hit = cache.get(val.num);
    if (hit) return hit;
    const copied = deepCopy(outDoc, srcDoc, srcDoc.getObject(val.num), cache);
    const r = outDoc.allocObject(copied);
    cache.set(val.num, r);
    return r;
  }
  if (isArray(val)) return val.map((v) => deepCopy(outDoc, srcDoc, v, cache));
  if (isDict(val)) { const m: PdfDict = new Map(); for (const [k, v] of val) m.set(k, deepCopy(outDoc, srcDoc, v, cache)); return m; }
  return val; // scalar / name / string
}

/** Install the accumulated tree into outDoc's catalog. */
function finalizeTree(outDoc: Document, tree: OutTree): void {
  tree.rootDict.set('K', tree.topK);
  const existingPt = outDoc.resolve(tree.rootDict.get('ParentTree'));
  if (isDict(existingPt)) existingPt.set('Nums', tree.nums);
  else tree.rootDict.set('ParentTree', outDoc.allocObject(new Map([['Nums', tree.nums]])));
  tree.rootDict.set('ParentTreeNextKey', tree.nextKey);
  if (tree.roleMap.size > 0) {
    const rm: PdfDict = new Map();
    for (const [k, v] of tree.roleMap) rm.set(k, name(v));
    tree.rootDict.set('RoleMap', rm);
  }
  const catalog = outDoc.catalog();
  catalog.set('StructTreeRoot', tree.rootRef);
  catalog.set('MarkInfo', new Map([['Marked', true]]));
}
```

> Note: `cloneSource` calls a `mergeRoleMap` in later tasks; for now the source RoleMap is read into the out tree only when the tree is created from a tagged source. Add this line at the end of `cloneSource` so Split/ExtractPages keep the RoleMap:
> ```ts
>   // carry the source RoleMap (single-source create case)
>   for (const [k, v] of readRoleMap(srcDoc, srcRootDict)) if (!tree.roleMap.has(k)) tree.roleMap.set(k, v);
> ```
> (Task 3 replaces this with full conflict-aware `mergeRoleMap`.)

- [ ] **Step 4: Wire Split and ExtractPages in `src/document.ts`**

Add the import near the other extractor import (~line 22):

```ts
import { preserveStructure, PageOrigin } from './structpreserve.js';
```

Extend `SplitOptions` (~line 61) and add `ExtractPagesOptions`:

```ts
export interface SplitOptions {
  /** Pruning policy applied while extracting each page's object graph. */
  prunePolicy?: PrunePolicy;
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}

export interface ExtractPagesOptions {
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}
```

Replace `Split` (~188-196):

```ts
  Split(options: SplitOptions = {}): Document[] {
    const policy = options.prunePolicy ?? defaultPrunePolicy();
    const preserve = options.preserveStructure ?? true;
    return this.Pages.map((page, i) => {
      const { objects, pageNum } = extractPage(this, page.Dict, policy);
      const { objects: full, rootNum } = assembleSinglePageDoc(objects, pageNum);
      const out = Document.fromObjects(full, rootNum);
      if (preserve) preserveStructure(out, [{ srcDoc: this, srcPageNum: this.pageObjNums[i], newPageNum: pageNum }]);
      return out;
    });
  }
```

Replace `ExtractPages` signature/body (~204-215) to thread options and origins:

```ts
  ExtractPages(numbers: number[], options: ExtractPagesOptions = {}): Document {
    const n = this.Pages.length;
    if (numbers.length === 0) throw new RangeError('ExtractPages: numbers must not be empty');
    for (const o of numbers)
      if (!Number.isInteger(o) || o < 1 || o > n)
        throw new RangeError(`ExtractPages: page number ${o} out of range 1..${n}`);
    const out = Document.createEmptyDocument();
    const selected = numbers.map((num) => this.Pages[num - 1]);
    const newNums = out.importPages(this, out.requireIndirectPagesRoot(), selected);
    out.syncPages(newNums.map((num) => ref(num)));
    if ((options.preserveStructure ?? true)) {
      const origins: PageOrigin[] = newNums.map((newNum, i) => ({
        srcDoc: this, srcPageNum: this.pageObjNums[selected[i].Number - 1], newPageNum: newNum,
      }));
      preserveStructure(out, origins);
    }
    return out;
  }
```

- [ ] **Step 5: Export `ExtractPagesOptions` from `src/index.ts`**

In `src/index.ts`, add `ExtractPagesOptions` to the existing `export type { SplitOptions, ... } from './document.js';` line:

```ts
export type { SplitOptions, ExtractPagesOptions, OpenOptions, SaveOptions } from './document.js';
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: PASS — Split slices, ExtractPages prune, and non-mutation tests all green. (Figure/OBJR is not asserted yet.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/structpreserve.ts src/document.ts src/index.ts test/structpreserve.test.ts
git commit -m "feat(struct): preserve structure on Split/ExtractPages (S2 core)"
```

---

## Task 3: Merge into an existing tree + RoleMap union/rename + wire Append/InsertPages/Merge

**Files:**
- Modify: `src/structpreserve.ts` (replace the inline RoleMap carry with `mergeRoleMap`; add rename-on-conflict)
- Modify: `src/document.ts` (`importPages` callers: `InsertPages`/`Append`, `Merge`; add `InsertPagesOptions`)
- Modify: `src/index.ts` (export `InsertPagesOptions`)
- Test: `test/structpreserve.test.ts`

**Interfaces:**
- Consumes: `preserveStructure`, `PageOrigin` (Task 2).
- Produces: `interface InsertPagesOptions { preserveStructure?: boolean; }`; `mergeRoleMap(srcDoc, srcRootDict, cache, tree)` renames source roles whose target conflicts with an existing different mapping and rewrites cloned elements' `/S`.

- [ ] **Step 1: Write failing tests**

Append to `test/structpreserve.test.ts`:

```ts
describe('structpreserve — Merge/Append', () => {
  test('merge of two tagged docs concatenates trees with non-colliding keys', () => {
    const a = Document.Open(buildMultiPageTaggedPdf()); // pages 1,2
    const b = Document.Open(buildMultiPageTaggedPdf()); // pages 1,2
    const merged = Document.Merge(a, b);
    expect(merged.Pages.length).toBe(4);
    const tree = merged.GetStructTree();
    expect(tree).not.toBeNull();
    // two Document roots (one per source)
    expect(tree!.Children.map((e) => e.Type)).toEqual(['Document', 'Document']);
    // every page's StructParents key is distinct
    const keys = merged.Pages.map((p) => p.Dict.get('StructParents'));
    expect(new Set(keys).size).toBe(keys.length);
    // each page resolves its own MCID 0 to a P
    for (const p of merged.Pages) {
      const k = p.Dict.get('StructParents') as number;
      expect(tree!.ElementFor(k, 0)?.Type).toBe('P');
    }
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).toContain('Page two body');
  });

  test('append onto a tagged doc grafts the source tree and keeps existing keys', () => {
    const a = Document.Open(buildMultiPageTaggedPdf());
    const b = Document.Open(buildMultiPageTaggedPdf());
    const beforeKeys = a.Pages.map((p) => p.Dict.get('StructParents'));
    a.Append(b);
    expect(a.Pages.length).toBe(4);
    // original pages keep their structure-parent keys
    expect(a.Pages.slice(0, 2).map((p) => p.Dict.get('StructParents'))).toEqual(beforeKeys);
    const tree = a.GetStructTree();
    expect(tree!.Children.map((e) => e.Type)).toEqual(['Document', 'Document']);
  });

  test('RoleMap conflict renames the source role and updates cloned /S', () => {
    const a = Document.Open(buildMultiPageTaggedPdf()); // RoleMap MyHead->H2
    const b = Document.Open(buildRoleConflictTaggedPdf()); // RoleMap MyHead->H3, a MyHead element
    const merged = Document.Merge(a, b);
    const rm = merged.GetStructTree()!.RoleMap;
    expect(rm.get('MyHead')).toBe('H2');       // a's mapping preserved
    expect(rm.get('MyHead_2')).toBe('H3');      // b's conflicting mapping renamed
    // the cloned element from b now uses the renamed role and still resolves to H3
    const text = JSON.stringify([...rm.entries()]);
    expect(text).toContain('MyHead_2');
  });
});
```

Add a small second fixture to `test/helpers/build-multipage-tagged-pdf.ts`:

```ts
/** One-page tagged PDF whose RoleMap maps MyHead -> H3 (conflicts with the
 *  multi-page fixture's MyHead -> H2) and has a MyHead element using it. */
export function buildRoleConflictTaggedPdf(): Uint8Array {
  const content = '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Conflict head) Tj ET\nEMC\n';
  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>`;
  o[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  o[4] = `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}endstream`;
  o[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  o[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /H3 >> /ParentTree 12 0 R >>`;
  o[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R] >>`;
  o[9] = `<< /Type /StructElem /S /MyHead /P 8 0 R /Pg 3 0 R /K 0 >>`;
  o[12] = `<< /Nums [0 [9 0 R]] >>`;
  const maxObj = 12;
  const enc = (s: string) => new TextEncoder().encode(s);
  const byteLen = (s: string) => enc(s).length;
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) { if (!o[n]) continue; offsets[n] = byteLen(body); body += `${n} 0 obj\n${o[n]}\nendobj\n`; }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += o[n] ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : `0000000000 65535 f \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

Import it in the test file: `import { buildMultiPageTaggedPdf, buildRoleConflictTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';`

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: FAIL — `Document.Merge`/`Append` produce untagged output (`GetStructTree()` null).

- [ ] **Step 3: Add conflict-aware `mergeRoleMap` in `src/structpreserve.ts`**

In `cloneSource`, replace the inline RoleMap carry added in Task 2 (the `for (const [k, v] of readRoleMap(srcDoc, srcRootDict)) ...` line from the Task 2 note) with this call (placed at the very end of `cloneSource`, after Phase 3):

```ts
  mergeRoleMap(outDoc, srcDoc, srcRootDict, cache, tree);
```

`cache` (the `src elem num -> new ref` map) and `outDoc` are both in scope there. Add this helper at the bottom of the module:

```ts
/** Union the source RoleMap into the out tree. On a key collision with a
 *  DIFFERENT target, rename the source role (suffix _2, _3, …) and rewrite the
 *  /S of every element cloned from this source that used the old name. */
function mergeRoleMap(
  outDoc: Document, srcDoc: Document, srcRootDict: PdfDict,
  cache: Map<number, PdfRef>, tree: OutTree,
): void {
  const srcRm = readRoleMap(srcDoc, srcRootDict);
  if (srcRm.size === 0) return;
  const renames = new Map<string, string>(); // old src role -> new unique role
  for (const [role, target] of srcRm) {
    const existing = tree.roleMap.get(role);
    if (existing === undefined) { tree.roleMap.set(role, target); continue; }
    if (existing === target) continue; // identical mapping — nothing to do
    let alt = role, i = 2;
    while (tree.roleMap.has(alt)) { alt = `${role}_${i++}`; }
    tree.roleMap.set(alt, target);
    renames.set(role, alt);
  }
  if (renames.size === 0) return;
  // Rewrite cloned elements' /S that used a renamed role.
  for (const newRef of cache.values()) {
    const elem = outDoc.getObject(newRef.num);
    if (!isDict(elem)) continue;
    const s = elem.get('S');
    if (isName(s) && renames.has(s.name)) elem.set('S', name(renames.get(s.name)!));
  }
}
```

- [ ] **Step 4: Wire Append/InsertPages and Merge in `src/document.ts`**

Add `InsertPagesOptions`:

```ts
export interface InsertPagesOptions {
  /** Preserve the source's tagged structure tree (default true). */
  preserveStructure?: boolean;
}
```

Replace `InsertPages` (~1213-1224), `Append` (~1229-1231), and `Merge` (~1235-1239):

```ts
  InsertPages(at: number, other: Document, options: InsertPagesOptions = {}): number[] {
    const rootNum = this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    if (!Number.isInteger(at) || at < 1 || at > n + 1)
      throw new RangeError(`InsertPages: position ${at} out of range 1..${n + 1}`);
    const newNums = this.importPages(other, rootNum);
    if (newNums.length === 0) return [];
    const kids = this.currentKids();
    kids.splice(at - 1, 0, ...newNums.map((num) => ref(num)));
    this.syncPages(kids);
    if ((options.preserveStructure ?? true)) {
      const origins: PageOrigin[] = newNums.map((newNum, i) => ({
        srcDoc: other, srcPageNum: other.pageObjNums[other.Pages[i].Number - 1], newPageNum: newNum,
      }));
      preserveStructure(this, origins);
    }
    return newNums.map((_, i) => at + i);
  }

  Append(other: Document, options: InsertPagesOptions = {}): number[] {
    return this.InsertPages(this.Pages.length + 1, other, options);
  }

  static Merge(...docs: Document[]): Document {
    const out = Document.createEmptyDocument();
    for (const d of docs) out.Append(d);
    return out;
  }
```

(`importPages` defaults `pages` to `other.Pages`, so `other.Pages[i]` aligns with `newNums[i]`. `Merge` preserves unconditionally via `Append`'s default.)

- [ ] **Step 5: Export `InsertPagesOptions`**

In `src/index.ts`:

```ts
export type { SplitOptions, ExtractPagesOptions, InsertPagesOptions, OpenOptions, SaveOptions } from './document.js';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: PASS — merge concatenation, key uniqueness, append grafting, RoleMap rename.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/structpreserve.ts src/document.ts src/index.ts test/structpreserve.test.ts test/helpers/build-multipage-tagged-pdf.ts
git commit -m "feat(struct): merge/append structure trees with RoleMap union (S2)"
```

---

## Task 4: OBJR / annotation structure re-keying

A surviving annotation that participates in structure (`/StructParent` → element, e.g. the `Figure`) must keep its structure. Because copied annotations are inlined into the page `/Annots` (by `sanitizeAnnots`), this task promotes such an annotation to an indirect object, re-keys it, wires the OBJR `/Obj` to it, and adds the object entry to `/ParentTree`.

**Files:**
- Modify: `src/structpreserve.ts`
- Test: `test/structpreserve.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–3.
- Produces: per-source object survivor map `srcAnnotNum -> { newRef, objKey }`; `remapContentItem` now resolves OBJR using it.

- [ ] **Step 1: Write failing tests**

Append to `test/structpreserve.test.ts`:

```ts
describe('structpreserve — OBJR / annotations', () => {
  test('surviving annotation keeps its Figure structure and re-keyed StructParent', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([1]); // page 1 carries the Figure + Link annot
    const tree = out.GetStructTree();
    const figure = tree!.Children[0].Children.find((e) => e.Type === 'Figure');
    expect(figure).toBeDefined();
    expect(figure!.Alt).toBe('A figure');
    // the OBJR resolves to a surviving annotation, re-keyed into the new ParentTree
    const items = figure!.ContentItems;
    const objr = items.find((it) => it.kind === 'objr');
    expect(objr).toBeDefined();
    const annot = out.resolve((objr as { ref: import('../src/types.js').PdfRef }).ref);
    expect((annot as Map<string, unknown>).get('StructParent')).toEqual(expect.any(Number));
    const key = (annot as Map<string, number>).get('StructParent')!;
    expect(tree!.ElementForObject(key)?.Type).toBe('Figure');
  });

  test('Figure on a dropped page is pruned entirely', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([2]); // page 2 has no Figure/annot
    const tree = out.GetStructTree();
    const types = tree!.Children[0].Children.map((e) => e.Type);
    expect(types).not.toContain('Figure');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/structpreserve.test.ts -t OBJR`
Expected: FAIL — Figure absent (OBJR currently dropped, and the Figure is reached only via the object key which Phase 1 does not scan).

- [ ] **Step 3: Implement OBJR handling in `src/structpreserve.ts`**

In `cloneSource`, insert the annotation scan **immediately after Phase 1's page loop and before the `if (keep.size === 0) return;` check** — an annotation-only page (Figure/OBJR, no MCID content) contributes nothing to `keep` in Phase 1, so the scan must run before that early return or its structure is lost. The scan (a) extends the keep-set with object-keyed elements and (b) builds the annotation survivor map. Add:

```ts
  // Object-keyed structure (annotations via /StructParent). Build a survivor map
  // keyed by the ELEMENT the annotation points to, and mark those elements keep.
  // New annots are inline dicts in the new page's /Annots, aligned by survivor
  // index with the source page's resolved annots.
  const objSurv = new Map<number, { newRef: PdfRef; objKey: number }>(); // src ELEMENT num -> info
  const srcRootForObj = srcDoc.GetStructTree()!; // non-null: caller checked IsTagged
  for (const [srcPageNum, newPageNum] of pageMap) {
    const srcPage = srcDoc.getObject(srcPageNum);
    const newPage = outDoc.getObject(newPageNum);
    if (!isDict(srcPage) || !isDict(newPage)) continue;
    const srcAnnots = srcDoc.resolve(srcPage.get('Annots'));
    const newAnnots = outDoc.resolve(newPage.get('Annots'));
    if (!isArray(srcAnnots) || !isArray(newAnnots)) continue;
    // survivors in source order (only dict-resolving entries were copied)
    let j = 0;
    for (const sa of srcAnnots) {
      const sd = srcDoc.resolve(sa);
      if (!isDict(sd)) continue;
      const newEntry = newAnnots[j++];          // aligned copy (inline dict or ref)
      const spk = asNum(srcDoc.resolve(sd.get('StructParent')));
      if (spk === undefined) continue;
      const elem = srcRootForObj.ElementForObject(spk);
      if (!elem || elem.Ref === undefined) continue;
      markKeep(srcDoc, elem.Ref.num, keep);
      // promote the new inline annot to an indirect object so OBJR can point at it
      const newAnnotDict = outDoc.resolve(newEntry);
      if (!isDict(newAnnotDict)) continue;
      const annotRef = isRef(newEntry) ? newEntry : outDoc.allocObject(newAnnotDict);
      if (!isRef(newEntry)) newAnnots[j - 1] = annotRef; // swap inline -> ref
      const objKey = tree.nextKey++;
      newAnnotDict.set('StructParent', objKey);
      objSurv.set(elem.Ref.num, { newRef: annotRef, objKey });
    }
  }
```

`objSurv` is keyed by the **element** object number (the element the annotation points to) — that is the key `remapContentItem` and Phase 3b look up.

Then, after Phase 2 clones elements, emit the ParentTree object entries:

```ts
  // Phase 3b — object entries: ParentTree[objKey] = cloned element ref.
  for (const [srcElemNum, info] of objSurv) {
    const cloned = cache.get(srcElemNum);
    if (cloned) tree.nums.push(info.objKey, cloned);
  }
```

Pass `objSurv` into `cloneElem`/`remapContentItem` so the OBJR `/Obj` is rewired. Change `cloneElem` to accept `objSurv` and forward it to `remapContentItem`, and update `remapContentItem`:

```ts
function remapContentItem(
  outDoc: Document, srcDoc: Document, entry: PdfObject,
  pageMap: Map<number, number>, objSurv: Map<number, { newRef: PdfRef; objKey: number }>, ownerSrcNum: number,
): PdfObject | undefined {
  if (typeof entry === 'number') return entry; // MCID
  const d = srcDoc.resolve(entry);
  if (!isDict(d) || !isName(d.get('Type'))) return undefined;
  const type = (d.get('Type') as { name: string }).name;
  if (type === 'MCR') {
    const pg = d.get('Pg');
    if (isRef(pg) && !pageMap.has(pg.num)) return undefined;
    const copy = new Map(d);
    if (isRef(pg) && pageMap.has(pg.num)) copy.set('Pg', ref(pageMap.get(pg.num)!));
    return copy;
  }
  if (type === 'OBJR') {
    const info = objSurv.get(ownerSrcNum);
    if (!info) return undefined; // annotation did not survive
    const copy = new Map(d);
    copy.set('Obj', info.newRef);
    const pg = d.get('Pg');
    if (isRef(pg) && pageMap.has(pg.num)) copy.set('Pg', ref(pageMap.get(pg.num)!));
    return copy;
  }
  return undefined;
}
```

`ownerSrcNum` is the source object number of the element whose `/K` is being rebuilt — pass `srcNum` from `cloneElem`. Update the `remapContentItem` call inside `cloneElem`:

```ts
      const item = remapContentItem(outDoc, srcDoc, entry, pageMap, objSurv, srcNum);
```

Thread `objSurv: Map<number, { newRef: PdfRef; objKey: number }>` through `cloneElem`'s parameter list, and update **all three** call sites to pass it:
- the **Phase 2 top-level** call in `cloneSource`: `cloneElem(outDoc, srcDoc, k.num, pageMap, keep, cache, objSurv, tree.rootRef)`
- the **recursive** child call inside `cloneElem`: `cloneElem(outDoc, srcDoc, entry.num, pageMap, keep, cache, objSurv, newRef)`

(Place `objSurv` before `parentRef` in the signature so the parameter order matches both call sites.)

- [ ] **Step 4: Run OBJR tests + full file**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: PASS — Figure preserved with re-keyed annotation; Figure pruned when its page is dropped; all earlier tests still green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/structpreserve.ts test/structpreserve.test.ts
git commit -m "feat(struct): preserve OBJR/annotation structure across page ops (S2)"
```

---

## Task 5: Opt-out, AddPage/InsertPage, untagged, Reorder regression, docs, full gate

**Files:**
- Modify: `src/document.ts` (`importPage` caller wiring for `AddPage`/`InsertPage`)
- Modify: `README.md`
- Test: `test/structpreserve.test.ts`

**Interfaces:**
- Consumes: `preserveStructure`, `PageOrigin`.

- [ ] **Step 1: Write failing tests**

Append to `test/structpreserve.test.ts`:

```ts
describe('structpreserve — opt-out, untagged, AddPage, Reorder', () => {
  test('opt-out drops structure on Split and ExtractPages', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.Split({ preserveStructure: false })[0].GetStructTree()).toBeNull();
    expect(doc.ExtractPages([1], { preserveStructure: false }).GetStructTree()).toBeNull();
  });

  test('untagged source yields untagged output', () => {
    const doc = Document.Open(buildClassicPdf(2));
    expect(doc.IsTagged).toBe(false);
    expect(doc.Split()[0].GetStructTree()).toBeNull();
    expect(doc.ExtractPages([1]).GetStructTree()).toBeNull();
    expect(Document.Merge(doc, doc).GetStructTree()).toBeNull();
  });

  test('AddPage(source) carries the page structure into a fresh doc', () => {
    const src = Document.Open(buildMultiPageTaggedPdf());
    const dst = Document.Merge(); // empty, untagged
    dst.AddPage(src.Pages[0]);
    const tree = dst.GetStructTree();
    expect(tree).not.toBeNull();
    expect(tree!.GetText()).toContain('Page one body');
  });

  test('Reorder leaves the existing structure tree intact and resolvable', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    doc.Reorder([2, 1]);
    const tree = doc.GetStructTree();
    expect(tree).not.toBeNull();
    // both pages still resolve their MCID 0 to a P
    for (const p of doc.Pages) {
      const k = p.Dict.get('StructParents') as number;
      expect(tree!.ElementFor(k, 0)?.Type).toBe('P');
    }
  });
});
```

> Add `buildClassicPdf` to the test file's imports: `import { buildClassicPdf } from './helpers/build-pdf.js';` (existing untagged classic-xref builder; `buildClassicPdf(n)` makes an `n`-page untagged PDF).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/structpreserve.test.ts -t "opt-out|AddPage"`
Expected: FAIL — AddPage produces untagged output (no wiring yet); opt-out tests pass already (flags exist) but AddPage fails.

- [ ] **Step 3: Wire AddPage/InsertPage in `src/document.ts`**

Replace `InsertPage` (~1127-1139) so a copied source page carries its structure:

```ts
  InsertPage(at: number, source?: Page): { page: Page; number: number } {
    const rootNum = this.requireIndirectPagesRoot();
    const n = this.Pages.length;
    if (!Number.isInteger(at) || at < 1 || at > n + 1)
      throw new RangeError(`InsertPage: position ${at} out of range 1..${n + 1}`);
    const kids = this.currentKids();
    const newNum = source === undefined
      ? this.createBlankPage(rootNum)
      : this.importPage(source.Document, source.Dict, rootNum);
    kids.splice(at - 1, 0, ref(newNum));
    this.syncPages(kids);
    if (source !== undefined) {
      const srcDoc = source.Document;
      preserveStructure(this, [{ srcDoc, srcPageNum: srcDoc.pageObjNums[source.Number - 1], newPageNum: newNum }]);
    }
    return { page: this.Pages[at - 1], number: at };
  }
```

(`AddPage` delegates to `InsertPage`, so it is covered. `source.Document.pageObjNums` is private but accessible — same class.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/structpreserve.test.ts`
Expected: PASS — opt-out, untagged (or skipped), AddPage, Reorder.

- [ ] **Step 5: Update README**

In `README.md`, under Features add a bullet noting tagged structure now survives split/extract/merge; under Limitations note: "A page copied multiple times in a single extract carries structure only on its first occurrence." Match the existing bullet style (find the page-operations / structure section and insert alongside it).

- [ ] **Step 6: Full suite + typecheck + build**

Run: `npm test`
Expected: entire suite green (no regressions in split/merge/extract/struct read-model tests).

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: builds to `dist/` with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts README.md test/structpreserve.test.ts
git commit -m "feat(struct): structure preservation on AddPage + opt-out, docs (S2)"
```

---

## Final Verification

- [ ] `npm test` — full suite green.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean.
- [ ] `bd close aspose-pdf-foss-for-ts-pjx.2` with a summary of what shipped.
- [ ] Session-close protocol: `git pull --rebase && git push && git status` shows up to date.

## Self-Review Notes (for the implementer)

- **Spec coverage:** Split/ExtractPages (Task 2), Merge/Append/InsertPages + RoleMap union/rename (Task 3), OBJR/annotations (Task 4), AddPage/InsertPage + opt-out + untagged + Reorder regression + docs (Task 5). `/ParentTree` rebuild, fresh `/StructParents` keys, `/Pg` remap, ancestor-closure pruning, first-occurrence repeated-page rule — all in Task 2's core.
- **Repeated-page limitation:** `pageMap` keeps the first `srcPageNum` occurrence, so a page copied twice in one `ExtractPages` call tags only the first copy — matches the spec. (No dedicated test is required, but `ExtractPages([1,1])` must not throw; if you add a guard test, assert the second page has no `StructParents`.)
- **Method/type names are stable across tasks:** `preserveStructure`, `PageOrigin`, `cloneSource`, `cloneElem`, `remapContentItem`, `markKeep`, `mergeRoleMap`, `deepCopy`, `finalizeTree`, `openOutTree`, `OutTree`, `asNum`, `childEntries`, `isStructElemNum`. `ExtractPagesOptions` / `InsertPagesOptions` / `SplitOptions.preserveStructure` are the public opt-out surface.
- **Merge opt-out:** `Merge` preserves unconditionally (it builds via `Append`'s default-true flag); there is no `Merge` options param because of its rest-parameter signature. To merge without structure, `Append(d, { preserveStructure: false })` into an empty doc.
```
