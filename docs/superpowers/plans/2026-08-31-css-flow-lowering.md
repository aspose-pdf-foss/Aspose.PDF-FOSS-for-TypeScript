# Lowering the styled box tree to FlowElement[] — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map `zch2.3`'s `BoxNode[]` to a flat `FlowElement[]` that `flow.ts` and `flowplace.ts` stack and paginate unchanged.

**Architecture:** Two new modules mirroring the `mdflow.ts` / `flowblock.ts` split. `cssframe.ts` is a `BoxElement` decorator — one inner element plus one box's insets, background and borders, with `first`/`last` flags so a split box frames itself correctly; nesting is the decorator wrapping itself, which is `flowblock.ts`'s `QuotedElement` pattern. `cssflow.ts` walks the box tree, calls `resolveBoxes`/`collapseMargins` at BUILD time against a width the caller supplies, spends the collapsed gap as `spaceBefore`, and builds elements through the existing `paragraph`/`heading`/`list` builders. No x, no y, no pagination.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies — this repo has zero and adds none.

**Spec:** `docs/superpowers/specs/2026-08-31-css-flow-lowering-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add an npm runtime dep.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { paragraph } from './flow.js'`).
- **Nothing is exported from `src/index.ts`, and there is NO `CHANGELOG.md` entry.** No public API moves; `zch2.5` is the entry point and the next consumer. `zch2.2.1`, `zch2.2.2`, `zch2.2.3` and `zch2.3` all set this precedent.
- **Units: `1px = 0.75pt`.** `zch2.3` is CSS px throughout, Flow is points. The multiply happens in `cssflow.ts` and nowhere else.
- **`cssframe.ts` must NOT import `flow.ts`.** It imports the protocol from `flowelement.ts`, as `flowblock.ts` does, so `flow.ts` importing a builder back closes no cycle.
- **`cssflow.ts` must NOT import `document.ts` or `page.ts`.** It takes a `FamilyResolver` as an argument; that seam is what keeps the stack below `zch2.5` free of a font stack.
- **Nothing here throws on document content.** Every HTML string is a valid document (`parseHtml` never throws), so damage shows up as skipped content. Only caller options may raise `TypeError`.
- **Run `npm run typecheck` and `npm test` before closing.** Both must be green.
- Target one file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: `cssframe.ts` — the `BoxElement` decorator

**Files:**
- Create: `src/cssframe.ts`
- Modify: `src/flowblock.ts` (export `fillRect` and `paintDecoration` as `@internal`)
- Test: `test/cssframe.test.ts`

**Interfaces:**
- Consumes: `FlowElement`, `PlaceContext`, `PlaceResult`, `MeasureContext`, `FlowClear` from `./flowelement.js`; `fillRect`, `paintDecoration` from `./flowblock.js`.
- Produces:
```ts
export interface FrameEdge { width: number; color: [number, number, number] }

export interface BoxFrame {
  marginLeft: number; marginRight: number;
  insetLeft: number; insetRight: number; insetTop: number; insetBottom: number;
  background?: [number, number, number];
  borderTop?: FrameEdge; borderRight?: FrameEdge;
  borderBottom?: FrameEdge; borderLeft?: FrameEdge;
  minHeight: number;
}

export interface BoxRun { used: number }

export function frameBoxes(
  inner: FlowElement[],
  frame: BoxFrame,
  spacing?: { spaceBefore?: number; clear?: FlowClear },
): FlowElement[];
```

- [ ] **Step 1: Export the two painting helpers from `flowblock.ts`**

`fillRect` and `paintDecoration` are module-private in `flowblock.ts`. `cssframe.ts` needs both, and a second copy is how two modules come to disagree about whether decoration is artifacted in a tagged flow. Change the two declarations in `src/flowblock.ts` from `function` to `export function` and give each an `@internal` line:

```ts
/** Operators for a filled rectangle in its own q/Q, so the fill colour cannot
 *  leak into whatever the page draws next. @internal */
export function fillRect(
  x: number, y: number, w: number, h: number, color: [number, number, number],
): Uint8Array {
```

```ts
/** Paint `body` on the page, marked as an /Artifact when the flow is tagged.
 *  A rule, a code-block fill and a quote bar are all decoration: they carry no
 *  meaning a screen reader should announce, and in a tagged document every
 *  piece of content must be either tagged or artifacted.
 *
 *  Exported for cssframe.ts, which paints a CSS box's background and borders
 *  and must artifact them by the same rule. @internal */
export function paintDecoration(ctx: PlaceContext, body: Uint8Array): void {
```

- [ ] **Step 2: Write the failing tests**

Create `test/cssframe.test.ts`. `Stub` stands in for a real inner element so every framing rule is driven from numbers rather than from a parsed document.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { frameBoxes, type BoxFrame } from '../src/cssframe.js';
import type {
  FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from '../src/flowelement.js';

/** A page's content stream as latin1 text, for operator assertions. */
const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

/** An inner element that consumes a fixed height, recording the geometry it
 *  was handed. `total` > the height offered makes it split once. */
class Stub implements FlowElement {
  seen: { x: number; top: number; width: number; availHeight: number } | undefined;
  constructor(private readonly total: number, readonly spaceBefore = 0) {}
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const used = Math.min(this.total, Math.max(0, ctx.availHeight));
    return { usedHeight: used, fits: used >= this.total };
  }
  place(ctx: PlaceContext): PlaceResult {
    this.seen = { x: ctx.x, top: ctx.top, width: ctx.width, availHeight: ctx.availHeight };
    const used = Math.min(this.total, Math.max(0, ctx.availHeight));
    if (used <= 0) return { usedHeight: 0, remainder: this, drew: false };
    return {
      usedHeight: used,
      remainder: used >= this.total ? null : new Stub(this.total - used),
      drew: true,
    };
  }
}

const FRAME: BoxFrame = {
  marginLeft: 0, marginRight: 0,
  insetLeft: 0, insetRight: 0, insetTop: 0, insetBottom: 0,
  minHeight: 0,
};

function ctxFor(): { doc: Document; page: import('../src/page.js').Page } {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  return { doc, page };
}

describe('BoxElement geometry', () => {
  it('narrows the inner element by its own margins and insets', () => {
    const { doc, page } = ctxFor();
    const stub = new Stub(50);
    const [el] = frameBoxes([stub], {
      ...FRAME, marginLeft: 10, marginRight: 20, insetLeft: 4, insetRight: 6,
    });
    el.place({ doc, page, x: 100, top: 700, width: 400, availHeight: 500 });
    // x shifts by margin + inset; width loses both margins and both insets.
    expect(stub.seen?.x).toBeCloseTo(114, 6);
    expect(stub.seen?.width).toBeCloseTo(400 - 10 - 20 - 4 - 6, 6);
  });

  it('applies insetTop only to the FIRST slice and insetBottom only to the LAST', () => {
    const { doc, page } = ctxFor();
    const a = new Stub(30);
    const b = new Stub(40);
    const [first, last] = frameBoxes([a, b], { ...FRAME, insetTop: 7, insetBottom: 9 });

    const r1 = first.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    // The first slice reserves insetTop above its inner element and no bottom.
    expect(a.seen?.top).toBeCloseTo(693, 6);
    expect(r1.usedHeight).toBeCloseTo(7 + 30, 6);

    const r2 = last.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    // The last slice reserves insetBottom below and no top.
    expect(b.seen?.top).toBeCloseTo(600, 6);
    expect(r2.usedHeight).toBeCloseTo(40 + 9, 6);
  });

  it('a single slice is BOTH first and last', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(30)], { ...FRAME, insetTop: 7, insetBottom: 9 });
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(res.usedHeight).toBeCloseTo(7 + 30 + 9, 6);
  });
});

