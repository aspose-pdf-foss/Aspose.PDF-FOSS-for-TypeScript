/** A CSS float as the flow engine sees it (zch2.10): a FloatContent over an
 *  ordinary FlowElement[], and the wrapper element that carries the marker.
 *
 *  Invariant: `elementFloat` captures a Document, which is why it is INJECTED
 *  into cssflow.ts rather than constructed there. placeElements needs a
 *  Document; FloatingBox captures one at construction; Page.doc is PRIVATE and
 *  paintAt takes only a Page — so the adapter must capture one too, and
 *  cssflow.ts is a pure leaf that may not import document.js.
 *
 *  Invariant, and it is the reading zch2.15's own issue got wrong: the wrapper
 *  DOES hold a group, and splitting did NOT force it to become a decorator over
 *  one child. CLAUDE.md's hazard is a container with its OWN pagination loop —
 *  how a quote comes to break across a column under one rule and a list under
 *  another. placeElements is not a second loop; it is the shared one, extracted
 *  in zch2.5 precisely so a caller can lay elements into ONE rect and get the
 *  overflow back. A container that delegates to it is not what the rule forbids.
 *
 *  Invariant: measure(), paintAt() and splitPaint() all run the same arithmetic
 *  through placeElements/measureElements, so the three cannot disagree about
 *  one float. Two walks is how a float comes to measure one way and paint
 *  another. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type {
  FloatContent, FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from './flowelement.js';
import { placeElements, measureElements } from './flowplace.js';

/** A {@link FloatContent} backed by flow elements, painted through
 *  {@link placeElements}. Adds no chrome of its own: a CSS float's border,
 *  background and padding are already on those elements from `frameBoxes`. */
export function elementFloat(
  doc: Document, elements: FlowElement[], width: number, spacing: number,
  onDegraded?: () => void,
): FloatContent {
  return {
    width,
    spacing,
    // A CSS float degrades to ordinary flow rather than throwing, which is this
    // epic's rule; FloatingBox's contract is the opposite and it sets nothing.
    degradeOnOverflow: true,
    onDegraded,
    measure(): number {
      return measureElements(elements, width);
    },
    paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number {
      const h = measureElements(elements, width);
      // rect `y` is the BOTTOM edge, the convention placeElements takes.
      const { usedHeight } = placeElements(
        doc, page, elements, [x, topY - h, width, h],
        { paragraphSpacing: 0, structParent });
      return usedHeight;
    },
    // The SAME placeElements call paintAt makes, with a budget instead of the
    // measured height — which is the whole of splitting, because placeElements
    // has always returned the remainder and paintAt has always made one
    // impossible by asking for a rect exactly as tall as measure().
    splitPaint(
      page: Page, x: number, topY: number, maxHeight: number,
      side: 'left' | 'right', structParent?: StructElement,
    ): { height: number; tail?: FlowElement } {
      const { usedHeight, remainder } = placeElements(
        doc, page, elements, [x, topY - maxHeight, width, maxHeight],
        { paragraphSpacing: 0, structParent });
      return {
        height: usedHeight,
        // A full float element, not a bare FloatContent: the tail then has a
        // real degrade path of its own (floatElement's place()) and the engine
        // builds nothing. It leads a column, so it carries no leading gap.
        tail: remainder.length === 0
          ? undefined
          : floatElement(remainder, side, elementFloat(doc, remainder, width, spacing), 0, 0),
      };
    },
  };
}

/** The single element a float box lowers to.
 *
 *  ONE element rather than one per child: a marker on the first of several
 *  would leave the rest in the queue to be placed a second time. Its own
 *  `place()` is the DEGRADE path, reached only when the engine declines to
 *  float it. */
export function floatElement(
  elements: FlowElement[], side: 'left' | 'right', content: FloatContent,
  spaceBefore: number, spaceAfter: number,
): FlowElement {
  // Named rather than `this` inside an object literal: under `strict` an
  // object-literal method's `this` is implicitly typed, and the remainder has
  // to be the element itself.
  const el: FlowElement = {
    float: { side, content },
    spaceBefore,
    spaceAfter,
    place(ctx: PlaceContext): PlaceResult {
      const { usedHeight, remainder } = placeElements(
        ctx.doc, ctx.page, elements,
        [ctx.x, ctx.top - ctx.availHeight, ctx.width, ctx.availHeight],
        { paragraphSpacing: ctx.paragraphSpacing ?? 0, structParent: ctx.structParent });
      return {
        usedHeight,
        drew: usedHeight > 0,
        // A float never splits, so an overflowing degrade is reported as "did
        // not fit here" and retried whole in the next column.
        remainder: remainder.length === 0 ? null : el,
      };
    },
    measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
      const h = measureElements(elements, ctx.width);
      return { usedHeight: Math.min(h, ctx.availHeight), fits: h <= ctx.availHeight };
    },
  };
  return el;
}
