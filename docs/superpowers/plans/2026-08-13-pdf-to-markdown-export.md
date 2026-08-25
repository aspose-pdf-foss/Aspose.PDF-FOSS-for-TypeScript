# PDF to Markdown Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.ToMarkdown` and `Page.ToMarkdown` by extracting the
document-reconstruction walk out of `htmlsemantic.ts` into a neutral model that
both the HTML and Markdown exporters serialize.

**Architecture:** A new `src/docmodel.ts` owns the tagged (structure-tree) and
untagged (geometry + font-rank) walks and emits `DocNode[]`, a tree that speaks
PDF standard structure types rather than HTML tags. `src/htmlsemantic.ts` is
rewritten as a serializer over that tree and must stay byte-identical;
`src/mdexport.ts` is the second serializer. DOCX (`8yt9`) and EPUB (`zwto`) plug
in later as serializers three and four.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-13-pdf-to-markdown-export-design.md`

**Issue:** `aspose-pdf-foss-for-ts-no93.1` (claimed). Parent epic `no93`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension
  (`import { Page } from './page.js'`), including type-only imports.
- **Strict TypeScript.** `npm run typecheck` must pass with no errors.
- **Both gates green before any task is considered done:** `npm run typecheck`
  and `npm test`. Target one file with `npx vitest run test/<name>.test.ts`.
- **HTML output is frozen.** `ToHtml` semantic-mode output must not change by a
  single byte. Task 1 installs the fence; if a later task cannot keep it green,
  STOP and report rather than updating the snapshot.
- **Never run `vitest -u`** during this plan. Regenerating the Task 1 snapshot
  destroys the only evidence that the refactor was safe.
- **Task tracking is `bd`.** Do not use TodoWrite, TaskCreate, or markdown TODO
  lists. `bd show no93.1` for context.
- **Naming:** the exporter's option bag is `MarkdownExportOptions`.
  `MarkdownOptions` already exists in `src/markdown.ts` (the parser's `{ gfm }`
  bag), is exported from `index.ts:192`, and is extended by `mdflow.ts`.
- **Direction:** `mdexport.ts` is PDF→Markdown. The eleven existing `md*.ts`
  modules are all Markdown→PDF and share no code with it.

---

### Task 1: The HTML byte-identity fence

Installs the safety net **before** any source file is touched. The snapshot file
this task commits is the entire justification for rewriting a shipped exporter.

**Files:**
- Create: `test/html-identity.test.ts`
- Create (generated, then committed): `test/__snapshots__/html-identity.test.ts.snap`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no source symbols. Produces the committed snapshot that Tasks 2–6
  must keep green.

- [ ] **Step 1: Write the fence test**

Create `test/html-identity.test.ts`. Every fixture here is already used by
`test/html.test.ts`, so the imports are known-good. `AutoTag` + `Save` +
re-`Open` is deterministic, so those cases snapshot cleanly.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';
import { buildTextAndImagePage, buildTwoImagePage } from './helpers/build-edit-pdf.js';

// A caption and a 1x1 image scaled to 100pt, for the /Figure path.
const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

// A 2x2 ruled grid with cell text, as AutoTag's table detection sees it.
const RULED_TABLE = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
  + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
  + text(55, 175, 'A') + text(105, 175, 'B')
  + text(55, 125, 'C') + text(105, 125, 'D');

/** Re-save through AutoTag, the way the tagged fixtures in html.test.ts do. */
function autoTagged(src: Uint8Array, alt?: (e: { quad: number[] }) => string): Document {
  const doc = Document.Open(src);
  doc.AutoTag(alt ? { alt } : undefined);
  return Document.Open(doc.Save());
}

// This suite exists to freeze ToHtml's semantic output across the docmodel.ts
// refactor (no93.1). It asserts nothing about whether the markup is GOOD — only
// that it did not change. Never regenerate with `vitest -u`: the recorded
// snapshot is the only evidence the refactor preserved behaviour.
describe('ToHtml — semantic output is byte-identical', () => {
  it('untagged: headings, paragraphs', () => {
    expect(Document.Open(buildUntaggedHtmlPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('untagged: a ruled card beside a real grid', () => {
    const stream = hline(20, 120, 220) + hline(20, 120, 280)
      + vline(20, 220, 280) + vline(120, 220, 280)
      + text(30, 250, 'Card heading') + RULED_TABLE;
    expect(Document.Open(buildTablePdf(stream)).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('untagged: page images', () => {
    expect(Document.Open(buildTextAndImagePage(FIGURE_PAGE)).ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: multi-page tree, whole document', () => {
    expect(Document.Open(buildMultiPageTaggedPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: multi-page tree, one page only', () => {
    expect(Document.Open(buildMultiPageTaggedPdf()).Pages[1].ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: RoleMap, /Lang and /ActualText', () => {
    expect(Document.Open(buildTaggedPdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a table with a caption and header scope', () => {
    expect(Document.Open(buildTaggedTablePdf()).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a Table element carrying no /Pg', () => {
    expect(autoTagged(buildTablePdf(RULED_TABLE)).ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a /Figure resolved to its image by MCID', () => {
    expect(autoTagged(buildTextAndImagePage(FIGURE_PAGE), () => 'a company logo')
      .ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: two figures on one page pair with their own images', () => {
    const src = buildTwoImagePage(
      'q 60 0 0 60 20 200 cm /Im0 Do Q q 60 0 0 60 20 100 cm /Im1 Do Q');
    expect(autoTagged(src, (e) => (e.quad[1] < 150 ? 'lower' : 'upper'))
      .ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('shell: doctype, title and CSS around a body', () => {
    expect(Document.Open(buildUntaggedHtmlPdf()).ToHtml()).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run it to generate the snapshot**

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS, 11 tests, with vitest reporting `11 snapshots written`.

- [ ] **Step 3: Read the snapshot and sanity-check it**

Read `test/__snapshots__/html-identity.test.ts.snap`. Confirm by eye:
- the untagged case contains `<h1>Quarterly Report</h1>` and a `<p>`;
- the tagged multi-page case contains `<p>Page one body</p>` and `alt="A figure"`;
- the one-page case contains `Page two body` and **not** `Page one body`;
- the table cases contain `<table>` exactly once each;
- the figure cases contain `<img src="data:image/png;base64,`;
- nothing contains `undefined` or `[object Object]`.

If any of those are wrong, the fence is recording a bug rather than behaviour —
STOP and report before continuing.

- [ ] **Step 4: Confirm the fence actually bites**

Temporarily break the output: in `src/htmlsemantic.ts`, change `TAG_FOR`'s
`P: 'p'` to `P: 'para'`.
Run: `npx vitest run test/html-identity.test.ts`
Expected: FAIL on several snapshots.
Then **revert the edit** (`git checkout -- src/htmlsemantic.ts`) and re-run.
Expected: PASS.

