# Over-tall content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an element taller than an empty column renders — scaled if it is an image, overflowing if it is not — instead of refusing the whole document, and every such compromise is reported.

**Architecture:** two optional members on `FlowElement` (`shrinkToFit`, `onCompromise`) and one on `FloatContent` (`onDegraded`). The engine asks for a shrink only where the alternative is refusing the document, falls back to drawing past the column bottom, and reports through bare callbacks — it learns no HTML vocabulary. `cssflow.ts` closes over the `HtmlElement` and maps the callbacks to `NotRendered` records.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-02-float-degrade-report-design.md`

## Global Constraints

- **Import specifiers carry the `.js` extension**, even from `.ts` sources.
- **No new npm runtime dependencies.**
- **`npm run typecheck` and `npm test` must BOTH be green before the issue is closed.** Target one file with `npx vitest run test/<name>.test.ts`.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**, under `## [Unreleased]`, citing `zch2.16`.
- **The engine learns no HTML vocabulary.** `flow.ts`, `flowplace.ts` and `flowelement.ts` must not import `htmlreport.js`, `htmldom.js` or `cssflow.js`. Every report crosses as a bare callback.
- **`shrinkToFit` is asked ONLY where the alternative is refusing the document** — at a column start in `flow.ts`, at the top of an otherwise-empty rect in `flowplace.ts`. Never during ordinary placement.
- **A shrink is accepted only when the replacement actually FITS.** That is the termination proof; one that was still too tall would be asked again at the same column start forever.
- **`FloatingBox` (`src/floatbox.ts`) is edited NOT AT ALL**, for the fourth issue running.
- **Geometry the fixtures depend on:** `Flow`'s default margins are 72 on all four sides (`src/flow.ts:62-68`). On A4 (595 x 842) that is a column **451 pt wide and 698 pt tall**, aspect **1.548**. An image scaled to the column width overflows when its own aspect (h/w) exceeds that.

---

### Task 1: Stop throwing — shrink, else overflow

**Files:**
- Modify: `src/flowelement.ts` (the `FlowElement` interface)
- Modify: `src/flow.ts` (`ImageElement.resolveSize` ~line 1032; the throw at ~line 1569)
- Modify: `src/cssframe.ts` (`BoxElement`, forward `shrinkToFit`)
- Test: `test/flow-overtall.test.ts` (new)

**Interfaces:**
- Produces, relied on by Tasks 2 and 3:
  - `FlowElement.shrinkToFit?(width: number, availHeight: number): FlowElement | undefined`
  - `FlowElement.onCompromise?: (how: 'scaled' | 'overflow') => void` — **not** `readonly`
  - `ImageElement` implements `shrinkToFit`; `BoxElement` (cssframe.ts) forwards it.

- [ ] **Step 1: Write the failing tests**

Create `test/flow-overtall.test.ts`:

```ts
/** Content taller than an empty column renders instead of refusing the
 *  document (zch2.16). Driven from the flow builders, so nothing here needs
 *  the CSS stack. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { image, paragraph } from '../src/flow.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

/** A w x h PNG of flat grey. The ASPECT is the fixture: the default A4 column
 *  is 451 x 698 pt (aspect 1.548), so an image scaled to the column width
 *  overflows it exactly when h/w exceeds that. */
function png(w: number, h: number): Uint8Array {
  return buildPngRgbWith(w, h, new Array(w * h * 3).fill(128), 0);
}

/** The drawn size of the first image on a page: the `w 0 0 h x y cm` that
 *  precedes its `Do`. Reading the content stream is how this suite asserts
 *  emitted geometry (test/flow.test.ts:298 and elsewhere) — `page.Images` can
 *  say an image is PRESENT but says nothing about how big it was drawn, which
 *  is the whole question here. */
function drawnImageSize(page: { Contents: Uint8Array }): [number, number] {
  const content = new TextDecoder('latin1').decode(page.Contents);
  const m = /([\d.]+) 0 0 ([\d.]+) -?[\d.]+ -?[\d.]+ cm\s*\/\w+ Do/.exec(content);
  if (m === null) throw new Error('no image draw found in the content stream');
  return [Number(m[1]), Number(m[2])];
}

describe('an image taller than an empty column', () => {
  it('renders SCALED instead of refusing the document', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements(image(png(9, 16)));
    const pages = flow.Render();
    expect(pages).toHaveLength(1);
    // Scaled, not clipped and not dropped: exactly as tall as the 698pt column
    // and NARROWER than its 451pt, the 9:16 aspect having been preserved.
    // Asserting only "did not throw" passes for a build that drops the image,
    // and asserting only `page.Images.length` passes for one that clips it.
    const [w, h] = drawnImageSize(pages[0]);
    expect(h).toBeCloseTo(698, 0);
    expect(w).toBeCloseTo(698 * 9 / 16, 0);
    expect(w).toBeLessThan(451);
  });

  it('reports the scale through onCompromise', () => {
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const els = image(png(9, 16));
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    flow.Render();
    expect(seen).toEqual(['scaled']);
  });

  it('does NOT shrink an image that merely does not fit what is LEFT', () => {
    // The rule Decision 2 exists for. A 3:4 image fits a column on its own, so
    // one arriving near a column foot must move to the next column at FULL
    // size. A build that shrinks at every place() passes every single-element
    // fixture and fails only this one.
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('filler '.repeat(400));   // most of column 1
    const els = image(png(6, 8));
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    const pages = flow.Render();
    expect(seen).toEqual([]);                    // never compromised
    expect(pages.length).toBeGreaterThan(1);     // it moved instead
  });
});

describe('content that cannot be scaled', () => {
  it('OVERFLOWS the column instead of refusing the document', () => {
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    // One line at 900pt cannot fit a 698pt column and cannot be scaled.
    const els = paragraph('W', { fontSize: 900 });
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    const pages = flow.Render();
    expect(seen).toEqual(['overflow']);
    expect(pages).toHaveLength(1);
    expect(pages[0].GetText()).toContain('W');   // drawn, not dropped
  });

  it('keeps rendering the content AFTER an overflowing element', () => {
    // The overflow must not take the document with it.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements(paragraph('W', { fontSize: 900 }));
    flow.AddParagraph('AFTERWARDS');
    const text = flow.Render().map((p) => p.GetText()).join(' ');
    expect(text).toContain('AFTERWARDS');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-overtall.test.ts`
