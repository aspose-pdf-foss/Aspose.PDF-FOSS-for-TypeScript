import type { OperationControlOptions } from './checkpoint.js';
import type { Document } from './document.js';
import type { OperationContext, OperationSteps } from './operation.js';
import { resolvePages } from './pagerange.js';
import type { Table, TableExtractOptions } from './tablemodel.js';
import { groupTables, repeatsHeader, type TablePart, type TableStitchOptions } from './tablestitch.js';
import { address, writeXlsx, type XlsxMerge, type XlsxSheet } from './xlsxpackage.js';

/** PDF table structure omitted from the workbook. Locations are one-based.
 * Table numbers here are local to the source page; row and column are local
 * to the original table, including a nested table's own grid. */
export interface XlsxSkipped {
  kind: 'summary' | 'row-section' | 'header-metadata' | 'cell-style' | 'repeated-header' | 'no-tables';
  sheetName?: string;
  pageNumber?: number;
  tableNumber?: number;
  row?: number;
  column?: number;
}

export interface XlsxExportOptions extends TableExtractOptions, TableStitchOptions, OperationControlOptions {
  /** One-based page numbers or a range such as "1-3,5". */
  pages?: number[] | string;
  /** One-based logical table numbers after page filtering and stitching. */
  tables?: readonly number[];
  onSkipped?: (item: XlsxSkipped) => void;
}

function selectedTables(numbers: readonly number[] | undefined, count: number): Set<number> | undefined {
  if (!numbers) return undefined;
  const selected = new Set(numbers);
  for (const number of selected) {
    if (!Number.isInteger(number) || number < 1 || number > count) {
      throw new RangeError(`Table number ${number} out of range (1..${count})`);
    }
  }
  return selected;
}

interface SheetJob { parts: TablePart[]; parent?: string }

function mapSheet(
  parts: TablePart[], id: string, name: string, onSkipped: XlsxExportOptions['onSkipped'],
): { sheet: XlsxSheet; children: SheetJob[] } {
  const rows: string[][] = [];
  const merges: XlsxMerge[] = [];
  const children: SheetJob[] = [];
  let offset = 0;
  for (const part of parts) {
    const { table } = part;
    const source = { sheetName: name, pageNumber: part.page + 1, tableNumber: part.index + 1 };
    if (table.summary) onSkipped?.({ kind: 'summary', ...source });
    const first = table.rows[0];
    // A child table or a vertical span owns data beyond the header text.
    // Dropping that row would lose the child or the span's anchor.
    const drop = part !== parts[0] && repeatsHeader(parts[0].table.rows[0], first)
      && first.cells.every(c => c.row === 0 && c.rowSpan === 1 && !c.tables?.length);
    if (drop) onSkipped?.({ kind: 'repeated-header', ...source, row: 1 });
    const base = offset - Number(drop);
    let height = table.rowCount;
    for (const [i, row] of table.rows.entries()) {
      if (i === 0 && drop) continue;
      if (row.section) onSkipped?.({ kind: 'row-section', ...source, row: (row.cells[0]?.row ?? i) + 1 });
      for (const cell of row.cells) {
        const r = base + cell.row;
        (rows[r] ??= [])[cell.col] = cell.text;
        if (cell.rowSpan > 1 || cell.colSpan > 1) {
          merges.push({ row: r, column: cell.col, rowSpan: cell.rowSpan, columnSpan: cell.colSpan });
          height = Math.max(height, cell.row + cell.rowSpan);
        }
        if (cell.isHeader || cell.scope || cell.id || cell.headers?.length) {
          onSkipped?.({ kind: 'header-metadata', ...source, row: cell.row + 1, column: cell.col + 1 });
        }
        if (cell.borders || cell.shading) {
          onSkipped?.({ kind: 'cell-style', ...source, row: cell.row + 1, column: cell.col + 1 });
        }
        for (const child of cell.tables ?? []) {
          children.push({ parts: [{ ...part, table: child }], parent: id + '!' + address(r, cell.col) });
        }
      }
    }
    offset = base + height;
  }
  return { sheet: { name, rows, merges }, children };
}

/** Shared generator for both public entry points. Packing a ZIP is synchronous;
 * page detection and individual sheets are cooperative work units. */
export function* xlsxSteps(doc: Document, opts: XlsxExportOptions, context: OperationContext): OperationSteps<Uint8Array> {
  const { onSkipped } = opts;
  if (onSkipped !== undefined && typeof onSkipped !== 'function') throw new TypeError('onSkipped must be a function');
  const pages = doc.Pages;
  const selected = resolvePages(opts.pages, pages.length);
  // Keep slots for unselected pages: two selected pages separated by a gap
  // must never be presented to the continuation matcher as adjacent.
  const perPage = pages.map((): Table[] => []);
  for (const [index, number] of selected.entries()) {
    perPage[number - 1] = pages[number - 1].GetTables(opts);
    yield context.progress('pages', index + 1, selected.length, number);
  }
  const groups = groupTables(perPage, opts);
  const filter = selectedTables(opts.tables, groups.length);
  const jobs: SheetJob[] = groups.flatMap((parts, i) => !filter || filter.has(i + 1) ? [{ parts }] : []).reverse();
  const sheets: XlsxSheet[] = [];
  while (jobs.length) {
    const { parts, parent } = jobs.pop()!;
    const id = 'T' + (sheets.length + 1);
    const name = parent ? `${id} (${parent})` : id;
    const { sheet, children } = mapSheet(parts, id, name, onSkipped);
    sheets.push(sheet);
    for (let i = children.length - 1; i >= 0; i--) jobs.push(children[i]);
    yield context.progress('sheets', sheets.length);
  }
  if (!sheets.length) {
    onSkipped?.({ kind: 'no-tables' });
    sheets.push({ name: 'Tables', rows: [] });
  }
  return writeXlsx(sheets);
}