A snapshot suite that passes on first run proves nothing until you have seen it
fail. This is the CLAUDE.md rule about proving assertions load-bearing.

- [ ] **Step 5: Commit**

```bash
git add test/html-identity.test.ts test/__snapshots__/html-identity.test.ts.snap
git commit -m "test(html): freeze semantic ToHtml output before the docmodel refactor

The fence for no93.1. Records current semantic-mode output for the eleven
fixtures html.test.ts already builds, so extracting the walk into docmodel.ts
can be proved byte-identical rather than assumed to be.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `docmodel.ts` — the neutral document model

Builds the model and its tests. Nothing consumes it yet, so `ToHtml` is
untouched and the Task 1 fence stays green trivially.

**Files:**
- Create: `src/docmodel.ts`
- Test: `test/docmodel.test.ts`

**Interfaces:**
- Consumes: `Document`, `Page`, `Table`, `PdfStream`, `StructElement`,
  `StructTreeRoot`, `tableFromStruct`, `visitContent`, `dominantFragmentSize`,
  `headingRanks` — all existing.
- Produces:
  - `type DocNode = DocContainer | DocText | DocTable | DocFigure`
  - `interface DocContainer { kind: 'container'; type: string; lang?: string; children: DocNode[] }`
  - `interface DocText { kind: 'text'; text: string }`
  - `interface DocTable { kind: 'table'; table: Table }`
  - `interface DocFigure { kind: 'figure'; alt: string; images: PdfStream[]; tagged: boolean }`
  - `function buildDocModel(doc: Document, pages: Page[]): DocNode[]`

- [ ] **Step 1: Write the failing test**

Create `test/docmodel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDocModel, type DocNode, type DocContainer } from '../src/docmodel.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

/** Every container type in the tree, pre-order — the model's shape in one line. */
function types(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'container') { out.push(n.type); types(n.children, out); }
    else out.push(n.kind);
  }
  return out;
}

/** All text in the tree, joined. */
function text(nodes: DocNode[]): string {
  return nodes.map((n) => n.kind === 'text' ? n.text
    : n.kind === 'container' ? text(n.children) : '').filter((s) => s).join(' ');
}

function find(nodes: DocNode[], type: string): DocContainer | undefined {
  for (const n of nodes) {
    if (n.kind !== 'container') continue;
    if (n.type === type) return n;
    const hit = find(n.children, type);
    if (hit) return hit;
  }
  return undefined;
}

describe('buildDocModel — untagged', () => {
  it('emits H1 and P containers, not HTML tags', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toEqual(['H1', 'text', 'P', 'text']);
    expect(text(model)).toBe('Quarterly Report Revenue grew twelve percent this year.');
  });

  it('emits an untagged figure per page image, with no alt', () => {
    const src = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';
    const doc = Document.Open(buildTextAndImagePage(src));
    const figures = buildDocModel(doc, doc.Pages).filter((n) => n.kind === 'figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ alt: '', tagged: false });
    expect((figures[0] as { images: unknown[] }).images).toHaveLength(1);
  });
});

