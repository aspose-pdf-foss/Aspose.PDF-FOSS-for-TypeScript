# Document.Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free `splitPdf` function with `Document.Split(options?): Document[]` (one from-scratch single-page Document per page), remove `Page.Save`, and teach `Document.save()` to serialize a freshly built document.

**Architecture:** Add a "built document" mode to `Document`: a private `fromObjects(objects, rootNum)` factory holds an in-memory object set with no backing file, `getObject` reads from it, and `save()` serializes it from scratch via a generalized `writePdf(objects, rootNum)`. `Split` extracts each page's object graph (`extractPage`), assembles a `/Catalog` + `/Pages` around it, and wraps it as a built Document.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-document-split-design.md`

## File Structure

- **Modify `src/writer.ts`** — add `writePdf(objects, rootNum)` (pure full-document serializer); later remove the old `writeSinglePagePdf`.
- **Modify `src/document.ts`** — built-document mode (constructor param, `getObject` branch, `save()` branch, `fromObjects`), the `assembleSinglePageDoc` helper, the `SplitOptions` interface, and the `Split` method.
- **Modify `src/page.ts`** — remove `Save` + `PageSaveOptions` + now-unused imports.
- **Delete `src/split.ts`** — `splitPdf`/old `SplitOptions` removed.
- **Modify `src/index.ts`** — drop `splitPdf`, the split-sourced `SplitOptions`, and `PageSaveOptions`; re-export `SplitOptions` from `document.js`.
- **Modify `src/node.ts`** — reimplement `splitPdfFile` on top of `Document.Split`.
- **Modify tests** — `test/split.test.ts` (rewrite to `Document.Split`), `test/page.test.ts` (drop Save blocks), `test/writer.test.ts` (switch to `writePdf`).

The work is sequenced so the full suite stays green after every task: the new API is added first (Task 1), then old surfaces are removed one at a time (Tasks 2–4).

---

### Task 1: Built-document mode, `writePdf`, and `Document.Split`

**Files:**
- Modify: `src/writer.ts`
- Modify: `src/document.ts`
- Test: `test/split.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/split.test.ts`:

```ts
describe('Document.Split', () => {
  const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

  it('splits a 3-page classic pdf into 3 single-page Documents', () => {
    const docs = Document.Open(buildClassicPdf(3)).Split();
    expect(docs.length).toBe(3);
    for (const d of docs) expect(d.Pages.length).toBe(1);
  });

  it('each split Document round-trips through save() to a 1-page pdf', () => {
    const docs = Document.Open(buildClassicPdf(3)).Split();
    for (const d of docs) expect(Document.Open(d.save()).Pages.length).toBe(1);
  });

  it('preserves page content bytes', () => {
    const docs = Document.Open(buildClassicPdf(2)).Split();
    expect(dec(docs[1].save()).includes('Page 2')).toBe(true);
  });

  it('splits an xref-stream pdf', () => {
    const docs = Document.Open(buildXrefStreamPdf()).Split();
    expect(docs.length).toBe(1);
    expect(Document.Open(docs[0].save()).Pages.length).toBe(1);
  });

  it('returns an empty array for a zero-page document', () => {
    expect(Document.Open(buildClassicPdf(0)).Split().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- split.test`
Expected: FAIL — `Document.Open(...).Split is not a function`.

- [ ] **Step 3a: Add `writePdf` to `src/writer.ts`**

Add this function to `src/writer.ts` (leave the existing `writeSinglePagePdf` in place for now — it is removed in Task 4). The file's current imports are:

```ts
import { PdfObject, PdfDict, isDict } from './types.js';
import { enc, serializeObject } from './serialize.js';
```

Leave them as-is and append this function at the end of the file:

