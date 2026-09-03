import { AuthoringFont, validateFont } from './stamp.js';
import {
  validateDecoration, validateBackground, isTextRunList,
  type Decoration, type Background, type TextRun,
} from './textdecor.js';
import { EmbeddedFont } from './embeddedfont.js';
import { FontDriver, winAnsiDriver, layoutText, layoutRuns } from './layout.js';
import { buildImageXObject, BuiltImage } from './imageembed.js';
import { buildSpanGrid, applySpanDeficits, type SpanGrid } from './tablespan.js';
import { textExtents } from './textextents.js';

// The sides vocabulary is shared with floatbox.ts and lives in its own module;
// re-exported here so `BorderInfo` and its `sides` stay one import for callers.
import { countBorderEdges, checkBorderSides, type BorderSides } from './bordersides.js';
import { coverageOf, type Undrawable } from './textcoverage.js';
export {
  resolveBorderSides, countBorderEdges, checkBorderSides,
  type BorderSides, type BorderEdges,
} from './bordersides.js';

/** A cell/table border: stroke width (pt), RGB colour (0..1), optional dash, and
 *  which edges to paint. */
export interface BorderInfo {
  width: number;
  color: [number, number, number];
  dash?: number[];
  /** Edges to paint. Default `'all'`, which keeps output byte-identical to a
   *  border written before this field existed. */
  sides?: BorderSides;
}

/** How many of a border's edges are painted. Thin wrapper over
 *  {@link countBorderEdges} so callers holding a whole {@link BorderInfo} do not
 *  have to reach into `.sides`. */
export function borderEdgeCount(b: BorderInfo): number {
  return countBorderEdges(b.sides);
}

/** Inner cell padding: one value for every side, or an object naming the sides
 *  that differ. Each side resolves through the cascade independently, so a cell's
 *  `{ top: 10 }` over a table's `padding: 6` is `{ 10, 6, 6, 6 }` — an omitted
 *  side inherits rather than collapsing to zero. */
export type Padding =
  | number
  | { top?: number; right?: number; bottom?: number; left?: number };

/** Padding with every side settled to a number. */
export interface ResolvedPadding {
  top: number; right: number; bottom: number; left: number;
}

const PAD_SIDES = ['top', 'right', 'bottom', 'left'] as const;
type PadSide = typeof PAD_SIDES[number];

/** One side's value at a single cascade level, or undefined if unset there. */
function padSide(p: Padding | undefined, side: PadSide): number | undefined {
  if (p === undefined) return undefined;
  return typeof p === 'number' ? p : p[side];
}

/** Resolve padding side by side down `levels` (nearest first), falling back to
 *  the built-in 2pt. Per side rather than per level: that is what lets a partial
 *  `{ top: 10 }` inherit the other three from the level below it. */
export function resolvePadding(...levels: (Padding | undefined)[]): ResolvedPadding {
  const pick = (side: PadSide): number => {
    for (const l of levels) {
      const v = padSide(l, side);
      if (v !== undefined) return v;
    }
    return 2;
  };
  return { top: pick('top'), right: pick('right'), bottom: pick('bottom'), left: pick('left') };
}

/** Per-cell/row text + visual style; each field falls back through the cascade
 *  (cell ?? row ?? table ?? built-in). */
export interface CellTextOptions {
  font?: AuthoringFont;
  fontSize?: number;
  leading?: number;
  color?: [number, number, number];
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'center' | 'bottom';
  border?: BorderInfo;
  background?: [number, number, number];
  /** Rule below the baseline of the cell's text. Default: none. */
  underline?: Decoration;
  /** Rule through the cell's text. Default: none. */
  strikethrough?: Decoration;
  /** Fill behind the cell's *text* (text-tight, per line). Distinct from
   *  `background`, which fills the whole cell box. Default: none. */
  textBackground?: Background;
  /** Inner padding, scalar or per side. Default 2pt. Sizes the text box in both
   *  directions, so it feeds row height as well as wrapping width. */
  padding?: Padding;
}

/** Table-level defaults; the cascade root, plus table-only fields. */
export interface TableDefaults extends CellTextOptions {
  /** Border around the whole table. */
  outerBorder?: BorderInfo;
}