Expected: FAIL. TypeScript reports `Property 'onCompromise' does not exist on type 'FlowElement'`, and at runtime every case throws `Flow: element does not fit in an empty column (column too short for its content)`.

- [ ] **Step 3: Add the two protocol members**

In `src/flowelement.ts`, inside the `FlowElement` interface, after the existing `float` member:

```ts
  /** Last resort before the engine gives up: return a replacement that fits
   *  `availHeight` at `width`, or `undefined` when this element cannot be
   *  scaled (`zch2.16`).
   *
   *  Asked ONLY where the alternative is refusing the document — at a column
   *  start, or at the top of an otherwise-empty rect. It must NOT be consulted
   *  during ordinary placement: a tall image near a column FOOT has to move to
   *  the next column, not shrink to the gap it happens to find, or a picture's
   *  size depends on what precedes it. */
  shrinkToFit?(width: number, availHeight: number): FlowElement | undefined;
  /** The engine had to compromise to place this element at all (`zch2.16`):
   *  `'scaled'` when it was shrunk to fit, `'overflow'` when it was drawn past
   *  the column bottom.
   *
   *  NOT readonly, and that is deliberate: `cssflow.ts` assigns it after
   *  construction, because the builders are shared with Markdown and
   *  hand-built flows and must not grow an HTML-shaped option. The engine
   *  fires it on the ORIGINAL element before swapping in a replacement, so a
   *  replacement need not carry it. */
  onCompromise?: (how: 'scaled' | 'overflow') => void;
```

- [ ] **Step 4: Clamp the image's height and implement `shrinkToFit`**

In `src/flow.ts`, replace `ImageElement`'s `resolveSize` (currently at ~1030-1041):

```ts
  /** Drawn size for a given region width: default fills the region; an
   *  over-region width clamps down (requested aspect preserved).
   *
   *  `availHeight` is the HEIGHT sibling of that clamp (`zch2.16`), and it
   *  lives here rather than at a second site because one function answers "how
   *  big is this drawn" — two would let them disagree. It defaults to Infinity,
   *  so `measure` and `place` are byte-identical to before; only `shrinkToFit`
   *  passes a real budget, and the engine asks for that solely where the
   *  alternative is refusing the document. */
  private resolveSize(
    regionWidth: number, availHeight = Infinity,
  ): { drawW: number; drawH: number } {
    const baseW = this.reqWidth ?? regionWidth;
    const baseH = this.reqHeight !== undefined && this.reqHeight > 0
      ? this.reqHeight : baseW * (this.ih / this.iw);
    let drawW = baseW;
    let drawH = baseH;
    if (drawW > regionWidth) {
      const factor = regionWidth / drawW;
      drawW = regionWidth;
      drawH *= factor;
    }
    if (drawH > availHeight) {
      const factor = availHeight / drawH;
      drawH = availHeight;
      drawW *= factor;
    }
    return { drawW, drawH };
  }

  /** An image can always be scaled, which is what makes it the one element
   *  type that implements this. The replacement STATES the fitted size, so its
   *  own measure() and place() agree with the engine about what it occupies. */
  shrinkToFit(width: number, availHeight: number): FlowElement | undefined {
    if (!(width > 0) || !(availHeight > 0)) return undefined;
    const { drawW, drawH } = this.resolveSize(width, availHeight);
    if (!(drawW > 0) || !(drawH > 0)) return undefined;
    return new ImageElement(this.built, drawW, drawH, this.align, this.alt,
      this.spaceBefore, this.spaceAfter, this.clear);
  }
```

- [ ] **Step 5: Replace the throw with shrink-then-overflow**

In `src/flow.ts`, replace these two lines (currently ~1568-1570):

```ts
      if (atColumnStart)
        throw new Error('Flow: element does not fit in an empty column (column too short for its content)');
      advanceColumn();
```

with:

