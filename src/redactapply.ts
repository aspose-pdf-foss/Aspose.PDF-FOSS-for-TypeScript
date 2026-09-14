// The annotation-driven half of redaction: consume /Redact marks and apply them.
//
// redact.ts owns the destructive content surgery (glyph rewriting, image
// re-encoding, resource pruning) and imports no annotation code. This module
// reads annotation dicts and paints overlays — a different job with a different
// dependency set, so it lives beside redact.ts rather than inside it.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { RedactAnnotation, addRedact, rectToQuad, type RedactAnnotationOptions } from './annotation.js';
import { searchText, type SearchOptions } from './textedit.js';
import { quadsBBox } from './annotdraw.js';
import { redactRegions, paintRedactionBoxes } from './redact.js';
import { measure } from './metrics.js';
import { stampText } from './stamp.js';
import { encodeWinAnsi } from './encoding.js';
import {
  appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, num, wrapMarkedContent,
} from './pagecontent.js';
import { allocContentMcid } from './structwrite.js';
import type { StructElement } from './struct.js';
import { placementMatrix } from './text.js';
import { isArray, isRef, PdfObject } from './types.js';
import type { Matrix, Rect } from './text.js';

/** Options for `Page.ApplyRedactions` / `Document.ApplyRedactions`. */
export interface ApplyRedactionsOptions {
  /** Also clear document metadata (/Info + XMP) when true. */
  scrubMetadata?: boolean;
  /** Keep annotations overlapping a redacted region instead of removing them.
   *  Default false. Setting it preserves their text in the saved file. */
  keepAnnotations?: boolean;
}

/** The regions a mark covers: one Rect per /QuadPoints quad (its bounding box),
 *  falling back to /Rect when /QuadPoints is absent — a foreign producer may omit
 *  it, though `AddRedact` always writes it. [] when neither is usable. */
export function redactRects(annot: RedactAnnotation): Rect[] {
  const q = annot.QuadPoints;
  if (q.length >= 8) {
    const out: Rect[] = [];
    for (let i = 0; i + 8 <= q.length; i += 8) {
      const { minX, minY, maxX, maxY } = quadsBBox(q.slice(i, i + 8));
      out.push([minX, minY, maxX, maxY]);
    }
    return out;
  }
  const r = annot.Rect;
  return r ? [r] : [];
}

/** A rect as [minX, minY, maxX, maxY], however the caller ordered its corners. */
function normRect(r: Rect): Rect {
  return [
    Math.min(r[0], r[2]), Math.min(r[1], r[3]),
    Math.max(r[0], r[2]), Math.max(r[1], r[3]),
  ];
}

/** Resolve `o` to `n` finite numbers, or undefined. */
function numArray(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

/** A fresh /P for one region's overlay, or undefined when the document is not
 *  tagged — an untagged document has no tree to attach to, and emitting an
 *  /MCID with no /StructTreeRoot would be worse than leaving the content plain.
 *
 *  /P rather than /Span: /Span is inline-level content that PDF/UA expects
 *  inside a block-level parent, so a bare /Span at the top of the tree would
 *  silence our warning while creating a subtler structural problem. The overlay
 *  is a short standalone paragraph replacing removed content.
 *
 *  Attached under the root's first child (the /Document element AutoTag and
 *  CreateStructTree produce) when there is one, so the result is
 *  /Document > /P rather than a /P sitting beside /Document. */
function overlayElement(doc: Document): StructElement | undefined {
  const root = doc.GetStructTree();
  if (root === null) return undefined;
  const parent = root.Children[0];
  return parent !== undefined ? parent.Append('P') : root.Append('P');
}

/** Place the mark's /RO overlay form into the page at its /Rect. Returns false
 *  when there is no usable /RO, so the caller falls back to /IC + /OverlayText.
 *
 *  §12.5.6.23 gives /RO precedence: a viewer showing the mark shows /RO, so
 *  applying it must produce the same ink. We honour one another producer wrote
 *  but never author one. */
function paintOverlayForm(doc: Document, page: Page, annot: RedactAnnotation): boolean {
  const ro = annot.Overlay;
  if (ro === undefined) return false;
  const rect = annot.Rect;
  if (rect === undefined) return false;
  const bbox = numArray(doc, ro.dict.get('BBox'), 4);
  if (bbox === undefined) return false;
  const m = (numArray(doc, ro.dict.get('Matrix'), 6) as Matrix | undefined) ?? [1, 0, 0, 1, 0, 0];
  const place = placementMatrix(bbox, m, rect);
  if (place === undefined) return false;

  const entry = annot.Dict.get('RO');
  const ref = isRef(entry) ? entry : doc.allocObject(ro);
  const xobjs = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, ref);
  const body = new TextEncoder().encode(
    `q ${place.map(num).join(' ')} cm /${key} Do Q\n`);
  const elem = overlayElement(doc);
  // /RO is the overlay — §12.5.6.23 gives it precedence over /IC and
  // /OverlayText — so it gets the overlay's treatment. We cannot inspect
  // foreign artwork, and over-describing it as a paragraph beats hiding it
  // from assistive technology behind an /Artifact.
  appendContent(doc, page, elem !== undefined
    ? wrapMarkedContent(elem.Type, allocContentMcid(doc, elem, page), body)
    : body);
  return true;
}