describe('buildDocModel — tagged', () => {
  it('drives the tree from structure types', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toContain('P');
    expect(text(model)).toContain('Page one body');
    expect(text(model)).toContain('Page two body');
  });

  it('marks a /Figure tagged and carries its /Alt', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    const figures: { alt: string; tagged: boolean }[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind === 'figure') figures.push(n);
        else if (n.kind === 'container') walk(n.children);
      }
    };
    walk(model);
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ alt: 'A figure', tagged: true });
  });

  it('resolves a RoleMap role to its standard type and keeps /Lang', () => {
    const doc = Document.Open(buildTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toContain('H2');
    const langed = JSON.stringify(model);
    expect(langed).toContain('en-GB');
  });

  it('lets /ActualText replace a subtree', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(text(buildDocModel(doc, doc.Pages))).toContain('Body paragraph actual');
  });

  it('emits a table node carrying the Table model, not markup', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const model = buildDocModel(doc, doc.Pages);
    const tables: { table: { rowCount: number } }[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind === 'table') tables.push(n as never);
        else if (n.kind === 'container') walk(n.children);
      }
    };
    walk(model);
    expect(tables).toHaveLength(1);
    expect(tables[0].table.rowCount).toBeGreaterThan(1);
  });

  it('keeps only the requested page, ancestors intact', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, [doc.Pages[1]]);
    const t = text(model);
    expect(t).toContain('Page two body');
    expect(t).not.toContain('Page one body');
    expect(find(model, 'Sect')).toBeDefined();   // the ancestor survives
  });

  it('prunes a container left with no children', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, [doc.Pages[1]]);
    const empty: string[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind !== 'container') continue;
        if (!n.children.length) empty.push(n.type);
        walk(n.children);
      }
    };
    walk(model);
    expect(empty).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/docmodel.test.ts`
Expected: FAIL — cannot resolve `../src/docmodel.js`.

- [ ] **Step 3: Write `src/docmodel.ts`**

The two builders are lifted from `htmlsemantic.ts` with the string-building
removed. Keep the comments: they record rules that were learned the hard way.

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { visitContent, type Rect, type TextBlock } from './text.js';
import type { PdfStream } from './types.js';
import type { Table } from './tablemodel.js';
import { dominantFragmentSize, headingRanks } from './textrank.js';
import { StructElement, StructTreeRoot, type StructNode, type StructTextNode } from './struct.js';
import { tableFromStruct } from './tablestruct.js';

/** A reconstructed document as a tree of PDF standard structure types.
 *
 *  Deliberately NOT an HTML or Markdown tree: it names structure types
 *  ('H1', 'P', 'Span', ...) so no serializer is privileged, and so the untagged
 *  builder's output is indistinguishable in shape from the tagged one. */
export type DocNode = DocContainer | DocText | DocTable | DocFigure;

/** A structure element. `type` is the resolved standard type; unknown types are
 *  kept verbatim so a serializer can decide what to do with them. */
export interface DocContainer { kind: 'container'; type: string; lang?: string; children: DocNode[] }
/** A run of text, decoded and UNESCAPED — escaping is a serializer concern, and
 *  the serializers escape differently. */
export interface DocText { kind: 'text'; text: string }
/** The Table model object, not markup: each serializer calls its own emitter. */
export interface DocTable { kind: 'table'; table: Table }
/** Image streams, not data: URIs, so a file-writing serializer needs no re-derivation.
 *
 *  `tagged` records provenance because the two paths legitimately differ when an
 *  image cannot be encoded: a tagged /Figure still announces itself through its
 *  /Alt, while an untagged bare page image has no alt and so nothing to announce. */
export interface DocFigure { kind: 'figure'; alt: string; images: PdfStream[]; tagged: boolean }

// ---------- tagged: structure-tree driven ----------

function isText(n: StructNode): n is StructTextNode {
  return !(n instanceof StructElement);
}

/** Walk state. `images` memoizes each page's MCID→image map, because a page with
 *  N figures would otherwise re-walk its whole content stream N times. Unlike a
 *  positional pairing this is keyed lookup, so it cannot drift out of step. */
interface Ctx {
  doc: Document;
  only: Page | undefined;
  images: Map<Page, Map<number, PdfStream[]>>;
}

/** The image XObjects drawn under each MCID on `page`, in content order.
 *  Inline images are absent: their samples live in the content op, not an
 *  object, so there is nothing for a serializer to encode. */
function pageMcidImages(ctx: Ctx, page: Page): Map<number, PdfStream[]> {
  let map = ctx.images.get(page);
  if (map) return map;
  map = new Map<number, PdfStream[]>();
  visitContent(ctx.doc, page, {
    image: (e) => {
      if (e.mcid === undefined || !e.stream) return;
      const list = map!.get(e.mcid);
      if (list) list.push(e.stream);
      else map!.set(e.mcid, [e.stream]);
    },
  });
  ctx.images.set(page, map);
  return map;
}

/** Every image this element's marked content draws.
 *
 *  Recurses: a Figure's content is normally its own /K MCIDs, but nothing
 *  forbids nesting it under intermediate elements, and elementNode never
 *  descends into a Figure — so an image reached only that way would be lost. */
function figureStreams(ctx: Ctx, el: StructElement, out: PdfStream[]): void {
  for (const item of el.ContentItems) {
    if (item.kind !== 'mcid' || !item.page) continue;
    if (ctx.only && item.page !== ctx.only) continue; // another page's half of a split figure
    for (const s of pageMcidImages(ctx, item.page).get(item.mcid) ?? []) out.push(s);
  }
  for (const child of el.Children) figureStreams(ctx, child, out);
}

/** True when this element contributes any content on `only` (or `only` is undefined). */
function onPage(el: StructElement, only: Page | undefined): boolean {
  if (!only) return true;
  const nodes = el.Nodes;
  if (!nodes.length) return el.Page === only;      // e.g. a Figure whose /K is an OBJR
  return nodes.some((n) => (isText(n) ? n.page === only : onPage(n, only)));
}

/** One element, or undefined when it contributes nothing.
 *
 *  Page filtering and empty-node pruning live HERE, not in a serializer: two
 *  serializers deciding independently whether a node is empty is how the HTML
 *  and Markdown exports come to disagree about a document. */
function elementNode(ctx: Ctx, el: StructElement): DocNode | undefined {
  if (!onPage(el, ctx.only)) return undefined;
  const type = el.StandardType;

  if (type === 'Table') {
    // Built from this element, not looked up by page position: a Table element
    // need not carry /Pg, and the walk must not depend on one.
    const table = tableFromStruct(el);
    return table ? { kind: 'table', table } : undefined;
  }
  if (type === 'Figure') {
    const images: PdfStream[] = [];
    figureStreams(ctx, el, images);
    return { kind: 'figure', alt: el.Alt ?? el.ActualText ?? '', images, tagged: true };
  }

  const children: DocNode[] = [];
  const actual = el.ActualText;
  if (actual !== undefined) {
    // ActualText replaces the subtree's own text entirely.
    if (actual !== '') children.push({ kind: 'text', text: actual });
  } else {
    for (const n of el.Nodes) {
      if (isText(n)) {
        if (ctx.only && n.page !== ctx.only) continue;
        if (n.text !== '') children.push({ kind: 'text', text: n.text });
      } else {
        const child = elementNode(ctx, n);
        if (child) children.push(child);
      }
    }
  }
  if (!children.length) return undefined;

  const node: DocContainer = { kind: 'container', type, children };
  if (el.Lang) node.lang = el.Lang;
  return node;
}

function taggedModel(doc: Document, root: StructTreeRoot, only: Page | undefined): DocNode[] {
  const ctx: Ctx = { doc, only, images: new Map() };
  const out: DocNode[] = [];
  for (const child of root.Children) {
    const node = elementNode(ctx, child);
    if (node) out.push(node);
  }
  return out;
}

// ---------- untagged: geometry + font-size heuristics ----------

/** True when the center of `box` lies inside `region`. */
function centerInside(box: Rect, region: Rect): boolean {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x0 = Math.min(region[0], region[2]), x1 = Math.max(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]), y1 = Math.max(region[1], region[3]);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/** A block's lines as heading and paragraph containers.
 *
 *  Ranking is per line, not per block: the block grouper clusters a heading with
 *  the body paragraph beneath it whenever they are left-aligned and close (the
 *  ordinary case), and ranking such a block as a whole would let the longer body
 *  text outvote the heading and demote it to P. Consecutive lines of equal rank
 *  merge into one container, so a wrapped paragraph stays a single P and a
 *  two-line heading stays a single H1. */
function blockNodes(block: TextBlock, ranks: Map<number, number>, out: DocNode[]): void {
  let level: number | undefined;
  let texts: string[] = [];
  const flush = (): void => {
    const text = texts.join(' ').trim();
    texts = [];
    if (!text) return;
    out.push({ kind: 'container', type: level ? `H${level}` : 'P', children: [{ kind: 'text', text }] });
  };
  for (const line of block.lines) {
    const lineLevel = ranks.get(dominantFragmentSize(line.fragments));
    if (texts.length && lineLevel !== level) flush();
    level = lineLevel;
    texts.push(line.text);
  }
  flush();
}

function untaggedModel(doc: Document, pages: Page[], ranks: Map<number, number>): DocNode[] {
  const out: DocNode[] = [];
  for (const page of pages) {
    const tables: Table[] = page.GetTables();
    for (const block of page.GetStructuredText()) {
      // A block absorbed by a table is emitted as part of that table, not twice.
      if (tables.some((t) => centerInside(block.quad, t.quad))) continue;
      blockNodes(block, ranks, out);
    }
    for (const table of tables) out.push({ kind: 'table', table });
    for (const img of page.Images) {
      out.push({ kind: 'figure', alt: '', images: [img.Stream], tagged: false });
    }
  }
  return out;
}

/** Reconstruct `pages` as a document tree: from the tagged structure tree when
 *  the document has one, and from geometry plus font-size ranking when it does
 *  not. The single walk behind every document exporter. */
export function buildDocModel(doc: Document, pages: Page[]): DocNode[] {
  const root = doc.GetStructTree();
  if (root) {
    // The tree spans pages: walk it once, restricted to a single page when that
    // is all that was asked for, so an element crossing a page break stays one
    // element.
    const only = pages.length === 1 && doc.Pages.length > 1 ? pages[0] : undefined;
    return taggedModel(doc, root, only);
  }
  return untaggedModel(doc, pages, headingRanks(doc));
}
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run test/docmodel.test.ts`
Expected: PASS, 9 tests.
Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: PASS — the Task 1 fence included, since nothing consumes the model yet.