/** A column-width spec: an absolute width in points (`fixed`), or a share of the
 *  leftover space after fixed columns are allotted (`fraction`). */
export type ColumnWidth = { fixed: number } | { fraction: number };

/** How a cell is marked in a tagged table: a /TH carrying the given /Scope, or a
 *  /TD. `true` is shorthand for 'column'; `false` opts the cell out of the
 *  repeating-header-row inference, so a blank corner cell in a header row stays
 *  a /TD. */
export type CellHeader = boolean | 'row' | 'column';

/** `addCell` options: the per-cell text style plus an optional horizontal span. */
export interface CellOptions extends CellTextOptions {
  /** Number of columns this cell spans. Integer >= 1. Default 1. */
  colSpan?: number;
  /** Number of rows this cell spans. Integer >= 1. Default 1. Rows below a
   *  spanning cell OMIT the covered cells, as HTML does — there is no
   *  placeholder vocabulary, because a placeholder would be a second way to
   *  say the same thing and the two would drift.
   *
   *  Clamped, silently, to the table's last row and (for a cell in the
   *  repeating-header rows) to the end of the header block. Rows are appended
   *  after `addCell`, so a caller cannot know the final row count when they
   *  set the span; the clamped value is what a tagged table's /RowSpan
   *  states. */
  rowSpan?: number;
  /** Emit this cell as a /TH rather than a /TD when the table is drawn with
   *  `{ tagged: true }`. Default: cells in the repeating-header rows are column
   *  headers, every other cell is a /TD. Ignored when the table is drawn
   *  untagged. */
  header?: CellHeader;
}

/** `addRow` options: the row-level text style plus row-only geometry. */
export interface RowOptions extends CellTextOptions {
  /** Floor for the row's laid height in points, before pagination. The row is
   *  `max(minHeight, content height)`, so content that needs more still wins;
   *  each cell's `valign` then positions its content within the enlarged box.
   *  Non-negative; default 0 (height is purely content-derived). */
  minHeight?: number;
}

/** `setImage` options: image sizing, placement, and opacity for a cell image. */
export interface CellImageOptions {
  /** Explicit image content height in points; default aspect-fit to inner width. */
  height?: number;
  /** Horizontal placement in the cell box; default the cell's resolved align. */
  align?: 'left' | 'center' | 'right';
  /** Vertical placement in the cell box; default the cell's resolved valign. */
  valign?: 'top' | 'center' | 'bottom';
  /** Constant opacity 0..1 (reuses /ExtGState). Default 1. */
  opacity?: number;
  /** Override JPEG/PNG sniffing. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Alt text for the /Figure this image gets when the table is drawn with
   *  `{ tagged: true }`. Ignored when the table is drawn untagged. */
  alt?: string;
  /** Mark this image as an /Artifact when the table is drawn with
   *  `{ tagged: true }` — decoration that carries no meaning and gets no
   *  /Figure. Cannot be combined with `alt`. Ignored when drawn untagged. */
  artifact?: boolean;
}

/** Measurement result for a table at given resolved column widths. */
export interface TableMetrics {
  /** Per-row laid height in points. */
  rowHeights: number[];
  /** Sum of `rowHeights`. */
  totalHeight: number;
  /** `cellLines[row][col]` = the wrapped line texts of that cell. */
  cellLines: string[][][];
  /** @internal The occupancy grid this measurement was taken against. Both
   *  pagination loops already call `measure`, so the safe-break set arrives
   *  where it is needed without a second computation and without a new
   *  parameter. */
  grid: SpanGrid;
}

/** A cell's fully-resolved style (no undefined text fields). */
export interface ResolvedStyle {
  font: AuthoringFont;
  fontSize: number;
  leading: number;
  color: [number, number, number];
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'bottom';
  border?: BorderInfo;
  background?: [number, number, number];
  underline?: Decoration;
  strikethrough?: Decoration;
  textBackground?: Background;
  padding: ResolvedPadding;
}

const EMPTY = new Uint8Array(0);

/** A {@link FontDriver} that measures/wraps like the real font but records no
 *  glyph usage — `encode` returns empty bytes, which measurement ignores. This
 *  keeps `measure()` side-effect-free for embedded fonts. */
