/** Place a list of {@link FlowElement}s into ONE rectangle on ONE page and hand
 *  back what did not fit.
 *
 *  This is `Flow.Render`'s loop with columns, floats, keep-with-next and page
 *  creation removed. It is a separate module rather than a mode of `Render`
 *  precisely so it cannot grow those back: a caller who wants columns wants a
 *  Flow. What it shares with the engine is the element protocol and the spacing
 *  rule, which is the part that must not drift. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { FlowElement } from './flowelement.js';
import {
  insetsAt, nextBoundary, pruneFloats, resolveFloatTop, type ActiveFloat,
} from './floatstack.js';

/** Options for {@link placeElements}. */
export interface PlaceElementsOptions {
  /** Gap inserted between consecutive elements, on top of their own
   *  `spaceAfter`/`spaceBefore`. Dropped above the first element. >= 0.
   *  Default 0. */
  paragraphSpacing?: number;
  /** Grouping element the placed content tags under. Omit for untagged output. */
  structParent?: StructElement;
}

/** Result of {@link placeElements}. */
export interface PlaceElementsResult {
  /** Vertical space consumed, measured from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, in order, ready to pass to another
   *  `placeElements` call. `[]` when everything was placed. A split element
   *  appears here as its continuation, not as the original. */
  remainder: FlowElement[];
}

/** Lay `elements` top-down into `rect` = `[x, y, w, h]`, where `y` is the
 *  BOTTOM edge (the convention `flowTextBlock` and `Page.AddTextBlock` use).
 *  Draws onto `page` and never creates one. */
export function placeElements(
  doc: Document, page: Page, elements: FlowElement[],
  rect: [number, number, number, number],
  options: PlaceElementsOptions = {},
): PlaceElementsResult {
  if (!Array.isArray(elements)) throw new TypeError('elements must be an array');
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, width, height] of finite numbers');
  const [x, y, w, h] = rect;
  if (!(w > 0)) throw new TypeError('rect width must be positive');
  if (!(h >= 0)) throw new TypeError('rect height must be non-negative');
  const ps = options.paragraphSpacing ?? 0;
  if (!Number.isFinite(ps) || ps < 0)
    throw new TypeError('paragraphSpacing must be a non-negative finite number');
  const rectTop = y + h;
  let top = rectTop;
  let started = false;
  let pendingAfter = 0;
  // Floats in force. The same bookkeeping Render does, over ONE rect: no next
  // column to carry to, so a float that does not fit is simply not floated.
  let floats: ActiveFloat[] = [];
  const stop = (remainder: FlowElement[]): PlaceElementsResult =>
    ({ usedHeight: rectTop - top, remainder });

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    floats = pruneFloats(floats, top);
    // The gap above this element, dropped entirely at the rect's top.
    const gap = started ? pendingAfter + ps + (el.spaceBefore ?? 0) : 0;
    const elTop = top - gap;

    // A float: paint it at the channel edge and record its band. It never
    // advances the pen past itself, exactly as in Render.
    const fl = el.float;
    if (fl !== undefined) {
      const fh = fl.content.measure();
      const fTop = resolveFloatTop(
        floats, fl.side, fl.content.width, fl.content.spacing, elTop, w);
      if (fTop - fh >= y - 1e-9) {
        const fx = fl.side === 'left' ? x : x + w - fl.content.width;
        fl.content.paintAt(page, fx, fTop, options.structParent);
        floats.push({
          side: fl.side, band: fl.content.width + fl.content.spacing, bottom: fTop - fh,
        });
        if (fTop === elTop) top = fTop;
        started = true;
        pendingAfter = 0;
        continue;
      }
      // Will not fit this rect: fall through and place it in flow. The marker
      // rides on a FlowElement, so that costs nothing.
      fl.content.onDegraded?.();
    }

    // Region: narrowed by the floats in force, and capped at the y where the
    // channel next widens so the element re-flows there. Render's rule, over a
    // rect whose bottom is `y`.
    const { left: insetL, right: insetR } = insetsAt(floats, top);
    const besideFloat = insetL > 0 || insetR > 0;
    const boundary = besideFloat ? nextBoundary(floats, top)! : 0;
    const elemX = x + insetL;
    const elemWidth = w - insetL - insetR;
    const availHeight = besideFloat ? elTop - boundary : elTop - y;
    // A left and a right band can swallow the rect between them: drop the pen
    // to where it reopens. Render skips to the next column here; a rect has
    // none, so the pen simply moves down.
    if (elemWidth <= 0) {
      if (boundary <= y) return stop(elements.slice(i));
      top = boundary;
      i--;
      continue;
    }
    if (availHeight <= 0) {
      // Beside a float with no room left in the band: resume below it.
      if (besideFloat && boundary > y) { top = boundary; i--; continue; }
      return stop(elements.slice(i));
    }

    const res = el.place({
      doc, page, x: elemX, top: elTop, width: elemWidth, availHeight,
      paragraphSpacing: ps, structParent: options.structParent,
    });

    if (res.drew) {
      top = elTop - res.usedHeight;
      started = true;
      if (res.remainder) {
        // Beside a float, the remainder resumes at full width below the band
        // rather than ending the rect.
        if (besideFloat && boundary > y) {
          elements = [...elements.slice(0, i), res.remainder, ...elements.slice(i + 1)];
          top = boundary;
          i--;
          continue;
        }
        return stop([res.remainder, ...elements.slice(i + 1)]);
      }
      pendingAfter = el.spaceAfter ?? 0;
      continue;
    }
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
  }
  return stop([]);
}

/** Height `elements` would occupy at `width` with unlimited room, including the
 *  gaps between them. Shares the gap arithmetic with {@link placeElements} —
 *  `spaceAfter + paragraphSpacing + spaceBefore`, dropped above the first — so
 *  the two cannot disagree about the same list. Draws nothing.
 *
 *  An element that measures 0 is SKIPPED rather than spaced around: that is
 *  what "nothing to draw" means since zch2.13, and charging a gap for it would
 *  leave a hole where an unencodable paragraph used to be. */
export function measureElements(
  elements: FlowElement[], width: number, paragraphSpacing = 0,
): number {
  let total = 0;
  let started = false;
  let pendingAfter = 0;
  for (const el of elements) {
    const m = el.measure?.({ width, availHeight: Infinity });
    if (m === undefined || m.usedHeight <= 0) continue;
    total += (started ? pendingAfter + paragraphSpacing + (el.spaceBefore ?? 0) : 0) + m.usedHeight;
    started = true;
    pendingAfter = el.spaceAfter ?? 0;
  }
  return total;
}
