// Table-of-contents model, validation and measurement (issue 1gg0.1). Painting
// and pagination live in tocrender.ts, mirroring the tableauthor/tablerender
// split. The Document is needed for two read-only things only: /PageLabels for
// default labels, and GoTo page-range validation.
import type { Document } from './document.js';
import { encodeAction } from './actions.js';
import type { OutlineView } from './outline.js';
import { parsePageLabels, resolvePageLabel } from './pagelabels.js';
import {
  measureText, validateFont, wrapLines,
  type AuthoringFont, type StampOptions, type TextBlockOptions,
} from './stamp.js';
import type { Decoration, Background } from './textdecor.js';
import type { StructElement } from './struct.js';

/** One row of a table of contents. */
export interface TOCEntry {
  /** Row text; wrapped to the title column. May be empty (the row still draws
   *  its label and link on one line). */
  title: string;
  /** 1-based target page for the row's GoTo link. */
  page: number;
  /** Displayed right-hand text. Default: the target page's logical /PageLabels
   *  label, else its decimal page number. */
  label?: string;
  /** Nesting depth, integer >= 1. Default 1. Indents the title by
   *  (level - 1) * indent. */
  level?: number;
  /** Per-row typographic override, merged over the call defaults. */
  style?: Pick<TOCOptions,
    'font' | 'fontSize' | 'color' | 'underline' | 'strikethrough' | 'background'>;
}

/** Options for {@link Page.AddTOC}. Inherits every option of
 *  {@link TextBlockOptions} — font, fontSize, color, opacity, leading, the
 *  decoration options, the shaping passthrough and `behind` — minus the ones a
 *  TOC row controls itself: `align` (the title column is left-aligned and the
 *  label column right-aligned), `valign` (rows stack from the box top), `tag`
 *  (`tagged` owns the marked content) and the internal `artifact` (a TOC marks
 *  its own dot leader as one, and a caller-supplied artifact would collide with
 *  `tagged` in stamp.ts's validateMarking only after earlier rows were painted,
 *  breaking the draws-nothing-on-rejection guarantee).
 *
 *  Note: a row is drawn as three separate stamps (title, dot leader, page
 *  number), and each is decorated on its own. An `underline` therefore runs
 *  under all three but breaks at the `leaderGap` blanks on either side of the
 *  leader run, rather than spanning the row as one unbroken rule. */
export interface TOCOptions
  extends Omit<TextBlockOptions, 'align' | 'valign' | 'tag' | 'artifact'> {
  /** Extra vertical gap between consecutive rows, points. Default 0. */
  rowGap?: number;
  /** Indent step per nesting level, points. Default 18. */
  indent?: number;
  /** Leader run between title and label. Default 'dots'. */
  leader?: 'dots' | 'none';
  /** Minimum blank gap on each side of the leader run, points. Default 4. */
  leaderGap?: number;
  /** Create a borderless GoTo link over each row. Default true. */
  links?: boolean;
  /** Destination view for those links. Default { type: 'Fit' }. */
  view?: OutlineView;
  /** Append pages sized to the anchor and draw every entry. Default false. */
  autoPaginate?: boolean;
  /** Emit /TOC + /TOCI logical structure into the document structure tree.
   *  Default false, in which case output is byte-identical to an untagged call.
   *  Each row becomes `TOCI > Reference > Link` holding the title and label
   *  marked content plus the link annotation's OBJR; `level` maps onto nested
   *  /TOC elements; the dot leader is marked as an /Artifact. */
  tagged?: boolean;
  /** Element to append the /TOC under. Default: the structure tree root. When
   *  this element is itself a /TOC it is *reused* rather than nested, which is
   *  how a manual-pagination loop keeps one TOC across pages — pass back
   *  {@link AddTOCResult.struct}. A reused /TOC also resumes the nesting depth
   *  the previous call left open, so a subtree split by a page break stays one
   *  subtree. Requires `tagged: true`. */
  structParent?: StructElement;
}

const DEFAULT_INDENT = 18;
const DEFAULT_LEADER_GAP = 4;

/** @internal A row's resolved typography: call defaults with the per-entry
 *  `style` merged over them. */
export interface RowStyle {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  leading: number;
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
}

