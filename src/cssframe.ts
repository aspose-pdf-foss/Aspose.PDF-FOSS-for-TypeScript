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

import type {
  FlowClear, FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from './flowelement.js';
import { fillRect, paintDecoration } from './flowblock.js';
import type { BuiltSvg } from './svgembed.js';
import { enc } from './serialize.js';
import {
  num, ensureOwnResources, ensureOwnSubdict, freshKey, appendContent,
} from './pagecontent.js';

/** One border edge, in points. */
export interface FrameEdge { width: number; color: [number, number, number] }

/** What one CSS box reserves and paints. Every length is in POINTS. */
export interface BoxFrame {
  marginLeft: number;
  marginRight: number;
  /** Border + padding, per side. */
  insetLeft: number;
  insetRight: number;
  insetTop: number;
  insetBottom: number;
  background?: [number, number, number];
  borderTop?: FrameEdge;
  borderRight?: FrameEdge;
  borderBottom?: FrameEdge;
  borderLeft?: FrameEdge;
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
    readonly spaceAfter: number,
    readonly clear: FlowClear | undefined,
    private readonly run: BoxRun,
  ) {}

  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }

  /** Forwarded to the element inside (`zch2.16`). The engine fires this on
   *  whatever it holds, which is always the OUTERMOST frame — so without the
   *  forwarding a compromise would be reported against the outermost box that
   *  wrapped the content, which for any document is `<html>`. Reading through
   *  is also what lets cssflow.ts's `attribute` see that an inner box has
   *  already claimed the element and leave it alone. */
  get onCompromise(): ((how: 'scaled' | 'overflow') => void) | undefined {
    return this.inner.onCompromise;
  }

  set onCompromise(fn: ((how: 'scaled' | 'overflow') => void) | undefined) {
    this.inner.onCompromise = fn;
  }

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

  private get padTop(): number { return this.first ? this.frame.insetTop : 0; }
  private get padBottom(): number { return this.last ? this.frame.insetBottom : 0; }

  /** The inner element's width, derived from the context rather than from the
   *  resolved contentWidth, so a caller that hands a different width degrades
   *  instead of overflowing. */
  private innerWidth(width: number): number {
    const f = this.frame;
    return width - f.marginLeft - f.marginRight - f.insetLeft - f.insetRight;
  }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const width = this.innerWidth(ctx.width);
    const avail = ctx.availHeight - this.padTop - this.padBottom;
    if (width <= 0 || avail <= 0) return { usedHeight: 0, fits: false };
    const m = this.inner.measure?.({ width, availHeight: avail })
      ?? { usedHeight: 0, fits: false };
    // A zero-height inner element with nothing left over is EMPTY, not unfitted:
    // pass its verdict through, so the discard survives a chain of nested boxes.
    if (m.usedHeight === 0) return { usedHeight: 0, fits: m.fits };
    return { usedHeight: this.padTop + m.usedHeight + this.padBottom, fits: m.fits };
  }

  place(ctx: PlaceContext): PlaceResult {
    const f = this.frame;
    const width = this.innerWidth(ctx.width);
    let avail = ctx.availHeight - this.padTop - this.padBottom;
    if (width <= 0 || avail <= 0) return { usedHeight: 0, remainder: this, drew: false };

    const measure = (h: number): { usedHeight: number; fits: boolean } =>
      this.inner.measure?.({ width, availHeight: h }) ?? { usedHeight: 0, fits: false };

    // Measure first so the fill and the borders can be painted at the right
    // height BEFORE the inner element draws over them.
    let probe = measure(avail);

    // A box that does NOT end here owes no bottom inset, so the room reserved
    // for it goes back to the content. Charge it on both this slice and the
    // continuation and a split box pays its bottom inset twice — which is
    // exactly what the first build did.
    if (!probe.fits && this.padBottom > 0) {
      const wider = measure(ctx.availHeight - this.padTop);
      // If the extra room makes it fit, the bottom inset has nowhere to go, so
      // the box must still split and the narrower probe is the right one.
      if (!wider.fits) { avail = ctx.availHeight - this.padTop; probe = wider; }
    }
    if (probe.usedHeight === 0) {
      // Nothing drawn: either undrawable (discard) or it did not fit here.
      return { usedHeight: 0, remainder: probe.fits ? null : this, drew: false };
    }

    const padBottom = probe.fits ? this.padBottom : 0;
    const pad = this.padFor(probe.usedHeight, probe.fits, avail);
    const used = this.padTop + probe.usedHeight + pad + padBottom;
    this.paint(ctx, used);

    const res = this.inner.place({
      ...ctx,
      x: ctx.x + f.marginLeft + f.insetLeft,
      width,
      top: ctx.top - this.padTop,
      availHeight: avail,
    });
    this.run.used += this.padTop + res.usedHeight + pad + padBottom;

    return {
      usedHeight: used,
      drew: res.drew,
      remainder: res.remainder === null ? null
        : new BoxElement(res.remainder, f, false, this.last, 0, this.spaceAfter,
          undefined, this.run),
    };
  }

  /** The shortfall this slice owes the box's stated minimum. Only the LAST
   *  slice of a box that fully placed owes anything, and never more than the
   *  room actually left. */
  private padFor(innerUsed: number, fits: boolean, avail: number): number {
    if (!this.last || !fits || this.frame.minHeight <= 0) return 0;
    const total = this.run.used + this.padTop + innerUsed + this.padBottom;
    return Math.max(0, Math.min(this.frame.minHeight - total, avail - innerUsed));
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

    const edge = (
      e: FrameEdge | undefined, x: number, y: number, w: number, h: number,
    ): void => {
      if (e === undefined || !(e.width > 0) || !(w > 0) || !(h > 0)) return;
      paintDecoration(ctx, fillRect(x, y, w, h, e.color));
    };
    // Side borders on EVERY slice; top and bottom only where the box begins
    // and ends, or a split box draws its top border twice and its bottom never.
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
 *  carries this box's collapsed gap and its `clear`, the last owns the bottom
 *  inset and the minimum-height padding.
 *
 *  **Invariant:** a wrapper ADDS this box's gap to the inner element's own
 *  spacing rather than REPLACING it — `quote()`'s rule, and load-bearing in
 *  both directions here. The gaps between a container's children are computed
 *  on those children and carried on their own decorators, so a wrapper that
 *  reported only its own would report 0 for every one of them and collapse a
 *  whole document's vertical rhythm; and `list()` expresses item spacing the
 *  same way, so swallowing it flattens every list. */
export function frameBoxes(
  inner: FlowElement[],
  frame: BoxFrame,
  spacing: { spaceBefore?: number; clear?: FlowClear } = {},
): FlowElement[] {
  if (inner.length === 0) return [];
  // A FLOAT passes through UNWRAPPED (zch2.10). A float is out of flow, so the
  // container's per-child frame slicing does not apply to it: its own frame is
  // already on the elements inside its marker, and wrapping it here would both
  // give it the CONTAINER's border and swallow the marker, which is how the
  // first build came to lay every float out in flow while reporting nothing.
  // Excluding it from the run also keeps the first/last flags — and so the
  // container's top and bottom insets — on the elements that are actually in
  // flow.
  const flow = inner.filter((el) => el.float === undefined);
  const run: BoxRun = { used: 0 };
  let n = 0;
  return inner.map((el) => {
    if (el.float !== undefined) return el;
    const i = n++;
    return new BoxElement(
      el, frame, i === 0, i === flow.length - 1,
      (i === 0 ? (spacing.spaceBefore ?? 0) : 0) + (el.spaceBefore ?? 0),
      el.spaceAfter ?? 0,
      i === 0 ? spacing.clear : undefined,
      run,
    );
  });
}

/** A built SVG form, drawn into the element's own box.
 *
 *  The import already happened at BUILD time (zch2.12) — which is what lets the
 *  importer's report reach the one AddHtml hands back — so this only PLACES
 *  what exists. It lives here rather than in the pure leaf because it paints,
 *  the same split this module already makes for BoxElement.
 *
 *  A figure never SPLITS: it is one graphic, so too tall for the column means
 *  the next column, which is what returning itself as the remainder does. */
export function svgFigure(built: BuiltSvg, size: [number, number]): FlowElement {
  const [w, h] = size;
  const el: FlowElement = {
    place(ctx: PlaceContext): PlaceResult {
      if (ctx.availHeight < h) return { usedHeight: 0, remainder: el, drew: false };
      const res = ensureOwnResources(ctx.doc, ctx.page);
      const xobjs = ensureOwnSubdict(ctx.doc, res, 'XObject');
      const key = freshKey(xobjs, 'Fm');
      xobjs.set(key, built.ref);
      const rect: [number, number, number, number] = [ctx.x, ctx.top - h, w, h];
      const m = built.matrixFor(rect);
      appendContent(ctx.doc, ctx.page, enc(
        `q\n${num(rect[0])} ${num(rect[1])} ${num(w)} ${num(h)} re\nW n\n`
        + `${m.map(num).join(' ')} cm\n/${key} Do\nQ`));
      return { usedHeight: h, remainder: null, drew: true };
    },
    measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
      return { usedHeight: h, fits: ctx.availHeight >= h };
    },
  };
  return el;
}
