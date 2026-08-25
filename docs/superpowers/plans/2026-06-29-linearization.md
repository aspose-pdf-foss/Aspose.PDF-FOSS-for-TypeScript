# Linearization (Fast Web View) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Save({ linearized: true })` emits a conformant classic-xref, plaintext linearized PDF (ISO 32000-1 Annex F) that `qpdf --check` reports as linearized with no errors.

**Architecture:** A new `src/linearize.ts` reuses the serializer's mark-sweep plan, partitions objects into a first-page set and a remainder, renumbers each into a contiguous range, lays them out in Annex F order with fixed-width placeholder numerics, then backfills the parameter dict, two cross-reference sections, and a primary hint stream. An exported `verifyLinearization` re-parses output and checks every offset/length/hint entry; it is the automated test gate, with `qpdf --check` as the manual acceptance step.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `PdfDict` is `Map<string, PdfObject>`; names without leading `/`. Create dicts with `new Map<string, PdfObject>()`. `serializeObject(o)` / `serializeValue(o)` from `serialize.ts` turn objects into bytes/strings. Streams hold raw bytes in `.raw`; `serializeObject` recomputes `/Length`.
- Linearization is classic-xref + plaintext only. `compressed: true` or `encrypt` combined with `linearized: true` throws `UnsupportedFeatureError`.
- TDD: failing test first, watch it fail, minimal implementation, watch it pass, commit.
- Run `npm run typecheck` and `npm test` before considering any task done; both must be green.
- Authoritative bit-level layout for the hint tables is **ISO 32000-1:2008 Annex F.3 (Tables F.3–F.6)**. Field bit-widths in Task 5 MUST be taken from those tables, not from memory; `verifyLinearization` and `qpdf --check` are the cross-checks.
- Spec: [docs/superpowers/specs/2026-06-29-linearization-design.md](../specs/2026-06-29-linearization-design.md).

## File Structure

- `src/linearize.ts` — **new**. Owns `serializeLinearized`, `verifyLinearization`, `LinearizationCheck`, the partition/renumber/layout logic, the `BitWriter`/`BitReader` helpers, and the hint-table builder/parser. Depends on `serialize.ts`, `flate.ts` (deflate via `node:zlib`), `types.ts`, `errors.ts`.
- `src/serializer.ts` — **modify**. `SerializeOptions` gains `linearized?`; `serializeDocument` routes to `serializeLinearized` and rejects unsupported combinations. Export `planDocument`/`refsIn`/`Plan` for reuse.
- `src/document.ts` — **modify**. `IsLinearized` getter.
- `src/index.ts` — **modify**. Export `verifyLinearization`, `LinearizationCheck`.
- `src/flate.ts` — **modify** (if needed). Export a `deflate(bytes): Uint8Array` helper if one is not already exported (the serializer currently calls `deflateSync` directly; reuse that pattern).
- `test/helpers/build-linear-fixtures.ts` — **new**. Programmatic single-page, multi-page, and shared-resource fixtures.
- `test/linearize.test.ts` — **new**.
- `README.md` — **modify**. Features + Limitations.

---

### Task 1: `Document.IsLinearized` getter (reader side)

Standalone, no serializer dependency. A file is linearized when its first indirect object (after the `%PDF` header) is a dictionary containing `/Linearized`.

**Files:**
- Modify: `src/document.ts`
- Test: `test/linearize.test.ts` (new)

