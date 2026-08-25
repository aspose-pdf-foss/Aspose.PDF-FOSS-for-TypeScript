// Table-of-contents painting and pagination (issue 1gg0.1). No new rendering
// primitives: titles, leaders and labels go through stampText (stamp.ts) and
// links through addLink (annotation.ts). The model and all validation live in
// toc.ts, which measureTOC runs to completion before anything is painted.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { addLink } from './annotation.js';
import { stampText } from './stamp.js';
import type { StructElement } from './struct.js';
import { TocTagger } from './tocstruct.js';
import {
  measureTOC, rowMeasure, rowStampOptions,
  type MeasuredRow, type TOCEntry, type TOCLayout, type TOCOptions,
} from './toc.js';

// Tolerance so a box exactly n rows tall fits n rows despite float drift, as in
// layout.ts.
const EPS = 1e-9;

/** The outcome of {@link drawTOC} / `page.AddTOC`. */
export interface AddTOCResult {
  /** Pages drawn onto, anchor first; length > 1 only in auto mode. */
  pages: Page[];
  /** Entries fully drawn, across all pages. */
  drawn: number;
  /** y of the bottom of the last drawn row on the last page, excluding any
   *  trailing rowGap; the box top when nothing was drawn. */
  endY: number;
  /** Entries that did not fit — a slice of the caller's array, so the same
   *  objects can be passed straight back. Manual mode only; undefined when
   *  everything was drawn. */
  remainder?: TOCEntry[];
  /** The /TOC element, when `tagged` and at least one row was drawn. Pass it
   *  back as `structParent` on a continuation call so a paginated TOC stays a
   *  single /TOC, with its nesting depth carried across the break. */
  struct?: StructElement;
}

/** Paint one measured row with its top edge at `rowTop`. */
function paintRow(
  doc: Document, page: Page, row: MeasuredRow, L: TOCLayout, opts: TOCOptions, rowTop: number,
  tagger: TocTagger | undefined,
): void {
  const { style } = row;
  // Open this row's TOCI > Reference > Link before any of its stamps, so the
  // MCIDs land under it in draw order: title lines, then the label.
  const content = tagger?.beginRow(row.entry.level ?? 1);
  const tag = content ? { tag: content } : {};
  const left = { ...rowStampOptions(style, opts, 'left'), ...tag };
  const right = { ...rowStampOptions(style, opts, 'right'), ...tag };

  for (let i = 0; i < row.lines.length; i++)
    stampText(doc, page, row.lines[i].text, row.titleLeft,
      rowTop - i * style.leading - style.fontSize, left);

  // An empty title draws no line but still occupies one, so the label sits on
  // the same baseline it would have had.
  const lineCount = Math.max(row.lines.length, 1);
  const lastBaseline = rowTop - (lineCount - 1) * style.leading - style.fontSize;

  if (L.leader === 'dots') {
    const last = row.lines[row.lines.length - 1];
    const lastEnd = row.titleLeft + (last ? last.width : 0);
    const gap = (L.numberLeft - L.leaderGap) - (lastEnd + L.leaderGap);
    const dotWidth = rowMeasure('.', style, opts);
    const count = dotWidth > 0 ? Math.floor(gap / dotWidth) : 0;
    // Right-aligned against the number column so the dot runs line up vertically
    // across rows however long the titles are — left-aligning leaves them ragged
    // exactly where the eye follows them.
    if (count > 0)
      // Decoration, not content: in a tagged page the leader must be an
      // artifact, or a screen reader reads a run of dots aloud.
      stampText(doc, page, '.'.repeat(count), L.numberLeft - L.leaderGap, lastBaseline,
        tagger ? { ...rowStampOptions(style, opts, 'right'), artifact: true } : right);
  }

  stampText(doc, page, row.label, L.rowRight, lastBaseline, right);

  // The rect starts at titleLeft, not the box edge, so a nested row's indent is
  // not clickable, and spans row.height so every line of a wrapped title is.
  if (L.links) {
    const link = addLink(doc, page, {
      rect: [row.titleLeft, rowTop - row.height, L.rowRight, rowTop],
      action: { type: 'goto', page: row.entry.page, view: L.view },
      border: 0,
    });
    tagger?.finishRow(link);
  }
}

/** Render `entries` as a table of contents into `rect` = [x, y, w, h] on `page`.
 *  Existing content is preserved. */
export function drawTOC(
  doc: Document, page: Page, entries: TOCEntry[], rect: [number, number, number, number],
  opts: TOCOptions = {},
): AddTOCResult {
  const L = measureTOC(doc, entries, rect, opts);   // validates everything; draws nothing
  const [, y, , h] = rect;
  const boxTop = y + h;
  const boxBottom = y;
  if (L.rows.length === 0) return { pages: [page], drawn: 0, endY: boxTop };

  const anchorMediaBox = page.MediaBox;
  const pages: Page[] = [page];
  let current = page;
  let rowTop = boxTop;
  let drawn = 0;
  let rowsOnPage = 0;
  let tagger: TocTagger | undefined;

  for (let i = 0; i < L.rows.length; i++) {
    const row = L.rows[i];
    // A row is atomic: a wrapped title never splits across pages, which keeps
    // exactly one link rect per entry. The test is rowsOnPage, not drawn: after
    // a page break an over-tall row must be drawn on the fresh page rather than
    // triggering another break, or auto mode appends pages forever. A row taller
    // than an EMPTY box therefore overflows the bottom — the same choice
    // layoutText makes for a word wider than its box.
    if (rowTop - row.height < boxBottom - EPS && rowsOnPage > 0) {
      if (!L.autoPaginate)
        return {
          pages, drawn, endY: rowTop + L.rowGap, remainder: entries.slice(i),
          struct: tagger?.toc,
        };
      // Append a page sized to the anchor and reuse the same box on it.
      current = doc.AddPage().page;
      current.MediaBox = [...anchorMediaBox];
      pages.push(current);
      rowTop = boxTop;
      rowsOnPage = 0;
      i--;                                   // retry this row on the fresh page
      continue;
    }
    // Built on the first PAINTED row, so a tagged call that draws nothing
    // bootstraps no structure tree and leaves the document untouched.
    if (L.tagged && tagger === undefined)
      tagger = new TocTagger(doc, { links: L.links, structParent: L.structParent });
    paintRow(doc, current, row, L, opts, rowTop, tagger);
    drawn++;
    rowsOnPage++;
    rowTop -= row.height + L.rowGap;
  }
  return { pages, drawn, endY: rowTop + L.rowGap, struct: tagger?.toc };
}