- [ ] **Step 5: Prove the pruning rule is load-bearing**

In `src/docmodel.ts`, temporarily change `if (!children.length) return undefined;`
to `if (false) return undefined;` (TypeScript will warn about unreachable code;
that is fine for the moment).
Run: `npx vitest run test/docmodel.test.ts`
Expected: FAIL on "prunes a container left with no children".
Revert with `git checkout -- src/docmodel.ts` — but you have not committed yet,
so instead re-apply the correct line by hand and re-run.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/docmodel.ts test/docmodel.test.ts
git commit -m "feat(docmodel): the neutral document model behind every exporter

buildDocModel reconstructs pages as a tree of PDF standard structure types,
from the tagged structure tree or from geometry plus font-size ranking. Page
filtering and empty-node pruning live in the builder so two serializers cannot
disagree about whether a node is there.

Nothing consumes it yet; htmlsemantic.ts moves onto it next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Rewrite `htmlsemantic.ts` as a serializer

The risky task. Its success condition is the Task 1 snapshot staying green
without modification.

**Files:**
- Modify: `src/htmlsemantic.ts` (full rewrite — the file shrinks from 183 lines
  to roughly 55)
- Modify: `src/html.ts:55-66` (`bodyFor`)

**Interfaces:**
- Consumes: `buildDocModel`, `DocNode`, `DocContainer`, `DocFigure` from Task 2.
- Produces: `function semanticBody(doc: Document, nodes: DocNode[]): string`.
  Replaces the old `taggedBody(doc, root, only)` and
  `untaggedBody(doc, pages, ranks)`, both of which are deleted.

- [ ] **Step 1: Replace `src/htmlsemantic.ts` entirely**

```ts
import type { Document } from './document.js';
import { escapeHtml } from './html.js';
import { imageHref } from './imagehref.js';
import type { DocFigure, DocNode } from './docmodel.js';

/** Standard structure type → HTML tag. Types absent here fall back to <div>. */
const TAG_FOR: Record<string, string> = {
  P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
  L: 'ul', LI: 'li', Span: 'span', Link: 'a',
  Document: 'div', Part: 'div', Sect: 'div', Div: 'div', Art: 'div', TOC: 'div', TOCI: 'div',
};

function figureHtml(doc: Document, fig: DocFigure): string {
  const alt = escapeHtml(fig.alt);
  const hrefs: string[] = [];
  for (const s of fig.images) {
    const href = imageHref(doc, s, [0, 0, 0]);
    if (href) hrefs.push(href);
  }
  // A tagged /Figure announces itself even with nothing to show — the /Alt is
  // the accessible content. An untagged page image has no alt, so an image that
  // will not encode leaves nothing behind.
  if (!hrefs.length) return fig.tagged ? `<img alt="${alt}">` : '';
  // A figure is described once. Repeating /Alt on each part of a composite
  // would have a screen reader announce the same description N times.
  return hrefs.map((h, i) => `<img src="${h}" alt="${i === 0 ? alt : ''}">`).join('');
}

function nodeHtml(doc: Document, node: DocNode): string {
  if (node.kind === 'text') return escapeHtml(node.text);
  if (node.kind === 'table') return node.table.toHtml();
  if (node.kind === 'figure') return figureHtml(doc, node);

  const inner = node.children.map((c) => nodeHtml(doc, c)).filter((s) => s).join('');
  if (!inner) return '';
  const tag = TAG_FOR[node.type] ?? 'div';
  const lang = node.lang ? ` lang="${escapeHtml(node.lang)}"` : '';
  return `<${tag}${lang}>${inner}</${tag}>`;
}

/** Serialize a document model as reflowable semantic HTML. */
export function semanticBody(doc: Document, nodes: DocNode[]): string {
  return nodes.map((n) => nodeHtml(doc, n)).filter((s) => s).join('\n');
}
```

- [ ] **Step 2: Rewire `src/html.ts`**

Replace the import on line 3 and the `bodyFor` function (lines 54-66).

Import becomes:
```ts
import { semanticBody } from './htmlsemantic.js';
import { buildDocModel } from './docmodel.js';
```

`bodyFor` becomes:
```ts
/** The body markup for `pages`. */
function bodyFor(doc: Document, pages: Page[], opts: HtmlOptions): string {
  void opts;
  return semanticBody(doc, buildDocModel(doc, pages));
}
```

Then delete the now-unused `headingRanks` import from `./textrank.js` — it moved
into `docmodel.ts`. `npm run typecheck` will flag it if you miss it.

- [ ] **Step 3: Run the fence**

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS, 11 tests, **0 snapshots written and 0 obsolete**.

If any snapshot differs, do NOT update it. Read the diff: it names the exact
construct the model lost. Fix `docmodel.ts` or `htmlsemantic.ts` until the diff
is empty. If it cannot be made empty, STOP and report — the spec says the
approach is wrong in that case.

- [ ] **Step 4: Cover the unencodable-image asymmetry**

`DocFigure.tagged` exists for a case no test reaches, so the snapshot cannot
protect it. The tagged half is already covered — `buildMultiPageTaggedPdf`'s
`/Figure` marks no image, and the fence records its `<img alt="A figure">`. The
untagged half is not.

`imageHref` returns `undefined` when `!width || !height` (`src/imagehref.ts:73`),
which makes a zero-width image the cheapest possible fixture. Append this
`describe` block to `test/html.test.ts`:

```ts
describe('ToHtml — an image that will not encode', () => {
  // The asymmetry DocFigure.tagged records: a tagged /Figure still announces
  // itself through its /Alt, because that is the accessible content, while an
  // untagged bare page image has no alt and so leaves nothing behind. Nothing
  // else in the suite reaches this — every other fixture's image encodes.
  it('untagged: emits no img at all', () => {
    const doc = Document.Open(buildTextAndImagePage(FIGURE_PAGE));
    doc.Pages[0].Images[0].Stream.dict.set('Width', 0);   // imageHref gives up
    const html = doc.ToHtml({ fragment: true });
    expect(html).not.toContain('<img');
    expect(html).toContain('caption');                    // the page's text survives
  });

  it('tagged: still emits the alt', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('<img alt="A figure">');
  });
});
```

Run: `npx vitest run test/html.test.ts`
Expected: PASS.

