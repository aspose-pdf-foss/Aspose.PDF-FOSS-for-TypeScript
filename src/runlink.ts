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
import { addLink, type LinkAnnotation } from './annotation.js';
import { appendContentKid, retargetMcid } from './structwrite.js';

/** One clickable box: a linked run's extent on ONE line. A run broken across a
 *  line break yields one of these per line, which is why the destination is
 *  repeated rather than shared. */
export interface RunLinkBox {
  uri: string;
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
 *  skipped: a run that laid out to nothing has no glyphs to click. */
export function placeRunLinks(
  doc: Document, page: Page, boxes: RunLinkBox[], parent?: StructElement,
): LinkAnnotation[] {
  const out: LinkAnnotation[] = [];
  let group: { uri: string; elem: StructElement } | undefined;
  for (const b of boxes) {
    if (!(b.rect[2] > b.rect[0]) || !(b.rect[3] > b.rect[1])) continue;
    const annot = addLink(doc, page, {
      rect: b.rect,
      action: { type: 'uri', uri: b.uri },
      border: 0,
    });
    out.push(annot);
    if (parent === undefined) continue;
    if (group === undefined || group.uri !== b.uri)
      group = { uri: b.uri, elem: parent.Append('Link') };
    // The glyphs first, then the annotation: /K is reading order, and the words
    // are what a reader meets before the link target.
    if (b.mcid !== undefined) {
      // The id was reserved against the block being laid out, because the /Link
      // did not exist yet; point the parent tree at its real owner.
      retargetMcid(doc, group.elem, page, b.mcid);
      appendContentKid(doc, group.elem.Dict, b.mcid, doc.pageRef(page.Number));
    }
    group.elem.AddAnnotation(annot);
  }
  return out;
}
