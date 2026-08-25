# AutoTag Foundation + Text Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `StructElement.MarkContent(page, region)` (pwi.1 — wrap existing content in `/<Type> <</MCID n>> BDC…EMC`) and `doc.AutoTag(opts?)` (pwi.2 — infer a `/StructTreeRoot` of headings/paragraphs/figures from layout).

**Architecture:** pwi.1 lives in `src/structwrite.ts` (region→op-span + op-list rewrite via `EditableContent`, MCID via `allocContentMcid`) with a thin `StructElement.MarkContent` method in `src/struct.ts`. pwi.2 lives in a new `src/autotag.ts` (font-size clustering + `GetStructuredText` classification) with a thin `doc.AutoTag` method in `src/document.ts`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps.

## Global Constraints

- Zero runtime deps; ESM + NodeNext (`.js` specifiers).
- Live-mutation model; content edits go through `EditableContent` and `commit()`.
- Heuristic and documented as such; never fabricate alt text (undescribed images → `/Artifact`).
- Errors: `UnsupportedFeatureError` for already-tagged (without `force`) and for `MarkContent` on a ref-less element (inherited from `allocContentMcid`).
- Run `npm run typecheck` and `npm test` green before closing.
- Keep `README.md` in sync.

---

### Task 1: pwi.1 — content-marking primitive (`MarkContent`)

**Files:**
- Modify: `src/structwrite.ts` (add `rectsIntersect`, `normRect`, `regionOpSpan`, `wrapRegionOps`, `markContentRegion`)
- Modify: `src/struct.ts` (add `StructElement.MarkContent`)
- Test: `test/struct-mark-content.test.ts` (create)

**Interfaces:**
- Consumes: `allocContentMcid` (existing, `structwrite.ts`), `EditableContent` (`editcontent.js`), `visitContent`/`Rect`/`ContentAddr` (`text.js`), `ContentOp` (`content.js`), `name`/`PdfObject` (`types.js`), `StructElement` (type, `struct.js`).
- Produces:
  - `export function regionOpSpan(doc, page, region): { streamIndex: number; min: number; max: number } | undefined`
  - `export function wrapRegionOps(ec: EditableContent, streamIndex: number, min: number, max: number, before: ContentOp, after: ContentOp): void`
  - `export function markContentRegion(doc: Document, element: StructElement, page: Page, region: Rect): number`
  - `StructElement.MarkContent(page: Page, region: Rect): number`

- [ ] **Step 1: Write the failing test**

Create `test/struct-mark-content.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** One stream, two text lines at different baselines. */
const TWO_LINES = 'BT /F1 10 Tf 50 200 Td (First line) Tj ET '
  + 'BT /F1 10 Tf 50 150 Td (Second line) Tj ET';

describe('StructElement.MarkContent', () => {
  it('tags existing content so GetStructTree/GetText round-trip', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const page = doc.Pages[0];
    const region = page.Search('First line')[0].quads[0]; // page-space box of line 1

    const root = doc.CreateStructTree();
    const p = root.Append('P');
    const mcid = p.MarkContent(page, region);
    expect(mcid).toBeGreaterThanOrEqual(0);

    const re = Document.Open(doc.Save());
    const tree = re.GetStructTree()!;
    expect(tree.Children.map((c) => c.Type)).toContain('P');
    const pEl = tree.Children.find((c) => c.Type === 'P')!;
    expect(pEl.GetText()).toContain('First line');
    expect(pEl.GetText()).not.toContain('Second line');
  });

  it('writes /P <</MCID 0>> BDC ... EMC into the content', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const page = doc.Pages[0];
    const region = page.Search('First line')[0].quads[0];
    const p = doc.CreateStructTree().Append('P');
    p.MarkContent(page, region);

    const raw = new TextDecoder('latin1').decode(page.Contents);
    expect(raw).toMatch(/\/P <<\/MCID 0>> BDC/);
    expect(raw).toContain('EMC');
  });

  it('returns -1 and tags nothing for an empty region', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const p = doc.CreateStructTree().Append('P');
    expect(p.MarkContent(doc.Pages[0], [0, 0, 5, 5])).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-mark-content.test.ts`