function measuringDriverFor(font: AuthoringFont): FontDriver {
  const real: FontDriver = font instanceof EmbeddedFont ? font.driver() : winAnsiDriver(font);
  return { measure: (t, fs) => real.measure(t, fs), probe: (t) => real.probe(t), encode: () => EMPTY };
}

/** The widest single LINE (max-content) and widest single WORD (min-content) of
 *  a cell's content, in points, excluding padding. The rules live in
 *  textextents.ts, shared with a CSS float's shrink-to-fit — one owner for
 *  "how wide does this content want to be". */
function cellExtents(
  text: string | TextRun[], st: ResolvedStyle,
): { longestLine: number; longestWord: number } {
  return textExtents(text, st.font, st.fontSize);
}

/** Distribute `total` across columns from their measured content.
 *
 *  Proportional to max-content handles both regimes with one rule: when the
 *  natural widths fit, every column gets its need plus a share of the slack;
 *  when they do not, all shrink together rather than one collapsing. Anything
 *  landing under its min-content is then raised to it, and the shortfall taken
 *  proportionally from the columns still above their own floor. */
function autoFitWidths(max: number[], min: number[], total: number): number[] {
  const n = max.length;
  const maxSum = max.reduce((a, b) => a + b, 0);
  const minSum = min.reduce((a, b) => a + b, 0);
  // Nothing can satisfy the floors (or there is no content to go on): equal
  // shares is the honest answer rather than an arbitrary winner. Not an error —
  // a table too narrow for its own words is a layout outcome.
  if (minSum > total || maxSum <= 0) return new Array<number>(n).fill(total / n);
  const w = max.map((m) => (total * m) / maxSum);
  const under = w.map((x, i) => x < min[i]);
  if (!under.some(Boolean)) return w;
  let shortfall = 0;
  let slack = 0;
  for (let i = 0; i < n; i++) {
    if (under[i]) { shortfall += min[i] - w[i]; w[i] = min[i]; } else slack += w[i] - min[i];
  }
  // slack >= shortfall always: sum(w - min) = total - minSum >= 0, and the
  // columns under their floor contribute -shortfall to that sum, so the rest
  // hold at least shortfall between them. The redistribution lands exactly on
  // `total`; the guard is defensive only.
  if (slack > 0) {
    for (let i = 0; i < n; i++) if (!under[i]) w[i] -= (shortfall * (w[i] - min[i])) / slack;
  }
  return w;
}

/** Report what each cell's resolved face cannot draw, ONCE (`zch2.14`).
 *
 *  A cell's effective font comes from the cell -> row -> table cascade, which
 *  {@link resolveCellStyle} owns, so this cannot live in the shared flow
 *  builders the way a paragraph's check does — a cell never goes through them.
 *  Called explicitly by each consumer rather than from `measure`, which the
 *  flow engine runs speculatively many times per table. @internal */
export function reportTableCoverage(
  t: TableBuilder, onUndrawable: (u: Undrawable) => void,
): void {
  for (const row of t.rows) {
    for (const cell of row.cells) {
      const st = resolveCellStyle(cell, row.style, t.defaults);
      const u = coverageOf(
        cell.text, st.font, st.font instanceof EmbeddedFont && st.font.shape,
      );
      if (u !== undefined) onUndrawable(u);
    }
  }
}

/** Resolve a cell's style: cell ?? row ?? table ?? built-in
 *  (Helvetica / 12pt / 1.2*fontSize leading / black / left / top / no border /
 *  no background / 2pt padding). `tablePadding` is the draw-time
 *  `cellPadding` override, which stands in for the table level — so it beats
 *  `table.padding` but still loses to a row or a cell. */
export function resolveCellStyle(
  cell: CellBuilder, row: CellTextOptions, table: TableDefaults,
  tablePadding?: Padding,
): ResolvedStyle {
  const o = cell.options;
  const fontSize = o.fontSize ?? row.fontSize ?? table.fontSize ?? 12;
  return {
    font: o.font ?? row.font ?? table.font ?? 'Helvetica',
    fontSize,
    leading: o.leading ?? row.leading ?? table.leading ?? 1.2 * fontSize,
    color: o.color ?? row.color ?? table.color ?? [0, 0, 0],
    align: o.align ?? row.align ?? table.align ?? 'left',
    valign: o.valign ?? row.valign ?? table.valign ?? 'top',
    border: o.border ?? row.border ?? table.border,
    background: o.background ?? row.background ?? table.background,
    underline: o.underline ?? row.underline ?? table.underline,
    strikethrough: o.strikethrough ?? row.strikethrough ?? table.strikethrough,
    textBackground: o.textBackground ?? row.textBackground ?? table.textBackground,
    padding: resolvePadding(o.padding, row.padding, tablePadding, table.padding),
  };
}