/** Paint what a mark leaves behind: the /IC fill over each region, then its
 *  /OverlayText in the /DA font, size and colour, anchored by /Q and tiled when
 *  /Repeat is set. Introduces no rendering primitives — the fill goes through
 *  paintRedactionBoxes and the text through stampText, the rule tocrender.ts
 *  follows. */
export function paintRedactOverlay(
  doc: Document, page: Page, annot: RedactAnnotation, rects: Rect[],
): void {
  if (paintOverlayForm(doc, page, annot)) return;

  const fill = annot.InteriorColor ?? [0, 0, 0];
  const boxes = rects.map(normRect);
  // Delegated rather than inlined: paintRedactionBoxes draws the same geometry
  // and owns the /Artifact wrapping, so both redaction paths share one rule.
  paintRedactionBoxes(doc, page, boxes, fill);

  const text = annot.OverlayText;
  if (text === undefined || text.length === 0) return;

  const size = annot.FontSize > 0 ? annot.FontSize : 12;
  const color = annot.TextColor;
  const align = annot.Alignment;
  const width = measure('Helvetica', encodeWinAnsi(text), size);
  const elem = overlayElement(doc);
  const opts = {
    font: 'Helvetica' as const, fontSize: size, color, align,
    ...(elem !== undefined ? { tag: elem } : {}),
  };

  for (const [x0, y0, x1, y1] of boxes) {
    // Baseline anchor: /Q picks the x edge; y centres the cap height in the box.
    const x = align === 'center' ? (x0 + x1) / 2 : align === 'right' ? x1 : x0;
    const y = (y0 + y1) / 2 - size * 0.35;
    if (!annot.Repeat) { stampText(doc, page, text, x, y, opts); continue; }

    // Tile: step by the text width across, by the line height down, until full.
    const step = width > 0 ? width * 1.2 : size;
    const lead = size * 1.2;
    for (let ty = y1 - lead * 0.8; ty >= y0; ty -= lead) {
      for (let tx = x0; tx + width <= x1; tx += step) {
        stampText(doc, page, text, tx, ty, { ...opts, align: 'left' });
      }
    }
  }
}

/** Apply every /Redact mark on `page`: destroy the marked content, paint each
 *  mark's overlay, then remove the marks. Returns the number applied; a page
 *  with no usable mark is left untouched and returns 0. */
export function applyRedactions(
  doc: Document, page: Page, opts: ApplyRedactionsOptions = {},
): number {
  const marks: Array<{ annot: RedactAnnotation; rects: Rect[] }> = [];
  for (const a of page.Annotations) {
    if (!(a instanceof RedactAnnotation)) continue;
    const rects = redactRects(a);
    if (rects.length === 0) continue; // no geometry to act on: skip, don't throw
    marks.push({ annot: a, rects });
  }
  if (marks.length === 0) return 0;

  // The overlay is painted inside the seam's callback so it lands after
  // ec.commit() and therefore sits on top of whatever content survived.
  redactRegions(doc, page, marks.flatMap((m) => m.rects), () => {
    for (const m of marks) paintRedactOverlay(doc, page, m.annot, m.rects);
  }, opts.keepAnnotations);

  // After painting, because the painter needs these dicts alive. RemoveAnnotation
  // (not a raw /Annots splice) because it is what calls untagObjects: a tagged
  // annotation is also named by an /OBJR reachable from /Root, and leaving that
  // keeps the annotation in the saved bytes with no /Annots entry anywhere.
  for (const m of marks) page.RemoveAnnotation(m.annot);

  if (opts.scrubMetadata) doc.ClearMetadata();
  return marks.length;
}

/** Options for `Page.MarkRedactText` — everything `AddRedact` takes except the
 *  geometry, which comes from the search hit, plus the search scope. */
export type MarkRedactTextOptions =
  Omit<RedactAnnotationOptions, 'quads' | 'rect'> & SearchOptions;

/** Mark every occurrence of `find` (a literal string or RegExp) on `page` with a
 *  /Redact annotation, using the same search as `Search`. One annotation per
 *  match, carrying a quad per line the match spans. Returns the number of
 *  occurrences marked; nothing is removed until `ApplyRedactions`. */
export function markRedactText(
  doc: Document, page: Page, find: string | RegExp, opts: MarkRedactTextOptions = {},
): number {
  // `region` scopes the search only. Destructured out so it never reaches
  // addRedact, which would carry it nowhere but would accept the key.
  const { region, ...annotOpts } = opts;
  // As `redactText`: a mark must cover hidden occurrences too.
  const matches = searchText(doc, page, find, { region, includeHidden: true });
  for (const m of matches) {
    // One annotation per match: a match wrapping a line break spans several line
    // boxes, and those become several quads on the same mark, not several marks.
    addRedact(doc, page, { ...annotOpts, quads: m.quads.flatMap(rectToQuad) });
  }
  return matches.length;
}