Expected: FAIL — `MarkContent` is not a function on `StructElement`.

- [ ] **Step 3: Add the helpers + `markContentRegion` to `src/structwrite.ts`**

Extend the imports at the top of `src/structwrite.ts`:

```ts
import { EditableContent } from './editcontent.js';
import { visitContent, type Rect, type ContentAddr } from './text.js';
import type { ContentOp } from './content.js';
```

Append at the end of `src/structwrite.ts`:

```ts
/** Normalize a rect to [minX,minY,maxX,maxY]. */
function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** Axis-aligned box overlap. */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** The top-level content-stream op span (in the stream with the most hits) whose
 *  glyph/image boxes fall in `region`; undefined when the region has no
 *  top-level content. Content inside Form XObjects (addr.path non-empty) is
 *  ignored — a documented AutoTag limitation. */
export function regionOpSpan(
  doc: Document, page: Page, region: Rect,
): { streamIndex: number; min: number; max: number } | undefined {
  const r = normRect(region);
  const per = new Map<number, { min: number; max: number; count: number }>();
  const hit = (addr: ContentAddr, quad: Rect) => {
    if (addr.path.length !== 0 || !rectsIntersect(quad, r)) return;
    const s = per.get(addr.streamIndex);
    if (!s) per.set(addr.streamIndex, { min: addr.opIndex, max: addr.opIndex, count: 1 });
    else { s.min = Math.min(s.min, addr.opIndex); s.max = Math.max(s.max, addr.opIndex); s.count++; }
  };
  visitContent(doc, page, { glyph: (e) => hit(e.addr, e.quad), image: (e) => hit(e.addr, e.quad) });
  let best: { streamIndex: number; min: number; max: number } | undefined;
  let bestCount = 0;
  for (const [streamIndex, s] of per) {
    if (s.count > bestCount) { bestCount = s.count; best = { streamIndex, min: s.min, max: s.max }; }
  }
  return best;
}

/** Rebuild top stream `streamIndex`, inserting `before` at op `min` and `after`
 *  immediately after op `max`. The caller commits `ec`. */
export function wrapRegionOps(
  ec: EditableContent, streamIndex: number, min: number, max: number,
  before: ContentOp, after: ContentOp,
): void {
  const ops = [...ec.topOps(streamIndex)];
  ec.setTopOps(streamIndex, [
    ...ops.slice(0, min), before, ...ops.slice(min, max + 1), after, ...ops.slice(max + 1),
  ]);
}

/** Wrap the top-level content of `region` in `/<element.Type> <</MCID n>> BDC …
 *  EMC` under `element` and return the allocated MCID; -1 when the region has no
 *  top-level content (nothing is allocated or written). */
export function markContentRegion(
  doc: Document, element: StructElement, page: Page, region: Rect,
): number {
  const span = regionOpSpan(doc, page, region);
  if (!span) return -1;
  const mcid = allocContentMcid(doc, element, page);
  const ec = new EditableContent(doc, page);
  wrapRegionOps(
    ec, span.streamIndex, span.min, span.max,
    { operator: 'BDC', operands: [name(element.Type), new Map<string, PdfObject>([['MCID', mcid]])] },
    { operator: 'EMC', operands: [] },
  );
  ec.commit();
  return mcid;
}
```

- [ ] **Step 4: Add `StructElement.MarkContent` to `src/struct.ts`**

Extend the `structwrite.js` import in `src/struct.ts` to include `markContentRegion`, and add `type Rect` to the `text.js` import:

```ts
import { visitContent, assembleLines, type GlyphEvent, type Run, type Rect } from './text.js';
```
```ts
import { ElemOpts, createElement, kArray, allocContentMcid, tagAnnotation, markContentRegion } from './structwrite.js';
```

Add the method to the `StructElement` class, next to `NextMcid`:

```ts
  /** Tag existing page content under this element: allocate an MCID and wrap the
   *  top-level show/`Do` ops whose content falls in `region` in
   *  `/<Type> <</MCID n>> BDC … EMC`. Returns the MCID, or -1 when the region has
   *  no top-level content. */
  MarkContent(page: Page, region: Rect): number {
    return markContentRegion(this.doc, this, page, region);
  }
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/struct-mark-content.test.ts && npm run typecheck`
Expected: PASS (all three `it` blocks), no type errors.

- [ ] **Step 6: Commit + close pwi.1**

```bash
git add src/structwrite.ts src/struct.ts test/struct-mark-content.test.ts
git commit -m "feat(pwi.1): StructElement.MarkContent — tag existing content by region"
bd close aspose-pdf-foss-for-ts-pwi.1
```

---

### Task 2: pwi.2 — `doc.AutoTag` headings + paragraphs

**Files:**
- Create: `src/autotag.ts`
- Modify: `src/document.ts` (add `AutoTag` method + import)
- Modify: `src/index.ts` (export `AutoTagOptions`, `AutoTagReport`)
- Test: `test/autotag.test.ts` (create)

**Interfaces:**
- Consumes: `Document`, `page.GetStructuredText()` → `TextBlock[]`, `doc.CreateStructTree()`/`root.Append`/`element.MarkContent` (Task 1), `doc.IsTagged`/`doc.Lang`/`doc.SetMetadata`, `ImageEvent`/`visitContent` (`text.js`), `wrapRegionOps`/`regionOpSpan` (Task 1), `EditableContent` (`editcontent.js`), `name` (`types.js`), `UnsupportedFeatureError` (`errors.js`).
- Produces:
  - `export interface AutoTagOptions { force?: boolean; lang?: string; title?: string; alt?: (image: ImageEvent) => string | undefined }`
  - `export interface AutoTagReport { headings: number; paragraphs: number; figures: number; artifacts: number }`
  - `export function autoTag(doc: Document, opts?: AutoTagOptions): AutoTagReport`
  - `Document.AutoTag(opts?: AutoTagOptions): AutoTagReport`

- [ ] **Step 1: Write the failing test**

Create `test/autotag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

// A 20pt title, then two 2-line 10pt paragraphs, well separated vertically.
const DOC = 'BT /F1 20 Tf 50 250 Td (Big Title) Tj ET '
  + 'BT /F1 10 Tf 50 210 Td (Para one line one here) Tj 0 -12 Td (para one line two here) Tj ET '
  + 'BT /F1 10 Tf 50 160 Td (Para two line one here) Tj 0 -12 Td (para two line two here) Tj ET';

describe('doc.AutoTag — headings + paragraphs', () => {
  it('tags a title as H1 and paragraphs as P, marking the doc Tagged', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    const report = doc.AutoTag();
    expect(report.headings).toBe(1);
    expect(report.paragraphs).toBe(2);
    expect(doc.IsTagged).toBe(true);

    const re = Document.Open(doc.Save());
    const kids = re.GetStructTree()!.Children;
    expect(kids.map((c) => c.Type)).toEqual(['H1', 'P', 'P']);
    expect(kids[0].GetText()).toContain('Big Title');
    expect(kids[1].GetText()).toContain('Para one');
  });

  it('throws on an already-tagged doc unless force is set', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag();
    expect(() => doc.AutoTag()).toThrow(UnsupportedFeatureError);
    expect(() => doc.AutoTag({ force: true })).not.toThrow();
  });

  it('sets lang and title from opts', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag({ lang: 'en-US', title: 'My Report' });
    expect(doc.Lang).toBe('en-US');
    expect(doc.GetMetadata().title).toBe('My Report');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/autotag.test.ts`
Expected: FAIL — `AutoTag` is not a function on `Document`.

- [ ] **Step 3: Create `src/autotag.ts` (headings + paragraphs; figures added in Task 3)**