function checkPos(label: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    throw new TypeError(`${label} must be a positive finite number`);
}

function checkColor(rgb: [number, number, number]): void {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
}

function checkNonNeg(label: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
    throw new TypeError(`${label} must be a non-negative finite number`);
}

function checkAlign(a: unknown): void {
  if (a !== 'left' && a !== 'center' && a !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
}

function checkValign(v: unknown): void {
  if (v !== 'top' && v !== 'center' && v !== 'bottom')
    throw new TypeError("valign must be 'top', 'center', or 'bottom'");
}

function checkOpacity(n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)
    throw new TypeError('opacity must be a number in 0..1');
}

function checkBorder(b: BorderInfo): void {
  if (typeof b !== 'object' || b === null)
    throw new TypeError('border must be a { width, color, dash? } object');
  checkPos('border.width', b.width);
  checkColor(b.color);
  if (b.dash !== undefined &&
      (!Array.isArray(b.dash) || !b.dash.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)))
    throw new TypeError('border.dash must be an array of non-negative finite numbers');
  checkBorderSides(b.sides);
}

/** Validate a {@link Padding}. Unknown object keys are rejected on the same
 *  reasoning as `border.sides`: a misspelt side would silently inherit instead
 *  of applying, which is invisible until someone measures the output. */
function checkPadding(p: Padding): void {
  const bad = () => new TypeError(
    'padding must be a non-negative finite number, or an object of ' +
    'top/right/bottom/left non-negative finite numbers');
  if (typeof p === 'number') {
    checkNonNeg('padding', p);
    return;
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw bad();
  for (const [k, v] of Object.entries(p)) {
    if (!(PAD_SIDES as readonly string[]).includes(k)) throw bad();
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad();
  }
}

/** Validate the cascadable style fields shared by table/row/cell. */
function validateStyleOpts(o: CellTextOptions): void {
  if (o.font !== undefined) validateFont(o.font);
  if (o.fontSize !== undefined) checkPos('fontSize', o.fontSize);
  if (o.leading !== undefined) checkPos('leading', o.leading);
  if (o.color !== undefined) checkColor(o.color);
  if (o.align !== undefined) checkAlign(o.align);
  if (o.valign !== undefined) checkValign(o.valign);
  if (o.border !== undefined) checkBorder(o.border);
  if (o.background !== undefined) checkColor(o.background);
  if (o.padding !== undefined) checkPadding(o.padding);
  validateDecoration('underline', o.underline);
  validateDecoration('strikethrough', o.strikethrough);
  validateBackground('textBackground', o.textBackground);
}

/** Validate one column-width spec and return a normalized single-key copy, so
 *  later discrimination via `'fixed' in w` is reliable. */
function normColumnWidth(w: ColumnWidth): ColumnWidth {
  const fx = (w as { fixed?: unknown }).fixed;
  const fr = (w as { fraction?: unknown }).fraction;
  const hasFixed = fx !== undefined;
  const hasFraction = fr !== undefined;
  if (hasFixed === hasFraction)
    throw new TypeError('each column width must have exactly one of { fixed } or { fraction }');
  const v = hasFixed ? fx : fr;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
    throw new TypeError(`column width ${hasFixed ? 'fixed' : 'fraction'} must be a positive finite number`);
  return hasFixed ? { fixed: v } : { fraction: v };
}

function validateColSpan(n: number): void {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new TypeError('colSpan must be an integer >= 1');
}

function validateRowSpan(n: number): void {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1)
    throw new TypeError('rowSpan must be an integer >= 1');
}

function validateHeader(h: unknown): void {
  if (h === undefined || typeof h === 'boolean' || h === 'row' || h === 'column') return;
  throw new TypeError("header must be a boolean, 'row', or 'column'");
}

/** One cell in a table row: a text string, optional per-cell style, and how many
 *  columns it spans. */
