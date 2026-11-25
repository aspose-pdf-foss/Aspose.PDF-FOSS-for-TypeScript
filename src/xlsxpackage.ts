import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from './ooxml.js';
import { escapeXml } from './xml.js';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
const WORKBOOK = 'xl/workbook.xml';
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const encoder = new TextEncoder();

/** Zero-based top-left corner and positive spans, including the anchor. */
export interface XlsxMerge {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

type Cell = string | number | boolean | null;

export interface XlsxSheet {
  name: string;
  /** Array positions are worksheet coordinates. Nulls and holes are blanks. */
  rows: readonly (readonly Cell[])[];
  merges?: readonly XlsxMerge[];
}

/** ST_Xstring quotes literal escape prefixes before introducing any escapes.
 * The Unicode flag keeps a supplementary character's valid surrogate pair together. */
function xstring(value: string): string {
  return escapeXml(value.replace(/_(?=x[0-9a-fA-F]{4}_)|[\u0000-\u0008\u000b-\u001f\ud800-\udfff\ufffe\uffff]/gu,
    ch => '_x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') + '_'));
}

export function address(row: number, column: number): string {
  let letters = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  }
  return letters + (row + 1);
}

function cellXml(value: Exclude<Cell, null>, ref: string): string {
  if (typeof value === 'string') {
    if (value.length > 32767) throw new RangeError(`Cell text at ${ref} exceeds 32767 characters`);
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xstring(value)}</t></is></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${Number(value)}</v></c>`;
  if (!Number.isFinite(value)) throw new RangeError(`Cell ${ref} needs a finite number`);
  return `<c r="${ref}"><v>${value}</v></c>`;
}

function checkMerge({ row, column, rowSpan, columnSpan }: XlsxMerge): void {
  if (![row, column, rowSpan, columnSpan].every(Number.isInteger) ||
      row < 0 || column < 0 || rowSpan < 1 || columnSpan < 1 ||
      row + rowSpan > MAX_ROWS || column + columnSpan > MAX_COLUMNS) {
    throw new RangeError('Invalid worksheet merge origin or span');
  }
}

function worksheetXml(sheet: XlsxSheet): string {
  if (sheet.rows.length > MAX_ROWS) throw new RangeError('Too many worksheet rows');
  const merges = [...(sheet.merges ?? [])];
  for (const merge of merges) checkMerge(merge);
  merges.sort((a, b) => a.row - b.row || a.column - b.column);

  // Only the last merge in each column can still cover a row. Checking spans
  // this way avoids expanding a tall blank merge or comparing every pair.
  const active: XlsxMerge[] = [];
  let nextMerge = 0;
  const mergeCells: string[] = [];
  function startMergesThrough(row: number): void {
    while (nextMerge < merges.length && merges[nextMerge].row <= row) {
      const m = merges[nextMerge++];
      const endColumn = m.column + m.columnSpan;
      for (let col = m.column; col < endColumn; col++) {
        const previous = active[col];
        if (previous && m.row < previous.row + previous.rowSpan) {
          throw new RangeError(`Overlapping worksheet merges at ${address(m.row, col)}`);
        }
        active[col] = m;
      }
      const end = address(m.row + m.rowSpan - 1, endColumn - 1);
      mergeCells.push(`<mergeCell ref="${address(m.row, m.column)}:${end}"/>`);
    }
  }

  const rows: string[] = [];
  sheet.rows.forEach((values, row) => {
    if (values.length > MAX_COLUMNS) throw new RangeError(`Too many columns in row ${row + 1}`);
    startMergesThrough(row);
    const cells: string[] = [];
    values.forEach((value, column) => {
      if (value === null) return;
      const m = active[column];
      const ref = address(row, column);
      if (m && row < m.row + m.rowSpan && (m.row !== row || m.column !== column)) {
        throw new RangeError(`Worksheet merge would hide cell ${ref}`);
      }
      cells.push(cellXml(value, ref));
    });
    if (cells.length) rows.push(`<row r="${row + 1}">${cells.join('')}</row>`);
  });
  startMergesThrough(MAX_ROWS);
  const ranges = mergeCells.length ? `<mergeCells count="${mergeCells.length}">${mergeCells.join('')}</mergeCells>` : '';
  return `${DECL}<worksheet xmlns="${MAIN_NS}"><sheetData>${rows.join('')}</sheetData>${ranges}</worksheet>`;
}

/** Package already-typed table data as XLSX. Each string is literal cell text. */
export function writeXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (!sheets.length) throw new RangeError('A workbook needs at least one worksheet');
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [
    { source: '', id: 'rId1', type: REL_NS + '/officeDocument', target: WORKBOOK },
  ];
  const names = new Set<string>();
  const sheetList = sheets.map((sheet, index) => {
    const { name } = sheet;
    const key = name.toUpperCase();
    if (!name || name.length > 31 || /[\\/?*:[\]\u0000-\u001f]|^'|'$/u.test(name) ||
        key === 'HISTORY' || names.has(key)) {
      throw new RangeError(`Invalid or duplicate worksheet name: ${name}`);
    }
    names.add(key);
    const id = index + 1;
    const target = `worksheets/sheet${id}.xml`;
    parts.push({ path: 'xl/' + target, bytes: encoder.encode(worksheetXml(sheet)), contentType: CONTENT_TYPE + 'worksheet+xml' });
    rels.push({ source: WORKBOOK, id: `rId${id}`, type: REL_NS + '/worksheet', target });
    return `<sheet name="${xstring(name)}" sheetId="${id}" r:id="rId${id}"/>`;
  });
  const workbook = `${DECL}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheetList.join('')}</sheets></workbook>`;
  parts.push({ path: WORKBOOK, bytes: encoder.encode(workbook), contentType: CONTENT_TYPE + 'sheet.main+xml' });
  return buildOoxmlPackage(parts, rels);
}