```ts
import type { Document } from './document.js';
import type { TextBlock, ImageEvent } from './text.js';
import { UnsupportedFeatureError } from './errors.js';

/** Options for {@link Document.AutoTag}. */
export interface AutoTagOptions {
  /** Re-tag even when the document is already tagged. Default false (throws). */
  force?: boolean;
  /** Set the document default language (/Lang). */
  lang?: string;
  /** Set the document title (/Info Title). */
  title?: string;
  /** Alt text for an image; when it returns undefined the image is marked
   *  /Artifact instead of tagged as a Figure. */
  alt?: (image: ImageEvent) => string | undefined;
}

/** Counts of the elements AutoTag produced. */
export interface AutoTagReport {
  headings: number;
  paragraphs: number;
  figures: number;
  artifacts: number;
}

/** Round a font size into 0.5pt buckets so near-equal sizes cluster. */
function roundSize(s: number): number { return Math.round(s * 2) / 2; }

/** The size bucket with the most characters among a block's fragments. */
function dominantSize(block: TextBlock): number {
  const chars = new Map<number, number>();
  for (const line of block.lines) for (const f of line.fragments) {
    const sz = roundSize(f.fontSize);
    chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
  }
  let best = 0, bestC = -1;
  for (const [sz, c] of chars) if (c > bestC) { bestC = c; best = sz; }
  return best;
}

/** Body size (most characters overall) + heading-size → level map (largest =
 *  H1, capped at H6), from every fragment across the document. */
function headingRanks(doc: Document): Map<number, number> {
  const chars = new Map<number, number>();
  for (const page of doc.Pages) for (const block of page.GetStructuredText()) {
    for (const line of block.lines) for (const f of line.fragments) {
      const sz = roundSize(f.fontSize);
      chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
    }
  }
  let bodySize = 0, bodyChars = -1;
  for (const [sz, c] of chars) if (c > bodyChars) { bodyChars = c; bodySize = sz; }
  const larger = [...chars.keys()].filter((s) => s > bodySize + 0.5).sort((a, b) => b - a);
  const ranks = new Map<number, number>();
  larger.forEach((s, i) => ranks.set(s, Math.min(i + 1, 6)));
  return ranks;
}

/** Infer and author a /StructTreeRoot for `doc` from page layout. */
export function autoTag(doc: Document, opts: AutoTagOptions = {}): AutoTagReport {
  if (doc.IsTagged && !opts.force)
    throw new UnsupportedFeatureError('document is already tagged; pass { force: true } to re-tag');

  const root = doc.CreateStructTree(); // marks the document Tagged
  if (opts.lang !== undefined) doc.Lang = opts.lang;
  if (opts.title !== undefined) doc.SetMetadata({ title: opts.title });

  const ranks = headingRanks(doc);
  const report: AutoTagReport = { headings: 0, paragraphs: 0, figures: 0, artifacts: 0 };

  for (const page of doc.Pages) {
    for (const block of page.GetStructuredText()) {
      if (block.text.trim().length === 0) continue;
      const level = ranks.get(dominantSize(block));
      const isHeading = level !== undefined && block.lines.length <= 2;
      const el = root.Append(isHeading ? `H${level}` : 'P');
      el.MarkContent(page, block.quad);
      if (isHeading) report.headings++; else report.paragraphs++;
    }
  }
  return report;
}
```

- [ ] **Step 4: Wire `Document.AutoTag`**

In `src/document.ts`, add the import near the other feature imports:

```ts
import { autoTag, type AutoTagOptions, type AutoTagReport } from './autotag.js';
```

Add the method next to `CreateStructTree`:

```ts
  /** Infer and author a `/StructTreeRoot` from page layout (headings by
   *  font-size clustering, paragraphs, and — with `opts.alt` — figures). Marks
   *  the document Tagged and returns per-type counts. Heuristic; see the README
   *  limitations. Throws if the document is already tagged unless `opts.force`. */
  AutoTag(opts?: AutoTagOptions): AutoTagReport {
    return autoTag(this, opts);
  }
```

