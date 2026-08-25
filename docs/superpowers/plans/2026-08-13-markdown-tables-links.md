# Markdown Tables and Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Markdown tables and place `/URI` link annotations, closing the two constructs `gl6o.3.2` shipped in `skipped`.

**Architecture:** Two halves sharing one idea — a laid-out run has a position worth reporting. The link half adds `TextRun.link`, extracts the per-segment geometry walk that `runDecorOps` already performs (correcting it for justification), and hands the boxes to a new `runlink.ts` that places the annotations and their `/Link` structure. The table half widens table cells to `TextRun[]`, extracts `drawTable`'s row-slice painter, and adds a `flowtable.ts` element that drives `TableBuilder`'s existing `measure` / `continuationFrom` against a flow column.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies (`node:` built-ins only).

**Spec:** `docs/superpowers/specs/2026-08-13-markdown-tables-links-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **`npm run typecheck && npm test` must be green before every commit.**
- **Errors are `TypeError` for bad options**, `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` for the documented public error types. Validate *before* allocating, so a rejected call leaves the document byte-identical.
- **Nothing in the Markdown stack throws on document content.** Damage renders as literal text.
- **A struct tree is cyclic** (kids link back to parents). Never `JSON.stringify` it in a test — walk it.
- **`addLink`'s rect is `[llx, lly, urx, ury]`**, not `[x, y, w, h]`. The two conventions sit side by side in this codebase.
- **Byte-identity is a fence, not a hope.** Where a task claims output is unchanged, break the code path and confirm the suite goes red before trusting the green.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

---

## Phase 1 — the link half (Tasks 1-6)

### Task 1: `TextRun.link` — the vocabulary

**Files:**
- Modify: `src/textdecor.ts` (the `TextRun` interface, ~line 135)
- Modify: `src/stamp.ts` (`ResolvedRun` ~line 389, `resolveRuns` ~line 404)
- Test: `test/rich-runs-link.test.ts` (create)

**Interfaces:**
- Produces: `TextRun.link?: string`; `ResolvedRun.link: string | undefined` (module-private to `stamp.ts`, consumed by Tasks 2-3 and 5).

- [ ] **Step 1: Write the failing test**

Create `test/rich-runs-link.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

const page = () => {
  const doc = Document.New();
  return { doc, page: doc.AddPage(PageFormat.A4).page };
};

describe('TextRun.link validation', () => {
  it('rejects a non-string link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: 42 as unknown as string }], [50, 50, 200, 100],
    )).toThrow(TypeError);
  });

  it('rejects an empty link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: '' }], [50, 50, 200, 100],
    )).toThrow(TypeError);
  });

  it('names the offending run index in the message', () => {
    const { page: p } = page();
    const runs: TextRun[] = [{ text: 'ok' }, { text: 'bad', link: '' }];
    expect(() => p.AddTextBlock(runs, [50, 50, 200, 100])).toThrow(/run 1/);
  });

  it('leaves the page untouched when a run is rejected', () => {
    const { page: p } = page();
    const before = p.GetText();
    expect(() => p.AddTextBlock(
      [{ text: 'drawn' }, { text: 'bad', link: '' }], [50, 50, 200, 100],
    )).toThrow(TypeError);
    expect(p.GetText()).toBe(before);
    expect(p.Annotations.length).toBe(0);
  });

  it('accepts a valid link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: 'https://example.com' }], [50, 50, 200, 100],
    )).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rich-runs-link.test.ts`
Expected: FAIL — the two rejection cases do not throw (no validation exists yet).

- [ ] **Step 3: Add the field to `src/textdecor.ts`**

In the `TextRun` interface, after `color`:

```ts
  /** Make this run a hyperlink to this absolute URI. A `/Link` annotation is
   *  placed over the run's laid-out glyphs — one per line it occupies, so a
   *  link broken across a line break stays clickable on both. Styling is NOT
   *  implied: set `color` and `underline` for the usual blue-underlined look.
   *  Default: none. */
  link?: string;
```

- [ ] **Step 4: Carry and validate it in `src/stamp.ts`**

Add the field to `ResolvedRun`:

```ts
interface ResolvedRun {
  layout: LayoutRun;
  font: AuthoringFont;
  color: [number, number, number];
  decor: ResolvedDecor | undefined;
  /** The /URI this run links to, or undefined. */
  link: string | undefined;
}
```

In `resolveRuns`, immediately before the `const own = ...` line:

```ts
    // Rejected before anything is emitted, like every other run property: a bad
    // link late in the list must leave the document byte-identical.
    if (r.link !== undefined && (typeof r.link !== 'string' || r.link === ''))
      throw new TypeError(`run ${i}: link must be a non-empty string`);
```

and add `link: r.link` to the pushed object:

```ts
    out.push({
      layout: { text: r.text, driver: driverFor(font), fontSize },
      font, color, decor, link: r.link,
    });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/rich-runs-link.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/textdecor.ts src/stamp.ts test/rich-runs-link.test.ts
git commit -m "$(cat <<'EOF'
feat(text): TextRun.link, the hyperlink vocabulary

Validated in resolveRuns beside every other run property, so a bad link late in
the list leaves the document byte-identical. Nothing reads it yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `segmentBoxes` — one segment walk, corrected for justification

`runDecorOps` already walks each line's segments accumulating `dx += seg.width`. That is the exact walk link rects need — and it is **wrong under `justify`**, because the emitter sets `Tw`, which widens every space. A justified run-decorated block therefore draws its underline progressively left of its glyphs today. Extracting the walk fixes that defect and gives Task 3 its geometry.

**Files:**
- Modify: `src/stamp.ts` (`runDecorOps` ~line 557, `buildRunBlockBody` ~line 599)
- Test: `test/rich-runs-justify-decor.test.ts` (create)

**Interfaces:**
- Consumes: `ResolvedRun` (Task 1).
- Produces: `interface SegmentBox { run: number; x: number; baseline: number; width: number }` and `function segmentBoxes(lines, x, w, baseline0, o): SegmentBox[]` — both module-private to `stamp.ts`, consumed by Tasks 3 and 5.

- [ ] **Step 1: Write the failing test**

The assertion runs through two independent extractors: `GetPaths()` reads the underline rectangle out of the content stream, `GetTextFragments()` reads the glyph span. Asserting the rect against the arithmetic that produced it would cancel the bug out.

Create `test/rich-runs-justify-decor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

// Long enough that a justified line carries real slack across several spaces,
// so a Tw-blind box drifts measurably. The underlined run is LAST, where the
// accumulated drift is largest.
const RUNS: TextRun[] = [
  { text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa ' },
  { text: 'UNDERLINED', underline: true },
];

describe('run decoration under justify', () => {
  it('puts the underline under the glyphs it decorates', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 500, 300, 200], { align: 'justify', fontSize: 12 });

    const frag = page.GetTextFragments().find((f) => f.text.includes('UNDERLINED'));
    expect(frag).toBeDefined();

    // The underline is the only thin filled path on the page.
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3,
    );
    expect(rules.length).toBe(1);
    const rule = rules[0].bbox;

    // Within a point of the glyph span at both ends.
    expect(Math.abs(rule[0] - frag!.quad[0])).toBeLessThan(1);
    expect(Math.abs(rule[2] - frag!.quad[2])).toBeLessThan(1);
  });

  it('still matches for a left-aligned block (no Tw in play)', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 500, 300, 200], { align: 'left', fontSize: 12 });

    const frag = page.GetTextFragments().find((f) => f.text.includes('UNDERLINED'));
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3,
    );
    expect(rules.length).toBe(1);
    expect(Math.abs(rules[0].bbox[0] - frag!.quad[0])).toBeLessThan(1);
    expect(Math.abs(rules[0].bbox[2] - frag!.quad[2])).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rich-runs-justify-decor.test.ts`
Expected: the `justify` case FAILS (the underline sits left of the glyphs); the `left` case PASSES. If the justify case passes, stop and investigate — the premise of this task is wrong.

- [ ] **Step 3: Add `segmentBoxes` to `src/stamp.ts`**

Insert immediately above `runDecorOps`:

```ts
/** One laid segment's box, in the frame `buildRunBlockBody` draws in. */
interface SegmentBox { run: number; x: number; baseline: number; width: number }

/** Per-segment boxes for a laid run block.
 *
 *  ONE walk feeds both run decoration and link rects: both ask exactly "where
 *  did this segment land", and a second copy is how a justified line's
 *  underline and its link rect come to disagree.
 *
 *  A segment's DRAWN width is not `seg.width`. Under `justify` the emitter sets
 *  `Tw`, which widens every space in the segment, so reading the same
 *  `justifySpacing` the emitter reads is what keeps the boxes on the glyphs —
 *  and the drift accumulates, so the last run on a line is worst hit. */
function segmentBoxes(
  lines: LaidLine[], x: number, w: number, baseline0: number, o: NormalizedBlockOptions,
): SegmentBox[] {
  const out: SegmentBox[] = [];
  lines.forEach((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    const baseline = baseline0 - i * o.leading;
    let dx = x + alignOffset(o.align, w, line.width);
    for (const seg of line.segments) {
      let spaces = 0;
      if (tw > 0) for (const ch of seg.text) if (ch === ' ') spaces++;
      const width = seg.width + tw * spaces;
      out.push({ run: seg.run, x: dx, baseline, width });
      dx += width;
    }
  });
  return out;
}
```

- [ ] **Step 4: Rewrite `runDecorOps` over it**

Replace the whole function body:

```ts
/** The decoration boxes for a laid block when runs carry their own decoration.
 *  Each distinct ResolvedDecor gets its own box list, so a run-level underline
 *  spans exactly that run and a block-level one still spans the line.
 *
 *  The single-decor fast path is NOT routed through here: an unstyled block must
 *  emit the same bytes it always did, and `blockLineBoxes` is what produced them. */
function runDecorOps(
  boxes: SegmentBox[], runs: ResolvedRun[],
): { beneath: string; above: string } {
  const buckets = new Map<ResolvedDecor, LineBox[]>();
  for (const b of boxes) {
    const d = runs[b.run].decor;
    if (d === undefined) continue;
    const list = buckets.get(d) ?? [];
    list.push({ x: b.x, baseline: b.baseline, width: b.width });
    buckets.set(d, list);
  }
  let beneath = '';
  let above = '';
  for (const [d, list] of buckets) {
    const ops = decorRects(list, d);
    beneath += ops.beneath;
    above += ops.above;
  }
  return { beneath, above };
}
```

- [ ] **Step 5: Update the one caller in `buildRunBlockBody`**

Replace the `const dec = runDecorOps(lines, runs, x, w, baseline0, o);` line with:

```ts
  const boxes = segmentBoxes(lines, x, w, baseline0, o);
  const dec = runDecorOps(boxes, runs);
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/rich-runs-justify-decor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Confirm the fence is load-bearing**

Temporarily change `const width = seg.width + tw * spaces;` back to `const width = seg.width;` and re-run. Expected: the `justify` case goes red. Restore the line.

- [ ] **Step 8: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean. `test/rich-runs-identity.test.ts` in particular must stay green — none of its cases justify a run-decorated block, so no hash moves.

```bash
git add src/stamp.ts test/rich-runs-justify-decor.test.ts
git commit -m "$(cat <<'EOF'
fix(text): run decoration follows Tw on a justified line

Extracts the per-segment walk runDecorOps performed inline into segmentBoxes,
which link rects need too. A segment's drawn width is not its measured width:
Tw widens every space, and the error accumulates, so a run-level underline on a
justified line drifted progressively left of its own glyphs. Asserted through
GetPaths against GetTextFragments — two extractors, so the arithmetic cannot
validate itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `runlink.ts` — place the annotations

