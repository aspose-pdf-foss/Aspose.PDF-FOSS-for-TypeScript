import type { CellBorder, CellBorders, Table, TableCell } from './tablemodel.js';
import { TWIPS_PER_PT } from './docxstyles.js';

const SIDES = ['top', 'left', 'bottom', 'right'] as const;

/** `w:sz` is in EIGHTHS of a point, and Word's accepted range is 2..96. */
function borderSz(width: number): number {
  return Math.max(2, Math.min(96, Math.round(width * 8)));
}

const hex = (rgb: readonly number[]): string =>
  rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('').toUpperCase();

/** One cell edge. An edge measured ABSENT draws nothing — distinct from a cell
 *  that was never recovered, which does not reach this function at all because
 *  the caller falls back to the table-level frame. */
function edgeXml(side: string, b: CellBorder | undefined): string {
  if (!b) return `<w:${side} w:val="none"/>`;
  const color = b.color ? hex(b.color) : 'auto';
  return `<w:${side} w:val="single" w:sz="${borderSz(b.width)}" w:color="${color}"/>`;
}

function tcBordersXml(borders: CellBorders): string {
  return `<w:tcBorders>${SIDES.map((s) => edgeXml(s, borders[s])).join('')}</w:tcBorders>`;
}

/** `paragraph` builds one `w:p` from cell text.
 *
 *  **Invariant:** it is PASSED IN rather than imported. `docxflow.ts` calls
 *  this module, so importing back would close a cycle — and a second paragraph
 *  emitter is how a cell comes to lose the `xml:space` attribute or the
 *  control-character strip that the rest of the document has. */
export interface DocxTableCtx { paragraph(text: string): string }

/** Column widths in points, from every cell's left edge plus the table's right
 *  edge.
 *
 *  Auto-fit is not attempted: the geometry the extractor recovered is the best
 *  statement available of what the columns were, and re-measuring the text
 *  would contradict it. */
function gridWidths(table: Table): number[] {
  const edges = new Set<number>();
  for (const r of table.rows) for (const c of r.cells) edges.add(c.quad[0]);
  edges.add(table.quad[2]);
  const sorted = [...edges].sort((a, b) => a - b);
  const widths: number[] = [];
  for (let i = 1; i < sorted.length; i++) widths.push(sorted[i] - sorted[i - 1]);
  return widths.length ? widths : [table.quad[2] - table.quad[0]];
}

/** The columns covered at `rowIndex` by a rowSpan started in an earlier row. */
function coveredColumns(table: Table, rowIndex: number): Set<number> {
  const out = new Set<number>();
  for (let r = 0; r < rowIndex; r++) {
    for (const c of table.rows[r]?.cells ?? []) {
      if (c.rowSpan > 1 && r + c.rowSpan > rowIndex) {
        for (let i = 0; i < c.colSpan; i++) out.add(c.col + i);
      }
    }
  }
  return out;
}

function cellXml(c: TableCell, widthTwips: number, ctx: DocxTableCtx): string {
  // **Invariant:** w:tcPr's children are schema-ORDERED, not free: tcW,
  // gridSpan, vMerge, tcBorders, shd. Wrong order is a file Word refuses
  // outright, so a new property is INSERTED at its place, never appended.
  const props = `<w:tcW w:w="${Math.round(widthTwips)}" w:type="dxa"/>`
    + (c.colSpan > 1 ? `<w:gridSpan w:val="${c.colSpan}"/>` : '')
    + (c.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '')
    + (c.borders ? tcBordersXml(c.borders) : '')
    + (c.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.shading)}"/>` : '');
  // A nested table nests directly, unlike GFM. WordprocessingML requires a
  // paragraph AFTER a nested table, or the cell has no closing paragraph mark.
  const nested = (c.tables ?? []).map((t) => docxTable(t, ctx)).join('');
  const body = ctx.paragraph(c.text) + nested + (nested ? ctx.paragraph('') : '');
  return `<w:tc><w:tcPr>${props}</w:tcPr>${body}</w:tc>`;
}

/** A continuation cell for a rowSpan started above. */
function mergedCellXml(widthTwips: number, ctx: DocxTableCtx): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${Math.round(widthTwips)}" w:type="dxa"/>`
    + `<w:vMerge/></w:tcPr>${ctx.paragraph('')}</w:tc>`;
}

/** An extracted table as `w:tbl`.
 *
 *  **Invariant:** every `w:tc` contains at least one `w:p`. An empty table cell
 *  is invalid WordprocessingML and Word refuses the document — an empty
 *  PARAGRAPH is how the format spells an empty cell.
 *
 *  `Table.summary` is deliberately not emitted: it has no obvious home here,
 *  and an element the schema does not accept fails the whole part rather than
 *  one table. It belongs with the border work that reads the rest of the
 *  recovered attributes. */
export function docxTable(table: Table, ctx: DocxTableCtx): string {
  if (!table.rows.length) return '';
  const widths = gridWidths(table).map((w) => Math.round(w * TWIPS_PER_PT));
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const total = widths.reduce((a, b) => a + b, 0);

  const rows = table.rows.map((r, ri) => {
    const covered = coveredColumns(table, ri);
    const header = r.cells.length > 0 && r.cells.every((c) => c.isHeader);
    const cells: string[] = [];
    let col = 0;
    for (const c of r.cells) {
      while (covered.has(col) && col < widths.length) {
        cells.push(mergedCellXml(widths[col] ?? 0, ctx));
        col++;
      }
      const span = widths.slice(col, col + c.colSpan).reduce((a, b) => a + b, 0);
      cells.push(cellXml(c, span || widths[col] || 0, ctx));
      col += c.colSpan;
    }
    while (col < widths.length && covered.has(col)) {
      cells.push(mergedCellXml(widths[col] ?? 0, ctx));
      col++;
    }
    // w:tblHeader makes Word repeat the row when the table breaks a page.
    const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
  }).join('');

  // **Invariant:** a recovered table OMITS the table-level frame and states all
  // four edges on every cell. Keeping both leaves two sources for one edge with
  // Word's specificity rules deciding between them, which is what makes "why is
  // this border here" unanswerable. An UNRECOVERED table emits exactly what
  // shipped before this feature existed, byte for byte.
  const recovered = table.rows.some((r) => r.cells.some((c) => c.borders));
  const frame = recovered ? '' : '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="auto"/>`).join('')
    + '</w:tblBorders>';
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>`
    + `${frame}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}