```ts
/** Serialize a complete object set (keys 1..max) into a PDF with the given /Root. */
export function writePdf(objects: Map<number, PdfObject>, rootNum: number): Uint8Array {
  const maxNum = Math.max(...objects.keys());
  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array) => { chunks.push(b); length += b.length; };

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  const offsets = new Map<number, number>();
  for (let n = 1; n <= maxNum; n++) {
    const obj = objects.get(n);
    if (obj === undefined) continue;
    offsets.set(n, length);
    push(enc(`${n} 0 obj\n`));
    push(serializeObject(obj));
    push(enc('\nendobj\n'));
  }

  const xrefStart = length;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n);
    xref += off === undefined ? `0000000000 65535 f \n` : `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${maxNum + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
```

- [ ] **Step 3b: Add built-document mode + `Split` to `src/document.ts`**

Add these imports. The current import block ends with:

```ts
import { buildPages, PageTree } from './pagetree.js';
import { readFileSync } from 'node:fs';
```

Insert after the `buildPages` line (before the `readFileSync` line):

```ts
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writePdf } from './writer.js';
```

Add the `SplitOptions` interface and the `assembleSinglePageDoc` helper at module scope, immediately above `export class Document {`:

```ts
export interface SplitOptions {
  /** Pruning policy applied while extracting each page's object graph. */
  prunePolicy?: PrunePolicy;
}

/** Wrap a renumbered single-page object set in a /Pages node + /Catalog.
 *  Returns the full object set and the catalog's object number (the /Root). */
function assembleSinglePageDoc(
  objects: Map<number, PdfObject>, pageObjNum: number,
): { objects: Map<number, PdfObject>; rootNum: number } {
  const maxExisting = Math.max(...objects.keys());
  const pagesNum = maxExisting + 1;
  const catalogNum = maxExisting + 2;
  const page = objects.get(pageObjNum);
  if (isDict(page)) page.set('Parent', ref(pagesNum));
  const pagesNode: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pages')],
    ['Count', 1],
    ['Kids', [ref(pageObjNum)]],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Catalog')],
    ['Pages', ref(pagesNum)],
  ]);
  const all = new Map(objects);
  all.set(pagesNum, pagesNode);
  all.set(catalogNum, catalog);
  return { objects: all, rootNum: catalogNum };
}
```

Add a `built` field and extend the constructor. The current field block + constructor is:

```ts
  /** Set by Reorder(); triggers a page-tree rewrite in save(). */
  private pageOrderChanged = false;

  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {
    const tree: PageTree = buildPages(this);
    this.Pages = tree.pages;
    this.pageObjNums = tree.pageObjNums;
    this.rootPagesNum = tree.rootPagesNum;
  }
```

Replace it with:

```ts
  /** Set by Reorder(); triggers a page-tree rewrite in save(). */
  private pageOrderChanged = false;

  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
    /** Present for documents built in memory (e.g. Split); save() serializes it from scratch. */
    private readonly built?: { objects: Map<number, PdfObject>; rootNum: number },
  ) {
    const tree: PageTree = buildPages(this);
    this.Pages = tree.pages;
    this.pageObjNums = tree.pageObjNums;
    this.rootPagesNum = tree.rootPagesNum;
  }

  /** Build an in-memory document from a complete object set rooted at `rootNum`. */
  private static fromObjects(objects: Map<number, PdfObject>, rootNum: number): Document {
    const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(rootNum)]]);
    return new Document(new Uint8Array(0), new Map(), trailer, { objects, rootNum });
  }

  /** Split into one new single-page Document per page, in page order. */
  Split(options: SplitOptions = {}): Document[] {
    const policy = options.prunePolicy ?? defaultPrunePolicy();
    return this.Pages.map((page) => {
      const { objects, pageNum } = extractPage(this, page.Dict, policy);
      const { objects: full, rootNum } = assembleSinglePageDoc(objects, pageNum);
      return Document.fromObjects(full, rootNum);
    });
  }
