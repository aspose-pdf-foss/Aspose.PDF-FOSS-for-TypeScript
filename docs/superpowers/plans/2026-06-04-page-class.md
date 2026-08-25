# Page Class & Document.Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Page` class (Aspose-style PascalCase surface) and a populated `Document.Pages: readonly Page[]` property built eagerly in `open()`, unifying the existing `listPages`/`PageRef` machinery onto `Page`.

**Architecture:** New `src/page.ts` holds the `Page` class — a thin wrapper over a materialized page dict that reads typed values lazily via the owning document's `resolve`. `src/pagetree.ts` is refactored so its walk emits `Page` objects (`buildPages`, replacing `listPages`/`PageRef`). `Document`'s constructor calls `buildPages(this)` and stores the result in a readonly `Pages` field, so `open()` returns a document with `Pages` ready.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), Vitest, Node built-in `zlib` (already used for inflate via `src/flate.ts`).

**Spec:** `docs/superpowers/specs/2026-06-04-page-class-design.md`

## File Structure

- **Create `src/page.ts`** — the `Page` class and its getters. One responsibility: present a single page's typed view.
- **Modify `src/pagetree.ts`** — tree walk + inheritance stays; rename `listPages` → `buildPages` returning `Page[]`; delete the `PageRef` interface; switch the `Document` import to `import type`.
- **Modify `src/document.ts`** — add `readonly Pages: Page[]`, assign it in the constructor via `buildPages(this)`.
- **Modify `src/split.ts`** — consume `doc.Pages` / `page.Dict`.
- **Modify `src/index.ts`** — export `Page`.
- **Modify tests** — `test/pagetree.test.ts`, `test/extractor.test.ts`, `test/writer.test.ts`, `test/split.test.ts` move from `listPages(...).dict` to `buildPages(...).Dict`.
- **Create `test/page.test.ts`** — unit tests for the `Page` class (self-contained, hand-built dicts).

---

### Task 1: Create the `Page` class

**Files:**
- Create: `src/page.ts`
- Test: `test/page.test.ts`

The `Page` tests are deliberately self-contained: they construct a `Page` from a
hand-built materialized dict with **inline** objects (not indirect refs), so they
do not depend on the page-tree walk (which still emits `PageRef` until Task 2).
`doc.resolve` returns non-ref values unchanged, so any opened document works as
the owner.

- [ ] **Step 1: Write the failing tests**

Create `test/page.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { Page } from '../src/page.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { PdfDict, PdfStream, name } from '../src/types.js';

// Any opened document works as the owner; resolve() returns inline values as-is.
const doc = Document.open(buildClassicPdf(1));
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

function rawStream(text: string): PdfStream {
  const raw = new TextEncoder().encode(text);
  return { kind: 'stream', dict: new Map([['Length', raw.length]]), raw };
}

function flateStream(text: string): PdfStream {
  const raw = new Uint8Array(deflateSync(Buffer.from(text)));
  return {
    kind: 'stream',
    dict: new Map<string, any>([['Filter', name('FlateDecode')], ['Length', raw.length]]),
    raw,
  };
}

describe('Page', () => {
  it('exposes Number and Dict from construction', () => {
    const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
    const page = new Page(doc, dict, 7);
    expect(page.Number).toBe(7);
    expect(page.Dict).toBe(dict);
  });

  it('reads MediaBox, and CropBox/Rect fall back to it', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
    const page = new Page(doc, dict, 1);
    expect(page.MediaBox).toEqual([0, 0, 200, 200]);
    expect(page.CropBox).toEqual([0, 0, 200, 200]);
    expect(page.Rect).toEqual([0, 0, 200, 200]);
  });

  it('defaults MediaBox to US Letter when absent', () => {
    const page = new Page(doc, new Map(), 1);
    expect(page.MediaBox).toEqual([0, 0, 612, 792]);
  });

  it('normalizes Rotate and defaults to 0', () => {
    expect(new Page(doc, new Map(), 1).Rotate).toBe(0);
    expect(new Page(doc, new Map<string, any>([['Rotate', 450]]), 1).Rotate).toBe(90);
    expect(new Page(doc, new Map<string, any>([['Rotate', -90]]), 1).Rotate).toBe(270);
  });

  it('returns Resources dict or undefined', () => {
    const res: PdfDict = new Map<string, any>([['Font', new Map()]]);
    expect(new Page(doc, new Map<string, any>([['Resources', res]]), 1).Resources).toBe(res);
    expect(new Page(doc, new Map(), 1).Resources).toBeUndefined();
  });

  it('decodes a single Contents stream', () => {
    const dict: PdfDict = new Map<string, any>([['Contents', rawStream('Page 1')]]);
    expect(dec(new Page(doc, dict, 1).Contents)).toBe('Page 1');
  });

  it('concatenates a Contents array with newline separators and inflates Flate', () => {
    const dict: PdfDict = new Map<string, any>([['Contents', [flateStream('Hello'), flateStream('World')]]]);
    expect(dec(new Page(doc, dict, 1).Contents)).toBe('Hello\nWorld');
  });

  it('returns empty Contents when absent', () => {
    expect(new Page(doc, new Map(), 1).Contents.length).toBe(0);
  });

  it('returns Annotation dicts, or [] when absent', () => {
    const a1: PdfDict = new Map<string, any>([['Subtype', name('Text')]]);
    const a2: PdfDict = new Map<string, any>([['Subtype', name('Link')]]);
    expect(new Page(doc, new Map<string, any>([['Annots', [a1, a2]]]), 1).Annotations).toEqual([a1, a2]);
    expect(new Page(doc, new Map(), 1).Annotations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- page.test`