Then prove it bites: in `src/htmlsemantic.ts`, change
`return fig.tagged ? \`<img alt="${alt}">\` : '';` to
`return \`<img alt="${alt}">\`;`.
Run: `npx vitest run test/html.test.ts`
Expected: FAIL on "untagged: emits no img at all".
Restore the line and re-run.
Expected: PASS.

- [ ] **Step 5: Run the full gates**

Run: `npx vitest run test/html.test.ts`
Expected: PASS — the behavioural assertions, not just the hashes.
Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 6: Commit**

```bash
git add src/htmlsemantic.ts src/html.ts test/html.test.ts
git commit -m "refactor(html): serialize the document model instead of walking the PDF

htmlsemantic.ts keeps TAG_FOR, escaping and the composite-figure alt rule and
loses the walk, which now lives in docmodel.ts. Output is byte-identical:
test/html-identity.test.ts passes with its snapshot unmodified.

Adds the one case the fence could not protect: an untagged image that will not
encode emits nothing, where a tagged /Figure still emits its /Alt.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `escapeMarkdown`

A pure function with its own oracle, written before anything calls it.

**Files:**
- Create: `src/mdexport.ts` (this task adds only the escaper; Task 5 adds the rest)
- Test: `test/markdown-escape.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `function escapeMarkdown(text: string): string`.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-escape.test.ts`. The oracle is our own CommonMark parser:
escaping is correct exactly when parsing the escaped string recovers the
original text.

```ts
import { describe, it, expect } from 'vitest';
import { escapeMarkdown } from '../src/mdexport.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdBlock, MdInline, MdNode } from '../src/mdast.js';

/** The literal text a parsed document renders, ignoring structure.
 *
 *  Only reaches node kinds a correctly escaped paragraph can produce. A
 *  construct appearing here that should not (a heading, a list, a code span)
 *  shows up as missing or extra text in the caller's comparison. */
function mdText(node: MdNode): string {
  switch (node.type) {
    case 'text': return node.value;
    case 'code': return node.value;
    case 'softbreak': return '\n';
    case 'linebreak': return '\n';
    case 'html_inline': return node.literal;
    case 'html_block': return node.literal;
    case 'code_block': return node.literal;
    case 'thematic_break': return '';
    default: {
      const kids = (node as { children?: (MdBlock | MdInline)[] }).children ?? [];
      return kids.map(mdText).join('');
    }
  }
}

/** The invariant: escaping is correct when the parser recovers the input. */
function roundTrips(s: string): void {
  const escaped = escapeMarkdown(s);
  const parsed = parseMarkdown(escaped, { gfm: true });
  expect(mdText(parsed)).toBe(s);
}