**Files:**
- Create: `src/runlink.ts`
- Modify: `src/stamp.ts` (`flowTextBlock`'s runs branch, ~line 705)
- Test: `test/rich-runs-link.test.ts` (append)

**Interfaces:**
- Consumes: `SegmentBox`, `ResolvedRun` (Tasks 1-2).
- Produces:
  ```ts
  export interface RunLinkBox {
    uri: string;
    /** Annotation rect [llx, lly, urx, ury]. */
    rect: [number, number, number, number];
  }
  export function placeRunLinks(doc: Document, page: Page, boxes: RunLinkBox[]): LinkAnnotation[];
  ```
  Task 6 extends this signature; Task 5 supplies the MCIDs it will need.

- [ ] **Step 1: Write the failing test**

Append to `test/rich-runs-link.test.ts`:

```ts
describe('link annotations from runs', () => {
  it('places one /Link over the linked run', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }, { text: ' now' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const links = p.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: unknown }).Action)
      .toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('puts the rect on the linked glyphs, not the whole line', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }, { text: ' now' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const rect = p.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect;
    const frag = p.GetTextFragments().find((f) => f.text.includes('the site'))!;
    // Independent path: the fragment quad comes from the text extractor, the
    // rect from the annotation dict.
    expect(rect[0]).toBeGreaterThan(49);
    expect(rect[0]).toBeLessThan(frag.quad[0] + 1);
    expect(rect[2]).toBeGreaterThan(frag.quad[0]);
    // The link must not span the untagged tail.
    expect(rect[2]).toBeLessThan(50 + 300);
  });

  it('places nothing when no run carries a link', () => {
    const { page: p } = page();
    p.AddTextBlock([{ text: 'plain' }, { text: 'text', underline: true }],
      [50, 500, 300, 200]);
    expect(p.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(0);
  });

  it('gives two adjacent links their own annotations', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'one', link: 'https://a.example' }, { text: 'two', link: 'https://b.example' }],
      [50, 500, 300, 200],
    );
    const uris = p.Annotations
      .filter((a) => a.Subtype === 'Link')
      .map((a) => (a as { Action?: { uri?: string } }).Action?.uri)
      .sort();
    expect(uris).toEqual(['https://a.example', 'https://b.example']);
  });

  it('places one rect per line for a link that wraps', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'lead in ' },
       { text: 'a very long link label that must wrap across two lines here',
         link: 'https://example.com' }],
      // Narrow box: the label cannot fit on one line.
      [50, 400, 120, 300], { fontSize: 12 },
    );
    const links = p.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBeGreaterThan(1);
    // Every rect carries the same destination.
    for (const l of links)
      expect((l as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
    // They sit on different baselines.
    const ys = new Set(links.map((l) => Math.round(l.Rect[1])));
    expect(ys.size).toBe(links.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rich-runs-link.test.ts`
Expected: FAIL — no `/Link` annotations are placed.

- [ ] **Step 3: Create `src/runlink.ts`**

```ts
/** A laid-out run becomes a /Link annotation.
 *
 *  Its own module because stamp.ts is the layout-and-ink layer while this is
 *  object-graph work — the split redactannots.ts makes against redact.ts — and
 *  because it holds stamp.ts's dependency on annotation.ts to one symbol.
 *  Nothing in annotation.ts's transitive import graph reaches stamp.ts, so the
 *  edge closes no cycle. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import { addLink, type LinkAnnotation } from './annotation.js';

/** One clickable box: a linked run's extent on ONE line. A run broken across a
 *  line break yields one of these per line, which is why the destination is
 *  repeated rather than shared. */
export interface RunLinkBox {
  uri: string;
  /** Annotation rect [llx, lly, urx, ury] — the /Rect convention, NOT the
   *  [x, y, w, h] the stamping layer passes around. */
  rect: [number, number, number, number];
}

/** Place a /Link over each box. `border: 0` because the text style already
 *  draws the underline; a viewer-drawn frame on top would be a second, uglier
 *  one. Zero-width boxes are skipped: a run that laid out to nothing has no
 *  glyphs to click. */
export function placeRunLinks(
  doc: Document, page: Page, boxes: RunLinkBox[],
): LinkAnnotation[] {
  const out: LinkAnnotation[] = [];
  for (const b of boxes) {
    if (!(b.rect[2] > b.rect[0]) || !(b.rect[3] > b.rect[1])) continue;
    out.push(addLink(doc, page, {
      rect: b.rect,
      action: { type: 'uri', uri: b.uri },
      border: 0,
    }));
  }
  return out;
}
```

- [ ] **Step 4: Build the boxes and call it from `src/stamp.ts`**

Add the imports at the top of `stamp.ts`:

```ts
import { placeRunLinks, type RunLinkBox } from './runlink.js';
```

Add this helper immediately after `segmentBoxes`:

```ts
/** The clickable boxes for a laid run block: one per (linked run, line).
 *
 *  The vertical extent is the run's own text-tight box — `vmetricsFor` scaled by
 *  the RUN's fontSize, not the block's — which is exactly the rect the
 *  `background` decoration paints. One geometry rule, so a link's clickable area
 *  and its underline cannot drift apart. */
function runLinkBoxes(boxes: SegmentBox[], runs: ResolvedRun[]): RunLinkBox[] {
  const out: RunLinkBox[] = [];
  for (const b of boxes) {
    const r = runs[b.run];
    if (r.link === undefined) continue;
    const vm = vmetricsFor(r.font);
    const size = r.layout.fontSize;
    out.push({
      uri: r.link,
      rect: [b.x, b.baseline + vm.descent * size, b.x + b.width, b.baseline + vm.ascent * size],
    });
  }
  return out;
}
```

The link boxes need the same first-line baseline `buildRunBlockBody` computes.
Extract that arithmetic rather than repeating it — a second copy is how the ink
and the annotation come to disagree about where line 0 sits. Add above
`buildRunBlockBody`:

```ts
/** The first line's baseline for a block of `lineCount` lines in [y, y+h].
 *  Shared by the emitter and the link-box builder so the ink and the annotation
 *  cannot disagree about where line 0 sits. */
function firstBaseline(
  y: number, h: number, lineCount: number, o: NormalizedBlockOptions,
): number {
  const blockHeight = lineCount * o.leading;
  const valignOffset = o.valign === 'center' ? (h - blockHeight) / 2
    : o.valign === 'bottom' ? h - blockHeight : 0;
  return (y + h - valignOffset) - o.fontSize;
}
```

Replace `buildRunBlockBody`'s own three lines computing `baseline0` with:

```ts
  const baseline0 = firstBaseline(y, h, lines.length, o);
```

Then, in `flowTextBlock`'s runs branch, inside the existing
`if (lines.length > 0) { ... }` block and **after** the `put(...)` call, add:

```ts
      // After the ink, so the annotation lands on content that exists.
      // measureTextBlock, the dry run, never reaches here — which is what keeps
      // measurement free of side effects.
      const linkBoxes = runLinkBoxes(
        segmentBoxes(lines, x, w, firstBaseline(y, h, lines.length, ro), ro), resolved);
      if (linkBoxes.length > 0) placeRunLinks(doc, page, linkBoxes);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/rich-runs-link.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean. No content bytes changed, so `test/rich-runs-identity.test.ts` stays green.

```bash
git add src/runlink.ts src/stamp.ts test/rich-runs-link.test.ts
git commit -m "$(cat <<'EOF'
feat(text): place /Link annotations over linked runs

A link rect is the run's text-tight box — vmetricsFor scaled by the RUN's own
fontSize, the same geometry the background decoration paints — so a link's
clickable area and its underline read one rule. flowTextBlock is the single call
site, so flow paragraphs, page.AddTextBlock and table cells all get it, while
measureTextBlock stays side-effect free.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Markdown links end to end

**Files:**
- Modify: `src/mdruns.ts` (`InlineState`, `stateKey`, `runProps`, the `'link'` case)
- Test: `test/markdown-links.test.ts` (create)

**Interfaces:**
- Consumes: `TextRun.link` (Task 1), `placeRunLinks` (Task 3).
- Produces: nothing new; `inlineRuns` now sets `link`.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const render = (src: string, opts = {}) => {
  const doc = Document.New();
  const flow = doc.NewFlow({ format: PageFormat.A4 });
  const res = flow.AddMarkdown(src, opts);
  const pages = flow.Render();
  return { doc, pages, res };
};

const linksOf = (p: { Annotations: { Subtype: string }[] }) =>
  p.Annotations.filter((a) => a.Subtype === 'Link') as unknown as
    { Rect: number[]; Action?: { type: string; uri?: string } }[];

describe('Markdown links', () => {
  it('places a /URI annotation for an inline link', () => {
    const { pages } = render('See [the docs](https://example.com/docs) today.');
    const links = linksOf(pages[0]);
    expect(links.length).toBe(1);
    expect(links[0].Action).toEqual({ type: 'uri', uri: 'https://example.com/docs' });
  });

  it('links a reference link the same way', () => {
    const { pages } = render('See [the docs][d].\n\n[d]: https://example.com/ref');
    expect(linksOf(pages[0])[0].Action?.uri).toBe('https://example.com/ref');
  });

  it('gives two links in one paragraph their own destinations', () => {
    const { pages } = render('[one](https://a.example) and [two](https://b.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('keeps adjacent links apart', () => {
    // No separating text at all: the two runs must not merge into one.
    const { pages } = render('[one](https://a.example)[two](https://b.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://a.example', 'https://b.example']);
  });

  it('links a GFM autolink', () => {
    const { pages } = render('visit www.example.com now', { gfm: true });
    expect(linksOf(pages[0]).length).toBe(1);
  });

  it('links inside a heading and inside a list item', () => {
    const { pages } = render('# See [docs](https://h.example)\n\n- and [more](https://l.example)');
    expect(linksOf(pages[0]).map((l) => l.Action?.uri).sort())
      .toEqual(['https://h.example', 'https://l.example']);
  });

  it('renders an empty destination as styled text and reports it', () => {
    const { pages, res } = render('an [empty]() link');
    expect(linksOf(pages[0]).length).toBe(0);
    expect(res.skipped).toEqual(['link']);
    expect(pages[0].GetText()).toContain('empty');
  });

  it('keeps the link when a paragraph paginates across columns', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    // Fill most of column 1 so the linked paragraph straddles the break.
    flow.AddMarkdown(`${'filler paragraph text. '.repeat(120)}\n\n`
      + `${'body '.repeat(200)}[the link](https://example.com) ${'tail '.repeat(200)}`);
    const pages = flow.Render();
    const all = pages.flatMap((p) => linksOf(p));
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.every((l) => l.Action?.uri === 'https://example.com')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-links.test.ts`
Expected: FAIL — no annotations are placed; `skipped` does not contain `'link'`.

- [ ] **Step 3: Carry the destination in `src/mdruns.ts`**

Change `InlineState.link` from a flag to the destination:

```ts
interface InlineState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  /** The destination in force, or undefined outside a link. */
  link: string | undefined;
}

const START: InlineState = {
  bold: false, italic: false, code: false, strike: false, link: undefined,
};
```

Fold the destination into the merge key — two adjacent links to different
places must stay two runs, or the first destination is lost and the whole
phrase points at the second:

```ts
const stateKey = (s: InlineState): string =>
  `${+s.bold}${+s.italic}${+s.code}${+s.strike} ${s.link ?? ''}`;
```

In `runProps`, replace the `if (s.link)` block:

```ts
  if (s.link !== undefined) {
    r.color = style.link.color;
    if (style.link.underline) r.underline = true;
    // An empty destination (CommonMark accepts `[text]()`) styles but does not
    // link: a /URI pointing nowhere is worse than no annotation. `inlineRuns`
    // reports it.
    if (s.link !== '') r.link = s.link;
  }
```

Change `runProps`' signature to take the `skipped` list is NOT needed — report from the walk instead. In the `'link'` case:

```ts
        case 'link':
          if (n.destination === '') skipped.push('link');
          walk(n.children, { ...s, link: n.destination });
          break;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-links.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdruns.ts test/markdown-links.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): links become /URI annotations

InlineState carries the destination rather than a flag, and stateKey folds it
in: two adjacent links to different places must stay two runs, or the first
destination is lost and the whole phrase points at the second. An empty
destination styles but does not link, and names itself in skipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: MCID splitting around link runs

**Files:**
- Modify: `src/stamp.ts` (`buildRunBlockBody`, `flowTextBlock`'s runs branch)
- Test: `test/rich-runs-link-tagged.test.ts` (create)
- Test: `test/rich-runs-identity.test.ts` (append one case)

**Interfaces:**
- Consumes: `SegmentBox` (Task 2), `runLinkBoxes` (Task 3).
- Produces: `buildRunBlockBody` gains a `linkMcids: (number | undefined)[]` parameter — one entry per `SegmentBox`, `undefined` for a segment that is not inside a link. `RunLinkBox` gains `mcid?: number`.

- [ ] **Step 1: Write the failing test**

Create `test/rich-runs-link-tagged.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

describe('link marked content', () => {
  it('wraps a linked run in its own /Span BDC ... EMC', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    page.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }],
      [50, 500, 300, 200], { tag: p },
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    // The paragraph's own sequence, and a nested one for the link.
    expect(body).toContain('/P <</MCID 0>> BDC');
    expect(body).toContain('/Span <</MCID 1>> BDC');
  });

  it('emits no /Span when no run carries a link', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    page.AddTextBlock([{ text: 'plain' }, { text: 'bold' }], [50, 500, 300, 200], { tag: p });
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('/Span');
  });

  it('emits no /Span for a linked run in an UNTAGGED block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'the site', link: 'https://example.com' }], [50, 500, 300, 200],
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('BDC');
    // The annotation is still placed.
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rich-runs-link-tagged.test.ts`
Expected: FAIL on the first case — no `/Span` is emitted.

- [ ] **Step 3: Thread the MCIDs through `buildRunBlockBody`**

Add the parameter:

```ts
function buildRunBlockBody(
  lines: LaidLine[], runs: ResolvedRun[], fontKeys: string[],
  x: number, y: number, w: number, h: number,
  o: NormalizedBlockOptions, gsKey: string | undefined,
  boxes: SegmentBox[], linkMcids: (number | undefined)[],
): Uint8Array {
```

Replace the `segmentBoxes`/`runDecorOps` lines with a use of the passed `boxes`:

```ts
  const baseline0 = firstBaseline(y, h, lines.length, o);
  const dec = runDecorOps(boxes, runs);
```

In the per-segment emission loop, wrap a segment whose MCID is defined. The loop currently walks `lines[i].segments`; it needs a running index into `boxes`/`linkMcids`, which are in the same order:

```ts
  let segIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    // ... existing Tw / Td emission, unchanged ...
    for (const seg of line.segments) {
      const mcid = linkMcids[segIdx++];
      // A nested marked-content sequence inside BT/ET is legal (32000-1 14.6),
      // and is what puts the link's words INSIDE its /Link element rather than
      // leaving the element text-less.
      if (mcid !== undefined) s += `/Span <</MCID ${mcid}>> BDC\n`;
      // ... existing Tf / rg / Tj emission for this segment, unchanged ...
      if (mcid !== undefined) s += 'EMC\n';
    }
  }
```

- [ ] **Step 4: Allocate the MCIDs in `flowTextBlock`**

The MCIDs must be allocated against the same element the block tags into, and
only when the block is tagged. In `flowTextBlock`'s runs branch, replace the
body of `if (lines.length > 0) { ... }` with:

```ts
    if (lines.length > 0) {
      const fontKeys = resolved.map((r) => registerFont(doc, page, r.font));
      const gsKey = ro.opacity < 1 ? registerExtGState(doc, page, ro.opacity) : undefined;
      const boxes = segmentBoxes(lines, x, w, firstBaseline(y, h, lines.length, ro), ro);
      // An untagged block allocates nothing and emits no BDC, so its bytes are
      // exactly what they were before links existed.
      const tag = options.artifact ? undefined : options.tag;
      const linkMcids = boxes.map((b) =>
        tag !== undefined && resolved[b.run].link !== undefined
          ? allocContentMcid(doc, tag, page)
          : undefined);
      const bodyBytes = buildRunBlockBody(
        lines, resolved, fontKeys, x, y, w, h, ro, gsKey, boxes, linkMcids);
      put(doc, page, markContent(doc, page, options, rotateBody(bodyBytes, ro.rotate, x, y)));
      const linkBoxes: RunLinkBox[] = [];
      boxes.forEach((b, i) => {
        const r = resolved[b.run];
        if (r.link === undefined) return;
        const vm = vmetricsFor(r.font);
        const size = r.layout.fontSize;
        linkBoxes.push({
          uri: r.link,
          rect: [b.x, b.baseline + vm.descent * size, b.x + b.width, b.baseline + vm.ascent * size],
          mcid: linkMcids[i],
        });
      });
      if (linkBoxes.length > 0) placeRunLinks(doc, page, linkBoxes);
    }
```

Delete the now-unused `runLinkBoxes` helper from Task 3 — its logic moved inline
so it can pair each box with its MCID by index.

Add `mcid?: number` to `RunLinkBox` in `src/runlink.ts`:

```ts
export interface RunLinkBox {
  uri: string;
  rect: [number, number, number, number];
  /** The marked-content id of this box's glyphs, when the block is tagged.
   *  Task 6 hangs the /Link element's /K on it. */
  mcid?: number;
}
```

Ensure `allocContentMcid` is imported in `stamp.ts`:

```ts
import { allocContentMcid } from './structwrite.js';
```

**Ordering note:** `markContent` allocates the *block's* MCID, and the link
MCIDs are allocated before it. That makes the block `/P` MCID 1 and the link
MCID 0, which is legal (MCIDs are identifiers, not an order) but reads badly in
a dump. Allocate the block's MCID first by hoisting it: call
`allocContentMcid(doc, tag, page)` for the block before the `boxes.map`, and
pass the number into `markContent` — change `markContent` to accept an optional
pre-allocated mcid:

```ts
function markContent(
  doc: Document, page: Page, options: StampOptions | TextBlockOptions, body: Uint8Array,
  mcid?: number,
): Uint8Array {
  if (options.artifact) return wrapArtifact(body);
  return options.tag
    ? wrapMarkedContent(options.tag.Type, mcid ?? allocContentMcid(doc, options.tag, page), body)
    : body;
}
```

and in the runs branch allocate `const blockMcid = tag ? allocContentMcid(doc, tag, page) : undefined;`
before `linkMcids`, then pass it: `markContent(doc, page, options, ..., blockMcid)`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/rich-runs-link-tagged.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Extend the byte-identity fence**

Append to `test/rich-runs-identity.test.ts`, following the existing cases' style
(hash the emitted page bytes):

```ts
  it('a run list carrying no link emits unchanged bytes', () => {
    // The BDC/EMC split must fire ONLY for runs with a link. This is the fence
    // between the link feature and every existing rich-run caller.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' }, { text: ' tail' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('BDC');
    expect(body).not.toContain('EMC');
  });
```

- [ ] **Step 7: Confirm the fence is load-bearing**

Temporarily change the `linkMcids` map to allocate unconditionally
(`tag !== undefined ? allocContentMcid(...) : undefined`) and re-run
`npx vitest run test/rich-runs-identity.test.ts`. Expected: red. Restore.

- [ ] **Step 8: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/stamp.ts src/runlink.ts test/rich-runs-link-tagged.test.ts test/rich-runs-identity.test.ts
git commit -m "$(cat <<'EOF'
feat(text): mark a linked run's glyphs with their own MCID

A nested /Span BDC inside BT/ET is what puts the link's words INSIDE the /Link
element rather than leaving the element text-less, which is the difference
between a screen reader announcing the link and announcing nothing. Fires only
for runs carrying a link, so every existing rich-run caller's bytes are
unchanged — fenced by rich-runs-identity and confirmed to go red without the
guard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: the `/Link` structure element

**Files:**
- Modify: `src/runlink.ts` (`placeRunLinks` takes the parent element)
- Modify: `src/stamp.ts` (pass `tag` through)
- Test: `test/rich-runs-link-tagged.test.ts` (append)

**Interfaces:**
- Consumes: `RunLinkBox.mcid` (Task 5).
- Produces:
  ```ts
  export function placeRunLinks(
    doc: Document, page: Page, boxes: RunLinkBox[], parent?: StructElement,
  ): LinkAnnotation[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/rich-runs-link-tagged.test.ts`:

```ts
import type { StructElement } from '../src/struct.js';

/** Collect every element of `type` in the tree. The tree is cyclic (kids link
 *  back to parents), so it must be walked rather than serialized. */
const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('/Link structure', () => {
  it('creates a /Link under the tagged element, holding the annotation', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const p = doc.CreateStructTree().Append('P');
    page.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }],
      [50, 500, 300, 200], { tag: p },
    );
    const links = collect(doc, 'Link');
    expect(links.length).toBe(1);
    // The annotation is named by an /OBJR under the /Link.
    const annot = page.Annotations.filter((a) => a.Subtype === 'Link')[0];
    expect(annot.Dict.get('StructParent')).toBeDefined();
  });

  it('gives a wrapped link ONE /Link element with several MCIDs', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const p = doc.CreateStructTree().Append('P');
    page.AddTextBlock(
      [{ text: 'lead in ' },
       { text: 'a very long link label that must wrap across two lines here',
         link: 'https://example.com' }],
      [50, 300, 120, 300], { fontSize: 12, tag: p },
    );
    // Several rects, one element per rect is WRONG; the run is one link.
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBeGreaterThan(1);
    expect(collect(doc, 'Link').length).toBe(1);
  });

  it('creates no /Link element for an untagged block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([{ text: 'x', link: 'https://example.com' }], [50, 500, 300, 200]);
    expect(doc.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/rich-runs-link-tagged.test.ts`
Expected: FAIL — no `/Link` elements exist.

- [ ] **Step 3: Extend `placeRunLinks` in `src/runlink.ts`**

```ts
import type { StructElement } from './struct.js';
import { appendContentKid } from './structwrite.js';

/** Place a /Link over each box, and — when `parent` is given — a single /Link
 *  structure element holding every box's marked content plus the annotations.
 *
 *  ONE element per destination-run, not per box: a link broken across a line
 *  break is one link, and two elements would have a screen reader announce it
 *  twice. Boxes sharing a `uri` and arriving consecutively are one run, which is
 *  the grouping `stamp.ts` produces.
 *
 *  `border: 0` because the text style already draws the underline; a
 *  viewer-drawn frame on top would be a second, uglier one. */
export function placeRunLinks(
  doc: Document, page: Page, boxes: RunLinkBox[], parent?: StructElement,
): LinkAnnotation[] {
  const out: LinkAnnotation[] = [];
  let group: { uri: string; elem: StructElement } | undefined;
  for (const b of boxes) {
    if (!(b.rect[2] > b.rect[0]) || !(b.rect[3] > b.rect[1])) continue;
    const annot = addLink(doc, page, {
      rect: b.rect, action: { type: 'uri', uri: b.uri }, border: 0,
    });
    out.push(annot);
    if (parent === undefined) continue;
    if (group === undefined || group.uri !== b.uri)
      group = { uri: b.uri, elem: parent.Append('Link') };
    // The glyphs first, then the annotation: /K order is reading order, and the
    // words are what a reader encounters before the link target.
    if (b.mcid !== undefined)
      appendContentKid(doc, group.elem.Dict, b.mcid, doc.pageRef(page.Number));
    group.elem.AddAnnotation(annot);
  }
  return out;
}
```

If `appendContentKid` is not exported from `structwrite.ts`, export it (it is
already used internally by `allocContentMcid`).

**Note on the MCID:** Task 5's `allocContentMcid(doc, tag, page)` already
appended the MCID to the *paragraph's* `/K` and registered it in the parent
tree against the paragraph. That is wrong for a link MCID — it belongs to the
`/Link`. Replace the allocation in `stamp.ts` with a raw one that does not
append to the paragraph. Add to `structwrite.ts`:

```ts
/** Reserve a marked-content id on `page` against `element` WITHOUT appending it
 *  to that element's /K — for a caller that will attach the kid itself, in an
 *  order only it knows. `allocContentMcid` is the ordinary form. @internal */
export function reserveContentMcid(doc: Document, element: StructElement, page: Page): number {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag content to an element with no ref');
  const arr = pageMcidArray(doc, element.Root.Dict, page);
  const mcid = arr.length;
  arr.push(elemRef);
  doc.markModified();
  return mcid;
}
```

and in `stamp.ts` change the `linkMcids` map to call `reserveContentMcid` rather
than `allocContentMcid`, importing it. **The reserved MCID must then be
registered against the `/Link`, not the paragraph** — so after
`group.elem.Append`, rewrite the parent-tree entry:

```ts
    if (b.mcid !== undefined) {
      retargetMcid(doc, group.elem, page, b.mcid);
      appendContentKid(doc, group.elem.Dict, b.mcid, doc.pageRef(page.Number));
    }
```

with, in `structwrite.ts`:

```ts
/** Point `page`'s parent-tree entry for `mcid` at `element`. Used when the
 *  reserving element and the owning element differ — a link's glyphs are
 *  reserved against the paragraph being laid out and owned by its /Link.
 *  @internal */
export function retargetMcid(
  doc: Document, element: StructElement, page: Page, mcid: number,
): void {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot retarget to an element with no ref');
  pageMcidArray(doc, element.Root.Dict, page)[mcid] = elemRef;
  doc.markModified();
}
```

- [ ] **Step 4: Pass the parent through in `src/stamp.ts`**

Change the call to:

```ts
      if (linkBoxes.length > 0) placeRunLinks(doc, page, linkBoxes, tag);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/rich-runs-link-tagged.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/runlink.ts src/structwrite.ts src/stamp.ts test/rich-runs-link-tagged.test.ts
git commit -m "$(cat <<'EOF'
feat(text): a /Link structure element per linked run

One element per destination-run, not per rect: a link broken across a line break
is one link, and two elements would have a screen reader announce it twice. The
glyphs' MCID is reserved against the block being laid out and retargeted onto
the /Link, since the reserving element and the owning element differ.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — the table half (Tasks 7-12)

### Task 7: table cells hold runs — the measure path

**Files:**
- Modify: `src/tableauthor.ts` (`CellBuilder`, `RowBuilder.addCell`, `TableBuilder.addRow`, `measure`)
- Test: `test/table-cell-runs.test.ts` (create)

**Interfaces:**
- Consumes: `TextRun` (Task 1).
- Produces: `CellBuilder.text: string | TextRun[]`;
  `RowBuilder.addCell(text?: string | TextRun[], opts?: CellOptions): CellBuilder`;
  `TableBuilder.addRow(cells?: (string | TextRun[])[], opts?: RowOptions): RowBuilder`.
  `TableMetrics.cellLines` stays `string[][][]` — `LaidLine.text` is a string
  either way.

- [ ] **Step 1: Write the failing test**

Create `test/table-cell-runs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import type { TextRun } from '../src/textdecor.js';

describe('table cells holding runs', () => {
  it('measures a run cell the same as the equivalent string', () => {
    const asString = createTable({ fontSize: 12 });
    asString.addRow(['hello world']);
    const asRuns = createTable({ fontSize: 12 });
    asRuns.addRow().addCell([{ text: 'hello ' }, { text: 'world' }] as TextRun[]);
    expect(asRuns.measure([200]).rowHeights).toEqual(asString.measure([200]).rowHeights);
  });

  it('reports the wrapped line texts of a run cell', () => {
    const t = createTable({ fontSize: 12 });
    t.addRow().addCell([{ text: 'alpha ' }, { text: 'beta' }] as TextRun[]);
    expect(t.measure([200]).cellLines[0][0]).toEqual(['alpha beta']);
  });

  it('accounts for a larger run when computing the row height', () => {
    const small = createTable({ fontSize: 12 });
    small.addRow().addCell([{ text: 'x' }] as TextRun[]);
    const wrapped = createTable({ fontSize: 12 });
    // A long bold run in a narrow column must wrap to more lines.
    wrapped.addRow().addCell(
      [{ text: 'a rather long stretch of text ', font: 'Helvetica-Bold' as const },
       { text: 'and more still' }] as TextRun[]);
    expect(wrapped.measure([80]).rowHeights[0])
      .toBeGreaterThan(small.measure([80]).rowHeights[0]);
  });

  it('rejects a malformed run before measuring', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'ok' }, { text: 'bad', link: '' }] as TextRun[]);
    expect(() => t.measure([200])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-cell-runs.test.ts`
Expected: FAIL — `addCell` rejects the array at the type level and `measure`
calls `layoutText` with it.

- [ ] **Step 3: Widen the types in `src/tableauthor.ts`**

Add the import:

```ts
import { isTextRunList, type TextRun } from './textdecor.js';
import { layoutRuns } from './layout.js';
```

`CellBuilder`:

```ts
  constructor(
    public text: string | TextRun[],
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
    readonly header?: CellHeader,
  ) {}
```

`RowBuilder.addCell`:

```ts
  /** Append a cell. `text` may be a plain string or a {@link TextRun} list,
   *  which renders the same inline vocabulary a paragraph does — mixed fonts,
   *  sizes, colours, decorations and links. */
  addCell(text: string | TextRun[] = '', opts: CellOptions = {}): CellBuilder {
```

`TableBuilder.addRow`:

```ts
  addRow(cells?: (string | TextRun[])[], opts: RowOptions = {}): RowBuilder {
```

- [ ] **Step 4: Branch `measure` onto the runs path**

Replace the `const res = layoutText(cell.text, ...)` line with:

```ts
        // Runs measure through layoutRuns, the SAME engine layoutText wraps, so
        // a cell's height cannot disagree with what the renderer will draw.
        const res = isTextRunList(cell.text)
          ? layoutRuns(
            cell.text.map((r) => ({
              text: r.text,
              driver: measuringDriverFor(r.font ?? st.font),
              fontSize: r.fontSize ?? st.fontSize,
            })),
            innerWidth, Infinity, st.leading)
          : layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
```

Validation of the runs themselves happens in `resolveRuns` at draw time, which
the fourth test exercises through `measure` — so add an explicit pre-check in
the runs branch, before the `layoutRuns` call:

```ts
        if (isTextRunList(cell.text)) {
          for (let i = 0; i < cell.text.length; i++) {
            const r = cell.text[i];
            if (typeof r?.text !== 'string')
              throw new TypeError(`cell run ${i}: text must be a string`);
            if (r.link !== undefined && (typeof r.link !== 'string' || r.link === ''))
              throw new TypeError(`cell run ${i}: link must be a non-empty string`);
          }
        }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/table-cell-runs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Note `src/tablerender.ts` will not typecheck yet if `Placed.text` is still
`string`; widen it in the same commit to `string | TextRun[]` and let
`stampTextBlock`'s existing overload take it (Task 8 tests the painted result):

```ts
interface Placed {
  x: number; bottom: number; w: number; h: number;
  text: string | TextRun[]; style: ResolvedStyle;
  ...
}
```

and narrow at the `stampTextBlock` call in `paintPlaced` exactly as `page.ts`
does — two identical arms, because a `string | TextRun[]` argument matches
neither overload:

```ts
  for (const p of placed) {
    const rect: [number, number, number, number] = [
      p.x + p.style.padding.left, p.bottom + p.style.padding.bottom,
      p.w - p.style.padding.left - p.style.padding.right,
      p.h - p.style.padding.top - p.style.padding.bottom,
    ];
    const opts = {
      font: p.style.font, fontSize: p.style.fontSize, leading: p.style.leading,
      color: p.style.color, align: p.style.align, valign: p.style.valign,
      underline: p.style.underline, strikethrough: p.style.strikethrough,
      background: p.style.textBackground, tag: p.struct,
    };
    if (isTextRunList(p.text)) stampTextBlock(doc, page, p.text, rect, opts);
    else stampTextBlock(doc, page, p.text, rect, opts);
  }
```

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/tableauthor.ts src/tablerender.ts test/table-cell-runs.test.ts
git commit -m "$(cat <<'EOF'
feat(table): cells may hold TextRun[]

Runs measure through layoutRuns, the same engine layoutText wraps, so a cell's
computed height cannot disagree with what the renderer draws. Both consumers
already had the arm they needed since gl6o.3.1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: styled and linked cells actually render

**Files:**
- Test: `test/table-cell-runs.test.ts` (append)

No source change is expected — Task 7 wired the paint path. This task proves it,
including that links inside cells come free from Phase 1. If a test fails, fix
`src/tablerender.ts` and note what was wrong.

**Interfaces:**
- Consumes: Task 7's widened `Placed.text`, Task 3's link placement.

- [ ] **Step 1: Write the test**

Append to `test/table-cell-runs.test.ts`:

```ts
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

describe('rendering a run cell', () => {
  const draw = (cell: TextRun[]) => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable({ fontSize: 12 });
    t.addRow().addCell(cell);
    page.AddTable(t, 50, 700, { width: 300 });
    return { doc, page };
  };

  it('draws the cell text', () => {
    const { page } = draw([{ text: 'hello ' }, { text: 'world' }]);
    expect(page.GetText()).toContain('hello world');
  });

  it("uses each run's own font", () => {
    const { page } = draw([
      { text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' },
    ]);
    const names = new Set(page.GetTextFragments().map((f) => f.fontName));
    expect([...names].some((n) => n?.includes('Bold'))).toBe(true);
    expect([...names].some((n) => n && !n.includes('Bold'))).toBe(true);
  });

  it('places a /Link for a linked cell run', () => {
    const { page } = draw([
      { text: 'see ' }, { text: 'docs', link: 'https://example.com' },
    ]);
    const links = page.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
  });

  it('leaves a string cell byte-identical to before', () => {
    const a = Document.New();
    const pa = a.AddPage(PageFormat.A4).page;
    const ta = createTable({ fontSize: 12 });
    ta.addRow(['plain text']);
    pa.AddTable(ta, 50, 700, { width: 300 });
    // A string cell must not take the runs branch anywhere.
    expect(Buffer.from(a.Save()).toString('latin1')).not.toContain('BDC');
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/table-cell-runs.test.ts`
Expected: PASS (8 tests). If any fail, fix `src/tablerender.ts` and re-run.

- [ ] **Step 3: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add test/table-cell-runs.test.ts src/tablerender.ts
git commit -m "$(cat <<'EOF'
test(table): styled and linked cell runs render

Links inside a cell come free from the run-link path: paintPlaced stamps a cell
through stampTextBlock, which is where placeRunLinks lives.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: extract `paintRowSlice`

**Files:**
- Modify: `src/tablerender.ts` (`drawTable`'s `paintRows` closure, ~line 262)
- Test: `test/table-slice-identity.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export function paintRowSlice(
    doc: Document, page: Page, table: TableBuilder,
    rowIndices: number[], rowHeights: number[], columnX: number[], widths: number[],
    sliceTop: number, x: number, tablePadding: number | undefined,
    outerBorder: BorderInfo | undefined, tagged: boolean, tagger?: TableTagger,
  ): void;
  ```

- [ ] **Step 1: Write the byte-identity test**

Create `test/table-slice-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** The bytes page.AddTable emits, with the trailing xref stripped so object
 *  numbering noise cannot mask a content change. */
const contentOf = (): string => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const t = createTable({
    fontSize: 10,
    border: { width: 0.5, color: [0, 0, 0] },
    background: [0.95, 0.95, 0.95],
  });
  t.addRow(['h1', 'h2']);
  for (let i = 0; i < 5; i++) t.addRow([`a${i}`, `b${i}`]);
  t.setRepeatingRowsCount(1);
  page.AddTable(t, 50, 700, { width: 300 });
  return Buffer.from(doc.Save()).toString('latin1');
};

describe('paintRowSlice extraction', () => {
  it('leaves page.AddTable output unchanged', () => {
    // Recorded from the run BEFORE the extraction. Regenerate deliberately only
    // when a table's ink is meant to change.
    expect(contentOf()).toBe(EXPECTED);
  });
});
```

Generate `EXPECTED` by running the helper *before* touching `drawTable`: add a
temporary `console.log(JSON.stringify(contentOf()))`, run the file, paste the
string in as `const EXPECTED = ...`, remove the log.

- [ ] **Step 2: Run to verify it passes on the unchanged code**

Run: `npx vitest run test/table-slice-identity.test.ts`
Expected: PASS. This is the baseline; it must stay green through Step 4.

- [ ] **Step 3: Extract the closure in `src/tablerender.ts`**

Move `paintRows`' body out of `drawTable` into a module-level export, above
`drawTable`:

```ts
/** Paint the rows named by `rowIndices` with the first row's top at `sliceTop`,
 *  wrapped in one outer-border block.
 *
 *  Exported because `drawTable` (page-positioned, CropBox-driven) and
 *  `flowtable.ts` (column-positioned, rect-driven) both need to put one slice of
 *  rows on a page. Their pagination rules contradict each other; the painting
 *  does not. */
export function paintRowSlice(
  doc: Document, page: Page, table: TableBuilder,
  rowIndices: number[], rowHeights: number[], columnX: number[], widths: number[],
  sliceTop: number, x: number, tablePadding: number | undefined,
  outerBorder: BorderInfo | undefined, tagged: boolean, tagger?: TableTagger,
): void {
  if (rowIndices.length === 0) return;
  let h = 0;
  for (const r of rowIndices) h += rowHeights[r];
  const tableWidth = columnX[widths.length] - x;
  const placed = placeRows(
    table, rowIndices, rowHeights, columnX, widths, sliceTop, tablePadding, tagger);
  paintPlaced(doc, page, placed, outerBorder,
    { x, bottom: sliceTop - h, w: tableWidth, h }, tagged);
}
```

Replace `drawTable`'s closure with a thin wrapper that keeps the lazy tagger
bootstrap (which is `drawTable`'s own rule — a tagged call that draws nothing
must build no structure tree):

```ts
  const paintRows = (pg: Page, rowIndices: number[], sliceTop: number): void => {
    if (rowIndices.length === 0) return;
    if (tagged && tagging.tagger === undefined)
      tagging.tagger = new TableTagger(doc, { structParent: opts.structParent });
    paintRowSlice(doc, pg, table, rowIndices, rowHeights, columnX, widths,
      sliceTop, x, padding, ob, tagged, tagging.tagger);
  };
```

- [ ] **Step 4: Run to verify the bytes did not move**

Run: `npx vitest run test/table-slice-identity.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Confirm the fence is load-bearing**

Temporarily change `sliceTop - h` to `sliceTop - h + 1` in `paintRowSlice` and
re-run. Expected: red. Restore.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/tablerender.ts test/table-slice-identity.test.ts
git commit -m "$(cat <<'EOF'
refactor(table): extract paintRowSlice from drawTable

drawTable is page-positioned and CropBox-driven; a flow element is rect-driven.
Their pagination rules contradict each other, but the painting does not. Pure
extraction, fenced by hashing page.AddTable's bytes and confirmed to go red
under a one-point nudge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `flowtable.ts` and `Flow.AddTable`

**Files:**
- Create: `src/flowtable.ts`
- Modify: `src/flow.ts` (the method, after `AddQuote`)
- Test: `test/flow-table.test.ts` (create)

**Interfaces:**
- Consumes: `paintRowSlice` (Task 9), `TableBuilder` (Task 7), the `FlowElement`
  protocol from `flowelement.ts`.
- Produces:
  ```ts
  export interface FlowTableOptions {
    width?: number; cellPadding?: number;
    spaceBefore?: number; spaceAfter?: number; clear?: FlowClear;
  }
  export function table(t: TableBuilder, o?: FlowTableOptions): FlowElement[];
  ```
  and `Flow.AddTable(t: TableBuilder, o?: FlowTableOptions): this`.

- [ ] **Step 1: Write the failing test**

Create `test/flow-table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import type { StructElement } from '../src/struct.js';

const build = (rows: number) => {
  const t = createTable({ fontSize: 10, border: { width: 0.5, color: [0, 0, 0] } });
  t.addRow(['head A', 'head B']);
  for (let i = 0; i < rows; i++) t.addRow([`a${i}`, `b${i}`]);
  t.setRepeatingRowsCount(1);
  return t;
};

const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('Flow.AddTable', () => {
  it('draws a short table in the flow', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('before');
    flow.AddTable(build(3));
    flow.AddParagraph('after');
    const text = flow.Render()[0].GetText();
    expect(text).toContain('before');
    expect(text).toContain('head A');
    expect(text).toContain('a2');
    expect(text).toContain('after');
  });

  it('splits across pages and repeats the header', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddTable(build(200));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    // Every page carrying table rows carries the header too.
    for (const p of pages) {
      const t = p.GetText();
      if (/\ba1?\d*\b/.test(t)) expect(t).toContain('head A');
    }
  });

  it('splits across columns', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddTable(build(120));
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('head A');
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it('emits one /Table for a table split across pages', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddTable(build(200));
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(collect(doc, 'Table').length).toBe(1);
    expect(collect(doc, 'TH').length).toBeGreaterThan(0);
    expect(collect(doc, 'TD').length).toBeGreaterThan(0);
  });

  it('honours spaceBefore and spaceAfter', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddTable(build(1), { spaceBefore: 40, spaceAfter: 40 });
    flow.AddParagraph('after');
    const frags = flow.Render()[0].GetTextFragments();
    const head = frags.find((f) => f.text.includes('head A'))!;
    const after = frags.find((f) => f.text.includes('after'))!;
    expect(head.quad[1] - after.quad[1]).toBeGreaterThan(60);
  });

  it('rejects a bad option before drawing', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(() => flow.AddTable(build(1), { spaceBefore: -1 })).toThrow(TypeError);
    expect(() => flow.AddTable(build(1), { width: 0 })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-table.test.ts`
Expected: FAIL — `flow.AddTable is not a function`.

- [ ] **Step 3: Create `src/flowtable.ts`**

```ts
/** The table Flow element.
 *
 *  `page.AddTable` is page-positioned: its pagination loop reads the anchor
 *  page's CropBox and appends pages itself. A flow element is handed a rect and
 *  must report an overflow, so the two pagination models cannot be one function
 *  — but the PAINTING can be, and is (`paintRowSlice`).
 *
 *  Nothing here re-derives a table: TableBuilder already owns row measurement,
 *  the `continuationFrom` remainder and repeating headers. */

import type { TableBuilder } from './tableauthor.js';
import type { BorderInfo } from './bordersides.js';
import { paintRowSlice } from './tablerender.js';
import { TableTagger } from './tabletag.js';
import {
  nonNegative, normalizeClear, normalizeSpacing,
  type FlowClear, type FlowElement, type MeasureContext, type PlaceContext, type PlaceResult,
} from './flowelement.js';

/** Options for {@link table} / `Flow.AddTable`. Lengths in points. */
export interface FlowTableOptions {
  /** Total table width. > 0. Default: the full column width. */
  width?: number;
  /** Table-level cell padding override, as `page.AddTable`'s. >= 0. */
  cellPadding?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  clear?: FlowClear;
}

/** Tolerance so a column exactly N rows tall takes N rows despite float drift,
 *  as layout.ts does for lines. */
const EPS = 1e-9;

/** @internal The element behind {@link table}. */
class TableElement implements FlowElement {
  constructor(
    private readonly t: TableBuilder,
    private readonly o: FlowTableOptions,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
    readonly clear?: FlowClear,
    /** Carried across a split so a paginated table stays ONE /Table. */
    private tagger?: TableTagger,
  ) {}

  /** How many leading rows fit in `availHeight`, and their height. */
  private fit(width: number, availHeight: number): { rows: number; height: number } {
    const widths = this.t.resolveColumnWidths(this.o.width ?? width);
    if (widths.length === 0) return { rows: 0, height: 0 };
    const { rowHeights } = this.t.measure(widths, { cellPadding: this.o.cellPadding });
    let rows = 0;
    let height = 0;
    for (const h of rowHeights) {
      if (height + h > availHeight + EPS) break;
      height += h;
      rows++;
    }
    return { rows, height };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { rows, height } = this.fit(ctx.width, ctx.availHeight);
    return { usedHeight: height, fits: rows === this.t.rows.length && rows > 0 };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const totalWidth = this.o.width ?? ctx.width;
    const widths = this.t.resolveColumnWidths(totalWidth);
    if (widths.length === 0) return { usedHeight: 0, remainder: null, drew: false };
    const { rowHeights } = this.t.measure(widths, { cellPadding: this.o.cellPadding });
    const { rows, height } = this.fit(ctx.width, ctx.availHeight);
    // Not one row fits: retry in the next column. The engine throws if this
    // happens at the start of an empty column, exactly as for an oversized image.
    if (rows === 0) return { usedHeight: 0, remainder: this, drew: false };

    if (ctx.structParent !== undefined && this.tagger === undefined)
      this.tagger = new TableTagger(ctx.doc, { structParent: ctx.structParent });

    const columnX: number[] = [ctx.x];
    for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);

    const indices = Array.from({ length: rows }, (_, i) => i);
    paintRowSlice(
      ctx.doc, ctx.page, this.t, indices, rowHeights, columnX, widths,
      ctx.top, ctx.x, this.o.cellPadding,
      this.t.defaults.outerBorder as BorderInfo | undefined,
      ctx.structParent !== undefined, this.tagger);

    if (rows === this.t.rows.length)
      return { usedHeight: height, remainder: null, drew: true };
    return {
      usedHeight: height,
      // continuationFrom prepends the repeating header rows on its own; the
      // continuation carries spaceBefore 0 (already started) and the SAME
      // tagger, which is what keeps a split table one /Table.
      remainder: new TableElement(
        this.t.continuationFrom(rows), this.o, 0, this.spaceAfter, undefined, this.tagger),
      drew: true,
    };
  }
}

/** Build a table element. The builder behind {@link Flow.AddTable}; use it to
 *  compose the `blocks` of a list item or the contents of a block quote.
 *
 *  The table splits by ROW across columns and pages; a row taller than an empty
 *  column reaches the engine's "does not fit in an empty column" error, as any
 *  atomic element does. */
export function table(t: TableBuilder, o: FlowTableOptions = {}): FlowElement[] {
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  if (o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0))
    throw new TypeError('width must be a positive finite number');
  if (o.cellPadding !== undefined) nonNegative(o.cellPadding, 0, 'cellPadding');
  return [new TableElement(t, o, spaceBefore, spaceAfter, normalizeClear(o.clear))];
}
```

`TableBuilder.rows` is already `readonly rows: RowBuilder[] = []`, so no
visibility change is needed.

- [ ] **Step 4: Add the method to `src/flow.ts`**

Import:

```ts
import { table, type FlowTableOptions } from './flowtable.js';
import type { TableBuilder } from './tableauthor.js';
```

Re-export beside the `flowblock.ts` re-exports:

```ts
export { table } from './flowtable.js';
export type { FlowTableOptions } from './flowtable.js';
```

Method, after `AddQuote`:

```ts
  /** Append a table built with `createTable`, paginating by row across columns
   *  and pages. Repeating header rows (`setRepeatingRowsCount`) reprint at the
   *  top of each continuation. Unlike `page.AddTable` this is positioned by the
   *  flow, not by the caller. Chainable. */
  AddTable(t: TableBuilder, options: FlowTableOptions = {}): this {
    this.items.push(...table(t, options));
    return this;
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/flow-table.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/flowtable.ts src/flow.ts test/flow-table.test.ts
git commit -m "$(cat <<'EOF'
feat(flow): Flow.AddTable, a rect-driven table element

TableBuilder already owns row measurement, the continuationFrom remainder and
repeating headers, so the element only decides how many rows fit a column. The
remainder carries the live TableTagger forward, which is what keeps a split
table one /Table rather than two.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: the `table` style group

**Files:**
- Modify: `src/mdstyle.ts` (`MarkdownStyle`, `ResolvedMarkdownStyle`, `resolveMarkdownStyle`)
- Test: `test/markdown-style.test.ts` (append; create if absent)

**Interfaces:**
- Produces:
  ```ts
  MarkdownStyle.table?: {
    border?: { color?: [number, number, number]; thickness?: number };
    headerBackground?: [number, number, number] | false;
    padding?: number;
    fontSize?: number;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  ResolvedMarkdownStyle.table: {
    border: { color: [number, number, number]; thickness: number };
    headerBackground: [number, number, number] | false;
    padding: number; fontSize: number; spaceBefore: number; spaceAfter: number;
  };
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-style.test.ts` (create the file with the imports below
if it does not exist):

```ts
import { describe, it, expect } from 'vitest';
import { resolveMarkdownStyle } from '../src/mdstyle.js';

describe('the table style group', () => {
  it('fills defaults', () => {
    const st = resolveMarkdownStyle({});
    expect(st.table.border.thickness).toBeGreaterThan(0);
    expect(st.table.padding).toBeGreaterThan(0);
    expect(st.table.fontSize).toBe(st.fontSize);
  });

  it('takes overrides', () => {
    const st = resolveMarkdownStyle({ table: { padding: 7, fontSize: 9 } });
    expect(st.table.padding).toBe(7);
    expect(st.table.fontSize).toBe(9);
  });

  it('accepts headerBackground: false', () => {
    expect(resolveMarkdownStyle({ table: { headerBackground: false } }).table.headerBackground)
      .toBe(false);
  });

  it('rejects a bad value before anything is built', () => {
    expect(() => resolveMarkdownStyle({ table: { padding: -1 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ table: { fontSize: 0 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({
      table: { border: { color: [2, 0, 0] } },
    })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-style.test.ts`
Expected: FAIL — `st.table` is undefined.

- [ ] **Step 3: Add the group to `src/mdstyle.ts`**

To `MarkdownStyle`, after `link`:

```ts
  table?: {
    /** Cell and frame rule. Default 0.5pt mid grey. */
    border?: { color?: [number, number, number]; thickness?: number };
    /** Fill behind the header row, or `false` for none. Default a light grey. */
    headerBackground?: [number, number, number] | false;
    /** Padding inside every cell. >= 0. Default 4. */
    padding?: number;
    /** Cell text size. > 0. Default the body `fontSize`. */
    fontSize?: number;
    /** Default 0.6 * fontSize. */ spaceBefore?: number;
    /** Default 0.6 * fontSize. */ spaceAfter?: number;
  };
```

To `ResolvedMarkdownStyle`, after `link`:

```ts
  table: {
    border: { color: [number, number, number]; thickness: number };
    headerBackground: [number, number, number] | false;
    padding: number; fontSize: number; spaceBefore: number; spaceAfter: number;
  };
```

Add the defaults near the other `DEFAULT_*` constants:

```ts
const DEFAULT_TABLE_RULE: [number, number, number] = [0.7, 0.7, 0.7];
const DEFAULT_TABLE_HEADER_FILL: [number, number, number] = [0.93, 0.93, 0.93];
```

`resolveMarkdownStyle` builds each group inline inside its single `return { … }`
and names the resolved body size `fontSize` (a local from
`pos(style.fontSize, 11, 'fontSize')`). Add the group as a sibling of `link`,
inside that returned object:

```ts
    table: {
      border: {
        color: (style.table?.border?.color) === undefined
          ? DEFAULT_TABLE_RULE
          : color(style.table.border.color, 'table.border.color'),
        thickness: pos(style.table?.border?.thickness, 0.5, 'table.border.thickness'),
      },
      headerBackground: fill(style.table?.headerBackground, DEFAULT_TABLE_HEADER_FILL,
        'table.headerBackground'),
      padding: nonNeg(style.table?.padding, 4, 'table.padding'),
      fontSize: pos(style.table?.fontSize, fontSize, 'table.fontSize'),
      spaceBefore: nonNeg(style.table?.spaceBefore, 0.6 * fontSize, 'table.spaceBefore'),
      spaceAfter: nonNeg(style.table?.spaceAfter, 0.6 * fontSize, 'table.spaceAfter'),
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-style.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/mdstyle.ts test/markdown-style.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): the table style group

Validated in full before anything is built, like every other group.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `MdTable` → `TableBuilder`

**Files:**
- Modify: `src/mdflow.ts` (the `'table'` case, imports)
- Test: `test/markdown-tables.test.ts` (create)
- Test: `test/markdown-render.test.ts` (invert the "reports what it skipped" case)

**Interfaces:**
- Consumes: `table` (Task 10), `createTable` (Task 7), `style.table` (Task 11),
  `inlineRuns` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `test/markdown-tables.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';

const SRC = [
  '| Name | Qty |',
  '| :--- | ---: |',
  '| apples | 12 |',
  '| pears | 7 |',
].join('\n');

const render = (src: string, flowOpts = {}, mdOpts = {}) => {
  const doc = Document.New();
  const flow = doc.NewFlow({ format: PageFormat.A4, ...flowOpts });
  const res = flow.AddMarkdown(src, { gfm: true, ...mdOpts });
  return { doc, pages: flow.Render(), res };
};

const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('Markdown tables', () => {
  it('renders a GFM table and reports nothing skipped', () => {
    const { pages, res } = render(SRC);
    expect(res.skipped).toEqual([]);
    const text = pages[0].GetText();
    expect(text).toContain('Name');
    expect(text).toContain('apples');
    expect(text).toContain('12');
  });

  it('renders inline styling and links inside cells', () => {
    const { pages } = render([
      '| a | b |',
      '| - | - |',
      '| **bold** | [docs](https://example.com) |',
    ].join('\n'));
    expect(pages[0].GetText()).toContain('bold');
    const links = pages[0].Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
  });

  it('honours the column alignment', () => {
    const { pages } = render(SRC);
    const frags = pages[0].GetTextFragments();
    const qty = frags.find((f) => f.text.trim() === '12')!;
    const name = frags.find((f) => f.text.includes('apples'))!;
    // The right-aligned column's text ends further right than the left one's.
    expect(qty.quad[2]).toBeGreaterThan(name.quad[2]);
  });

  it('emits /Table /TR /TH /TD under a tagged flow', () => {
    const { doc } = render(SRC, { tagged: true });
    expect(collect(doc, 'Table').length).toBe(1);
    expect(collect(doc, 'TH').length).toBe(2);
    expect(collect(doc, 'TD').length).toBe(4);
  });

  it('repeats the header when a long table splits', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| r${i} | ${i} |`).join('\n');
    const { pages } = render(`| Name | Qty |\n| - | - |\n${rows}`);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const t = p.GetText();
      if (t.includes('r199') || t.includes('r0')) expect(t).toContain('Name');
    }
  });

  it('leaves a table unrendered when gfm is off', () => {
    // Without the extension the source is a paragraph, not a table.
    const { pages, res } = render(SRC, {}, { gfm: false });
    expect(res.skipped).toEqual([]);
    expect(pages[0].GetText()).toContain('Name');
  });

  it('reports no untagged content for a table and a link', () => {
    // UntaggedContent is a `warning`, so it lives in Issues, not Errors. It is
    // the rule the tagging half exists to keep quiet; the rest of PDF/UA (a
    // title, /Lang, …) is gl6o.4's business and is deliberately not asserted.
    const { doc } = render(`${SRC}\n\nSee [docs](https://example.com).`, { tagged: true });
    const untagged = doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent');
    expect(untagged).toEqual([]);
  });

  it('renders through page.AddMarkdown too', () => {
    // The table element is an ordinary FlowElement, so the rect placer gets it
    // with no further work — the three-entry-point property gl6o.3.2 asserted,
    // now exercised on a source containing a table.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = page.AddMarkdown(SRC, [72, 72, 451, 698], { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(res.remainder).toEqual([]);
    expect(page.GetText()).toContain('apples');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-tables.test.ts`
Expected: FAIL — the table is skipped, so no text appears.

- [ ] **Step 3: Map the table in `src/mdflow.ts`**

Add the imports:

```ts
import { createTable } from './tableauthor.js';
import { table } from './flowtable.js';
import type { MdTable } from './mdast.js';
```

Add the builder above `blockToElements`:

```ts
/** A GFM table as a `TableBuilder`.
 *
 *  Cells go through `inlineRuns`, the same function a paragraph uses, so bold,
 *  code spans, strikethrough and links behave identically inside a cell.
 *
 *  Note what `setRepeatingRowsCount` makes unnecessary: `CellOptions.header`
 *  already defaults to "cells in the repeating-header rows are column headers",
 *  so setting `header: 'column'` would restate the documented default. One
 *  statement, not two that can drift apart. */
function mdTable(n: MdTable, c: Ctx) {
  const st = c.st.table;
  const t = createTable({
    fontSize: st.fontSize,
    leading: st.fontSize * 1.2,
    font: c.st.family.regular,
    color: c.st.color,
    padding: st.padding,
    border: { width: st.border.thickness, color: st.border.color },
    outerBorder: { width: st.border.thickness, color: st.border.color },
  });
  const ctx = { family: c.st.family, fontSize: st.fontSize };
  const headerCtx = { family: c.st.heading.family, fontSize: st.fontSize };
  let hasHeader = false;
  for (const row of n.children) {
    if (row.header) hasHeader = true;
    const r = t.addRow(undefined, row.header && st.headerBackground !== false
      ? { background: st.headerBackground }
      : {});
    row.children.forEach((cell, i) => {
      r.addCell(inlineRuns(cell.children, c.st, row.header ? headerCtx : ctx, c.skipped), {
        align: n.align[i] ?? 'left',
      });
    });
  }
  if (hasHeader) t.setRepeatingRowsCount(1);
  return t;
}
```

Replace the `'table'` case:

```ts
    case 'table':
      return table(mdTable(n, c), {
        spaceBefore: c.st.table.spaceBefore + extraBefore,
        spaceAfter: c.st.table.spaceAfter,
      });
```

Every option name above is verified against `src/tableauthor.ts`: `font`,
`fontSize`, `leading`, `color`, `align`, `background` and `padding` are all
`CellTextOptions` fields, which `TableDefaults`, `RowOptions` and `CellOptions`
each extend; `outerBorder` is `TableDefaults`-only; `BorderInfo` is
`{ width, color, dash?, sides? }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-tables.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Invert the stale expectation**

In `test/markdown-render.test.ts`, the "reports what it skipped" case asserts
`['table']`. Replace it:

```ts
  it('renders a table rather than skipping it', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const res = flow.AddMarkdown('a\n\n| x | y |\n| - | - |\n| 1 | 2 |', { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(flow.Render()[0].GetText()).toContain('x');
  });
```

- [ ] **Step 6: Run both files, then typecheck and full suite**

Run: `npx vitest run test/markdown-tables.test.ts test/markdown-render.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/mdflow.ts test/markdown-tables.test.ts test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): render GFM tables

Cells go through inlineRuns, the same function a paragraph uses, so bold, code
spans, strikethrough and links behave identically inside a cell. The header row
sets the repeat count and lets /TH with column scope follow from the documented
default rather than restating it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — surface and documentation (Task 13)

### Task 13: Exports and documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Test: `test/markdown-render.test.ts` (extend the "public surface" case)

- [ ] **Step 1: Write the failing test**

In `test/markdown-render.test.ts`, extend the `public surface` case's name list:

```ts
    for (const name of [
      'paragraph', 'heading', 'list', 'image', 'rule', 'codeBlock', 'quote',
      'placeElements', 'markdownElements', 'resolveMarkdownStyle',
      'table', 'createTable',
    ]) {
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-render.test.ts -t "public surface"`
Expected: FAIL — `table` is undefined.

- [ ] **Step 3: Export from `src/index.ts`**

Beside the existing `flowblock.ts` / `flowplace.ts` exports:

```ts
export { table } from './flowtable.js';
export type { FlowTableOptions } from './flowtable.js';
```

`createTable`, `TableBuilder` and `TextRun` are already exported; verify with
`grep -n "createTable\|TextRun" src/index.ts` and add whichever is missing.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/markdown-render.test.ts -t "public surface"`
Expected: PASS.

- [ ] **Step 5: Update `README.md`**

In **Features**, replace the trailing sentence of the "Markdown to PDF" bullet —
`Tables and links are pending.` — with:

```
Tables and links render too: a GFM table becomes a flow-paginated table with repeating headers, and a link becomes a clickable `/URI` annotation.
```

In the **Flow blocks** bullet, add `table` to the builder list and `AddTable` to
the method list.

In the **Markdown** section of the API overview, add after the "Into a rect"
example:

````markdown
Links and tables need no extra options — a link becomes a `/URI` annotation over
its own words (one per line it wraps onto), and a GFM table paginates across
columns and pages with its header row repeating:

```ts
const { pages } = doc.AddMarkdown(`
See [the docs](https://example.com).

| Name   | Qty |
| :---   | --: |
| apples |  12 |
`, { gfm: true, format: PageFormat.A4 });
```
````

and add these rows to the Markdown member table:

```
| `TextRun.link` | Make a rich-text run a hyperlink; a `/Link` annotation is placed over its laid-out glyphs |
| `flow.AddTable(t, opts?)` / `table(t, opts?)` | A `createTable` table as a flow element, paginating by row across columns and pages |
```

In the API overview's Flow rows, add:

```
| `flow.AddTable(t, opts?)` | Append a `createTable` table, paginated by row across columns and pages (`width`, `cellPadding`, `spaceBefore`/`spaceAfter`/`clear`); repeating headers via `setRepeatingRowsCount` |
```

Under **Limitations**, replace the sentence
`Markdown tables and links are **not yet rendered** — they are reported in `skipped` and contribute their text;`
with:

```
Markdown tables and links render, but a table's columns are always equal fractions of the flow column (GFM declares no widths) and an inline image is still alt text;
```

- [ ] **Step 6: Update `CLAUDE.md`**

Append to the `mdstyle.ts`/`mdruns.ts`/`mdflow.ts` entry:

```markdown
  **Invariant:** a link's destination is part of its run identity. `stateKey`
  folds the URI in, so `[a](x)[b](y)` stays two runs — merge them and the first
  destination is lost and the whole phrase points at the second, which renders
  perfectly and links wrongly.
  **Invariant:** a table cell's inlines go through `inlineRuns`, the same
  function a paragraph uses. A second inline mapper is how a cell comes to render
  bold where a paragraph renders code.
  **Invariant:** the header row sets `setRepeatingRowsCount(1)` and lets `/TH`
  with column scope follow from `CellOptions.header`'s documented default. Saying
  both is two statements that can drift apart.
```

Add a new entry after the `flowelement.ts`/`flowblock.ts`/`flowplace.ts` one:

```markdown
- **runlink.ts**, **flowtable.ts** — the two things `gl6o.3.3` needed and the
  authoring layer lacked. `runlink.ts` turns a laid-out run into a `/Link`
  annotation and its structure element; `flowtable.ts` is the table
  `FlowElement`.
  **Invariant:** a link rect and a text background are ONE geometry —
  `vmetricsFor` scaled by the RUN's own `fontSize`, not the block's. A second
  derivation drifts, and the drift is invisible until someone compares a link's
  clickable area with its underline.
  **Invariant:** a justified line's run positions are not its measured ones.
  `Tw` spreads slack across spaces and the error ACCUMULATES, so a box computed
  from `seg.width` alone marches left of the glyphs, worst for the last run on
  the line. `segmentBoxes` is the single walk that reads the same
  `justifySpacing` the emitter reads — which is why run decoration and link
  rects share it rather than each keeping a copy.
  **Invariant:** ONE `/Link` element per linked run, not per rect. A link broken
  across a line break is one link; two elements have a screen reader announce it
  twice. Its glyphs' MCID is *reserved* against the block being laid out
  (`reserveContentMcid`) and *retargeted* onto the `/Link`, because the
  reserving element and the owning element differ.
  **Invariant:** an untagged block emits no `BDC` at all. The link split fires
  only for runs carrying a link in a tagged block, which is what keeps every
  existing rich-run caller's bytes unchanged — asserted by
  `test/rich-runs-identity.test.ts`, confirmed red without the guard.
  **Invariant:** `page.AddTable` paginates against the page CropBox and a flow
  element against a rect; the two models contradict each other and cannot be one
  function. The PAINTING can be, and is — `paintRowSlice`, shared by both.
  **Invariant:** a split table carries its `TableTagger` forward, which is what
  keeps it one `/Table` rather than one per column.
```

- [ ] **Step 7: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts README.md CLAUDE.md test/markdown-render.test.ts
git commit -m "$(cat <<'EOF'
docs(markdown): export the table element and record the invariants

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing the issue

- [ ] **Run the whole gate one more time**

```bash
npm run typecheck
npm test
```

Both must be green. `test/rich-runs-identity.test.ts` and
`test/table-slice-identity.test.ts` in particular are the two byte-identity
fences this work rests on; each was confirmed to go red under a deliberate
mutation during its own task, and neither may be regenerated to make a failure
go away.

- [ ] **File follow-ups**

```bash
bd create "Markdown: per-column table widths from a style option or an HTML-style attribute" -t task -p 3
bd create "Flow: a link rect includes the separator space owned by the linked run" -t task -p 3
```

The second is the caveat the spec records: the separator space belongs to the
run preceding it, so a link followed by a space gets a rect about one space
wider than its glyphs. Trimming it needs layout to report space ownership.

- [ ] **Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-gl6o.3.3
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

- [ ] **Check whether `gl6o.3` can close**

`gl6o.3.1`, `gl6o.3.2` and `gl6o.3.3` are its only children. If all three are
closed, close `gl6o.3` too, leaving `gl6o.4` as the epic's last child.
