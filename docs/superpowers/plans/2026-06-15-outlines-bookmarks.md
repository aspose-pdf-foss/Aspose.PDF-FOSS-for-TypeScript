# Outlines / bookmarks read + write — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the `/Catalog /Outlines` tree into a nested `OutlineItem[]` model and write/replace it via `SetOutlines`, round-tripping through `Save()`.

**Architecture:** Pure model + parse/build logic lives in a new `src/outline.ts` (mirrors the `metadata.ts` pattern). `Document` gains `GetOutlines`/`SetOutlines` plus the graph-private bits (object allocation, page↔ref mapping, old-tree deletion). `Save()` already mark-sweeps from `/Root`, so no serializer change is needed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest. Spec: `docs/superpowers/specs/2026-06-15-outlines-bookmarks-design.md`.

---

## File Structure

- **Create** `src/outline.ts` — model types (`OutlineItem`, `OutlineDest`, `OutlineView`); pure read (`readOutlineTree`, `parseDest`, `resolveNamedDest`, `lookupNameTree`, `decodeView`); pure write (`encodeDest`, `buildOutlineObjects`, `OutlineBuildCtx`).
- **Modify** `src/document.ts` — add `GetOutlines`, `SetOutlines`, and private helpers `pageNumberForObject`, `pageRefForNumber`, `deleteOutlineSubtree`.
- **Modify** `src/index.ts` — export the three model types.
- **Create** `test/helpers/build-outline-pdf.ts` — multi-page fixture with nested items and all destination forms.
- **Create** `test/outline.test.ts` — read, dest-resolution, write/round-trip, validation tests.

---

## Task 1: Model types + fixture

**Files:**
- Create: `src/outline.ts`
- Create: `test/helpers/build-outline-pdf.ts`
- Test: `test/outline.test.ts`

- [ ] **Step 1: Create the model types in `src/outline.ts`**

```ts
import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** A node in the document outline (bookmark) tree. */
export interface OutlineItem {
  Title: string;
  /** Target; undefined for a heading with no (or an unresolvable) destination. */
  Dest?: OutlineDest;
  /** Expanded state; set on read for items with children, default true on write. */
  Open?: boolean;
  /** Child items; omitted/empty for a leaf. */
  Children?: OutlineItem[];
}

/** A page destination: 1-based page number plus an optional view. */
export interface OutlineDest {
  page: number;
  view?: OutlineView;
}

/** A PDF 32000-1 §12.3.2.2 destination view. `null` = "retain current value". */
export type OutlineView =
  | { type: 'XYZ'; left?: number | null; top?: number | null; zoom?: number | null }
  | { type: 'Fit' }
  | { type: 'FitH'; top?: number | null }
  | { type: 'FitV'; left?: number | null }
  | { type: 'FitR'; left: number; bottom: number; right: number; top: number }
  | { type: 'FitB' }
  | { type: 'FitBH'; top?: number | null }
  | { type: 'FitBV'; left?: number | null };
```

- [ ] **Step 2: Create the fixture `test/helpers/build-outline-pdf.ts`**

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Three-page classic-xref PDF with a nested outline exercising every
 *  destination form:
 *    Chapter 1 (explicit /Dest [page1 /XYZ null 780 null])
 *      Section 1.1 (/A /GoTo /D [page2 /Fit])
 *    Chapter 2 (/Dest (chap2) -> /Names /Dests name tree -> page3 /Fit)
 *    Chapter 3 (/Dest /chap3  -> legacy catalog /Dests dict -> page2 /Fit)
 *  Object layout: 1 Catalog, 2 Pages, 3-5 Pages, 6 /Outlines root,
 *  7 Chapter 1, 8 Section 1.1, 9 Chapter 2, 10 Chapter 3,
 *  11 /Names /Dests leaf, 12 legacy /Dests dict. */