```

Make `getObject` read from the built set. The current method begins:

```ts
  getObject(num: number): PdfObject {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
```

Replace those three lines with (adds the built-mode branch first):

```ts
  getObject(num: number): PdfObject {
    if (this.built) return this.built.objects.get(num) ?? null;
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
```

Make `save()` serialize a built document from scratch. The current method begins:

```ts
  save(): Uint8Array {
    if (this.infoState === 'unchanged' && !this.pageOrderChanged) return this.buf;
```

Replace those two lines with (adds the built-mode branch first):

```ts
  save(): Uint8Array {
    if (this.built) return writePdf(this.built.objects, this.built.rootNum);
    if (this.infoState === 'unchanged' && !this.pageOrderChanged) return this.buf;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- split.test`
Expected: PASS — the original `splitPdf` describe (still present) and the new `Document.Split` describe both pass.

- [ ] **Step 5: Commit**

```bash
git add src/writer.ts src/document.ts test/split.test.ts
git commit -m "feat: add built-document mode, writePdf, and Document.Split"
```

---

### Task 2: Remove `Page.Save` and `PageSaveOptions`

**Files:**
- Modify: `src/page.ts`
- Test: `test/page.test.ts`

- [ ] **Step 1: Remove the Save test blocks from `test/page.test.ts`**

Delete everything from line 89 to the end of the file. The lines to delete are:

```ts
import { defaultPrunePolicy } from '../src/extractor.js';

describe('Page.Save', () => {
  it('saves a single page that re-parses to one page with its content', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const bytes = doc.Pages[1].Save();
    const reopened = Document.Open(bytes);
    expect(reopened.Pages.length).toBe(1);
    expect(dec(reopened.Pages[0].Contents)).toContain('Page 2');
  });

  it('passes a custom prune policy through to extraction', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const policy = defaultPrunePolicy();
    policy.dropPageKeys.add('Type'); // not dropped by default
    const bytes = doc.Pages[0].Save({ prunePolicy: policy });
    const reopened = Document.Open(bytes);
    expect(reopened.Pages[0].Dict.has('Type')).toBe(false);
  });
});

describe('Page.Save via index', () => {
  it('is reachable on Page constructed through the public API', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const opts: api.PageSaveOptions = {};
    expect(doc.Pages[0].Save(opts).length).toBeGreaterThan(0);
  });
});
```

The file now ends at line 87 (the `index exports` describe checking `api.Page`). The `dec` helper defined near the top is still used by the remaining `Page` content tests, so leave it.

- [ ] **Step 2: Run the page tests to verify they fail to compile / fail**

Run: `npm test -- page.test`
Expected: PASS for the remaining cases — but note the goal of this step is that the suite still references `Save` nowhere. (If you run before editing `page.ts`, it still passes because `Save` exists; the real check is Step 4 after removal.)

- [ ] **Step 3: Remove `Save` + `PageSaveOptions` from `src/page.ts`**

The current top of `src/page.ts` is:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfStream, isArray, isDict, isStream } from './types.js';
import { inflateStream } from './flate.js';
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writeSinglePagePdf } from './writer.js';

export interface PageSaveOptions {
  /** Pruning policy applied while extracting the page's object graph. */
  prunePolicy?: PrunePolicy;
}

/** A single PDF page: a typed, read-only view over a materialized page dict. */
export class Page {
```

Replace that whole block with (drops the extractor/writer imports and the `PageSaveOptions` interface):

```ts
import type { Document } from './document.js';
import { PdfDict, PdfStream, isArray, isDict, isStream } from './types.js';
import { inflateStream } from './flate.js';

/** A single PDF page: a typed, read-only view over a materialized page dict. */
export class Page {
```

Then delete the `Save` method at the end of the class. The current code is:

```ts
  /** Serialize this page to a self-contained single-page PDF. */
  Save(options: PageSaveOptions = {}): Uint8Array {
    const policy = options.prunePolicy ?? defaultPrunePolicy();
    const { objects, pageNum } = extractPage(this.doc, this.Dict, policy);
    return writeSinglePagePdf(objects, pageNum);
  }
}
```

Replace it with just the closing brace:

```ts
}
```

- [ ] **Step 4: Run the page tests to verify they pass**

Run: `npm test -- page.test`
Expected: PASS — the `Page` view tests and the `index exports` (`api.Page`) test remain green; nothing references `Save` or `PageSaveOptions`.

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "refactor: remove Page.Save and PageSaveOptions"
```

---

### Task 3: Replace `splitPdf` with `Document.Split` across the codebase

**Files:**
- Delete: `src/split.ts`
- Modify: `src/index.ts`
- Modify: `src/node.ts`
- Test: `test/split.test.ts`

- [ ] **Step 1: Rewrite `test/split.test.ts` to drop the old `splitPdf` describe**

The current top of `test/split.test.ts` is:

```ts
import { describe, it, expect } from 'vitest';
import { splitPdf } from '../src/split.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';

function pageCount(pdf: Uint8Array): number {
  return buildPages(Document.Open(pdf)).pages.length;
}

describe('splitPdf', () => {
  it('splits a 3-page classic pdf into 3 single-page pdfs', () => {
    const out = splitPdf(buildClassicPdf(3));
    expect(out.length).toBe(3);
    for (const p of out) expect(pageCount(p)).toBe(1);          // round-trip invariant
  });
  it('splits an xref-stream pdf', () => {
    const out = splitPdf(buildXrefStreamPdf());
    expect(out.length).toBe(1);
    expect(pageCount(out[0])).toBe(1);
  });
  it('preserves page content bytes', () => {
    const out = splitPdf(buildClassicPdf(2));
    const s = new TextDecoder('latin1').decode(out[1]);
    expect(s.includes('Page 2')).toBe(true);                   // 2nd output has 2nd page content
  });
  it('returns empty array for zero-page document', () => {
    // buildClassicPdf(0) emits a valid catalog with an empty Pages tree.
    expect(splitPdf(buildClassicPdf(0)).length).toBe(0);
  });
});
```

Replace that entire block (down to and including the closing `});` of the `splitPdf` describe) with:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
```

