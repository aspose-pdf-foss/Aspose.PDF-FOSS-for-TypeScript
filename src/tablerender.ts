import type { Document } from './document.js';
import type { Page } from './page.js';
import { stampTextBlock } from './stamp.js';
import { isTextRunList, type TextRun } from './textdecor.js';
import { PageGraphics } from './graphics.js';
import { drawBuiltImage } from './imageembed.js';
import type { BuiltImage } from './imageembed.js';
import type { StructElement } from './struct.js';
import { TableTagger, validateTableTagging } from './tabletag.js';
import {
  TableBuilder, resolveCellStyle, ResolvedStyle, BorderInfo, CellImageOptions,
  resolveBorderSides, borderEdgeCount, reportTableCoverage,
} from './tableauthor.js';
import type { Undrawable } from './textcoverage.js';
import type { SpanGrid } from './tablespan.js';

/** Options for {@link drawTable} / `page.AddTable`. */
export interface AddTableOptions {
  /** Total table width in points; feeds resolveColumnWidths. Required. */
  width: number;
  /** Inner padding per cell in points, standing in for the table style's
   *  `padding` (default 2). It occupies the *table* level of the cascade, so a
   *  row's or a cell's own `padding` still wins over it. */
  cellPadding?: number;
  /** Append pages (sized to the anchor page) and draw the whole table. Default
   *  false: draw what fits above the bottom line and return the rest as
   *  `remainder`. */
  autoPaginate?: boolean;
  /** Stop line, in points above each page's CropBox bottom edge: a row is drawn
   *  only while it fits above `CropBox.y0 + bottomMargin`. Non-negative.
   *  Default 0 (fill to the bottom edge). */
  bottomMargin?: number;
  /** Continuation start, in points below an appended page's CropBox top edge:
   *  each new page starts at `CropBox.y1 - topMargin`. Non-negative. Default =
   *  the anchor's top inset (`anchor.CropBox.y1 - top`). Only used in auto
   *  mode. */
  topMargin?: number;
  /** Emit /Table + /TR + /TD logical structure into the document structure tree.
   *  Default false, in which case output is byte-identical to an untagged call.
   *  Cell text is tagged into its cell element (a /TH for the repeating-header
   *  rows and for cells marked with `header`, a /TD otherwise); cell images get
   *  a /Figure under their cell; cell backgrounds, cell borders and the outer
   *  border are marked as /Artifact. */
  tagged?: boolean;
  /** Element to append the /Table under. Default: the structure tree root. When
   *  this element is itself a /Table it is *reused* rather than nested, which is
   *  how a manual-pagination loop keeps one table across pages — pass back
   *  {@link AddTableResult.struct}. Requires `tagged: true`. */
  structParent?: StructElement;
  /** Called for each cell whose resolved face cannot draw some or all of its
   *  text. Opt-in; a caller who passes nothing gets the previous silence.
   *  Fires once per cell, before anything is drawn — page.AddTable is the one
   *  table consumer that does not route through flowtable.ts's builder. */
  onUndrawable?: (u: Undrawable) => void;
}

/** The outcome of {@link drawTable} / `page.AddTable`. */
export interface AddTableResult {
  /** Pages drawn onto, in order. Always includes the anchor page; length > 1
   *  only in auto mode. */
  pages: Page[];
  /** The y of the bottom edge of the last drawn row on the last page (equals
   *  `top` when nothing was drawn). */
  endY: number;
  /** Rows that did not fit, as a re-drawable TableBuilder. Set only in manual
   *  mode when the table overflowed; undefined when everything was drawn. */
  remainder?: TableBuilder;
  /** The /Table element, when `tagged` and at least one row was drawn. An
   *  auto-paginated table is a single /Table across all its pages. */
  struct?: StructElement;
}

