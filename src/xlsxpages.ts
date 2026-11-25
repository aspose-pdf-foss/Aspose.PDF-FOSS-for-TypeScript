import type { Document } from './document.js';
import type { Page } from './page.js';
import { registerStream } from './decodebudget.js';
import { inlineImageToStream } from './inlinedict.js';
import { visualFrame } from './decorate.js';
import { resolvePages } from './pagerange.js';
import type { OperationContext, OperationSteps } from './operation.js';
import { apply, invert, mul, visitContent, fragmentsFromGlyphs, type GlyphEvent, type Rect } from './text.js';
import { workbookImages } from './xlsxmedia.js';
import { writeXlsx, type XlsxSheet } from './xlsxpackage.js';
import type { XlsxPicture } from './xlsxdrawing.js';
import type { XlsxExportOptions, XlsxSkipped } from './xlsxexport.js';

/** Positions in whole 96-dpi pixels. Coalesce near-identical starts, and split
 * long blank intervals at Excel's per-track size limit before allocating. */
function gridAxis(starts: number[], extent: number, tolerance: number, maxSize: number, maxTracks: number) {
  const end = Math.max(1, Math.ceil(extent / 0.75));
  if (!Number.isFinite(end) || end > maxSize * maxTracks) throw new RangeError('Page exceeds XLSX grid dimensions');
  const points = [0], sizes: number[] = [];
  function add(point: number): void {
    let last = points[points.length - 1];
    while (last < point) {
      if (sizes.length === maxTracks) throw new RangeError('Page exceeds XLSX grid dimensions');
      const size = Math.min(maxSize, point - last);
      sizes.push(size);
      last += size;
      points.push(last);
    }
  }
  for (const value of starts.sort((a, b) => a - b)) {
    const px = Math.round(value / 0.75);
    if (px < end && px - points[points.length - 1] > tolerance) add(px);
  }
  add(end);
  function index(value: number): number {
    const px = Math.round(value / 0.75);
    let lo = 0, hi = sizes.length;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (points[mid] <= px) lo = mid;
      else hi = mid;
    }
    return lo;
  }
  return { sizes, index };
}

interface PlacedText { text: string; rect: Rect }

/** Adjacent style runs on a common baseline belong to one cell. Separate a
 * layout gap from an ordinary word space using the local text height. */
function lineCells(horizontal: PlacedText[]): PlacedText[] {
  horizontal.sort((a, b) => a.rect[3] - b.rect[3]);
  const cells: PlacedText[] = [];
  for (let start = 0; start < horizontal.length;) {
    let end = start + 1;
    while (end < horizontal.length && horizontal[end].rect[3] - horizontal[start].rect[3] <= 2) end++;
    const line = horizontal.slice(start, end).sort((a, b) => a.rect[0] - b.rect[0]);
    const top = line.reduce((y, run) => Math.min(y, run.rect[1]), Infinity);
    let cell: PlacedText | undefined;
    for (const run of line) {
      const gap = cell ? run.rect[0] - cell.rect[2] : Infinity;
      const size = run.rect[3] - run.rect[1];
      if (cell && gap >= -1 && gap <= 0.65 * size) {
        const space = gap > 0.2 * size && !/\s$/.test(cell.text) && !/^\s/.test(run.text);
        cell.text += (space ? ' ' : '') + run.text;
        cell.rect[2] = Math.max(cell.rect[2], run.rect[2]);
      } else {
        run.rect[1] = top;
        cells.push(run);
        cell = run;
      }
    }
    start = end;
  }
  return cells;
}

