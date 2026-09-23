# Structural Validate() and Repair() Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.Validate()` (page-tree structural checks) and `doc.Repair()` (fix what it reports, in place), and stop our own page edits from writing a tree that fails those checks.

**Architecture:** One new module, `src/pagecheck.ts`, holds a single walk over the raw `/Kids` graph from `/Root`, used in two modes: collect-only (`Validate`) and collect-and-fix (`Repair`). `document.ts` wires both public methods and gains a private `flattenToRoot()` that copies inherited page attributes down before any edit re-lists pages under the root.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-structural-validate-repair-design.md` (read it, including its two "Amended while planning" notes).

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Every `catch` in `src/` calls `rethrowLimit(e)` as its FIRST statement, with a named binding (`catch (caught) {`). `test/limits-catch.test.ts` enforces this.
- Never write `this.objects.set` in `document.ts`; objects enter only through `install` / `allocObject` (`test/limits-acquired.test.ts` enforces this).
- Rule ids are exactly: `CatalogInvalid`, `PageTreeShared`, `PageCountMismatch`, `PageParentMismatch`, `PageMediaBoxMissing`. All `severity: 'error'`.
- Default media box written by Repair: `[0, 0, 612, 792]` (US Letter, what `Page.MediaBox` already reports).
- Inheritable keys copied down by `flattenToRoot`: `MediaBox`, `CropBox`, `Resources`, `Rotate`.
- Presence of a key is tested on the RAW dict (`dict.has(k)`), never by comparing a resolved value with `undefined` — `doc.resolve(undefined)` is `null`.
- Before closing: `npm run typecheck` and `npm test` both green.
- Beads issue: `aspose-pdf-foss-for-ts-dmin.4`. Commit messages prefixed `feat(dmin.4):` / `fix(dmin.4):` / `docs(dmin.4):`, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Raw page-tree fixture helper + `Validate()`

**Files:**
- Create: `test/helpers/build-page-tree-pdf.ts`
- Create: `src/pagecheck.ts`
- Modify: `src/document.ts` (import + public `Validate()` method, place it next to `ValidatePdfA` at ~line 1290)
- Test: `test/page-validate.test.ts`

**Interfaces:**
- Produces:
  - `buildRawPdf(objects: string[]): Uint8Array` — object `i` (0-based) becomes `i+1 0 obj`; trailer `/Root 1 0 R`.
  - `buildNestedPageTreePdf(): Uint8Array` — the canonical nested fixture below.
  - `checkPageTree(doc: Document, fix: boolean): ValidationIssue[]` in `src/pagecheck.ts`.
  - `LETTER_MEDIABOX: readonly number[]` = `[0, 0, 612, 792]` in `src/pagecheck.ts`.
  - `Document.Validate(): ValidationReport`.

- [ ] **Step 1: Write the fixture helper**

`test/helpers/build-page-tree-pdf.ts`:

```ts
/** Hand-built PDFs for page-tree structure tests (dmin.4). The object bodies
 *  are written raw, so a test can state a broken /Count, a stale /Parent or a
 *  shared kid exactly as a damaged file would carry it — which no Document
 *  API will produce. */

/** Object i (0-based) is written as `i+1 0 obj`; the trailer's /Root is 1. */
export function buildRawPdf(objects: string[]): Uint8Array {
  let s = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(s.length);
    s += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) s += `${String(o).padStart(10, '0')} 00000 n \n`;
  s += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}

/** Root 2 lists intermediate node 3 (carrying /MediaBox [0 0 100 100], holding
 *  pages 4 and 5) and page 6 (its own 200x200 box). Structurally sound. */
export function buildNestedPageTreePdf(): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 >>',
    '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 3 0 R >>',
    '<< /Type /Page /Parent 3 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ]);
}
```

- [ ] **Step 2: Write the failing tests**

`test/page-validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isRef } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';

const rules = (d: Document) => d.Validate().Issues.map((i) => i.rule);

describe('doc.Validate() — clean documents', () => {
  it('passes a nested, sound page tree', () => {
    const r = Document.Open(buildNestedPageTreePdf()).Validate();
    expect(r.Issues).toEqual([]);
    expect(r.Passed).toBe(true);
  });

  it('passes a document authored in memory', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.AddPage(PageFormat.A4);
    expect(rules(d)).toEqual([]);
  });
});

