/** Resolving a box against a containing-block WIDTH: used widths, insets,
 *  margins and min-height.
 *
 *  Invariant: a PURE LEAF over cssbox.js, cssprop.js and cssvalue.js — types
 *  and arithmetic only. No Document, no PDF object module, no `node:` import.
 *
 *  Invariant: it takes a WIDTH as an argument rather than baking one in, and
 *  that is forced rather than preferred. A percentage margin resolves against
 *  the containing block's WIDTH — vertical margins included, which is the
 *  part that surprises — so nothing here can be precomputed. flow.ts supplies
 *  the width at place() time.
 *
 *  Invariant: a percentage HEIGHT is ignored and reported as 0. It resolves
 *  against the containing block's HEIGHT, which a module that positions
 *  nothing does not have; 0 means content-sized, which is what the box would
 *  have been anyway.
 *
 *  Invariant: `measure` is INJECTED, the seam grayimage.ts uses for
 *  resolve/inflate. Shrink-to-fit needs intrinsic widths, and measuring text
 *  means layoutRuns, which would drag a font stack into a pure leaf. */

import type { BoxNode } from './cssbox.js';
import type { ComputedStyle } from './cssprop.js';
import { resolveLengthPct, fixedPx } from './cssvalue.js';
import type { LengthPct } from './cssvalue.js';

export interface ResolvedBox {
  box: BoxNode;
  /** The content box's width. */
  contentWidth: number;
  insetLeft: number; insetRight: number;
  insetTop: number; insetBottom: number;
  /** Resolved to px, BEFORE collapsing. cssmargin.ts collapses them. */
  marginTop: number; marginBottom: number;
  marginLeft: number; marginRight: number;
  /** From `height`, treated as a MINIMUM. 0 when `auto`. */
  minHeight: number;
}

/** Intrinsic widths of a box's own content, for a float's shrink-to-fit. */
export type MeasureFn = (box: BoxNode) => { min: number; max: number };

/** A length or percentage against the containing WIDTH.
 *
 *  It DELEGATES rather than doing the arithmetic, and that is the point: a
 *  `min(50%, 100px)` arrives as a retained expression rather than as a pair,
 *  and cssvalue.ts is the one place that knows how to resolve either. The
 *  local name survives because it is what a dozen call sites below read as. */
function px(v: LengthPct, width: number): number {
  return resolveLengthPct(v, width);
}

/** A margin, which may also be `auto`. `auto` is reported as undefined so the
 *  §10.3.3 case analysis can see which of the three are open. */
function marginPx(v: ComputedStyle['marginTop'], width: number): number | undefined {
  return v === 'auto' ? undefined : px(v, width);
}

/** A border edge's USED width, which is 0 when its style is `none` or
 *  `hidden` (CSS 2.1 §8.5.3) however wide the computed value is.
 *
 *  This is not a nicety. The initial `border-width` is `medium` — 3px — and
 *  the initial `border-style` is `none`, so EVERY box that states no border
 *  at all carries a computed 3px per edge. Adding it would take 6px off the
 *  content width of every element in every document, which is exactly what
 *  the first run of this module's tests reported: 794 where 800 was right.
 *  Chrome reports the used 0 through getComputedStyle for the same reason,
 *  which is why test/fixtures/css-cascade/PROVENANCE.md had to exclude
 *  border-width from that corpus. */
function borderPx(width: number, style: ComputedStyle['borderTopStyle']): number {
  return style === 'none' || style === 'hidden' ? 0 : width;
}

export function resolveBoxes(
  boxes: BoxNode[], containingWidth: number, measure?: MeasureFn,
): ResolvedBox[] {
  return boxes.map((box) => resolveOne(box, containingWidth, measure));
}

