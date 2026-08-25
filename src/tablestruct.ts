import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { Table } from './tablemodel.js';
import type { Rect, TableCell, TableRow, TableExtractOptions } from './tablemodel.js';

const ZERO: Rect = [0, 0, 0, 0];

const unionRect = (rects: Rect[]): Rect => {
  const nz = rects.filter((r) => r[2] > r[0] || r[3] > r[1]);
  if (!nz.length) return ZERO;
  return [
    Math.min(...nz.map((r) => r[0])), Math.min(...nz.map((r) => r[1])),
    Math.max(...nz.map((r) => r[2])), Math.max(...nz.map((r) => r[3])),
  ];
};

const centroid = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const contains = (q: Rect, x: number, y: number): boolean => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3];

/** Collect only top-level Table elements — a table found inside another table's
 *  cells is attached to that cell by buildTable, not returned at top level. */
function findTables(elems: StructElement[], out: StructElement[]): void {
  for (const e of elems) {
    if (e.StandardType === 'Table') out.push(e);
    else findTables(e.Children, out);
  }
}

/** The nearest-enclosed Table elements inside `elem`: descend through non-Table
 *  descendants, stop at and collect the first Table on each branch. */
function collectNested(elem: StructElement, out: StructElement[]): void {
  for (const child of elem.Children) {
    if (child.StandardType === 'Table') out.push(child);
    else collectNested(child, out);
  }
}

interface RawRow { row: StructElement; section?: 'head' | 'body' | 'foot'; }

/** Flatten a Table's children into ordered rows with their section label. */
function tableRows(table: StructElement): RawRow[] {
  const out: RawRow[] = [];
  const section = (child: StructElement, sec: 'head' | 'body' | 'foot') => {
    for (const tr of child.Children) if (tr.StandardType === 'TR') out.push({ row: tr, section: sec });
  };
  for (const child of table.Children) {
    const t = child.StandardType;
    if (t === 'TR') out.push({ row: child });
    else if (t === 'THead') section(child, 'head');
    else if (t === 'TBody') section(child, 'body');
    else if (t === 'TFoot') section(child, 'foot');
  }
  return out;
}

/** The page-space quad for a cell: /BBox layout attribute, else glyph union. */
function cellQuad(cell: StructElement, page: Page): Rect {
  const bbox = cell.LayoutAttributes?.bbox;
  if (bbox) return bbox;
  return cell.GetBBox(page) ?? ZERO;
}

/** Build one Table from a Table structure element. */
function buildTable(table: StructElement, page: Page): Table | undefined {
  const rawRows = tableRows(table);
  if (!rawRows.length) return undefined;

  // HTML-style occupancy: occupied[r] is a set of taken column indices.
  const occupied: Set<number>[] = rawRows.map(() => new Set<number>());
  const rows: TableRow[] = [];
  let colCount = 0;

  rawRows.forEach((rr, r) => {
    const cells: TableCell[] = [];
    let c = 0;
    for (const cellElem of rr.row.Children) {
      const st = cellElem.StandardType;
      if (st !== 'TD' && st !== 'TH') continue;
      while (occupied[r].has(c)) c++;
      const attrs = cellElem.TableAttributes;
      const rowSpan = Math.max(1, attrs?.rowSpan ?? 1);
      const colSpan = Math.max(1, attrs?.colSpan ?? 1);
      for (let dr = 0; dr < rowSpan; dr++)
        for (let dc = 0; dc < colSpan; dc++)
          occupied[r + dr]?.add(c + dc);
      const cell: TableCell = {
        row: r, col: c, rowSpan, colSpan,
        quad: cellQuad(cellElem, page),
        text: cellElem.GetText((e) => e.StandardType === 'Table'),
      };
      if (st === 'TH') cell.isHeader = true;
      if (attrs?.scope) cell.scope = attrs.scope;
      const id = cellElem.ID;
      if (id) cell.id = id;
      if (attrs?.headers && attrs.headers.length) cell.headers = attrs.headers;
      const nested: StructElement[] = [];
      collectNested(cellElem, nested);
      if (nested.length) {
        const childTables = nested
          .map((n) => buildTable(n, page))
          .filter((t): t is Table => t !== undefined);
        if (childTables.length) cell.tables = childTables;
      }
      cells.push(cell);
      colCount = Math.max(colCount, c + colSpan);
      c += colSpan;
    }
    rows.push({ cells, quad: unionRect(cells.map((x) => x.quad)), section: rr.section });
  });

  const quad = unionRect(rows.map((x) => x.quad));
  const summary = table.TableAttributes?.summary;
  return new Table(quad, rows.length, colCount, rows, summary);
}

/** Primary page of a Table: page of its first content-bearing cell, else /Pg. */
function primaryPage(table: StructElement): Page | undefined {
  for (const { row } of tableRows(table))
    for (const cell of row.Children) {
      if (cell.StandardType !== 'TD' && cell.StandardType !== 'TH') continue;
      const p = cell.Page;
      if (p) return p;
    }
  return table.Page;
}

/** The Table model for a single tagged `Table` structure element, built on the
 *  page its content lives on. Undefined when it carries no rows.
 *
 *  Prefer this over locating the element's table by position in
 *  `extractTaggedTables`: /Pg is optional on a Table element whose content all
 *  sits in its cells (what AutoTag authors), so the element and the extracted
 *  table disagree about which page they belong to. */
export function tableFromStruct(elem: StructElement): Table | undefined {
  const page = primaryPage(elem);
  if (!page) return undefined;
  const t = buildTable(elem, page);
  return t && t.rows.length ? t : undefined;
}

/** Extract tables from a page's tagged /Table structure elements. Returns []
 *  when the document is untagged or the page has no Table structure. */
export function extractTaggedTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  const root = doc.GetStructTree();
  if (!root) return [];
  const tables: StructElement[] = [];
  findTables(root.Children, tables);
  const out: Table[] = [];
  for (const te of tables) {
    if (primaryPage(te)?.Number !== page.Number) continue;
    const t = buildTable(te, page);
    if (!t || !t.rows.length) continue;
    if (options.region && !contains(options.region, ...centroid(t.quad))) continue;
    out.push(t);
  }
  return out;
}
