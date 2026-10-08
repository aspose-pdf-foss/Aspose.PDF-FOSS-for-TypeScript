/** A laid-out run becomes a /Link annotation.
 *
 *  Its own module because stamp.ts is the layout-and-ink layer while this is
 *  object-graph work — the split redactannots.ts makes against redact.ts — and
 *  because it holds stamp.ts's dependency on annotation.ts to one symbol.
 *  Nothing in annotation.ts's transitive import graph reaches stamp.ts, so the
 *  edge closes no cycle. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { TextRun } from './textdecor.js';
import { addLink, type LinkAnnotation } from './annotation.js';
import { appendContentKid, retargetMcid } from './structwrite.js';

/** A link whose target is not known when its run is laid out (v9j3.3.4): a
 *  note mark, whose note is placed later. The run is laid out and tagged like
 *  any linked run, but no annotation is made: its box (and, when tagged, the
 *  /Link element holding its glyphs) is handed to `onBox`, and whoever made
 *  the link writes the annotation once the target exists. @internal */
export interface DeferredLink {
  readonly deferred: true;
  onBox(page: Page, rect: [number, number, number, number], elem?: StructElement): void;
}

/** What a run's `link` may hold inside the authoring layer: a /URI, or a
 *  deferred note link. @internal */
export type RunLink = string | DeferredLink;

/** `TextRun` as the authoring layer READS it (mba3). The public type says
 *  `link?: string`, and a note mark's `DeferredLink` rides in the same field,
 *  so every module that reads a run's link goes through this type — which
 *  makes the compiler refuse a reader that assumes a string. A `TextRun` is
 *  assignable to it, so no caller changes. @internal */
export type LinkedRun = Omit<TextRun, 'link'> & { link?: RunLink };

/** Whether `v` is a {@link DeferredLink}. @internal */
export function isDeferredLink(v: unknown): v is DeferredLink {
  return typeof v === 'object' && v !== null && (v as DeferredLink).deferred === true
    && typeof (v as DeferredLink).onBox === 'function';
}

/** One clickable box: a linked run's extent on ONE line. A run broken across a
 *  line break yields one of these per line, which is why the destination is
 *  repeated rather than shared. */
export interface RunLinkBox {
  /** The /URI this box links to, or a deferred target (v9j3.3.4). */
  target: RunLink;
  /** Annotation rect [llx, lly, urx, ury] — the /Rect convention, NOT the
   *  [x, y, w, h] the stamping layer passes around. */
  rect: [number, number, number, number];
  /** The marked-content id of this box's glyphs, when the block is tagged.
   *  The /Link element's /K hangs on it. */
  mcid?: number;
}

/** Place a /Link over each box, and — when `parent` is given — a /Link structure
 *  element holding the boxes' marked content plus their annotations.
 *
 *  ONE element per consecutive run of boxes sharing a destination, not one per
 *  box: a link broken across a line break is a single link, and two elements
 *  would have a screen reader announce it twice. Consecutive-and-equal is
 *  exactly the grouping stamp.ts produces, since a run contributes at most one
 *  box per line and its boxes arrive in line order.
 *
 *  `border: 0` because the text style already draws the underline; a
 *  viewer-drawn frame on top would be a second, uglier one. Zero-area boxes are
 *  skipped: a run that laid out to nothing has no glyphs to click.
 *
 *  A deferred box (v9j3.3.4) gets its /Link element and marked content here,
 *  and its annotation from the owner of the link. */
export function placeRunLinks(
  doc: Document, page: Page, boxes: RunLinkBox[], parent?: StructElement,
): LinkAnnotation[] {
  const out: LinkAnnotation[] = [];
  let group: { target: string | DeferredLink; elem: StructElement } | undefined;
  for (const b of boxes) {
    if (!(b.rect[2] > b.rect[0]) || !(b.rect[3] > b.rect[1])) continue;
    const deferred = isDeferredLink(b.target);
    const annot = deferred ? undefined : addLink(doc, page, {
      rect: b.rect,
      action: { type: 'uri', uri: b.target as string },
      border: 0,
    });
    if (annot !== undefined) out.push(annot);
    let elem: StructElement | undefined;
    if (parent !== undefined) {
      if (group === undefined || group.target !== b.target)
        group = { target: b.target, elem: parent.Append('Link') };
      elem = group.elem;
      // The glyphs first, then the annotation: /K is reading order, and the words
      // are what a reader meets before the link target.
      if (b.mcid !== undefined) {
        // The id was reserved against the block being laid out, because the /Link
        // did not exist yet; point the parent tree at its real owner.
        retargetMcid(doc, elem, page, b.mcid);
        appendContentKid(doc, elem.Dict, b.mcid, doc.pageRef(page.Number));
      }
      if (annot !== undefined) elem.AddAnnotation(annot);
    }
    // A deferred target's annotation is written by its owner, later.
    if (deferred) (b.target as DeferredLink).onBox(page, b.rect, elem);
  }
  return out;
}
