import type { Rect as TextRect } from './text.js';
import type { Rgb } from './colorspace.js';
import { escapeMarkdownInline, escapeTableCell } from './mdescape.js';

export type Rect = TextRect;
export interface TableExtractOptions {
  region?: Rect;
  structure?: 'auto' | 'off';
  /** Detect from content the default optional-content configuration HIDES.
   *  Defaults to false, as every read API does — a table drawn on a switched-off
   *  layer is not a table anybody sees. */
  includeHidden?: boolean;
}

/** One drawn cell edge. `width` is in points; `color` absent means the ink
 *  carried none. */
export interface CellBorder { width: number; color?: Rgb }
export interface CellBorders {
  top?: CellBorder; right?: CellBorder; bottom?: CellBorder; left?: CellBorder;
}

export interface TableCell {
  row: number; col: number; rowSpan: number; colSpan: number;
  quad: Rect; text: string;
  /** Tagged path only: true for a `TH` cell. */
  isHeader?: boolean;
  /** Tagged path only: `/Scope` — 'Row' | 'Column' | 'Both'. */
  scope?: string;
  /** Tagged path only: the element's `/ID`, for header association. */
  id?: string;
  /** Tagged path only: `/Headers` — ids of the header cells that describe this cell. */
  headers?: string[];
  /** Tables nested inside this cell (recursive). Absent when none. */
  tables?: Table[];
  /** The cell's drawn edges, when they could be recovered.
   *
   *  **Invariant:** ABSENT means *not recovered* — a tagged table, a rotated
   *  table, a page whose ink could not be read — and a consumer must fall back
   *  to whatever it drew before this field existed. An edge missing from a
   *  PRESENT `borders` means *measured absent*: there is genuinely no rule
   *  there, and it must draw nothing. The two want opposite renderings, and
   *  collapsing them is the mistake `parseSimpleWidths` records about a present
   *  versus an absent `/MissingWidth`. A present-but-EMPTY object is therefore
   *  meaningful: recovered, and this cell has no drawn edge at all. */
  borders?: CellBorders;
  /** The cell's recovered background, absent when none was found. */
  shading?: Rgb;
}
export interface TableRow { cells: TableCell[]; quad: Rect; section?: 'head' | 'body' | 'foot'; }

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Map a PDF table-header `/Scope` to a valid HTML `scope` value. HTML permits
 *  only col|row|colgroup|rowgroup, so 'Both' (no HTML equivalent) is omitted —
 *  the `/Headers` association carries that relationship instead. */
const cssHex = (rgb: readonly number[]): string =>
  '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16)
    .padStart(2, '0')).join('').toUpperCase();

/** Inline style for a recovered cell, or '' when the cell was not recovered.
 *
 *  An unrecovered cell emits NO style attribute at all, which is what keeps
 *  every existing snapshot of an unruled or tagged table exactly as it was —
 *  the same absent-versus-measured-absent rule `TableCell.borders` records. */
function cellStyle(c: TableCell): string {
  if (!c.borders && !c.shading) return '';
  const parts: string[] = [];
  if (c.borders) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const b = c.borders[side];
      parts.push(b
        ? `border-${side}: ${b.width}pt solid ${b.color ? cssHex(b.color) : 'currentColor'}`
        : `border-${side}: none`);
    }
  }
  if (c.shading) parts.push(`background-color: ${cssHex(c.shading)}`);
  return ` style="${escHtml(parts.join('; '))}"`;
}

const htmlScope = (scope: string): string | undefined =>
  scope === 'Column' ? 'col' : scope === 'Row' ? 'row' : undefined;

/** A reconstructed table: a rows×cells model with page-space quads and text,
 *  serializable to HTML or Markdown. */
export class Table {
  constructor(
    public quad: Rect,
    public rowCount: number,
    public colCount: number,
    public rows: TableRow[],
    /** Tagged path only: the table's `/Summary`. */
    public summary?: string,
    /** For a stitched table: the contributing page rectangles, in page order.
     *  Absent for a single-page (non-stitched) table. */
    public pageSpans?: { page: number; quad: Rect }[],
  ) {}

  /** Rotation of the table in radians; 0 for axis-aligned. Quads are in the
   *  table's own upright frame — map a corner to page space via a rotation by
   *  `angle` about the origin. */
  angle = 0;