/** @internal One measured row: everything the painter needs and nothing else. */
export interface MeasuredRow {
  entry: TOCEntry;
  style: RowStyle;
  /** The resolved right-hand text (never undefined by this point). */
  label: string;
  /** Wrapped title lines. Empty for an empty/unencodable title — the row still
   *  occupies one line; see `height`. */
  lines: { text: string; width: number }[];
  titleLeft: number;
  /** max(lines.length, 1) * leading. */
  height: number;
}

/** @internal Resolved call-level geometry and options, shared by every row. */
export interface TOCLayout {
  rows: MeasuredRow[];
  /** Left edge of the right-aligned number column. */
  numberLeft: number;
  /** Right edge of every row (the box's right edge). */
  rowRight: number;
  rowGap: number;
  leader: 'dots' | 'none';
  leaderGap: number;
  links: boolean;
  view: OutlineView;
  autoPaginate: boolean;
  tagged: boolean;
  structParent?: StructElement;
}

function nonNeg(v: number | undefined, dflt: number, what: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${what} must be a non-negative finite number`);
  return n;
}

/** Resolve one row's typography. An explicit call-level `leading` applies to
 *  every row; otherwise each row's leading follows its own size, so a 16pt
 *  level-1 row is not cramped by a 12pt call default. */
function rowStyle(entry: TOCEntry, opts: TOCOptions): RowStyle {
  const s = entry.style ?? {};
  const fontSize = s.fontSize ?? opts.fontSize ?? 12;
  return {
    font: s.font ?? opts.font ?? 'Helvetica',
    fontSize,
    color: s.color ?? opts.color ?? [0, 0, 0],
    leading: opts.leading ?? 1.2 * fontSize,
    underline: s.underline ?? opts.underline,
    strikethrough: s.strikethrough ?? opts.strikethrough,
    background: s.background ?? opts.background,
  };
}

/** Validate a resolved row style up front. stamp.ts re-validates on every draw,
 *  but that is too late: the first rows would already be painted. */
function validateRowStyle(style: RowStyle, i: number): void {
  validateFont(style.font);
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0)
    throw new TypeError(`entries[${i}]: fontSize must be a positive finite number`);
  if (!Number.isFinite(style.leading) || style.leading <= 0)
    throw new TypeError(`entries[${i}]: leading must be a positive finite number`);
  const c = style.color;
  if (!Array.isArray(c) || c.length !== 3 ||
      !c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
    throw new TypeError(`entries[${i}]: color must be [r, g, b] with each component in 0..1`);
}

/** @internal Width of `s` in a row's typography, honoring the call's shaping
 *  options. Shared by the number-column sizing here and the dot-width
 *  computation in tocrender.ts, so both agree. */
export function rowMeasure(s: string, style: RowStyle, opts: TOCOptions): number {
  return measureText(s, style.fontSize, style.font, opts.shape, opts.dir, opts.script, opts.language);
}

/** @internal The stamp.ts single-line options for a row. Forwards every option
 *  {@link TOCOptions} inherits and does not own — if you add one there, add it
 *  here and in rowBlockOptions, or it is silently dropped.
 *
 *  `behind` sinks each stamp under the page's existing content individually, so
 *  the rows end up in reverse order among themselves in /Contents. They do not
 *  overlap, so that is invisible — unless a `background` padding is wide enough
 *  to reach a neighbouring row, which paints over its text in either order. */
export function rowStampOptions(
  style: RowStyle, opts: TOCOptions, align: 'left' | 'right',
): StampOptions {
  return {
    font: style.font, fontSize: style.fontSize, color: style.color, align,
    opacity: opts.opacity, shape: opts.shape, dir: opts.dir,
    script: opts.script, language: opts.language,
    underline: style.underline, strikethrough: style.strikethrough,
    background: style.background, behind: opts.behind,
  };
}

/** The block options wrapping uses: the row's typography plus its leading.
 *  `behind` has no effect on wrapping, but passing it here is what gets it
 *  type-validated inside measureTOC, i.e. before any row is painted. */
function rowBlockOptions(style: RowStyle, opts: TOCOptions): TextBlockOptions {
  return {
    font: style.font, fontSize: style.fontSize, color: style.color, leading: style.leading,
    opacity: opts.opacity, shape: opts.shape, dir: opts.dir,
    script: opts.script, language: opts.language,
    underline: style.underline, strikethrough: style.strikethrough,
    background: style.background, behind: opts.behind,
  };
}

/** Validate every entry and option, then measure every row against the box.
 *  Throws before returning anything, so a caller that lets this throw has drawn
 *  nothing and allocated nothing. */
export function measureTOC(
  doc: Document, entries: TOCEntry[], rect: [number, number, number, number],
  opts: TOCOptions = {},
): TOCLayout {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  const [x, , w, h] = rect;
  if (w <= 0 || h <= 0) throw new TypeError('rect width and height must be positive');
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');

  const indent = nonNeg(opts.indent, DEFAULT_INDENT, 'indent');
  const rowGap = nonNeg(opts.rowGap, 0, 'rowGap');
  const leaderGap = nonNeg(opts.leaderGap, DEFAULT_LEADER_GAP, 'leaderGap');
  const leader = opts.leader ?? 'dots';
  if (leader !== 'dots' && leader !== 'none')
    throw new TypeError("leader must be 'dots' or 'none'");
  const links = opts.links ?? true;
  const view: OutlineView = opts.view ?? { type: 'Fit' };
  const autoPaginate = opts.autoPaginate ?? false;
  const tagged = opts.tagged ?? false;
  if (typeof tagged !== 'boolean') throw new TypeError('tagged must be a boolean');
  const structParent = opts.structParent;
  if (structParent !== undefined) {
    // Explicit rejection rather than implying `tagged`: an unused option must
    // never silently change output.
    if (!tagged) throw new TypeError('structParent requires tagged: true');
    if (structParent.Ref === undefined)
      throw new TypeError('structParent must be a structure element with an indirect ref');
    const root = doc.GetStructTree();
    if (!root || structParent.Root.Dict !== root.Dict)
      throw new TypeError('structParent belongs to a different document');
  }

  const labels = parsePageLabels(doc);

  // Pass 1 — per-entry validation, style and label. encodeAction is called
  // purely to validate `page` and `view`: it allocates nothing, and it throws
  // the same RangeError the link would throw later, when rows are already
  // painted.
  const pre: { entry: TOCEntry; style: RowStyle; label: string; level: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === null || typeof e !== 'object') throw new TypeError(`entries[${i}] must be an object`);
    if (typeof e.title !== 'string') throw new TypeError(`entries[${i}].title must be a string`);
    if (e.label !== undefined && typeof e.label !== 'string')
      throw new TypeError(`entries[${i}].label must be a string`);
    const level = e.level ?? 1;
    if (!Number.isInteger(level) || level < 1)
      throw new TypeError(`entries[${i}].level must be an integer >= 1`);
    encodeAction(doc, { type: 'goto', page: e.page, view });
    const style = rowStyle(e, opts);
    validateRowStyle(style, i);
    pre.push({ entry: e, style, label: e.label ?? resolvePageLabel(labels, e.page - 1), level });
  }

  // Pass 2 — the number column, sized over EVERY entry rather than only the ones
  // that fit, so an auto-paginated TOC keeps one column x on every page.
  let numberWidth = 0;
  for (const p of pre) numberWidth = Math.max(numberWidth, rowMeasure(p.label, p.style, opts));
  const rowRight = x + w;
  const numberLeft = rowRight - numberWidth;

  // Pass 3 — wrap each title in its own column.
  const rows: MeasuredRow[] = [];
  for (let i = 0; i < pre.length; i++) {
    const p = pre[i];
    const titleLeft = x + (p.level - 1) * indent;
    const titleWidth = numberLeft - leaderGap - titleLeft;
    if (titleWidth <= 0)
      throw new RangeError(
        `entries[${i}]: TOC box too narrow — level ${p.level} leaves no title column ` +
        `(box width ${w}, indent ${indent}, number column ${numberWidth})`);
    const lines = wrapLines(p.entry.title, titleWidth, rowBlockOptions(p.style, opts));
    rows.push({
      entry: p.entry, style: p.style, label: p.label, lines, titleLeft,
      height: Math.max(lines.length, 1) * p.style.leading,
    });
  }

  return {
    rows, numberLeft, rowRight, rowGap, leader, leaderGap, links, view, autoPaginate,
    tagged, structParent,
  };
}