describe('doc.Validate() — rules', () => {
  it('PageCountMismatch: /Count disagrees with the pages found', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 7 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const [issue] = d.Validate().Issues;
    expect(issue.rule).toBe('PageCountMismatch');
    expect(issue.severity).toBe('error');
    expect(issue.object?.num).toBe(2);
  });

  it('PageCountMismatch fires on an INTERMEDIATE node, not just the root', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 5 >>',
      '<< /Type /Page /Parent 3 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageCountMismatch', 3]]);
  });

  it('PageParentMismatch: a kid whose /Parent is not the node listing it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const [issue, ...rest] = d.Validate().Issues;
    expect(rest).toEqual([]);
    expect(issue.rule).toBe('PageParentMismatch');
    expect(issue.object?.num).toBe(4);
    expect(issue.page).toBe(d.Pages[1]);
  });

  it('PageParentMismatch: a kid with no /Parent at all', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page >>',
    ]));
    expect(rules(d)).toEqual(['PageParentMismatch']);
  });

  it('PageMediaBoxMissing: no /MediaBox on the page or anywhere above it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const issues = d.Validate().Issues;
    expect(issues.map((i) => [i.rule, i.object?.num])).toEqual([['PageMediaBoxMissing', 4]]);
    expect(issues[0].page).toBe(d.Pages[1]);
  });

  it('PageMediaBoxMissing: inherited from an intermediate node counts', () => {
    // buildNestedPageTreePdf: pages 4 and 5 own no box; node 3 carries one.
    expect(rules(Document.Open(buildNestedPageTreePdf()))).toEqual([]);
  });

  it('PageTreeShared: a node reached twice (after a live mutation)', () => {
    // Open refuses a shared node outright (tracked as 1lr9), so the fixture
    // shares one through the live model — which Validate must still see,
    // because it reads the raw graph rather than doc.Pages.
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const root = d.resolve(d.catalog().get('Pages'));
    if (!isDict(root)) throw new Error('fixture');
    const kids = d.resolve(root.get('Kids'));
    if (!Array.isArray(kids)) throw new Error('fixture');
    kids.push(kids[0]);
    root.set('Count', 2);
    expect(rules(d)).toEqual(['PageTreeShared']);
  });

  it('PageTreeShared: a genuine /Kids cycle terminates and is reported', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    // Point node 3 back at the root through its /Kids after Open.
    const n3 = d.resolve({ kind: 'ref', num: 3, gen: 0 });
    if (!isDict(n3)) throw new Error('fixture');
    const kids = d.resolve(n3.get('Kids'));
    if (!Array.isArray(kids)) throw new Error('fixture');
    kids.push({ kind: 'ref', num: 2, gen: 0 });
    expect(rules(d)).toContain('PageTreeShared');
  });

  it('CatalogInvalid: /Pages is not a /Type /Pages dictionary', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    d.catalog().set('Pages', { kind: 'ref', num: 3, gen: 0 });
    const r = d.Validate();
    expect(r.Issues.map((i) => i.rule)).toEqual(['CatalogInvalid']);
    expect(r.Passed).toBe(false);
  });
});