```ts
      if (atColumnStart) {
        // Last resort before refusing the document (zch2.16). Asked ONLY here,
        // where availHeight is the whole column: a tall image near a column
        // FOOT must move to the next column rather than shrink to the gap it
        // happens to find.
        const shrunk = item2.shrinkToFit?.(elemWidth, availHeight);
        // Accepted only when the replacement actually FITS. That is the
        // termination proof: one still too tall would be asked again at this
        // same column start, forever.
        if (shrunk !== undefined
          && shrunk.measure?.({ width: elemWidth, availHeight })?.fits === true) {
          item2.onCompromise?.('scaled');
          queue[0] = shrunk;
          continue;
        }
        // Cannot be scaled: draw it at its natural size, overflowing the
        // column, rather than refusing the whole document. Only UNSPLITTABLE
        // content reaches here — a paragraph, a table and (since zch2.15) a
        // float all split — so the overflow is ONE element, never a cascade.
        item2.onCompromise?.('overflow');
        const over = item2.place({
          doc: this.doc, page, x: elemX, top, width: elemWidth,
          availHeight: Infinity,
          paragraphSpacing: g.paragraphSpacing, structParent,
        });
        queue.shift();
        if (over.drew) {
          colTop = top - over.usedHeight;
          atColumnStart = false;
          pendingSpaceAfter = item2.spaceAfter ?? 0;
        }
        continue;
      }
      advanceColumn();
```

`page`, `elemX`, `elemWidth`, `availHeight`, `top`, `g`, `structParent`,
`colTop`, `atColumnStart`, `pendingSpaceAfter` and `queue` are all already in
scope at this point. Calling `place` a second time is safe because this branch
is reached only when `res.drew` was false, so nothing was drawn.

- [ ] **Step 6: Forward `shrinkToFit` through the box decorator**

`cssframe.ts`'s `frameBoxes` wraps every non-float element, so without this the
CSS stack never reaches `ImageElement.shrinkToFit` and every HTML image would
take the overflow path instead of being scaled.

In `src/cssframe.ts`, in `class BoxElement`, after the `keepWithNext` getter:

```ts
  /** Forwarded (`zch2.16`): frameBoxes wraps every non-float element, so
   *  without this the engine's last-resort shrink never reaches the image
   *  inside and an HTML picture overflows where it should scale. The insets
   *  belong to the frame, so the inner element is offered what is left. */
  shrinkToFit(width: number, availHeight: number): FlowElement | undefined {
    const w = this.innerWidth(width);
    const avail = availHeight - this.padTop - this.padBottom;
    if (w <= 0 || avail <= 0) return undefined;
    const shrunk = this.inner.shrinkToFit?.(w, avail);
    if (shrunk === undefined) return undefined;
    return new BoxElement(shrunk, this.frame, this.first, this.last,
      this.spaceBefore, this.spaceAfter, this.clear, this.run);
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/flow-overtall.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Run the neighbouring fences**

Run: `npx vitest run test/flow.test.ts test/flow-float-content.test.ts test/flowfloat.test.ts test/css-float.test.ts test/cssframe.test.ts test/rich-runs-identity.test.ts`
Expected: PASS with no case changed. `resolveSize`'s new parameter defaults to
Infinity, so ordinary placement is byte-identical; a red case here means the
clamp is firing outside the last-resort path.

- [ ] **Step 9: Commit**

```bash
git add src/flowelement.ts src/flow.ts src/cssframe.ts test/flow-overtall.test.ts
git commit -m "fix(zch2.16): content taller than a column renders instead of refusing the document

doc.AddHtml('<img …>') threw for any image whose aspect exceeded the column's
— 9:16, a phone photo held upright. ImageElement.resolveSize clamped WIDTH to
the region and never HEIGHT, so a portrait image scaled to the column width
exceeded the column height and Render refused the whole document.

An image now scales to fit and anything else draws past the column bottom.
Both are asked for ONLY at a column start, where the alternative is refusing
the document: a tall image near a column FOOT still moves to the next column
at full size, or a picture's size would depend on what precedes it. A shrink
is accepted only when the replacement actually fits, which is the termination
proof.

cssframe.ts's decorator forwards the shrink: frameBoxes wraps every non-float
element, so without that an HTML image would overflow where it should scale.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `placeElements` shrinks at the rect top

**Files:**
- Modify: `src/flowplace.ts` (the `!res.drew` tail, currently lines 140-144)
- Test: `test/flow-overtall.test.ts` (append)

**Interfaces:**
- Consumes from Task 1: `FlowElement.shrinkToFit`, `FlowElement.onCompromise`.
- Produces: `placeElements` scales an over-tall element that is first into the
  rect, and still returns it as `remainder` when it cannot be scaled.

- [ ] **Step 1: Write the failing tests**

Append to `test/flow-overtall.test.ts`:

```ts
describe('placeElements with over-tall content', () => {
  it('scales an image too tall for the rect, and leaves NO remainder', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = image(png(9, 16));
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    const res = placeElements(doc, page, els, [50, 50, 400, 300]);
    expect(seen).toEqual(['scaled']);
    expect(res.remainder).toHaveLength(0);
    expect(res.usedHeight).toBeLessThanOrEqual(300 + 1e-9);
  });

  it('does NOT overflow the caller’s rect for content it cannot scale', () => {
    // Decision 5: one rect has a real answer Render does not — `remainder` —
    // so an unscalable element is handed back rather than drawn outside the
    // box the caller asked for.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = placeElements(doc, page, paragraph('W', { fontSize: 900 }),
      [50, 50, 400, 300]);
    expect(res.remainder).toHaveLength(1);
    expect(res.usedHeight).toBe(0);
  });

  it('does NOT shrink an element that merely does not fit what is LEFT', () => {
    // The rect-level twin of Decision 2: after a paragraph has been placed,
    // the element is no longer first into the rect, so it is handed back
    // rather than squeezed into the gap.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = image(png(6, 8));
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    const res = placeElements(doc, page, [...paragraph('filler'), ...els],
      [50, 50, 400, 60]);
    expect(seen).toEqual([]);
    expect(res.remainder).toHaveLength(1);
  });
});
```