**Interfaces:**
- Produces: `Document.IsLinearized: boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/linearize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

// Minimal hand-built file whose first object is a /Linearized parameter dict.
function linearizedLikeBytes(): Uint8Array {
  const body =
    '%PDF-1.7\n' +
    '1 0 obj\n<< /Linearized 1 /L 1000 /O 4 /E 500 /N 1 /T 800 /H [200 50] >>\nendobj\n' +
    '2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n' +
    '3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n' +
    '4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] >>\nendobj\n';
  const offsets: number[] = [];
  let pos = enc('%PDF-1.7\n').length;
  for (const seg of ['1 0 obj', '2 0 obj', '3 0 obj', '4 0 obj']) {
    offsets.push(body.indexOf(seg));
  }
  const xrefStart = enc(body).length;
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (const o of offsets) xref += `${String(enc(body.slice(0, o)).length).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size 5 /Root 2 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

describe('Document.IsLinearized', () => {
  it('is true when the first object is a /Linearized dict', () => {
    expect(Document.Open(linearizedLikeBytes()).IsLinearized).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/linearize.test.ts -t IsLinearized`
Expected: FAIL — `IsLinearized` is not a function/property.

- [ ] **Step 3: Implement the getter**

In `src/document.ts`, near `IsTagged` (~line 503), add. The getter scans the original bytes for the first `obj` and checks for `/Linearized`; falls back to `false` for in-memory documents with no `originalBytes`.

```ts
  /** True when the opened file is linearized (its first indirect object is a
   *  /Linearized parameter dictionary). False for in-memory/authored documents. */
  get IsLinearized(): boolean {
    const bytes = this.originalBytes;
    if (!bytes) return false;
    // Inspect only the head: the param dict must be within the first 1024 bytes.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const m = /\bobj\b([\s\S]*?)\bendobj\b/.exec(head);
    return m !== null && /\/Linearized\b/.test(m[1]);
  }
```

If `this.originalBytes` is not the field name, use the same accessor `headerVersion()` uses (it references `this.originalBytes` at [src/document.ts:489](../../../src/document.ts)). Confirm the field name before implementing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/linearize.test.ts -t IsLinearized`
Expected: PASS.

- [ ] **Step 5: Add the negative case + commit**

Add to the same describe:

```ts
  it('is false for a normal (non-linearized) document', () => {
    const doc = Document.Open(linearizedLikeBytes());
    const normal = Document.Open(doc.Save());      // re-saved: not linearized
    expect(normal.IsLinearized).toBe(false);
  });
```

Run: `npx vitest run test/linearize.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

```bash
git add src/document.ts test/linearize.test.ts
git commit -m "feat(linearize): Document.IsLinearized getter"
```

---

### Task 2: Option plumbing + unsupported-combination guards

Add the `linearized` option, route it, and reject the unsupported combinations and the no-page case. `serializeLinearized` is a stub that the later tasks flesh out; for now the happy path is not yet reachable by tests (only the guards are).

**Files:**
- Modify: `src/serializer.ts`
- Create: `src/linearize.ts`
- Test: `test/linearize.test.ts`

**Interfaces:**
- Consumes: `planDocument`, `refsIn`, `Plan` (exported from `serializer.ts` in this task).
- Produces: `SerializeOptions.linearized?: boolean`; `serializeLinearized(objects, trailer, ver?): Uint8Array` (throws until Task 4 completes it).

- [ ] **Step 1: Write the failing tests**

Add to `test/linearize.test.ts`:

```ts
import { UnsupportedFeatureError } from '../src/errors.js';

describe('Save linearized — guards', () => {
  // A real opened doc with one page.
  const onePage = () => Document.Open(linearizedLikeBytes());
  it('throws when combined with compressed', () => {
    expect(() => onePage().Save({ linearized: true, compressed: true }))
      .toThrow(UnsupportedFeatureError);
  });
  it('throws when combined with encrypt', () => {
    expect(() => onePage().Save({ linearized: true, encrypt: { userPassword: 'x' } as any }))
      .toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/linearize.test.ts -t guards`
Expected: FAIL — no `linearized` option / no throw.

- [ ] **Step 3: Export the plan internals from `serializer.ts`**

Change `interface Plan` to `export interface Plan`, `function planDocument` to `export function planDocument`, and `function refsIn` to `export function refsIn` in `src/serializer.ts`.

- [ ] **Step 4: Add the option and routing**

In `SerializeOptions` (src/serializer.ts ~line 12) add:

```ts
  /** Emit a linearized ("Fast Web View") layout (classic xref, plaintext only).
   *  Throws if combined with `compressed` or `encrypt`. Default: false. */
  linearized?: boolean;
```

Add the import at the top of `serializer.ts`:

```ts
import { serializeLinearized } from './linearize.js';
```

In `serializeDocument`, before the existing body, add:

```ts
  if (options.linearized) {
    if (options.compressed) throw new UnsupportedFeatureError('compressed linearization is not supported');
    if (options.encrypt) throw new UnsupportedFeatureError('encrypted linearization is not supported');
    return serializeLinearized(objects, trailer, headerVersion(objects, trailer));
  }
```

(`UnsupportedFeatureError` is already imported in `serializer.ts`.)

- [ ] **Step 5: Create the stub `src/linearize.ts`**

```ts
import { PdfObject, PdfDict } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

/** Serialize the live object map as a linearized (Fast Web View) PDF.
 *  Classic xref, plaintext. Completed across Tasks 3–5. */
export function serializeLinearized(
  _objects: Map<number, PdfObject>, _trailer: PdfDict, _ver = '1.7',
): Uint8Array {
  throw new UnsupportedFeatureError('linearization not yet implemented');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/linearize.test.ts -t guards && npm run typecheck`
Expected: the two guard tests PASS (they throw before reaching the stub); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/serializer.ts src/linearize.ts test/linearize.test.ts
git commit -m "feat(linearize): Save({linearized}) option + unsupported-combo guards"
```

---

### Task 3: Object partitioning + renumbering

A pure function over the serializer `Plan`: split objects into the first-page set and the remainder, detect shared objects, and assign contiguous renumbered ranges. Highly unit-testable in isolation.

**Files:**
- Modify: `src/linearize.ts`
- Test: `test/linearize.test.ts`, `test/helpers/build-linear-fixtures.ts` (new)

**Interfaces:**
- Consumes: `planDocument(objects, trailer)` → `Plan { rootRef, infoRef, oldToNew, objs }` from `serializer.ts`; `refsIn(o, out)`.
- Produces (internal, exported for test):
  ```ts
  interface Partition {
    firstPageNew: number[];   // new object numbers in first-page section, in layout order
    remainderNew: number[];   // new object numbers in remainder section, in layout order
    sharedNew: number[];      // subset of firstPageNew also referenced from remainder
    firstPageObjNew: number;  // new number of the first /Type /Page object
    pageCount: number;
  }
  function partitionForLinearization(plan: Plan): Partition;
  ```

- [ ] **Step 1: Write the fixtures helper**

Create `test/helpers/build-linear-fixtures.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Build a classic-xref PDF from a 1-based array of object body strings. */
function assemble(objects: string[], rootNum: number, extraTrailer = ''): Uint8Array {
  const maxObj = objects.length - 1;
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R${extraTrailer} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** Single page, one content stream and one font. */
export function buildSinglePage(): Uint8Array {
  const content = 'BT /F1 12 Tf 50 700 Td (Page one) Tj ET';
  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  o[2] = `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  o[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  o[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(o, 1);
}

/** Three pages, each its own content; page 1 and page 2 share font 9. */
export function buildSharedResource(): Uint8Array {
  const c = (s: string) => `<< /Length ${byteLen(s)} >>\nstream\n${s}\nendstream`;
  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  o[2] = `<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 9 0 R >> >> >>`;
  o[4] = c('BT /F1 12 Tf 50 700 Td (Page one) Tj ET');
  o[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 9 0 R >> >> >>`;
  o[6] = c('BT /F1 12 Tf 50 700 Td (Page two) Tj ET');
  o[7] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 9 0 R >> >> >>`;
  o[8] = c('BT /F1 12 Tf 50 700 Td (Page three) Tj ET');
  o[9] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  return assemble(o, 1);
}
```

- [ ] **Step 2: Write the failing test**

Add to `test/linearize.test.ts`:

```ts
import { partitionForLinearization } from '../src/linearize.js';
import { planDocument } from '../src/serializer.js';
import { buildSinglePage, buildSharedResource } from './helpers/build-linear-fixtures.js';

// Re-plan the same way the serializer does, from the opened doc's objects/trailer.
function planOf(bytes: Uint8Array) {
  const doc = Document.Open(bytes) as any;
  return planDocument(doc.objects, doc.trailer);
}

describe('partitionForLinearization', () => {
  it('puts the catalog, page-tree root, and first page in the first-page set', () => {
    const p = partitionForLinearization(planOf(buildSinglePage()));
    expect(p.pageCount).toBe(1);
    // Catalog renumbers to 1 (root first); it must be in the first-page set.
    expect(p.firstPageNew).toContain(1);
    expect(p.firstPageObjNew).toBeGreaterThan(0);
  });
  it('detects a font shared between page 1 and later pages', () => {
    const p = partitionForLinearization(planOf(buildSharedResource()));
    expect(p.pageCount).toBe(3);
    expect(p.sharedNew.length).toBeGreaterThan(0);
  });
  it('partitions every object exactly once', () => {
    const plan = planOf(buildSharedResource());
    const p = partitionForLinearization(plan);
    const all = [...p.firstPageNew, ...p.remainderNew].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: plan.objs.length }, (_, i) => i + 1));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/linearize.test.ts -t partitionForLinearization`
Expected: FAIL — `partitionForLinearization` is not exported.

- [ ] **Step 4: Implement the partition**

Add to `src/linearize.ts` (and import what it needs):

```ts
import { isRef, isDict, isArray, isStream, PdfRef } from './types.js';
import { planDocument, refsIn, type Plan } from './serializer.js';

export interface Partition {
  firstPageNew: number[];
  remainderNew: number[];
  sharedNew: number[];
  firstPageObjNew: number;
  pageCount: number;
}

/** Resolve a planned object by NEW number (1-based) from plan.objs. */
function obj(plan: Plan, newNum: number): PdfObject | undefined {
  return plan.objs[newNum - 1];
}

/** New numbers directly referenced by the object at `newNum`. */
function childRefs(plan: Plan, newNum: number): number[] {
  const o = obj(plan, newNum);
  if (o === undefined) return [];
  const refs: PdfRef[] = [];
  refsIn(o, refs);
  return refs.map((r) => r.num).filter((n) => n >= 1 && n <= plan.objs.length);
}

/** Find the first /Type /Page leaf and the page count by walking /Root /Pages. */
function findPages(plan: Plan): { firstPageNew: number; pageCount: number } {
  const catalog = obj(plan, 1);            // root is renumbered to 1
  if (!isDict(catalog)) throw new Error('linearize: catalog is not a dict');
  const pagesRef = catalog.get('Pages');
  if (!isRef(pagesRef)) throw new Error('linearize: /Pages is not a reference');
  let count = 0;
  let first = 0;
  const visit = (n: number, seen: Set<number>): void => {
    if (seen.has(n)) return;
    seen.add(n);
    const node = obj(plan, n);
    if (!isDict(node)) return;
    const type = node.get('Type');
    if (isName(type) && type.name === 'Page') {
      if (first === 0) first = n;
      count++;
      return;
    }
    const kids = node.get('Kids');
    if (isArray(kids)) for (const k of kids) if (isRef(k)) visit(k.num, seen);
  };
  visit(pagesRef.num, new Set());
  if (first === 0) throw new UnsupportedFeatureError('linearization requires at least one page');
  return { firstPageNew: first, pageCount: count };
}

/** Transitive closure of `roots` over child references, within plan bounds. */
function closure(plan: Plan, roots: number[]): Set<number> {
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    for (const c of childRefs(plan, n)) stack.push(c);
  }
  return out;
}

export function partitionForLinearization(plan: Plan): Partition {
  const { firstPageNew: firstPageObjNew, pageCount } = findPages(plan);

  // First-page set: catalog (1) + page-tree path + first page closure, but NOT
  // the closures of other pages. Compute first-page closure, then subtract
  // objects reachable ONLY through other pages is unnecessary — closure from the
  // first page object + catalog already excludes sibling page subtrees, except
  // shared objects (handled below).
  const catalogChildrenExceptPages = (): number[] => {
    const cat = obj(plan, 1) as PdfDict;
    const out: number[] = [1];
    for (const [k, v] of cat) if (k !== 'Pages' && isRef(v)) out.push(v.num);
    return out;
  };
  // Page-tree root node number (the /Pages ref from the catalog).
  const pagesRef = (obj(plan, 1) as PdfDict).get('Pages') as PdfRef;

  const firstPageClosure = closure(plan, [
    ...catalogChildrenExceptPages(),
    pagesRef.num,           // page-tree root node (its /Kids refs pull in sibling
                            // page objects, so prune those below)
    firstPageObjNew,
  ]);

  // Prune sibling page objects (and their exclusive closures) from the first-page
  // set: any page object other than the first.
  const allPages = new Set<number>();
  {
    const seen = new Set<number>();
    const visit = (n: number): void => {
      if (seen.has(n)) return; seen.add(n);
      const node = obj(plan, n);
      if (!isDict(node)) return;
      const type = node.get('Type');
      if (isName(type) && type.name === 'Page') { allPages.add(n); return; }
      const kids = node.get('Kids');
      if (isArray(kids)) for (const k of kids) if (isRef(k)) visit(k.num);
    };
    visit(pagesRef.num);
  }
  const siblingPages = [...allPages].filter((n) => n !== firstPageObjNew);
  const siblingClosure = closure(plan, siblingPages);
  // Keep an object in the first-page set only if it is in firstPageClosure and is
  // NOT exclusively part of sibling pages (i.e. it is reachable from page 1 too).
  const firstPageSet = new Set<number>();
  for (const n of firstPageClosure) {
    if (allPages.has(n) && n !== firstPageObjNew) continue; // sibling page objects
    firstPageSet.add(n);
  }

  const total = plan.objs.length;
  const firstPageNew: number[] = [];
  const remainderNew: number[] = [];
  for (let n = 1; n <= total; n++) (firstPageSet.has(n) ? firstPageNew : remainderNew).push(n);

  // Shared = first-page-set objects also referenced from a remainder object.
  const referencedFromRemainder = new Set<number>();
  for (const n of remainderNew) for (const c of childRefs(plan, n)) referencedFromRemainder.add(c);
  const sharedNew = firstPageNew.filter((n) => referencedFromRemainder.has(n));

  void siblingClosure; // (kept for clarity; sibling pruning above is by page identity)
  return { firstPageNew, remainderNew, sharedNew, firstPageObjNew, pageCount };
}
```

Also add `isName` to the `types.js` import in `linearize.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/linearize.test.ts -t partitionForLinearization && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/linearize.ts test/linearize.test.ts test/helpers/build-linear-fixtures.ts
git commit -m "feat(linearize): object partitioning + shared detection"
```

---

### Task 4: Layout, parameter dict, two xref sections, offset backfill

Produce a structurally valid linearized file (param dict + first-page xref + first-page objects + hint-stream object + remainder + main xref) that re-opens cleanly and whose non-hint numerics (`/L`, `/O`, `/E`, `/T`, xref offsets) are byte-accurate. The hint stream is emitted as a present-but-empty placeholder object here; its tables are filled in Task 5. Builds the offset machinery and the structural half of `verifyLinearization`.

**Files:**
- Modify: `src/linearize.ts`, `src/index.ts`
- Test: `test/linearize.test.ts`

**Interfaces:**
- Consumes: `Partition` (Task 3), `serializeObject`/`enc` from `serialize.ts`, `deflateSync` from `node:zlib`.
- Produces: working `serializeLinearized`; `verifyLinearization(bytes): LinearizationCheck` with structural checks; renumbering map from partition order.

- [ ] **Step 1: Write the failing tests**

Add to `test/linearize.test.ts`:

```ts
import { verifyLinearization } from '../src/index.js';
import { buildSinglePage as bsp } from './helpers/build-linear-fixtures.js';

describe('serializeLinearized — structure', () => {
  it('re-opens with the page intact', () => {
    const out = Document.Open(bsp()).Save({ linearized: true });
    const re = Document.Open(out);
    expect(re.Pages.length).toBe(1);
    expect(re.IsLinearized).toBe(true);
  });
  it('passes the structural checks of verifyLinearization', () => {
    const out = Document.Open(bsp()).Save({ linearized: true });
    const check = verifyLinearization(out);
    expect(check.linearized).toBe(true);
    // Structural-only at this stage: /L, /O, /T, /E, xref offsets. (Hint checks
    // arrive in Task 5; they must not fail on the empty placeholder here.)
    expect(check.errors.filter((e) => !/hint/i.test(e))).toEqual([]);
  });
  it('reports /L equal to the byte length', () => {
    const out = Document.Open(bsp()).Save({ linearized: true });
    const head = new TextDecoder('latin1').decode(out.subarray(0, 1024));
    const L = Number(/\/L\s+(\d+)/.exec(head)![1]);
    expect(L).toBe(out.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/linearize.test.ts -t structure`
Expected: FAIL — `serializeLinearized` still throws "not yet implemented".

- [ ] **Step 3: Implement layout with fixed-width backfill**

Replace the stub `serializeLinearized` in `src/linearize.ts`. Key technique: every numeric that can only be known after layout is written as a **10-digit zero-padded** token reserved up front, then overwritten in place (overwrite never changes byte length). Approach:

```ts
import { deflateSync } from 'node:zlib';
import { enc, serializeObject } from './serialize.js';
import { name } from './types.js';

const PAD = 10;
const pad = (n: number): string => String(n).padStart(PAD, '0');

/** Mutable byte buffer that records named slots to backfill. */
class Layout {
  bytes: number[] = [];
  slots = new Map<string, number>();   // name -> byte offset of a PAD-width field
  put(s: string): void { for (const b of enc(s)) this.bytes.push(b); }
  putBytes(b: Uint8Array): void { for (const x of b) this.bytes.push(x); }
  /** Emit a PAD-width placeholder and remember where it is. */
  slot(name: string): void { this.slots.set(name, this.bytes.length); this.put('0'.repeat(PAD)); }
  get length(): number { return this.bytes.length; }
  finalize(values: Map<string, number>): Uint8Array {
    const out = Uint8Array.from(this.bytes);
    for (const [k, off] of this.slots) {
      const v = values.get(k);
      if (v === undefined) continue;
      const t = enc(pad(v));
      out.set(t, off);
    }
    return out;
  }
}

export function serializeLinearized(
  objects: Map<number, PdfObject>, trailer: PdfDict, ver = '1.7',
): Uint8Array {
  const plan = planDocument(objects, trailer);
  const part = partitionForLinearization(plan);

  // Renumbered order for the linearized file: first-page section first, then the
  // hint stream, then the remainder. Build old(plan-new) -> lin-new map so each
  // section is a contiguous range.
  const linOrder = [...part.firstPageNew];          // first-page objects (incl. catalog=1)
  const hintLinNum = linOrder.length + 1;           // hint stream gets the next number
  const remainderStart = hintLinNum + 1;
  const remainderOrder = [...part.remainderNew];
  // planNew -> linNew
  const toLin = new Map<number, number>();
  linOrder.forEach((planNew, i) => toLin.set(planNew, i + 1));
  remainderOrder.forEach((planNew, i) => toLin.set(planNew, remainderStart + i));
  const total = plan.objs.length + 1;               // +1 for the hint stream

  // Re-remap object bodies so their internal refs use lin-new numbers.
  const remapToLin = (o: PdfObject): PdfObject => /* deep copy rewriting ref.num via toLin; mirror serializer.remap */ o as PdfObject;
  // NOTE: implement remapToLin exactly like serializer.ts `remap`, but using
  // `toLin.get(ref.num)` and keeping gen 0. (Copy that 14-line function here.)

  // Serialize each object body once (lengths known).
  const firstPageBodies = part.firstPageNew.map((pn) => serializeObject(remapToLin(plan.objs[pn - 1])));
  const remainderBodies = part.remainderNew.map((pn) => serializeObject(remapToLin(plan.objs[pn - 1])));

  // Hint stream body is computed in Task 5; here it is an empty stream object.
  const hintStreamRaw = buildHintStream(/* part, offsets */); // Task 5; returns Uint8Array (empty for now)

  const L = new Layout();
  L.put(`%PDF-${ver}\n%\xE2\xE3\xCF\xD3\n`);

  // --- linearization parameter dictionary (lin object number = total+? ) ---
  // The param dict itself is an extra object. Give it lin number `total+1`.
  const paramNum = total + 1;
  const paramOffset = L.length;
  L.put(`${paramNum} 0 obj\n<< /Linearized 1 /L `); L.slot('L');
  L.put(` /H [ `); L.slot('Hoff'); L.put(' '); L.slot('Hlen');
  L.put(` ] /O ${toLin.get(part.firstPageObjNew)} /E `); L.slot('E');
  L.put(` /N ${part.pageCount} /T `); L.slot('T');
  L.put(` >>\nendobj\n`);

  // --- first-page xref section ---  (covers lin objects 1..hintLinNum)
  // record object offsets as we emit bodies; but xref must precede bodies in the
  // file, so: emit a fixed-width xref with slots, then bodies, then backfill.
  // ... (emit `xref\n1 <hintLinNum>\n` then PAD-based entries via slots keyed
  //      `obj:<linNum>`, then a trailer with /Prev slot 'mainXref') ...

  // --- first-page object bodies (record offsets into slots) ---
  // --- hint stream object (record /H offset+length) ---
  // --- remainder bodies ---
  // --- main xref section + final startxref(first-page-xref offset) ---

  // Compute all slot values, then L.finalize(values).
  // (The implementer fills the body emission + offset bookkeeping following the
  //  Annex F layout; every recorded offset feeds a slot.)
}
```

This step is the structural core. Implement it concretely:
- Copy `serializer.ts`'s `remap` into `linearize.ts` as `remapToLin` using `toLin`.
- Emit the file in Annex F order, recording each object's byte offset in a `Map<number, number>` (lin number → offset) as bodies are written.
- For the two xref sections, first reserve the xref bytes with PAD-width slots keyed `obj:<n>`, emit the bodies (filling the offset map), and backfill. Because xref entry format is fixed width (`0000000000 00000 n \n`), reserve exactly that and overwrite the 10-digit offset.
- `/L` = final length; `/T` = main-xref offset; `/E` = offset of the end of the first page's objects; `/O` = lin number of first page; `/H` = [hint-stream-data-offset, hint-stream-data-length].
- Final `startxref` points to the first-page xref offset.

Keep the param dict within the first 1024 bytes (it is — header + dict are small).

- [ ] **Step 4: Implement structural `verifyLinearization` + export**

Add to `src/linearize.ts`:

```ts
export interface LinearizationCheck { linearized: boolean; errors: string[]; }

export function verifyLinearization(bytes: Uint8Array): LinearizationCheck {
  const errors: string[] = [];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const linM = /<<[^>]*\/Linearized\b[\s\S]*?>>/.exec(head);
  if (!linM) return { linearized: false, errors: ['no /Linearized dict in first 1024 bytes'] };
  const num = (k: string): number | undefined => {
    const m = new RegExp(`/${k}\\s+(\\d+)`).exec(linM[0]); return m ? Number(m[1]) : undefined;
  };
  const L = num('L');
  if (L !== bytes.length) errors.push(`/L ${L} != file length ${bytes.length}`);
  // /T must equal the offset of the main xref ('xref' nearest end before startxref).
  // /O must be a valid object whose dict has /Type /Page (re-parse via Document).
  // First-page xref offsets must match real object positions (scan '<n> 0 obj').
  // Hint checks added in Task 5.
  return { linearized: true, errors };
}
```

Implement the `/T`, `/O`, and xref-offset checks concretely (re-open with `Document.Open` to resolve `/O`; scan the byte stream for `\n<n> 0 obj` to confirm offsets). Export from `index.ts`:

```ts
export { verifyLinearization } from './linearize.js';
export type { LinearizationCheck } from './linearize.js';
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/linearize.test.ts && npm run typecheck`
Expected: the structure tests PASS; typecheck clean. Debug real failures (offset bookkeeping is the likely culprit) before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/linearize.ts src/index.ts test/linearize.test.ts
git commit -m "feat(linearize): param dict, two xref sections, offset backfill"
```

---

### Task 5: Primary hint stream (page-offset + shared-object tables)

Fill the hint stream with the two mandatory tables and extend `verifyLinearization` to validate them. After this task the output is qpdf-clean.

**Authoritative reference:** ISO 32000-1:2008 Annex F.3 — the page-offset hint table (F.3.4, Tables F.3–F.4) and shared-object hint table (F.3.5, Tables F.5–F.6). The bit-widths and field order below MUST be taken from those tables; do not infer them.

**Files:**
- Modify: `src/linearize.ts`
- Test: `test/linearize.test.ts`

**Interfaces:**
- Consumes: the offset map and `Partition` from Task 4.
- Produces: `buildHintStream(...)` returning the real hint-stream bytes; hint validation in `verifyLinearization`.

- [ ] **Step 1: Write the failing tests**

Add to `test/linearize.test.ts`:

```ts
import { buildSharedResource as bsr, buildSinglePage as bsp2 } from './helpers/build-linear-fixtures.js';

describe('serializeLinearized — hint stream', () => {
  for (const [name, build] of [['single', bsp2], ['shared', bsr]] as const) {
    it(`is fully verifyLinearization-clean (${name})`, () => {
      const out = Document.Open(build()).Save({ linearized: true });
      const check = verifyLinearization(out);
      expect(check.linearized).toBe(true);
      expect(check.errors).toEqual([]);          // including hint checks now
    });
  }
  it('catches corruption (verifier is not vacuous)', () => {
    const out = Document.Open(bsp2()).Save({ linearized: true });
    const corrupt = out.slice();
    // Flip a digit inside the /L value in the param dict.
    const i = new TextDecoder('latin1').decode(corrupt.subarray(0, 1024)).indexOf('/L ') + 3;
    corrupt[i] = corrupt[i] === 0x39 ? 0x38 : corrupt[i] + 1;
    expect(verifyLinearization(corrupt).errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/linearize.test.ts -t "hint stream"`
Expected: FAIL — empty placeholder hint stream fails the hint checks; corruption test may already pass (the `/L` check from Task 4 catches it — that is acceptable).

- [ ] **Step 3: Add the bit-writer/reader helpers**

Add to `src/linearize.ts`:

```ts
/** MSB-first bit writer for hint tables. */
class BitWriter {
  private bytes: number[] = [];
  private cur = 0; private nbits = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
    }
  }
  finish(): Uint8Array {
    if (this.nbits > 0) { this.bytes.push(this.cur << (8 - this.nbits)); this.cur = 0; this.nbits = 0; }
    return Uint8Array.from(this.bytes);
  }
}

/** MSB-first bit reader (used by verifyLinearization). */
class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array, private bitPos = 0) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.bitPos >> 3] ?? 0;
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
      v = (v << 1) | bit; this.bitPos++;
    }
    return v >>> 0;
  }
}
```

- [ ] **Step 4: Implement `buildHintStream`**

Implement against Annex F.3. The function receives, per page in document order: the page's object count, the page's byte length, the offset of its first object, and the set of shared objects it uses; plus the global shared-object list with each shared object's length. Build the page-offset hint table header (F.3.4 Table F.3 fields), the per-page entries (Table F.4 fields), then the shared-object hint table header (F.3.5 Table F.5) and entries (Table F.6), writing each field with `BitWriter.write(value, bitsFromIsoTable)`. Set the hint stream dict `/S` to the byte offset of the shared-object table within the stream data. `deflateSync` the result. **Use the exact bit-widths from the ISO tables.**

Because the precise widths are normative, after a first implementation run `qpdf --check` (Step 7) and iterate until it reports "File is linearized" with no warnings; `verifyLinearization` (Step 5) independently recomputes the same values from object offsets and compares.

- [ ] **Step 5: Extend `verifyLinearization` with hint checks**

Parse the hint stream from `/H`, inflate it, and with `BitReader` re-read the page-offset and shared-object tables. Recompute the expected per-page object counts/offsets and shared-object lengths from the file's actual object positions (scan `\n<n> 0 obj`), and push an error for any mismatch. This makes the verifier the true gate.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run test/linearize.test.ts && npm run typecheck`
Expected: PASS (hint checks clean for both fixtures; corruption caught); typecheck clean. If the hint tests fail, the bit layout disagrees with the ISO tables — fix widths, do not weaken the verifier.

- [ ] **Step 7: Manual qpdf acceptance (documented gate)**

If `qpdf` is available, run:

```bash
node -e "const{Document}=require('./dist/index.js');const fs=require('fs');fs.writeFileSync('/tmp/lin.pdf',Document.Open(fs.readFileSync('test/fixtures/any.pdf')).Save({linearized:true}))" 2>/dev/null || true
qpdf --check /tmp/lin.pdf
```

Expected: "File is linearized" and "No errors found". This is a manual/CI acceptance step, not part of the vitest suite. Record the result in the commit message.

- [ ] **Step 8: Commit**

```bash
git add src/linearize.ts test/linearize.test.ts
git commit -m "feat(linearize): page-offset + shared-object hint tables; verifier hint checks"
```

---

### Task 6: Documentation + full-suite verification

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Update README Features**

Add a bullet near the compressed-output entry:

```markdown
- **Linearization (Fast Web View)** — `doc.Save({ linearized: true })` emits a
  linearized PDF (ISO 32000-1 Annex F): a parameter dictionary first, the first
  page's objects and a primary hint stream near the front, and two chained
  cross-reference sections, so a viewer can render page 1 before the whole file
  downloads. `doc.IsLinearized` reports whether an opened file is linearized, and
  `verifyLinearization(bytes)` re-checks output offsets/hints. Classic-xref,
  plaintext output only.
```

- [ ] **Step 2: Update README Limitations**

```markdown
- **Linearization is classic-xref and plaintext only** — `Save({ linearized: true })`
  rejects `compressed: true` and `encrypt` (they throw `UnsupportedFeatureError`).
  Only the two mandatory hint tables (page-offset, shared-object) are emitted;
  the optional thumbnail/outline/thread/named-destination/form hint tables are
  not. `qpdf --check` is the external conformance gate.
```

- [ ] **Step 3: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire suite green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: linearization (Fast Web View) output"
```

---

## Self-Review

**Spec coverage:**
- `Save({ linearized: true })` classic/plaintext output → Tasks 2 (plumbing), 4 (layout), 5 (hints).
- `IsLinearized` getter → Task 1.
- `verifyLinearization` exported gate → Task 4 (structural) + Task 5 (hint).
- Partition (first-page set / remainder / shared) → Task 3.
- Two chained xref sections + param dict + offset backfill → Task 4.
- Mandatory hint tables only → Task 5.
- Unsupported `compressed`/`encrypt`/no-page → Task 2 (combos) + Task 3 (`findPages` throws no-page).
- qpdf manual gate → Task 5 Step 7.
- README Features + Limitations → Task 6.

**Placeholder scan:** Task 4 Step 3 and Task 5 Step 4 intentionally describe the offset-bookkeeping and ISO-bit-layout work at the level of exact helper code (`Layout`, `BitWriter`/`BitReader`) plus a normative ISO reference, because the bit-widths are defined by ISO Tables F.3–F.6 and must be copied from them, not invented. This is a deliberate reference dependency, flagged in Global Constraints — not an unspecified placeholder. All other steps carry complete code.

**Type consistency:** `Partition` (Task 3) consumed by `serializeLinearized` (Task 4). `LinearizationCheck`/`verifyLinearization` (Task 4) extended in Task 5. `planDocument`/`refsIn`/`Plan` exported in Task 2, consumed in Tasks 3–4. `toLin`/`remapToLin` mirror `serializer.ts` `oldToNew`/`remap`.