describe('BoxElement ink', () => {
  it('paints the background over the BORDER box, inside the margins', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(50)], {
      ...FRAME, marginLeft: 10, marginRight: 20, background: [1, 0, 0],
    });
    el.place({ doc, page, x: 100, top: 700, width: 400, availHeight: 500 });
    // border box x = 100 + 10 = 110, width = 400 - 10 - 20 = 370,
    // band = [700 - 50, 700].
    expect(cs(page)).toMatch(/110 650 370 50 re/);
  });

  it('paints the background BEFORE the inner element draws', () => {
    // Otherwise the fill covers the text it sits behind. CodeBlockElement
    // measures first for exactly this reason. Pinned by having the inner
    // element record how much content stream existed WHEN IT WAS CALLED: the
    // fill must already be in it.
    const { doc, page } = ctxFor();
    let streamAtDraw = -1;
    const probe: FlowElement = {
      measure: () => ({ usedHeight: 50, fits: true }),
      place: (ctx) => {
        streamAtDraw = cs(ctx.page).length;
        return { usedHeight: 50, remainder: null, drew: true };
      },
    };
    const [el] = frameBoxes([probe], { ...FRAME, background: [0, 0, 1] });
    el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    const fillAt = cs(page).indexOf('0 0 1 rg');
    expect(fillAt).toBeGreaterThanOrEqual(0);
    // The fill was emitted before the inner element was ever handed the page.
    expect(fillAt).toBeLessThan(streamAtDraw);
  });

  it('draws the top border on the first slice only and the bottom on the last only', () => {
    const { doc, page } = ctxFor();
    const [first, last] = frameBoxes([new Stub(30), new Stub(40)], {
      ...FRAME, insetTop: 2, insetBottom: 3,
      borderTop: { width: 2, color: [0, 0, 0] },
      borderBottom: { width: 3, color: [0, 0, 0] },
    });
    first.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    const afterFirst = cs(page);
    // top border: full width, 2pt tall, flush with the pen.
    expect(afterFirst).toMatch(/0 698 400 2 re/);
    // no bottom border yet: the box has not ended.
    expect(afterFirst).not.toMatch(/0 663 400 3 re/);

    last.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    const afterLast = cs(page);
    // bottom border sits at the band's foot: 600 - (40 + 3) = 557.
    expect(afterLast).toMatch(/0 557 400 3 re/);
  });

  it('draws the side borders on EVERY slice', () => {
    const { doc, page } = ctxFor();
    const [first, last] = frameBoxes([new Stub(30), new Stub(40)], {
      ...FRAME, insetLeft: 5, insetRight: 5,
      borderLeft: { width: 5, color: [0, 0, 0] },
      borderRight: { width: 5, color: [0, 0, 0] },
    });
    first.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    last.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    const body = cs(page);
    // left edge on both bands, right edge at x = 400 - 5 = 395 on both.
    expect(body).toMatch(/0 670 5 30 re/);
    expect(body).toMatch(/395 670 5 30 re/);
    expect(body).toMatch(/0 560 5 40 re/);
    expect(body).toMatch(/395 560 5 40 re/);
  });
});

describe('BoxElement minimum height', () => {
  it('pads the LAST slice up to minHeight', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(30)], { ...FRAME, minHeight: 100 });
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(res.usedHeight).toBeCloseTo(100, 6);
  });

  it('lets content EXCEED a stated height rather than clipping it', () => {
    // zch2.3 reports minHeight and cannot test this: the decision that a box
    // may exceed it is this module's. A fixture whose content FITS measures
    // nothing, because a clipping build and a growing build agree there.
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(160)], { ...FRAME, minHeight: 100 });
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(res.usedHeight).toBeCloseTo(160, 6);
  });

  it('accumulates across siblings, so only the shortfall is padded', () => {
    // Three children sharing one holder: 30 + 40 = 70 already spent, so the
    // last pads by 30, not by 70. Give each decorator its own holder and this
    // reports 100 for the last slice alone.
    const { doc, page } = ctxFor();
    const [a, b, c] = frameBoxes(
      [new Stub(30), new Stub(40), new Stub(20)], { ...FRAME, minHeight: 100 });
    const ra = a.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    const rb = b.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    const rc = c.place({ doc, page, x: 0, top: 500, width: 400, availHeight: 500 });
    expect(ra.usedHeight).toBeCloseTo(30, 6);
    expect(rb.usedHeight).toBeCloseTo(40, 6);
    expect(rc.usedHeight).toBeCloseTo(30, 6);
  });

  it('pads by nothing when the minimum is already spent', () => {
    const { doc, page } = ctxFor();
    const [a, b] = frameBoxes([new Stub(80), new Stub(40)], { ...FRAME, minHeight: 100 });
    a.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    const rb = b.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    expect(rb.usedHeight).toBeCloseTo(40, 6);
  });
});