Add `placeElements` to the file's imports:

```ts
import { placeElements } from '../src/flowplace.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow-overtall.test.ts`
Expected: the three new cases FAIL — `seen` is `[]` and `remainder` has length
1 in the first, because `placeElements` never asks for a shrink. The second and
third cases PASS already: they pin behaviour Decision 5 keeps.

- [ ] **Step 3: Ask for a shrink at the rect top**

In `src/flowplace.ts`, replace the `!res.drew` tail (currently lines 140-144):

```ts
    // Nothing painted: a null remainder means the element was empty (discard);
    // anything else means it did not fit what is left, and the rect is done.
    if (res.remainder === null) continue;
    if (besideFloat && boundary > y) { top = boundary; i--; continue; }
    return stop(elements.slice(i));
```

with:

```ts
    // Nothing painted: a null remainder means the element was empty (discard);
    // anything else means it did not fit what is left, and the rect is done.
    if (res.remainder === null) continue;
    if (besideFloat && boundary > y) { top = boundary; i--; continue; }
    // Nothing has been placed into this rect yet, so this element cannot be
    // deferred to anywhere: it is the rect-level twin of Render's empty column
    // (zch2.16). Offer the shrink, accepting it only when the replacement
    // actually fits, which is what makes this terminate.
    if (!started) {
      const shrunk = el.shrinkToFit?.(elemWidth, availHeight);
      if (shrunk !== undefined
        && shrunk.measure?.({ width: elemWidth, availHeight })?.fits === true) {
        el.onCompromise?.('scaled');
        elements = [...elements.slice(0, i), shrunk, ...elements.slice(i + 1)];
        i--;
        continue;
      }
    }
    // It cannot be scaled, and unlike Render this caller gave us a RECT and
    // meant it — `remainder` is a real answer, so nothing is drawn outside it.
    return stop(elements.slice(i));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow-overtall.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Run the neighbouring fences**

Run: `npx vitest run test/flowplace-floats.test.ts test/html-render.test.ts test/htmlreport-render.test.ts`
Expected: PASS with no case changed.

- [ ] **Step 6: Commit**

```bash
git add src/flowplace.ts test/flow-overtall.test.ts
git commit -m "fix(zch2.16): placeElements scales an over-tall element at the rect top

The rect-level twin of Render's empty column: with nothing placed yet the
element cannot be deferred anywhere, so the shrink is offered. It is NOT
offered once something has been placed — the element moves on instead, which
is the rect-level form of the rule that a picture's size must not depend on
what precedes it.

Unlike Render, an unscalable element is still handed back as `remainder`
rather than drawn: a caller who gave us a rect meant it, and `remainder` is a
real answer Render does not have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The reports reach the HTML caller

**Files:**
- Modify: `src/htmlreport.ts` (`Construct`, `CONSTRUCTS`)
- Modify: `src/flowfloat.ts` (`elementFloat` takes `onDegraded`)
- Modify: `src/flow.ts`, `src/flowplace.ts` (fire `onDegraded` at the degrade points)
- Modify: `src/cssflow.ts` (`CssFlowOptions.onNotRendered`, widen `makeFloat`, the closures)
- Modify: `src/htmlflow.ts` (`HtmlFlowOptions.onNotRendered`, pass through)
- Modify: `src/document.ts` (`AddHtml`), `src/page.ts` (`AddHtml`)
- Test: `test/htmlreport.test.ts` (the size assertion), `test/css-overtall-report.test.ts` (new)

**Interfaces:**
- Consumes from Tasks 1-2: `FlowElement.onCompromise`, `FlowElement.shrinkToFit`.
- Produces: `HtmlFlowOptions.onNotRendered?: (r: NotRendered) => void`;
  `FloatContent.onDegraded?: () => void`;
  `elementFloat(doc, elements, width, spacing, onDegraded?)`;
  `CssFlowOptions.makeFloat?: (elements, width, spacing, onDegraded?) => FloatContent`.

- [ ] **Step 1: Write the failing tests**

Create `test/css-overtall-report.test.ts`:

```ts
/** What AddHtml reports when the engine had to compromise at PLACEMENT time
 *  (zch2.16) — the phase after building and lowering. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

function png(w: number, h: number): string {
  return Buffer.from(buildPngRgbWith(w, h, new Array(w * h * 3).fill(128), 0))
    .toString('base64');
}
/** 9:16 exceeds the 1.548 column aspect, so it must be scaled to fit. */
const TALL_IMG = `<img src="data:image/png;base64,${png(9, 16)}">`;

describe('doc.AddHtml reports a placement-time compromise', () => {
  it('renders a too-tall image and reports it as scaled', () => {
    const { pages, skipped } = Document.New().AddHtml(TALL_IMG);
    expect(pages).toHaveLength(1);
    expect(skipped.map(describeReport)).toContain('image:scaled-to-fit');
  });

  it('reports an element it could only draw by overflowing', () => {
    const { skipped } = Document.New().AddHtml('<p style="font-size:900px">W</p>');
    expect(skipped.map((r) => r.construct)).toContain('overflow');
  });

  it('reports NOTHING for content that places normally', () => {
    const { skipped } = Document.New().AddHtml('<p>ordinary</p>');
    expect(skipped).toEqual([]);
  });
});

describe('page.AddHtml reports the same', () => {
  it('scales the image and reports it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { skipped, remainder } = page.AddHtml(TALL_IMG, [50, 50, 400, 300]);
    expect(remainder).toHaveLength(0);
    expect(skipped.map(describeReport)).toContain('image:scaled-to-fit');
  });
});

describe('a Flow gets the opt-in sink, and its array never mutates', () => {
  it('fires onNotRendered during Render()', () => {
    const seen: NotRendered[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(TALL_IMG, { onNotRendered: (r) => { seen.push(r); } });
    flow.Render();
    expect(seen.map(describeReport)).toContain('image:scaled-to-fit');
  });

  it('does NOT append to the skipped array it already handed back', () => {
    // Decision 7. A build that pushed into the shared array passes every other
    // case in this file and fails only here.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const { skipped } = flow.AddHtml(TALL_IMG);
    const before = skipped.length;
    flow.Render();
    expect(skipped.length).toBe(before);
  });
});

describe('a float that cannot be floated', () => {
  it('lays out in flow and reports itself', () => {
    // Reachable for the first time: before this issue it threw.
    const src = `<div style="float:left;width:150px"><img src="data:image/png;base64,${png(9, 16)}"></div>`
      + '<p style="margin:0">alpha bravo charlie</p>';
    const { skipped } = Document.New().AddHtml(src);
    expect(skipped.map((r) => r.construct)).toContain('float');
  });

  it('reports ONE record even when the element is retried across columns', () => {
    // Decision 9: after degrading, the element places like any other, and a
    // retry re-enters the float branch. One box is one record.
    const src = `<div style="float:left;width:150px"><img src="data:image/png;base64,${png(9, 16)}"></div>`
      + '<p style="margin:0">alpha bravo charlie</p>';
    const { skipped } = Document.New().AddHtml(src);
    expect(skipped.filter((r) => r.construct === 'float')).toHaveLength(1);
  });
});
```

And in `test/htmlreport.test.ts`, change the size assertion at line 29:

```ts
    expect(CONSTRUCTS.length).toBe(21);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/css-overtall-report.test.ts test/htmlreport.test.ts`
Expected: FAIL. TypeScript reports `'onNotRendered' does not exist in type
'HtmlFlowOptions'`; `CONSTRUCTS.length` is 20; and every report assertion finds
an empty `skipped`.

- [ ] **Step 3: Add the `'overflow'` construct**

In `src/htmlreport.ts`, in the `Construct` union, extend the layout line:

```ts
  // Layout constructs.
  | 'float' | 'image' | 'table' | 'table-cell-blocks' | 'link'
  // Content the engine could only place by drawing it past the column bottom.
  // NOT 'text', which means a glyph the resolved face cannot draw and is shared
  // with svgdraw.ts — an overflowing block drew every character perfectly, and
  // filing it under 'text' would send a caller hunting a font problem.
  | 'overflow'
```

and in `CONSTRUCTS`:

```ts
  'float', 'image', 'table', 'table-cell-blocks', 'link',
  'overflow',
  'text',
```

- [ ] **Step 4: Let `elementFloat` carry `onDegraded`, and fire it**

In `src/flowelement.ts`, in `FloatContent`, after `splitPaint`:

```ts
  /** Called when the engine gives up on floating this and places it in flow
   *  instead (`zch2.16`). Only a degradable float can reach a degrade, and only
   *  a CSS float is degradable, so it never fires for a hand-built flow. */
  readonly onDegraded?: () => void;
```

In `src/flowfloat.ts`, widen `elementFloat`'s signature and store it:

```ts
export function elementFloat(
  doc: Document, elements: FlowElement[], width: number, spacing: number,
  onDegraded?: () => void,
): FloatContent {
  return {
    width,
    spacing,
    degradeOnOverflow: true,
    onDegraded,
```

(the rest of the returned object is unchanged).

In `src/flow.ts`, in the degrade fall-through added by `zch2.15`, immediately
before `if (box.degradeOnOverflow !== true) {`:

```ts
          box.onDegraded?.();
```

In `src/flowplace.ts`, in the float branch, replace the trailing comment:

```ts
      // Will not fit this rect: fall through and place it in flow. The marker
      // rides on a FlowElement, so that costs nothing.
```

with:

```ts
      // Will not fit this rect: fall through and place it in flow. The marker
      // rides on a FlowElement, so that costs nothing.
      fl.content.onDegraded?.();
```

- [ ] **Step 5: Build the closures in `cssflow.ts`**

In `src/cssflow.ts`, add to `interface Ctx` (after `renderSvg`):

```ts
  /** Placement-time reports (`zch2.16`). Separate from `skipped`, which is
   *  handed back at BUILD time — see the spec's Decision 7. */
  onNotRendered?: (r: NotRendered) => void;
```

widen `makeFloat` in both `Ctx` and `CssFlowOptions`:

```ts
  makeFloat?: (
    elements: FlowElement[], width: number, spacing: number,
    onDegraded?: () => void,
  ) => FloatContent;
```

add `onNotRendered` to `CssFlowOptions` with the same type, forward it where
`Ctx` is built (cssflow.ts:664, beside `makeFloat` and `renderSvg`):