Leave the `describe('Document.Split', ...)` block (added in Task 1) untouched below it.

- [ ] **Step 2: Run the split tests to verify they still pass**

Run: `npm test -- split.test`
Expected: PASS — only the `Document.Split` describe remains and it is green.

- [ ] **Step 3: Delete `src/split.ts`**

Run: `git rm src/split.ts`

- [ ] **Step 4: Update `src/index.ts`**

The current `src/index.ts` is:

```ts
export { splitPdf } from './split.js';
export type { SplitOptions } from './split.js';
export { defaultPrunePolicy } from './extractor.js';
export type { PrunePolicy } from './extractor.js';
export { PdfParseError, UnsupportedFeatureError } from './errors.js';
export { splitPdfFile, readMetadataFile, updateMetadataFile, clearMetadataFile } from './node.js';
export { Document } from './document.js';
export { Page } from './page.js';
export type { PageSaveOptions } from './page.js';
export type { Metadata, MetadataUpdate } from './metadata.js';
```

Replace it with (drops `splitPdf`, the split-sourced `SplitOptions`, and `PageSaveOptions`; re-exports `SplitOptions` from `document.js`):

```ts
export { defaultPrunePolicy } from './extractor.js';
export type { PrunePolicy } from './extractor.js';
export { PdfParseError, UnsupportedFeatureError } from './errors.js';
export { splitPdfFile, readMetadataFile, updateMetadataFile, clearMetadataFile } from './node.js';
export { Document } from './document.js';
export type { SplitOptions } from './document.js';
export { Page } from './page.js';
export type { Metadata, MetadataUpdate } from './metadata.js';
```

- [ ] **Step 5: Reimplement `splitPdfFile` in `src/node.ts`**

The current top of `src/node.ts` is:

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitPdf, SplitOptions } from './split.js';
import { Document } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';

/** Read a PDF from disk, split it, and write `page-N.pdf` files into `outDir`. */
export async function splitPdfFile(inputPath: string, outDir: string, options?: SplitOptions): Promise<string[]> {
  const input = new Uint8Array(await readFile(inputPath));
  const pages = splitPdf(input, options);
  await mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = join(outDir, `page-${i + 1}.pdf`);
    await writeFile(p, pages[i]);
    paths.push(p);
  }
  return paths;
}
```

Replace it with (imports `SplitOptions` from `document.js`, splits into Documents, serializes each with `save()`):

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Document, SplitOptions } from './document.js';
import { Metadata, MetadataUpdate } from './metadata.js';

/** Read a PDF from disk, split it, and write `page-N.pdf` files into `outDir`. */
export async function splitPdfFile(inputPath: string, outDir: string, options?: SplitOptions): Promise<string[]> {
  const input = new Uint8Array(await readFile(inputPath));
  const docs = Document.Open(input).Split(options);
  await mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < docs.length; i++) {
    const p = join(outDir, `page-${i + 1}.pdf`);
    await writeFile(p, docs[i].save());
    paths.push(p);
  }
  return paths;
}
```

- [ ] **Step 6: Run the affected suites to verify they pass**

Run: `npm test -- split.test node.test`
Expected: PASS — `Document.Split` and `splitPdfFile` (writes `page-1.pdf` / `page-2.pdf`) are green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/node.ts test/split.test.ts
git commit -m "refactor: replace splitPdf with Document.Split; delete split.ts"
```

---

### Task 4: Remove the dead `writeSinglePagePdf` and switch its test to `writePdf`

**Files:**
- Modify: `src/writer.ts`
- Test: `test/writer.test.ts`

- [ ] **Step 1: Rewrite `test/writer.test.ts` to exercise `writePdf`**

Replace the entire contents of `test/writer.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { writePdf } from '../src/writer.js';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';
import { isName, name, ref } from '../src/types.js';