describe('doc.Validate() — deliberate non-rules', () => {
  it('a dangling reference is not a failure (7.3.10 makes it null)', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 99 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R /Annots [98 0 R] >>',
    ]));
    expect(rules(d)).toEqual([]);
  });

  it('a /Kids entry naming a missing object is null, and only the /Count sees it', () => {
    // /Count 1 agrees with the one real page: nothing to report.
    const ok = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(rules(ok)).toEqual([]);
  });

  it('back-references are not cycles: /Parent, an annotation /P, outline /Prev', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R /Annots [4 0 R] >>',
      '<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /P 3 0 R >>',
      '<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>',
      '<< /Title (a) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>',
      '<< /Title (b) /Parent 5 0 R /Prev 6 0 R /Dest [3 0 R /Fit] >>',
    ]));
    expect(rules(d)).toEqual([]);
  });

  it('reads the raw graph, not doc.Pages', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.Pages[0].Dict.delete('Parent');
    expect(rules(d)).toEqual(['PageParentMismatch']);
    expect(isRef(d.Validate().Issues[0].object)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run test/page-validate.test.ts`
Expected: FAIL — `d.Validate is not a function`.

- [ ] **Step 4: Write `src/pagecheck.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ValidationIssue } from './validation.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef } from './types.js';
import { rethrowLimit } from './errors.js';

/** US Letter — the box `Page.MediaBox` reports for a page that states none, so
 *  a repaired file agrees with what this library has been rendering. */
export const LETTER_MEDIABOX: readonly number[] = [0, 0, 612, 792];

interface Walk {
  doc: Document;
  fix: boolean;
  issues: ValidationIssue[];
  /** Every node reached so far, for PageTreeShared. */
  seen: Set<PdfDict>;
  /** Pages under each finished intermediate node, so a shared node still
   *  counts toward its second parent in validate mode. */
  counts: Map<PdfDict, number>;
  /** Live Page handle per page dict, for ValidationIssue.page. */
  pageOf: Map<PdfDict, Page>;
}

/** The page-tree structure check behind `doc.Validate()` (`fix` false) and
 *  `doc.Repair()` (`fix` true). ONE walk for both, so a checker and a fixer
 *  cannot disagree about which nodes are pages.
 *
 *  It reads the RAW `/Kids` graph from `/Root`, never `doc.Pages`, so damage
 *  done through a page's live `Dict` after Open is visible. It follows `/Kids`
 *  ONLY: `/Parent`, an annotation's `/P` and an outline's `/Prev` are
 *  back-references the format requires, not cycles. A reference to an absent
 *  object is null (7.3.10) and is not itself a failure.
 *
 *  Leaf versus intermediate is decided exactly as `pagetree.ts`'s `buildPages`
 *  decides it, so this and `doc.Pages` agree about which nodes are pages. */
export function checkPageTree(doc: Document, fix: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let catalog: PdfDict;
  try {
    catalog = doc.catalog();
  } catch (caught) {
    rethrowLimit(caught);
    issues.push(issue('CatalogInvalid', '/Root does not resolve to a dictionary'));
    return issues;
  }
  if (!isNamed(doc.resolve(catalog.get('Type')), 'Catalog')) {
    issues.push(issue('CatalogInvalid', 'the /Root dictionary is not /Type /Catalog'));
    return issues;
  }
  const rootRaw = catalog.get('Pages');
  const root = doc.resolve(rootRaw);
  if (!isDict(root) || !isNamed(doc.resolve(root.get('Type')), 'Pages')) {
    issues.push(issue('CatalogInvalid', 'the catalog /Pages is not a /Type /Pages dictionary',
      isRef(rootRaw) ? rootRaw : undefined));
    return issues;
  }
  const w: Walk = {
    doc, fix, issues, seen: new Set(), counts: new Map(),
    pageOf: new Map(doc.Pages.map((p) => [p.Dict, p])),
  };
  visit(w, root, isRef(rootRaw) ? rootRaw : undefined, new Set(), false, 1);
  return issues;
}

/** Visit an intermediate node; returns the number of pages found under it. */
function visit(
  w: Walk, node: PdfDict, nodeRef: PdfRef | undefined,
  ancestors: Set<PdfDict>, boxAbove: boolean, depth: number,
): number {
  // Same bound, same unit, as buildPages: levels of intermediate nodes.
  w.doc.loadLimits.enforce('maxNestingDepth', depth, 'page tree');
  w.seen.add(node);
  ancestors.add(node);
  const boxHere = boxAbove || node.has('MediaBox');
  const kidsVal = w.doc.resolve(node.get('Kids'));
  const kids: PdfObject[] = isArray(kidsVal) ? kidsVal : [];
  const kept: PdfObject[] = [];
  let changed = false;
  let pages = 0;

  for (const raw of kids) {
    let child = w.doc.resolve(raw);
    // A dead kid is legal null: it contributes no page, and only the /Count
    // check below can notice it.
    if (!isDict(child)) { kept.push(raw); continue; }
    let childRaw: PdfObject = raw;

    if (w.seen.has(child)) {
      const cyclic = ancestors.has(child);
      w.issues.push(issue('PageTreeShared', cyclic
        ? 'a page-tree node lists one of its own ancestors in /Kids'
        : 'a page-tree node is listed more than once', refOf(raw), w.pageOf.get(child)));
      if (!w.fix) {
        pages += cyclic ? 0 : (w.counts.get(child) ?? 1);
        kept.push(raw);
        continue;
      }
      changed = true;
      // Copying an ancestor would never terminate: drop the back edge.
      if (cyclic) continue;
      const copy: PdfDict = new Map(child);
      childRaw = isRef(raw) ? w.doc.allocObject(copy) : copy;
      child = copy;
    }

    // A kid of an INLINE node cannot name it: there is no reference to write.
    if (nodeRef !== undefined && w.doc.resolve(child.get('Parent')) !== node) {
      w.issues.push(issue('PageParentMismatch',
        'a page-tree node\'s /Parent is not the node that lists it',
        refOf(childRaw), w.pageOf.get(child)));
      if (w.fix) child.set('Parent', nodeRef);
    }

    if (isLeaf(w.doc, child)) {
      w.seen.add(child);
      pages += 1;
      if (!boxHere && !child.has('MediaBox')) {
        w.issues.push(issue('PageMediaBoxMissing',
          'a page has no /MediaBox on itself or on any node above it',
          refOf(childRaw), w.pageOf.get(child)));
        if (w.fix) child.set('MediaBox', [...LETTER_MEDIABOX]);
      }
    } else {
      pages += visit(w, child, isRef(childRaw) ? childRaw : undefined, ancestors, boxHere, depth + 1);
    }
    kept.push(childRaw);
  }
  ancestors.delete(node);

  if (w.doc.resolve(node.get('Count')) !== pages) {
    w.issues.push(issue('PageCountMismatch',
      `/Count does not agree with the ${pages} page(s) found under this node`, nodeRef));
    if (w.fix) {
      node.set('Count', pages);
      // Only where /Count is being corrected: a null kid is legal, so a node
      // Validate passes keeps it and a clean document stays byte-identical.
      const live = kept.filter((k) => isDict(w.doc.resolve(k)));
      if (live.length !== kept.length) { kept.length = 0; kept.push(...live); changed = true; }
    }
  }
  if (w.fix && changed) node.set('Kids', kept);
  w.counts.set(node, pages);
  return pages;
}

/** buildPages' rule, verbatim: /Type /Page is a leaf; else a /Kids array makes
 *  an intermediate node; else a leaf. */
function isLeaf(doc: Document, d: PdfDict): boolean {
  const type = d.get('Type');
  if (isName(type) && type.name === 'Page') return true;
  return !isArray(doc.resolve(d.get('Kids')));
}

function isNamed(v: PdfObject, n: string): boolean {
  return isName(v) && v.name === n;
}

function refOf(o: PdfObject): PdfRef | undefined {
  return isRef(o) ? o : undefined;
}

function issue(rule: string, message: string, object?: PdfRef, page?: Page): ValidationIssue {
  const out: ValidationIssue = { rule, severity: 'error', message };
  if (object) out.object = object;
  if (page) out.page = page;
  return out;
}
```

Note on the shared-node count fallback `?? 1`: a shared LEAF is never put in `counts` (only intermediate nodes are), and it is one page. `isArray` narrows to the mutable `PdfArray = PdfObject[]`.
- [ ] **Step 5: Wire `Validate()` in `src/document.ts`**

Add the import beside the other local imports:

```ts
import { checkPageTree } from './pagecheck.js';
```

Add next to `ValidatePdfA` (~line 1290):

```ts
  /** Check the document's structural integrity (`dmin.4`): the catalog
   *  resolves to a `/Type /Catalog` whose `/Pages` is a `/Type /Pages` node,
   *  every page-tree node is reached once, every intermediate node's `/Count`
   *  agrees with the pages under it, every kid's `/Parent` is the node listing
   *  it, and every page has a `/MediaBox` on itself or above it.
   *
   *  Reads the raw object graph, so damage made through a live `Dict` after
   *  Open is visible. Two things are deliberately NOT failures: a
   *  back-reference (`/Parent`, `/P`, `/Prev` — the format requires them),
   *  and a reference to an object the file does not have, which 7.3.10 makes
   *  null. Never throws on a broken structure; see {@link Repair}. */
  Validate(): ValidationReport {
    return new ValidationReport(checkPageTree(this, false));
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/page-validate.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/pagecheck.ts src/document.ts test/page-validate.test.ts test/helpers/build-page-tree-pdf.ts
git commit -m "feat(dmin.4): doc.Validate() page-tree structural checks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `Repair()`

**Files:**
- Modify: `src/document.ts` (public `Repair()` directly after `Validate()`; add `import type { ValidationIssue } from './validation.js';` — `ValidationReport` is already imported from `./structvalidate.js`)
- Test: `test/page-repair.test.ts`

**Interfaces:**
- Consumes: `checkPageTree(doc, true)`, `buildRawPdf`, `buildNestedPageTreePdf` (Task 1); `buildSigner()` from `test/helpers/build-signer.ts` (returns `{ certificate, privateKey }`).
- Produces: `Document.Repair(): ValidationIssue[]`.

- [ ] **Step 1: Write the failing tests**

`test/page-repair.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isArray, isDict } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const rootOf = (d: Document) => {
  const r = d.resolve(d.catalog().get('Pages'));
  if (!isDict(r)) throw new Error('no root');
  return r;
};
const reopen = (d: Document) => Document.Open(d.Save());

describe('doc.Repair()', () => {
  it('returns [] and touches nothing on a sound document', () => {
    const base = buildNestedPageTreePdf();
    const d = Document.Open(base);
    const before = d.Save();
    expect(d.Repair()).toEqual([]);
    expect(d.Save()).toEqual(before);
  });

  it('does not mark a sound document modified (the sign path keeps its base)', async () => {
    // A full rewrite of an untouched model reproduces the same bytes, so a
    // save alone cannot see a spurious markModified(). Signing can: the
    // incremental append is taken only for an UNMODIFIED base.
    const d0 = Document.Open(buildNestedPageTreePdf());
    const base = d0.Save();
    const d = Document.Open(base);
    d.Repair();
    const s = buildSigner();
    await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(d.Save().subarray(0, base.length)).toEqual(base);
  });

  it('a salvaged /Count 7 over one page writes /Count 1 and drops the dead kid', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 7 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageCountMismatch']);
    const re = reopen(d);
    const root = rootOf(re);
    expect(root.get('Count')).toBe(1);
    const kids = re.resolve(root.get('Kids'));
    expect(isArray(kids) ? kids.length : -1).toBe(1);
    expect(re.Validate().Passed).toBe(true);
  });

  it('keeps a dead kid on a node whose /Count is already right', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    expect(d.Repair()).toEqual([]);
    const kids = d.resolve(rootOf(d).get('Kids'));
    expect(isArray(kids) ? kids.length : -1).toBe(2);
  });

  it('points a stale /Parent at the node listing it', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageParentMismatch']);
    expect(d.resolve(d.Pages[1].Dict.get('Parent'))).toBe(rootOf(d));
    expect(reopen(d).Validate().Passed).toBe(true);
  });

  it('writes US Letter onto a page with no /MediaBox anywhere', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const before = d.Pages[0].MediaBox;
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageMediaBoxMissing']);
    expect(d.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
    // The written box is the one the library already reported.
    expect(d.Pages[0].MediaBox).toEqual(before);
  });

  it('copies a shared page so each listing owns its node', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const root = rootOf(d);
    const kids = d.resolve(root.get('Kids'));
    if (!isArray(kids)) throw new Error('fixture');
    kids.push(kids[0]);
    root.set('Count', 2);
    expect(d.Repair().map((i) => i.rule)).toEqual(['PageTreeShared']);
    expect(d.Pages.length).toBe(2);
    expect(d.Pages[0].Dict).not.toBe(d.Pages[1].Dict);
    expect(d.Validate().Passed).toBe(true);
    expect(reopen(d).Pages.length).toBe(2);
  });

  it('drops the back edge of a genuine /Kids cycle', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 3 0 R >>',
    ]));
    const n3 = d.resolve({ kind: 'ref', num: 3, gen: 0 });
    if (!isDict(n3)) throw new Error('fixture');
    const kids = d.resolve(n3.get('Kids'));
    if (!isArray(kids)) throw new Error('fixture');
    kids.push({ kind: 'ref', num: 2, gen: 0 });
    expect(d.Repair().map((i) => i.rule)).toContain('PageTreeShared');
    expect(d.Validate().Passed).toBe(true);
    expect(reopen(d).Pages.length).toBe(1);
  });

  it('refreshes doc.Pages', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 1 1] >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    const root = rootOf(d);
    const kids = d.resolve(root.get('Kids'));
    if (!isArray(kids)) throw new Error('fixture');
    kids.push(kids[0]);
    d.Repair();
    expect(d.Pages.map((p) => p.Number)).toEqual([1, 2]);
  });

  it('does not repair CatalogInvalid (nothing to rebuild from)', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.catalog().set('Pages', { kind: 'ref', num: 4, gen: 0 });
    expect(d.Repair()).toEqual([]);
    expect(d.Validate().Issues.map((i) => i.rule)).toEqual(['CatalogInvalid']);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run test/page-repair.test.ts`
Expected: FAIL — `d.Repair is not a function`.

- [ ] **Step 3: Implement `Repair()`**

In `src/document.ts`, directly after `Validate()`:

```ts
  /** Fix, in place, what {@link Validate} reports about the page tree
   *  (`dmin.4`), keeping the file's tree shape: a shared node is copied, a
   *  `/Kids` cycle loses its back edge, a wrong `/Count` is recounted (and only
   *  there are `/Kids` entries naming nothing dropped), a stale `/Parent` is
   *  repointed, and a page with no `/MediaBox` anywhere gets US Letter — the
   *  size `Page.MediaBox` already reported for it. Returns the issues it
   *  fixed; afterwards `Validate().Passed` is true unless the catalog itself is
   *  invalid, which is not repairable.
   *
   *  On a sound document it returns `[]` and touches NOTHING, including the
   *  modified flag — a no-op that marked the document modified would turn a
   *  following sign into a full rewrite of bytes an earlier signature covered. */
  Repair(): ValidationIssue[] {
    const fixed = checkPageTree(this, true).filter((i) => i.rule !== 'CatalogInvalid');
    if (fixed.length === 0) return fixed;
    this.markModified();
    const tree = buildPages(this);
    this.Pages.length = 0;
    this.Pages.push(...tree.pages);
    this.pageObjNums = tree.pageObjNums;
    return fixed;
  }
```

Note: when the catalog is invalid, `checkPageTree` returns before the walk, so the filter yields `[]` and nothing was mutated.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/page-repair.test.ts test/page-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/document.ts test/page-repair.test.ts
git commit -m "feat(dmin.4): doc.Repair() reconciles the page tree in place

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Page edits stop writing stale `/Parent` chains

**Files:**
- Modify: `src/document.ts` — hoist the inheritable-key list to module level; new private `flattenToRoot()`; call it from `Reorder` and `currentKids()`; use the hoisted list in `importPages` (~line 3296).
- Test: `test/page-edit-tree.test.ts`

**Interfaces:**
- Consumes: `buildNestedPageTreePdf`, `buildRawPdf` (Task 1); `Document.Validate()` (Task 1).
- Produces: nothing public.

- [ ] **Step 1: Write the failing tests**

`test/page-edit-tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict } from '../src/types.js';
import { buildRawPdf, buildNestedPageTreePdf } from './helpers/build-page-tree-pdf.js';

const reopen = (d: Document) => Document.Open(d.Save());
const boxes = (d: Document) => d.Pages.map((p) => p.MediaBox);

describe('page edits on a nested tree (dmin.4)', () => {
  it('RemovePage leaves a tree Validate passes and keeps the inherited box', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.RemovePage(3);
    expect(d.Validate().Issues).toEqual([]);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re)).toEqual([[0, 0, 100, 100], [0, 0, 100, 100]]);
  });

  it('Reorder keeps the intermediate node\'s box (it used to reset /Parent first)', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.Reorder([3, 1, 2]);
    expect(boxes(d)).toEqual([[0, 0, 200, 200], [0, 0, 100, 100], [0, 0, 100, 100]]);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re)).toEqual([[0, 0, 200, 200], [0, 0, 100, 100], [0, 0, 100, 100]]);
  });

  it('InsertPage leaves a tree Validate passes', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.InsertPage(1, PageFormat.A4);
    const re = reopen(d);
    expect(re.Validate().Issues).toEqual([]);
    expect(boxes(re).slice(1)).toEqual([[0, 0, 100, 100], [0, 0, 100, 100], [0, 0, 200, 200]]);
  });

  it('every page\'s /Parent is the root afterwards, and the intermediate node is gone', () => {
    const d = Document.Open(buildNestedPageTreePdf());
    d.RemovePage(3);
    const re = reopen(d);
    const root = re.resolve(re.catalog().get('Pages'));
    for (const p of re.Pages) expect(re.resolve(p.Dict.get('Parent'))).toBe(root);
    // Node 3 was the only /Pages node besides the root.
    let pagesNodes = 0;
    for (const [, obj] of re.objectEntries()) {
      if (isDict(obj) && obj.get('Type') && (obj.get('Type') as { name?: string }).name === 'Pages') pagesNodes++;
    }
    expect(pagesNodes).toBe(1);
  });

  it('does not copy the ROOT\'s own values down — the page still inherits them', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 50 50] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Page /Parent 2 0 R >>',
    ]));
    d.RemovePage(2);
    expect(d.Pages[0].Dict.has('MediaBox')).toBe(false);
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 50, 50]);
  });

  it('does not overwrite a value the page states itself', () => {
    const d = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R] /Count 1 /MediaBox [0 0 100 100] /Rotate 90 >>',
      '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 7 7] >>',
    ]));
    d.InsertPage(2, PageFormat.A4);
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 7, 7]);
    expect(d.Pages[0].Rotate).toBe(90);
  });
});
```

`objectEntries()` is a generator of `[PdfRef, PdfObject]` pairs (document.ts ~line 1326).

Run: `npx vitest run test/page-edit-tree.test.ts`
Expected: FAIL — the RemovePage/InsertPage cases report `PageParentMismatch` and `PageCountMismatch` (node 3 still lists pages); the Reorder case reports `[0,0,612,792]` for the moved pages.

- [ ] **Step 3: Implement `flattenToRoot()`**

At module level in `src/document.ts`, near the other module constants:

```ts
/** The page attributes 7.7.3.4 makes inheritable. */
const INHERITABLE_PAGE_KEYS = ['MediaBox', 'CropBox', 'Resources', 'Rotate'] as const;
```

In `importPages` (~line 3296) replace
`const inheritable = ['MediaBox', 'CropBox', 'Resources', 'Rotate'];`
with
`const inheritable = INHERITABLE_PAGE_KEYS;`
(if a later use needs a mutable `string[]`, keep the local but spread it: `const inheritable: string[] = [...INHERITABLE_PAGE_KEYS];`).

Add the private method next to `currentKids()` (~line 3046):

```ts
  /** Before an edit re-lists this document's existing pages directly under the
   *  root, copy each page's inherited attributes from the intermediate nodes
   *  between it and the root onto its own dict, and point its `/Parent` at the
   *  root (`dmin.4`). Without it the pages kept `/Parent` naming an
   *  intermediate node that still listed them with its old `/Count` — a tree
   *  `Validate()` fails — and `Reorder`, which repoints `/Parent` itself, lost
   *  the intermediate node's `/MediaBox` outright. The ROOT's own values are
   *  not copied: the page still inherits them from the root. A value the page
   *  states itself is never overwritten. */
  private flattenToRoot(): void {
    const rootNum = this.requireIndirectPagesRoot();
    const root = this.objects.get(rootNum);
    for (const page of this.Pages) {
      const dict = page.Dict;
      let node = this.resolve(dict.get('Parent'));
      const seen = new Set<PdfDict>();
      while (isDict(node) && node !== root && !seen.has(node)) {
        seen.add(node);
        for (const key of INHERITABLE_PAGE_KEYS)
          if (!dict.has(key) && node.has(key)) dict.set(key, node.get(key)!);
        node = this.resolve(node.get('Parent'));
      }
      dict.set('Parent', ref(rootNum));
    }
  }
```

Change `currentKids()` so the inline check runs first, then the flatten:

```ts
  private currentKids(): PdfObject[] {
    const kids = this.pageObjNums.map((num) => {
      if (num === 0)
        throw new UnsupportedFeatureError('cannot modify pages: a page is not an indirect object');
      return ref(num);
    });
    this.flattenToRoot();
    return kids;
  }
```

In `Reorder`, immediately after the loop that throws `cannot reorder: a page is not an indirect object` and before `const srcNums = this.pageObjNums.slice();`, add:

```ts
    this.flattenToRoot();
```

- [ ] **Step 4: Run the new tests and the page-edit suites**

Run: `npx vitest run test/page-edit-tree.test.ts test/page-validate.test.ts test/page-repair.test.ts`
Expected: PASS.

Then run everything that touches page edits:
Run: `npx vitest run test/pages test/reorder test/insert test/remove test/split test/merge test/extract`
(vitest filters by path substring; any that match nothing are harmless). Expected: PASS. Any red here means the flatten moved bytes a fixture pinned — read the failing assertion before changing anything; a byte-identity fence (e.g. `test/*-identity.test.ts`) going red is information, not a golden to refresh.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/document.ts test/page-edit-tree.test.ts
git commit -m "fix(dmin.4): page edits no longer leave pages under a stale intermediate node

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Clean-document sweep

**Files:**
- Test: `test/page-validate-sweep.test.ts`

**Interfaces:**
- Consumes: `Document.Validate()`; builders `buildTaggedPdf` (`test/helpers/build-tagged-pdf.ts`), `buildFormPdf` (`build-form-pdf.ts`), `buildAnnotTarget` (`build-annot-target.ts`), `buildPdfaPdf` (`build-pdfa-pdf.ts`), `buildPageLabelsPdf` (`build-pagelabels-pdf.ts`), `buildComposeSource` (`build-compose-pdf.ts`), `buildMultiPageTaggedPdf` (`build-multipage-tagged-pdf.ts`).

- [ ] **Step 1: Write the sweep**

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildPageLabelsPdf } from './helpers/build-pagelabels-pdf.js';
import { buildComposeSource } from './helpers/build-compose-pdf.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

/** Every real-world PDF we vendor, except the deliberately damaged ones. */
function fixturePdfs(dir = 'test/fixtures'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'corrupt') out.push(...fixturePdfs(p)); }
    else if (e.endsWith('.pdf')) out.push(p);
  }
  return out;
}