```ts
    makeFloat: options.makeFloat, renderSvg: options.renderSvg,
    onNotRendered: options.onNotRendered, containingWidthPx,
```

and in `mapBox`, replace the two lines that build the content and the wrapper:

```ts
  const content = c.makeFloat(els, pt(borderBoxWidth), spacing);
  return [floatElement(els, side, content, spaceBefore, 0)];
```

with:

```ts
  // The engine may call back MORE THAN ONCE for one box: after a float
  // degrades it places like any other element, and a retry in the next column
  // re-enters the float branch. One box is one record, so the de-duplication
  // lives here — the engine must not have to know.
  const once = (r: NotRendered): (() => void) => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      c.onNotRendered?.(r);
    };
  };
  const content = c.makeFloat(els, pt(borderBoxWidth), spacing,
    once({ el: r.box.el, kind: 'degraded', construct: 'float', detail: side }));
  return [floatElement(els, side, content, spaceBefore, 0)];
```

Then, so every non-float element reports its own compromises, add this at the
END of `mapBoxInner`'s caller — in `mapBox`, immediately after
`const els = mapBoxInner(r, spaceBefore, c);`:

```ts
  // The scale and the overflow are decided by the ENGINE, which holds no
  // HtmlElement, and cannot be predicted here: this module knows the container
  // WIDTH and never the column HEIGHT. So the element carries a callback back.
  const scaled = once2(c, { el: r.box.el, kind: 'degraded', construct: 'image', detail: 'scaled-to-fit' });
  const overflowed = once2(c, { el: r.box.el, kind: 'degraded', construct: 'overflow' });
  for (const el of els) {
    el.onCompromise = (how) => { (how === 'scaled' ? scaled : overflowed)(); };
  }
```

with this module-level helper beside `mapBox`:

```ts
/** A one-shot report: the engine may fire a callback more than once for one
 *  box (a retry after a column advance does), and one box is one record. */
function once2(c: Ctx, r: NotRendered): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    c.onNotRendered?.(r);
  };
}
```

and replace the inline `once` above with a call to `once2(c, …)` so there is
ONE de-duplication helper rather than two:

```ts
  const content = c.makeFloat(els, pt(borderBoxWidth), spacing,
    once2(c, { el: r.box.el, kind: 'degraded', construct: 'float', detail: side }));
```

- [ ] **Step 6: Thread the option through `htmlflow.ts`**

In `src/htmlflow.ts`, add to `HtmlFlowOptions`:

```ts
  /** Called for a construct the engine could only place by compromising —
   *  scaling an over-tall image, drawing an element past the column bottom, or
   *  laying a float out in flow (`zch2.16`). These are PLACEMENT-time facts, so
   *  `doc.AddHtml` and `page.AddHtml` fold them into the `skipped` they return
   *  and a caller needs this only for a `Flow`, whose `AddHtml` returns before
   *  `Render` runs. */
  onNotRendered?: (r: NotRendered) => void;
```

and pass both through in `htmlElements`:

```ts
    onNotRendered: options.onNotRendered,
    makeFloat: (els, w, spacing, onDegraded) =>
      elementFloat(doc, els, w, spacing, onDegraded),
```

- [ ] **Step 7: Collect the late records in the two one-call entry points**

In `src/document.ts`, in `AddHtml`, replace:

```ts
    const { skipped, unsupported } = flow.AddHtml(root, options);
    const pages = flow.Render();
```

with:

```ts
    // Placement-time reports (zch2.16). Collected into a LOCAL array and
    // concatenated on the way out, never appended to the array flow.AddHtml
    // already handed back — nothing may mutate under a caller. A caller's own
    // sink still fires.
    const late: NotRendered[] = [];
    const sink = (r: NotRendered): void => {
      late.push(r);
      options.onNotRendered?.(r);
    };
    const { skipped, unsupported } = flow.AddHtml(root, { ...options, onNotRendered: sink });
    const pages = flow.Render();
```

and the return:

```ts
    return { pages, skipped: [...skipped, ...late], unsupported };
```

In `src/page.ts`, in `AddHtml`, replace the body's first two statements:

```ts
    const { elements, skipped, unsupported } =
      htmlElements(this.doc, src, rect[2], options);
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped, unsupported };
```

with:

```ts
    // See Document.AddHtml: a fresh array on the way out, never a mutation of
    // the one htmlElements returned (zch2.16).
    const late: NotRendered[] = [];
    const sink = (r: NotRendered): void => {
      late.push(r);
      options.onNotRendered?.(r);
    };
    const { elements, skipped, unsupported } =
      htmlElements(this.doc, src, rect[2], { ...options, onNotRendered: sink });
    const { usedHeight, remainder } = placeElements(this.doc, this, elements, rect, {
      paragraphSpacing: options.paragraphSpacing,
      structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped: [...skipped, ...late], unsupported };
```

Both files import the type: `import type { NotRendered } from './htmlreport.js';`
(`document.ts` already does; add it to `page.ts` if absent).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/css-overtall-report.test.ts test/htmlreport.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add src/htmlreport.ts src/flowelement.ts src/flowfloat.ts src/flow.ts src/flowplace.ts src/cssflow.ts src/htmlflow.ts src/document.ts src/page.ts test/css-overtall-report.test.ts test/htmlreport.test.ts
git commit -m "feat(zch2.16): report what the engine had to compromise to place