export class CellBuilder {
  /** A cached cell image (from {@link setImage}) with intrinsic pixel size, or
   *  undefined. Painted aspect-fit into the cell box, under any cell text. */
  image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions };

  constructor(
    public text: string | TextRun[],
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
    readonly rowSpan: number = 1,
    readonly header?: CellHeader,
  ) {}

  /** Embed `data` (JPEG/PNG) in this cell, aspect-fit to the cell box. Validates
   *  and builds the image XObject once, caching it with its intrinsic pixel size.
   *  Bad image bytes throw from `buildImageXObject`. Chainable. */
  setImage(data: Uint8Array, opts: CellImageOptions = {}): this {
    if (!(data instanceof Uint8Array)) throw new TypeError('setImage data must be a Uint8Array');
    if (opts.height !== undefined) checkPos('image height', opts.height);
    if (opts.align !== undefined) checkAlign(opts.align);
    if (opts.valign !== undefined) checkValign(opts.valign);
    if (opts.opacity !== undefined) checkOpacity(opts.opacity);
    if (opts.alt !== undefined && typeof opts.alt !== 'string')
      throw new TypeError('image alt must be a string');
    if (opts.artifact !== undefined && typeof opts.artifact !== 'boolean')
      throw new TypeError('image artifact must be a boolean');
    if (opts.artifact && opts.alt !== undefined)
      throw new TypeError('image artifact cannot be combined with alt');
    const built = buildImageXObject(data, opts.format);
    const width = built.stream.dict.get('Width') as number;
    const height = built.stream.dict.get('Height') as number;
    this.image = { built, width, height, opts };
    return this;
  }
}

/** One row: an ordered list of cells plus an optional row-level style. */
export class RowBuilder {
  readonly cells: CellBuilder[] = [];

  /** @internal Backing store for {@link minHeight} / {@link setMinHeight}. */
  private _minHeight: number;

  /** @internal Use {@link TableBuilder.addRow}. Geometry lives beside the style,
   *  not in it: `minHeight` is a row-only property and must not reach
   *  {@link resolveCellStyle}'s cascade. */
  constructor(readonly style: CellTextOptions = {}, minHeight = 0) {
    this._minHeight = minHeight;
  }

  /** This row's height floor in points (default 0 = purely content-derived). */
  get minHeight(): number {
    return this._minHeight;
  }

  /** Set this row's height floor in points: the row lays out at
   *  `max(n, content height)`, so content that needs more still wins. Overrides
   *  the `minHeight` passed to {@link TableBuilder.addRow}; `n = 0` restores a
   *  purely content-derived height. Non-negative. Chainable — this is the setter
   *  for a row built cell by cell, where there is no options object to pass. */
  setMinHeight(n: number): this {
    checkNonNeg('minHeight', n);
    this._minHeight = n;
    return this;
  }

  /** Append a cell with `text` (default '') and optional per-cell style/span. */
  /** Append a cell. `text` may be a plain string or a {@link TextRun} list,
   *  which renders the same inline vocabulary a paragraph does — mixed fonts,
   *  sizes, colours, decorations and links. */
  addCell(text: string | TextRun[] = '', opts: CellOptions = {}): CellBuilder {
    const { colSpan = 1, rowSpan = 1, header, ...style } = opts;
    validateColSpan(colSpan);
    validateRowSpan(rowSpan);
    validateHeader(header);
    validateStyleOpts(style);
    const c = new CellBuilder(text, style, colSpan, rowSpan, header);
    this.cells.push(c);
    return c;
  }
}

/** A page-independent table: ordered rows over shared text defaults. Build it
 *  with {@link createTable}, then measure (and later render) it. */
export class TableBuilder {
  readonly rows: RowBuilder[] = [];

  /** @internal Normalized column specs from {@link setColumnWidths};
   *  undefined => equal columns at resolve time. */
  private columnSpecs?: ColumnWidth[];

  /** @internal Set by {@link autoFitColumns}; read by resolveColumnWidths. */
  private autoFit = false;

  /** @internal Fixed column count for continuation tables; when set, overrides
   *  the rows-derived count so resolveColumnWidths matches the original table
   *  even if the leftover rows are narrower. */
  private forcedColumnCount?: number;