const issuesOf = (d: Document) => d.Validate().Issues.map((i) => `${i.rule}@${i.object?.num}`);

describe('Validate() passes every clean document in the suite', () => {
  const files = fixturePdfs();
  it('found the vendored fixtures', () => expect(files.length).toBeGreaterThanOrEqual(13));
  for (const f of files)
    it(f, () => expect(issuesOf(Document.Open(readFileSync(f)))).toEqual([]));

  const builders: [string, () => Uint8Array][] = [
    ['buildTaggedPdf', buildTaggedPdf],
    ['buildFormPdf', buildFormPdf],
    ['buildAnnotTarget', buildAnnotTarget],
    ['buildPdfaPdf', () => buildPdfaPdf()],
    ['buildPageLabelsPdf', buildPageLabelsPdf],
    ['buildComposeSource', () => buildComposeSource()],
    ['buildMultiPageTaggedPdf', buildMultiPageTaggedPdf],
  ];
  for (const [n, build] of builders)
    it(n, () => expect(issuesOf(Document.Open(build()))).toEqual([]));

  it('Document.New + AddPage, saved and reopened', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.AddPage(PageFormat.Letter);
    expect(issuesOf(Document.Open(d.Save()))).toEqual([]);
  });

  it('Split / ExtractPages output', () => {
    const src = Document.Open(buildMultiPageTaggedPdf());
    expect(issuesOf(src.ExtractPages([1]))).toEqual([]);
  });
});
```

If an encrypted fixture (`qpdf/encrypted-*.pdf`) needs a password, check `test/qpdf-goldens.test.ts` for how it opens them and mirror that.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/page-validate-sweep.test.ts`
Expected: PASS. If a case fails, DO NOT loosen a rule to make it pass. Read the file's tree (`/Type` on the root? `/Parent` on every kid?). Either it is a real defect in that producer's output — record it in the test as an explicit expectation with a comment naming the defect — or it is a builder of ours writing a broken tree, which gets fixed in the builder. Report which in the commit message.