A scaled image, an overflowing block and a float laid out in flow are all
PLACEMENT-time facts, and the existing report is handed back at build time.
doc.AddHtml and page.AddHtml place before they return, so they fold the late
records into a FRESH skipped array; a Flow, whose Add and Render are separate
by design, gets HtmlFlowOptions.onNotRendered. Nothing mutates under a caller.

'overflow' is a new construct rather than a reuse of 'text', which means a
glyph the face cannot draw and is shared with svgdraw.ts — an overflowing
block drew every character perfectly. CONSTRUCTS 20 -> 21.

The engine still learns no HTML vocabulary: it holds a FlowElement and a
FloatContent, never an HtmlElement, so every report crosses as a bare callback
and cssflow.ts closes over the element. It may fire more than once for one box
— a retry after a column advance does — so one box is one record, de-duplicated
where the record is made.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Docs, the mutation sweep, and close

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Record the invariants in `CLAUDE.md`**

Under the `flow.ts` / authoring-layer entry, add:

```
  **Invariant (`zch2.16`):** content taller than an EMPTY column renders rather
  than refusing the document. An image SCALES (`shrinkToFit`, implemented only
  by `ImageElement`, which is the one element type with an aspect ratio and no
  other meaning); anything else DRAWS PAST the column bottom. `Render` used to
  throw here, and `doc.AddHtml('<img …>')` reached it for any image whose own
  aspect exceeded the column's — measured at 1.548 on a default A4 flow, so a
  9:16 phone photo refused the whole document.
  **Invariant (`zch2.16`), and it is the one a single-element fixture cannot
  see:** the shrink is asked ONLY where the alternative is refusing the
  document — at a column start, or with nothing yet placed into a rect. A tall
  image near a column FOOT must move to the next column at full size; shrink at
  every `place()` and a picture's size depends on what precedes it.
  **Invariant (`zch2.16`):** a shrink is accepted only when the replacement
  actually FITS — the termination proof, since one still too tall would be
  asked again at the same column start forever. `zch2.15`'s "a tail is accepted
  only when something was painted" is the same shape.
  **Invariant (`zch2.16`):** `ImageElement.resolveSize` clamps HEIGHT beside
  WIDTH, and the two live in ONE function because it answers "how big is this
  drawn" — a second site would let them disagree. `availHeight` defaults to
  Infinity, so `measure` and `place` are byte-identical to before and only
  `shrinkToFit` passes a budget.
  **Invariant (`zch2.16`):** `cssframe.ts`'s `BoxElement` FORWARDS
  `shrinkToFit`. `frameBoxes` wraps every non-float element, so without it the
  shrink never reaches the image inside and every HTML picture overflows where
  it should scale.
  **Note (`zch2.16`), a deliberate asymmetry:** `flowplace.ts` shrinks but
  never overflows. A rect has a real answer `Render` does not — `remainder` —
  so an unscalable element is handed back rather than drawn outside the box the
  caller asked for.
  **Invariant (`zch2.16`):** the engine learns NO HTML vocabulary. It holds a
  `FlowElement` and a `FloatContent`, never an `HtmlElement`, and
  `NotRendered.el` IS an `HtmlElement` — so `flow.ts` provably cannot build one
  of these records. `onCompromise` and `onDegraded` are bare callbacks and
  `cssflow.ts` closes over the element. `onCompromise` is the ONE non-readonly
  member of `FlowElement`, because the builders are shared with Markdown and
  hand-built flows and must not grow an HTML-shaped option.
  **Invariant (`zch2.16`):** the engine may fire a callback MORE THAN ONCE for
  one box — after a float degrades it places like any other element, and a
  retry re-enters the float branch — so one box is one record, de-duplicated
  where the record is made.
  **Invariant (`zch2.16`):** `doc.AddHtml` and `page.AddHtml` return a FRESH
  `[...skipped, ...late]`; `flow.AddHtml`'s array is never appended to after it
  is handed back. A Flow caller uses `HtmlFlowOptions.onNotRendered`, which is
  the only channel that can fire at the right time when Add and Render are
  separate calls.
  **Invariant (`zch2.16`):** `'overflow'` is its OWN construct, not a reuse of
  `'text'` — that name means a glyph the resolved face cannot draw and is
  shared with `svgdraw.ts`, while an overflowing block drew every character
  perfectly. `CONSTRUCTS` is 21.
```

Also update the `htmlreport.ts` entry's construct count and the
`HtmlFlowResult.skipped` ORDER note to name **three** phases: building,
lowering, then PLACING.

- [ ] **Step 2: Add the `CHANGELOG.md` entry**

Under `## [Unreleased]`, as the first entry of `### Fixed`:

```markdown
- **Content taller than a column no longer refuses the whole document.** `doc.AddHtml('<img src="…">')` threw `Flow: element does not fit in an empty column` for any image whose own aspect ratio exceeded the column's — measured at 1.548 on a default A4 flow, so a **9:16 phone photo held upright was enough**, with no float, no CSS and no file involved. The cause was one missing clamp: `ImageElement` fitted an image's WIDTH to the region and never its HEIGHT, so a portrait picture scaled to the column width ran past the column bottom and the engine gave up. An image now **scales to fit**, aspect preserved, and anything that cannot be scaled — a line of 900pt text, say — **draws past the column bottom** rather than taking the document with it. Both happen ONLY where the alternative was refusing the document: a tall image arriving near the foot of a column still moves to the next column at full size, so a picture's size never depends on what precedes it. `page.AddHtml` scales the same image where it previously drew nothing and handed the element back; it still returns anything it cannot scale in `remainder` rather than drawing outside the rect you gave it. Both compromises are now reported in `skipped` — a scaled image as `image:scaled-to-fit`, an overflowing block under the new `overflow` construct — as is a float that could only be laid out in flow, which was unreachable before because it threw. Because these are decided while PLACING, `doc.AddHtml` and `page.AddHtml` return a fresh `skipped` including them, while a `Flow` — whose `AddHtml` returns before `Render` runs — takes the new `onNotRendered` callback; the array `flow.AddHtml` hands back is never appended to afterwards. (`zch2.16`)
```

