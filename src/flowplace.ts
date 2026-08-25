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
  const stop = (remainder: FlowElement[]): PlaceElementsResult =>
    ({ usedHeight: rectTop - top, remainder });

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    // The gap above this element, dropped entirely at the rect's top.
    const gap = started ? pendingAfter + ps + (el.spaceBefore ?? 0) : 0;
    const elTop = top - gap;
    const availHeight = elTop - y;
    if (availHeight <= 0) return stop(elements.slice(i));

    const res = el.place({
      doc, page, x, top: elTop, width: w, availHeight,
      paragraphSpacing: ps, structParent: options.structParent,
    });

    if (res.drew) {
      top = elTop - res.usedHeight;
      started = true;
      if (res.remainder) return stop([res.remainder, ...elements.slice(i + 1)]);
      pendingAfter = el.spaceAfter ?? 0;
      continue;
    }
    // Nothing painted: a null remainder means the element was empty (discard);
    // anything else means it did not fit what is left, and the rect is done.
    if (res.remainder === null) continue;
    return stop(elements.slice(i));
  }
  return stop([]);
}