export function buildOutlinePdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Names << /Dests 11 0 R >> /Dests 12 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
  objects[6] = `<< /Type /Outlines /First 7 0 R /Last 10 0 R /Count 4 >>`;
  objects[7] = `<< /Title (Chapter 1) /Parent 6 0 R /Next 9 0 R /First 8 0 R /Last 8 0 R /Count 1 /Dest [3 0 R /XYZ null 780 null] >>`;
  objects[8] = `<< /Title (Section 1.1) /Parent 7 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>`;
  objects[9] = `<< /Title (Chapter 2) /Parent 6 0 R /Prev 7 0 R /Next 10 0 R /Dest (chap2) >>`;
  objects[10] = `<< /Title (Chapter 3) /Parent 6 0 R /Prev 9 0 R /Dest /chap3 >>`;
  objects[11] = `<< /Names [(chap2) [5 0 R /Fit]] >>`;
  objects[12] = `<< /chap3 [4 0 R /Fit] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 3: Write the fixture sanity test `test/outline.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildOutlinePdf } from './helpers/build-outline-pdf.js';
import { isDict } from '../src/types.js';

const open = () => Document.Open(buildOutlinePdf());

describe('outline fixture', () => {
  it('opens with three pages and an /Outlines dict', () => {
    const doc = open();
    expect(doc.Pages.length).toBe(3);
    expect(isDict(doc.resolve(doc.catalog().get('Outlines')))).toBe(true);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- outline`
Expected: PASS (1 test). Also run `npm run typecheck` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/outline.ts test/helpers/build-outline-pdf.ts test/outline.test.ts
git commit -m "test: outline model types + multi-form bookmark fixture (5oh)"
```

---

## Task 2: Read path — tree walk + explicit /Dest

**Files:**
- Modify: `src/outline.ts`
- Modify: `src/document.ts`
- Test: `test/outline.test.ts`

- [ ] **Step 1: Write the failing read test (append to `test/outline.test.ts`)**

```ts
describe('GetOutlines (read)', () => {
  it('returns the nested tree with titles, Open flags, and nesting', () => {
    const items = open().GetOutlines();
    expect(items.map((i) => i.Title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(items[0].Open).toBe(true);
    expect(items[0].Children?.map((c) => c.Title)).toEqual(['Section 1.1']);
    // leaves carry no Open / Children keys
    expect(items[1].Open).toBeUndefined();
    expect(items[1].Children).toBeUndefined();
    expect(items[0].Children![0].Children).toBeUndefined();
  });

  it('resolves an explicit /Dest array with null XYZ coordinates', () => {
    const ch1 = open().GetOutlines()[0];
    expect(ch1.Dest).toEqual({ page: 1, view: { type: 'XYZ', left: null, top: 780, zoom: null } });
  });

  it('returns [] for a document with no /Outlines', () => {
    const doc = open();
    doc.catalog().delete('Outlines');
    expect(doc.GetOutlines()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- outline`
Expected: FAIL — `GetOutlines is not a function`.

- [ ] **Step 3: Add view decoding + tree walk to `src/outline.ts`**

```ts
/** Map a dest array element to a coordinate number, treating null/absent as null. */
function coord(o: PdfObject | undefined): number | null {
  return typeof o === 'number' ? o : null;
}

/** Decode the tail of a destination array (the fit name + operands) to a view. */
export function decodeView(parts: PdfObject[]): OutlineView {
  const fit = isName(parts[0]) ? parts[0].name : 'Fit';
  switch (fit) {
    case 'XYZ': return { type: 'XYZ', left: coord(parts[1]), top: coord(parts[2]), zoom: coord(parts[3]) };
    case 'FitH': return { type: 'FitH', top: coord(parts[1]) };
    case 'FitV': return { type: 'FitV', left: coord(parts[1]) };
    case 'FitR': return {
      type: 'FitR', left: coord(parts[1]) ?? 0, bottom: coord(parts[2]) ?? 0,
      right: coord(parts[3]) ?? 0, top: coord(parts[4]) ?? 0,
    };
    case 'FitB': return { type: 'FitB' };
    case 'FitBH': return { type: 'FitBH', top: coord(parts[1]) };
    case 'FitBV': return { type: 'FitBV', left: coord(parts[1]) };
    default: return { type: 'Fit' };
  }
}

/** Resolve a 1-based page number from a destination's first element. */
export type PageOf = (o: PdfObject) => number | undefined;

/** Resolve an outline item's destination. Task 2 handles only explicit /Dest
 *  arrays; /A GoTo and named destinations are added in Task 3. */
export function parseDest(doc: Document, item: PdfDict, pageOf: PageOf): OutlineDest | undefined {
  const dest = doc.resolve(item.get('Dest'));
  if (!isArray(dest)) return undefined;
  const page = pageOf(dest[0]);
  if (page === undefined) return undefined;
  return { page, view: decodeView(dest.slice(1).map((p) => doc.resolve(p))) };
}

/** Walk a sibling list from `firstRef`, following /Next, into OutlineItem[]. */
export function readOutlineTree(doc: Document, container: PdfDict, pageOf: PageOf): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Set<PdfDict>();
  let node = doc.resolve(container.get('First'));
  while (isDict(node) && !seen.has(node)) {
    seen.add(node);
    const title = doc.resolve(node.get('Title'));
    const item: OutlineItem = { Title: isString(title) ? decodePdfText(title.bytes) : '' };
    const dest = parseDest(doc, node, pageOf);
    if (dest) item.Dest = dest;
    const children = readOutlineTree(doc, node, pageOf);
    if (children.length) {
      item.Children = children;
      const count = doc.resolve(node.get('Count'));
      item.Open = !(typeof count === 'number' && count < 0);
    }
    out.push(item);
    node = doc.resolve(node.get('Next'));
  }
  return out;
}
```

- [ ] **Step 4: Add `GetOutlines` + `pageNumberForObject` to `src/document.ts`**

Add the import near the other model imports (top of file):

```ts
import { OutlineItem, readOutlineTree } from './outline.js';
```

Add these methods to the `Document` class (e.g. after `GetMetadata`):

```ts
  /** Resolve a destination's page object to its 1-based page number, or undefined. */
  private pageNumberForObject(o: PdfObject): number | undefined {
    const d = this.resolve(o);
    if (!isDict(d)) return undefined;
    const i = this.Pages.findIndex((p) => p.Dict === d);
    return i === -1 ? undefined : i + 1;
  }

  /** The document outline (bookmark) tree; [] when there is no /Outlines. */
  GetOutlines(): OutlineItem[] {
    const outlines = this.resolve(this.catalog().get('Outlines'));
    if (!isDict(outlines)) return [];
    return readOutlineTree(this, outlines, (o) => this.pageNumberForObject(o));
  }
```

- [ ] **Step 5: Run to verify the read tests pass**

Run: `npm test -- outline`
Expected: PASS (4 tests). The GoTo/named dests (Chapter 2/3, Section 1.1) carry no `Dest` yet — Task 3 adds them; current tests do not assert those.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/outline.ts src/document.ts test/outline.test.ts
git commit -m "feat: GetOutlines reads nested tree + explicit /Dest (5oh)"
```

---

## Task 3: Read path — /A GoTo + named destinations

**Files:**
- Modify: `src/outline.ts`
- Test: `test/outline.test.ts`

- [ ] **Step 1: Write the failing dest-resolution test (append to `test/outline.test.ts`)**

```ts
describe('GetOutlines destination forms', () => {
  it('resolves all destination forms to the right page + Fit view', () => {
    const items = open().GetOutlines();
    const goto = items[0].Children![0];          // /A /GoTo /D [page2 /Fit]
    const named = items[1];                       // /Dest (chap2) via name tree
    const legacy = items[2];                      // /Dest /chap3 via /Dests dict
    expect(goto.Dest).toEqual({ page: 2, view: { type: 'Fit' } });
    expect(named.Dest).toEqual({ page: 3, view: { type: 'Fit' } });
    expect(legacy.Dest).toEqual({ page: 2, view: { type: 'Fit' } });
  });

  it('leaves Dest undefined for an unresolvable named destination', () => {
    const doc = open();
    doc.catalog().delete('Names');
    doc.catalog().delete('Dests');
    expect(doc.GetOutlines()[1].Dest).toBeUndefined(); // Chapter 2 (named) now unresolved
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- outline`
Expected: FAIL — `goto.Dest` is `undefined` (GoTo/named not yet resolved).

- [ ] **Step 3: Add name-tree lookup + extend `parseDest` in `src/outline.ts`**

Add these functions above `parseDest`:

```ts
/** Look up `key` in a /Names name-tree node (honoring /Limits when present). */
export function lookupNameTree(doc: Document, node: PdfObject, key: string): PdfObject | undefined {
  const n = doc.resolve(node);
  if (!isDict(n)) return undefined;
  const names = doc.resolve(n.get('Names'));
  if (isArray(names)) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const k = doc.resolve(names[i]);
      if (isString(k) && decodePdfText(k.bytes) === key) return names[i + 1];
    }
  }
  const kids = doc.resolve(n.get('Kids'));
  if (isArray(kids)) {
    for (const kid of kids) {
      const kd = doc.resolve(kid);
      if (!isDict(kd)) continue;
      const limits = doc.resolve(kd.get('Limits'));
      if (isArray(limits) && isString(limits[0]) && isString(limits[1])) {
        const lo = decodePdfText(limits[0].bytes), hi = decodePdfText(limits[1].bytes);
        if (key < lo || key > hi) continue;
      }
      const found = lookupNameTree(doc, kd, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Resolve a named destination (`key`) via the legacy catalog /Dests dict, then
 *  the /Names /Dests name tree. Returns the raw dest array, or undefined. */
export function resolveNamedDest(doc: Document, key: string): PdfObject | undefined {
  const catalog = doc.catalog();
  const legacy = doc.resolve(catalog.get('Dests'));
  if (isDict(legacy) && legacy.has(key)) return doc.resolve(legacy.get(key));
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names)) {
    const found = lookupNameTree(doc, names.get('Dests'), key);
    if (found !== undefined) return doc.resolve(found);
  }
  return undefined;
}
```

Replace the body of `parseDest` with the full version (explicit `/Dest`, then `/A` GoTo, then named lookup; a named dest may itself be a dict with `/D`):

```ts
export function parseDest(doc: Document, item: PdfDict, pageOf: PageOf): OutlineDest | undefined {
  let dest = doc.resolve(item.get('Dest'));
  if (dest === null) {
    const a = doc.resolve(item.get('A'));
    if (isDict(a)) {
      const s = doc.resolve(a.get('S'));
      if (isName(s) && s.name === 'GoTo') dest = doc.resolve(a.get('D'));
    }
  }
  if (isString(dest)) dest = resolveNamedDest(doc, decodePdfText(dest.bytes));
  else if (isName(dest)) dest = resolveNamedDest(doc, dest.name);
  dest = doc.resolve(dest);
  if (isDict(dest)) dest = doc.resolve(dest.get('D')); // named dest given as << /D [...] >>
  if (!isArray(dest)) return undefined;
  const page = pageOf(dest[0]);
  if (page === undefined) return undefined;
  return { page, view: decodeView(dest.slice(1).map((p) => doc.resolve(p))) };
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test -- outline`
Expected: PASS (6 tests). Run `npm run typecheck` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/outline.ts test/outline.test.ts
git commit -m "feat: resolve /A GoTo + named outline destinations (5oh)"
```

---

## Task 4: Write path — SetOutlines + round-trip

**Files:**
- Modify: `src/outline.ts`
- Modify: `src/document.ts`
- Modify: `src/index.ts`
- Test: `test/outline.test.ts`

- [ ] **Step 1: Write the failing write tests (append to `test/outline.test.ts`)**

```ts
import { UnsupportedFeatureError } from '../src/errors.js';

const reopen = (d: Document) => Document.Open(d.Save());

describe('SetOutlines (write + round-trip)', () => {
  it('round-trips a built tree through Save()/Open()', () => {
    const doc = open();
    doc.SetOutlines([
      { Title: 'Intro', Dest: { page: 2 } },
      {
        Title: 'Part A', Dest: { page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } },
        Open: false,
        Children: [{ Title: 'A.1', Dest: { page: 3, view: { type: 'Fit' } } }],
      },
    ]);
    const items = reopen(doc).GetOutlines();
    expect(items.map((i) => i.Title)).toEqual(['Intro', 'Part A']);
    expect(items[0].Dest).toEqual({ page: 2, view: { type: 'Fit' } });
    expect(items[1].Open).toBe(false);
    expect(items[1].Children![0].Dest).toEqual({ page: 3, view: { type: 'Fit' } });
    expect(items[1].Dest).toEqual({ page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } });
  });

  it('allows an item with no destination', () => {
    const doc = open();
    doc.SetOutlines([{ Title: 'Heading only' }]);
    const items = reopen(doc).GetOutlines();
    expect(items).toEqual([{ Title: 'Heading only' }]);
  });

  it('clears the outline on an empty array', () => {
    const doc = open();
    doc.SetOutlines([]);
    expect(doc.GetOutlines()).toEqual([]);
    expect(reopen(doc).catalog().has('Outlines')).toBe(false);
  });

  it('rejects an out-of-range page without mutating the document', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 'Bad', Dest: { page: 99 } }])).toThrow(RangeError);
    expect(doc.GetOutlines().map((i) => i.Title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  });

  it('rejects a non-string title', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 123 as unknown as string }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- outline`
Expected: FAIL — `SetOutlines is not a function`.

- [ ] **Step 3: Add the write helpers to `src/outline.ts`**

```ts
/** Build context supplied by Document: object allocation + page-ref lookup. */
export interface OutlineBuildCtx {
  /** Install `obj` under a fresh object number and return that number. */
  alloc(obj: PdfObject): number;
  /** The page object ref for a validated 1-based page number. */
  pageRef(page: number): PdfRef;
}

/** Encode a destination as a PDF dest array `[pageRef /Fit ...]`. */
export function encodeDest(pageRef: PdfRef, view: OutlineView = { type: 'Fit' }): PdfObject[] {
  const n = (x: number | null | undefined): PdfObject => (typeof x === 'number' ? x : null);
  switch (view.type) {
    case 'XYZ': return [pageRef, name('XYZ'), n(view.left), n(view.top), n(view.zoom)];
    case 'FitH': return [pageRef, name('FitH'), n(view.top)];
    case 'FitV': return [pageRef, name('FitV'), n(view.left)];
    case 'FitR': return [pageRef, name('FitR'), view.left, view.bottom, view.right, view.top];
    case 'FitB': return [pageRef, name('FitB')];
    case 'FitBH': return [pageRef, name('FitBH'), n(view.top)];
    case 'FitBV': return [pageRef, name('FitBV'), n(view.left)];
    default: return [pageRef, name('Fit')];
  }
}

/** Count visible descendants of a node (children plus open children's visible
 *  descendants). Used for the signed /Count entry. */
function visibleCount(children: OutlineItem[]): number {
  let c = children.length;
  for (const kid of children)
    if (kid.Children?.length && kid.Open !== false) c += visibleCount(kid.Children);
  return c;
}

/** Validate the whole tree; throws before any mutation. `pageCount` is the
 *  document's page count; `checkPage` mirrors Document.pageRefForNumber so a
 *  non-indirect target page fails here too. */
export function validateOutlineItems(
  items: OutlineItem[], pageCount: number, checkPage: (page: number) => void,
): void {
  for (const item of items) {
    if (typeof item.Title !== 'string') throw new TypeError('outline item Title must be a string');
    if (item.Dest !== undefined) {
      const p = item.Dest.page;
      if (!Number.isInteger(p) || p < 1 || p > pageCount)
        throw new RangeError(`outline destination page ${p} out of range 1..${pageCount}`);
      checkPage(p);
    }
    if (item.Children) validateOutlineItems(item.Children, pageCount, checkPage);
  }
}

/** Build the /Outlines object graph from a validated tree; returns the root
 *  object number. Wires /Parent /Prev /Next /First /Last /Count /Title /Dest. */
export function buildOutlineObjects(items: OutlineItem[], ctx: OutlineBuildCtx): number {
  const rootDict: PdfDict = new Map<string, PdfObject>([['Type', name('Outlines')]]);
  const rootNum = ctx.alloc(rootDict);

  const buildList = (siblings: OutlineItem[], parent: PdfRef): { first: number; last: number } => {
    const dicts = siblings.map(() => new Map<string, PdfObject>());
    const nums = dicts.map((d) => ctx.alloc(d));
    siblings.forEach((item, i) => {
      const d = dicts[i];
      d.set('Title', { kind: 'string', bytes: encodePdfText(item.Title) });
      if (item.Dest) d.set('Dest', encodeDest(ctx.pageRef(item.Dest.page), item.Dest.view));
      d.set('Parent', parent);
      if (i > 0) d.set('Prev', ref(nums[i - 1]));
      if (i < nums.length - 1) d.set('Next', ref(nums[i + 1]));
      if (item.Children?.length) {
        const { first, last } = buildList(item.Children, ref(nums[i]));
        d.set('First', ref(first));
        d.set('Last', ref(last));
        const cnt = visibleCount(item.Children);
        d.set('Count', item.Open === false ? -cnt : cnt);
      }
    });
    return { first: nums[0], last: nums[nums.length - 1] };
  };

  const { first, last } = buildList(items, ref(rootNum));
  rootDict.set('First', ref(first));
  rootDict.set('Last', ref(last));
  rootDict.set('Count', visibleCount(items));
  return rootNum;
}
```

Add `ref` to the existing `types.js` import at the top of `src/outline.ts`:

```ts
import {
  PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isString, name, ref,
} from './types.js';
```

- [ ] **Step 4: Add `SetOutlines` + helpers to `src/document.ts`**

Extend the outline import:

```ts
import { OutlineItem, readOutlineTree, buildOutlineObjects, validateOutlineItems } from './outline.js';
```

Add these methods to the `Document` class (next to `GetOutlines`):

```ts
  /** The page object ref for a 1-based page number; throws when that page is
   *  not an indirect object (consistent with Reorder). */
  private pageRefForNumber(page: number): PdfRef {
    const num = this.pageObjNums[page - 1];
    if (!num)
      throw new UnsupportedFeatureError('cannot set outline destination: target page is not an indirect object');
    return ref(num);
  }

  /** Delete the /Outlines root and every item object reachable via First/Next. */
  private deleteOutlineSubtree(): void {
    const rootRef = this.catalog().get('Outlines');
    if (!isRef(rootRef)) return;
    const seen = new Set<number>();
    const walk = (r: PdfObject): void => {
      let cur = r;
      while (isRef(cur) && !seen.has(cur.num)) {
        seen.add(cur.num);
        const d = this.objects.get(cur.num);
        const next = isDict(d) ? d.get('Next') ?? null : null;
        if (isDict(d)) walk(d.get('First') ?? null);
        this.objects.delete(cur.num);
        cur = next;
      }
    };
    const root = this.objects.get(rootRef.num);
    if (isDict(root)) walk(root.get('First') ?? null);
    this.objects.delete(rootRef.num);
  }

  /** Replace the document outline with `items`; an empty array removes it.
   *  Validates the whole tree first, so a throw leaves the document unchanged. */
  SetOutlines(items: OutlineItem[]): void {
    validateOutlineItems(items, this.Pages.length, (p) => { this.pageRefForNumber(p); });
    const catalog = this.catalog();
    this.deleteOutlineSubtree();
    if (items.length === 0) { catalog.delete('Outlines'); return; }
    const rootNum = buildOutlineObjects(items, {
      alloc: (obj) => { const n = this.maxObjNum() + 1; this.objects.set(n, obj); return n; },
      pageRef: (p) => this.pageRefForNumber(p),
    });
    catalog.set('Outlines', ref(rootNum));
  }
```

- [ ] **Step 5: Export the model types from `src/index.ts`**

Add after the existing `FieldType` export line:

```ts
export type { OutlineItem, OutlineDest, OutlineView } from './outline.js';
```

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test -- outline`
Expected: PASS (11 tests).

Run: `npm test` then `npm run typecheck`
Expected: entire suite green; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/outline.ts src/document.ts src/index.ts test/outline.test.ts
git commit -m "feat: SetOutlines writes/replaces the bookmark tree (5oh)"
```

---

## Self-review notes

- **Spec coverage:** read tree/titles/dests/nesting (Tasks 2-3); explicit + GoTo + named incl. name-tree & legacy /Dests (Tasks 2-3); typed page+view with all 8 views + null coords (Tasks 2,4); symmetric SetOutlines with validate-before-mutate, empty-clears, no-dest items, old-tree deletion (Task 4); index exports (Task 4); `[]` on no /Outlines (Task 2). All covered.
- **Error types:** page range → `RangeError`; non-string title → `TypeError`; non-indirect target page → `UnsupportedFeatureError`. (The spec text said "RangeError … non-string title"; this plan uses `TypeError` for the type mismatch to match the `Field` setter convention, and `RangeError` strictly for the numeric range — a deliberate, documented refinement.)
- **Type consistency:** `OutlineItem`/`OutlineDest`/`OutlineView`, `parseDest`/`readOutlineTree`/`resolveNamedDest`/`lookupNameTree`/`decodeView`/`encodeDest`/`buildOutlineObjects`/`validateOutlineItems`, `OutlineBuildCtx{alloc,pageRef}`, and `PageOf` are used consistently across tasks. `parseDest` is introduced in Task 2 (explicit-only) and its body fully replaced in Task 3.
```
