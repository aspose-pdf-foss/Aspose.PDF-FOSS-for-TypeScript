import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { blockFromLines, extractStructured, visitContent, type ImageEvent, type Rect, type TextBlock } from './text.js';
import type { Table } from './tablemodel.js';
import type { TableAttributes } from './structattr.js';
import { prepareHeadings } from './autotagheading.js';
import { prepareFurniture } from './autotagfurniture.js';
import { listCandidateBlocks, tagListBlock } from './autotaglist.js';
import { isListTable } from './autotaglisttable.js';
import { stripOrphanPageMcids } from './autotagmcid.js';
import { centerInside, markPagePaint } from './autotagpaint.js';
import { existingAnnotationOwners, tagPageAnnotations, type TextRegion } from './autotagannot.js';
import type { PdfDict } from './types.js';
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
  /** Heading source. Defaults to document-wide font size ranking. */
  headingStrategy?: 'fontSize' | 'outline' | 'thresholds';
  /** One to six strictly descending minimum sizes in points for H1 through H6. */
  headingThresholds?: readonly number[];
  /** Recognize corroborated list items. Default true. */
  lists?: boolean;
  /** Mark recurring marginal headers and footers as pagination artifacts. */
  furniture?: boolean;
  /** Confirm a recurring text candidate as a watermark, including in the page body. */
  watermark?: (text: string) => boolean;
}

/** Counts of the elements AutoTag produced. */
export interface AutoTagReport {
  headings: number;
  paragraphs: number;
  figures: number;
  artifacts: number;
  tables: number;
  /** List containers, including nested lists. */
  lists: number;
  /** Annotations newly attached to the structure tree. */
  annotations: number;
}

const SCOPES = new Set(['Row', 'Column', 'Both']);

/** The first row of a multi-row table supplies column headers by default. */
function tagTable(root: StructTreeRoot, table: Table, regions: TextRegion[]): void {
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
      regions.push({ quad: cell.quad, owner: cellEl });
    }
  });
}

type LayoutItem = { kind: 'table'; value: Table; quad: Rect }
  | { kind: 'text'; value: TextBlock; quad: Rect }
  | { kind: 'image'; value: ImageEvent; quad: Rect; index: number };

function pageLayout(doc: Document, page: Page, tables: Table[], blocks: TextBlock[], lists: boolean): LayoutItem[] {
  const items: LayoutItem[] = tables.map(value => ({ kind: 'table', value, quad: value.quad }));
  for (const value of blocks) items.push({ kind: 'text', value, quad: value.quad });
  let index = 0;
  visitContent(doc, page, { image: value => {
    if (!value.addr.path.length && !value.artifact && value.mcid === undefined)
      items.push({ kind: 'image', value, quad: value.quad, index: index++ });
  } }, { skipHidden: true });
  items.sort((a, b) => b.quad[3] - a.quad[3] || a.quad[0] - b.quad[0]);
  if (!lists) return items;
  const layout: LayoutItem[] = [];
  for (let i = 0; i < items.length;) {
    const item = items[i++];
    if (item.kind !== 'text') { layout.push(item); continue; }
    const run = [item.value];
    while (i < items.length) {
      const next = items[i];
      if (next.kind !== 'text') break;
      run.push(next.value);
      i++;
    }
    for (const value of listCandidateBlocks(run)) layout.push({ kind: 'text', value, quad: value.quad });
  }
  return layout;
}

/** Infer and author a /StructTreeRoot for `doc` from page layout. */
export function autoTag(doc: Document, opts: AutoTagOptions = {}): AutoTagReport {
  if (doc.IsTagged && !opts.force)
    throw new UnsupportedFeatureError('document is already tagged; pass { force: true } to re-tag');

  const headingLevel = prepareHeadings(doc, opts);
  if (opts.lists !== undefined && typeof opts.lists !== 'boolean') throw new TypeError('lists must be a boolean');
  if (opts.furniture !== undefined && typeof opts.furniture !== 'boolean') throw new TypeError('furniture must be a boolean');
  if (opts.watermark !== undefined && typeof opts.watermark !== 'function') throw new TypeError('watermark must be a function');
  stripOrphanPageMcids(doc);
  const markFurniture = prepareFurniture(doc, opts.furniture ?? false, opts.watermark);
  const root = doc.CreateStructTree(); // marks the document Tagged
  if (opts.lang !== undefined) doc.Lang = opts.lang;
  if (opts.title !== undefined) {
    doc.SetMetadata({ title: opts.title });
    // A title only satisfies PDF/UA when the viewer is told to show it. Through
    // the property, which is viewerprefs.ts's one writer — this was a third
    // hand-rolled copy of the ensure-the-dict dance until 72nc.3.
    doc.DisplayDocTitle = true;
  }

  const report: AutoTagReport = { headings: 0, paragraphs: 0, figures: 0, artifacts: 0, tables: 0, lists: 0, annotations: 0 };
  const owners = doc.Pages.some(p => p.Dict.has('Annots'))
    ? existingAnnotationOwners(doc, root) : new Map<PdfDict, StructElement>();
  const seenAnnotations = new Set<PdfDict>();

  for (const page of doc.Pages) {
    const annotations = page.Annotations;
    const detected = (opts.tables ?? true) ? page.GetTables() : [];
    const tables = opts.lists === false ? detected : detected.filter(t => !isListTable(t));
    report.artifacts += markFurniture(page, tables.map(t => t.quad));
    const blocks = extractStructured(doc, page, undefined, g =>
      !g.artifact && g.mcid === undefined && !tables.some(t => centerInside(g.quad, t.quad)));
    const regions: TextRegion[] = [], images: (StructElement | 'artifact')[] = [];
    const tagProse = (block: TextBlock) => {
      if (!block.text.trim()) return;
      const level = headingLevel(page, block, blocks);
      const owner = root.Append(level === undefined ? 'P' : `H${level}`);
      for (const line of block.lines) regions.push({ owner, quad: line.quad });
      if (level === undefined) report.paragraphs++; else report.headings++;
    };
    for (const item of pageLayout(doc, page, tables, blocks, opts.lists !== false)) {
      if (item.kind === 'table') {
        tagTable(root, item.value, regions);
        report.tables++;
      } else if (item.kind === 'image') {
        const alt = opts.alt?.(item.value);
        images[item.index] = alt === undefined ? 'artifact' : root.Append('Figure', { alt });
        if (alt === undefined) report.artifacts++; else report.figures++;
      } else {
        const lists = opts.lists === false ? 0 : tagListBlock(doc, root, page, item.value, regions,
          lines => tagProse(blockFromLines(lines)));
        if (lists) report.lists += lists;
        else tagProse(item.value);
      }
    }
    markPagePaint(doc, page, regions, images);
    report.annotations += tagPageAnnotations(doc, root, page, annotations, regions, owners, seenAnnotations);
  }
  return report;
}