Expected: FAIL — cannot find module `../src/page.js` / `Page` is not a constructor.

- [ ] **Step 3: Implement `src/page.ts`**

Create `src/page.ts`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfStream, isArray, isDict, isStream } from './types.js';
import { inflateStream } from './flate.js';

/** A single PDF page: a typed, read-only view over a materialized page dict. */
export class Page {
  constructor(
    private readonly doc: Document,
    /** Materialized page dict: own entries with inheritable attributes folded in. */
    readonly Dict: PdfDict,
    /** 1-based position in document order. */
    readonly Number: number,
  ) {}

  private box(key: string, dflt: number[]): number[] {
    const b = this.doc.resolve(this.Dict.get(key));
    if (isArray(b) && b.length === 4) {
      const nums = b.map((x) => this.doc.resolve(x)).filter((x): x is number => typeof x === 'number');
      if (nums.length === 4) return nums;
    }
    return dflt;
  }

  /** Page boundary [llx, lly, urx, ury]; defaults to US Letter if absent. */
  get MediaBox(): number[] {
    return this.box('MediaBox', [0, 0, 612, 792]);
  }

  /** Visible region; defaults to MediaBox when absent. */
  get CropBox(): number[] {
    return this.box('CropBox', this.MediaBox);
  }

  /** Effective visible rectangle (= CropBox). */
  get Rect(): number[] {
    return this.CropBox;
  }

  /** Clockwise rotation in degrees, normalized to one of 0/90/180/270. */
  get Rotate(): number {
    const r = this.doc.resolve(this.Dict.get('Rotate'));
    if (typeof r !== 'number') return 0;
    return ((Math.trunc(r) % 360) + 360) % 360;
  }

  /** The page's resource dictionary, or undefined when absent. */
  get Resources(): PdfDict | undefined {
    const r = this.doc.resolve(this.Dict.get('Resources'));
    return isDict(r) ? r : undefined;
  }