describe('writePdf', () => {
  it('serializes a complete object set into a parseable single-page pdf', () => {
    const content = new TextEncoder().encode('BT /F1 12 Tf (x) Tj ET');
    const page = new Map<string, any>([
      ['Type', name('Page')],
      ['Parent', ref(3)],
      ['MediaBox', [0, 0, 100, 100]],
      ['Resources', new Map()],
      ['Contents', ref(2)],
    ]);
    const stream = { kind: 'stream', dict: new Map([['Length', content.length]]), raw: content };
    const pages = new Map<string, any>([
      ['Type', name('Pages')],
      ['Count', 1],
      ['Kids', [ref(1)]],
    ]);
    const catalog = new Map<string, any>([
      ['Type', name('Catalog')],
      ['Pages', ref(3)],
    ]);
    const objects = new Map<number, any>([[1, page], [2, stream], [3, pages], [4, catalog]]);
    const pdf = writePdf(objects, 4);

    const built = buildPages(Document.Open(pdf)).pages;
    expect(built.length).toBe(1);
    const type = built[0].Dict.get('Type');
    expect(isName(type!) && (type as any).name).toBe('Page');
  });
});
```

- [ ] **Step 2: Run the writer test to verify it passes against `writePdf`**

Run: `npm test -- writer.test`
Expected: PASS — `writePdf` was added in Task 1, so the rewritten test is already green. (This is a cleanup task: `writeSinglePagePdf` still exists but now has no importers; Step 3 removes it and Step 4 confirms via typecheck.)

- [ ] **Step 3: Remove `writeSinglePagePdf` from `src/writer.ts`**

Delete the entire `writeSinglePagePdf` function (the original function spanning its doc comment through its closing brace) and tidy the imports. After deletion `src/writer.ts` should contain only the `writePdf` function added in Task 1, with this import line at the top:

```ts
import { PdfObject } from './types.js';
import { enc, serializeObject } from './serialize.js';
```

(`PdfDict` and `isDict` were only used by the removed `writeSinglePagePdf`.)

- [ ] **Step 4: Type-check and run the writer test**

Run: `npm run typecheck`
Expected: no errors (no remaining references to `writeSinglePagePdf`).

Run: `npm test -- writer.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/writer.ts test/writer.test.ts
git commit -m "refactor: drop writeSinglePagePdf in favor of writePdf"
```

---

### Task 5: Full verification + close issue

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors, exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: every suite passes. Pay attention to `split`, `page`, `writer`, and `node` suites — all should be green with no references to `splitPdf`, `Page.Save`, `PageSaveOptions`, or `writeSinglePagePdf`.

- [ ] **Step 3: Confirm the removed symbols are gone**

Run: `git grep -nE "splitPdf\b|writeSinglePagePdf|PageSaveOptions|\.Save\(" -- src test`
Expected: no matches (`splitPdfFile` is a different token and must NOT match `splitPdf\b`; verify none of the listed symbols remain).

- [ ] **Step 4: Close the beads issue and commit tracker state**

Scope the commit to tracker dirs only — do NOT `git add -A` (it would sweep the `_my/` scratch dirs into history).

```bash
bd close aspose-pdf-foss-for-ts-k0c --reason="Replaced splitPdf with Document.Split (built-document mode + writePdf); removed Page.Save/PageSaveOptions; typecheck + full suite green"
git add .beads
git commit -m "chore: beads close Document.Split issue"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Built-document mode (`fromObjects`, `getObject` branch, `save()` branch) — Task 1 Step 3b.
  - `writePdf` pure serializer — Task 1 Step 3a; old `writeSinglePagePdf` removed — Task 4.
  - `Document.Split(options?): Document[]` + `assembleSinglePageDoc` + `SplitOptions` (prunePolicy preserved) — Task 1 Step 3b.
  - 0-page → `[]` — covered by Split impl + Task 1 test.
  - Remove `Page.Save` + `PageSaveOptions` + unused imports — Task 2.
  - Delete `src/split.ts`; index export changes (drop `splitPdf`/`PageSaveOptions`, re-export `SplitOptions` from document) — Task 3 Steps 3–4.
  - `node.splitPdfFile` reimplemented via `Document.Split().map(save())` — Task 3 Step 5.
  - Test updates (split rewrite, page Save blocks removed, writer→writePdf) — Tasks 1/3 (split), 2 (page), 4 (writer).
- **Type/name consistency:** `Document.Split`, `SplitOptions { prunePolicy?: PrunePolicy }` (from `document.js`), `Document.fromObjects(objects, rootNum)`, `assembleSinglePageDoc(objects, pageObjNum): { objects, rootNum }`, `writePdf(objects, rootNum)` are used identically across tasks. `built?: { objects; rootNum }` field name matches `getObject`/`save` usage.
- **No placeholders:** every code step shows full code; every run step states the expected result.
- **Green-at-each-commit ordering:** Task 1 adds new API while old surfaces still exist; Tasks 2–4 remove old surfaces one subsystem at a time, each with its suite re-run.