  /** @internal Repeat the first N rows atop each continuation page; 0 = none. */
  private _repeatingRows = 0;

  /** @internal Use {@link createTable}. */
  constructor(readonly defaults: TableDefaults) {}

  /** Append a row with an optional row-level `style` and `minHeight`. With a
   *  `string[]`, appends one text cell per entry (each inheriting the row +
   *  table style). */
  addRow(cells?: (string | TextRun[])[], opts: RowOptions = {}): RowBuilder {
    const { minHeight, ...style } = opts;
    if (minHeight !== undefined) checkNonNeg('minHeight', minHeight);
    validateStyleOpts(style);
    const r = new RowBuilder(style, minHeight);
    if (cells) for (const t of cells) r.addCell(t);
    this.rows.push(r);
    return r;
  }

  /** Set per-column widths as `fixed` points or `fraction`s of the leftover
   *  space. Chainable. The count is validated against the table's columns at
   *  resolve time (rows may be added afterward), not here. */
  setColumnWidths(widths: ColumnWidth[]): this {
    if (!Array.isArray(widths)) throw new TypeError('columnWidths must be an array');
    this.columnSpecs = widths.map(normColumnWidth);
    return this;
  }

  /** Size columns from their content rather than splitting the width equally:
   *  proportional to each column's widest unwrapped line, floored at its widest
   *  single word, falling back to equal shares when even the floors do not fit.
   *  Chainable.
   *
   *  The measuring happens at resolve time, not here, because the column budget
   *  is not known until the table is placed — it differs between a one-column
   *  and a two-column flow, and again on a continuation.
   *
   *  An explicit {@link setColumnWidths} wins: a stated width is a decision, a
   *  measured one is a guess. */
  autoFitColumns(): this {
    this.autoFit = true;
    return this;
  }

  /** @internal The occupancy grid for the rows as they stand.
   *
   *  Rebuilt on each call rather than cached: rows and cells are mutable right
   *  up to draw time (`addRow`, `setMinHeight`, `setImage`), and a cache would
   *  have to be invalidated from every one of them. The walk is O(cells) over
   *  data already in memory, against a `measure` that wraps every string in
   *  the table.
   *
   *  It cannot be a by-product of measuring: `resolveColumnWidths` runs first
   *  and needs the column count. */
  private spanGrid(): SpanGrid {
    return buildSpanGrid(
      this.rows.map((r) => r.cells.map((c) => ({ rowSpan: c.rowSpan, colSpan: c.colSpan }))),
      Math.min(this._repeatingRows, this.rows.length));
  }