/** A placed cell: page-space rect (top-left origin uses `bottom`), text, style. */
interface Placed {
  x: number; bottom: number; w: number; h: number;
  text: string | TextRun[]; style: ResolvedStyle;
  image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions };
  /** The /TD or /TH this cell's text is tagged into. Tagged mode only. */
  struct?: StructElement;
  /** The /Figure this cell's image is tagged into. Tagged mode only, and absent
   *  for an image the caller marked decorative. */
  figure?: StructElement;
}

/** A page block's outer rectangle for the table border. */
interface BlockRect { x: number; bottom: number; w: number; h: number }

/** Stroke `border` around the box `(x, bottom, w, h)` into `g`, honouring its
 *  `sides`. All four edges keep the single-`re` shorthand, so a border written
 *  before `sides` existed emits the same bytes as it always did; a partial
 *  border emits one segment per edge into a single path. Fully sets the stroke
 *  state (width/colour/dash) so nothing leaks; dash `[]` means solid. */
function strokeBorderBox(
  g: PageGraphics, border: BorderInfo, x: number, bottom: number, w: number, h: number,
): void {
  const n = borderEdgeCount(border);
  if (n === 0) return;
  g.setLineWidth(border.width).setStrokeColor(border.color).setDash(border.dash ?? []);
  if (n === 4) {
    g.drawRect(x, bottom, w, h).stroke();
    return;
  }
  const e = resolveBorderSides(border.sides);
  const top = bottom + h, right = x + w;
  if (e.top) g.drawLine(x, top, right, top);
  if (e.right) g.drawLine(right, bottom, right, top);
  if (e.bottom) g.drawLine(x, bottom, right, bottom);
  if (e.left) g.drawLine(x, bottom, x, top);
  g.stroke();
}

/** The contiguous index list `[start, start+1, ..., end-1)`. */
function rangeIndices(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** Place the cells of the rows named by `rowIndices` (in the given order) with
 *  the first row's top at `top`, stacking downward. `columnX` are prefix-sum
 *  column left edges; `grid` says which column each cell landed in and how far
 *  down it reaches, so this walk and `measure`'s cannot disagree.
 *
 *  `rowIndices` may be non-contiguous — a repeating-header prefix followed by a
 *  body range. That is safe because both of the grid's clamps and the
 *  pagination back-off guarantee every spanned row is contiguous WITHIN the
 *  slice: a header span cannot leave the header block, and a body slice is
 *  never cut inside a span. So the accumulated `rowTop` walk still yields the
 *  right `bottom`, and no cell is ever placed against a row that is not on the
 *  page. */
function placeRows(
  table: TableBuilder, rowIndices: number[],
  rowHeights: number[], grid: SpanGrid, columnX: number[], widths: number[], top: number,
  tablePadding?: number, tagger?: TableTagger,
): Placed[] {
  const placed: Placed[] = [];
  let rowTop = top;
  for (const r of rowIndices) {
    const rowBottom = rowTop - rowHeights[r];
    tagger?.beginRow();
    const row = table.rows[r];
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i];
      const p = grid.placements[r][i];
      let cellW = 0;
      for (let k = 0; k < p.colSpan; k++) cellW += widths[p.col + k];
      // A spanning cell's background, border and text box are its FULL span
      // box: the three paint passes read `h` and need no change at all.
      let cellH = 0;
      for (let k = 0; k < p.rowSpan; k++) cellH += rowHeights[p.row + k];
      const struct = tagger?.cell(cell, r, table.repeatingRowCount, p.rowSpan);
      // Appended here, not in the image pass: paintPlaced draws every image
      // before any text, so allocating the /Figure at cell-creation time is what
      // keeps a cell's /K in reading order — [Figure, textMcid].
      const figure = struct !== undefined && cell.image !== undefined && !cell.image.opts.artifact
        ? tagger!.figure(struct, cell.image.opts.alt)
        : undefined;
      placed.push({
        x: columnX[p.col], bottom: rowTop - cellH, w: cellW, h: cellH,
        text: cell.text,
        style: resolveCellStyle(cell, row.style, table.defaults, tablePadding),
        image: cell.image, struct, figure,
      });
    }
    rowTop = rowBottom;
  }
  return placed;
}