  /** Decoded content-stream bytes; a /Contents array is joined with '\n'. */
  get Contents(): Uint8Array {
    const c = this.doc.resolve(this.Dict.get('Contents'));
    const streams: PdfStream[] = [];
    if (isStream(c)) {
      streams.push(c);
    } else if (isArray(c)) {
      for (const e of c) {
        const s = this.doc.resolve(e);
        if (isStream(s)) streams.push(s);
      }
    }
    if (streams.length === 0) return new Uint8Array(0);
    const parts = streams.map((s) => inflateStream(s));
    const total = parts.reduce((n, p) => n + p.length, 0) + (parts.length - 1);
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) out[off++] = 0x0a;
      out.set(parts[i], off);
      off += parts[i].length;
    }
    return out;
  }

  /** Resolved /Annots entries that are dicts; [] when absent. */
  get Annotations(): PdfDict[] {
    const a = this.doc.resolve(this.Dict.get('Annots'));
    if (!isArray(a)) return [];
    const out: PdfDict[] = [];
    for (const e of a) {
      const d = this.doc.resolve(e);
      if (isDict(d)) out.push(d);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- page.test`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/page.ts test/page.test.ts
git commit -m "feat: add Page class with typed page accessors"
```

---

### Task 2: Refactor pagetree to emit `Page[]` (unify, remove `PageRef`)

**Files:**
- Modify: `src/pagetree.ts`
- Modify: `src/split.ts`
- Modify: `test/pagetree.test.ts`
- Modify: `test/extractor.test.ts`
- Modify: `test/writer.test.ts`
- Modify: `test/split.test.ts`

This task renames `listPages` → `buildPages` (returns `Page[]`), deletes
`PageRef`, and updates every consumer in the same commit so the build stays green.

- [ ] **Step 1: Update the page-tree tests to the new API**

Replace the body of `test/pagetree.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';
import { isArray } from '../src/types.js';

describe('buildPages', () => {
  it('returns pages in order with inherited MediaBox', () => {
    const doc = Document.open(buildClassicPdf(3));
    const pages = buildPages(doc);
    expect(pages.length).toBe(3);
    // MediaBox is defined on Pages node and must be inherited onto each page.
    const mb = pages[0].Dict.get('MediaBox');
    expect(isArray(mb!) && (mb as any[]).length).toBe(4);
  });
});
```

In `test/extractor.test.ts`, change the import and the two usages:

- Replace `import { listPages } from '../src/pagetree.js';` with
  `import { buildPages } from '../src/pagetree.js';`
- Replace `const page = listPages(doc)[0];` with `const page = buildPages(doc)[0];`
- Replace `extractPage(doc, page.dict, defaultPrunePolicy())` with
  `extractPage(doc, page.Dict, defaultPrunePolicy())`

In `test/writer.test.ts`, change the import and the two usages:

- Replace `import { listPages } from '../src/pagetree.js';` with
  `import { buildPages } from '../src/pagetree.js';`
- Replace `const pages = listPages(doc);` with `const pages = buildPages(doc);`
- Replace `const type = pages[0].dict.get('Type');` with
  `const type = pages[0].Dict.get('Type');`

In `test/split.test.ts`, change the import and the helper:

- Replace `import { listPages } from '../src/pagetree.js';` with
  `import { buildPages } from '../src/pagetree.js';`
- Replace `return listPages(Document.open(pdf)).length;` with
  `return buildPages(Document.open(pdf)).length;`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- pagetree extractor writer split`
Expected: FAIL — `buildPages` is not exported from `../src/pagetree.js`.

- [ ] **Step 3: Rewrite `src/pagetree.ts`**

Replace the entire contents of `src/pagetree.ts` with:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, isArray, isName } from './types.js';
import { PdfParseError } from './errors.js';
import { Page } from './page.js';

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/** Walk the page tree and return one Page per leaf, in document order. */
export function buildPages(doc: Document): Page[] {
  const catalog = doc.catalog();
  const pagesRoot = doc.resolve(catalog.get('Pages'));
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const dicts: PdfDict[] = [];
  walk(doc, pagesRoot, {}, new Set(), dicts);
  return dicts.map((dict, i) => new Page(doc, dict, i + 1));
}

function walk(
  doc: Document, node: PdfDict,
  inherited: Partial<Record<string, PdfObject>>,
  seen: Set<PdfDict>, out: PdfDict[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const merged = { ...inherited };
  for (const key of INHERITABLE) if (node.has(key)) merged[key] = node.get(key)!;

  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push(materialize(node, merged));
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, merged, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type but no kids: treat as page.
  out.push(materialize(node, merged));
}

function materialize(page: PdfDict, inherited: Partial<Record<string, PdfObject>>): PdfDict {
  const copy: PdfDict = new Map(page);
  for (const key of INHERITABLE) if (!copy.has(key) && inherited[key] !== undefined)
    copy.set(key, inherited[key]!);
  return copy;
}
```

- [ ] **Step 4: Update `src/split.ts` to use `buildPages` + `.Dict`**

Replace the entire contents of `src/split.ts` with:

```ts
import { Document } from './document.js';
import { buildPages } from './pagetree.js';
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writeSinglePagePdf } from './writer.js';

export interface SplitOptions { prunePolicy?: PrunePolicy; }

/** Split a PDF into one self-contained single-page PDF per page, in page order. */
export function splitPdf(input: Uint8Array, options: SplitOptions = {}): Uint8Array[] {
  const doc = Document.open(input);
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  return buildPages(doc).map((page) => {
    const { objects, pageNum } = extractPage(doc, page.Dict, policy);
    return writeSinglePagePdf(objects, pageNum);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- pagetree extractor writer split`
Expected: PASS (all four suites).

- [ ] **Step 6: Commit**

```bash
git add src/pagetree.ts src/split.ts test/pagetree.test.ts test/extractor.test.ts test/writer.test.ts test/split.test.ts
git commit -m "refactor: pagetree emits Page[]; remove PageRef"
```

---

### Task 3: Populate `Document.Pages` eagerly

**Files:**
- Modify: `src/document.ts`
- Modify: `src/split.ts`
- Test: `test/document.test.ts` (add a `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `test/document.test.ts`:

```ts
import { buildPages } from '../src/pagetree.js';

describe('Document.Pages', () => {
  it('is populated by open() with one Page per page, numbered from 1', () => {
    const doc = Document.open(buildClassicPdf(3));
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 200, 200]);
  });

  it('is empty for a zero-page document', () => {
    expect(Document.open(buildClassicPdf(0)).Pages.length).toBe(0);
  });
});
```

(If `test/document.test.ts` does not already import `buildClassicPdf` and
`Document`, add `import { buildClassicPdf } from './helpers/build-pdf.js';`
and `import { Document } from '../src/document.js';` at the top.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- document.test`
Expected: FAIL — `doc.Pages` is `undefined` (property does not exist).

- [ ] **Step 3: Add the `Pages` field and populate it in the constructor**

In `src/document.ts`, add these imports after the existing import block (after
the `appendIncremental` import on line 8):

```ts
import type { Page } from './page.js';
import { buildPages } from './pagetree.js';
```

Add a public field to the class. Change the field declarations from:

```ts
  private cache = new Map<number, PdfObject>();
  private objStmCache = new Map<number, Map<number, PdfObject>>();
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;
```

to:

```ts
  private cache = new Map<number, PdfObject>();
  private objStmCache = new Map<number, Map<number, PdfObject>>();
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;
  /** One Page per page, in document order. Populated by open(). */
  readonly Pages: Page[];
```

Change the constructor from:

```ts
  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {}
```

to:

```ts
  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {
    this.Pages = buildPages(this);
  }
```

(`buf`/`entries`/`trailer` are parameter properties, assigned before the
constructor body runs, so `buildPages(this)` — which calls `this.catalog()` and
`this.resolve()` — works. `open()` itself needs no change.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- document.test`
Expected: PASS.

- [ ] **Step 5: Switch `src/split.ts` to `doc.Pages`**

Now that `Pages` is built once at `open()`, reuse it. Replace the entire
contents of `src/split.ts` with:

```ts
import { Document } from './document.js';
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writeSinglePagePdf } from './writer.js';

export interface SplitOptions { prunePolicy?: PrunePolicy; }

/** Split a PDF into one self-contained single-page PDF per page, in page order. */
export function splitPdf(input: Uint8Array, options: SplitOptions = {}): Uint8Array[] {
  const doc = Document.open(input);
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  return doc.Pages.map((page) => {
    const { objects, pageNum } = extractPage(doc, page.Dict, policy);
    return writeSinglePagePdf(objects, pageNum);
  });
}
```

- [ ] **Step 6: Run the split tests to verify they still pass**

Run: `npm test -- split.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/split.ts test/document.test.ts
git commit -m "feat: populate Document.Pages eagerly in open()"
```

---

### Task 4: Export `Page` from the package index

**Files:**
- Modify: `src/index.ts:7`
- Test: `test/page.test.ts` (add a `describe` block)

- [ ] **Step 1: Add the export**

In `src/index.ts`, after the line:

```ts
export { Document } from './document.js';
```

add:

```ts
export { Page } from './page.js';
```

- [ ] **Step 2: Add an index re-export assertion**

Append to `test/page.test.ts`:

```ts
import * as api from '../src/index.js';

describe('index exports', () => {
  it('re-exports the Page class', () => {
    expect(api.Page).toBe(Page);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npm test -- page.test`
Expected: PASS (10 tests).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts test/page.test.ts
git commit -m "feat: export Page from package index"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npm run typecheck`
Expected: no errors, exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass (existing suites + `page.test` + new `document.test` cases).

- [ ] **Step 3: Close the beads issue and commit any state**

```bash
bd close aspose-pdf-foss-for-ts-3gq --reason="Implemented Page class and eager Document.Pages per spec; typecheck + full suite green"
git add -A
git commit -m "chore: beads close Page class issue"
```

---

## Self-Review Notes

- **Spec coverage:** module layout (Tasks 1–3); Page surface incl. Number/Dict/MediaBox/CropBox/Rect/Rotate/Resources/Contents/Annotations (Task 1); eager `Pages` in constructor (Task 3); unify + remove `PageRef` + consumer updates (Task 2); import-cycle avoidance via `import type` (Tasks 1, 2, 3); exports (Task 4); tests incl. inherited MediaBox, Rotate default, Resources, single + Flate-array Contents, Annotations empty/non-empty, splitter round-trip (Tasks 1–3, 5).
- **Test-fixture deviation from spec:** the spec proposed adding `flateContents`/`firstPageAnnots` flags to `buildClassicPdf`. The plan instead tests `Contents` (incl. FlateDecode + array) and `Annotations` with hand-built inline dicts/streams in `test/page.test.ts`. Same coverage, no binary-in-string complication in the string-based fixture builder, and no helper changes. Net simpler — chosen deliberately.
- **Type/name consistency:** `buildPages` (not `listPages`) used everywhere after Task 2; `Page.Dict`/`Page.Number` PascalCase consistent across page.ts, pagetree.ts, split.ts, and tests; `readonly Pages: Page[]` matches usage `doc.Pages`.