- [ ] **Step 3: Update `README.md`'s Limitations**

Search for any statement that an over-tall element throws and correct it; add
the scale/overflow behaviour and the `onNotRendered` option to the HTML section.

Run: `grep -n "does not fit in an empty column" README.md`

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm test`
Expected: PASS, both. The issue cannot be closed on a partial run.

- [ ] **Step 5: Mutation sweep**

There is NO oracle — placement is not observable through `getComputedStyle`, so
`test/fixtures/css-box/` sees none of this. Apply each mutation, record which
cases redden, then REVERT it:

| # | Mutation | Must redden |
|---|---|---|
| 1 | `resolveSize`: drop the `drawH > availHeight` clamp | `flow-overtall` "renders SCALED", `css-overtall-report` image cases |
| 2 | `flow.ts`: ask `shrinkToFit` unconditionally instead of under `atColumnStart` | `flow-overtall` "does NOT shrink an image that merely does not fit what is LEFT" |
| 3 | `flow.ts`: accept the shrink without re-measuring `fits` | a hang, or `flow-overtall` "renders SCALED" |
| 4 | `flow.ts`: drop the overflow branch and re-throw | `flow-overtall` "OVERFLOWS the column", "keeps rendering AFTER" |
| 5 | `cssframe.ts`: delete `BoxElement.shrinkToFit` | `css-overtall-report` image cases (HTML overflows where it should scale) |
| 6 | `flowplace.ts`: offer the shrink without the `!started` guard | `flow-overtall` "does NOT shrink an element that merely does not fit what is LEFT" |
| 7 | `flowplace.ts`: overflow instead of returning the remainder | `flow-overtall` "does NOT overflow the caller's rect" |
| 8 | `cssflow.ts`: drop the `once2` de-duplication | `css-overtall-report` "reports ONE record even when retried" |
| 9 | `document.ts`: push into `skipped` instead of concatenating a fresh array | `css-overtall-report` "does NOT append to the skipped array it already handed back" |
| 10 | `cssflow.ts`: report `'text'` instead of `'overflow'` | `css-overtall-report` "reports an element it could only draw by overflowing" |

Record every result in the issue's close notes, INCLUDING any that redden
nothing — an uncovered rule is written down, not deleted, and gets a
`**Note, measured and NOT covered:**` line in `CLAUDE.md`.

- [ ] **Step 6: Commit, close and push**

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(zch2.16): the invariants, the changelog entry and the sweep

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close zch2.16
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-review

**Spec coverage.** Decision 1 → Tasks 1 and 2. Decision 2 → Task 1 Step 5's
`atColumnStart` guard + Task 2's `!started` guard, both with their own fixture
and mutations 2 and 6. Decision 3 → Task 1 Step 4. Decision 4 → Task 1 Step 5's
overflow branch, mutation 4. Decision 5 → Task 2, mutation 7. Decision 6 → Task
3 Step 4. Decision 7 → Task 3 Step 7, mutation 9. Decision 8 → the Global
Constraint plus `onCompromise`/`onDegraded` being bare callbacks. Decision 9 →
Task 3 Step 5's `once2`, mutation 8. Decision 10 → Task 3 Step 3, mutation 10.
Decision 11 → Task 1 Step 3 and Task 3 Step 5. Decision 12 → Task 1 Step 5's
re-measure, mutation 3. The `BoxElement` forwarding the spec's Files table
implies → Task 1 Step 6, mutation 5.

**Placeholders.** One deliberate open instruction remains, in Task 4 Step 3: the
README edit is a `grep` and a correction, because the exact wording to change
cannot be quoted without the current file in hand — if the `grep` finds nothing,
there is nothing to correct and the step is the two additions only. Every other
step carries its code or its exact command.

**Self-review found and FIXED one defect in this plan:** Task 1 Step 1's first
test originally asserted only `page.Images.length === 1`, which says an image is
PRESENT and nothing about how big it was drawn — so it passed for a build that
clipped rather than scaled, which is the exact distinction the task exists for.
It reads the emitted `cm` matrix instead, the idiom `test/flow.test.ts` already
uses for emitted geometry.

**Type consistency.** `shrinkToFit(width, availHeight)` and
`onCompromise(how: 'scaled' | 'overflow')` are used with those exact signatures
in Task 1 (declaration, `ImageElement`, `BoxElement`, the engine), Task 2
(`flowplace`) and Task 3 (`cssflow`). `onDegraded: () => void` matches between
`FloatContent`, `elementFloat`, both fire sites and `makeFloat`.
`onNotRendered: (r: NotRendered) => void` matches across `CssFlowOptions`,
`Ctx`, `HtmlFlowOptions`, `document.ts` and `page.ts`.