/** Paint placed cells into `page`: backgrounds, then aligned text, then cell
 *  borders and (if given) the outer border around `blockRect`. Paint order is
 *  fills -> text -> borders. Existing content is preserved. */
function paintPlaced(
  doc: Document, page: Page, placed: Placed[],
  outerBorder: BorderInfo | undefined, blockRect: BlockRect | undefined,
  tagged: boolean,
): void {
  // Pass 1: backgrounds (bottom). A cell fill is decoration, so in a tagged
  // table it is an artifact or it trips UntaggedContent. The sequence is opened
  // only when there is a fill to put in it: apply() no-ops on an empty part
  // list, but BeginArtifact pushes a part, so an unconditional call would emit a
  // bare /Artifact BMC EMC into a table that has no backgrounds at all.
  const filled = placed.filter((p) => p.style.background !== undefined);
  if (filled.length > 0) {
    const bg = new PageGraphics(doc, page);
    if (tagged) bg.BeginArtifact();
    for (const p of filled)
      bg.setFillColor(p.style.background!).drawRect(p.x, p.bottom, p.w, p.h).fill();
    if (tagged) bg.EndMarkedContent();
    bg.apply();
  }

  // Pass 1.5: cell images (above backgrounds, below text). Contained (aspect-
  // preserving) into innerWidth x imageContentHeight, then placed in the full
  // inner box by the image's align/valign (defaulting to the cell's).
  for (const p of placed) {
    if (!p.image) continue;
    const pad = p.style.padding;
    const innerW = p.w - pad.left - pad.right;
    const innerH = p.h - pad.top - pad.bottom;
    if (innerW <= 0 || innerH <= 0) continue;
    const { built, width: imgW, height: imgH, opts } = p.image;
    const boxH = opts.height ?? imgH * innerW / imgW;   // measured image content height
    const scale = Math.min(innerW / imgW, boxH / imgH);
    const drawnW = imgW * scale;
    const drawnH = imgH * scale;
    const align = opts.align ?? p.style.align;
    const valign = opts.valign ?? p.style.valign;
    const ix = p.x + pad.left, iy = p.bottom + pad.bottom;
    const dx = align === 'center' ? (innerW - drawnW) / 2 : align === 'right' ? innerW - drawnW : 0;
    const dy = valign === 'center' ? (innerH - drawnH) / 2 : valign === 'top' ? innerH - drawnH : 0;
    // Untagged, the marking options are ignored entirely — output stays
    // byte-identical to a table drawn without them.
    const mark = p.figure !== undefined
      ? { tag: p.figure }
      : tagged && opts.artifact ? { artifact: true } : {};
    drawBuiltImage(doc, page, built, [ix + dx, iy + dy, drawnW, drawnH],
      { opacity: opts.opacity, ...mark });
  }

  // Pass 2: cell text (middle), aligned per resolved style.
  for (const p of placed) {
    const rect: [number, number, number, number] = [
      p.x + p.style.padding.left, p.bottom + p.style.padding.bottom,
      p.w - p.style.padding.left - p.style.padding.right,
      p.h - p.style.padding.top - p.style.padding.bottom,
    ];
    // The cell's `textBackground` becomes the stamp's `background`: inside a
    // cell, `background` already means the box fill.
    const opts = {
      font: p.style.font, fontSize: p.style.fontSize, leading: p.style.leading,
      color: p.style.color, align: p.style.align, valign: p.style.valign,
      underline: p.style.underline, strikethrough: p.style.strikethrough,
      background: p.style.textBackground, tag: p.struct,
    };
    // Two identical arms: TypeScript resolves an overloaded call by picking one
    // signature, and a `string | TextRun[]` argument matches neither. The same
    // shape appears in page.ts, flow.ts and stamp.ts, for the same reason.
    if (isTextRunList(p.text)) stampTextBlock(doc, page, p.text, rect, opts);
    else stampTextBlock(doc, page, p.text, rect, opts);
  }

  // Pass 3: cell borders + the block's outer border (top). Artifacted as one
  // sequence, on the same only-when-drawn rule as pass 1 — which is why a border
  // whose `sides` resolve to no edge is filtered out here rather than no-opped
  // inside strokeBorderBox: a table whose only borders are `'none'` must not
  // open a bare /Artifact BMC EMC.
  const bordered = placed.filter((p) => p.style.border !== undefined && borderEdgeCount(p.style.border) > 0);
  const hasOuter = outerBorder !== undefined && blockRect !== undefined &&
    borderEdgeCount(outerBorder) > 0;
  if (bordered.length > 0 || hasOuter) {
    const bd = new PageGraphics(doc, page);
    if (tagged) bd.BeginArtifact();
    for (const p of bordered)
      strokeBorderBox(bd, p.style.border!, p.x, p.bottom, p.w, p.h);
    if (hasOuter)
      strokeBorderBox(bd, outerBorder!, blockRect!.x, blockRect!.bottom, blockRect!.w, blockRect!.h);
    if (tagged) bd.EndMarkedContent();
    bd.apply();
  }
}