  /** @internal Max-content and min-content width per column, including each
   *  contributing cell's horizontal padding. */
  private contentWidths(tablePadding?: number): { max: number[]; min: number[] } {
    const n = this.columnCount();
    const max = new Array<number>(n).fill(0);
    const min = new Array<number>(n).fill(0);
    const { placements } = this.spanGrid();
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const p = placements[r][i];
        // A spanning cell contributes to no single column: attributing its
        // width to one of the columns it covers would be arbitrary, which is
        // the choice CSS auto-layout makes for the same reason. rowSpan does
        // not enter this rule at all — a tall cell is still exactly as wide as
        // the columns it covers.
        if (p.colSpan === 1 && p.col < n) {
          const st = resolveCellStyle(cell, row.style, this.defaults, tablePadding);
          const pad = st.padding.left + st.padding.right;
          const { longestLine, longestWord } = cellExtents(cell.text, st);
          max[p.col] = Math.max(max[p.col], longestLine + pad);
          min[p.col] = Math.max(min[p.col], longestWord + pad);
        }
      }
    }
    return { max, min };
  }

  /** The repeating-header row count set via {@link setRepeatingRowsCount}
   *  (default 0). @internal Read by the renderer and `continuationFrom`. */
  get repeatingRowCount(): number {
    return this._repeatingRows;
  }

  /** Repeat the first `n` rows at the top of every continuation page (`n = 0`
   *  disables). On page 1 they appear naturally as the leading rows. The count
   *  is clamped to the row count at draw time, so rows may be added afterward.
   *  Chainable. */
  setRepeatingRowsCount(n: number): this {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0)
      throw new TypeError('repeatingRowsCount must be a non-negative integer');
    this._repeatingRows = n;
    return this;
  }

  /** @internal Physical column count: forced (continuation tables) or
   *  `max(col + colSpan)` over the grid.
   *
   *  Not the widest row's total colSpan: a cell pushed right by a span
   *  inherited from an earlier row reaches further than its own row's sum
   *  says, which would shrink the table and make `resolveColumnWidths` reject
   *  a valid `setColumnWidths`. For a table with no rowSpan the two agree by
   *  construction. */
  private columnCount(): number {
    if (this.forcedColumnCount !== undefined) return this.forcedColumnCount;
    return this.spanGrid().columnCount;
  }

  /** @internal Build a continuation table of the rows left after `startRow`:
   *  shares this table's `defaults` and normalized column specs, carries the
   *  original column count, and holds the same RowBuilder references (never
   *  mutated). With a repeating-header count `N > 0`, the leftover is prefixed
   *  with the header rows `[0, N)` and the body starts at `max(startRow, N)`, so
   *  re-drawing reprints the header and never duplicates a header row; the count
   *  is carried forward so further splits compose. Re-drawing with the same
   *  `width` yields identical per-column widths. */
  continuationFrom(startRow: number): TableBuilder {
    const t = new TableBuilder(this.defaults);
    t.forcedColumnCount = this.columnCount();
    t.columnSpecs = this.columnSpecs;
    // Without this the second page of a paginated auto-fit table reverts to
    // equal fractions and its columns visibly jump mid-table.
    t.autoFit = this.autoFit;
    const n = Math.min(this._repeatingRows, this.rows.length);
    if (n > 0) {
      t._repeatingRows = n;
      t.rows.push(...this.rows.slice(0, n), ...this.rows.slice(Math.max(startRow, n)));
    } else {
      t.rows.push(...this.rows.slice(startRow));
    }
    return t;
  }

  /** Resolve the column specs (from {@link setColumnWidths}, or equal columns if
   *  unset) plus a `totalWidth` in points into concrete per-column widths. Fixed
   *  columns take their absolute width; fraction columns split the leftover
   *  `totalWidth - Σfixed` by share. Returns `[]` for an empty table. Throws if
   *  the spec count disagrees with the column count, or if fixed columns leave no
   *  room for the fractions. */
  resolveColumnWidths(totalWidth: number, opts: { cellPadding?: number } = {}): number[] {
    if (typeof totalWidth !== 'number' || !Number.isFinite(totalWidth) || totalWidth <= 0)
      throw new TypeError('totalWidth must be a positive finite number');
    const n = this.columnCount();
    if (n === 0) return [];
    // Explicit widths win over a measurement.
    if (this.autoFit && this.columnSpecs === undefined) {
      const { max, min } = this.contentWidths(opts.cellPadding);
      return autoFitWidths(max, min, totalWidth);
    }
    const specs = this.columnSpecs ?? Array.from({ length: n }, () => ({ fraction: 1 } as ColumnWidth));
    if (specs.length !== n)
      throw new TypeError(`setColumnWidths has ${specs.length} entries but the table has ${n} columns`);
    let fixedSum = 0, fracSum = 0;
    for (const w of specs) {
      if ('fixed' in w) fixedSum += w.fixed; else fracSum += w.fraction;
    }
    const remaining = totalWidth - fixedSum;
    if (fracSum > 0 && remaining <= 0)
      throw new TypeError('fixed columns leave no room for the proportional columns');
    return specs.map((w) => ('fixed' in w ? w.fixed : (remaining * w.fraction) / fracSum));
  }

  /** Measure the table's natural laid-out height given resolved `columnWidths`
   *  (points). A cell spans `cell.colSpan` adjacent columns (default 1); its
   *  outer width is the sum of those columns and its text is wrapped to
   *  `outer - (padding.left + padding.right)`. Cell height is
   *  `max(1, lineCount) * leading + padding.top + padding.bottom`; row height is
   *  the tallest cell, floored at the row's `minHeight`; total is the row sum.
   *  Padding resolves per cell through cell ?? row ?? `cellPadding` ?? table ??
   *  2pt, so it is read inside the cell loop rather than once up front. */
  measure(columnWidths: number[], opts: { cellPadding?: number } = {}): TableMetrics {
    if (!Array.isArray(columnWidths) || !columnWidths.every((w) => Number.isFinite(w) && w > 0))
      throw new TypeError('columnWidths must be an array of positive finite numbers');
    const override = opts.cellPadding;
    if (override !== undefined && (!Number.isFinite(override) || override < 0))
      throw new TypeError('cellPadding must be a non-negative finite number');
    const cols = this.columnCount();
    if (columnWidths.length < cols)
      throw new TypeError(`columnWidths has ${columnWidths.length} entries but a row spans ${cols} columns`);

    const grid = this.spanGrid();
    const rowHeights: number[] = [];
    const cellLines: string[][][] = [];
    // Pass 1's per-cell natural heights, parallel to the placements, for the
    // pass-2 deficit walk.
    const needs: number[][] = [];

    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const rowCellLines: string[][] = [];
      const rowNeeds: number[] = [];
      let rowHeight = row.minHeight;
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i];
        const p = grid.placements[r][i];
        if (p.col + p.colSpan > columnWidths.length)
          throw new TypeError(`a row's spans overrun the ${columnWidths.length} provided columns`);
        let outerWidth = 0;
        for (let k = 0; k < p.colSpan; k++) outerWidth += columnWidths[p.col + k];
        const st = resolveCellStyle(cell, row.style, this.defaults, override);
        const innerWidth = outerWidth - st.padding.left - st.padding.right;
        if (innerWidth <= 0)
          throw new TypeError("each cell span width must exceed the cell's horizontal padding");
        // A run cell validates before it measures, so a malformed run is
        // rejected while the table is still untouched rather than at draw time,
        // where resolveRuns would catch it after the caller had committed.
        if (isTextRunList(cell.text)) {
          for (let j = 0; j < cell.text.length; j++) {
            const run = cell.text[j];
            if (typeof run?.text !== 'string')
              throw new TypeError(`cell run ${j}: text must be a string`);
            if (run.link !== undefined && (typeof run.link !== 'string' || run.link === ''))
              throw new TypeError(`cell run ${j}: link must be a non-empty string`);
          }
        }
        // Runs measure through layoutRuns, the SAME engine layoutText wraps, so
        // a cell's computed height cannot disagree with what the renderer draws.
        const res = isTextRunList(cell.text)
          ? layoutRuns(
            cell.text.map((run) => ({
              text: run.text,
              driver: measuringDriverFor(run.font ?? st.font),
              fontSize: run.fontSize ?? st.fontSize,
            })),
            innerWidth, Infinity, st.leading, st.fontSize)
          : layoutText(cell.text, measuringDriverFor(st.font), st.fontSize, innerWidth, Infinity, st.leading);
        // Sum the line bands rather than lineCount * leading: a cell run larger
        // than the cell's font size claims a taller band, and a row sized on the
        // flat product would let its glyphs spill out of the row.
        const textHeight = res.lines.length === 0
          ? st.leading                       // an empty cell still occupies a line
          : res.lines.reduce((n, l) => n + l.height, 0);
        const imageHeight = cell.image
          ? (cell.image.opts.height ?? cell.image.height * innerWidth / cell.image.width)
          : 0;
        const need = Math.max(textHeight, imageHeight) + st.padding.top + st.padding.bottom;
        // Only a 1x1 cell sizes its row here. A spanning cell's shortfall is
        // settled in pass 2, against the rows it actually covers — sizing its
        // top row by its whole height is what makes the row above a tall span
        // grow for no reason of its own.
        if (p.rowSpan === 1) rowHeight = Math.max(rowHeight, need);
        rowNeeds.push(need);
        rowCellLines.push(res.lines.map((l) => l.text));
      }
      rowHeights.push(rowHeight);
      cellLines.push(rowCellLines);
      needs.push(rowNeeds);
    }

    // Pass 2.
    applySpanDeficits(grid, rowHeights, needs);
    return { rowHeights, totalHeight: rowHeights.reduce((a, b) => a + b, 0), cellLines, grid };
  }
}

/** Create a table with optional shared defaults (text style, alignment, border,
 *  background, padding, outer border), each overridable per row/cell. */
export function createTable(opts: TableDefaults = {}): TableBuilder {
  validateStyleOpts(opts);
  if (opts.outerBorder !== undefined) checkBorder(opts.outerBorder);
  return new TableBuilder(opts);
}