- [ ] **Step 3: Commit**

```bash
git add test/page-validate-sweep.test.ts
git commit -m "test(dmin.4): Validate() passes every clean fixture and builder

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Mutation checks, docs, quality gates, close

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`
- No new tests unless a mutation below stays green.

- [ ] **Step 1: Mutation-check each rule and repair step**

For each mutation: apply it to `src/pagecheck.ts` (or `document.ts`), run
`npx vitest run test/page-validate.test.ts test/page-repair.test.ts test/page-edit-tree.test.ts`,
confirm AT LEAST ONE case goes red, revert with `git checkout -- src/`. Record the red count per mutation for the CLAUDE.md entry.

1. `visit`: delete the `PageCountMismatch` push.
2. `visit`: compare `/Count` with `pages + 1`.
3. `visit`: delete the `PageParentMismatch` push.
4. `visit`: drop the `nodeRef !== undefined &&` guard (should stay green — no fixture has an inline root; if so, record as uncovered/held by reasoning).
5. `visit`: `boxHere = boxAbove` (ignore the node's own /MediaBox).
6. `visit`: delete the `PageMediaBoxMissing` push.
7. `visit`: `pages += cyclic ? 0 : 1` in validate mode (ignore `counts`) — expect green unless a shared INTERMEDIATE fixture exists; record the result.
8. `visit`: in fix mode, drop dead kids on EVERY node (remove the `/Count`-mismatch condition).
9. `visit`: in fix mode, copy a cyclic node instead of dropping it (run with `--testTimeout=5000`; a hang is a red).
10. `isLeaf`: resolve `/Type` before testing it — expect green (no fixture has an indirect `/Type`); record.
11. `Repair`: call `this.markModified()` unconditionally.
12. `Repair`: skip the `buildPages` refresh.
13. `flattenToRoot`: walk up to and INCLUDING the root.
14. `flattenToRoot`: overwrite keys the page already states.
15. `Reorder`: remove the `this.flattenToRoot()` call.
16. `currentKids`: remove the `this.flattenToRoot()` call.

After each: `git diff --stat src/` must be empty before the next.

- [ ] **Step 2: README**

- Key Capabilities: add a bullet near the other validation bullets (after **PDF/X conversion**, before **PDF/UA remediation**), titled **Structural integrity**, describing `doc.Validate()` (the five rule ids, reads the raw graph, never throws, no cycle test on back-references, dangling references are not failures) and `doc.Repair()` (what it fixes, returns the fixed issues, touches nothing on a sound document, `CatalogInvalid` not repairable), and noting that `RemovePage`/`InsertPage`/`Reorder` now leave a flat tree with inherited attributes copied onto each page.
- Additional Examples: add an imperative-titled example `### Check and Repair a Salvaged Document` near the other validation examples:

```ts
import { Document } from '@asposefoss/pdf';
import { readFileSync, writeFileSync } from 'node:fs';

const doc = Document.Open(readFileSync('salvaged.pdf'));
if (doc.recovery) console.log('recovered:', doc.recovery.reason);
const report = doc.Validate();
for (const i of report.Issues) console.log(i.rule, i.object?.num, i.message);
if (!report.Passed) {
  const fixed = doc.Repair();
  console.log(`repaired ${fixed.length} issue(s)`);
  writeFileSync('repaired.pdf', doc.Save());
}
```

- API Reference: add `doc.Validate()` and `doc.Repair()` rows in the Core/validation table beside `ValidatePdfA`. No new exports, so `test/readme-api.test.ts`'s counts should not move — run it to confirm.

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Added

- **Structural validation and repair.** `doc.Validate()` checks the page tree a
  healthy or salvaged document carries — the catalog resolves, every node is
  reached once, `/Count` agrees with the pages under each node, every `/Parent`
  is the node listing it, every page has a `/MediaBox` somewhere above it — and
  returns the same `ValidationReport` as `ValidatePdfA`. Two things are
  deliberately not failures: back-references (`/Parent`, `/P`, `/Prev`) are
  required by the format, not cycles, and a reference to a missing object is
  null by 7.3.10. `doc.Repair()` fixes what it reports in place, keeping the
  tree's shape, so a document salvaged from a truncated file writes the pages
  it has rather than the `/Count` it claimed; on a sound document it touches
  nothing, not even the modified flag, so a following signature still appends.
  (dmin.4)

### Fixed

- **Page edits on a nested page tree.** `RemovePage`, `InsertPage` and
  `InsertPages` flattened the pages under the root but left each page's
  `/Parent` naming its old intermediate node, which still listed it with its old
  `/Count` — the file rendered, and was structurally inconsistent. `Reorder` was
  worse: it repointed `/Parent` first, so a page inheriting its `/MediaBox`,
  `/CropBox`, `/Resources` or `/Rotate` from an intermediate node lost it and
  came out US Letter. Inherited values are now copied onto each page before it
  is re-listed. (dmin.4)
```

Merge into existing `### Added` / `### Fixed` headings under `[Unreleased]` if they exist.

- [ ] **Step 4: CLAUDE.md**

Add a **pagecheck.ts** entry to the Source list right after the **page.ts**, **pagetree.ts** bullet. It must state: one walk for both Validate and Repair; reads raw `/Kids` from `/Root`, not `doc.Pages`; leaf rule shared verbatim with `buildPages`; no cycle test on back-references and dangling refs are null (7.3.10); dead kids dropped only where `/Count` is being corrected (byte-identity of a clean document); inline parents skip the `/Parent` check; a cyclic node's back edge is dropped, never copied; `Repair` touches nothing — including `markModified()` — on a sound document, pinned through the sign path; `flattenToRoot` runs BEFORE `Reorder` repoints `/Parent`, and does not copy the root's own values. Include the mutation results from Step 1, naming any that stayed green as "measured, and it covers NOTHING" per the file's convention. Also mention `1lr9` (Open refuses a shared node) as the reason `PageTreeShared` is only reachable after a live mutation.

Then run the module-doc sweep and confirm empty output:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 5: Quality gates**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: all green. Before trusting a red timing test, check for orphaned vitest workers from Step 1's hang mutation (see memory `mutation-hang-orphans-vitest`).

- [ ] **Step 6: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md docs/superpowers/specs/2026-09-22-structural-validate-repair-design.md
git commit -m "docs(dmin.4): Validate()/Repair() in README, CHANGELOG and CLAUDE.md

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-dmin.4
git pull --rebase
git push
git status
```

Expected: `git status` reports up to date with origin.