/** Paint the rows named by `rowIndices` with the first row's top at `sliceTop`,
 *  wrapped in one outer-border block.
 *
 *  Exported because `drawTable` (page-positioned, driven by the anchor page's
 *  CropBox) and `flowtable.ts` (column-positioned, driven by a rect) both need
 *  to put one slice of rows on a page. Their pagination rules contradict each
 *  other and cannot be one function; the painting does not, and is this. */
export function paintRowSlice(
  doc: Document, page: Page, table: TableBuilder,
  rowIndices: number[], rowHeights: number[], grid: SpanGrid,
  columnX: number[], widths: number[],
  sliceTop: number, x: number, tablePadding: number | undefined,
  outerBorder: BorderInfo | undefined, tagged: boolean, tagger?: TableTagger,
): void {
  if (rowIndices.length === 0) return;
  let h = 0;
  for (const r of rowIndices) h += rowHeights[r];
  const tableWidth = columnX[widths.length] - x;
  const placed = placeRows(
    table, rowIndices, rowHeights, grid, columnX, widths, sliceTop, tablePadding, tagger);
  paintPlaced(doc, page, placed, outerBorder,
    { x, bottom: sliceTop - h, w: tableWidth, h }, tagged);
}

/** Lay out `table` with its top-left corner at (x, top) in PDF user space and
 *  draw its backgrounds, cell text (aligned), and borders into the page's
 *  /Contents. This single-page version draws every row; pagination is layered on
 *  in later tasks. Returns the anchor page and the last row's bottom y. Input
 *  validation is delegated to resolveColumnWidths/measure. */