describe('escapeMarkdown — the parser is the oracle', () => {
  const cases: [string, string][] = [
    ['plain text', 'plain text'],
    ['emphasis markers', 'a *b* c and _d_ e'],
    ['a code span', 'use `npm test` now'],
    ['brackets', 'see [1] and ![2]'],
    ['a pipe', 'a | b'],
    ['an angle bracket', 'compare <b> to <https://x>'],
    ['an ampersand entity', 'AT&T and &copy; and &#65;'],
    ['a tilde', 'approx ~5 and ~~six~~'],
    ['a backslash', 'a \\ b and \\* c'],
    ['a leading hash', '# not a heading'],
    ['a leading dash', '- not a list'],
    ['a leading plus', '+ not a list'],
    ['a leading angle', '> not a quote'],
    ['a leading number', '1. not a list'],
    ['a leading paren number', '1) not a list'],
    ['a thematic break', '---'],
    ['a setext underline', '==='],
    ['everything at once', '# 1) a *b* `c` [d] <e> & ~f~ | g \\ h'],
  ];
  for (const [name, input] of cases) {
    it(name, () => roundTrips(input));
  }

  it('leaves text with nothing structural untouched', () => {
    expect(escapeMarkdown('Revenue grew twelve percent this year.'))
      .toBe('Revenue grew twelve percent this year.');
  });

  it('does not escape a mid-line hash or dash', () => {
    // Over-escaping is a defect too: these are not structural where they sit.
    expect(escapeMarkdown('issue #42 and a-b')).toBe('issue #42 and a-b');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/markdown-escape.test.ts`
Expected: FAIL — cannot resolve `../src/mdexport.js`.

- [ ] **Step 3: Write the escaper**

Create `src/mdexport.ts` with only this for now:

```ts
/** Characters that are structural wherever they appear. */
const INLINE_SPECIAL = /[\\`*_[\]<&~|]/g;

/** Escape one line: the inline set everywhere, plus the block openers that are
 *  structural only at a line's start. CommonMark allows a backslash escape
 *  before any ASCII punctuation, so every case here has the same spelling. */
function escapeLine(line: string): string {
  let out = line.replace(INLINE_SPECIAL, (c) => `\\${c}`);
  // Up to three leading spaces still open a block; four make it indented code,
  // which the callers below never emit.
  out = out.replace(/^(\s{0,3})([#>+=-])/, '$1\\$2');
  out = out.replace(/^(\s{0,3})(\d{1,9})([.)])/, '$1$2\\$3');
  return out;
}

/** Escape text so it survives a Markdown round trip as literal text.
 *
 *  Correctness is defined against our own parser rather than against a
 *  hand-written character list: `parseMarkdown(escapeMarkdown(s))` must yield
 *  text equal to `s`. Under-escaping turns a leading '#' in body text into a
 *  heading and a '|' into a cell boundary; over-escaping litters the output
 *  with backslashes. Both are visible to the oracle; neither is visible to a
 *  list. */
export function escapeMarkdown(text: string): string {
  return text.split('\n').map(escapeLine).join('\n');
}
```

- [ ] **Step 4: Run the tests and the gates**

Run: `npx vitest run test/markdown-escape.test.ts`
Expected: PASS, 20 tests.

If a case fails, the oracle has told you exactly which character class is wrong
— add it to `INLINE_SPECIAL` or to a line-start rule. Do not weaken the test to
make it pass.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Prove the oracle bites**

Temporarily remove `|` from `INLINE_SPECIAL` (making it `/[\\`*_[\]<&~]/g`).
Run: `npx vitest run test/markdown-escape.test.ts`
Expected: still PASS — a lone `|` in a paragraph is not structural without a
delimiter row, so this proves the `|` escape is **not** covered by the current
oracle. Restore it, then instead remove `#` from the line-start rule.
Run: `npx vitest run test/markdown-escape.test.ts`
Expected: FAIL on "a leading hash" and "everything at once".
Restore the rule and re-run.
Expected: PASS.

Record this honestly in the commit message: the `|` escape is defensive for
`no93.3`'s table path and is not currently pinned by a test. Do not claim
coverage the suite does not have.

- [ ] **Step 6: Commit**

```bash
git add src/mdexport.ts test/markdown-escape.test.ts
git commit -m "feat(mdexport): escape text against the CommonMark parser as oracle

escapeMarkdown is specified by parseMarkdown(escapeMarkdown(s)) recovering s,
not by a hand-written character list. Measured: removing the leading-# rule
goes red; removing the | escape does NOT, since a lone pipe is not structural
without a delimiter row — that escape is defensive for no93.3 and is currently
unpinned.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The Markdown serializer and the public API

**Files:**
- Modify: `src/mdexport.ts` (add options, serializer, entry points)
- Modify: `src/page.ts` (add `ToMarkdown` after `ToHtml` at line 544)
- Modify: `src/document.ts` (add `ToMarkdown` after `ToHtml` at line 938)
- Modify: `src/index.ts` (export the option type near line 192)
- Test: `test/markdown-export.test.ts`

**Interfaces:**
- Consumes: `buildDocModel`, `DocNode`, `DocFigure` (Task 2); `escapeMarkdown`
  (Task 4); `imageHref`, `Table.toMarkdown()` (existing).
- Produces:
  - `interface MarkdownExportOptions {}`
  - `function renderPageToMarkdown(doc: Document, page: Page, opts?: MarkdownExportOptions): string`
  - `function renderDocumentToMarkdown(doc: Document, opts?: MarkdownExportOptions): string`
  - `Page.ToMarkdown(options?: MarkdownExportOptions): string`
  - `Document.ToMarkdown(options?: MarkdownExportOptions): string`

- [ ] **Step 1: Write the failing test**

Create `test/markdown-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

const FIGURE_PAGE = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

describe('ToMarkdown — untagged', () => {
  it('emits an ATX heading and a paragraph, blank-line separated', () => {
    const md = Document.Open(buildUntaggedHtmlPdf()).ToMarkdown();
    expect(md).toBe('# Quarterly Report\n\nRevenue grew twelve percent this year.\n');
  });

  it('ends with exactly one newline', () => {
    const md = Document.Open(buildUntaggedHtmlPdf()).ToMarkdown();
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('emits a page image as an inline data URI', () => {
    const md = Document.Open(buildTextAndImagePage(FIGURE_PAGE)).ToMarkdown();
    expect(md).toMatch(/!\[\]\(data:image\/png;base64,/);
  });
});

describe('ToMarkdown — tagged', () => {
  it('drives headings from the structure tree', () => {
    const md = Document.Open(buildTaggedPdf()).ToMarkdown();
    expect(md).toContain('## ');            // the RoleMap H2
    expect(md).toContain('Body paragraph actual');   // /ActualText won
  });

  it('flattens the Document and Sect wrappers rather than emitting a marker', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).ToMarkdown();
    expect(md).toContain('Page one body');
    expect(md).toContain('Page two body');
    expect(md).not.toContain('Sect');
    expect(md).not.toContain('<div>');
  });

  it('emits a figure with its /Alt', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).ToMarkdown();
    expect(md).toContain('![A figure]');
  });

  it('emits a table as a GFM pipe table', () => {
    const md = Document.Open(buildTaggedTablePdf()).ToMarkdown();
    expect(md).toContain('| --- |');
    expect(md.split('\n').filter((l) => l.startsWith('|')).length).toBeGreaterThan(2);
  });
});

describe('ToMarkdown — page filtering', () => {
  it('emits only the requested page', () => {
    const md = Document.Open(buildMultiPageTaggedPdf()).Pages[1].ToMarkdown();
    expect(md).toContain('Page two body');
    expect(md).not.toContain('Page one body');
  });
});

describe('ToMarkdown — tagged and untagged agree', () => {
  // One deliberately simple document: a heading and a paragraph, where the
  // font-size ranking and the structure tree have no room to disagree.
  it('produces the same Markdown either way', () => {
    const untagged = Document.Open(buildUntaggedHtmlPdf());
    const plain = untagged.ToMarkdown();

    const tagged = Document.Open(buildUntaggedHtmlPdf());
    tagged.AutoTag();
    const viaTree = Document.Open(tagged.Save()).ToMarkdown();

    expect(viaTree).toBe(plain);
  });
});

describe('ToMarkdown — contract', () => {
  it('never throws on a document with no content', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    expect(() => doc.ToMarkdown()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/markdown-export.test.ts`
Expected: FAIL — `doc.ToMarkdown is not a function`.

- [ ] **Step 3: Add the serializer to `src/mdexport.ts`**

The file currently holds only `INLINE_SPECIAL`, `escapeLine` and
`escapeMarkdown` from Task 4. Add these imports at the very top of the file,
above `INLINE_SPECIAL`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { buildDocModel, type DocFigure, type DocNode } from './docmodel.js';
import { imageHref } from './imagehref.js';
```

and append everything below to the end of the file, after `escapeMarkdown`:

```ts
/** Options for {@link Page.ToMarkdown} and {@link Document.ToMarkdown}.
 *
 *  Empty today. It exists so the signature is stable for no93.4's link options
 *  and no93.5's image options. NOT `MarkdownOptions`, which is the parser's
 *  option bag for the opposite direction. */
export interface MarkdownExportOptions {}

/** Structure types that concatenate into the enclosing block rather than
 *  starting one. A Link renders as its text until no93.4 recovers the URI.
 *
 *  Deliberately short. An inline type nested inside a P never reaches this set
 *  — inlineText recurses through every container — so it matters only for one
 *  appearing at block level, where a container holding a single text run gives
 *  the same result either way. */
const INLINE_TYPES = new Set(['Span', 'Link']);

/** Heading level, or 0 for anything else. */
function headingLevel(type: string): number {
  const m = /^H([1-6])$/.exec(type);
  return m ? Number(m[1]) : 0;
}

/** All text under a node, concatenated and escaped — the inline projection. */
function inlineText(node: DocNode): string {
  if (node.kind === 'text') return escapeMarkdown(node.text);
  if (node.kind === 'container') return node.children.map(inlineText).join('');
  return '';   // a table or figure nested inside an inline run has no inline form
}

function figureMarkdown(doc: Document, fig: DocFigure): string[] {
  const alt = escapeMarkdown(fig.alt);
  const hrefs: string[] = [];
  for (const s of fig.images) {
    const href = imageHref(doc, s, [0, 0, 0]);
    if (href) hrefs.push(href);
  }
  // Mirrors the HTML serializer: a tagged /Figure still announces itself
  // through its /Alt when there is nothing to show, an untagged page image
  // leaves nothing behind.
  if (!hrefs.length) return fig.tagged ? [`![${alt}]()`] : [];
  return hrefs.map((h, i) => `![${i === 0 ? alt : ''}](${h})`);
}

/** Append `node`'s blocks to `out`. */
function nodeBlocks(doc: Document, node: DocNode, out: string[]): void {
  if (node.kind === 'text') {
    const t = escapeMarkdown(node.text);
    if (t) out.push(t);
    return;
  }
  if (node.kind === 'table') { out.push(node.table.toMarkdown()); return; }
  if (node.kind === 'figure') { out.push(...figureMarkdown(doc, node)); return; }

  const level = headingLevel(node.type);
  if (level) {
    const t = node.children.map(inlineText).join('').trim();
    if (t) out.push(`${'#'.repeat(level)} ${t}`);
    return;
  }
  if (node.type === 'P' || INLINE_TYPES.has(node.type)) {
    const t = node.children.map(inlineText).join('').trim();
    if (t) out.push(t);
    return;
  }
  // Transparent: an unknown type emits its children as sibling blocks rather
  // than vanishing. Visible content beats a silently dropped subtree — the rule
  // svgdraw.ts already sets — and it is what keeps no93.2's L/LI readable
  // before that issue lands.
  for (const child of node.children) nodeBlocks(doc, child, out);
}

function render(doc: Document, pages: Page[], opts: MarkdownExportOptions): string {
  void opts;
  const blocks: string[] = [];
  try {
    for (const node of buildDocModel(doc, pages)) nodeBlocks(doc, node, blocks);
  } catch {
    // Degrade: emit whatever was produced. Matches ToHtml and renderPageToSvg,
    // neither of which throws on a document we could not fully reconstruct.
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** Render one page to GFM Markdown. Never throws. */
export function renderPageToMarkdown(
  doc: Document, page: Page, opts: MarkdownExportOptions = {}): string {
  return render(doc, [page], opts);
}

/** Render every page to one Markdown document. Never throws. */
export function renderDocumentToMarkdown(
  doc: Document, opts: MarkdownExportOptions = {}): string {
  return render(doc, doc.Pages, opts);
}
```

- [ ] **Step 4: Wire `Page.ToMarkdown`**

In `src/page.ts`, add to the import block near line 12:
```ts
import { renderPageToMarkdown, MarkdownExportOptions } from './mdexport.js';
```
and immediately after the `ToHtml` method (which ends at line 544):
```ts
  /** Render this page to GFM Markdown. Reconstructs the document from the
   *  tagged structure tree when the document has one, and from font-size
   *  heuristics when it does not. Never throws. */
  ToMarkdown(options?: MarkdownExportOptions): string {
    return renderPageToMarkdown(this.doc, this, options);
  }
```

- [ ] **Step 5: Wire `Document.ToMarkdown`**

In `src/document.ts`, add to the import block near line 13:
```ts
import { renderDocumentToMarkdown, MarkdownExportOptions } from './mdexport.js';
```
and immediately after the `ToHtml` method (which ends at line 938):
```ts
  /** Render every page to one Markdown document. See `Page.ToMarkdown`. */
  ToMarkdown(options?: MarkdownExportOptions): string {
    return renderDocumentToMarkdown(this, options);
  }
```

- [ ] **Step 6: Export the option type**

In `src/index.ts`, beside the existing `export type { MarkdownOptions } from './markdown.js';`
on line 192, add:
```ts
export type { MarkdownExportOptions } from './mdexport.js';
```

- [ ] **Step 7: Run the tests and the gates**

Run: `npx vitest run test/markdown-export.test.ts`
Expected: PASS, 10 tests.
Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS, 0 snapshots written.
Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 8: Prove the transparent-container rule is load-bearing**

In `src/mdexport.ts`, temporarily replace the transparent branch's body
(`for (const child of node.children) nodeBlocks(doc, child, out);`) with
`return;`.
Run: `npx vitest run test/markdown-export.test.ts`
Expected: FAIL on "flattens the Document and Sect wrappers" and on the tagged
figure and table cases — everything in a tagged tree hangs under a `Document`
wrapper, so dropping unknown types empties the output.
Restore the line and re-run.
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/mdexport.ts src/page.ts src/document.ts src/index.ts test/markdown-export.test.ts
git commit -m "feat(mdexport): Document.ToMarkdown and Page.ToMarkdown

The second serializer over docmodel.ts. Headings from H1..H6 or font-size
ranking, paragraphs, GFM pipe tables via Table.toMarkdown, figures as data
URIs. An unknown structure type is transparent, never dropped.

Closes the skeleton half of no93.1; lists and code blocks are no93.2, link
destinations no93.4, image dedup no93.5.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end round trip and documentation

Proves the two directions of the Markdown stack against each other and brings
the docs into line, as CLAUDE.md's conventions require.

**Files:**
- Test: `test/markdown-roundtrip.test.ts` (create)
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `Document.ToMarkdown` (Task 5), `Document.AddMarkdown` (existing),
  `parseMarkdown` (existing).
- Produces: nothing new.

- [ ] **Step 1: Write the round-trip test**

Create `test/markdown-roundtrip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdBlock, MdInline, MdNode } from '../src/mdast.js';

const SOURCE = [
  '# Quarterly Report',
  '',
  'Revenue grew twelve percent this year.',
  '',
  '## Regional breakdown',
  '',
  'The northern region led growth.',
  '',
].join('\n');

function textOf(node: MdNode): string {
  if (node.type === 'text') return node.value;
  const kids = (node as { children?: (MdBlock | MdInline)[] }).children ?? [];
  return kids.map(textOf).join('');
}

/** Headings as [level, text] and paragraphs as text — the block skeleton. */
function skeleton(md: string): string[] {
  const doc = parseMarkdown(md, { gfm: true });
  const out: string[] = [];
  for (const block of doc.children) {
    if (block.type === 'heading') out.push(`h${block.level}:${textOf(block).trim()}`);
    else if (block.type === 'paragraph') out.push(`p:${textOf(block).trim()}`);
  }
  return out;
}

describe('Markdown round trip through PDF', () => {
  // Compares BLOCK STRUCTURE, not ASTs. A round trip through PDF is lossy by
  // construction here: emphasis has no recovery path until a sibling issue adds
  // one, so asserting AST equality would fail for a reason that is not a defect.
  it('recovers headings and paragraphs from a tagged document', () => {
    const doc = Document.New();
    doc.AddMarkdown(SOURCE, { tagged: true });
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(skeleton(back)).toEqual(skeleton(SOURCE));
  });

  it('recovers the text even from an untagged rendering', () => {
    const doc = Document.New();
    doc.AddMarkdown(SOURCE);
    const back = Document.Open(doc.Save()).ToMarkdown();

    const words = (s: string) => s.replace(/[#*_`]/g, '').split(/\s+/).filter((w) => w);
    for (const w of words(SOURCE)) expect(words(back)).toContain(w);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/markdown-roundtrip.test.ts`
Expected: PASS, 2 tests.

If the tagged case fails on heading LEVELS, read the output before changing
anything: `AddMarkdown({ tagged: true })` writes `/H1` and `/H2` elements, so a
level mismatch means `headingLevel` in `mdexport.ts` is not reading
`StandardType` as expected. If it fails because `Document.New()` or
`AddMarkdown`'s option name differs, check `src/document.ts` for the real
signature and fix the test — do not change `mdexport.ts` to match a guess.

- [ ] **Step 3: Update `README.md`**

Three edits, all at located lines. Read each surrounding line first and match
its style — the API table rows are long single lines with `|` delimiters.

**(a)** The API table has `doc.ToHtml` and `page.ToHtml` rows at lines
1886-1887. Add two rows immediately after line 1887:

```markdown
| `doc.ToMarkdown(options?)` | Export every page to one GFM Markdown document. Reconstructs the document from the `/StructTree` when tagged and from font-size heuristics otherwise: ATX headings, paragraphs, pipe tables, and images inline as `data:` URIs |
| `page.ToMarkdown(options?)` | Export one page to Markdown (same options; a tagged tree is filtered to this page's content) |
```

**(b)** The Quick start snippet at lines 64-73 ends with the `doc.ToHtml()`
line and its commented `writeFileSync`. Add after line 72:

```typescript
const md = doc.ToMarkdown();               // GFM Markdown, all pages
// fs.writeFileSync('out.md', md);
```

**(c)** The Limitations list runs from roughly line 2037 to 2051. Add an entry
in it, because the deferred siblings are real gaps a reader will hit:

```markdown
- **Markdown export covers headings, paragraphs, tables and images** — `ToMarkdown` does not yet recover lists, code blocks or link destinations (a `/Link` renders as its text), and every image is emitted inline as a `data:` URI rather than deduplicated or written alongside.
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the Source (`src/`) list, add a `docmodel.ts` entry immediately before the
`html.ts` entry:

```markdown
- **docmodel.ts** — the neutral document model behind every document exporter.
  `buildDocModel(doc, pages)` reconstructs pages as a `DocNode[]` tree from the
  tagged structure tree when the document has one, and from geometry plus
  `textrank.ts` font-size ranking when it does not. `htmlsemantic.ts` and
  `mdexport.ts` are serializers over it; DOCX and EPUB export are meant to be
  the third and fourth.
  **Invariant:** the tree speaks PDF standard structure types (`'H1'`, `'P'`,
  `'Span'`), never HTML tags. That is what keeps the serializers unprivileged
  and what makes the untagged builder's output indistinguishable in shape from
  the tagged one.
  **Invariant:** page filtering and empty-node pruning live in the builder, not
  in a serializer. Two serializers deciding independently whether a node is
  empty is how two exports come to disagree about a document.
  **Invariant:** `DocFigure.tagged` records provenance because the two paths
  legitimately differ when an image will not encode: a tagged `/Figure` still
  emits its `/Alt`, since that is the accessible content, while an untagged
  bare page image emits nothing, having no alt to announce. Erasing the flag
  changes untagged output silently — no test covers an unencodable image.
```

Then extend the existing `html.ts`/`htmlsemantic.ts` entry to note that
`htmlsemantic.ts` is now a serializer, and add an `mdexport.ts` entry after the
Markdown parsing block:

```markdown
- **mdexport.ts** — PDF→**Markdown** (`Document.ToMarkdown`, `Page.ToMarkdown`),
  a serializer over `docmodel.ts` plus `escapeMarkdown`. Note the direction: the
  eleven `md*.ts` modules above are all Markdown→PDF and share no code with this
  one, the same hazard the `svgembed.ts`/`svgrender.ts` split carries.
  **Invariant:** the escaper is specified by our own parser —
  `parseMarkdown(escapeMarkdown(s))` must yield text equal to `s`. A
  hand-written character list makes both under- and over-escaping invisible.
  **Invariant:** an unknown structure type is transparent — its children are
  emitted as sibling blocks — never dropped. Everything in a tagged tree hangs
  under a `Document` wrapper, so dropping unknown types empties the output
  entirely.
  **Invariant:** the option bag is `MarkdownExportOptions`, not
  `MarkdownOptions`, which `markdown.ts` already exports for the opposite
  direction.
```

- [ ] **Step 5: Run the full gates one last time**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm test`
Expected: PASS, whole suite, including `test/html-identity.test.ts` with its
snapshot unmodified.

- [ ] **Step 6: Commit**

```bash
git add test/markdown-roundtrip.test.ts README.md CLAUDE.md
git commit -m "test(mdexport): round-trip Markdown through PDF, and document it

Renders a Markdown source through AddMarkdown and back out through ToMarkdown,
comparing block structure rather than ASTs — the trip is lossy by construction
until no93.2/.4 land. README and CLAUDE.md record the new modules and the three
invariants docmodel.ts carries.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close no93.1
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

If `bd close` prompts for a completion note, record what shipped and what was
deferred to `no93.2`–`no93.5`.

---

## Notes for the executor

- **`test/helpers/` fixture names are load-bearing.** Every helper imported in
  this plan is already imported by `test/html.test.ts`; if a name does not
  resolve, read that file rather than inventing a fixture.
- **`Table.toMarkdown()` escapes only `|`.** That is pre-existing
  (`src/tablemodel.ts:101`) and out of scope here. Do not "fix" it — a cell
  whose text contains `*` is `no93.3`'s problem, and changing the method now
  would move `Table.toMarkdown`'s existing callers' output.
- **If a snapshot in `test/html-identity.test.ts` ever differs, that is the
  plan failing, not the test.** The spec commits to byte-identity. Stop and
  report.
- **Task 5's "tagged and untagged agree" test is the one assertion in this plan
  written without having seen it run.** It leans on `AutoTag` recovering the
  same `H1` + `P` split that the font-size ranking finds directly, which is
  plausible (both read `textrank.ts`) but not verified. If it fails, print both
  strings before touching anything: a difference in heading LEVEL or in the
  wrapper types is worth investigating in `docmodel.ts`, but a difference in
  whitespace or block ORDER is `AutoTag`'s tree shape, not a defect in this
  work — in that case narrow the assertion to the heading and paragraph text
  and record in the commit message that the two paths agree on content, not on
  exact output.
- **`Document.New()` takes an optional `PageFormat` and starts with zero pages**
  (`src/document.ts:335`); `AddMarkdown(src, options)` appends pages and returns
  `{ pages, skipped }` (`src/document.ts:1984`), with `tagged` arriving through
  `FlowOptions`. Task 6 relies on both.
