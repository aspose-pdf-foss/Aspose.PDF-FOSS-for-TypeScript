import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructTreeRoot } from './struct.js';
import { visitContent, type Rect, type ImageEvent } from './text.js';
import type { Table } from './tablemodel.js';
import type { TableAttributes } from './structattr.js';
import { dominantSize, headingRanks } from './textrank.js';
import { EditableContent } from './editcontent.js';
import { wrapRegionOps, regionOpSpan } from './structwrite.js';
import { name } from './types.js';
import { UnsupportedFeatureError } from './errors.js';

/** Options for {@link Document.AutoTag}. */
export interface AutoTagOptions {
  /** Re-tag even when the document is already tagged. Default false (throws). */
  force?: boolean;
  /** Set the document default language (/Lang). */
  lang?: string;
  /** Set the document title (/Info Title). */
  title?: string;
  /** Alt text for an image; when it returns undefined the image is marked
   *  /Artifact instead of tagged as a Figure. */
  alt?: (image: ImageEvent) => string | undefined;
  /** Detect and tag tables (via GetTables). Default true. */
  tables?: boolean;
}

/** Counts of the elements AutoTag produced. */
export interface AutoTagReport {
  headings: number;
  paragraphs: number;
  figures: number;
  artifacts: number;
  tables: number;
}

const SCOPES = new Set(['Row', 'Column', 'Both']);

/** True when the center of `box` lies inside `region`. */
function centerInside(box: Rect, region: Rect): boolean {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x0 = Math.min(region[0], region[2]), x1 = Math.max(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]), y1 = Math.max(region[1], region[3]);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/** Tag each table as Table > TR > TH/TD, marking cell content. The first row of a
 *  multi-row table is treated as a header (TH, scope Column) unless a cell already
 *  declares isHeader. Returns the number of tables tagged. */
function tagTables(doc: Document, root: StructTreeRoot, page: Page, tables: Table[]): number {
  let count = 0;
  for (const table of tables) {
    const tEl = root.Append('Table');
    if (table.summary) tEl.SetTableAttributes({ summary: table.summary });
    const multiRow = table.rowCount >= 2;
    table.rows.forEach((row, ri) => {
      const trEl = tEl.Append('TR');
      for (const cell of row.cells) {
        const heuristicHeader = multiRow && ri === 0;
        const isHeader = cell.isHeader === true || heuristicHeader;
        const cellEl = trEl.Append(isHeader ? 'TH' : 'TD');
        const attrs: Partial<TableAttributes> = {};
        if (cell.rowSpan > 1) attrs.rowSpan = cell.rowSpan;
        if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
        const scope = cell.scope && SCOPES.has(cell.scope)
          ? (cell.scope as 'Row' | 'Column' | 'Both')
          : (heuristicHeader ? 'Column' : undefined);
        if (scope) attrs.scope = scope;
        if (Object.keys(attrs).length > 0) cellEl.SetTableAttributes(attrs);
        cellEl.MarkContent(page, cell.quad);
      }
    });
    count++;
  }
  return count;
}

/** Infer and author a /StructTreeRoot for `doc` from page layout. */
export function autoTag(doc: Document, opts: AutoTagOptions = {}): AutoTagReport {
  if (doc.IsTagged && !opts.force)
    throw new UnsupportedFeatureError('document is already tagged; pass { force: true } to re-tag');

  const root = doc.CreateStructTree(); // marks the document Tagged
  if (opts.lang !== undefined) doc.Lang = opts.lang;
  if (opts.title !== undefined) {
    doc.SetMetadata({ title: opts.title });
    // A title only satisfies PDF/UA when the viewer is told to show it. Through
    // the property, which is viewerprefs.ts's one writer — this was a third
    // hand-rolled copy of the ensure-the-dict dance until 72nc.3.
    doc.DisplayDocTitle = true;
  }

  const ranks = headingRanks(doc);
  const report: AutoTagReport = { headings: 0, paragraphs: 0, figures: 0, artifacts: 0, tables: 0 };

  for (const page of doc.Pages) {
    const tables = (opts.tables ?? true) ? page.GetTables() : [];
    report.tables += tagTables(doc, root, page, tables);
    const tableQuads = tables.map((t) => t.quad);

    for (const block of page.GetStructuredText()) {
      if (block.text.trim().length === 0) continue;
      if (tableQuads.some((q) => centerInside(block.quad, q))) continue; // tagged as a cell
      const level = ranks.get(dominantSize(block));
      const isHeading = level !== undefined && block.lines.length <= 2;
      const el = root.Append(isHeading ? `H${level}` : 'P');
      el.MarkContent(page, block.quad);
      if (isHeading) report.headings++; else report.paragraphs++;
    }

    // Images: Figure with /Alt when described, else /Artifact.
    const images: ImageEvent[] = [];
    visitContent(doc, page, { image: (e) => { if (e.addr.path.length === 0) images.push(e); } });
    for (const img of images) {
      const alt = opts.alt?.(img);
      if (alt !== undefined) {
        const el = root.Append('Figure', { alt });
        if (el.MarkContent(page, img.quad) >= 0) report.figures++;
      } else {
        const span = regionOpSpan(doc, page, img.quad);
        if (span) {
          const ec = new EditableContent(doc, page);
          wrapRegionOps(
            ec, span.streamIndex, span.min, span.max,
            { operator: 'BMC', operands: [name('Artifact')] },
            { operator: 'EMC', operands: [] },
          );
          ec.commit();
          report.artifacts++;
        }
      }
    }
  }
  return report;
}
