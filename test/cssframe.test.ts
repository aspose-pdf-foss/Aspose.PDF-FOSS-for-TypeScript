import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { frameBoxes, type BoxFrame } from '../src/cssframe.js';
import type {
  FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from '../src/flowelement.js';
import type { Page } from '../src/page.js';

/** A page's content stream as latin1 text, for operator assertions. */
const cs = (page: Page): string => new TextDecoder('latin1').decode(page.Contents);

/** An inner element that consumes a fixed height, recording the geometry it
 *  was handed. A `total` larger than the height offered makes it split. */
class Stub implements FlowElement {
  seen: { x: number; top: number; width: number; availHeight: number } | undefined;
  constructor(private readonly total: number) {}
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

function ctxFor(): { doc: Document; page: Page } {
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

  it('declines rather than overflowing when the insets exceed the width', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(30)], { ...FRAME, insetLeft: 300, insetRight: 300 });
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(res.drew).toBe(false);
    expect(res.usedHeight).toBe(0);
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
    expect(afterFirst).not.toMatch(/0 665 400 3 re/);

    last.place({ doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
    // bottom border sits at the band's foot: 600 - (40 + 3) = 557.
    expect(cs(page)).toMatch(/0 557 400 3 re/);
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

  it('paints nothing for a fully transparent box', () => {
    const { doc, page } = ctxFor();
    const before = cs(page).length;
    const [el] = frameBoxes([new Stub(30)], FRAME);
    el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(cs(page).length).toBe(before);
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

  it('stretches the painted background to the padded height', () => {
    const { doc, page } = ctxFor();
    const [el] = frameBoxes([new Stub(30)],
      { ...FRAME, minHeight: 100, background: [1, 0, 0] });
    el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(cs(page)).toMatch(/0 600 400 100 re/);
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
    const res2 = res.remainder!.place(
      { doc, page, x: 0, top: 600, width: 400, availHeight: 500 });
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

  it('ADDS its gap to the inner element\'s own spacing rather than replacing it', () => {
    // A container's children carry the gaps computed BETWEEN them on their own
    // decorators. Report only the wrapper's own and every one of those reads 0,
    // which flattens a whole document; list() expresses item spacing the same
    // way, so swallowing it flattens every list too.
    const spaced: FlowElement = {
      spaceBefore: 7,
      spaceAfter: 3,
      measure: () => ({ usedHeight: 10, fits: true }),
      place: () => ({ usedHeight: 10, remainder: null, drew: true }),
    };
    const inner: FlowElement = {
      spaceBefore: 5,
      measure: () => ({ usedHeight: 10, fits: true }),
      place: () => ({ usedHeight: 10, remainder: null, drew: true }),
    };
    const [first, second] = frameBoxes([spaced, inner], FRAME, { spaceBefore: 12 });
    expect(first.spaceBefore).toBeCloseTo(12 + 7, 6);
    expect(first.spaceAfter).toBeCloseTo(3, 6);
    // A later sibling gets its OWN spacing and none of the wrapper's.
    expect(second.spaceBefore).toBeCloseTo(5, 6);
  });

  it('puts clear on the first slice only', () => {
    const [first, second] = frameBoxes(
      [new Stub(10), new Stub(10)], FRAME, { clear: 'both' });
    expect(first.clear).toBe('both');
    expect(second.clear).toBeUndefined();
  });

  it('delegates keep-with-next to the inner element', () => {
    const inner: FlowElement = {
      keepWithNextEligible: true,
      measure: () => ({ usedHeight: 10, fits: true }),
      place: () => ({ usedHeight: 10, remainder: null, drew: true }),
    };
    const [el] = frameBoxes([inner], FRAME);
    expect(el.keepWithNextEligible).toBe(true);
  });

  it('returns an empty array for an empty inner list', () => {
    expect(frameBoxes([], FRAME)).toEqual([]);
  });
});