function pageSheet(doc: Document, page: Page, opts: XlsxExportOptions, images: ReturnType<typeof workbookImages>): XlsxSheet {
  const frame = visualFrame(page);
  const unit = doc.resolve(page.Dict.get('UserUnit')) ?? 1;
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) throw new RangeError('Invalid page UserUnit');
  const width = frame.VW * unit, height = frame.VH * unit;
  if (!(width > 0 && height > 0)) throw new RangeError('Invalid page CropBox');
  const matrix = mul(invert(frame.M), [unit, 0, 0, -unit, 0, height]);
  function bounds(rect: Rect): Rect {
    // CropBox rotation is a quarter turn, so opposite corners suffice.
    const [x0, y0] = apply(matrix, rect[0], rect[1]), [x1, y1] = apply(matrix, rect[2], rect[3]);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
  const name = 'Page ' + page.Number;
  const skipped = (kind: XlsxSkipped['kind']): void => opts.onSkipped?.({ kind, pageNumber: page.Number, sheetName: name });
  const glyphs: GlyphEvent[] = [], pictures: XlsxPicture[] = [];
  visitContent(doc, page, {
    glyph(g) {
      const [l, t, r, b] = bounds(g.quad);
      if (r > 0 && b > 0 && l < width && t < height) glyphs.push(g);
    },
    image(e, inline) {
      const [l, t, r, b] = bounds(e.quad);
      if (r <= 0 || b <= 0 || l >= width || t >= height) return;
      if (![l, t, r, b].every(Number.isFinite) || l < 0 || t < 0 || r > width || b > height) {
        skipped('unsupported-image'); return;
      }
      const [a, dy, c, d] = mul(e.ctm, matrix);
      const w = Math.hypot(a, dy), h = Math.hypot(c, d);
      if (w === 0 || h === 0 || Math.abs(a * c + dy * d) > 1e-8 * w * h) {
        skipped('unsupported-image'); return;
      }
      const stream = inline ? inlineImageToStream(inline) : e.stream;
      if (!stream) { skipped('unsupported-image'); return; }
      if (inline) registerStream(stream, doc.decodeBudget);
      const media = images(stream);
      if (typeof media === 'string') { skipped(media); return; }
      pictures.push({ media, x: (l + r - w) / 2, y: (t + b - h) / 2,
        width: w, height: h, angle: Math.atan2(dy, a) * 180 / Math.PI, flipV: a * d - dy * c > 0 });
    },
  }, { skipHidden: !opts.includeHidden });
  const horizontal: PlacedText[] = [], fragments: PlacedText[] = [];
  for (const f of fragmentsFromGlyphs(glyphs)) {
    const rect = bounds(f.quad);
    if (!rect.every(Number.isFinite)) continue;
    const angle = (f.angle ?? 0) - frame.R * Math.PI / 180;
    const list = !f.vertical && Math.cos(angle) > 0.99999 ? horizontal : fragments;
    list.push({ text: f.text, rect });
  }
  for (const cell of lineCells(horizontal)) fragments.push(cell);
  const cols = gridAxis(fragments.map(f => f.rect[0]), width, 4, 1785, 16384);
  const rowStarts = fragments.flatMap(f => [f.rect[1], Math.max(f.rect[3], f.rect[1] + 15)]);
  const lines = gridAxis(rowStarts, height, 2, 545, 1048576);
  const rows: string[][] = lines.sizes.map(() => []);
  fragments.sort((a, b) => lines.index(a.rect[1]) - lines.index(b.rect[1]) || a.rect[0] - b.rect[0]);
  for (const { text, rect } of fragments) {
    const row = rows[lines.index(rect[1])], col = cols.index(rect[0]);
    row[col] = row[col] ? row[col] + ' ' + text : text;
  }
  // SpreadsheetML column widths are in maximum-digit units (7 px for the
  // default Calibri 11); stored widths include padding and use 1/256 units.
  return { name, rows, pictures, grid: {
    columnWidths: cols.sizes.map(px => Math.round(px / 7 * 256) / 256),
    rowHeights: lines.sizes.map(px => px * 0.75),
  } };
}

export function* pageWorkbookSteps(doc: Document, opts: XlsxExportOptions, context: OperationContext): OperationSteps<Uint8Array> {
  const pages = doc.Pages;
  const selected = resolvePages(opts.pages, pages.length);
  const images = workbookImages(doc, opts.maxImagePixels, opts.maxImageBytes);
  const sheets: XlsxSheet[] = [];
  for (const number of selected) {
    sheets.push(pageSheet(doc, pages[number - 1], opts, images));
    yield context.progress('pages', sheets.length, selected.length, number);
  }
  if (!sheets.length) sheets.push({ name: 'Pages', rows: [] });
  return writeXlsx(sheets);
}