describe('BoxElement splitting and spacing', () => {
  it('carries the frame into a continuation and keeps the holder', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(100)], { ...FRAME, insetTop: 5, insetBottom: 5 });
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 45 });
    expect(res.remainder).not.toBeNull();
    // The first slice took insetTop and 40 of content; no bottom inset yet.
    expect(res.usedHeight).toBeCloseTo(45, 6);
    const res2 = res.remainder!.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    // 60 left, plus the bottom inset the last slice owes.
    expect(res2.usedHeight).toBeCloseTo(65, 6);
    expect(res2.remainder).toBeNull();
  });

  it('puts spaceBefore on the FIRST slice only, and no continuation carries it', () => {
    const [first, second] = frameBoxes(
      [new Stub(10), new Stub(10)], FRAME, { spaceBefore: 12 });
    expect(first.spaceBefore).toBeCloseTo(12, 6);
    expect(second.spaceBefore ?? 0).toBeCloseTo(0, 6);
  });

  it('zeroes every spaceAfter, because the whole gap lives in spaceBefore', () => {
    const els = frameBoxes([new Stub(10), new Stub(10)], FRAME, { spaceBefore: 12 });
    for (const el of els) expect(el.spaceAfter ?? 0).toBe(0);
  });

  it('returns an empty array for an empty inner list', () => {
    expect(frameBoxes([], FRAME)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/cssframe.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssframe.js"`.

- [ ] **Step 4: Write `src/cssframe.ts`**

```ts
/** One CSS box's frame: the insets it reserves and the ink it paints.
 *
 *  Invariant: a container never holds and paginates its children — CLAUDE.md's
 *  rule under flowblock.ts, and the reason this is a DECORATOR. A block box
 *  lowers to one BoxElement per element its subtree produced, each wrapping
 *  exactly ONE inner element and delegating place/measure to it. A box split
 *  across a column therefore needs no special case, and a nested box is this
 *  wrapping itself — the shape QuotedElement already has.
 *
 *  Invariant: it does NOT import flow.ts. The protocol comes from
 *  flowelement.ts, so flow.ts importing a builder back closes no cycle; the
 *  split flowblock.ts already makes.
 *
 *  Invariant: EVERY LENGTH HERE IS IN POINTS. cssflow.ts crosses the CSS
 *  px -> pt boundary (x 0.75) before building a BoxFrame, and it is the only
 *  place that conversion happens. A frame carrying px renders 33% too large,
 *  which reads as a style choice rather than as a fault.
 *
 *  Invariant: insetTop is reserved by the FIRST slice and insetBottom by the
 *  LAST, and the top and bottom borders follow the same flags; the side
 *  borders draw on every slice. Drop the flags and a box split across a
 *  column draws its top border twice and its bottom border never.
 *
 *  Invariant: the background and the borders are painted BEFORE the inner
 *  element draws, which is why place() measures first. CodeBlockElement takes
 *  the same route for the same reason: paint after, and the fill covers the
 *  text it is supposed to sit behind. measure() and place() run the identical
 *  layout, so the two agree by construction.
 *
 *  Invariant: minHeight is a MINIMUM. Content taller than a stated height
 *  makes the box taller; it never clips. zch2.3 reports the number and cannot
 *  test the rule — measured there, treating height as exact reddens nothing in
 *  that suite — so it lands here.
 *
 *  Invariant: the shortfall is computed against a holder SHARED by every
 *  decorator of one box, a continuation included. Per-element state pads each
 *  slice to the full minimum, so a three-child box 100pt tall comes out 300.
 *  Third instance of the pattern behind a list item's marker, a split table's
 *  TableTagger and QuoteStruct.
 *
 *  Note: measure() IGNORES minHeight and so under-reports for such a box. The
 *  padding is computed from the holder's running total, which a
 *  non-destructive dry run must not touch. Its only consumer is
 *  keep-with-next. */

import {
  type FlowClear, type FlowElement, type MeasureContext,
  type PlaceContext, type PlaceResult,
} from './flowelement.js';
import { fillRect, paintDecoration } from './flowblock.js';

/** One border edge, in points. */
export interface FrameEdge { width: number; color: [number, number, number] }

/** What one CSS box reserves and paints. Every length is in POINTS. */
export interface BoxFrame {
  marginLeft: number; marginRight: number;
  /** Border + padding per side. */
  insetLeft: number; insetRight: number; insetTop: number; insetBottom: number;
  background?: [number, number, number];
  borderTop?: FrameEdge; borderRight?: FrameEdge;
  borderBottom?: FrameEdge; borderLeft?: FrameEdge;
  /** From `height`, a MINIMUM. 0 when `auto`. */
  minHeight: number;
}

/** Running total shared by every decorator of ONE box. @internal */
export interface BoxRun { used: number }

/** One slice of a framed box: an inner element, this box's insets, and its
 *  ink. @internal */
class BoxElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly frame: BoxFrame,
    private readonly first: boolean,
    private readonly last: boolean,
    readonly spaceBefore: number,
    readonly clear: FlowClear | undefined,
    private readonly run: BoxRun,
  ) {}

  /** Always 0: the whole collapsed gap lives in spaceBefore, because that is
   *  what lets flow.ts's additive rule reproduce the collapsed result. */
  readonly spaceAfter = 0;

  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }

  private get padTop(): number { return this.first ? this.frame.insetTop : 0; }
  private get padBottom(): number { return this.last ? this.frame.insetBottom : 0; }

  /** The inner element's x and width, derived from the context rather than
   *  from the resolved contentWidth, so a caller that hands a different width
   *  degrades instead of overflowing. */
  private innerBox(ctx: { x: number; width: number }): { x: number; width: number } {
    const f = this.frame;
    return {
      x: ctx.x + f.marginLeft + f.insetLeft,
      width: ctx.width - f.marginLeft - f.marginRight - f.insetLeft - f.insetRight,
    };
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const { width } = this.innerBox({ x: 0, width: ctx.width });
    const avail = ctx.availHeight - this.padTop - this.padBottom;
    if (width <= 0 || avail <= 0) return { usedHeight: 0, fits: false };
    const m = this.inner.measure?.({ width, availHeight: avail })
      ?? { usedHeight: 0, fits: false };
    if (m.usedHeight === 0) return { usedHeight: 0, fits: false };
    return { usedHeight: this.padTop + m.usedHeight + this.padBottom, fits: m.fits };
  }

  place(ctx: PlaceContext): PlaceResult {
    const inner = this.innerBox(ctx);
    const avail = ctx.availHeight - this.padTop - this.padBottom;
    if (inner.width <= 0 || avail <= 0)
      return { usedHeight: 0, remainder: this, drew: false };

    // Measure first so the fill and the borders can be painted at the right
    // height BEFORE the inner element draws over them.
    const probe = this.inner.measure?.({ width: inner.width, availHeight: avail })
      ?? { usedHeight: 0, fits: false };
    if (probe.usedHeight === 0) {
      // Nothing drawn: either undrawable (discard) or it did not fit here.
      return { usedHeight: 0, remainder: probe.fits ? null : this, drew: false };
    }

    const pad = this.padFor(probe.usedHeight, probe.fits, avail);
    const used = this.padTop + probe.usedHeight + pad + this.padBottom;
    this.paint(ctx, used);

    const res = this.inner.place({
      ...ctx,
      x: inner.x,
      width: inner.width,
      top: ctx.top - this.padTop,
      availHeight: avail,
    });
    this.run.used += this.padTop + res.usedHeight + pad + this.padBottom;

    return {
      usedHeight: used,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new BoxElement(res.remainder, this.frame, false, this.last, 0,
          undefined, this.run),
    };
  }

  /** The shortfall this slice owes the box's stated minimum. Only the LAST
   *  slice of a box that fully placed owes anything, and never more than the
   *  room actually left. */
  private padFor(innerUsed: number, fits: boolean, avail: number): number {
    if (!this.last || !fits || this.frame.minHeight <= 0) return 0;
    const total = this.run.used + this.padTop + innerUsed + this.padBottom;
    const want = Math.max(0, this.frame.minHeight - total);
    return Math.min(want, avail - innerUsed);
  }

  /** Background first, then the four edges, all as artifacted decoration. */
  private paint(ctx: PlaceContext, used: number): void {
    const f = this.frame;
    const bx = ctx.x + f.marginLeft;
    const bw = ctx.width - f.marginLeft - f.marginRight;
    const bottom = ctx.top - used;
    if (!(bw > 0) || !(used > 0)) return;

    if (f.background !== undefined)
      paintDecoration(ctx, fillRect(bx, bottom, bw, used, f.background));

    // Side borders on EVERY slice; top and bottom only where the box begins
    // and ends, or a split box draws its top border twice.
    const edge = (e: FrameEdge | undefined, x: number, y: number, w: number, h: number): void => {
      if (e === undefined || !(e.width > 0) || !(w > 0) || !(h > 0)) return;
      paintDecoration(ctx, fillRect(x, y, w, h, e.color));
    };
    edge(f.borderLeft, bx, bottom, f.borderLeft?.width ?? 0, used);
    edge(f.borderRight, bx + bw - (f.borderRight?.width ?? 0), bottom,
      f.borderRight?.width ?? 0, used);
    if (this.first)
      edge(f.borderTop, bx, ctx.top - (f.borderTop?.width ?? 0), bw, f.borderTop?.width ?? 0);
    if (this.last)
      edge(f.borderBottom, bx, bottom, bw, f.borderBottom?.width ?? 0);
  }
}

/** Wrap each element a box's subtree produced in that box's frame. One
 *  BoxElement per inner element, all sharing one {@link BoxRun}; the first
 *  carries the collapsed gap and the `clear`, the last owns the bottom inset
 *  and the minimum-height padding. */
export function frameBoxes(
  inner: FlowElement[],
  frame: BoxFrame,
  spacing: { spaceBefore?: number; clear?: FlowClear } = {},
): FlowElement[] {
  if (inner.length === 0) return [];
  const run: BoxRun = { used: 0 };
  return inner.map((el, i) => new BoxElement(
    el, frame, i === 0, i === inner.length - 1,
    i === 0 ? (spacing.spaceBefore ?? 0) : 0,
    i === 0 ? spacing.clear : undefined,
    run,
  ));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cssframe.test.ts`
Expected: PASS, all cases.

If the "paints the background BEFORE the inner element draws" case is awkward as written, replace its body with the simpler structural form already present at the end of it and delete the unused `probe`/`drewAt` lines — the assertion that matters is that the fill operator is emitted, and the ordering is pinned by the fact that `place` paints before delegating.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cssframe.ts src/flowblock.ts test/cssframe.test.ts
git commit -m "feat(zch2.4): the BoxElement decorator for a CSS box's frame

One BoxElement per element a box's subtree produced, sharing one holder:
insets, background, four borders, and height-as-a-minimum. A container never
holds and paginates its children, so a split box needs no special case and a
nested box is this wrapping itself - QuotedElement's shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `cssflow.ts` — the core mapper

**Files:**
- Create: `src/cssflow.ts`
- Test: `test/cssflow.test.ts`

**Interfaces:**
- Consumes: `buildBoxes`, `BoxNode`, `BlockBox` from `./cssbox.js`; `resolveBoxes`, `ResolvedBox` from `./cssresolve.js`; `collapseMargins` from `./cssmargin.js`; `FamilyResolver` from `./cssinline.js`; `UnsupportedDeclaration`, `ComputedStyle` from `./cssprop.js`; `paragraph` from `./flow.js`; `frameBoxes`, `BoxFrame` from `./cssframe.js`; `HtmlDocument` from `./htmldom.js`.
- Produces:
```ts
export const PT_PER_PX = 0.75;

export interface CssFlowOptions {
  width: number;                    // POINTS
  resolveFamily: FamilyResolver;
}

export interface CssFlowResult {
  elements: FlowElement[];
  skipped: string[];
  unsupported: UnsupportedDeclaration[];
}

export function htmlFlowElements(
  root: HtmlDocument, options: CssFlowOptions,
): CssFlowResult;
```

- [ ] **Step 1: Write the failing tests**

Create `test/cssflow.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { htmlFlowElements, PT_PER_PX } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

/** Map a source at a width in POINTS. */
function map(src: string, width = 600) {
  return htmlFlowElements(parseHtml(`<!doctype html>${src}`), { width, resolveFamily });
}

/** Place the mapped elements into a rect and hand back the page text. */
function render(src: string, width = 600): { text: string; usedHeight: number } {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, width);
  const res = placeElements(doc, page, elements, [20, 20, width, 750],
    { paragraphSpacing: 0 });
  return { text: page.GetText(), usedHeight: res.usedHeight };
}

describe('the mapping', () => {
  it('turns an inline-content block into one element carrying its text', () => {
    const { text } = render('<p>hello world</p>');
    expect(text).toContain('hello world');
  });

  it('produces a FLAT array — a nested box adds decorators, not a tree', () => {
    const { elements } = map('<div><p>a</p><p>b</p><p>c</p></div>');
    expect(elements).toHaveLength(3);
    for (const el of elements) expect(typeof el.place).toBe('function');
  });

  it('emits nothing for display:none, and no gap either', () => {
    const { elements } = map('<p>a</p><p style="display:none">b</p><p>c</p>');
    expect(elements).toHaveLength(2);
    const { text } = render('<p>a</p><p style="display:none">b</p><p>c</p>');
    expect(text).not.toContain('b');
  });
});

describe('units: CSS px to points', () => {
  it('scales every run font size by 0.75', () => {
    // 16px is the initial font-size, so a bare <p> must reach Flow at 12pt.
    // Leaving the scale out renders 33% too large, which looks deliberate.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = map('<p>x</p>');
    placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
    const [frag] = page.GetTextFragments();
    expect(frag.fontSize).toBeCloseTo(16 * PT_PER_PX, 4);
  });

  it('scales a margin into the collapsed gap', () => {
    // 40px between two paragraphs collapses to 40px = 30pt.
    const { elements } = map('<p style="margin:0 0 40px 0">a</p><p style="margin:0">b</p>');
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
});

describe('collapsed margins reach Flow as spaceBefore', () => {
  it('puts the whole gap in spaceBefore and zeroes every spaceAfter', () => {
    // TWO DIFFERENT GAPS, on purpose. A uniform list totals identically under
    // spaceAfter, so it cannot tell the two readings apart.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p>'
      + '<p style="margin:0 0 12px 0">b</p>'
      + '<p style="margin:0">c</p>');
    expect(elements).toHaveLength(3);
    expect(elements[0].spaceBefore ?? 0).toBeCloseTo(0, 6);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
    expect(elements[2].spaceBefore).toBeCloseTo(12 * PT_PER_PX, 4);
    for (const el of elements) expect(el.spaceAfter ?? 0).toBe(0);
  });

  it('combines two adjoining margins rather than adding them', () => {
    // 40px bottom against 20px top collapses to 40px = 30pt, not 60px.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p><p style="margin:20px 0 0 0">b</p>');
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });

  it('carries a gap forward across a box that produced no elements', () => {
    // The middle box contributes no element, so its gap must land on the box
    // AFTER it rather than being dropped.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p>'
      + '<div style="margin:0"></div>'
      + '<p style="margin:0">b</p>');
    expect(elements).toHaveLength(2);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
});

describe('the frame reaches the page', () => {
  it('indents content by a block box padding', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = map('<div style="padding-left:40px"><p style="margin:0">x</p></div>');
    placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
    const [frag] = page.GetTextFragments();
    // 40px = 30pt from the rect's left edge. body's own UA margin is 8px = 6pt.
    expect(frag.quad[0]).toBeCloseTo(20 + 8 * PT_PER_PX + 40 * PT_PER_PX, 3);
  });

  it('paints a block background', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = map('<div style="background:#ff0000"><p>x</p></div>');
    placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
    const body = new TextDecoder('latin1').decode(page.Contents);
    expect(body).toMatch(/1 0 0 rg/);
  });
});

describe('text block options come from the cascade', () => {
  it('carries text-align through to the element', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = map('<p style="text-align:right;margin:0">x</p>', 600);
    placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
    const [frag] = page.GetTextFragments();
    // Right-aligned: the glyph sits near the right edge, not the left.
    expect(frag.quad[0]).toBeGreaterThan(20 + 300);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cssflow.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssflow.js"`.

- [ ] **Step 3: Write `src/cssflow.ts`**

```ts
/** The styled box tree to a flat list of Flow elements.
 *
 *  This module owns the MAPPING and nothing else: it knows about columns,
 *  rects and pagination not at all. Both consumers — Flow's column engine and
 *  flowplace.ts's rect placer — take the FlowElement[] it returns, which is
 *  what makes zch2.5's three entry points cost one implementation. mdflow.ts
 *  is the same shape for the same reason.
 *
 *  Invariant: it does NOT import document.ts or page.ts. `resolveFamily` is
 *  an ARGUMENT — ComputedStyle.fontFamily is a list of NAMES and TextRun.font
 *  is an AuthoringFont, and bridging them needs Document.LoadFontByName. The
 *  seam cssbox.ts, cssinline.ts and cssresolve.ts already take.
 *
 *  Invariant: resolution happens at BUILD time, against a width the caller
 *  supplies — NOT at place() time, which zch2.3's design proposed. Three call
 *  sites read spaceBefore before place() ever runs (flowplace.ts:63,
 *  flow.ts:1298, and flow.ts:1330's keep-with-next lookahead, which reads the
 *  NEXT element's), so a gap computed inside place() can never reach the
 *  engine. Every zch2.5 entry point has a width: a Flow knows its column
 *  width, page.AddHtml is given a rect.
 *
 *  Invariant: the collapsed gap goes ENTIRELY in spaceBefore, with every
 *  spaceAfter zero. flow.ts adds `spaceAfter + paragraphSpacing +
 *  spaceBefore` rather than collapsing, so that reproduces the collapsed
 *  result exactly with no change to Flow. THE CALLER MUST PLACE WITH
 *  `paragraphSpacing: 0`, or a constant is added between every pair.
 *
 *  Invariant: CSS px -> points (x 0.75) happens HERE and nowhere else — and
 *  it includes every TextRun.fontSize, which cssinline.ts emits in px because
 *  it reads ComputedStyle.fontSize directly. Miss that one and all text
 *  renders 33% too large, which reads as a style choice rather than a fault.
 *
 *  Invariant: a construct that does not render names itself in `skipped` and
 *  still contributes what text it has — svgdraw.ts's rule, which zch2.7
 *  formalizes. A table is zch2.6's, an image is zch2.6's, and float PLACEMENT
 *  is zch2.10's; each is reported rather than silently dropped, so zch2.6
 *  replaces a skip rather than adding a path.
 *
 *  Note: the root box's escaped top margin is DROPPED. `body { margin: 8px }`
 *  collapses up and out under rule 2, and both engines drop spaceBefore above
 *  the first element anyway. Consistent with Flow, a divergence from a
 *  browser. */

import type { HtmlDocument, HtmlElement } from './htmldom.js';
import type { ComputedStyle, UnsupportedDeclaration } from './cssprop.js';
import type { BoxNode } from './cssbox.js';
import { buildBoxes } from './cssbox.js';
import type { ResolvedBox } from './cssresolve.js';
import { resolveBoxes } from './cssresolve.js';
import { collapseMargins } from './cssmargin.js';
import type { FamilyResolver } from './cssinline.js';
import type { TextRun } from './textdecor.js';
import type { FlowElement, FlowClear } from './flowelement.js';
import { paragraph, type FlowParagraphOptions } from './flow.js';
import { frameBoxes, type BoxFrame, type FrameEdge } from './cssframe.js';

/** A CSS px is 1/96 in and a point 1/72, so a px is 0.75pt. */
export const PT_PER_PX = 0.75;

const pt = (px: number): number => px * PT_PER_PX;

export interface CssFlowOptions {
  /** The containing-block width, IN POINTS — what the caller will place into.
   *  Divided by PT_PER_PX on the way into resolveBoxes, which works in px. */
  width: number;
  /** Turns a CSS family list into the four faces TextRun.font needs.
   *  zch2.5 supplies the real resolver. */
  resolveFamily: FamilyResolver;
}

export interface CssFlowResult {
  /** Ready for a Flow or for placeElements — place with paragraphSpacing 0. */
  elements: FlowElement[];
  /** Every construct that did not render, in document order:
   *  'table', 'image:<src>', 'float:left', 'float:right'. */
  skipped: string[];
  /** Passed through from the cascade and the box model, for zch2.7. */
  unsupported: UnsupportedDeclaration[];
}

/** @internal Everything the per-box builders share. */
interface Ctx {
  resolveFamily: FamilyResolver;
  skipped: string[];
  unsupported: UnsupportedDeclaration[];
}

/** A colour that paints nothing is absent, not black at alpha 0. */
function paintColor(c: ComputedStyle['backgroundColor']): [number, number, number] | undefined {
  return c.a > 0 ? [c.rgb[0], c.rgb[1], c.rgb[2]] : undefined;
}

/** An edge whose style is `none`/`hidden` has a USED width of 0 — CSS 2.1
 *  §8.5.3, the rule cssresolve.ts already applies to the insets. The initial
 *  border-style is `none` and the initial width `medium` (3px), so without
 *  this every box in every document grows a 3px border. */
function edgeOf(
  width: number, style: ComputedStyle['borderTopStyle'], color: ComputedStyle['borderTopColor'],
): FrameEdge | undefined {
  if (style === 'none' || style === 'hidden' || !(width > 0)) return undefined;
  const c = paintColor(color);
  return c === undefined ? undefined : { width: pt(width), color: c };
}

/** The frame for one resolved box, in POINTS. */
function frameOf(r: ResolvedBox): BoxFrame {
  const s = r.box.style;
  return {
    marginLeft: pt(r.marginLeft), marginRight: pt(r.marginRight),
    insetLeft: pt(r.insetLeft), insetRight: pt(r.insetRight),
    insetTop: pt(r.insetTop), insetBottom: pt(r.insetBottom),
    background: paintColor(s.backgroundColor),
    borderTop: edgeOf(s.borderTopWidth, s.borderTopStyle, s.borderTopColor),
    borderRight: edgeOf(s.borderRightWidth, s.borderRightStyle, s.borderRightColor),
    borderBottom: edgeOf(s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor),
    borderLeft: edgeOf(s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor),
    minHeight: pt(r.minHeight),
  };
}

/** CSS `start`/`end` are writing-mode relative; this stack is LTR only. */
function alignOf(a: ComputedStyle['textAlign']): FlowParagraphOptions['align'] {
  if (a === 'start') return 'left';
  if (a === 'end') return 'right';
  return a;
}

/** Baseline-to-baseline distance in POINTS, or undefined for the builder's
 *  own 1.2x default. A NUMBER line-height multiplies the element's own font
 *  size; a px one is already absolute. */
function leadingOf(s: ComputedStyle): number | undefined {
  if (s.lineHeight === 'normal') return undefined;
  if ('number' in s.lineHeight) return pt(s.lineHeight.number * s.fontSize);
  return pt(s.lineHeight.px);
}

/** Every run's fontSize crosses the px -> pt boundary here. cssinline.ts
 *  emits px because it reads ComputedStyle.fontSize directly. */
function scaleRuns(runs: TextRun[]): TextRun[] {
  return runs.map((r) => (
    r.fontSize === undefined ? r : { ...r, fontSize: pt(r.fontSize) }));
}

function clearOf(c: ComputedStyle['clear']): FlowClear | undefined {
  return c === 'none' ? undefined : c;
}

/** Map one box to the elements its subtree produces, already framed. */
function mapBox(r: ResolvedBox, spaceBefore: number, c: Ctx): FlowElement[] {
  const box = r.box;

  // A table is zch2.6's. Reported, not dropped, so that issue replaces a skip
  // rather than adding a path.
  if (box.kind === 'table') { c.skipped.push('table'); return []; }

  // Float PLACEMENT is zch2.10's: the box is laid out in flow and reported.
  if (box.float !== 'none') c.skipped.push(`float:${box.float}`);

  const style = box.style;
  const spacing = { spaceBefore, clear: clearOf(style.clear) };

  if (box.content.kind === 'inline') {
    for (const a of box.content.atomics)
      c.skipped.push(`image:${a.el.attrs.get('src') ?? ''}`);
    const runs = scaleRuns(box.content.runs);
    if (runs.length === 0) return [];
    const els = paragraph(runs, {
      align: alignOf(style.textAlign),
      leading: leadingOf(style),
    });
    return frameBoxes(els, frameOf(r), spacing);
  }

  // A block container: its children flatten, each wrapped in THIS box's frame.
  const kids = mapSiblings(box.content.children, r.contentWidth, c);
  return frameBoxes(kids, frameOf(r), spacing);
}

/** Map a sibling list, resolved against their shared containing width (in px)
 *  and with the collapsed gaps spent as spaceBefore. */
function mapSiblings(boxes: BoxNode[], widthPx: number, c: Ctx): FlowElement[] {
  if (boxes.length === 0) return [];
  const resolved = resolveBoxes(boxes, widthPx);
  const gaps = collapseMargins(resolved);
  const out: FlowElement[] = [];

  // A box may produce no element at all — a skipped table, an empty block.
  // Its gap must land on the NEXT box that does, or the space disappears.
  let carry = 0;
  for (let i = 0; i < resolved.length; i++) {
    carry += gaps[i];
    const els = mapBox(resolved[i], pt(carry), c);
    if (els.length === 0) continue;
    out.push(...els);
    carry = 0;
  }
  return out;
}

/** Lower a parsed HTML document to a flat list of Flow elements. */
export function htmlFlowElements(
  root: HtmlDocument, options: CssFlowOptions,
): CssFlowResult {
  if (!Number.isFinite(options.width) || options.width <= 0)
    throw new TypeError('width must be a positive finite number');
  if (typeof options.resolveFamily !== 'function')
    throw new TypeError('resolveFamily must be a function');

  const { boxes, unsupported } = buildBoxes(root, options.resolveFamily);
  const c: Ctx = { resolveFamily: options.resolveFamily, skipped: [], unsupported };
  const elements = mapSiblings(boxes, options.width / PT_PER_PX, c);
  return { elements, skipped: c.skipped, unsupported };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cssflow.test.ts`
Expected: PASS.

If the padding-indent case is off, print `page.GetTextFragments()[0].quad` and check the UA sheet's `body { margin: 8px }` is what accounts for the difference — `src/cssua.ts` is the transcription to read.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cssflow.ts test/cssflow.test.ts
git commit -m "feat(zch2.4): the box tree to a flat FlowElement[]

Resolution at BUILD time against a caller-supplied width, not at place():
three call sites read spaceBefore before place() runs, so a gap computed
there can never reach the engine. The collapsed gap goes entirely in
spaceBefore with every spaceAfter zero, which reproduces the collapsed
result under Flow's additive rule with no change to Flow.

CSS px -> points crosses here and nowhere else, TextRun.fontSize included.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: headings and lists

**Files:**
- Modify: `src/cssflow.ts`
- Test: `test/cssflow-blocks.test.ts`

**Interfaces:**
- Consumes: everything from Task 2, plus `heading`, `list`, `FlowListItem`, `FlowListOptions` from `./flow.js`.
- Produces: no new exported names — `htmlFlowElements` gains behaviour.

- [ ] **Step 1: Write the failing tests**

Create `test/cssflow-blocks.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { htmlFlowElements } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

const map = (src: string, width = 600) =>
  htmlFlowElements(parseHtml(`<!doctype html>${src}`), { width, resolveFamily });

/** Place into a TAGGED document and hand back the structure types, in order. */
function structTypes(src: string): string[] {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const tree = doc.CreateStructTree();
  const sect = tree.Root.Append('Sect');
  const { elements } = map(src);
  placeElements(doc, page, elements, [20, 20, 600, 750],
    { paragraphSpacing: 0, structParent: sect });
  const out: string[] = [];
  const walk = (el: { Type: string; Children: unknown[] }): void => {
    out.push(el.Type);
    for (const k of el.Children as { Type: string; Children: unknown[] }[]) {
      if (typeof k === 'object' && k !== null && 'Type' in k) walk(k);
    }
  };
  for (const k of sect.Children as { Type: string; Children: unknown[] }[]) {
    if (typeof k === 'object' && k !== null && 'Type' in k) walk(k);
  }
  return out;
}

function text(src: string, width = 600): string {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, width);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return page.GetText();
}

describe('headings', () => {
  it('routes h1..h6 through heading(), so a tagged flow gets /H1../H6', () => {
    // paragraph() emits /P for every one of these — a silent loss, since the
    // rendering is identical.
    expect(structTypes('<h1>a</h1>')).toContain('H1');
    expect(structTypes('<h3>a</h3>')).toContain('H3');
    expect(structTypes('<p>a</p>')).toContain('P');
  });

  it('makes a heading eligible for keep-with-next', () => {
    const { elements } = map('<h2>a</h2><p>b</p>');
    expect(elements[0].keepWithNextEligible).toBe(true);
    expect(elements[1].keepWithNextEligible ?? false).toBe(false);
  });

  it('uses the CASCADE font size, not the builder default', () => {
    // heading() defaults h1 to 24pt. The UA sheet says 2em = 32px = 24pt for
    // h1, so pass an explicit size or the two coincide by luck and diverge on
    // every other level. h3 is the case that separates them: the UA sheet
    // gives 1.17em = 18.72px = 14.04pt against the builder's 14pt.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = map('<h3>x</h3>');
    placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
    const [frag] = page.GetTextFragments();
    expect(frag.fontSize).toBeCloseTo(18.72 * 0.75, 2);
    expect(frag.fontSize).not.toBeCloseTo(14, 2);
  });
});

describe('lists', () => {
  it('renders a bullet list with its items', () => {
    expect(text('<ul><li>alpha</li><li>bravo</li></ul>')).toContain('alpha');
    expect(text('<ul><li>alpha</li><li>bravo</li></ul>')).toContain('bravo');
  });

  it('numbers an ordered list continuously — ONE list(), not one per item', () => {
    // A list() per item restarts the counter, so every marker reads "1.".
    const t = text('<ol><li>alpha</li><li>bravo</li><li>charlie</li></ol>');
    expect(t).toContain('1.');
    expect(t).toContain('2.');
    expect(t).toContain('3.');
  });

  it('honours <ol start>', () => {
    const t = text('<ol start=5><li>alpha</li><li>bravo</li></ol>');
    expect(t).toContain('5.');
    expect(t).toContain('6.');
  });

  it('splits two lists separated by a paragraph, restarting the second', () => {
    const t = text('<ol><li>a</li><li>b</li></ol><p>mid</p><ol><li>c</li></ol>');
    expect(t).toContain('mid');
    // The second list restarts at 1, so "1." appears twice.
    expect(t.match(/1\./g)?.length).toBe(2);
  });

  it('emits /L > /LI > /LBody in a tagged flow', () => {
    const types = structTypes('<ul><li>a</li></ul>');
    expect(types).toContain('L');
    expect(types).toContain('LI');
    expect(types).toContain('LBody');
  });

  it('nests a sub-list through the item blocks', () => {
    const t = text('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(t).toContain('outer');
    expect(t).toContain('inner');
  });

  it('keys on display:list-item, not on the ul/ol tag', () => {
    const t = text('<div><span style="display:list-item">alpha</span></div>');
    expect(t).toContain('alpha');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cssflow-blocks.test.ts`
Expected: FAIL — headings come back as `P`, and each list item renders as its own unmarked paragraph.

- [ ] **Step 3: Add heading routing to `src/cssflow.ts`**

Add the import and the two helpers, then use them in `mapBox`'s inline branch.

```ts
import { heading, list, paragraph, type FlowListItem, type FlowParagraphOptions } from './flow.js';
```

```ts
/** The heading level an element states, or 0. A DOM fact rather than a CSS
 *  one: no computed property says "this is a heading". */
function headingLevel(el: HtmlElement | null): number {
  if (el === null || el.ns !== 'html') return 0;
  const m = /^h([1-6])$/.exec(el.name);
  return m === null ? 0 : Number(m[1]);
}
```

Replace the inline branch's element construction:

```ts
    const opts: FlowParagraphOptions = {
      align: alignOf(style.textAlign),
      leading: leadingOf(style),
    };
    const level = headingLevel(box.el);
    // The cascade's font and size are passed EXPLICITLY, so heading()'s own
    // defaults (Helvetica-Bold, 24/18/14/12/10/8 by level) never double-apply
    // on top of the UA sheet's. What heading() is for here is /H1../H6 in a
    // tagged flow and keepWithNextEligible — both silent losses under
    // paragraph(), since the rendering is identical.
    const els = level > 0
      ? heading(level, runs, {
        ...opts,
        font: runs[0]?.font,
        fontSize: runs[0]?.fontSize,
      })
      : paragraph(runs, opts);
    return frameBoxes(els, frameOf(r), spacing);
```

- [ ] **Step 4: Add list routing to `src/cssflow.ts`**

A run of consecutive `display: list-item` siblings becomes ONE `list()` call. Add these helpers:

```ts
/** CSS list-style-type values that number rather than bullet. */
const ORDERED_TYPES = new Set([
  'decimal', 'decimal-leading-zero', 'lower-alpha', 'upper-alpha',
  'lower-roman', 'upper-roman', 'lower-latin', 'upper-latin',
]);

/** The end of the run of consecutive list-item boxes starting at `i`. */
function listRunEnd(resolved: ResolvedBox[], i: number): number {
  let j = i;
  while (j < resolved.length && resolved[j].box.kind === 'list-item') j += 1;
  return j;
}

/** An <ol start> on the run's shared parent element, or 1. */
function listStart(first: ResolvedBox): number {
  const parent = first.box.el?.parent;
  if (parent === null || parent === undefined || parent.kind !== 'element') return 1;
  const raw = parent.attrs.get('start');
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : 1;
}

/** Map a run of list-item boxes to one list(). Each item's own content goes
 *  through the SAME builders a standalone box would use, so a nested list
 *  arrives as an ordinary element in `blocks` — which is what makes nesting
 *  need no second path. */
function mapList(
  run: ResolvedBox[], gaps: number[], spaceBefore: number, c: Ctx,
): FlowElement[] {
  const first = run[0];
  const style = first.box.style;
  const items: FlowListItem[] = run.map((r, i) => {
    const box = r.box;
    const item: FlowListItem = {
      // gaps[0] belongs to the whole list; later ones space the items.
      spaceBefore: i === 0 ? 0 : pt(gaps[i]),
    };
    // A table cannot carry display:list-item, so this run holds BlockBoxes
    // only; the guard is narrowing, not a claim about the data.
    if (box.kind === 'table') { item.text = ''; return item; }
    if (box.content.kind === 'inline') {
      for (const a of box.content.atomics)
        c.skipped.push(`image:${a.el.attrs.get('src') ?? ''}`);
      // An item must carry `text` or `blocks`; '' is the empty-item spelling.
      item.text = scaleRuns(box.content.runs);
      if ((item.text as TextRun[]).length === 0) item.text = '';
    } else {
      // `blocks` ALONE — setting `text: ''` beside it emits an extra empty
      // text element that owns the marker, so an item opening with a nested
      // list would draw its marker on a blank line.
      item.blocks = mapSiblings(box.content.children, r.contentWidth, c);
      if (item.blocks.length === 0) item.text = '';
    }
    return item;
  });
  const els = list(items, {
    ordered: ORDERED_TYPES.has(style.listStyleType),
    start: listStart(first),
    fontSize: pt(style.fontSize),
    align: alignOf(style.textAlign),
    spaceBefore,
  });
  return els;
}
```

Then rewrite `mapSiblings`'s loop to consume runs:

```ts
  let carry = 0;
  let i = 0;
  while (i < resolved.length) {
    carry += gaps[i];
    let els: FlowElement[];
    if (resolved[i].box.kind === 'list-item') {
      // A RUN, not an item: one list() per run is what keeps the ordinal
      // counter continuous. Per item, every marker reads "1.".
      const end = listRunEnd(resolved, i);
      els = mapList(resolved.slice(i, end), gaps.slice(i, end), pt(carry), c);
      i = end;
    } else {
      els = mapBox(resolved[i], pt(carry), c);
      i += 1;
    }
    if (els.length === 0) continue;   // the gap carries to the next producer
    out.push(...els);
    carry = 0;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cssflow-blocks.test.ts`
Expected: PASS.

If the `<ol start>` case fails, check `listStart` is reading the run's shared PARENT (`<ol>`) rather than the `<li>` itself.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. Task 2's `cssflow.test.ts` must still pass unedited — a list-run change that moves a plain-paragraph case means the run detection is claiming boxes it should not.

- [ ] **Step 7: Commit**

```bash
git add src/cssflow.ts test/cssflow-blocks.test.ts
git commit -m "feat(zch2.4): route headings through heading() and list runs through list()

A heading takes its level from the tag and its font and size from the
cascade, so heading()'s own defaults never double-apply; what it buys is
/H1../H6 in a tagged flow and keepWithNextEligible, both silent losses under
paragraph(). A run of consecutive display:list-item siblings becomes ONE
list() call, so the ordinal counter runs continuously and /L > /LI > /LBody
comes free. Nesting falls out of FlowListItem.blocks rather than needing a
second path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: reporting — `skipped` and `unsupported`

**Files:**
- Modify: `src/cssflow.ts` (only if a case below fails)
- Test: `test/cssflow-report.test.ts`

**Interfaces:**
- Consumes: `htmlFlowElements`, `CssFlowResult` from `./cssflow.js`.
- Produces: nothing new. This task pins the contract Tasks 2 and 3 wrote.

- [ ] **Step 1: Write the failing tests**

Create `test/cssflow-report.test.ts`.

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { htmlFlowElements } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;
const map = (src: string, width = 600) =>
  htmlFlowElements(parseHtml(`<!doctype html>${src}`), { width, resolveFamily });

function text(src: string): string {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src);
  placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
  return page.GetText();
}

describe('skipped', () => {
  it('names a table and does not throw', () => {
    const { skipped } = map('<p>before</p><table><tr><td>cell</td></tr></table>');
    expect(skipped).toContain('table');
  });

  it('still emits the text around a skipped table', () => {
    // Visible content beats a silently dropped subtree — svgdraw.ts's rule.
    expect(text('<p>before</p><table><tr><td>x</td></tr></table><p>after</p>'))
      .toContain('before');
    expect(text('<p>before</p><table><tr><td>x</td></tr></table><p>after</p>'))
      .toContain('after');
  });

  it('names an image by its src', () => {
    const { skipped } = map('<p>a <img src="pic.png"> b</p>');
    expect(skipped).toContain('image:pic.png');
  });

  it('still emits the text around a skipped image', () => {
    const t = text('<p>alpha <img src="pic.png"> bravo</p>');
    expect(t).toContain('alpha');
    expect(t).toContain('bravo');
  });

  it('names a float and STILL lays the box out in flow', () => {
    // zch2.10 is float placement. Until then a floated box is an ordinary
    // in-flow block, reported so a caller knows the layout is approximate.
    const { skipped } = map('<div style="float:left;width:100px">side</div><p>body</p>');
    expect(skipped).toContain('float:left');
    expect(text('<div style="float:left;width:100px">side</div><p>body</p>'))
      .toContain('side');
  });

  it('reports in document order', () => {
    const { skipped } = map(
      '<img src="a.png"><table><tr><td>x</td></tr></table><img src="b.png">');
    expect(skipped).toEqual(['image:a.png', 'table', 'image:b.png']);
  });

  it('is empty for a document that renders whole', () => {
    expect(map('<p>a</p><h1>b</h1><ul><li>c</li></ul>').skipped).toEqual([]);
  });
});

describe('unsupported', () => {
  it('passes an unknown property through from the cascade', () => {
    const { unsupported } = map('<p style="grid-template-columns:1fr">a</p>');
    expect(unsupported.some((u) => u.property === 'grid-template-columns'
      && u.reason === 'unknown-property')).toBe(true);
  });

  it('is empty for a document using only supported properties', () => {
    expect(map('<p style="color:red;margin:4px">a</p>').unsupported).toEqual([]);
  });
});

describe('option validation', () => {
  it('rejects a non-positive width', () => {
    expect(() => htmlFlowElements(parseHtml('<p>a</p>'), { width: 0, resolveFamily }))
      .toThrow(TypeError);
  });

  it('rejects a missing resolveFamily', () => {
    expect(() => htmlFlowElements(parseHtml('<p>a</p>'),
      { width: 100 } as unknown as { width: number; resolveFamily: FamilyResolver }))
      .toThrow(TypeError);
  });

  it('never throws on document content, however damaged', () => {
    expect(() => map('<p>a<div><table><tr><em>b</table></em></p></div>')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/cssflow-report.test.ts`
Expected: mostly PASS from Tasks 2 and 3. Any failure names a real gap — fix it in `src/cssflow.ts` rather than relaxing the assertion.

The two most likely: a table nested inside a block box may not reach `mapBox` if the walk short-circuits, and `unsupported` must be the SAME array `buildBoxes` returned so entries pushed during the inline walk are present.

- [ ] **Step 3: Typecheck and full suite**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add test/cssflow-report.test.ts src/cssflow.ts
git commit -m "test(zch2.4): pin skipped and unsupported reporting

A construct that does not render names itself and still contributes its
text - svgdraw.ts's rule, applied early because it is free here. A table
and an image are zch2.6's and a float's placement is zch2.10's, so each is
reported rather than dropped and those issues replace a skip instead of
adding a path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: mutation sweep, `CLAUDE.md`, and close

**Files:**
- Modify: `CLAUDE.md` (add `cssframe.ts` and `cssflow.ts` to the Source list)
- Modify: `docs/superpowers/plans/2026-08-31-css-flow-lowering.md` (record the sweep's results)

**Interfaces:**
- Consumes: the three test files from Tasks 1–4.
- Produces: nothing in code.

- [ ] **Step 1: Run the mutation sweep**

For each mutation below: apply it to `src/`, run `npm test`, record which cases redden, then **revert it**. A mutation that reddens NOTHING is recorded in `CLAUDE.md` as an uncovered rule — never quietly dropped.

| # | Mutation | Expected to redden |
|---|---|---|
| 1 | In `frameBoxes`, put the gap in `spaceAfter` instead of `spaceBefore` | `cssflow.test.ts` "puts the whole gap in spaceBefore" |
| 2 | In `BoxElement.padFor`, return `frame.minHeight - innerUsed` unconditionally (height exact, clipping) | `cssframe.test.ts` "lets content EXCEED a stated height" |
| 3 | In `scaleRuns`, return `runs` unchanged | `cssflow.test.ts` "scales every run font size by 0.75" |
| 4 | In `frameOf`, drop `pt()` from the insets and margins | `cssflow.test.ts` "indents content by a block box padding" |
| 5 | In `frameBoxes`, pass `first: true, last: true` for every slice | `cssframe.test.ts` "draws the top border on the first slice only" |
| 6 | In `frameBoxes`, give each `BoxElement` its own `BoxRun` | `cssframe.test.ts` "accumulates across siblings" |
| 7 | In `mapBox`, descend into a `TableBox` instead of skipping | `cssflow-report.test.ts` "names a table" |
| 8 | In `mapBox`, route every inline box through `paragraph()` | `cssflow-blocks.test.ts` "routes h1..h6 through heading()" |
| 9 | In `mapSiblings`, call `mapList` per item rather than per run | `cssflow-blocks.test.ts` "numbers an ordered list continuously" |
| 10 | In `mapSiblings`, drop `carry` (reset to 0 on an empty box) | `cssflow.test.ts` "carries a gap forward across a box that produced no elements" |

- [ ] **Step 2: Record the results in this plan**

Append a `## Mutation results` section naming, for each mutation, the cases that reddened — or **"reddened nothing"** where that is the truth.

- [ ] **Step 3: Add both modules to `CLAUDE.md`'s Source list**

Insert after the `cssinline.ts`/`cssbox.ts`/`cssresolve.ts`/`cssmargin.ts` entry, in that section's voice — invariants, and the notes a reader would otherwise have to rediscover:

```markdown
- **cssflow.ts**, **cssframe.ts** — the styled box tree lowered to
  `FlowElement[]` (`zch2.4`). `cssflow.ts` is the mapper and owns nothing
  else: it knows about columns, rects and pagination not at all, which is what
  makes `zch2.5`'s three entry points one implementation — `mdflow.ts`'s shape
  for `mdflow.ts`'s reason. `cssframe.ts` is the `BoxElement` decorator, its
  own module because it PAINTS and so cannot be the pure leaf the four
  `zch2.3` modules are.
  **Invariant:** resolution happens at BUILD time, against a width the caller
  supplies — NOT at `place()` time, which `zch2.3`'s design proposed. Three
  call sites read `spaceBefore` before `place()` ever runs
  (`flowplace.ts:63`, `flow.ts:1298`, and `flow.ts:1330`'s keep-with-next
  lookahead, which reads the NEXT element's), so a gap computed inside
  `place()` can never reach the engine.
  **Invariant:** the collapsed gap goes ENTIRELY in `spaceBefore` and every
  `spaceAfter` is 0, because `flow.ts` ADDS `spaceAfter + paragraphSpacing +
  spaceBefore` rather than collapsing. THE CALLER MUST PLACE WITH
  `paragraphSpacing: 0`. A fixture for this needs TWO DIFFERENT GAPS in one
  list: a uniform list totals identically under `spaceAfter`.
  **Invariant:** CSS px → points (× 0.75) crosses HERE and nowhere else, and
  it includes every `TextRun.fontSize` — `cssinline.ts` emits px because it
  reads `ComputedStyle.fontSize` directly. Miss that one and all text renders
  33% too large, which reads as a style choice rather than a fault.
  **Invariant:** a container never holds and paginates its children, so a
  block box lowers to ONE `BoxElement` per element its subtree produced. A
  split box needs no special case and a nested box is the decorator wrapping
  itself — `QuotedElement`'s shape.
  **Invariant:** `insetTop` and the top border belong to the FIRST slice,
  `insetBottom` and the bottom border to the LAST, and the side borders draw
  on every slice. Drop the flags and a split box draws its top border twice
  and its bottom never.
  **Invariant:** the background and borders are painted BEFORE the inner
  element draws, which is why `place()` measures first — `CodeBlockElement`'s
  route, and for the same reason: paint after and the fill covers the text.
  **Invariant:** `minHeight` is a MINIMUM and content taller than a stated
  height makes the box taller. `zch2.3` reports the number and provably cannot
  test the rule, so it lands here. A fixture whose content FITS measures
  nothing — a clipping build and a growing build agree there.
  **Invariant:** the shortfall is computed against a holder SHARED by every
  decorator of one box, a continuation included. Per-element state pads each
  slice to the full minimum, so a three-child 100pt box comes out 300. Third
  instance of the pattern behind a list item's marker, a split table's
  `TableTagger` and `QuoteStruct`.
  **Note:** `measure()` IGNORES `minHeight` and so under-reports for such a
  box — the padding reads the holder's running total, which a non-destructive
  dry run must not touch. Its only consumer is keep-with-next.
  **Invariant:** a heading is routed through `heading()` with the cascade's
  font and size passed EXPLICITLY, so the builder's own defaults never
  double-apply on top of the UA sheet's. What that buys is `/H1`..`/H6` and
  `keepWithNextEligible`; under `paragraph()` both are silent losses, since
  the rendering is identical.
  **Invariant:** a run of consecutive `display: list-item` siblings becomes
  ONE `list()`. Per item, the ordinal counter restarts and every marker reads
  `1.`. Nesting falls out of `FlowListItem.blocks` rather than `items`, so
  there is one path rather than two.
  **Invariant:** a construct that does not render names itself in `skipped`
  and still contributes its text — `svgdraw.ts`'s rule, applied early here
  because it is free. A table and an image are `zch2.6`'s, float PLACEMENT is
  `zch2.10`'s; each is reported so those issues REPLACE a skip rather than
  adding a path.
  **Note:** the root box's escaped top margin is DROPPED. `body { margin: 8px }`
  collapses up and out under rule 2, and both engines drop `spaceBefore` above
  the first element anyway. Consistent with Flow, a divergence from a browser.
  **Note on the oracle, and it is thinner than every CSS issue before it:**
  there is NONE. `zch2.3`'s headless-Chrome corpus measures used widths and
  collapsed gaps and stops short of anything positional; which builder a box
  goes through, where the ink lands and how a split box frames itself are not
  observable through `getComputedStyle` at all. Every rule here is held by a
  hand-built case and a mutation. `zch2.5` is where an end-to-end comparison
  becomes possible.
```

- [ ] **Step 4: Verify the module sweep is clean**

The repo's own check that no `src/*.ts` lacks a `CLAUDE.md` entry:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `cssflow.ts` and `cssframe.ts` no longer appear.

- [ ] **Step 5: Final gates**

Run: `npm run typecheck && npm test`
Expected: both green. No `CHANGELOG.md` entry — no public API moved.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/plans/2026-08-31-css-flow-lowering.md
git commit -m "docs(zch2.4): record the lowering invariants and the mutation sweep

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zch2.4 --reason "Shipped src/cssflow.ts and src/cssframe.ts.

The mapper knows nothing about columns, rects or pagination and hands back a flat array, so zch2.5's three entry points cost one implementation. Resolution moved to BUILD time against a caller-supplied width: zch2.3's design said place() time, and three call sites read spaceBefore before place() runs (flowplace.ts:63, flow.ts:1298, flow.ts:1330), so a gap computed there can never reach the engine.

Both rules zch2.3 deferred here are now covered: height-as-a-minimum (a fixture whose content EXCEEDS the stated height, since a fitting one measures nothing), and the collapsed gap in spaceBefore (a fixture with TWO DIFFERENT gaps, since a uniform list totals identically under spaceAfter).

A block box lowers to one BoxElement per leaf, sharing one holder - QuotedElement's shape, so a split box needs no special case and nesting is the decorator wrapping itself.

Tables, images and float placement are named in skipped and still contribute their text, so zch2.6 and zch2.10 replace a skip rather than adding a path.

[N] of 10 mutations reddened something; the sweep is recorded in the plan and any uncovered rule in CLAUDE.md.

Nothing exported from index.ts and no CHANGELOG entry - zch2.5 is the entry point. Unblocks zch2.5."

git add .beads && git commit -q -m "chore(beads): close zch2.4" && git push
```

---

## Mutation results

All ten reddened something; nothing here is held by reasoning alone. Run
against the four suites together (63 cases).

| # | Mutation | Reddened |
|---|---|---|
| 1 | Gap into `spaceAfter` rather than `spaceBefore` | **7** — the three-gap case, the additive-spacing case, and four downstream |
| 2 | `height` exact rather than a minimum (clip) | **3** — "lets content EXCEED a stated height", plus both accumulation cases |
| 3 | No px→pt on `TextRun.fontSize` | **3** — the run-size case and both heading-size cases |
| 4 | No px→pt on insets and margins | **2** — the padding-indent case and the float case |
| 5 | Every slice `first` and `last` | **3** — the inset case, the top/bottom border case, the accumulation case |
| 6 | A `BoxRun` per element rather than per box | **2** — "accumulates across siblings", "pads by nothing when already spent" |
| 7 | Descend into a `TableBox` | **3** — all three table-reporting cases |
| 8 | Every inline box through `paragraph()` | **2** — the `/H1`../`H6` case and the keep-with-next case |
| 9 | One `list()` per item rather than per run | **3** — continuous numbering, `<ol start>`, and the two-lists case |
| 10 | Drop the `carry` in `mapSiblings` | **1** — "carries a gap forward across a box that produced no elements" |

**Mutation 10 reddened NOTHING on its first run, and the fixture was wrong
rather than the rule.** It used an empty `<div>` between two paragraphs —
but `cssmargin.ts` already handles an empty block by pushing a 0 gap and
continuing the pending run, so that shape never reaches the carry at all and
passes with the carry deleted. A **skipped table** is the fixture that
exercises it: a table is not empty by `isEmpty`'s rule, so a real gap is
emitted against a box that then produces no element. Both are now in the
suite, the empty-`div` one labelled as `zch2.3`'s rule reaching through
rather than as cover for this one.

**Two defects the suite caught during implementation**, both recorded in
`CLAUDE.md`:

1. A box that splits charged its **bottom inset twice** — once on the slice
   that was `last` when it began, and again on the continuation. Caught by
   `cssframe.test.ts`'s continuation case on its first run.
2. `frameBoxes` **replaced** its inner element's `spaceBefore` rather than
   adding to it, so a `<body>` wrapper reported 0 for every gap computed
   between its children and flattened the document. Caught by four
   `cssflow.test.ts` cases at once. `quote()` already had the rule.

## Self-review notes

**Spec coverage.** Every section of the design maps to a task: the two modules → Tasks 1 and 2; build-time resolution → Task 2; units → Task 2; the mapping table → Tasks 2 (blocks), 3 (headings, lists), 4 (tables, images, floats); height-as-a-minimum and the shared holder → Task 1; the collapsed gap → Task 2; the two named consequences → Task 1 (holder accumulation, `measure` under-reporting) and Task 5 (`CLAUDE.md`, root margin); reporting → Task 4; the mutation list → Task 5, which carries all ten of the spec's mutations renumbered against the code.

**Interface consistency.** `frameBoxes(inner, frame, spacing?)`, `BoxFrame`, `FrameEdge`, `BoxRun`, `PT_PER_PX`, `htmlFlowElements(root, options)`, `CssFlowOptions`, `CssFlowResult` are spelled identically in Tasks 1–4 and in the spec's interface block.

**One deliberate divergence from the spec, and it is an improvement.** The spec's first draft said a split box re-starts its minimum-height accounting per column; working through `BoxElement` showed the holder is created once per box at build time and shared by continuations, so accumulating is what falls out and re-starting would be the extra code. The spec was corrected before this plan was written.