  toHtml(): string {
    const emitRow = (lines: string[], row: TableRow) => {
      lines.push('  <tr>');
      for (const c of row.cells) {
        const tag = c.isHeader ? 'th' : 'td';
        const scope = c.scope ? htmlScope(c.scope) : undefined;
        const attrs =
          (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '') +
          (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '') +
          (scope ? ` scope="${scope}"` : '') +
          (c.id ? ` id="${escHtml(c.id)}"` : '') +
          (c.headers && c.headers.length ? ` headers="${escHtml(c.headers.join(' '))}"` : '') +
          cellStyle(c);
        const inner = escHtml(c.text).replace(/\n/g, '<br/>');
        const nested = c.tables?.length ? c.tables.map((t) => t.toHtml()).join('') : '';
        lines.push(`    <${tag}${attrs}>${inner}${nested}</${tag}>`);
      }
      lines.push('  </tr>');
    };

    const lines = ['<table>'];
    if (this.summary) lines.push(`  <caption>${escHtml(this.summary)}</caption>`);
    const hasSections = this.rows.some((r) => r.section);
    if (hasSections) {
      const groups: ['thead' | 'tbody' | 'tfoot', 'head' | 'body' | 'foot'][] =
        [['thead', 'head'], ['tbody', 'body'], ['tfoot', 'foot']];
      for (const [tag, sec] of groups) {
        const rows = this.rows.filter((r) => r.section === sec);
        if (!rows.length) continue;
        lines.push(`  <${tag}>`);
        for (const row of rows) emitRow(lines, row);
        lines.push(`  </${tag}>`);
      }
      for (const row of this.rows.filter((r) => !r.section)) emitRow(lines, row);
    } else {
      for (const row of this.rows) emitRow(lines, row);
    }
    lines.push('</table>');
    return lines.join('\n');
  }

  /** The grid row indices this table considers its header, in grid order.
   *
   *  Semantic where the table reports one — `/THead`, else a row 0 made entirely
   *  of `TH` — because promoting a row of data to a heading misstates it.
   *
   *  **Invariant:** a table carrying NO header information is a different case
   *  from one that reports none, and they get different answers. `isHeader` and
   *  `section` are tagged-path only, so a geometry-detected table sets neither:
   *  that is ignorance, and row 0 stays the header, which is both the
   *  overwhelmingly common layout and what this method has always emitted. A
   *  table that *did* report its structure and named no head genuinely has none.
   *  Collapsing the two is the mistake `parseSimpleWidths` records — losing the
   *  difference between "the font says zero" and "the font says nothing". */
  private headerRowIndices(): number[] {
    const sectioned = this.rows
      .filter((r) => r.section === 'head' && r.cells.length)
      .map((r) => r.cells[0].row);
    if (sectioned.length) return [...new Set(sectioned)].sort((a, b) => a - b);

    const first = this.rows.find((r) => r.cells.length && r.cells[0].row === 0);
    if (first && first.cells.length && first.cells.every((c) => c.isHeader)) return [0];

    const informed = this.rows.some(
      (r) => r.section !== undefined || r.cells.some((c) => c.isHeader));
    return informed ? [] : [0];
  }

  toMarkdown(): string {
    // GFM's grammar has no table without a delimiter row, and a delimiter row
    // needs a width. Returning '' lets the caller drop the block entirely
    // rather than emitting a malformed one.
    if (this.rowCount === 0 || this.colCount === 0) return '';

    // Expand spans into a dense grid of strings (colSpan repeats, rowSpan blanks below).
    const grid: string[][] = Array.from({ length: this.rowCount }, () => new Array(this.colCount).fill(''));
    const nested: Table[] = [];
    for (const row of this.rows) {
      for (const c of row.cells) {
        // A newline becomes <br/>, as toHtml does — GFM accepts inline HTML in a
        // cell, and collapsing to a space loses the author's line break. Applied
        // AFTER escaping, which preserves newlines but would escape the '<'.
        const cell = escapeTableCell(c.text).replace(/\n/g, '<br/>');
        for (let dr = 0; dr < c.rowSpan; dr++)
          for (let dc = 0; dc < c.colSpan; dc++)
            grid[c.row + dr][c.col + dc] = dr === 0 ? cell : '';
        if (c.tables?.length) nested.push(...c.tables);
      }
    }

    const fmt = (r: string[]) => `| ${r.join(' | ')} |`;
    const delim = `| ${new Array(this.colCount).fill('---').join(' | ')} |`;

    // GFM permits exactly ONE header row. Where a table declares several, the
    // first becomes the header and the rest stay body rows: content preserved,
    // structure as near as the format allows. Merging them would invent text.
    const header = this.headerRowIndices();
    const headIdx = header.length ? header[0] : undefined;
    const out: string[] = [];
    if (this.summary) out.push(escapeMarkdownInline(this.summary), '');
    out.push(headIdx === undefined ? fmt(new Array(this.colCount).fill('')) : fmt(grid[headIdx]));
    out.push(delim);
    for (let r = 0; r < grid.length; r++) if (r !== headIdx) out.push(fmt(grid[r]));

    // GFM cannot nest a table, so an inner one follows the outer as its own
    // block rather than vanishing. The cell keeps its own text either way.
    const self = out.join('\n');
    const inner = nested.map((t) => t.toMarkdown()).filter((s) => s);
    return inner.length ? [self, ...inner].join('\n\n') : self;
  }
}