- [ ] **Step 5: Export the option/report types**

In `src/index.ts`, append:

```ts
export type { AutoTagOptions, AutoTagReport } from './autotag.js';
```

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/autotag.test.ts && npm run typecheck`
Expected: PASS (all three `it` blocks), no type errors. If `Children.map(c => c.Type)` is not `['H1','P','P']`, the fixture's vertical gaps did not split into three `GetStructuredText` blocks — widen the gaps (currently 40 and 38 pt) and re-run; use `systematic-debugging` if grouping is stubborn.

- [ ] **Step 7: Commit**

```bash
git add src/autotag.ts src/document.ts src/index.ts test/autotag.test.ts
git commit -m "feat(pwi.2): doc.AutoTag — headings + paragraphs from layout"
```

---

### Task 3: pwi.2 — figures + artifacts

**Files:**
- Modify: `src/autotag.ts` (tag images)
- Test: `test/autotag.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `visitContent`/`ImageEvent` (`text.js`), `wrapRegionOps`/`regionOpSpan` (Task 1, `structwrite.js`), `EditableContent` (`editcontent.js`), `name` (`types.js`).
- Produces: image tagging inside `autoTag` (updates `report.figures` / `report.artifacts`).

- [ ] **Step 1: Write the failing test**

Add to `test/autotag.test.ts` (extend the import with `buildTextAndImagePage`):

```ts
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

describe('doc.AutoTag — figures + artifacts', () => {
  const withImage = () => Document.Open(buildTextAndImagePage(
    'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q'));

  it('tags an image as Figure with /Alt when alt is provided', () => {
    const doc = withImage();
    const report = doc.AutoTag({ alt: () => 'a company logo' });
    expect(report.figures).toBe(1);
    expect(report.artifacts).toBe(0);

    const re = Document.Open(doc.Save());
    const fig = re.GetStructTree()!.Children.find((c) => c.Type === 'Figure')!;
    expect(fig).toBeDefined();
    expect(fig.Alt).toBe('a company logo');
  });

  it('marks an undescribed image as /Artifact (not in the tree)', () => {
    const doc = withImage();
    const report = doc.AutoTag(); // no alt callback
    expect(report.figures).toBe(0);
    expect(report.artifacts).toBe(1);

    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.some((c) => c.Type === 'Figure')).toBe(false);
    expect(new TextDecoder('latin1').decode(re.Pages[0].Contents)).toContain('/Artifact BMC');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/autotag.test.ts -t "figures + artifacts"`
Expected: FAIL — images are not tagged yet (`figures`/`artifacts` stay 0; no `Figure`/`/Artifact`).

- [ ] **Step 3: Add image tagging to `src/autotag.ts`**

Extend the imports:

```ts
import { visitContent } from './text.js';
import { EditableContent } from './editcontent.js';
import { wrapRegionOps, regionOpSpan } from './structwrite.js';
import { name } from './types.js';
```

In `autoTag`, inside the `for (const page of doc.Pages)` loop, after the text-block loop, add:

```ts
    // Images: Figure with /Alt when described, else /Artifact.
    const images: ImageEvent[] = [];
    visitContent(doc, page, { image: (e) => { if (e.addr.path.length === 0) images.push(e); } });
    for (const img of images) {
      const alt = opts.alt?.(img);
      if (alt !== undefined) {
        const el = root.Append('Figure', { alt });
        if (el.MarkContent(page, img.quad) >= 0) report.figures++;
      } else {
        const span = regionOpSpan(doc, page, img.quad);
        if (span) {
          const ec = new EditableContent(doc, page);
          wrapRegionOps(
            ec, span.streamIndex, span.min, span.max,
            { operator: 'BMC', operands: [name('Artifact')] },
            { operator: 'EMC', operands: [] },
          );
          ec.commit();
          report.artifacts++;
        }
      }
    }
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/autotag.test.ts && npm run typecheck`
Expected: PASS (all five `it` blocks), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/autotag.ts test/autotag.test.ts
git commit -m "feat(pwi.2): AutoTag figures (with alt) + artifacts"
```

---

### Task 4: README + PDF/UA improvement check + full verify + close

**Files:**
- Modify: `README.md`
- Test: `test/autotag.test.ts` (add a ValidatePdfUa assertion)

- [ ] **Step 1: Add a PDF/UA-improvement test**

Add to `test/autotag.test.ts`:

```ts
describe('doc.AutoTag — PDF/UA improvement', () => {
  it('reduces PDF/UA errors on a simple untagged doc', () => {
    const before = Document.Open(buildMultiStreamPage([DOC])).ValidatePdfUa().Errors.length;
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag({ lang: 'en-US', title: 'Doc' });
    const after = doc.ValidatePdfUa().Errors.length;
    expect(after).toBeLessThan(before);
  });
});
```

Run: `npx vitest run test/autotag.test.ts -t "PDF/UA improvement"`. If `after` is not less than `before`, inspect the two `ValidatePdfUa().Issues` lists and confirm which rules the tagging/lang/title were expected to clear; adjust the assertion to the rules AutoTag actually addresses (tagging-present + marked-content correlation at minimum) rather than weakening it silently.

- [ ] **Step 2: Add the Features bullet**

In `README.md`, after the tagged-PDF authoring bullet, add:

```md
- **Accessibility auto-tagging** — `doc.AutoTag(opts?)` infers a `/StructTreeRoot` for an untagged document from page layout: headings by font-size clustering, paragraphs, and images as `Figure` (with `/Alt` from `opts.alt`) or `/Artifact` when undescribed. It marks the document Tagged and returns per-type counts. Built on `StructElement.MarkContent(page, region)`, which wraps existing page content in `/<Type> <</MCID n>> BDC … EMC` so `GetStructTree`/`GetText` read it back. Heuristic — a starting point for accessibility, not a guarantee of semantic correctness. Tables and lists are follow-ups.
```

- [ ] **Step 3: Add API-overview rows**

In `README.md`, in the API table, add:

```md
| `doc.AutoTag(opts?)` | Infer a `/StructTreeRoot` (headings/paragraphs/figures) from layout; returns counts |
| `element.MarkContent(page, region)` | Tag existing page content under a structure element (returns the MCID) |
```

- [ ] **Step 4: Add a Limitations bullet**

In `README.md` Limitations, add:

```md
- **Auto-tagging is heuristic** — `doc.AutoTag` infers structure from layout: reading order follows `GetStructuredText`, headings are font-size based (modal size = body; larger sizes rank H1..H6), and undescribed images are marked `/Artifact` (no fabricated alt text). It does not tag tables or lists (follow-ups), content nested inside Form XObjects, or blocks whose ops span multiple content streams. A passing structure tree is a starting point for accessibility remediation, not a guarantee of correct semantics or reading order.
```

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no type errors.

- [ ] **Step 6: Commit + close pwi.2**

```bash
git add README.md test/autotag.test.ts
git commit -m "docs(pwi.2): document AutoTag + MarkContent; PDF/UA improvement test"
bd close aspose-pdf-foss-for-ts-pwi.2
```

(pwi.3 — tables — and the pwi umbrella remain open.)

---

## Notes for the implementer

- `MarkContent` uses a fresh `visitContent` + `EditableContent` per call, so op-index shifts from earlier marks on the same page are re-derived; do not try to batch marks into one op list by hand.
- The `BDC` op's type name comes from `element.Type` (the element's `/S`), so `root.Append('H1')` then `MarkContent` writes `/H1 <</MCID n>> BDC`.
- Region matching is by box intersection on the top-level stream with the most hits; content in Form XObjects or spanning multiple streams is left untagged (documented).
- Empty/whitespace blocks are skipped so no empty `P` is created.
- `structwrite.ts` already imports `StructElement` as a type and calls its members at runtime in `allocContentMcid`; `markContentRegion` follows the same pattern (type-only import, runtime member access).