export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): AddTableResult {
  validateTableTagging(doc, opts);
  if (opts.onUndrawable !== undefined) reportTableCoverage(table, opts.onUndrawable);
  // The draw-time cellPadding override stands in for the table level of the
  // cascade, and padding is part of a column's natural width — so auto-fit has
  // to see it.
  const widths = table.resolveColumnWidths(opts.width, { cellPadding: opts.cellPadding });
  if (widths.length === 0) return { pages: [page], endY: top, remainder: undefined };
  // Passed through rather than collapsed here: `cellPadding` is only the table
  // level of the cascade, so a row or cell padding must still be able to beat it.
  const padding = opts.cellPadding;
  const { rowHeights, grid } = table.measure(widths, { cellPadding: padding });

  // Column left edges by prefix sum: columnX[c] = x + Σ widths[0..c).
  const columnX: number[] = [x];
  for (let i = 0; i < widths.length; i++) columnX.push(columnX[i] + widths[i]);

  const bottomMargin = opts.bottomMargin ?? 0;
  const ob = table.defaults.outerBorder;

  const tagged = opts.tagged ?? false;
  // A holder rather than a bare `let`: paintRows is a closure, and TypeScript
  // narrows a closure-assigned local back to `undefined` at the return sites.
  const tagging: { tagger?: TableTagger } = {};

  // Paint the rows named by `rowIndices` on `pg` with the first row's top at
  // `sliceTop`, wrapped in one outer-border block.
  const paintRows = (pg: Page, rowIndices: number[], sliceTop: number): void => {
    if (rowIndices.length === 0) return;
    // Built on the first PAINTED slice, so a tagged call that draws nothing
    // bootstraps no structure tree and leaves the document untouched.
    if (tagged && tagging.tagger === undefined)
      tagging.tagger = new TableTagger(doc, { structParent: opts.structParent });
    paintRowSlice(doc, pg, table, rowIndices, rowHeights, grid, columnX, widths,
      sliceTop, x, padding, ob, tagged, tagging.tagger);
  };

  const autoPaginate = opts.autoPaginate ?? false;
  const anchorCb = page.CropBox;                 // [x0, y0, x1, y1]
  const topMargin = opts.topMargin ?? (anchorCb[3] - top);
  const anchorMediaBox = page.MediaBox;

  // Repeating header: the first N rows reprint atop each continuation page.
  const headerCount = Math.min(table.repeatingRowCount, table.rows.length);
  const headerIndices = rangeIndices(0, headerCount);
  let headerHeight = 0;
  for (let r = 0; r < headerCount; r++) headerHeight += rowHeights[r];

  const pages: Page[] = [page];
  let currentPage = page;
  let cb = anchorCb;
  let bottomLine = cb[1] + bottomMargin;
  let sliceTop = top;
  let sliceStartRow = 0;
  let usedHeight = 0;
  let rowsOnThisPage = 0;
  let onContinuation = false;

  for (let i = 0; i < table.rows.length; i++) {
    const h = rowHeights[i];
    const fits = sliceTop - usedHeight - h >= bottomLine;
    if (!fits && rowsOnThisPage > 0) {
      // A rowSpan group is atomic across a break: back off to the largest cut
      // at or before `i` that slices no span. `safeBreak[headerCount]` is
      // always true — a header span is clamped to the header block — so the
      // body's own start is reachable.
      let cut = i;
      while (cut > sliceStartRow && !grid.safeBreak[cut]) cut--;
      if (cut === sliceStartRow) {
        // The span group starting here is by itself taller than the page.
        // Fall through to the existing "draw it anyway" path, which is what a
        // single oversized row does today: no new error, and the failure mode
        // for an over-tall group is the one callers already know.
        usedHeight += h;
        rowsOnThisPage++;
        continue;
      }
      // Recomputed for the shorter slice: the back-off may have dropped rows
      // that `usedHeight` had already counted.
      let used = onContinuation ? headerHeight : 0;
      for (let r = sliceStartRow; r < cut; r++) used += rowHeights[r];
      usedHeight = used;
      const body = rangeIndices(sliceStartRow, cut);
      paintRows(currentPage, onContinuation ? [...headerIndices, ...body] : body, sliceTop);
      if (!autoPaginate)
        return {
          pages, endY: sliceTop - usedHeight, remainder: table.continuationFrom(cut),
          struct: tagging.tagger?.table,
        };
      // Append a page sized to the anchor and continue from its top.
      currentPage = doc.AddPage().page;
      currentPage.MediaBox = [...anchorMediaBox];
      pages.push(currentPage);
      cb = currentPage.CropBox;
      bottomLine = cb[1] + bottomMargin;
      sliceTop = cb[3] - topMargin;
      sliceStartRow = Math.max(cut, headerCount);  // body never re-lists a header row
      onContinuation = true;
      usedHeight = headerHeight;                    // header consumes space up top
      rowsOnThisPage = 0;
      i = sliceStartRow - 1;                        // retry the first body row on the new page
      continue;
    }
    usedHeight += h;
    rowsOnThisPage++;
  }
  {
    const body = rangeIndices(sliceStartRow, table.rows.length);
    paintRows(currentPage, onContinuation ? [...headerIndices, ...body] : body, sliceTop);
  }
  return {
    pages, endY: sliceTop - usedHeight, remainder: undefined,
    struct: tagging.tagger?.table,
  };
}
