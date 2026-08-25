// DOCX textbox mode: positioned groups and image placements to the inner XML of
// <w:body>. Pure — it names an image by a rid a sink already handed it and
// touches no Document, the split svgdraw.ts/svgembed.ts already make.
import { paragraphXml, runXml, drawingXml, type FrameProps } from './docxflow.js';
import { TWIPS_PER_PT } from './docxstyles.js';
import type { TextGroup } from './docxgroup.js';

/** An image the package has already registered, and where the page drew it. */
export interface ImagePlacement {
  rid: string;
  /** Page-space axis box [x0,y0,x1,y1] of the drawn image. */
  quad: [number, number, number, number];
  alt?: string;
}

export interface TextboxPage {
  /** Page-space sizing box [x0,y0,x1,y1] — CropBox, or MediaBox under box:'media'. */
  box: [number, number, number, number];
  groups: TextGroup[];
  images: ImagePlacement[];
  /** Page-sized backdrop image, emitted first so the frames stack above it.
   *
   *  Glyph-less by construction — `docxexport.ts` renders it through
   *  `renderPageGraphicsToPng`. The frames below are visible, so a backdrop
   *  carrying glyphs would draw every one of them twice (`tvc4`). */
  backdrop?: { rid: string };
}

/** **Invariant:** a frame errs wide, never narrow. Word re-measures the text
 *  with a substituted face, and a frame narrower than the result wraps to a
 *  second line and displaces everything below it inside that frame;
 *  `w:wrap="none"` means an over-wide frame displaces nothing at all. The two
 *  errors are not symmetric, so the headroom is deliberately generous.
 *
 *  Starting points, to be tuned against fixtures rather than derived. */
const WIDTH_HEADROOM = 1.25;
const PAD_PT = 2;

const tw = (pt: number): number => Math.round(pt * TWIPS_PER_PT);

/** A page-space quad as a page-anchored frame, in twips.
 *
 *  **Invariant:** the frame's top comes from `quad[3]`, not from a font ascent.
 *  A group's quad runs `baseline .. baseline + fontSize`, so its top edge is
 *  already where Word starts the line box. `htmlfixed.ts` subtracts
 *  `ascent * dev` because a CSS `top` is the em-box top and it knows the
 *  substituted face's ascent; inventing an ascent for a face we did not choose
 *  would be a guess with nothing behind it. */
function frameFor(
  quad: [number, number, number, number], box: [number, number, number, number],
  headroom: number, pad: number,
): FrameProps {
  const x = quad[0] - box[0];
  const y = box[3] - quad[3];
  const avail = Math.max(0, (box[2] - box[0]) - x);
  const w = Math.min(Math.max(0, quad[2] - quad[0]) * headroom + pad, avail);
  return { x: tw(x), y: tw(y), w: tw(w), h: tw(Math.max(0, quad[3] - quad[1])) };
}

/** `w:sectPr` for one page, stated in that page's own size.
 *
 *  **Invariant:** zero margins. Frames anchor to the page edge regardless, but
 *  the unframed anchor paragraph does not — a default 1" margin would push it,
 *  and on a short page give it a page of its own. */
function sectPr(box: [number, number, number, number]): string {
  return `<w:sectPr><w:pgSz w:w="${tw(box[2] - box[0])}" w:h="${tw(box[3] - box[1])}"/>`
    + '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"'
    + ' w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
}

/** One picture in its own frame — the same `drawingXml` flow mode places
 *  inline, wrapped rather than reimplemented. An image frame takes no width
 *  headroom: a picture is exactly as wide as it was drawn. */
function pictureFrame(
  rid: string, quad: [number, number, number, number],
  box: [number, number, number, number], alt: string, id: number,
): string {
  const wPt = Math.max(1e-3, quad[2] - quad[0]);
  const hPt = Math.max(1e-3, quad[3] - quad[1]);
  return paragraphXml(`<w:r>${drawingXml(rid, wPt, hPt, alt, id)}</w:r>`,
    { frame: frameFor(quad, box, 1, 0) });
}

/** Every frame paragraph for one page, backdrop first. */
function pageFrames(p: TextboxPage, nextDrawingId: () => number): string[] {
  const out: string[] = [];

  // **Invariant:** the backdrop is emitted FIRST. Frames stack in document
  // order, so a backdrop emitted after the text hides the page.
  if (p.backdrop) out.push(pictureFrame(p.backdrop.rid, p.box, p.box, '', nextDrawingId()));

  for (const img of p.images)
    out.push(pictureFrame(img.rid, img.quad, p.box, img.alt ?? '', nextDrawingId()));

  for (const g of p.groups) {
    if (!g.text) continue;
    // A skewed group is placed unrotated at its quad's top-left: a frame has no
    // rotation, and visible ink beats silently dropped content.
    out.push(paragraphXml(runXml(g.text, {
      size: g.fontSize,
      ...(g.color ? { color: g.color } : {}),
      ...(g.bold ? { bold: true } : {}),
      ...(g.italic ? { italic: true } : {}),
    }), { frame: frameFor(g.quad, p.box, WIDTH_HEADROOM, PAD_PT) }));
  }
  return out;
}

/** Map positioned pages to the inner XML of `<w:body>`.
 *
 *  **Invariant:** a non-final section's `w:sectPr` lives inside the LAST
 *  paragraph's `w:pPr`; only the final section's is a direct child of
 *  `w:body`. The two spellings are not interchangeable and the wrong one is a
 *  file Word refuses — the same class of rule as `w:tcPr`'s ordered children.
 *
 *  **Invariant:** every page emits one ordinary, unframed paragraph. A framed
 *  paragraph is lifted out of the flow, so a page of nothing but frames has no
 *  flow content and its section collapses into the next.
 *
 *  **Invariant:** the drawing id counter spans the whole document, not one
 *  page. `wp:docPr@id` must be unique across `document.xml`, and Word calls a
 *  file with a duplicate corrupt in some builds and opens it in others. */
export function docxTextboxBody(pages: TextboxPage[]): string {
  let drawingId = 0;
  const nextDrawingId = (): number => ++drawingId;
  const out: string[] = [];

  pages.forEach((p, i) => {
    out.push(...pageFrames(p, nextDrawingId));
    if (i === pages.length - 1) {
      out.push(paragraphXml(''));          // the anchor paragraph
      out.push(sectPr(p.box));             // final section: a direct body child
    } else {
      // The anchor paragraph doubles as this section's break carrier.
      out.push(`<w:p><w:pPr>${sectPr(p.box)}</w:pPr></w:p>`);
    }
  });
  return out.join('');
}