function resolveOne(box: BoxNode, cw: number, measure?: MeasureFn): ResolvedBox {
  const s = box.style;

  const insetLeft = borderPx(s.borderLeftWidth, s.borderLeftStyle) + px(s.paddingLeft, cw);
  const insetRight = borderPx(s.borderRightWidth, s.borderRightStyle) + px(s.paddingRight, cw);
  const insetTop = borderPx(s.borderTopWidth, s.borderTopStyle) + px(s.paddingTop, cw);
  const insetBottom = borderPx(s.borderBottomWidth, s.borderBottomStyle)
    + px(s.paddingBottom, cw);

  // Vertical margins resolve against the WIDTH, and `auto` on one is 0.
  const marginTop = marginPx(s.marginTop, cw) ?? 0;
  const marginBottom = marginPx(s.marginBottom, cw) ?? 0;

  let mLeft = marginPx(s.marginLeft, cw);
  let mRight = marginPx(s.marginRight, cw);
  const stated = s.width === 'auto' ? undefined : px(s.width, cw);

  // A FLOAT with an auto width is shrink-to-fit rather than fill.
  let width: number | undefined = stated;
  if (box.float !== 'none') {
    if (width === undefined) {
      const avail = Math.max(0, cw - (mLeft ?? 0) - (mRight ?? 0) - insetLeft - insetRight);
      if (measure !== undefined) {
        const { min, max } = measure(box);
        width = Math.max(min, Math.min(max, avail));
      } else {
        width = avail;
      }
    }
    // CSS 2.1 §10.3.5: on a FLOAT an `auto` margin computes to 0, whatever the
    // width. It used to be done only for an auto width, so a float with a
    // STATED width fell through to §10.3.3's over-constrained rule and absorbed
    // the whole leftover column into margin-right — 326pt for a 150px float in
    // a 601px container. Nothing noticed until zch2.10 read those margins: it
    // made the excluded band absurd AND drove the float's own content width
    // negative, so it measured 0 and drew nothing.
    mLeft ??= 0;
    mRight ??= 0;
  }

  // CSS 2.1 §10.3.3, which governs a block-level, non-replaced element IN
  // NORMAL FLOW — and so not a float, whose width and margins §10.3.5 has
  // already settled above. Running it for a float reaches the over-constrained
  // branch (nothing is auto by then) and hands margin-right the whole leftover
  // column: 326pt for a 150px float in a 601px container, which is both an
  // absurd excluded band and a negative content width for the float's own
  // contents. Nothing read those margins before zch2.10, so nothing noticed.
  if (box.float !== 'none') {
    // Settled above by §10.3.5: width is stated or shrink-to-fit, and an auto
    // margin is 0. The three re-assignments are NARROWING for TypeScript, which
    // cannot see that across the branch — each is already its own value.
    width ??= 0;
    mLeft ??= 0;
    mRight ??= 0;
  } else if (width === undefined) {
    // `width: auto` absorbs the remainder; an `auto` margin becomes 0.
    mLeft ??= 0;
    mRight ??= 0;
    width = cw - mLeft - mRight - insetLeft - insetRight;
  } else if (mLeft === undefined && mRight === undefined) {
    // Both margins auto: the remainder splits EQUALLY. This is how
    // `margin: 0 auto` centres, and splitting it unevenly gives a document
    // that looks fine and is never centred.
    const rest = cw - width - insetLeft - insetRight;
    mLeft = rest / 2;
    mRight = rest / 2;
  } else if (mLeft === undefined) {
    mLeft = cw - width - insetLeft - insetRight - (mRight as number);
  } else if (mRight === undefined) {
    mRight = cw - width - insetLeft - insetRight - mLeft;
  } else {
    // Nothing auto. If the numbers do not add up the box is over-constrained
    // and margin-right gives way — which is what makes it the only value that
    // can come out negative.
    mRight = cw - width - insetLeft - insetRight - mLeft;
  }

  // A percentage height resolves against a height we do not have; 0 means
  // content-sized, which is what the box would have been anyway. `fixedPx`
  // is that same refusal widened by exactly nothing: a math function whose
  // value depends on the basis is as unresolvable here as a bare percentage.
  const minHeight = s.height === 'auto' ? 0 : fixedPx(s.height) ?? 0;

  return {
    box,
    contentWidth: Math.max(0, width as number),
    insetLeft, insetRight, insetTop, insetBottom,
    // Both are assigned in every branch of the case analysis above; TypeScript
    // cannot see that across four branches, so the assertion is narrowing
    // rather than a claim.
    marginTop, marginBottom, marginLeft: mLeft as number, marginRight: mRight as number,
    minHeight,
  };
}
